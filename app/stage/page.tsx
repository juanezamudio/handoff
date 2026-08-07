"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentRun, PublicSnapshot, TaskState, WorkerState } from "@/lib/state";

/**
 * The projector.
 *
 * Two rules drove every layout decision:
 *  1. It is read from thirty feet away — type is large, contrast is hard.
 *  2. The bottom half has to make the MARKET visible, not just the payment.
 *     Watching strangers' cards race and one win is the moment the room
 *     understands this is a labour market and not a webhook.
 *
 * This page also drives the demo: it passes tick=1 on its poll, which is what
 * advances the scripted agents. Serverless has nowhere to keep a timer.
 */

const POLL_MS = 400;

export default function StagePage() {
  const [snap, setSnap] = useState<PublicSnapshot | null>(null);
  const [origin, setOrigin] = useState("");
  const version = useRef(-1);

  // Whatever host the projector loaded from is the host phones can reach —
  // works for a LAN IP in rehearsal and the deployed URL on the day.
  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/state?tick=1", { cache: "no-store" });
        if (!alive) return;
        const data: PublicSnapshot = await res.json();
        if (data.v !== version.current || data.tasks.length || data.agents.length) {
          version.current = data.v;
          setSnap(data);
        }
      } catch {
        /* a dropped poll costs 400ms — this is why there's no SSE */
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const agents = snap?.agents ?? [];
  const totalPaid = Object.values(snap?.earned ?? {}).reduce((a, b) => a + b, 0);

  return (
    <main className="grid h-dvh grid-rows-[1fr_auto_auto] gap-4 bg-neutral-950 p-6 text-white">
      <section className="grid min-h-0 grid-cols-3 gap-4">
        {agents.length === 0 ? (
          <div className="col-span-3 flex items-center justify-center text-neutral-600">
            Waiting to start…
          </div>
        ) : (
          agents.map((a) => (
            <AgentColumn
              key={a.id}
              agent={a}
              task={snap?.tasks.find((t) => t.id === a.taskId) ?? null}
            />
          ))
        )}
      </section>

      <MarketStrip snap={snap} origin={origin} />
      <LatencyBar snap={snap} totalPaid={totalPaid} />
    </main>
  );
}

/* ------------------------------------------------------------------ agent -- */

