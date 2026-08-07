import { NextRequest, NextResponse } from "next/server";
import { heartbeat, readSnapshot } from "@/lib/state";
import { tick } from "@/lib/tick";

export const dynamic = "force-dynamic";

/**
 * The single read endpoint. Every surface polls this — no SSE anywhere.
 *
 * A dropped poll costs 500ms; a dropped SSE stream costs the rest of the demo
 * unless you also build reconnect and replay. Polling is also reload-safe, which
 * matters because you WILL reload the projector during rehearsal.
 *
 * ?w=<workerId> doubles as that worker's heartbeat, so a phone that is polling
 * is by definition online and no separate heartbeat request is needed.
 */
export async function GET(req: NextRequest) {
  const workerId = req.nextUrl.searchParams.get("w");
  if (workerId) await heartbeat(workerId);

  // Serverless has nowhere to keep a timer, so the scripted agents advance as a
  // side effect of the projector/control poll. Worker phones never tick — only
  // the surfaces that pass tick=1 — and a SET NX lock inside tick() keeps
  // concurrent pollers from double-advancing.
  if (req.nextUrl.searchParams.get("tick") === "1") {
    await tick();
  }

  const snapshot = await readSnapshot({
    fresh: Boolean(workerId) || req.nextUrl.searchParams.get("tick") === "1",
  });
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
