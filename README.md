# MeshTab

**Offline community payments for blackouts, disasters and rural areas with unreliable internet.**

People load a balance with **PayPal** while they are online. When the internet is down, they pay each other with signed vouchers that hop phone to phone over a Bluetooth mesh. When any phone is back online, an **AI settlement agent** (Anthropic Claude + the PayPal Agent Toolkit) checks the vouchers, explains every risk in plain language, and pays the receivers with **PayPal Payouts**. A person approves anything risky.

- Live demo (no install, no login): **https://vertexofagents.com/meshtab/**
- Demo video: **TODO: YouTube URL**
- License: GPL-3.0

> Sandbox only. MeshTab never touches live money. The gateway refuses `PAYPAL_MODE=live`.

## How it works

1. **Online: load a balance with PayPal.** PayPal Orders v2 (create + capture). One checkout can fund several phones, for example an aid organiser who tops up several families before a storm. After the capture, the gateway signs a *load certificate* for each wallet.
2. **Offline: pay over the mesh.** The payer's phone signs a voucher (Ed25519) and adds it to its own hash chain (`seq`, `prev`, running total `cum`). The receiver checks the signature and the load certificate with no internet. Phones relay vouchers over several hops and sync their stores when they meet.
3. **Back online: settle.** Any phone uploads every voucher it carries. Deterministic code checks signatures, chains, forks and escrow. Claude checks each PayPal top-up with the PayPal Agent Toolkit, scores risk and writes an explanation. Code policy auto-pays clean payouts with PayPal Payouts and holds the rest for a human.

See [docs/architecture.md](docs/architecture.md) for the diagram, the data formats and the security model.

### Evil Eve: the double-spend demo

Eve copies her wallet, pays Bob $15 in the west market, walks to the east market and pays Carol $15 with the **same** money. Carol cannot know at that moment, and no offline system can know. Then Dave walks back between the markets. His phone syncs with both shops, finds two vouchers with the same sequence number, and floods a **fork proof** that any phone can verify. Every phone then refuses Eve. At settlement, Eve's PayPal escrow pays Bob (chain order). Carol's $15 is a shortfall that goes to a human, and Eve's wallet is frozen.

## Where AI is used (and where it is not)

| Task | Done by |
| --- | --- |
| Signature, hash chain, fork and escrow checks | Code (`protocol/`). The LLM never decides validity. |
| Confirm each PayPal top-up was really paid | Claude calls the PayPal Agent Toolkit `get_order` tool. Code checks again any order the agent skipped. |
| Risk score, flags, plain-language explanation for the organiser | Claude (`claude-opus-5-5` by default) through the Anthropic TypeScript SDK tool runner, with a strict `record_assessment` tool |
| Auto-pay or hold | Code policy. An AI "hold" adds a hold. An AI "pay" cannot remove a hold. |
| Payouts above the approval limit, payouts that touch a fork, shortfalls | A human clicks Approve, Reject or "Cover from pool" |

Guardrails:

- Voucher memos (free text written by users) are never sent to the LLM, so a cheater cannot inject instructions. A test checks this.
- If no API key is set, the daily AI budget is used up, or the API fails, the agent falls back to rule-based explanations. The demo always works.
- Server-side model fallbacks are on for refusals (`server-side-fallback-2026-07-01`, `fallbacks: "default"`).

## PayPal integration

| PayPal product | Where |
| --- | --- |
| PayPal JS SDK v6 (`@paypal/react-paypal-js/sdk-v6`, `PayPalOneTimePaymentButton`) | `web/src/components/TopUp.tsx` |
| Orders v2: create and capture (PayPal button), and one-call card capture with the sandbox test card | `gateway/src/paypal.ts`, `gateway/src/app.ts` |
| Payouts: create batch, poll batch status | `gateway/src/paypal.ts`, `gateway/src/settlement.ts` |
| Webhooks: signature verification, `PAYMENT.PAYOUTS-ITEM.*` | `gateway/src/app.ts` |
| PayPal Agent Toolkit (`@paypal/agent-toolkit`, `get_order`) as a tool for Claude | `agent/src/paypalTools.ts` |

The Agent Toolkit (v1.11.0) has no Payouts tool, so payouts use the REST API directly from the gateway, and only after the code policy allows them.

## Repository layout

```
protocol/   TypeScript: voucher format, signing, hash chains, fork detection, settlement (unit tests)
agent/      Claude settlement agent + PayPal Agent Toolkit adapter (tests with a scripted Claude API)
gateway/    Node/Express: PayPal Orders v2, Payouts, Webhooks, settlement policy, MOCK mode (end-to-end test)
web/        React "Mesh Lab": simulated Bluetooth mesh, internet toggle, Evil Eve, PayPal checkout,
            AI settlement panel, AG Grid ledger console
docs/       Architecture and demo script
render.yaml Render deploy
```

## Run it locally

Requirements: Node 20 or newer.

```bash
npm install
```

```bash
npm test
```

```bash
npm run build && npm start
```

Open http://localhost:8787. With no environment variables, the app runs in **MOCK mode**: no PayPal calls, no LLM, and the full story still works.

For development with hot reload, run the gateway and Vite in two terminals:

