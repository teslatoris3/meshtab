// Real PayPal sandbox smoke test: OAuth, Orders v2 create, Agent Toolkit get_order, Payouts.
// Run: npx tsx --env-file=.env scripts/sandbox-smoke.ts
import { payPalToolkitOrderTool, summarizeOrder } from '../agent/src/index.js';
import { SandboxPayPal } from '../gateway/src/paypal.js';

const id = process.env.PAYPAL_CLIENT_ID!;
const secret = process.env.PAYPAL_CLIENT_SECRET!;
const receiver = (process.env.DEMO_PAYOUT_RECEIVERS ?? '').split(',')[0]?.split('=')[1];
const pp = new SandboxPayPal(id, secret);

const order = await pp.createOrder({ amountCents: 500, customId: 'smoke', description: 'MeshTab smoke test', requestId: `smoke-${Date.now()}` });
console.log('1. Orders v2 create:', order);

const tool = payPalToolkitOrderTool({ clientId: id, clientSecret: secret, sandbox: true });
console.log('2. Agent Toolkit get_order:', summarizeOrder(await tool.lookup(order.id)));

const batch = await pp.createPayout({ senderBatchId: `smoke-${Date.now()}`, items: [{ senderItemId: `smoke${Date.now()}`, receiver: receiver!, amountCents: 100, note: 'MeshTab smoke test' }] });
console.log('3. Payouts create:', batch.batchId, batch.status);
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const b = await pp.getPayoutBatch(batch.batchId);
  console.log(`4. Payout status (try ${i + 1}):`, b.status, b.items.map((x) => x.status).join(','));
  if (b.items.every((x) => !['PENDING', 'UNKNOWN'].includes(x.status)) && b.items.length) break;
}
