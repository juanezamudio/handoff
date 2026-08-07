import { Redis } from "@upstash/redis";

/**
 * All demo state. Redis is the only system of record — every surface is a view
 * of it, obtained by polling.
 *
 * HARD RULE: no module-level mutable state. Fluid Compute reuses instances AND
 * runs several of them, so the agent request and the poll requests land on
 * different instances. A Map works on localhost and fails on stage.
 *
 * KEY LAYOUT
 *   demo:state       JSON blob — run phase, current + past tasks, mock flag.
 *                    Low-concurrency writers only, so read-modify-write is safe.
 *                    Invoices and the log used to live here and had to be moved
 *                    out; see the note on KEYS.invoices below.
 *   invoices         HASH invoiceId -> InvoiceState. Atomic per-field writes.
 *   log              LIST of LogEntry, RPUSH + LTRIM. Atomic appends.
 *   workers          HASH workerId -> WorkerState JSON.
 *                    Each worker only ever writes its OWN field, so 40 phones
 *                    heartbeating at 1Hz never clobber each other. This is why
 *                    workers are NOT in the blob.
 *   workers:earned   HASH workerId -> raw token units. HINCRBY is atomic, so a
 *                    payment can never be lost to a concurrent heartbeat.
 *   claim:{taskId}   SET NX — the only atomic primitive in the build.
 *   answer:{taskId}  what the blocked ask_human tool polls for.
 *   misses:{taskId}  RPUSH — losers never read-modify-write anything.
 *   wallets:pool     LPOP list of pre-created {pubkey, ata}.
 *   session:{sid}    sid -> workerId, so a phone reload doesn't drain the pool.
 */

export const KEYS = {
  state: "demo:state",
  /**
   * Invoices and the log are NOT in the blob.
   *
   * The model emits record_decision as PARALLEL tool calls — six of them landed
   * on the same millisecond in testing — so routing them through a shared
   * read-modify-write blob loses updates, and one lost write took the active
   * task with it and made a dispatch invisible to every client. Per-field hash
   * writes and list appends are atomic; the blob is for low-concurrency state
   * only.
   */
  invoices: "invoices",
  log: "log",
  /**
   * Each task is its own key.
   *
   * Payment settles asynchronously while the agent loop keeps writing phase and
   * task pointers, so both were doing read-modify-write on the same blob — the
   * archive write and the payment write raced, and whichever landed second
   * clobbered the other. On stage that showed up as a card stuck on "paying…"
   * forever. Task mutations now never touch the blob.
   */
  task: (taskId: string) => `task:${taskId}`,
  /** HASH agentId -> AgentRun. Three agents advance concurrently; per-field
   *  writes keep them from clobbering each other, same as workers. */
  agents: "agents",
  /** Photo evidence, kept OUT of the snapshot — it must never ride along on a
   *  payload that forty phones poll once a second. */
  photo: (taskId: string) => `photo:${taskId}`,
  workers: "workers",
  earned: "workers:earned",
  pool: "wallets:pool",
  claim: (taskId: string) => `claim:${taskId}`,
  answer: (taskId: string) => `answer:${taskId}`,
  misses: (taskId: string) => `misses:${taskId}`,
  session: (sid: string) => `session:${sid}`,
  paymentCount: "payments:count",
} as const;

export type Phase = "idle" | "running" | "waiting" | "done";

export type InvoiceStatus =
  | "pending"
  | "deciding"
  | "approve"
  | "hold";

export type InvoiceState = {
  id: string;
  status: InvoiceStatus;
  reason?: string;
  decidedAt?: number;
};

export type WorkerState = {
  id: string;
  name: string;
  pubkey: string;
  ata: string;
  joinedAt: number;
  lastHeartbeat: number;
  answeredCount: number;
  recentlyPaidAt: number | null;
  /**
   * Spawned from /control to rehearse a full room solo. Treated as permanently
   * online since no phone is polling to keep it fresh.
   */
  simulated?: boolean;
};

export type PaymentState = {
  status: "none" | "pending" | "sent" | "confirmed" | "failed";
  signature: string | null;
  priorityFeeMicroLamports: number | null;
  /** Which tier produced the fee, so the stage can label it honestly. */
  priorityFeeSource: "quicknode" | "network-p75" | "floor" | null;
  sentAt: number | null;
  confirmedAt: number | null;
  error?: string;
};

