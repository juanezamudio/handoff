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
 *   demo:state       JSON blob — run phase, invoices, current task, log.
 *                    Written only by the agent / dispatch / answer paths, which
 *                    are effectively single-writer, so read-modify-write is safe.
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
  | "hold"
  | "reject";

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
};

export type PaymentState = {
  status: "none" | "pending" | "sent" | "confirmed" | "failed";
  signature: string | null;
  priorityFeeMicroLamports: number | null;
  sentAt: number | null;
  confirmedAt: number | null;
  error?: string;
};

export type TaskState = {
  id: string;
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
  payment: PaymentState;
};

export type LogEntry = { at: number; message: string };

export type DemoState = {
  /** Monotonic — clients skip re-render when unchanged. */
  v: number;
  phase: Phase;
  runStartedAt: number | null;
  invoices: InvoiceState[];
  task: TaskState | null;
  pastTasks: TaskState[];
  log: LogEntry[];
};

export function emptyState(invoiceIds: string[]): DemoState {
  return {
    v: 1,
    phase: "idle",
    runStartedAt: null,
    invoices: invoiceIds.map((id) => ({ id, status: "pending" })),
    task: null,
    pastTasks: [],
    log: [],
  };
}

/** Built per-request; never held at module scope. */
export function redis() {
  return Redis.fromEnv();
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
  const [state, workers, earned] = await Promise.all([
    r.get<DemoState>(KEYS.state),
    r.hgetall<Record<string, WorkerState>>(KEYS.workers),
    r.hgetall<Record<string, number>>(KEYS.earned),
  ]);

  const value: PublicSnapshot = {
    ...(state ?? emptyState([])),
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
  const current = (await r.get<DemoState>(KEYS.state)) ?? emptyState([]);
  const next = (fn(current) ?? current) as DemoState;
  next.v = (current.v ?? 0) + 1;
  await r.set(KEYS.state, next);
  globalCache.__handoffCache = undefined; // force the next read to be fresh
  return next;
}

export async function log(message: string) {
  await mutate((s) => {
    s.log = [...s.log, { at: Date.now(), message }].slice(-60);
  });
}

export async function setInvoice(
  id: string,
  status: InvoiceStatus,
  reason?: string,
) {
  await mutate((s) => {
    const inv = s.invoices.find((i) => i.id === id);
    if (inv) {
      inv.status = status;
      if (reason) inv.reason = reason;
      inv.decidedAt = Date.now();
    }
  });
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

export async function resetAll(invoiceIds: string[]) {
  const r = redis();
  await r.set(KEYS.state, emptyState(invoiceIds));
  await r.del(KEYS.paymentCount);
  globalCache.__handoffCache = undefined;
}
