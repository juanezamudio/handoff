import { KEYS, creditWorker, isMock, patchTask, redis } from "./state";
import { TASK_PRICE_RAW, payWorker } from "./pay";

/** Stops a retry bug from draining the treasury while the room watches. */
const MAX_PAYMENTS_PER_RUN = 6;

/**
 * Pay a worker for an answered task.
 *
 * Shared by /api/answer (the real path) and /api/control forceAnswer (the
 * operator parachute) — the parachute originally skipped this entirely, so a
 * forced answer left the worker unpaid and the stage stuck on "paying…".
 *
 * Always call this from waitUntil(), never inline: it must not gate the agent's
 * resume, and a bare floating promise gets dropped when the instance freezes.
 */
export async function settle(args: {
  taskId: string;
  workerId: string;
  ata: string;
}) {
  const { taskId, workerId, ata } = args;
  const r = redis();

  const count = await r.incr(KEYS.paymentCount);
  if (count > MAX_PAYMENTS_PER_RUN) {
    await patchTask(taskId, (t) => {
      t.payment.status = "failed";
      t.payment.error = "payment cap reached for this run";
    });
    return;
  }

  // Mock mode: same state transitions and roughly the same timing as a real
  // devnet settle, so the stage animation and the rehearsal feel identical —
  // only the chain is absent, and every surface says SIMULATED while it is.
  if (await isMock()) {
    const fakeSig = `MOCK${Math.random().toString(36).slice(2, 10)}${"x".repeat(20)}`;
    await patchTask(taskId, (t) => {
      t.payment.status = "sent";
      t.payment.signature = fakeSig;
      t.payment.priorityFeeMicroLamports = 10_000;
      t.payment.priorityFeeSource = "floor";
      t.payment.sentAt = Date.now();
    });
    await new Promise((res) => setTimeout(res, 900));
    await patchTask(taskId, (t) => {
      t.payment.status = "confirmed";
      t.payment.confirmedAt = Date.now();
    });
    await creditWorker(workerId, TASK_PRICE_RAW);
    return;
  }

  try {
    const result = await payWorker({
      toAta: ata,
      onProgress: async (p) => {
        await patchTask(taskId, (t) => {
          if (p.status === "sent") {
            t.payment.status = "sent";
            t.payment.signature = p.signature;
            t.payment.priorityFeeMicroLamports = p.priorityFeeMicroLamports;
            t.payment.priorityFeeSource = p.priorityFeeSource;
            t.payment.sentAt = Date.now();
          } else if (p.status === "confirmed") {
            t.payment.status = "confirmed";
            t.payment.confirmedAt = p.confirmedAt;
          } else {
            t.payment.status = "failed";
            t.payment.error = p.error;
          }
        });
      },
    });

    if (result.confirmedAt) await creditWorker(workerId, TASK_PRICE_RAW);
  } catch (err) {
    await patchTask(taskId, (t) => {
      t.payment.status = "failed";
      t.payment.error = err instanceof Error ? err.message : String(err);
    });
  }
}
