import { verifyLoadCert, type LoadCert } from './cert.js';
import { CURRENCY, MAX_VOUCHER_CENTS } from './constants.js';
import { detectFork, hashOf, type ForkProof } from './fork.js';
import { generateKeyPair, type KeyPair } from './keys.js';
import { genesisHash, isFutureDated, signVoucher, verifyVoucher, type Voucher } from './voucher.js';

/** What a phone keeps about its own spending chain. */
export interface WalletState {
  keys: KeyPair;
  seq: number;
  head: string;
  cum: number;
  certs: LoadCert[];
}

/** What travels over the mesh for one payment: the voucher plus the payer's load certificates. */
export interface PaymentPacket {
  voucher: Voucher;
  certs: LoadCert[];
}

export function newWallet(keys: KeyPair = generateKeyPair()): WalletState {
  return { keys, seq: 0, head: genesisHash(keys.publicKey), cum: 0, certs: [] };
}

export function loadedTotal(certs: LoadCert[]): number {
  const byLoad = new Map<string, number>();
  for (const c of certs) byLoad.set(c.loadId, c.amount);
  let total = 0;
  for (const amount of byLoad.values()) total += amount;
  return total;
}

export function availableBalance(w: WalletState): number {
  return loadedTotal(w.certs) - w.cum;
}

export function addCert(w: WalletState, cert: LoadCert): WalletState {
  if (cert.wallet !== w.keys.publicKey) throw new Error('certificate is for a different wallet');
  if (w.certs.some((c) => c.loadId === cert.loadId)) return w;
  return { ...w, certs: [...w.certs, cert] };
}

/** Creates the next voucher in the chain. Pure: returns the new wallet state. */
export function pay(
  w: WalletState,
  payee: string,
  amount: number,
  memo = '',
  now = Date.now(),
): { packet: PaymentPacket; wallet: WalletState } {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (cents)');
  if (amount > MAX_VOUCHER_CENTS) throw new Error(`offline limit is ${MAX_VOUCHER_CENTS} cents per voucher`);
  if (amount > availableBalance(w)) throw new Error('insufficient balance');
  const voucher = signVoucher(
    {
      v: 1,
      kind: 'voucher',
      payer: w.keys.publicKey,
      payee,
      amount,
      currency: CURRENCY,
      seq: w.seq + 1,
      prev: w.head,
      cum: w.cum + amount,
      ts: now,
      memo,
    },
    w.keys.secretKey,
  );
  return {
    packet: { voucher, certs: w.certs },
    wallet: { ...w, seq: voucher.seq, head: hashOf(voucher), cum: voucher.cum },
  };
}

export type AcceptReason =
  | 'invalid_voucher'
  | 'not_for_me'
  | 'bad_certificate'
  | 'over_cap'
  | 'blacklisted'
  | 'fork'
  | 'cum_inconsistent'
  | 'duplicate';

export interface AcceptResult {
  ok: boolean;
  reason?: AcceptReason;
  detail?: string;
  warnings: string[];
  proof?: ForkProof;
}

/**
 * The payee's offline check, run before it accepts a payment.
 * It cannot prevent a double-spend to a phone it never hears from. It catches every
 * conflict with vouchers it already knows (its own or gossiped), and it rejects payers
 * that are on the local blacklist because of a verified fork proof.
 */
export function checkIncoming(
  packet: PaymentPacket,
  ctx: { me: string; gateway: string; known: Voucher[]; blacklist: Set<string>; now?: number },
): AcceptResult {
  const { voucher: v, certs } = packet;
  const warnings: string[] = [];
  const fmt = verifyVoucher(v);
  if (!fmt.ok) return { ok: false, reason: 'invalid_voucher', detail: fmt.reason, warnings };
  if (v.payee !== ctx.me) return { ok: false, reason: 'not_for_me', warnings };
  if (ctx.blacklist.has(v.payer)) return { ok: false, reason: 'blacklisted', warnings };
  for (const c of certs) {
    const r = verifyLoadCert(c, ctx.gateway);
    if (!r.ok || c.wallet !== v.payer) return { ok: false, reason: 'bad_certificate', detail: r.reason, warnings };
  }
  const cap = loadedTotal(certs);
  if (v.cum > cap) return { ok: false, reason: 'over_cap', detail: `cum ${v.cum} > loaded ${cap}`, warnings };
  const h = hashOf(v);
  for (const k of ctx.known) {
    if (k.payer !== v.payer) continue;
    if (hashOf(k) === h) return { ok: false, reason: 'duplicate', warnings };
    const proof = detectFork(k, v);
    if (proof) return { ok: false, reason: 'fork', proof, warnings };
    // In an honest chain, cum grows by at least `amount` at every step.
    if (k.seq < v.seq && v.cum - v.amount < k.cum) return { ok: false, reason: 'cum_inconsistent', warnings };
    if (k.seq > v.seq && k.cum - k.amount < v.cum) return { ok: false, reason: 'cum_inconsistent', warnings };
  }
  if (isFutureDated(v, ctx.now)) warnings.push('voucher time is in the future');
  return { ok: true, warnings };
}
