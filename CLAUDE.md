# MeshTab: project handoff (read this first)

Owner: Amir (AI engineer, Malta, solo). Work in simple English (ASD-STE100). Be direct. Do not flatter.
Tag key claims [Certain] / [Likely] / [Guessing]. If a plan has a flaw, say it first.
If Amir says "do it with my responsibility", do it and do not repeat warnings.

## Deadline
PayPal AI Hackathon (Devpost): **Thu 12 Nov 2026, 12:00 PST = 21:00 Malta/Berlin = 20:00 UTC.**
Freeze all commits at 20:00 Berlin. Demo video must be on YouTube by Thu 15:00 Berlin.
Keep demo, test credentials and credits alive until 15 Dec 2026, 08:00 PT.

## Goal and rules that decide the result
Win a prize. Stage 1 is pass/fail: PayPal (sandbox is fine) AND AI must both be central, working build, public repo.
Stage 2 criteria (equal): Technological Implementation (tie-breaker), Design, Potential Impact, Innovation, Presentation.
Needs: public repo with open-source license in the GitHub About box; hosted demo URL that works with no login;
video under 3 min on YouTube showing the project working (no copyrighted music, no third-party logos);
text names the AI tools/models and how; say what is new versus upstream (Bitchat Android, GPL-3.0).
Keep secrets in environment variables. Never commit secrets.
Framing: RESILIENCE (blackouts, disasters, rural areas, unreliable internet, community payments).
Do NOT use words about regimes, sanctions or dictators.

## Product
MeshTab = offline community payments. Online: load balance with PayPal (Orders v2). Offline: signed vouchers over a
Bluetooth mesh. Back online: AI settlement agent (Claude + PayPal Agent Toolkit) checks and explains; PayPal Payouts pays;
a human approves risky payouts. **Code decides validity. The LLM only scores risk and explains. The LLM can add a hold, never remove one.**

## Repo state (all on `main`, GitHub: teslatoris3/meshtab, public, GPL-3.0)
- `protocol/` DONE. Ed25519 vouchers, hash chain, fork detection, deterministic `settle()`. 15 tests.
- `agent/` DONE. Claude tool loop (Anthropic SDK `toolRunner`), PayPal Agent Toolkit `get_order`, `record_assessment` tool, rule fallback. `client.ts` picks OpenRouter or Anthropic. 3 tests.
- `gateway/` DONE. Express: Orders v2 (button flow AND one-call sandbox test-card flow), Payouts + polling, webhook verify, settlement policy, MOCK mode, rate limits. 2 e2e tests.
- `web/` DONE. React Mesh Lab (simulated mesh, internet toggle, Evil Eve, PayPal button + "test card, no login" button, settlement panel with Approve), AG Grid ledger console (lazy loaded). Phone layout OK.
- `docs/architecture.md`, `README.md`, `render.yaml` DONE. README has TODOs: Render URL, YouTube URL, Android section.
- `scripts/sandbox-smoke.ts` and `scripts/agent-smoke.ts`: real PayPal sandbox and real Claude checks.
- `android/` NOT STARTED.

Verified for real (not mocks) on 10 Nov: sandbox Orders v2 create+capture ($65 COMPLETED), Agent Toolkit get_order, Payouts reached SUCCESS,
real Claude (anthropic/claude-opus-5.5 via OpenRouter) called get_order and record_assessment, full browser demo had no errors.

## Last change not yet verified (do this first)
In `agent/src/agent.ts` and `gateway/src/settlement.ts` I started passing the full PayPal order split (`allocations`) to Claude as `paypal_orders`,
and told it to write plain text (no markdown). Reason: Claude wrongly put Alice on hold because one $65 order funded three wallets
(Alice $30, Dave $15, Eve $20) and it only saw two of them. Typecheck and 20 tests pass. **Not yet re-run live.**
Re-run: `npm run build`, start the server (see Run), run the browser walk, check Alice is "ok to pay" and the summary has no `**`.

## Run
```bash
npm install && npm test
npm run build && node --env-file=.env gateway/dist/server.js   # http://localhost:8787
npx tsx --env-file=.env scripts/sandbox-smoke.ts                # real PayPal sandbox
npx tsx --env-file=.env scripts/agent-smoke.ts                  # real Claude call
```
`.env` is gitignored and NOT in the repo. Recreate it from `.env.example` (see "Secrets" below).
On Node >= 22.21 behind a proxy use `NODE_USE_ENV_PROXY=1`. Not needed on Amir's normal machine.

## Secrets (Amir has them; never commit)
PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (PayPal sandbox app "Default Application"), GATEWAY_SECRET_KEY (64 hex),
OPENROUTER_API_KEY (starts `sk-or-v1-`; LLM_MODEL=anthropic/claude-opus-5.5), DEMO_PAYOUT_RECEIVERS
(all three payees currently = sb-h4zp453779271@personal.example.com, Amir's sandbox personal account).
These were pasted in a chat. After the hackathon: regenerate the PayPal secret and the OpenRouter key.
Sandbox business account (sends payouts): sb-hw243b53667188@business.example.com. Amir cannot log in to paypal.com (forced password reset loop), so never ask him to.

## Open work, in order
1. Verify the last change (above).
2. **Render deploy** (Amir does it): Blueprint from this repo; set the secret env vars in the Render dashboard; use a paid instance so it does not sleep. He sends me the URL. Then test the live URL end to end and put it in README.
3. **Android** (`android/`): copy upstream https://github.com/permissionlesstech/bitchat-android at commit 14ab73c. Add `PAYMENT_VOUCHER(0x30u)` to `MessageType` in `app/src/main/java/com/bitchat/android/protocol/BinaryProtocol.kt` (existing: 0x01,0x02,0x03,0x10,0x11,0x20,0x21,0x22,0x29). Port the canonical voucher/LoadCert format from `protocol/src/voucher.ts` (test vector in `protocol/test/protocol.test.ts`), add `/pay @nick 5.00`, a wallet screen, a sync step. Stack: AGP 9.3.1, Kotlin 2.4.10, compileSdk/targetSdk 37, minSdk 26. Amir has Android Studio, Ubuntu 20.04, 2 phones. **Cut Android FIRST if late**; then the video shows Mesh Lab on a phone browser. Update README "what is new vs upstream".
4. Devpost text, README TODOs, video (outline: 0:00 problem, 0:20 PayPal load, 0:45 internet off + mesh pay, 1:15 Evil Eve, 1:35 AI agent + payouts, 2:10 PayPal dashboard shows money, 2:30 impact + new vs Bitchat). Under 3 minutes. Select AG Grid and Render on the Devpost form (both really used).
5. Final checklist: repo public + GPL in About (Amir must set the About description/topics by hand), README complete, demo URL works with no login, video public on YouTube, nothing changed after the deadline.

Never cut: protocol, gateway, agent, Mesh Lab.

## Notes and known limits
- Git author on old commits is a placeholder ("Amir"). Offer to rewrite if Amir sends his GitHub noreply email.
- The Agent Toolkit has no Payouts tool, so payouts use the REST API from the gateway (README says so).
- An offline system cannot stop a double-spend at the moment it happens. MeshTab limits, detects, settles from escrow, freezes the payer. Say this honestly in the video and Devpost text.
- Eligibility: Amir is a Maltese resident, eligible. Prize payout needs W-8BEN and a bank account.
