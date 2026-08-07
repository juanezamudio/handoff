import { randomUUID } from "node:crypto";
import {
  KEYS,
  log,
  mutate,
  patchTask,
  putTask,
  readSnapshot,
  redis,
  type TaskState,
  type WorkerState,
} from "./state";
import { TASK_PRICE_RAW } from "./pay";

/**
 * Routing, not broadcasting.
 *
 * Buzzing every phone invites the obvious objection ("so it's a group text").
 * We score the roster, ping a shortlist, and dim everyone else WITH A VISIBLE
 * REASON. That one frame is what makes this read as a product rather than a
 * raffle — so the reasons must be honest, which is why the scoring below is a
 * real weighted sum and not a coin flip dressed up in UI.
 */

export const SHORTLIST_SIZE = 5;
export const ONLINE_WINDOW_MS = 10_000;
export const RECENTLY_PAID_MS = 60_000;

/** Fallbacks — shown on stage as deliberate dispatch behavior, not as a patch. */
export const WIDEN_AFTER_MS = 6_000;
export const FORCE_AFTER_MS = 12_000;
export const ANSWER_DEADLINE_MS = 45_000;

const POLL_MS = 400;

export type Scored = {
  worker: WorkerState;
  score: number;
  reason: string | null;
};

/**
 * Deprioritizing recently-paid workers is what makes stop 2 land on a DIFFERENT
 * person than stop 1 — two people in the room holding money instead of one.
 * It's a penalty rather than a hard exclusion so a two-phone rehearsal can't
 * deadlock itself.
 */
export function scoreRoster(workers: WorkerState[], now: number): Scored[] {
  return workers
    .map((worker) => {
      let score = 100;
      let reason: string | null = null;

      const sinceBeat = worker.simulated ? 0 : now - worker.lastHeartbeat;
      if (sinceBeat > ONLINE_WINDOW_MS) {
        score -= 1000;
        reason = "offline";
      }

      if (worker.recentlyPaidAt && now - worker.recentlyPaidAt < RECENTLY_PAID_MS) {
        score -= 500;
        reason = reason ?? "recently paid";
      }

      // Spread work across the room rather than letting one fast thumb win everything.
      score -= worker.answeredCount * 5;
      // Mild freshness bonus, so a live phone outranks a barely-alive one.
      score += Math.max(0, (ONLINE_WINDOW_MS - sinceBeat) / 1000);

      return { worker, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildShortlist(scored: Scored[]) {
  const online = scored.filter((s) => s.reason !== "offline");
  const shortlist = online.slice(0, SHORTLIST_SIZE);
  const shortlistIds = new Set(shortlist.map((s) => s.worker.id));

  const ineligible = scored
    .filter((s) => !shortlistIds.has(s.worker.id))
    .map((s) => ({
      workerId: s.worker.id,
      reason: s.reason ?? "not selected",
    }));

  return { shortlist: shortlist.map((s) => s.worker.id), ineligible };
}

/** Create + publish a task. Returns the task id the tool will block on. */
export async function dispatchTask(args: {
  agentId: string;
  agentName: string;
  invoiceId: string;
  question: string;
  options: string[];
  requiresPhoto?: boolean;
  inputHint?: string;
}): Promise<TaskState> {
  const snap = await readSnapshot({ fresh: true });
  const now = Date.now();
  const { shortlist, ineligible } = buildShortlist(scoreRoster(snap.workers, now));

  const task: TaskState = {
    id: randomUUID().slice(0, 8),
    agentId: args.agentId,
    agentName: args.agentName,
    invoiceId: args.invoiceId,
    question: args.question,
    options: args.options,
    amountRaw: TASK_PRICE_RAW,
    dispatchedAt: now,
    shortlist,
    ineligible,
    widenedAt: null,
    claimedBy: null,
    claimedAt: null,
    answer: null,
    answeredAt: null,
    requiresPhoto: args.requiresPhoto,
    inputHint: args.inputHint,
    payment: {
      status: "none",
      signature: null,
      priorityFeeMicroLamports: null,
      priorityFeeSource: null,
      sentAt: null,
      confirmedAt: null,
    },
  };

  await putTask(task);
  await log(
    `Dispatched ${args.agentName}'s job to ${shortlist.length} worker${shortlist.length === 1 ? "" : "s"}`,
  );

  return task;
}

/**
 * Blocks until a human answers, or the deadline passes. This is what
 * ask_human's run() awaits — the whole product in one function.
 *
 * Along the way it runs the two fallbacks so a quiet room never stalls the demo:
 * widen the shortlist at 6s, force to anyone at 12s.
 */
export async function waitForAnswer(taskId: string): Promise<string | null> {
  const r = redis();
  const started = Date.now();
  let widened = false;

  while (Date.now() - started < ANSWER_DEADLINE_MS) {
    const answer = await r.get<string>(KEYS.answer(taskId));
    if (answer) return answer;

    const elapsed = Date.now() - started;

    if (!widened && elapsed > WIDEN_AFTER_MS) {
      widened = true;
      await patchTask(taskId, (t) => {
        t.widenedAt = Date.now();
        t.shortlist = []; // empty shortlist == everyone is eligible
        t.ineligible = [];
      });
      await log("No claim in 6s — expanding to all workers");
    }

    await new Promise((res) => setTimeout(res, POLL_MS));
  }

  return null;
}

/** An empty shortlist means the dispatch was widened — everyone is eligible. */
export function isEligible(task: TaskState, workerId: string): boolean {
  if (task.shortlist.length === 0) return true;
  return task.shortlist.includes(workerId);
}
