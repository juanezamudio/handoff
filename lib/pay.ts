import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * Worker payments.
 *
 * Design notes that matter on stage:
 *  - Workers never sign anything. The treasury signs and pays them. That is why
 *    we store only a pubkey and an ATA for each worker and hold NO secret keys.
 *  - This is called from inside waitUntil() AFTER the answer has already been
 *    written, so a slow or failed payment can never stall the agent's resume.
 *  - QuickNode is load-bearing here, not decorative: we ask it what the priority
 *    fee should be, set it on the transaction, and show the number on stage.
 */

/** 6 decimals. $0.40 = 400_000. The off-by-1000 here is the classic mistake. */
export const TOKEN_DECIMALS = 6;
export const TASK_PRICE_RAW = 400_000; // $0.40

/** Used only if QuickNode's estimate is unavailable — never silently zero. */
const FALLBACK_PRIORITY_FEE_MICROLAMPORTS = 10_000;
const COMPUTE_UNIT_LIMIT = 60_000;

const REBROADCAST_INTERVAL_MS = 500;
const CONFIRM_POLL_MS = 400;
const CONFIRM_TIMEOUT_MS = 30_000;

export type PaymentProgress =
  | {
      status: "sent";
      signature: string;
      priorityFeeMicroLamports: number;
      priorityFeeSource: FeeSource;
    }
  | { status: "confirmed"; signature: string; confirmedAt: number }
  | { status: "failed"; error: string };

export type PaymentResult = {
  signature: string | null;
  priorityFeeMicroLamports: number;
  priorityFeeSource: FeeSource;
  confirmedAt: number | null;
  error?: string;
};

function rpcUrl(): string {
  const url = process.env.QUICKNODE_RPC_URL;
  if (!url) throw new Error("QUICKNODE_RPC_URL is not set");
  return url;
}

export function connection(): Connection {
  return new Connection(rpcUrl(), "confirmed");
}

/** Accepts either a base58 string or a JSON array of bytes. */
export function treasury(): Keypair {
  const raw = process.env.TREASURY_SECRET_KEY;
  if (!raw) throw new Error("TREASURY_SECRET_KEY is not set");
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // base58 — decoded via bs58 which ships with @solana/web3.js deps
  const bs58 = require("bs58");
  const decoded = bs58.default?.decode?.(trimmed) ?? bs58.decode(trimmed);
  return Keypair.fromSecretKey(Uint8Array.from(decoded));
}

export function tokenMint(): PublicKey {
  const mint = process.env.TOKEN_MINT;
  if (!mint) throw new Error("TOKEN_MINT is not set");
  return new PublicKey(mint);
}

export type FeeSource = "quicknode" | "network-p75" | "floor";
export type FeeEstimate = { microLamports: number; source: FeeSource };

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json?.error) throw new Error(json.error.message ?? "rpc error");
  return json?.result;
}

/**
 * What should we pay to make this transaction land?
 *
 * Three tiers, best first:
 *   1. qn_estimatePriorityFees — QuickNode's own estimate. Sending at
 *      `recommended` or above routes through their stake pool, which is the
 *      actual reliable-landing mechanism. REQUIRES the Priority Fee add-on to be
 *      enabled on the endpoint; without it the method is simply not found.
 *   2. getRecentPrioritizationFees — core Solana RPC, available on any endpoint.
 *      We take the 75th percentile of recent blocks.
 *   3. A floor, so we never send a transaction with no priority fee at all.
 *
 * The source is reported alongside the number so the stage can label it
 * honestly rather than claiming a QuickNode estimate we didn't get.
 */