```bash
npm run dev -w gateway
```

```bash
npm run dev -w web
```

## PayPal sandbox setup

1. At developer.paypal.com, open **Apps & Credentials**, select **Sandbox** and create an app. Copy the Client ID and Secret.
2. In **Sandbox accounts**, use the default business account (it sends payouts) and create personal accounts for the payees (Bob, Carol, Dave) and one buyer account (for the checkout).
3. Copy `.env.example` to `.env` and set:
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE=sandbox`
   - `DEMO_PAYOUT_RECEIVERS=Bob=<sandbox email>,Carol=<sandbox email>,Dave=<sandbox email>`
   - `GATEWAY_SECRET_KEY` (64 hex characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` (optional; without one the agent uses rules)
4. Optional: create a webhook for `PAYMENT.PAYOUTS-ITEM.*` that points to `https://<host>/api/webhooks/paypal`, and set `PAYPAL_WEBHOOK_ID`. Without it, the gateway polls the payout batch.

**Judges need no PayPal login.** In the Mesh Lab, click **"Pay with a PayPal sandbox test card (no login)"**. The gateway creates and captures a real PayPal sandbox order (Orders v2, `payment_source.card`) with PayPal's published sandbox test Visa. The card number is fixed in the server code, and the app never accepts card data from users. The normal PayPal button is shown as well.

## Environment variables

| Name | Default | Meaning |
| --- | --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | empty | Sandbox REST app. Empty means MOCK mode. |
| `PAYPAL_MODE` | `sandbox` if keys are set | `sandbox` or `mock`. `live` is refused. |
| `PAYPAL_WEBHOOK_ID` | empty | Enables webhook verification. |
| `DEMO_PAYOUT_RECEIVERS` | empty | `Name=email,...` payout receivers for the demo characters. |
| `GATEWAY_SECRET_KEY` | random at boot | Ed25519 key that signs load certificates. Set it so certificates survive restarts. |
| `OPENROUTER_API_KEY` | empty | Enables the Claude agent through OpenRouter. Wins if both keys are set. |
| `ANTHROPIC_API_KEY` | empty | Enables the Claude agent through the Anthropic API. |
| `LLM_MODEL` | `anthropic/claude-opus-5.5` (OpenRouter) or `claude-opus-5-5` (Anthropic) | Claude model. |
| `LLM_EFFORT` | `low` | `low`, `medium` or `high`. |
| `LLM_RUNS_PER_DAY` | `300` | AI budget for the public demo. After that: rules. |
| `APPROVAL_LIMIT_CENTS` | `2500` | Payouts above this always need a human. |
| `MAX_LOAD_CENTS` | `10000` | Largest top-up per wallet. |

Secrets come only from environment variables. `.env` is in `.gitignore`.

## Deploy

The live demo runs on a small Linux VPS: one Node process (`HOST=127.0.0.1`, systemd) behind nginx, served under `/meshtab/` (the web app uses relative URLs, so any path works).

Alternative, not used for the live demo: create a Render Blueprint from this repository (`render.yaml`), then set the secret variables in the dashboard. The build runs `npm ci --include=dev && npm run build`. The service serves the API and the web app on one port. The health check is `/healthz`.

## Tests

Real sandbox smoke test (Orders v2, Agent Toolkit `get_order`, Payouts): `npx tsx --env-file=.env scripts/sandbox-smoke.ts`


```bash
npm test
```

- `protocol/test`: signing, tampering, overspend, canonical test vector, honest chains, duplicates, multi-run settlement, forks (same seq and same prev), offline rejection after gossip, cap lies, running-total lies, wallets with no load.
- `agent/test`: rule-based run; a full Claude tool loop against a scripted HTTP layer (checks that the PayPal tool is called, that memos never reach the model, and that a model "pay" cannot clear a frozen payer); fallback when the API fails.
- `gateway/test`: end to end in MOCK mode: register, PayPal top-up for two wallets, offline payments, Evil Eve, sync from two phones with duplicates, settlement, auto payouts, human approval, no double payment on a second run.

## What is new compared to Bitchat

MeshTab is designed for [Bitchat](https://github.com/permissionlesstech/bitchat-android) (GPL-3.0), a Bluetooth mesh chat app. The mesh model in the Mesh Lab copies Bitchat's behaviour: TTL-limited flooding, de-duplication by message ID, and store sync when peers meet.

New in this project: the payment voucher protocol, the load certificates, fork proofs, the settlement engine, the PayPal gateway, the AI settlement agent, the Mesh Lab and the ledger console.

**TODO (Android):** a `PAYMENT_VOUCHER` message type (0x30, unused in upstream `BinaryProtocol.kt` at commit 14ab73c), the `/pay @nick 5.00` command and a wallet screen in a fork of Bitchat Android. Until that is done, the mesh in the demo is simulated in the browser; the cryptography, settlement, PayPal and AI parts are real.

## Built with

PayPal Orders v2 · PayPal Payouts · PayPal Webhooks · PayPal JS SDK v6 · PayPal Agent Toolkit · Anthropic Claude (Claude Opus 5.5) · Anthropic TypeScript SDK · TypeScript · Node.js · Express · React · Vite · AG Grid · @noble/ed25519 · nginx
