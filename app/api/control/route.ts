import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import { waitUntil } from "@vercel/functions";
import { INVOICES } from "@/lib/invoices";
import {
  KEYS,
  log,
  mutate,
  patchTask,
  readSnapshot,
  redis,
  resetAll,
  upsertWorker,
  type WorkerState,
} from "@/lib/state";
import { generateName } from "@/lib/names";
import { scoreRoster } from "@/lib/dispatch";
import { startAgents } from "@/lib/tick";
import { settle } from "@/lib/settle";

export const dynamic = "force-dynamic";

/**
 * Operator parachutes. Everything here exists because something can go wrong on
 * stage and you need a way out that doesn't involve a terminal.
 */
export async function POST(req: NextRequest) {
  const { action, value } = await req.json();
  const r = redis();

  switch (action) {
    // --- the scripted three, running concurrently, no model cost -----------
    case "startAgents": {
      await resetAll(INVOICES.map((i) => i.id));
      for (const prefix of ["claim:*", "answer:*", "misses:*", "photo:*"]) {
        const keys = await r.keys(prefix);
        if (keys.length) await r.del(...keys);
      }
      await startAgents();
      return NextResponse.json({ ok: true });
    }

    // --- simulated payments, no chain required ----------------------------
    case "mock": {
      await mutate((s) => {
        s.mock = Boolean(value);
      });
      await log(
        value
          ? "Mock mode ON — payments simulated"
          : "Mock mode OFF — payments settle on devnet",
      );
      return NextResponse.json({ ok: true, mock: Boolean(value) });
    }

    // --- populate the roster so a solo rehearsal looks like a real room ----
    case "spawnWorkers": {
      const n = Math.min(Number(value) || 8, 40);
      for (let i = 0; i < n; i++) {
        const kp = Keypair.generate();
        const id = randomUUID().slice(0, 8);
        const worker: WorkerState = {
          id,
          name: generateName(kp.publicKey.toBase58()),
          pubkey: kp.publicKey.toBase58(),
          ata: kp.publicKey.toBase58(),
          joinedAt: Date.now(),
          lastHeartbeat: Date.now(),
          answeredCount: 0,
          recentlyPaidAt: null,
          simulated: true,
        };
        await upsertWorker(worker);
      }
      return NextResponse.json({ ok: true, spawned: n });
    }

    case "clearAllWorkers": {
      await r.del(KEYS.workers, KEYS.earned);
      await log("Roster cleared");
      return NextResponse.json({ ok: true });
    }

    case "clearSimulated": {
      const workers = await r.hgetall<Record<string, WorkerState>>(KEYS.workers);
      const ids = Object.values(workers ?? {})
        .filter((w) => w.simulated)
        .map((w) => w.id);
      if (ids.length) await r.hdel(KEYS.workers, ...ids);
      return NextResponse.json({ ok: true, removed: ids.length });
    }

    // --- claim/answer on someone's behalf when the room goes quiet ---------
    case "forceAnswer": {
      const snap = await readSnapshot({ fresh: true });
      // With three agents running, an operator has to say WHICH job to answer.
      const task = value?.taskId
        ? snap.tasks.find((t) => t.id === value.taskId)
        : snap.tasks[0];
      if (!task) {
        return NextResponse.json({ error: "no open task" }, { status: 409 });
      }

      const answer = String(value?.answer ?? task.options[0] ?? "acknowledged");
      // Pick whoever the dispatcher would actually have favoured — same scoring
      // as a real claim. Taking the first shortlisted worker instead sent both
      // escalations to the same person, which loses the "two different people
      // in the room got paid" beat the demo is built around.
      const ranked = scoreRoster(snap.workers, Date.now())
        .filter((s) => s.reason !== "offline")
        .filter((s) => task.shortlist.length === 0 || task.shortlist.includes(s.worker.id));

      const chosen =
        snap.workers.find((w) => w.id === task.claimedBy) ??
        ranked[0]?.worker ??
        snap.workers[0];

      if (chosen) {
        await r.set(KEYS.claim(task.id), `${chosen.id}:${Date.now()}`, {
          px: 30_000,
        });
      }
      // Writing the answer key is what actually unblocks the waiting agent.
      await r.set(KEYS.answer(task.id), answer, { ex: 300 });

      await patchTask(task.id, (t) => {
        t.claimedBy = chosen?.id ?? null;
        t.claimedAt = Date.now();
        t.answer = answer;
        t.answeredAt = Date.now();
        t.payment.status = "pending";
      });
      await log(`Operator answered: ${answer}`);

      // The parachute must still pay, or a forced answer leaves the worker
      // unpaid and the stage stuck on "paying…".
      if (chosen) {
        // Mark them paid so the NEXT parachute picks someone else. Without
        // this, answering three open jobs in a row hands all three to the same
        // person — and "three different people in this room just got paid" is
        // the whole beat.
        await upsertWorker({
          ...chosen,
          answeredCount: chosen.answeredCount + 1,
          recentlyPaidAt: Date.now(),
        });
        waitUntil(settle({ taskId: task.id, workerId: chosen.id, ata: chosen.ata }));
      }

      return NextResponse.json({ ok: true, answer, worker: chosen?.name });
    }

    // --- widen dispatch immediately instead of waiting out the 6s ---------
    case "widen": {
      const open = await readSnapshot({ fresh: true });
      for (const t0 of open.tasks) {
        await patchTask(t0.id, (t) => {
          t.shortlist = [];
          t.ineligible = [];
          t.widenedAt = Date.now();
        });
      }
      await log("Operator expanded to all workers");
      return NextResponse.json({ ok: true });
    }

    case "reset": {
      await resetAll(INVOICES.map((i) => i.id));
      for (const prefix of ["claim:*", "answer:*", "misses:*", "photo:*"]) {
        const keys = await r.keys(prefix);
        if (keys.length) await r.del(...keys);
      }
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }
}
