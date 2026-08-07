/**
 * Pre-demo preflight. Run this the morning of, and again before you walk on.
 *
 *   npx tsx --env-file=.env.local scripts/preflight.ts
 *
 * Every check is something that has a plausible way of being quietly broken on
 * the day: an expired key, a drained pool, an endpoint pointed at the wrong
 * cluster, a treasury that ran out of SOL overnight.
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Redis } from "@upstash/redis";
import Anthropic from "@anthropic-ai/sdk";
import { estimatePriorityFee, treasury, tokenMint } from "../lib/pay";

const ok = (s: string) => console.log(`\x1b[32m  ✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`\x1b[31m  ✗\x1b[0m ${s}`);
const warn = (s: string) => console.log(`\x1b[33m  !\x1b[0m ${s}`);
const head = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

let failures = 0;
const fail = (s: string) => {
  failures++;
  bad(s);
};

async function checkAnthropic() {
  head("Anthropic");
  if (!process.env.ANTHROPIC_API_KEY) return fail("ANTHROPIC_API_KEY not set");
  try {
    const client = new Anthropic();
    // Cheapest possible round trip that still proves key + credits.
    await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    ok("key valid, credits available");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("credit balance")) {
      fail("key is valid but the account has NO CREDITS — top up in Plans & Billing");
    } else {
      fail(`Anthropic call failed: ${msg.slice(0, 120)}`);
    }
  }
}

async function checkRpc() {
  head("QuickNode / Solana");
  if (!process.env.QUICKNODE_RPC_URL) return fail("QUICKNODE_RPC_URL not set");

  const conn = new Connection(process.env.QUICKNODE_RPC_URL, "confirmed");
  try {
    const genesis = await conn.getGenesisHash();
    if (genesis === DEVNET_GENESIS) ok("endpoint reachable, cluster = devnet");
    else fail(`endpoint is NOT devnet (genesis ${genesis.slice(0, 12)}…)`);
  } catch (err) {
    return fail(`RPC unreachable: ${err instanceof Error ? err.message : err}`);
  }

  const fee = await estimatePriorityFee();
  if (fee.source === "quicknode") {
    ok(`priority fee ${fee.microLamports} µL/CU via QuickNode add-on`);
  } else if (fee.source === "network-p75") {
    warn(
      `priority fee ${fee.microLamports} µL/CU from core RPC — enable the QuickNode Priority Fee add-on to use theirs`,
    );
  } else {
    warn(
      `priority fee falling back to floor (${fee.microLamports} µL/CU) — normal on an idle devnet`,
    );
  }
}

async function checkTreasury() {
  head("Treasury");
  if (!process.env.TREASURY_SECRET_KEY) return warn("TREASURY_SECRET_KEY not set — run scripts/mint-pool.ts");
  if (!process.env.TOKEN_MINT) return warn("TOKEN_MINT not set — run scripts/mint-pool.ts");

  const conn = new Connection(process.env.QUICKNODE_RPC_URL!, "confirmed");
  const payer = treasury();
  const mint = tokenMint();

  const sol = (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  if (sol >= 0.2) ok(`${sol.toFixed(3)} SOL`);
  else fail(`only ${sol.toFixed(3)} SOL — running out mid-demo is unrecoverable`);

  try {
    const ata = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const acct = await getAccount(conn, ata);
    const bal = Number(acct.amount) / 1_000_000;
    if (bal >= 10) ok(`${bal.toFixed(2)} demo USDC`);
    else fail(`only ${bal.toFixed(2)} demo USDC — re-run scripts/mint-pool.ts`);
  } catch {
    fail("treasury token account missing — run scripts/mint-pool.ts");
  }
}

async function checkRedis() {
  head("Redis / wallet pool");
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return fail("Redis env not set — vercel integration add upstash/upstash-kv");
  }
  try {
    const r = new Redis({ url, token });
    await r.ping();
    ok("Redis reachable");

    const depth = await r.llen("wallets:pool");
    if (depth >= 20) ok(`${depth} wallets in the pool`);
    else if (depth > 0) warn(`only ${depth} wallets left — re-run scripts/mint-pool.ts`);
    else fail("wallet pool is EMPTY — run scripts/mint-pool.ts");

    const workers = await r.hlen("workers");
    console.log(`    ${workers} workers currently registered`);
  } catch (err) {
    fail(`Redis failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  console.log("\n\x1b[1mHandoff preflight\x1b[0m");
  await checkAnthropic();
  await checkRpc();
  await checkRedis();
  await checkTreasury();

  console.log("");
  if (failures === 0) {
    console.log("\x1b[32m\x1b[1mREADY\x1b[0m — all checks passed\n");
  } else {
    console.log(`\x1b[31m\x1b[1m${failures} BLOCKER${failures === 1 ? "" : "S"}\x1b[0m — fix before going on stage\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("preflight crashed:", err);
  process.exit(1);
});