export async function estimatePriorityFee(): Promise<FeeEstimate> {
  // Tier 1 — QuickNode add-on.
  try {
    const r = (await rpc("qn_estimatePriorityFees", {
      last_n_blocks: 100,
      api_version: 2,
    })) as Record<string, any>;

    const candidate =
      r?.per_compute_unit?.recommended ??
      r?.recommended ??
      r?.per_compute_unit?.medium ??
      r?.per_compute_unit?.percentiles?.["75"];

    const fee = Number(candidate);
    if (Number.isFinite(fee) && fee > 0) {
      return { microLamports: Math.ceil(fee), source: "quicknode" };
    }
  } catch {
    // add-on not enabled on this endpoint — fall through
  }

  // Tier 2 — core RPC percentile.
  try {
    const recent = (await rpc("getRecentPrioritizationFees", [[]])) as
      | { prioritizationFee: number }[]
      | undefined;

    if (Array.isArray(recent) && recent.length) {
      const fees = recent
        .map((f) => Number(f.prioritizationFee))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      const p75 = fees[Math.floor(fees.length * 0.75)] ?? 0;
      if (p75 > 0) {
        return { microLamports: Math.ceil(p75), source: "network-p75" };
      }
    }
  } catch {
    // fall through
  }

  // Tier 3 — devnet is usually uncongested and reports 0, which would mean no
  // priority fee at all. Never send that.
  return {
    microLamports: FALLBACK_PRIORITY_FEE_MICROLAMPORTS,
    source: "floor",
  };
}

/**
 * Pay one worker. Sends with maxRetries: 0 and runs our own rebroadcast loop —
 * that combination, plus the priority fee above, is the landing story.
 */
export async function payWorker(args: {
  toAta: string;
  amountRaw?: number;
  onProgress?: (p: PaymentProgress) => Promise<void> | void;
}): Promise<PaymentResult> {
  const { toAta, amountRaw = TASK_PRICE_RAW, onProgress } = args;

  const conn = connection();
  const payer = treasury();
  const mint = tokenMint();
  const fromAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

  const { microLamports: priorityFeeMicroLamports, source: priorityFeeSource } =
    await estimatePriorityFee();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    }),
    createTransferInstruction(
      fromAta,
      new PublicKey(toAta),
      payer.publicKey,
      amountRaw,
    ),
  );

  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  const raw = tx.serialize();

  let signature: string;
  try {
    // maxRetries: 0 — we own the rebroadcast, not the RPC.
    signature = await conn.sendRawTransaction(raw, {
      skipPreflight: true,
      maxRetries: 0,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await onProgress?.({ status: "failed", error });
    return {
      signature: null,
      priorityFeeMicroLamports,
      priorityFeeSource,
      confirmedAt: null,
      error,
    };
  }

  await onProgress?.({
    status: "sent",
    signature,
    priorityFeeMicroLamports,
    priorityFeeSource,
  });

  const confirmedAt = await confirmWithRebroadcast({
    conn,
    raw,
    signature,
    lastValidBlockHeight,
  });

  if (confirmedAt) {
    await onProgress?.({ status: "confirmed", signature, confirmedAt });
    return { signature, priorityFeeMicroLamports, priorityFeeSource, confirmedAt };
  }

  const error = "not confirmed before timeout";
  await onProgress?.({ status: "failed", error });
  return {
    signature,
    priorityFeeMicroLamports,
    priorityFeeSource,
    confirmedAt: null,
    error,
  };
}

/**
 * Rebroadcast every 500ms while polling getSignatureStatuses every 400ms, until
 * confirmed / blockhash expiry / timeout.
 *
 * Deliberately not using signatureSubscribe — a WebSocket has awkward lifecycle
 * management inside a serverless function and buys nothing visible here. It's a
 * roadmap item, not a demo item.
 */
async function confirmWithRebroadcast(args: {
  conn: Connection;
  raw: Buffer | Uint8Array;
  signature: string;
  lastValidBlockHeight: number;
}): Promise<number | null> {
  const { conn, raw, signature, lastValidBlockHeight } = args;
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let lastRebroadcast = 0;

  while (Date.now() < deadline) {
    if (Date.now() - lastRebroadcast > REBROADCAST_INTERVAL_MS) {
      lastRebroadcast = Date.now();
      conn
        .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
        .catch(() => {});
    }

    const { value } = await conn.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) return null;
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return Date.now();
    }

    try {
      const height = await conn.getBlockHeight("confirmed");
      if (height > lastValidBlockHeight) return null; // blockhash expired
    } catch {
      // transient RPC hiccup — keep trying until the deadline
    }

    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }

  return null;
}
