import { NextRequest, NextResponse } from "next/server";
import { INVOICES } from "@/lib/invoices";
import { KEYS, redis, resetAll } from "@/lib/state";

export const dynamic = "force-dynamic";

/**
 * Reset between rehearsals. By default the roster survives, so you don't have to
 * make everyone re-scan between runs — pass { clearWorkers: true } to wipe it.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const r = redis();

  await resetAll(INVOICES.map((i) => i.id));

  // Clear any stale claim/answer keys from the previous run.
  for (const prefix of ["claim:*", "answer:*", "misses:*"]) {
    const keys = await r.keys(prefix);
    if (keys.length) await r.del(...keys);
  }

  if (body.clearWorkers) {
    await r.del(KEYS.workers, KEYS.earned);
  }

  return NextResponse.json({ ok: true, clearedWorkers: Boolean(body.clearWorkers) });
}
