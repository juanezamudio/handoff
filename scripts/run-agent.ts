/**
 * Terminal harness for the agent — no Redis, no UI, no network beyond Anthropic.
 *
 * This is the exit criterion for the agent build: prove the model stops exactly
 * twice, on INV-2041 and INV-2044, WITHOUT any case-specific text in the prompt.
 * If this passes five times in a row, the demo's riskiest assumption holds.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/run-agent.ts
 *
 * Set INTERACTIVE=1 to answer the questions yourself instead of auto-answering.
 */
import * as readline from "node:readline/promises";
import { runAgent, type Decision } from "../lib/agent";

const EXPECTED_STOPS = ["INV-2041", "INV-2044"];
const INTERACTIVE = process.env.INTERACTIVE === "1";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function main() {
  const decisions: { invoiceId: string; decision: Decision; reason: string }[] =
    [];
  const stops: { invoiceId: string; question: string; options: string[] }[] = [];

  const started = Date.now();
  const t = () => dim(`+${((Date.now() - started) / 1000).toFixed(1)}s`);

  await runAgent({
    decisionDelayMs: 0,

    onDecision: (d) => {
      decisions.push(d);
      const mark =
        d.decision === "approve" ? green("✓") : yellow(d.decision.toUpperCase());
      console.log(`${t()} ${mark} ${bold(d.invoiceId)} ${dim(d.reason)}`);
    },

    onLog: (m) => console.log(`${t()} ${dim(m)}`),

    onAsk: async ({ invoiceId, question, options }) => {
      stops.push({ invoiceId, question, options });
      console.log("");
      console.log(`${t()} ${red("■ STUCK")} ${bold(invoiceId)}`);
      console.log(`   ${question}`);
      options.forEach((o, i) => console.log(`   ${dim(`[${i}]`)} ${o}`));

      if (!INTERACTIVE) {
        await new Promise((r) => setTimeout(r, 300));
        console.log(`   ${dim(`auto-answering: ${options[0]}`)}\n`);
        return options[0];
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const raw = await rl.question("   your answer (number): ");
      rl.close();
      const idx = Number.parseInt(raw.trim(), 10);
      const chosen = options[Number.isNaN(idx) ? 0 : idx] ?? options[0];
      console.log("");
      return chosen;
    },
  });

  // ---- verdict -------------------------------------------------------------
  const stopIds = stops.map((s) => s.invoiceId);
  const decidedIds = decisions.map((d) => d.invoiceId);

  const stoppedTwice = stops.length === 2;
  const stoppedCorrectly =
    EXPECTED_STOPS.every((id) => stopIds.includes(id)) && stoppedTwice;
  const decidedAll = new Set(decidedIds).size === 8;

  console.log("");
  console.log(bold("──────── verdict ────────"));
  console.log(
    `decisions recorded : ${decidedAll ? green(`${new Set(decidedIds).size}/8`) : red(`${new Set(decidedIds).size}/8`)}`,
  );
  console.log(
    `human escalations  : ${stoppedTwice ? green(String(stops.length)) : red(String(stops.length))} ${dim("(want 2)")}`,
  );
  console.log(
    `stopped on         : ${stoppedCorrectly ? green(stopIds.join(", ")) : red(stopIds.join(", ") || "none")} ${dim(`(want ${EXPECTED_STOPS.join(", ")})`)}`,
  );
  console.log(
    `elapsed            : ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log("");

  const pass = stoppedCorrectly && decidedAll;
  console.log(pass ? green(bold("PASS")) : red(bold("FAIL")));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(red("\nagent run threw:"), err);
  process.exit(1);
});