function AgentColumn({ agent, task }: { agent: AgentRun; task: TaskState | null }) {
  const blocked = agent.status === "blocked";
  const done = agent.status === "done";

  return (
    <div
      className={`flex min-h-0 flex-col rounded-2xl border p-5 transition-all duration-300 ${
        blocked
          ? "border-amber-500 bg-amber-500/10"
          : done
            ? "border-emerald-800 bg-emerald-950/20"
            : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-bold">{agent.name}</h2>
        <span
          className={`text-xs font-semibold uppercase tracking-widest ${
            blocked ? "text-amber-400" : done ? "text-emerald-400" : "text-neutral-500"
          }`}
        >
          {blocked ? "stuck" : done ? "done" : "working"}
        </span>
      </div>
      <div className="mt-1 text-sm text-neutral-500">{agent.role}</div>

      {blocked && task && (
        <div className="mt-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
          <div className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-widest text-amber-400">
            <span>{task.requiresPhoto ? "needs a photo" : "needs a human"}</span>
            <span>${(task.amountRaw / 1_000_000).toFixed(2)}</span>
          </div>
          <p className="mt-2 leading-snug">{task.question}</p>
          {task.hasPhoto && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/photo?taskId=${task.id}`}
              alt=""
              className="mt-3 max-h-40 w-full rounded-lg object-cover"
            />
          )}
        </div>
      )}

      <div className="mt-4 min-h-0 flex-1 space-y-1.5 overflow-hidden">
        {agent.history.slice(-6).map((line, i, arr) => (
          <div
            key={`${i}-${line}`}
            className={`text-sm leading-snug ${
              i === arr.length - 1 ? "text-neutral-200" : "text-neutral-600"
            }`}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- market -- */

function MarketStrip({
  snap,
  origin,
}: {
  snap: PublicSnapshot | null;
  origin: string;
}) {
  const workers = snap?.workers ?? [];
  const now = snap?.now ?? Date.now();
  const tasks = snap?.tasks ?? [];

  // Before anyone joins, the QR is the only thing the room needs to act on.
  if (workers.length === 0) {
    return (
      <section className="flex items-center justify-center gap-8 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
        {origin && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/qr?url=${encodeURIComponent(origin)}`}
            alt="Scan to join"
            className="h-40 w-40 rounded-xl bg-white p-2"
          />
        )}
        <div>
          <div className="text-3xl font-bold">Scan to start earning</div>
          <div className="mt-2 text-lg text-neutral-400">
            No app. No wallet. Answer one question, get paid.
          </div>
          <div className="mt-2 font-mono text-sm text-neutral-600">
            {origin.replace(/^https?:\/\//, "")}
          </div>
        </div>
      </section>
    );
  }

  const shortlisted = new Set(tasks.flatMap((t) => t.shortlist));
  const claimedBy = new Set(tasks.map((t) => t.claimedBy).filter(Boolean) as string[]);
  const reasonFor = new Map(
    tasks.flatMap((t) => t.ineligible.map((i) => [i.workerId, i.reason] as const)),
  );

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
          Worker marketplace
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-500">{workers.length} online</span>
          {origin && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/qr?url=${encodeURIComponent(origin)}`}
              alt="Scan to join"
              className="h-12 w-12 rounded bg-white p-1"
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-6 gap-2">
        {workers.slice(0, 18).map((w) => (
          <WorkerCard
            key={w.id}
            worker={w}
            now={now}
            pinged={shortlisted.has(w.id) || (tasks.length > 0 && shortlisted.size === 0)}
            won={claimedBy.has(w.id)}
            anyTask={tasks.length > 0}
            reason={reasonFor.get(w.id)}
            earnedRaw={snap?.earned?.[w.id] ?? 0}
          />
        ))}
      </div>
    </section>
  );
}

function WorkerCard({
  worker,
  now,
  pinged,
  won,
  anyTask,
  reason,
  earnedRaw,
}: {
  worker: WorkerState;
  now: number;
  pinged: boolean;
  won: boolean;
  anyTask: boolean;
  reason?: string;
  earnedRaw: number;
}) {
  const offline = !worker.simulated && now - worker.lastHeartbeat > 10_000;
  const dimmed = anyTask && !pinged && !won;

  let label = "available";
  let tone = "border-neutral-800 bg-neutral-900/60";

  if (won) {
    label = "WON";
    tone = "border-emerald-500 bg-emerald-500/15";
  } else if (pinged) {
    label = "pinged";
    tone = "border-amber-400 bg-amber-400/10 animate-pulse";
  } else if (dimmed) {
    label = reason ?? (offline ? "offline" : "not selected");
    tone = "border-neutral-900 bg-neutral-950 opacity-35";
  } else if (offline) {
    label = "offline";
    tone = "border-neutral-900 bg-neutral-950 opacity-40";
  }

  return (
    <div className={`rounded-lg border px-3 py-2 transition-all duration-200 ${tone}`}>
      <div className="truncate text-sm font-semibold capitalize">{worker.name}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-1">
        <span className="truncate text-[10px] uppercase tracking-wider text-neutral-400">
          {label}
        </span>
        <span className="text-xs tabular-nums text-emerald-400">
          ${(earnedRaw / 1_000_000).toFixed(2)}
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- latency -- */

function LatencyBar({
  snap,
  totalPaid,
}: {
  snap: PublicSnapshot | null;
  totalPaid: number;
}) {
  const recent =
    snap?.pastTasks?.[snap.pastTasks.length - 1] ?? snap?.tasks?.[0] ?? null;

  const ms = (from?: number | null, to?: number | null) =>
    from && to
      ? to - from < 10_000
        ? `${to - from}ms`
        : `${((to - from) / 1000).toFixed(1)}s`
      : "—";

  return (
    <footer className="grid grid-cols-6 items-center gap-4 rounded-2xl border border-neutral-800 bg-black px-6 py-3 font-mono text-sm">
      <Metric label="claimed" value={ms(recent?.dispatchedAt, recent?.claimedAt)} />
      <Metric label="answered" value={ms(recent?.claimedAt, recent?.answeredAt)} />
      <Metric
        label="paid"
        value={ms(recent?.answeredAt, recent?.payment.confirmedAt)}
      />
      <Metric
        label="priority fee"
        value={
          recent?.payment.priorityFeeMicroLamports
            ? `${recent.payment.priorityFeeMicroLamports.toLocaleString()} µL/CU`
            : "—"
        }
        hint={
          recent?.payment.priorityFeeSource === "quicknode"
            ? "QuickNode"
            : recent?.payment.priorityFeeSource === "network-p75"
              ? "network p75"
              : undefined
        }
      />
      {/* Honest, permanently visible, sized like a fact rather than an alarm. */}
      <Metric
        label={snap?.mock ? "settlement" : "signature"}
        value={
          snap?.mock
            ? "simulated"
            : recent?.payment.signature
              ? `${recent.payment.signature.slice(0, 10)}…`
              : "—"
        }
        hint={snap?.mock ? undefined : "solana devnet"}
      />
      <Metric label="paid out" value={`$${(totalPaid / 1_000_000).toFixed(2)}`} />
    </footer>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-neutral-600">
        {hint ? `${label} · ${hint}` : label}
      </div>
      <div className="mt-0.5 truncate text-lg text-neutral-200">{value}</div>
    </div>
  );
}