export type TaskState = {
  id: string;
  /** Which agent is blocked on this. */
  agentId: string;
  agentName: string;
  invoiceId: string;
  question: string;
  options: string[];
  amountRaw: number;
  dispatchedAt: number;
  /** Worker ids pinged first. Others see themselves dimmed, with a reason. */
  shortlist: string[];
  ineligible: { workerId: string; reason: string }[];
  widenedAt: number | null;
  claimedBy: string | null;
  claimedAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  /** Demands a photo as evidence alongside the answer. */
  requiresPhoto?: boolean;
  inputHint?: string;
  /** True once a photo has been stored under KEYS.photo(taskId). */
  hasPhoto?: boolean;
  payment: PaymentState;
};

export type LogEntry = { at: number; message: string };

export type AgentStatus = "idle" | "working" | "blocked" | "done";

export type AgentRun = {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  /** Index into the agent's scripted steps. */
  stepIndex: number;
  stepStartedAt: number;
  /** Labels of finished steps, newest last. */
  history: string[];
  /** Set while blocked on a human. */
  taskId: string | null;
};

export type DemoState = {
  /** Monotonic — clients skip re-render when unchanged. */
  v: number;
  phase: Phase;
  runStartedAt: number | null;
  /** Finished tasks, newest last. Open tasks hang off each agent instead. */
  pastTaskIds: string[];
  /**
   * Simulated payments — no chain, no wallet pool, no funding required.
   *
   * Deliberately an EXPLICIT toggle rather than an automatic fallback when the
   * pool runs dry: silently faking payments while you believe they're real is
   * the worst possible failure, so every surface renders a loud SIMULATED badge
   * whenever this is on.
   */
  mock: boolean;
};

/**
 * Defaults to mock ON.
 *
 * Real payments need a funded treasury and a pre-generated wallet pool; without
 * them the worker page just errors on join, which is a terrible first run and a
 * worse thing to discover mid-rehearsal. Mock is the safe default and going
 * live is a deliberate toggle on /control.
 */
export function emptyState(mock = true): DemoState {
  return {
    v: 1,
    phase: "idle",
    runStartedAt: null,
    pastTaskIds: [],
    mock,
  };
}

/**
 * Built per-request; never held at module scope.
 *
 * Vercel's Upstash integration provisions KV_REST_API_URL / KV_REST_API_TOKEN,
 * but Redis.fromEnv() looks for UPSTASH_REDIS_REST_*. Accept either so the same
 * code runs locally and on a deployment without an env-var rename dance.
 */
export function redis() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Redis is not configured — expected KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN",
    );
  }
  return new Redis({ url, token });
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * A short read-through cache so ~40 phones polling at 1Hz collapse into a few
 * Redis reads per second per instance. This caches a *copy of a read*, which is
 * not the same thing as holding authoritative state in memory — a stale read
 * costs at most CACHE_MS of latency and self-heals on the next poll.
 */
const CACHE_MS = 250;
type CacheEntry = { at: number; value: PublicSnapshot };
const globalCache = globalThis as unknown as { __handoffCache?: CacheEntry };

export type PublicSnapshot = DemoState & {
  agents: AgentRun[];
  /** Every task currently waiting on a human — up to one per agent. */
  tasks: TaskState[];
  pastTasks: TaskState[];
  invoices: InvoiceState[];
  log: LogEntry[];
  workers: WorkerState[];
  earned: Record<string, number>;
  now: number;
};

export async function readSnapshot(
  opts: { fresh?: boolean } = {},
): Promise<PublicSnapshot> {
  const cached = globalCache.__handoffCache;
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const r = redis();
  const [state, invoices, log, workers, earned, agentMap] = await Promise.all([
    r.get<DemoState>(KEYS.state),
    r.hgetall<Record<string, InvoiceState>>(KEYS.invoices),
    r.lrange<LogEntry>(KEYS.log, -60, -1),
    r.hgetall<Record<string, WorkerState>>(KEYS.workers),
    r.hgetall<Record<string, number>>(KEYS.earned),
    r.hgetall<Record<string, AgentRun>>(KEYS.agents),
  ]);
  const agents = Object.values(agentMap ?? {});

  const base = state ?? emptyState();
  const openIds = agents
    .map((a) => a.taskId)
    .filter((id): id is string => Boolean(id));
  const ids = [...(base.pastTaskIds ?? []), ...openIds];
  const tasks = ids.length
    ? await r.mget<(TaskState | null)[]>(...ids.map((id) => KEYS.task(id)))
    : [];
  const byId = new Map(
    tasks.filter(Boolean).map((t) => [(t as TaskState).id, t as TaskState]),
  );

  const value: PublicSnapshot = {
    ...base,
    agents: agents.sort((a, b) => a.id.localeCompare(b.id)),
    tasks: openIds
      .map((id) => byId.get(id))
      .filter((t): t is TaskState => Boolean(t) && !t!.answer),
    pastTasks: (base.pastTaskIds ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is TaskState => Boolean(t)),
    invoices: Object.values(invoices ?? {}),
    log: log ?? [],
    workers: Object.values(workers ?? {}),
    earned: earned ?? {},
    now: Date.now(),
  };

  globalCache.__handoffCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Read-modify-write the blob. Safe because the blob's writers (agent, dispatch,
 * answer) are effectively single-writer. Anything with real concurrency —
 * heartbeats, earnings, claims, misses — uses its own key and never comes here.
 */
