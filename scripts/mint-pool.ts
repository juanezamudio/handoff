/**
 * Pre-demo setup. Run this the morning of, not during.
 *
 *   npx tsx scripts/mint-pool.ts
 *
 * What it does:
 *   1. Ensures the treasury has devnet SOL (airdrops are rate-limited — run early).
 *   2. Creates the demo SPL token if TOKEN_MINT isn't set, and mints supply.
 *   3. Generates POOL_SIZE wallets and creates a token account for each,
 *      batched and idempotent so re-running is safe.
 *   4. Pushes {pubkey, ata} into Redis so joining is a 5ms LPOP.
 *
 * The point of all this is that ZERO on-chain work happens while the room is
 * watching. A phone scanning the QR pops a ready wallet off a list.
 *
 * Note we never persist worker secret keys — workers never sign anything, the
 * treasury pays them. There is deliberately no key-storage subsystem here.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Redis } from "@upstash/redis";

const POOL_SIZE = Number(process.env.POOL_SIZE ?? 60);
const ATAS_PER_TX = 8;
const TOKEN_DECIMALS = 6;
const SUPPLY_RAW = 1_000 * 10 ** TOKEN_DECIMALS; // 1,000 demo dollars
const MIN_TREASURY_SOL = 0.5;

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function treasuryKeypair(): Keypair {
  const raw = process.env.TREASURY_SECRET_KEY;
  if (!raw) {
    const kp = Keypair.generate();
    console.log(bold("\nNo TREASURY_SECRET_KEY set — generated a new one.\n"));
    console.log("Add these to .env.local before running again:\n");
    console.log(`TREASURY_SECRET_KEY=${JSON.stringify(Array.from(kp.secretKey))}`);
    console.log(dim(`# pubkey ${kp.publicKey.toBase58()}`));
    process.exit(1);
  }
  const t = raw.trim();
  if (t.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(t)));
  const bs58 = require("bs58");
  return Keypair.fromSecretKey(
    Uint8Array.from(bs58.default?.decode?.(t) ?? bs58.decode(t)),
  );
}

async function ensureSol(conn: Connection, payer: Keypair) {
  const balance = await conn.getBalance(payer.publicKey);
  const sol = balance / LAMPORTS_PER_SOL;
  console.log(`treasury balance: ${sol.toFixed(3)} SOL`);
  if (sol >= MIN_TREASURY_SOL) return;

  console.log(dim("airdropping (devnet airdrops are rate-limited)..."));
  try {
    const sig = await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(green("airdrop confirmed"));
  } catch (err) {
    console.log(
      `\n${bold("Airdrop failed")} — you are probably rate-limited.`,
      `\nFund ${payer.publicKey.toBase58()} from https://faucet.solana.com and re-run.\n`,
    );
    process.exit(1);
  }
}

async function ensureMint(conn: Connection, payer: Keypair): Promise<PublicKey> {
  if (process.env.TOKEN_MINT) {
    const mint = new PublicKey(process.env.TOKEN_MINT);
    console.log(`using existing mint ${dim(mint.toBase58())}`);
    return mint;
  }

  console.log(dim("creating demo token mint..."));
  const mint = await createMint(
    conn,
    payer,
    payer.publicKey,
    null,
    TOKEN_DECIMALS,
  );

  const treasuryAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    mint,
    payer.publicKey,
  );
  await mintTo(conn, payer, mint, treasuryAta.address, payer, SUPPLY_RAW);

  console.log(green(`\nmint created: ${mint.toBase58()}`));
  console.log(bold("Add this to .env.local, then re-run:\n"));
  console.log(`TOKEN_MINT=${mint.toBase58()}\n`);
  process.exit(0);
}

async function main() {
  const rpc = process.env.QUICKNODE_RPC_URL;
  if (!rpc) throw new Error("QUICKNODE_RPC_URL is not set");

  const conn = new Connection(rpc, "confirmed");
  const payer = treasuryKeypair();
  console.log(`treasury: ${dim(payer.publicKey.toBase58())}`);

  await ensureSol(conn, payer);
  const mint = await ensureMint(conn, payer);

  // Treasury must hold the token it's paying out.
  const treasuryAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    mint,
    payer.publicKey,
  );
  const held = Number(treasuryAta.amount) / 10 ** TOKEN_DECIMALS;
  console.log(`treasury token balance: ${held.toFixed(2)}`);
  if (held < 50) {
    console.log(dim("topping up treasury token balance..."));
    await mintTo(conn, payer, mint, treasuryAta.address, payer, SUPPLY_RAW);
  }

  // ---- generate wallets and create their token accounts -------------------
  console.log(`\ngenerating ${POOL_SIZE} wallets...`);
  const wallets = Array.from({ length: POOL_SIZE }, () => {
    const owner = Keypair.generate().publicKey;
    return {
      pubkey: owner.toBase58(),
      ata: getAssociatedTokenAddressSync(mint, owner).toBase58(),
      owner,
    };
  });

  const batches = Math.ceil(wallets.length / ATAS_PER_TX);
  for (let i = 0; i < batches; i++) {
    const slice = wallets.slice(i * ATAS_PER_TX, (i + 1) * ATAS_PER_TX);
    const tx = new Transaction();
    for (const w of slice) {
      // Idempotent: safe to re-run this whole script without blowing up.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          new PublicKey(w.ata),
          w.owner,
          mint,
        ),
      );
    }
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
      commitment: "confirmed",
    });
    console.log(
      `  batch ${i + 1}/${batches} ${green("✓")} ${dim(sig.slice(0, 16) + "…")}`,
    );
  }

  // ---- publish the pool ---------------------------------------------------
  const redis = Redis.fromEnv();
  await redis.del("wallets:pool");
  await redis.rpush(
    "wallets:pool",
    ...wallets.map((w) => JSON.stringify({ pubkey: w.pubkey, ata: w.ata })),
  );

  console.log(green(`\n✓ pool ready — ${wallets.length} wallets in wallets:pool`));
  console.log(dim(`  mint ${mint.toBase58()}`));
  console.log(dim(`  treasury ${payer.publicKey.toBase58()}\n`));
}

main().catch((err) => {
  console.error("\nmint-pool failed:", err);
  process.exit(1);
});
