import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { KEYS, log, patchTask, readSnapshot, redis, upsertWorker } from "@/lib/state";
import { settle } from "@/lib/settle";

export const dynamic = "force-dynamic";

/**
 * Answer submitted.
 *
 * Order matters: write the answer FIRST (that unblocks the agent's poll within
 * 400ms), return 200, and only then pay. Payment must never gate the agent's
 * resume — an unbounded, congestion-dependent delay in the middle of the best
 * beat of the demo. It's also better theater: the agent resumes instantly, and
 * the money lands a moment later. Two payoffs instead of one.
 */
export async function POST(req: NextRequest) {
  const { workerId, taskId, answer } = await req.json();
  if (!workerId || !taskId || !answer) {
    return NextResponse.json(
      { error: "workerId, taskId and answer required" },
      { status: 400 },
    );
  }

  const r = redis();

  // Only the worker who won the claim may answer it.
  const held = await r.get<string>(KEYS.claim(taskId));
  const [winnerId] = (held ?? "").split(":");
  if (winnerId !== workerId) {
    return NextResponse.json({ error: "you don't hold this job" }, { status: 403 });
  }

  const answeredAt = Date.now();

  // 1. Unblock the agent immediately.
  await r.set(KEYS.answer(taskId), answer, { ex: 300 });

  const snap = await readSnapshot({ fresh: true });
  const worker = snap.workers.find((w) => w.id === workerId);
  const task = snap.tasks.find((t) => t.id === taskId);

  await patchTask(taskId, (t) => {
    t.answer = answer;
    t.answeredAt = answeredAt;
    t.payment.status = "pending";
  });
  await log(`${worker?.name ?? workerId} answered: ${answer}`);

  if (worker) {
    worker.answeredCount += 1;
    worker.recentlyPaidAt = answeredAt; // deprioritizes them for the next stop
    await upsertWorker(worker);
  }

  // 2. Pay in the background. A bare `void pay()` would be silently dropped
  //    when the instance freezes after responding — you don't see that in dev.
  if (worker) {
    waitUntil(settle({ taskId, workerId, ata: worker.ata }));
  }

  return NextResponse.json({ ok: true });
}
