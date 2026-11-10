// Real Claude call through the settlement agent (Evil Eve scenario, mock PayPal order lookups).
// Run: npx tsx --env-file=.env scripts/agent-smoke.ts
import { addCert, generateKeyPair, issueLoadCert, newWallet, pay, settle } from '../protocol/src/index.js';
import { createClaudeClient, mockOrderTool, runSettlementAgent } from '../agent/src/index.js';
const claude = createClaudeClient();
if (!claude) throw new Error('set OPENROUTER_API_KEY or ANTHROPIC_API_KEY');

const gw = generateKeyPair();
const mk = (c: number, id: string) => { const w = newWallet(); return addCert(w, issueLoadCert({ wallet: w.keys.publicKey, amount: c, loadId: id }, gw)); };
const alice = mk(3000, 'ORDERALICE0000000-1'), eve = mk(2000, 'ORDEREVE000000000-1');
const bob = newWallet(), carol = newWallet();
const t = Date.now() - 600_000;
const vs = [pay(alice, bob.keys.publicKey, 800, '', t).packet.voucher, pay(eve, bob.keys.publicKey, 1500, '', t + 60_000).packet.voucher, pay(eve, carol.keys.publicKey, 1500, '', t + 240_000).packet.voucher];
const report = settle({ vouchers: vs, loads: [...alice.certs, ...eve.certs], gateway: gw.publicKey });
const order = (id: string, v: string) => ({ id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ status: 'COMPLETED', amount: { value: v } }] } }] });
const orders: Record<string, unknown> = { ORDERALICE0000000: order('ORDERALICE0000000', '30.00'), ORDEREVE000000000: order('ORDEREVE000000000', '20.00') };
const started = Date.now();
const r = await runSettlementAgent({
  report,
  directory: { names: { [alice.keys.publicKey]: 'Alice', [eve.keys.publicKey]: 'Eve', [bob.keys.publicKey]: 'Bob', [carol.keys.publicKey]: 'Carol' },
    loads: { [alice.keys.publicKey]: ['ORDERALICE0000000'], [eve.keys.publicKey]: ['ORDEREVE000000000'] } },
  expectedLoads: [{ orderId: 'ORDERALICE0000000', wallets: [alice.keys.publicKey], amountCents: 3000 }, { orderId: 'ORDEREVE000000000', wallets: [eve.keys.publicKey], amountCents: 2000 }],
  orderTool: mockOrderTool(async (id) => orders[id]),
  client: claude.client,
  model: process.env.LLM_MODEL ?? claude.defaultModel,
  effort: 'low',
});
for (const l of r.log) console.log(`[${l.kind}] ${l.text.slice(0, 300)}`);
console.log('sources:', r.assessments.map((a) => `${a.name}:${a.source}:${a.recommendation}:${a.riskScore}`).join(' '), '| seconds:', ((Date.now() - started) / 1000).toFixed(1));
