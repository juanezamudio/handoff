import { NextRequest, NextResponse } from "next/server";
import { KEYS, log, patchTask, readSnapshot, redis } from "@/lib/state";
import { isEligible } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

/** Never show "missed by 0.00s" — it reads as a bug, not a photo finish. */
const MIN_DISPLAYED_MISS_MS = 100;

/**
 * The claim race. SET NX is the ONLY atomic primitive in this build, and this is
 * the only place a task can be claimed — there is no application-level locking
 * anywhere, because two people winning the same job on stage would be ugly.
 *
 * Everything is timed off the server clock. Phone clocks drift by seconds, and
 * the tap→server latency is honestly part of the race anyway.
 */
export async function POST(req: NextRequest) {
  const arrivedAt = Date.now(); // must be the first thing that happens

  const { workerId, taskId } = await req.json();
  if (!workerId || !taskId) {
    return NextResponse.json({ error: "workerId and taskId required" }, { status: 400 });
  }

  const snap = await readSnapshot({ fresh: true });
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) {
    return NextResponse.json(
      { won: false, reason: "that job is no longer open" },
      { status: 409 },
    );
  }

  if (!isEligible(task, workerId)) {
    return NextResponse.json({ won: false, reason: "not dispatched to you" });
  }

  const r = redis();
  const ok = await r.set(KEYS.claim(taskId), `${workerId}:${arrivedAt}`, {
    nx: true,
    px: 30_000,
  });

  if (ok === "OK") {
    await patchTask(taskId, (t) => {
      t.claimedBy = workerId;
      t.claimedAt = arrivedAt;
    });
    const w = snap.workers.find((x) => x.id === workerId);
    await log(`Claimed by ${w?.name ?? workerId}`);
    return NextResponse.json({ won: true });
  }

  // Lost the race. Report how narrowly, from the winner's recorded arrival.
  const held = await r.get<string>(KEYS.claim(taskId));
  const [winnerId, claimedAtRaw] = (held ?? "").split(":");
  const claimedAt = Number(claimedAtRaw);
  const deltaMs = Number.isFinite(claimedAt)
    ? Math.max(arrivedAt - claimedAt, MIN_DISPLAYED_MISS_MS)
    : MIN_DISPLAYED_MISS_MS;

  // Losers RPUSH and read their result straight off this response. They must
  // never read-modify-write the shared blob, or concurrent losers clobber
  // each other and the roster starts losing workers mid-demo.
  await r.rpush(KEYS.misses(taskId), JSON.stringify({ workerId, deltaMs }));

  const winner = snap.workers.find((w) => w.id === winnerId);
  return NextResponse.json({
    won: false,
    missedBySeconds: Number((deltaMs / 1000).toFixed(1)),
    winnerName: winner?.name ?? null,
  });
}
