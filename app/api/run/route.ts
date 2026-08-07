import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import { dispatchTask, waitForAnswer } from "@/lib/dispatch";
import { log, mutate, putAgent, readSnapshot, setInvoice } from "@/lib/state";

/**
 * The REAL, model-driven accounts-payable agent.
 *
 * The three-agent demo (/control → Start agents) is scripted and free to run.
 * This route is the genuine article: Claude decides for itself which invoices
 * it cannot resolve, and it was verified across repeated runs to find both of
 * its escalations unprompted. It costs money per run, so it is not the default
 * — but it works, and it's the honest answer to "is the demo scripted?".
 *
 * It registers itself as an agent named "live" so it renders on the same stage
 * as the scripted three.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const LIVE_ID = "live";
const LIVE_NAME = "Accounts Payable (live model)";

export async function POST() {
  const snap = await readSnapshot({ fresh: true });
  if (snap.agents.some((a) => a.id === LIVE_ID && a.status !== "done")) {
    return NextResponse.json({ error: "a live run is already going" }, { status: 409 });
  }

  await putAgent({
    id: LIVE_ID,
    name: LIVE_NAME,
    role: "approving supplier invoices with Claude",
    status: "working",
    stepIndex: 0,
    stepStartedAt: Date.now(),
    history: ["Loading today's invoice queue — 8 invoices"],
    taskId: null,
  });
  await mutate((s) => {
    s.phase = "running";
    s.runStartedAt = Date.now();
  });
  await log("Live model agent started");

  const push = async (line: string, patch: Record<string, unknown> = {}) => {
    const cur = (await readSnapshot({ fresh: true })).agents.find(
      (a) => a.id === LIVE_ID,
    );
    if (!cur) return;
    await putAgent({ ...cur, history: [...cur.history, line].slice(-8), ...patch });
  };

  try {
    await runAgent({
      decisionDelayMs: 400,

      onDecision: async ({ invoiceId, decision, reason }) => {
        await setInvoice(invoiceId, decision, reason);
        await push(`${invoiceId} — ${decision}`);
      },

      onLog: async (message) => {
        await log(message);
      },

      onAsk: async ({ invoiceId, question, options }) => {
        await setInvoice(invoiceId, "deciding");
        const task = await dispatchTask({
          agentId: LIVE_ID,
          agentName: LIVE_NAME,
          invoiceId,
          question,
          options,
        });
        await push(`Stuck on ${invoiceId} — asking a human`, {
          status: "blocked",
          taskId: task.id,
        });

        const answer = await waitForAnswer(task.id);

        await mutate((s) => {
          if (!s.pastTaskIds.includes(task.id)) {
            s.pastTaskIds = [...s.pastTaskIds, task.id];
          }
        });
        await push(`Human answered: ${answer ?? "nobody available"}`, {
          status: "working",
          taskId: null,
        });

        return (
          answer ??
          "No human was available in time. Hold this invoice for manual review."
        );
      },
    });

    await push("Run complete", { status: "done", taskId: null });
    await log("Live model run complete");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await push(`Run failed: ${message}`, { status: "done", taskId: null });
    await log(`Live model run failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
