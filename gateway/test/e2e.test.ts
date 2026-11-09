import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addCert, newWallet, pay } from '@meshtab/protocol';
import { mockOrderTool } from '@meshtab/agent';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockPayPal } from '../src/paypal.js';
import { SettlementService } from '../src/settlement.js';
import { Store } from '../src/store.js';

let base = '';
let close: () => void;

beforeAll(async () => {
  const cfg = loadConfig({ PAYPAL_MODE: 'mock', APPROVAL_LIMIT_CENTS: '2500' } as NodeJS.ProcessEnv);
  const paypal = new MockPayPal();
  const store = new Store();
  const settlement = new SettlementService(cfg, store, paypal, mockOrderTool((id) => paypal.getOrder(id)), null);
  const server = createApp({ cfg, store, paypal, settlement }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('gateway end to end (MOCK PayPal, no LLM)', () => {
  it('loads with PayPal, settles offline vouchers, catches Evil Eve, pays honest payees', async () => {
    const cfg = await api('GET', '/api/config');
    expect(cfg.paypalMode).toBe('mock');
    const { roomId } = await api('POST', '/api/rooms');
    const r = `/api/rooms/${roomId}`;

    let alice = newWallet();
    let eve = newWallet();
    const bob = newWallet();
    const carol = newWallet();
    for (const [w, name] of [[alice, 'Alice'], [eve, 'Eve'], [bob, 'Bob'], [carol, 'Carol']] as const) {
      await api('POST', `${r}/wallets`, { publicKey: w.keys.publicKey, name, payoutEmail: `${name.toLowerCase()}@example.com` });
    }

    // Online: load balances with PayPal (Orders v2 create + capture), get signed load certificates.
    // One checkout funds two wallets (an organiser tops up several people at once).
    const order = await api('POST', `${r}/orders`, { allocations: [
      { wallet: alice.keys.publicKey, amountCents: 3000 }, { wallet: eve.keys.publicKey, amountCents: 2000 }] });
    expect(order.amountCents).toBe(5000);
    const { certs } = await api('POST', `${r}/orders/${order.id}/capture`);
    expect(certs).toHaveLength(2);
    expect(certs[0].gateway).toBe(cfg.gatewayPublicKey);
    alice = addCert(alice, certs[0]);
    eve = addCert(eve, certs[1]);

    // Offline: Alice pays Bob $8. Eve pays Bob $15 and then Carol $15 from the same state.
    const t = Date.now() - 60_000;
    const a1 = pay(alice, bob.keys.publicKey, 800, 'water', t).packet.voucher;
    const e1 = pay(eve, bob.keys.publicKey, 1500, 'battery', t + 1000).packet.voucher;
    const e2 = pay(eve, carol.keys.publicKey, 1500, 'rice', t + 2000).packet.voucher;

    // Back online: Bob's phone syncs his vouchers, Carol's phone syncs hers (and a duplicate).
    expect((await api('POST', `${r}/sync`, { vouchers: [a1, e1], via: 'Bob' })).added).toBe(2);
    expect((await api('POST', `${r}/sync`, { vouchers: [e2, a1], via: 'Carol' })).duplicates).toBe(1);

    const { runId } = await api('POST', `${r}/settle`);
    let run: any;
    for (let i = 0; i < 50; i++) {
      run = await api('GET', `${r}/runs/${runId}`);
      if (run.status !== 'running') break;
      await sleep(100);
    }
    expect(run.status).toBe('done');
    expect(run.forks).toHaveLength(1);
    expect(run.loadChecks.every((c: any) => c.matches)).toBe(true);

    const byKey = (payee: string, kind: string) => run.proposals.find((p: any) => p.payeeName === payee && p.kind === kind && (kind === 'shortfall' || p.reasons.length > 0 === (payee !== 'Bob' || p.amountCents === 1500)));
    const bobClean = run.proposals.find((p: any) => p.payeeName === 'Bob' && p.reasons.length === 0);
    const bobFlagged = run.proposals.find((p: any) => p.payeeName === 'Bob' && p.reasons.includes('fork_involved'));
    const carolShortfall = byKey('Carol', 'shortfall');
    expect(bobClean.amountCents).toBe(800);
    expect(['processing', 'paid']).toContain(bobClean.status);
    expect(bobFlagged.amountCents).toBe(1500);
    expect(bobFlagged.status).toBe('needs_approval');
    expect(carolShortfall.amountCents).toBe(1500);
    expect(carolShortfall.reasons).toContain('escrow_exhausted');

    // A human approves Bob's flagged payout (Eve's escrow covers it).
    const approved = await api('POST', `${r}/proposals/${bobFlagged.id}/approve`, { approver: 'organiser' });
    expect(approved.status).toBe('processing');
    await sleep(2600);
    const ledger = await api('GET', `${r}/ledger`);
    const statuses = Object.fromEntries(ledger.proposals.map((p: any) => [p.id, p.status]));
    expect(statuses[bobClean.id]).toBe('paid');
    expect(statuses[bobFlagged.id]).toBe('paid');
    expect(statuses[carolShortfall.id]).toBe('needs_approval');
    expect(ledger.payers.find((p: any) => p.name === 'Eve').frozen).toBe(true);

    // A second settlement run does not pay anything twice.
    const run2 = await api('POST', `${r}/settle`);
    await sleep(300);
    const second = await api('GET', `${r}/runs/${run2.runId}`);
    expect(second.proposals).toHaveLength(0);
  }, 20_000);

  it('rejects bad input', async () => {
    const { roomId } = await api('POST', '/api/rooms');
    await expect(api('POST', `/api/rooms/${roomId}/wallets`, { publicKey: 'zz', name: 'x' })).rejects.toThrow('400');
    await expect(api('POST', `/api/rooms/${roomId}/orders`, { wallet: 'a'.repeat(64), amountCents: 500 })).rejects.toThrow('400');
    await expect(api('GET', '/api/rooms/nope/ledger')).rejects.toThrow('404');
  });
});
