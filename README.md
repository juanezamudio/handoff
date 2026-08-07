# Handoff

**When an AI agent gets stuck, it hires a human for fifteen seconds and pays them 40¢.**

Three agents run at once. Each one hits a wall it cannot pass, and each for a
genuinely different reason:

| Agent | Blocked because it | Needs |
|---|---|---|
| Accounts Payable | can't **know** — the fact lives in someone's head | a judgment on vendor identity |
| Event Operations | can't **perceive** — the answer is in a physical room | **a photo and a headcount** |
| Customer Support | shouldn't **decide** — a judgment call with money either way | a policy exception |

Each posts a paid micro-job. Phones in the room buzz, someone claims it, answers,
gets paid, and that agent resumes — while the other two keep working.

The middle one is the argument. No amount of model intelligence lets a system
count the people standing in front of you. **This market does not shrink as
models improve.**

> A real, model-driven version of the accounts-payable agent also ships
> (`lib/agent.ts`, `/control` → "Start the LIVE model agent"). It was verified
> across repeated runs to find both of its own escalations with no case-specific
> prompting. The three demo agents are scripted so the demo is free to rehearse
> and deterministic on stage.

---

## Run it

```bash
npm run dev
```

| Surface | URL |
|---|---|
| Operator | http://localhost:3000/control |
| Projector | http://localhost:3000/stage |
| Worker (QR target) | http://localhost:3000 |

**From a phone, use the LAN address** (`http://<your-ip>:3000`) — the QR on the stage page encodes whatever host the projector was loaded from, so open the stage at the LAN address and the code just works.

### First rehearsal, ninety seconds

1. Open `/control` and `/stage` side by side
2. `/control` → **Spawn 8 simulated workers** (or scan the QR with a real phone)
3. `/control` → **Start the three agents**
4. Watch `/stage`. Within ~12s all three are stuck and three jobs are open
5. Answer on your phone, or use **Answer for them** on `/control`
6. **Reset** between runs — it keeps the roster so nobody has to re-scan

**The projector page drives the demo.** Serverless has nowhere to keep a timer,
so the scripted agents advance as a side effect of the stage/control poll
(`?tick=1`). If no projector page is open, the agents don't move.

---

## Payments

Ships in **mock mode**: same state transitions, same timing, same animation — no chain. Every surface labels it `simulated`, so it can never be mistaken for real settlement.

To settle on Solana devnet instead:

1. Fund the treasury (address in `.env.local`, `TREASURY_SECRET_KEY`) with ~0.5 devnet SOL from [faucet.solana.com](https://faucet.solana.com) or a Phantom wallet in devnet mode
2. `npx tsx --env-file=.env.local scripts/mint-pool.ts` — creates the demo token and pre-generates 60 funded wallets
3. `/control` → **Switch to real devnet payments**

Everything on-chain is pre-created **before** the demo, so scanning the QR is a 5ms list pop rather than a transaction. Workers never sign anything — the treasury pays them — so no worker secret keys are stored anywhere.

**QuickNode** carries every read, send, and confirmation, plus priority-fee estimation. If the Priority Fee add-on isn't enabled on the endpoint, it falls back to the core-RPC 75th percentile and then a floor, and the stage bar labels which tier actually produced the number.

---

## Scripts

```bash
npx tsx --env-file=.env.local scripts/preflight.ts    # pre-demo health check
npx tsx --env-file=.env.local scripts/run-agent.ts    # agent only — asserts it stops twice
npx tsx --env-file=.env.local scripts/mint-pool.ts    # generate the wallet pool
```

`run-agent.ts` exercises the **live model** agent with no Redis, no UI, and no
chain, and prints PASS/FAIL on whether it escalated exactly twice on the right
invoices. Run it after any prompt change. It costs API credits; the three demo
agents don't. Set `HANDOFF_MODEL=claude-haiku-4-5` to rehearse it cheaply.

---

## Architecture

Redis is the only system of record. Every surface polls `/api/state`; there is no SSE anywhere, because a dropped poll costs 400ms and a dropped stream costs the rest of the demo.

**The blocking `ask_human` tool is the whole product.** Its `run()` writes a task, dispatches it, and then blocks — polling for an answer — so the agent genuinely waits on a human before continuing.

Four things that look like details and are not:

- **`SET NX` is the only claim path.** Two people winning the same job on stage would be ugly. Losers get a miss delta computed from server clocks (phone clocks drift by seconds).
- **Anything concurrent gets its own key.** Invoices, the log, worker records, earnings, and each task are all separate — read-modify-write on a shared blob loses updates, and it did: five invoices silently stayed `pending`, and payment signatures vanished when the archive write raced the settle write.
- **`disable_parallel_tool_use` is load-bearing** on the live-model path. Without it the model batches all six approvals onto one millisecond (nothing animates) and fires both escalations at once, racing two dispatches so one waits out its deadline on a task no phone can see.
- **Photos never ride in the state snapshot.** They live under their own key and the projector fetches them once — forty phones poll that snapshot every second.
- **Payment never blocks the agent's resume.** The answer is written first, then settlement runs in the background. Also better theatre: the agent resumes instantly and money lands a beat later.

Phones are alerted with a **WebAudio beep unlocked on the join tap** plus a full-screen flash — `navigator.vibrate()` is a no-op on iOS Safari, which would silently be half the room.

---

## On stage

- Pre-seed 15–20 workers from the hallway; the roster should never start empty
- Brief two teammates to claim, so the 6s widen and 12s fallback never have to fire visibly
- Run the agent from a phone hotspot, not venue wifi
- Keep `/control` open on a second device — it can widen dispatch and answer on someone's behalf
- Have the backup video in a tab
