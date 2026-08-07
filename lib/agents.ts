/**
 * The three demo agents.
 *
 * These are scripted rather than model-driven. That is a deliberate trade: the
 * product being demonstrated is the marketplace — dispatch, the claim race, and
 * settlement — not the model's reasoning. Scripting the agents makes the demo
 * free to rehearse, deterministic on stage, and lets three of them run at once.
 *
 * (A real Claude-driven version of the accounts-payable agent lives in
 * lib/agent.ts and still works via /api/run. It was verified to find both of
 * its own escalations unprompted; it just costs money to rehearse.)
 *
 * WHY THESE THREE
 * Each one gets stuck for a genuinely different reason, and together they make
 * the argument that this market doesn't shrink as models improve:
 *
 *   ap      — can't KNOW      : the fact lives in a human's head
 *   ops     — can't PERCEIVE  : the answer is in a physical room
 *   support — shouldn't DECIDE: a judgment call with money on both sides
 *
 * The middle one is the sharpest. No amount of intelligence lets a model count
 * the people standing in front of you.
 */

export type AgentStep =
  | { kind: "work"; label: string; ms: number }
  | {
      kind: "ask";
      label: string;
      question: string;
      /** Tap-to-answer choices. Omit when the answer is typed. */
      options?: string[];
      /** Demands a photo as evidence alongside the answer. */
      requiresPhoto?: boolean;
      /** Placeholder for the typed answer, when there are no options. */
      inputHint?: string;
    }
  | { kind: "done"; label: string };

export type AgentScript = {
  id: string;
  name: string;
  role: string;
  /** Stagger the starts so the three stuck moments don't land on top of each other. */
  startDelayMs: number;
  steps: AgentStep[];
};

export const AGENTS: AgentScript[] = [
  {
    id: "ap",
    name: "Accounts Payable",
    role: "approving supplier invoices",
    startDelayMs: 0,
    steps: [
      { kind: "work", label: "Loading today's invoice queue — 8 invoices", ms: 1600 },
      { kind: "work", label: "INV-2038 Northwind Logistics $3,200 — approved", ms: 1300 },
      { kind: "work", label: "INV-2039 Kestrel Print $890 — approved", ms: 1300 },
      { kind: "work", label: "INV-2040 Bayline Materials $6,750 — approved", ms: 1400 },
      { kind: "work", label: "INV-2041 ACME Supplies Inc. $4,100 — checking vendor…", ms: 1800 },
      {
        kind: "ask",
        label: "Vendor identity can't be verified",
        question:
          "An invoice arrived from \"ACME Supplies Inc.\" for $4,100. Our records list a supplier called \"Acme Supply Co.\" — and the bank account on the invoice is different from the one we've paid before. Same company, or someone impersonating them?",
        options: [
          "Same company — records are just out of date",
          "Different — do not pay",
          "Hold it until someone calls the vendor",
        ],
      },
      { kind: "work", label: "INV-2041 resolved — recorded with human sign-off", ms: 1500 },
      { kind: "work", label: "INV-2042 Northwind Logistics $1,450 — approved", ms: 1300 },
      { kind: "work", label: "INV-2043 Delta Fabrication $9,800 — approved", ms: 1300 },
      { kind: "done", label: "8 of 8 invoices cleared" },
    ],
  },

  {
    id: "ops",
    name: "Event Operations",
    role: "managing tonight's catering order",
    startDelayMs: 2200,
    steps: [
      { kind: "work", label: "Reading catering contract for Cursor ship night", ms: 1600 },
      { kind: "work", label: "Final headcount due to venue 30 minutes before doors", ms: 1500 },
      { kind: "work", label: "Ticketed RSVPs: 240", ms: 1300 },
      { kind: "work", label: "Historical no-show rate for this venue: 31%", ms: 1400 },
      { kind: "work", label: "Estimating turnout… 165 ± 48. Confidence too low to commit", ms: 2000 },
      {
        kind: "ask",
        label: "Needs eyes in the room",
        question:
          "How many people are at Cursor ship night right now? Take a photo of the room so we can confirm the count.",
        requiresPhoto: true,
        inputHint: "Roughly how many people?",
      },
      { kind: "work", label: "Headcount confirmed — resizing catering order", ms: 1600 },
      { kind: "work", label: "Order updated with venue, confirmation sent", ms: 1400 },
      { kind: "done", label: "Catering locked for tonight" },
    ],
  },

  {
    id: "support",
    name: "Customer Support",
    role: "resolving refund requests",
    startDelayMs: 4200,
    steps: [
      { kind: "work", label: "Ticket #4471 — refund request, $2,400", ms: 1500 },
      { kind: "work", label: "Account: Enterprise plan, 14 months tenure", ms: 1300 },
      { kind: "work", label: "Purchase date: 33 days ago", ms: 1300 },
      { kind: "work", label: "Policy: refunds available within 30 days", ms: 1400 },
      { kind: "work", label: "Request is 3 days outside the window", ms: 1500 },
      {
        kind: "ask",
        label: "Exception is above its authority",
        question:
          "A customer is asking for a $2,400 refund three days after the refund window closed. They've been with us 14 months and spend well. Policy says no. Make an exception?",
        options: [
          "Approve the refund",
          "Offer account credit instead",
          "Decline — hold the policy",
        ],
      },
      { kind: "work", label: "Decision applied, customer notified", ms: 1500 },
      { kind: "done", label: "Ticket #4471 closed" },
    ],
  },
];

export function agentById(id: string): AgentScript | undefined {
  return AGENTS.find((a) => a.id === id);
}