export async function mutate(
  fn: (s: DemoState) => DemoState | void,
): Promise<DemoState> {
  const r = redis();
  const current = (await r.get<DemoState>(KEYS.state)) ?? emptyState();
  const next = (fn(current) ?? current) as DemoState;
  next.v = (current.v ?? 0) + 1;
  await r.set(KEYS.state, next);
  globalCache.__handoffCache = undefined; // force the next read to be fresh
  return next;
}

/** RPUSH is atomic — safe from any number of concurrent writers. */
/**
 * Apply a change to a task wherever it currently lives.
 *
 * Payment settles asynchronously, but the run archives the task into pastTasks
 * as soon as the answer unblocks the agent — so by the time a signature or a
 * confirmation arrives, the task is usually no longer `state.task`. Guarding
 * only on `s.task.id` silently dropped every payment update and left the stage
 * stuck on "paying…" forever.
 */
export async function patchTask(
  taskId: string,
  fn: (t: TaskState) => void,
): Promise<void> {
  const r = redis();
  const task = await r.get<TaskState>(KEYS.task(taskId));
  if (!task) return;
  fn(task);
  await r.set(KEYS.task(taskId), task, { ex: 60 * 60 });
  globalCache.__handoffCache = undefined;
}

export async function putTask(task: TaskState): Promise<void> {
  await redis().set(KEYS.task(task.id), task, { ex: 60 * 60 });
  globalCache.__handoffCache = undefined;
}

export async function log(message: string) {
  const r = redis();
  await r.rpush(KEYS.log, { at: Date.now(), message });
  await r.ltrim(KEYS.log, -60, -1);
  globalCache.__handoffCache = undefined;
}

/**
 * Per-field hash write — atomic, so the model's parallel record_decision calls
 * can't lose each other's updates. Do NOT move this back into the blob.
 */
export async function setInvoice(
  id: string,
  status: InvoiceStatus,
  reason?: string,
) {
  const r = redis();
  const existing = await r.hget<InvoiceState>(KEYS.invoices, id);
  const next: InvoiceState = {
    id,
    status,
    reason: reason ?? existing?.reason,
    decidedAt: Date.now(),
  };
  await r.hset(KEYS.invoices, { [id]: next });
  globalCache.__handoffCache = undefined;
}

export async function putAgent(a: AgentRun) {
  await redis().hset(KEYS.agents, { [a.id]: a });
  globalCache.__handoffCache = undefined;
}

export async function getAgents(): Promise<AgentRun[]> {
  const m = await redis().hgetall<Record<string, AgentRun>>(KEYS.agents);
  return Object.values(m ?? {});
}

export async function upsertWorker(w: WorkerState) {
  await redis().hset(KEYS.workers, { [w.id]: w });
}

export async function heartbeat(workerId: string) {
  const r = redis();
  const w = await r.hget<WorkerState>(KEYS.workers, workerId);
  if (!w) return null;
  w.lastHeartbeat = Date.now();
  await r.hset(KEYS.workers, { [workerId]: w });
  return w;
}

export async function creditWorker(workerId: string, amountRaw: number) {
  await redis().hincrby(KEYS.earned, workerId, amountRaw);
}

/** Reset preserves the mock toggle — you don't want it flipping under you mid-rehearsal. */
export async function resetAll(invoiceIds: string[]) {
  const r = redis();
  const prev = await r.get<DemoState>(KEYS.state);
  await r.set(KEYS.state, emptyState(prev?.mock ?? false));
  await r.del(KEYS.log, KEYS.invoices, KEYS.paymentCount, KEYS.earned, KEYS.agents);
  const fresh: Record<string, InvoiceState> = {};
  for (const id of invoiceIds) fresh[id] = { id, status: "pending" };
  if (invoiceIds.length) await r.hset(KEYS.invoices, fresh);
  globalCache.__handoffCache = undefined;
}

export async function isMock(): Promise<boolean> {
  const s = await redis().get<DemoState>(KEYS.state);
  return s?.mock ?? false;
}
