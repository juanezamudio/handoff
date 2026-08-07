import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { renderReferenceData } from "./invoices";

/**
 * The accounts-payable agent.
 *
 * Callbacks are injected so this module can be exercised from a terminal script
 * with no Redis, no network, and no UI — which is how we verify that the model
 * genuinely stops twice rather than being told to.
 */
export type AgentCallbacks = {
  /** Called once per invoice the agent decides on. */
  onDecision: (d: {
    invoiceId: string;
    decision: Decision;
    reason: string;
  }) => Promise<void> | void;

  /**
   * Called when the agent gets stuck. MUST block until a human answers and then
   * resolve with the answer text. This blocking call is the entire product.
   */
  onAsk: (a: {
    invoiceId: string;
    question: string;
    options: string[];
  }) => Promise<string>;

  /** Free-form progress for the stage log. */
  onLog?: (message: string) => Promise<void> | void;
};

export type Decision = "approve" | "hold" | "reject";

export type RunAgentOptions = AgentCallbacks & {
  /**
   * Artificial pause after each recorded decision so the room can watch the
   * left panel animate. Without this the model resolves the clean invoices
   * faster than anyone can read. Set to 0 for tests.
   */
  decisionDelayMs?: number;
};

const SYSTEM_PROMPT = `You are an accounts-payable agent at a mid-sized manufacturer. You process supplier invoices for payment approval.

APPROVAL POLICY
An invoice may be approved only when all three of these hold:
  1. The vendor appears on the approved vendor list.
  2. The invoice total is within 10% of the purchase order amount.
  3. The remit-to bank account matches the account on file for that vendor.

HOW TO WORK
Process the invoices in the order given. For every invoice, call record_decision exactly once with your decision and a one-sentence reason.

WHEN TO INVOLVE A HUMAN
If an invoice does not satisfy the policy, first try to resolve it yourself from the information you have been given. If you genuinely cannot resolve it — because the answer depends on a fact you have not been given, or because it is a business judgment that is not yours to make — call ask_human before recording a decision.

Do not involve a human for anything you can settle from the data in front of you. Do not involve a human out of caution. Involve a human when you are actually blocked.

WRITING A GOOD QUESTION
The person answering is a stranger with no context about this company, this vendor, or this invoice. They will see only your question and your options, and they will answer in about fifteen seconds. So:
  - Give them the one or two facts they need to decide, in plain language.
  - Ask one question, not several.
  - Offer 2 to 4 short options, phrased as actions or answers rather than explanations.
  - Never assume they know an invoice number, a vendor code, or a policy rule.

After a human answers, record your decision for that invoice and continue with the rest.`;

export async function runAgent(opts: RunAgentOptions) {
  const { onDecision, onAsk, onLog, decisionDelayMs = 400 } = opts;

  const client = new Anthropic();

  const recordDecision = betaZodTool({
    name: "record_decision",
    description:
      "Record your approval decision for a single invoice. Call this exactly once per invoice.",
    inputSchema: z.object({
      invoiceId: z.string().describe("The invoice ID, e.g. INV-2038"),
      decision: z
        .enum(["approve", "hold", "reject"])
        .describe("Your decision for this invoice"),
      reason: z.string().describe("One sentence explaining the decision"),
    }),
    run: async ({ invoiceId, decision, reason }) => {
      await onDecision({ invoiceId, decision: decision as Decision, reason });
      if (decisionDelayMs > 0) {
        await new Promise((r) => setTimeout(r, decisionDelayMs));
      }
      return `Recorded: ${invoiceId} → ${decision}`;
    },
  });

  const askHuman = betaZodTool({
    name: "ask_human",
    description:
      "Ask a human a short question when you cannot resolve something yourself. " +
      "Use this only when the answer requires a fact you have not been given, or a " +
      "business judgment that is not yours to make. The person answering has no " +
      "context and will answer in about fifteen seconds.",
    inputSchema: z.object({
      invoiceId: z
        .string()
        .describe("The invoice this question is about, e.g. INV-2041"),
      question: z
        .string()
        .describe(
          "A single question a stranger can answer in under fifteen seconds",
        ),
      options: z
        .array(z.string())
        .min(2)
        .max(4)
        .describe("2-4 short answer options, phrased as actions or answers"),
    }),
    run: async ({ invoiceId, question, options }) => {
      await onLog?.(`Stuck on ${invoiceId} — asking a human`);
      const answer = await onAsk({ invoiceId, question, options });
      await onLog?.(`Human answered: ${answer}`);
      return answer;
    },
  });

  const userMessage = `Here is today's approval queue.\n\n${renderReferenceData()}\n\nProcess every invoice.`;

  // NOTE: never set thinking to "disabled" on claude-opus-5. With thinking off it
  // occasionally writes a tool call into visible text instead of emitting a
  // tool_use block — the turn succeeds, ask_human never fires, and nothing errors.
  // On stage that reads as the agent silently skipping the human. Control latency
  // with effort instead.
  const finalMessage = await client.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    tools: [recordDecision, askHuman],
    messages: [{ role: "user", content: userMessage }],
  });

  return finalMessage;
}
