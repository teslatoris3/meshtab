import { describe, expect, it } from 'vitest';
import {
  addCert,
  checkIncoming,
  findForks,
  generateKeyPair,
  genesisHash,
  hashOf,
  issueLoadCert,
  newWallet,
  pay,
  settle,
  signVoucher,
  verifyForkProof,
  verifyLoadCert,
  verifyVoucher,
  voucherCanonical,
  type Voucher,
  type WalletState,
} from '../src/index.js';

const gateway = generateKeyPair();
const T0 = 1_762_700_000_000;

function funded(cents: number, loadId = `ORDER${Math.random().toString(36).slice(2, 10)}`): WalletState {
  const w = newWallet();
  return addCert(w, issueLoadCert({ wallet: w.keys.publicKey, amount: cents, loadId, issuedAt: T0 }, gateway));
}

describe('vouchers', () => {
  it('signs and verifies a voucher', () => {
    const alice = funded(2000);
    const bob = newWallet();
    const { packet } = pay(alice, bob.keys.publicKey, 500, 'bread', T0 + 1);
    expect(verifyVoucher(packet.voucher)).toEqual({ ok: true });
    expect(packet.voucher.seq).toBe(1);
    expect(packet.voucher.prev).toBe(genesisHash(alice.keys.publicKey));
  });

  it('rejects a voucher whose amount was changed after signing', () => {
    const alice = funded(2000);
    const { packet } = pay(alice, newWallet().keys.publicKey, 500, '', T0);
    const tampered: Voucher = { ...packet.voucher, amount: 900, cum: 900 };
    expect(verifyVoucher(tampered)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('will not let an honest wallet overspend', () => {
    const alice = funded(1000);
    const bob = newWallet().keys.publicKey;
    const first = pay(alice, bob, 800, '', T0).wallet;
    expect(() => pay(first, bob, 300, '', T0 + 1)).toThrow('insufficient balance');
  });

  it('rejects a load certificate from an unknown gateway', () => {
    const fake = generateKeyPair();
    const w = newWallet();
    const cert = issueLoadCert({ wallet: w.keys.publicKey, amount: 100000, loadId: 'FAKE1' }, fake);
    expect(verifyLoadCert(cert, gateway.publicKey).ok).toBe(false);
  });

  it('has a stable canonical form (test vector for other languages)', () => {
    const payer = 'a'.repeat(64);
    const payee = 'b'.repeat(64);
    const canonical = voucherCanonical({
      v: 1, kind: 'voucher', payer, payee, amount: 250, currency: 'USD', seq: 1,
      prev: genesisHash(payer), cum: 250, ts: T0, memo: 'tea',
    });
    expect(canonical).toBe(`MT1|VOUCHER|${payer}|${payee}|250|USD|1|${genesisHash(payer)}|250|${T0}|746561`);
  });
});

describe('honest chain', () => {
  it('settles a chain of three payments with no flags', () => {
    let alice = funded(3000);
    const bob = newWallet().keys.publicKey;
    const carol = newWallet().keys.publicKey;
    const vouchers: Voucher[] = [];
    for (const [to, amt] of [[bob, 500], [carol, 700], [bob, 300]] as const) {
      const r = pay(alice, to, amt, '', T0 + vouchers.length);
      alice = r.wallet;
      vouchers.push(r.packet.voucher);
    }
    expect(findForks(vouchers)).toHaveLength(0);
    const report = settle({ vouchers, loads: alice.certs, gateway: gateway.publicKey, now: T0 + 10 });
    expect(report.verdicts.every((v) => v.status === 'payable')).toBe(true);
    expect(report.payeeTotals[bob]).toBe(800);
    expect(report.payeeTotals[carol]).toBe(700);
    expect(report.payers[0]?.frozen).toBe(false);
  });

  it('ignores duplicate uploads of the same voucher (many phones may sync it)', () => {
    const alice = funded(1000);
    const bob = newWallet().keys.publicKey;
    const v = pay(alice, bob, 400, '', T0).packet.voucher;
    const report = settle({ vouchers: [v, v, { ...v }], loads: alice.certs, gateway: gateway.publicKey, now: T0 });
    expect(report.verdicts).toHaveLength(1);
    expect(report.payeeTotals[bob]).toBe(400);
  });

  it('does not pay a voucher twice across settlement runs', () => {
    let alice = funded(1000);
    const bob = newWallet().keys.publicKey;
    const r1 = pay(alice, bob, 400, '', T0);
    alice = r1.wallet;
    const r2 = pay(alice, bob, 300, '', T0 + 1);
    const settledSet = new Set([hashOf(r1.packet.voucher)]);
    const report = settle({
      vouchers: [r1.packet.voucher, r2.packet.voucher], loads: alice.certs, gateway: gateway.publicKey,
      settled: settledSet, now: T0 + 2,
    });
    expect(report.payeeTotals[bob]).toBe(300);
    expect(report.verdicts.find((v) => v.voucher.seq === 1)?.status).toBe('settled');
  });
});

describe('Evil Eve double-spend', () => {
  it('detects a forked chain: same balance spent twice from the same state', () => {
    const eve = funded(2000);
    const bob = newWallet().keys.publicKey;
    const carol = newWallet().keys.publicKey;
    // Eve pays Bob, then throws away the new state and pays Carol from the OLD state.
    const toBob = pay(eve, bob, 1500, 'phone charger', T0).packet.voucher;
    const toCarol = pay(eve, carol, 1500, 'rice', T0 + 60_000).packet.voucher;

    const forks = findForks([toBob, toCarol]);
    expect(forks).toHaveLength(1);
    expect(forks[0]?.kind).toBe('same_seq');
    expect(verifyForkProof(forks[0]!)).toBe(true);

    const report = settle({ vouchers: [toCarol, toBob], loads: eve.certs, gateway: gateway.publicKey, now: T0 + 120_000 });
    const eveReport = report.payers[0]!;
    expect(eveReport.forks).toHaveLength(1);
    expect(eveReport.frozen).toBe(true);
    // The escrow ($20) covers the first voucher in chain order; the second is a $15 shortfall.
    expect(report.payeeTotals[bob]).toBe(1500);
    expect(report.payeeTotals[carol]).toBeUndefined();
    expect(eveReport.uncoveredTotal).toBe(1500);
    expect(report.verdicts.every((v) => v.inFork)).toBe(true);
  });

  it('pays both payees when the escrow covers a double-spend, but still freezes the payer', () => {
    const eve = funded(5000);
    const bob = newWallet().keys.publicKey;
    const carol = newWallet().keys.publicKey;
    const a = pay(eve, bob, 1500, '', T0).packet.voucher;
    const b = pay(eve, carol, 1500, '', T0 + 1).packet.voucher;
    const report = settle({ vouchers: [a, b], loads: eve.certs, gateway: gateway.publicKey, now: T0 + 2 });
    expect(report.payeeTotals[bob]).toBe(1500);
    expect(report.payeeTotals[carol]).toBe(1500);
    expect(report.payers[0]?.frozen).toBe(true);
  });

  it('detects a same-prev fork even when the cheater changes the sequence number', () => {
    const eve = funded(3000);
    const bob = newWallet().keys.publicKey;
    const a = pay(eve, bob, 1000, '', T0).packet.voucher;
    const b = signVoucher({ ...a, payee: newWallet().keys.publicKey, seq: 2, cum: 2000, amount: 1000, ts: T0 + 5 }, eve.keys.secretKey);
    // seq 2 with the genesis prev is malformed only if seq is 1; here prev is genesis and seq is 2.
    const forks = findForks([a, b]);
    expect(forks[0]?.kind).toBe('same_prev');
  });

  it('lets a payee reject the second spend offline once it has seen the first (gossip)', () => {
    const eve = funded(2000);
    const bob = newWallet();
    const carol = newWallet();
    const toBob = pay(eve, bob.keys.publicKey, 1500, '', T0).packet;
    const toCarol = pay(eve, carol.keys.publicKey, 1500, '', T0 + 1).packet;

    // Carol has not heard about Bob's voucher: she cannot know. This is the offline limit.
    const blind = checkIncoming(toCarol, { me: carol.keys.publicKey, gateway: gateway.publicKey, known: [], blacklist: new Set() });
    expect(blind.ok).toBe(true);

    // Bob's voucher reached Carol over the mesh first: she rejects and gets a fork proof to gossip.
    const informed = checkIncoming(toCarol, {
      me: carol.keys.publicKey, gateway: gateway.publicKey, known: [toBob.voucher], blacklist: new Set(),
    });
    expect(informed.ok).toBe(false);
    expect(informed.reason).toBe('fork');
    expect(verifyForkProof(informed.proof!)).toBe(true);
  });

  it('rejects offline a voucher that claims more than the loaded balance', () => {
    const eve = funded(1000);
    const bob = newWallet();
    const forged = signVoucher(
      { v: 1, kind: 'voucher', payer: eve.keys.publicKey, payee: bob.keys.publicKey, amount: 1500, currency: 'USD',
        seq: 1, prev: genesisHash(eve.keys.publicKey), cum: 1500, ts: T0, memo: '' },
      eve.keys.secretKey,
    );
    const r = checkIncoming({ voucher: forged, certs: eve.certs }, {
      me: bob.keys.publicKey, gateway: gateway.publicKey, known: [], blacklist: new Set(),
    });
    expect(r.reason).toBe('over_cap');
  });

  it('catches a payer who lies about the running total (cum reset)', () => {
    let eve = funded(2000);
    const bob = newWallet();
    const r1 = pay(eve, bob.keys.publicKey, 1000, '', T0);
    eve = r1.wallet;
    // Honest seq 2 would have cum 1500. Eve signs cum 500 to look "fresh".
    const liar = signVoucher(
      { v: 1, kind: 'voucher', payer: eve.keys.publicKey, payee: bob.keys.publicKey, amount: 500, currency: 'USD',
        seq: 2, prev: eve.head, cum: 500, ts: T0 + 1, memo: '' },
      eve.keys.secretKey,
    );
    const offline = checkIncoming({ voucher: liar, certs: eve.certs }, {
      me: bob.keys.publicKey, gateway: gateway.publicKey, known: [r1.packet.voucher], blacklist: new Set(),
    });
    expect(offline.reason).toBe('cum_inconsistent');
    const report = settle({ vouchers: [r1.packet.voucher, liar], loads: eve.certs, gateway: gateway.publicKey, now: T0 + 2 });
    expect(report.payers[0]?.chainIssues.some((i) => i.includes('cum'))).toBe(true);
    expect(report.payers[0]?.frozen).toBe(true);
  });

  it('never pays a voucher from a wallet with no PayPal load', () => {
    const ghost = newWallet();
    const bob = newWallet().keys.publicKey;
    const v = signVoucher(
      { v: 1, kind: 'voucher', payer: ghost.keys.publicKey, payee: bob, amount: 100, currency: 'USD', seq: 1,
        prev: genesisHash(ghost.keys.publicKey), cum: 100, ts: T0, memo: '' },
      ghost.keys.secretKey,
    );
    const report = settle({ vouchers: [v], loads: [], gateway: gateway.publicKey, now: T0 });
    expect(report.verdicts[0]?.status).toBe('uncovered');
    expect(report.payeeTotals[bob]).toBeUndefined();
  });
});
