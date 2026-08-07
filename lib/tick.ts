import { AGENTS, agentById, type AgentStep } from "./agents";
import { dispatchTask } from "./dispatch";
import {
  KEYS,
  getAgents,
  log,
  mutate,
  patchTask,
  putAgent,
  redis,
  type AgentRun,
} from "./state";

/**
 * Advances the scripted agents.
 *
 * There is no server-side timer — serverless has nowhere to keep one. Instead
 * the projector and control pages tick as a side effect of polling, and every
 * advance is derived from wall-clock elapsed time, so the agents progress at
 * the same rate no matter how often (or how erratically) ticks arrive.
 *
 * A short SET NX lock keeps concurrent pollers from double-advancing a step or
 * dispatching the same job twice.
 */

const TICK_LOCK = "tick:lock";
const LOCK_MS = 900;

export async function startAgents(): Promise<void> {
  const now = Date.now();
  for (const script of AGENTS) {
    const run: AgentRun = {
      id: script.id,
      name: script.name,
      role: script.role,
      status: "idle", // becomes "working" once its stagger elapses
      stepIndex: 0,
      stepStartedAt: now + script.startDelayMs,
      history: [],
      taskId: null,
    };
    await putAgent(run);
  }
  await mutate((s) => {
    s.phase = "running";
    s.runStartedAt = now;
  });
  await log(`${AGENTS.length} agents started`);
}

export async function tick(): Promise<void> {
  const r = redis();
  const got = await r.set(TICK_LOCK, "1", { nx: true, px: LOCK_MS });
  if (got !== "OK") return; // another poller is already advancing them

  const agents = await getAgents();
  if (agents.length === 0) return;

  const now = Date.now();
  let anyActive = false;

  for (const agent of agents) {
    const script = agentById(agent.id);
    if (!script || agent.status === "done") continue;

    // Still inside its stagger delay.
    if (now < agent.stepStartedAt) {
      anyActive = true;
      continue;
    }

    const step: AgentStep | undefined = script.steps[agent.stepIndex];
    if (!step) {
      await putAgent({ ...agent, status: "done", taskId: null });
      continue;
    }

    anyActive = true;

    if (step.kind === "done") {
      await putAgent({
        ...agent,
        status: "done",
        taskId: null,
        history: [...agent.history, step.label],
      });
      await log(`${agent.name}: ${step.label}`);
      continue;
    }

    if (step.kind === "work") {
      if (agent.status !== "working") {
        await putAgent({ ...agent, status: "working" });
      }
      if (now - agent.stepStartedAt >= step.ms) {
        await putAgent({
          ...agent,
          status: "working",
          stepIndex: agent.stepIndex + 1,
          stepStartedAt: now,
          history: [...agent.history, step.label].slice(-8),
        });
      }
      continue;
    }

    // step.kind === "ask"
    if (agent.status !== "blocked") {
      const task = await dispatchTask({
        agentId: agent.id,
        agentName: agent.name,
        invoiceId: step.label,
        question: step.question,
        options: step.options ?? [],
        requiresPhoto: step.requiresPhoto,
        inputHint: step.inputHint,
      });
      await putAgent({ ...agent, status: "blocked", taskId: task.id });
      await log(`${agent.name} is stuck — ${step.label}`);
      continue;
    }

    // Blocked: has the human answered yet?
    if (agent.taskId) {
      const answer = await r.get<string>(KEYS.answer(agent.taskId));
      if (answer) {
        await mutate((s) => {
          if (!agent.taskId) return;
          if (!s.pastTaskIds.includes(agent.taskId)) {
            s.pastTaskIds = [...s.pastTaskIds, agent.taskId];
          }
        });
        await putAgent({
          ...agent,
          status: "working",
          stepIndex: agent.stepIndex + 1,
          stepStartedAt: now,
          taskId: null,
          history: [...agent.history, `Human answered: ${answer}`].slice(-8),
        });
        await log(`${agent.name} resumed`);
      }
    }
  }

  if (!anyActive) {
    await mutate((s) => {
      if (s.phase !== "done") s.phase = "done";
    });
  }
}

/** Marks a task answered from the tick side, used by the operator parachute. */
export async function noteAnswered(taskId: string, answer: string) {
  await patchTask(taskId, (t) => {
    t.answer = answer;
    t.answeredAt = Date.now();
  });
}
