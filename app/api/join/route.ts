import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import { KEYS, isMock, redis, upsertWorker, type WorkerState } from "@/lib/state";
import { generateName } from "@/lib/names";

export const dynamic = "force-dynamic";

/**
 * Scan → wallet, in about 5ms.
 *
 * All the on-chain work (keypair generation, token account creation) already
 * happened in scripts/mint-pool.ts before the demo. Joining is an LPOP off a
 * pre-built pool, so nothing touches the chain while the room is watching.
 *
 * The session cookie matters more than it looks: without it, a phone that
 * reloads would pop a second wallet and slowly drain the pool.
 */
export async function POST(req: NextRequest) {
  const r = redis();
  const body = await req.json().catch(() => ({}));
  const sid: string = body.sid || randomUUID();

  // Returning phone? Give it back the same worker.
  const existingId = await r.get<string>(KEYS.session(sid));
  if (existingId) {
    const existing = await r.hget<WorkerState>(KEYS.workers, existingId);
    if (existing) {
      existing.lastHeartbeat = Date.now();
      await upsertWorker(existing);
      return NextResponse.json({ sid, worker: existing });
    }
  }

  let wallet: { pubkey: string; ata: string };

  if (await isMock()) {
    // Mock mode: a real base58 keypair, generated on the spot, never funded and
    // never used to sign. Lets the whole flow be rehearsed with no chain at all.
    const kp = Keypair.generate();
    wallet = { pubkey: kp.publicKey.toBase58(), ata: kp.publicKey.toBase58() };
  } else {
    const raw = await r.lpop<string | { pubkey: string; ata: string }>(KEYS.pool);
    if (!raw) {
      return NextResponse.json(
        {
          error:
            "wallet pool is empty — run scripts/mint-pool.ts, or turn on mock mode at /control to rehearse without the chain",
        },
        { status: 503 },
      );
    }
    wallet = typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  const id = randomUUID().slice(0, 8);
  const worker: WorkerState = {
    id,
    name: generateName(wallet.pubkey),
    pubkey: wallet.pubkey,
    ata: wallet.ata,
    joinedAt: Date.now(),
    lastHeartbeat: Date.now(),
    answeredCount: 0,
    recentlyPaidAt: null,
  };

  await upsertWorker(worker);
  await r.set(KEYS.session(sid), id, { ex: 60 * 60 * 6 });

  return NextResponse.json({ sid, worker });
}
