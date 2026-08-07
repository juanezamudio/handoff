"use client";

import { useEffect, useState } from "react";
import type { PublicSnapshot } from "@/lib/state";

/**
 * Operator panel — keep this open on a second device during the demo.
 *
 * Every control here is a parachute for a specific way the demo can go wrong:
 * a silent room, a stalled dispatch, an unfunded treasury, a run that needs
 * resetting between rehearsals.
 */
export default function ControlPage() {
  const [snap, setSnap] = useState<PublicSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        setSnap(await res.json());
      } catch {}
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);

  const control = async (action: string, value?: unknown) => {
    setBusy(action);
    setNote(null);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      });
      const data = await res.json();
      setNote(res.ok ? JSON.stringify(data) : (data.error ?? "failed"));
    } catch (err) {
      setNote(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const startRun = async () => {
    setBusy("run");
    setNote("live model running — this request stays open for the whole run");
    try {
      const res = await fetch("/api/run", { method: "POST" });
      const data = await res.json();
      setNote(res.ok ? "run complete" : (data.error ?? "run failed"));
    } catch (err) {
      setNote(err instanceof Error ? err.message : "run failed");
    } finally {
      setBusy(null);
    }
  };

  const tasks = snap?.tasks ?? [];
  const workers = snap?.workers ?? [];
  const simulated = workers.filter((w) => w.simulated).length;

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-6 bg-neutral-950 p-6 text-white">
      <header className="flex items-baseline justify-between border-b border-neutral-800 pb-4">
        <h1 className="text-2xl font-bold">Control</h1>
        <div className="text-right text-sm">
          <div className="text-neutral-400">
            phase <span className="text-white">{snap?.phase ?? "—"}</span>
          </div>
          <div className="text-neutral-500">
            {workers.length} workers ({simulated} simulated)
          </div>
        </div>
      </header>

      {snap?.mock && (
        <div className="rounded-xl border border-amber-500 bg-amber-500/10 px-4 py-3 text-center font-semibold text-amber-300">
          MOCK MODE — payments are simulated, nothing touches the chain
        </div>
      )}

      <Section title="Run">
        <Btn
          onClick={() => control("startAgents")}
          busy={busy === "startAgents"}
          primary
        >
          Start the three agents
        </Btn>
        <Btn onClick={() => control("reset")} busy={busy === "reset"}>
          Reset (keeps roster)
        </Btn>
        <p className="text-sm text-neutral-500">
          The three agents are scripted — free to run, and they advance while the
          projector page is open.
        </p>
        <Btn onClick={startRun} busy={busy === "run"}>
          Start the LIVE model agent (costs API credits)
        </Btn>
      </Section>

      <Section title="Payments">
        <Btn
          onClick={() => control("mock", !snap?.mock)}
          busy={busy === "mock"}
        >
          {snap?.mock ? "Switch to real devnet payments" : "Turn ON mock mode"}
        </Btn>
        <p className="text-sm text-neutral-500">
          Mock mode needs no treasury, no wallet pool, and no funding. Use it to
          rehearse the whole flow, then switch off once devnet is funded.
        </p>
      </Section>

      <Section title="Roster">
        <Btn onClick={() => control("spawnWorkers", 8)} busy={busy === "spawnWorkers"}>
          Spawn 8 simulated workers
        </Btn>
        <Btn
          onClick={() => control("clearSimulated")}
          busy={busy === "clearSimulated"}
        >
          Clear simulated
        </Btn>
        <Btn
          onClick={() => control("clearAllWorkers")}
          busy={busy === "clearAllWorkers"}
        >
          Clear everyone (roster back to empty)
        </Btn>
        <p className="text-sm text-neutral-500">
          Simulated workers always read as online, so a solo rehearsal still
          shows a full roster and a real shortlist.
        </p>
      </Section>

      <Section title="Dispatch parachutes">
        {tasks.length > 0 ? (
          <>
            <Btn onClick={() => control("widen")} busy={busy === "widen"}>
              Expand every open job to all workers
            </Btn>
            {tasks.map((t) => (
              <div
                key={t.id}
                className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3"
              >
                <div className="text-xs uppercase tracking-wider text-amber-400">
                  {t.agentName} {t.requiresPhoto ? "· needs a photo" : ""}
                </div>
                <div className="text-sm">{t.question}</div>
                {(t.options.length > 0
                  ? t.options
                  : ["120 people"]
                ).map((opt) => (
                  <Btn
                    key={opt}
                    onClick={() =>
                      control("forceAnswer", { taskId: t.id, answer: opt })
                    }
                    busy={busy === "forceAnswer"}
                  >
                    Answer for them: “{opt}”
                  </Btn>
                ))}
              </div>
            ))}
          </>
        ) : (
          <p className="text-sm text-neutral-500">
            No open jobs. Parachutes appear here when an agent is waiting on a
            human.
          </p>
        )}
      </Section>

      {note && (
        <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs text-neutral-400">
          {note}
        </pre>
      )}

      <div className="border-t border-neutral-900 pt-4 text-sm text-neutral-500">
        <a className="underline" href="/stage" target="_blank" rel="noreferrer">
          open projector →
        </a>
        <span className="mx-3">·</span>
        <a className="underline" href="/" target="_blank" rel="noreferrer">
          open worker page →
        </a>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Btn({
  onClick,
  busy,
  primary,
  children,
}: {
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`w-full rounded-xl px-5 py-4 text-left text-base font-medium active:scale-[0.99] disabled:opacity-50 ${
        primary
          ? "bg-emerald-500 text-black"
          : "border border-neutral-700 bg-neutral-900 text-white"
      }`}
    >
      {busy ? "working…" : children}
    </button>
  );
}
