"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicSnapshot, TaskState, WorkerState } from "@/lib/state";

/**
 * The worker page — the QR target.
 *
 * Built around one constraint: a stranger in an audience has about ten seconds
 * of patience and one thumb. Scan, tap once, in. No install, no wallet, no
 * typing, no auth.
 *
 * With three agents running there can be several jobs open at once, so this is
 * a board you pick from rather than a single prompt — which also makes the
 * market legible from the worker's side, not just the projector's.
 */

type ClaimResult =
  | { won: true; taskId: string }
  | { won: false; missedBySeconds?: number; winnerName?: string | null; reason?: string };

const POLL_MS = 1000;
const PHOTO_MAX_EDGE = 640;
const PHOTO_QUALITY = 0.6;

export default function WorkerPage() {
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const [snap, setSnap] = useState<PublicSnapshot | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const audioRef = useRef<AudioContext | null>(null);
  const alerted = useRef<Set<string>>(new Set());

  // --- alerting -------------------------------------------------------------
  // navigator.vibrate() is a NO-OP on iOS Safari — half the room. So: an audio
  // beep (unlocked by the join tap, the only way iOS permits audio), a
  // full-screen flash, and vibration where it happens to work.
  const alertMe = useCallback(() => {
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
    try {
      navigator.vibrate?.([120, 60, 120]);
    } catch {}

    const ctx = audioRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  }, []);

  // --- join -----------------------------------------------------------------
  const join = useCallback(async () => {
    setJoining(true);
    setError(null);

    // Must run inside the tap handler — iOS only unlocks audio from a gesture.
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      await ctx.resume();
      audioRef.current = ctx;
    } catch {}

    try {
      const sid = localStorage.getItem("handoff-sid") ?? crypto.randomUUID();
      localStorage.setItem("handoff-sid", sid);
      const res = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not join");
      setWorker(data.worker);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not join");
    } finally {
      setJoining(false);
    }
  }, []);

  // --- poll -----------------------------------------------------------------
  useEffect(() => {
    if (!worker) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/state?w=${worker.id}`, { cache: "no-store" });
        if (!alive) return;
        setSnap(await res.json());
      } catch {
        // A dropped poll costs 1s — exactly why there's no SSE here.
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    const onVis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [worker]);

  const tasks = snap?.tasks ?? [];
  const myId = worker?.id ?? "";
  const open = tasks.filter(
    (t) => !t.claimedBy && (t.shortlist.length === 0 || t.shortlist.includes(myId)),
  );
  const mine = tasks.find((t) => t.claimedBy === myId && !t.answer) ?? null;
  const settling =
    snap?.pastTasks.find((t) => t.claimedBy === myId && t.answer) ?? null;

  // Alert once per job that's actually routed to me.
  useEffect(() => {
    const fresh = open.filter((t) => !alerted.current.has(t.id));
    if (fresh.length === 0) return;
    fresh.forEach((t) => alerted.current.add(t.id));
    setClaim(null);
    alertMe();
  }, [open, alertMe]);

  const doClaim = async (taskId: string) => {
    if (!worker) return;
    setBusy(true);
    const res = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: worker.id, taskId }),
    });
    const data = await res.json();
    setClaim(data.won ? { won: true, taskId } : data);
    setBusy(false);
  };

  const doAnswer = async (answer: string) => {
    if (!mine || !worker) return;
    setBusy(true);
    if (photo) {
      await fetch("/api/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: mine.id, dataUrl: photo, workerId: worker.id }),
      });
    }
    await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: worker.id, taskId: mine.id, answer }),
    });
    setPhoto(null);
    setTyped("");
    setBusy(false);
  };

  // Downscale hard before upload — a raw phone photo is megabytes, and this only
  // has to be legible enough to count a room on a projector.
  const onPhoto = async (file: File) => {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    setPhoto(canvas.toDataURL("image/jpeg", PHOTO_QUALITY));
  };

  const earnedRaw = snap?.earned?.[myId] ?? 0;
  const earned = (earnedRaw / 1_000_000).toFixed(2);

  // --- join screen ----------------------------------------------------------
  if (!worker) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-neutral-950 p-8 text-white">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight">Handoff</h1>
          <p className="mt-3 text-lg text-neutral-400">
            Answer a question for an AI. Get paid instantly.
          </p>
        </div>
        <button
          onClick={join}
          disabled={joining}
          className="w-full max-w-sm rounded-2xl bg-emerald-500 px-8 py-6 text-2xl font-semibold text-black active:scale-[0.98] disabled:opacity-50"
        >
          {joining ? "Joining…" : "Tap to start earning"}
        </button>
        {error && <p className="text-center text-red-400">{error}</p>}
        <p className="max-w-sm text-center text-sm text-neutral-500">
          No app, no wallet, no signup. A wallet is created for you the moment
          you tap.
        </p>
      </main>
    );
  }

  return (
    <main
      className={`min-h-dvh p-5 text-white transition-colors duration-200 ${
        flash ? "bg-emerald-500" : "bg-neutral-950"
      }`}
    >
      <header className="flex items-baseline justify-between border-b border-neutral-800 pb-4">
        <div>
          <div className="text-xl font-semibold capitalize">{worker.name}</div>
          <div className="font-mono text-xs text-neutral-500">
            {worker.pubkey.slice(0, 4)}…{worker.pubkey.slice(-4)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold tabular-nums text-emerald-400">
            ${earned}
          </div>
          <div className="text-xs text-neutral-500">earned</div>
        </div>
      </header>

      <section className="mt-6 space-y-4">
        {/* I hold a job — answer it */}
        {mine && (
          <AnswerCard
            task={mine}
            photo={photo}
            typed={typed}
            busy={busy}
            onPhoto={onPhoto}
            onTyped={setTyped}
            onAnswer={doAnswer}
          />
        )}

        {/* Payment in flight */}
        {!mine && settling && (
          <div className="rounded-2xl border border-emerald-800 bg-emerald-950/40 p-8 text-center">
            <div className="text-sm uppercase tracking-widest text-emerald-400">
              {settling.payment.status === "confirmed" ? "Paid" : "Paying…"}
            </div>
            <div className="mt-2 text-5xl font-bold tabular-nums">
              ${(settling.amountRaw / 1_000_000).toFixed(2)}
            </div>
            {settling.payment.signature &&
              (snap?.mock ? (
                <div className="mt-4 text-xs font-semibold uppercase tracking-widest text-amber-400">
                  simulated — not a real transaction
                </div>
              ) : (
                <a
                  href={`https://explorer.solana.com/tx/${settling.payment.signature}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block font-mono text-xs text-emerald-400 underline"
                >
                  {settling.payment.signature.slice(0, 20)}…
                </a>
              ))}
          </div>
        )}

        {/* Lost a race */}
        {!mine && claim?.won === false && (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6 text-center">
            {claim.missedBySeconds != null ? (
              <>
                <div className="text-3xl font-bold text-amber-400">
                  Missed by {claim.missedBySeconds}s
                </div>
                {claim.winnerName && (
                  <div className="mt-1 capitalize text-neutral-400">
                    {claim.winnerName} got it
                  </div>
                )}
              </>
            ) : (
              <div className="text-neutral-400">{claim.reason ?? "Not this time"}</div>
            )}
          </div>
        )}

        {/* The job board */}
        {!mine && open.length > 0 && (
          <>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">
              {open.length} job{open.length === 1 ? "" : "s"} available
            </div>
            {open.map((t) => (
              <button
                key={t.id}
                disabled={busy}
                onClick={() => doClaim(t.id)}
                className="w-full rounded-2xl border border-emerald-600 bg-emerald-950/30 p-5 text-left active:scale-[0.99] disabled:opacity-50"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wider text-neutral-400">
                    {t.agentName}
                  </span>
                  <span className="text-lg font-bold tabular-nums text-emerald-400">
                    ${(t.amountRaw / 1_000_000).toFixed(2)}
                  </span>
                </div>
                <div className="mt-2 leading-snug">{t.question}</div>
                <div className="mt-3 text-sm font-semibold text-emerald-400">
                  {t.requiresPhoto ? "Claim it — needs a photo" : "Claim it"}
                </div>
              </button>
            ))}
          </>
        )}

        {/* Idle */}
        {!mine && !settling && open.length === 0 && !claim && (
          <div className="py-16 text-center">
            <div className="text-lg text-neutral-400">Waiting for work…</div>
            <div className="mt-2 text-sm text-neutral-600">
              Keep this screen open. Your phone will buzz.
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function AnswerCard({
  task,
  photo,
  typed,
  busy,
  onPhoto,
  onTyped,
  onAnswer,
}: {
  task: TaskState;
  photo: string | null;
  typed: string;
  busy: boolean;
  onPhoto: (f: File) => void;
  onTyped: (v: string) => void;
  onAnswer: (a: string) => void;
}) {
  const needsPhoto = Boolean(task.requiresPhoto);
  const canSubmit = needsPhoto ? Boolean(photo) && typed.trim().length > 0 : true;

  return (
    <div className="space-y-5">
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">
        You got it · {task.agentName}
      </div>
      <p className="text-xl leading-relaxed">{task.question}</p>

      {needsPhoto ? (
        <div className="space-y-4">
          <label className="block w-full rounded-2xl border-2 border-dashed border-emerald-600 bg-emerald-950/20 p-6 text-center active:scale-[0.99]">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt="" className="mx-auto max-h-56 rounded-xl" />
            ) : (
              <>
                <div className="text-4xl">📷</div>
                <div className="mt-2 font-semibold">Take a photo of the room</div>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPhoto(f);
              }}
            />
            {photo && (
              <div className="mt-3 text-sm text-emerald-400">
                Tap to retake
              </div>
            )}
          </label>

          <input
            type="number"
            inputMode="numeric"
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            placeholder={task.inputHint ?? "Your answer"}
            className="w-full rounded-xl border border-neutral-700 bg-neutral-900 px-5 py-5 text-2xl tabular-nums outline-none focus:border-emerald-500"
          />

          <button
            disabled={busy || !canSubmit}
            onClick={() => onAnswer(`${typed} people`)}
            className="w-full rounded-2xl bg-emerald-500 px-6 py-6 text-2xl font-bold text-black active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send it"}
          </button>
          {!canSubmit && (
            <p className="text-center text-sm text-neutral-500">
              Photo and a count are both needed.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {task.options.map((opt) => (
            <button
              key={opt}
              disabled={busy}
              onClick={() => onAnswer(opt)}
              className="w-full rounded-xl border border-neutral-700 bg-neutral-900 px-5 py-5 text-left text-lg active:scale-[0.99] disabled:opacity-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
