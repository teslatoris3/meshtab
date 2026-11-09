import { CURRENCY, FUTURE_SKEW_MS, MAX_MEMO_BYTES, MAX_VOUCHER_CENTS, PROTOCOL_TAG } from './constants.js';
import { isHex, isPositiveInt, sha256Hex, textToHex, utf8ToBytes } from './encoding.js';
import { signDigest, verifyDigest } from './keys.js';

/**
 * A signed offline payment. Each payer keeps one hash chain:
 *   seq = 1, 2, 3 ...   prev = hash of the voucher with seq - 1 (or the genesis hash for seq 1)
 *   cum = total spent by this payer including this voucher
 * Two different vouchers with the same payer and seq (or the same prev) are a provable fork,
 * which means the payer tried to spend the same balance twice.
 */
export interface Voucher {
  v: 1;
  kind: 'voucher';
  payer: string;
  payee: string;
  amount: number;
  currency: string;
  seq: number;
  prev: string;
  cum: number;
  ts: number;
  memo: string;
  sig: string;
}

export type UnsignedVoucher = Omit<Voucher, 'sig'>;

export function genesisHash(payer: string): string {
  return sha256Hex(`${PROTOCOL_TAG}|GENESIS|${payer}`);
}

/**
 * Canonical form. Only hex, integers and fixed ASCII, joined by '|', so the same bytes can be
 * built in Kotlin, Swift or TypeScript without a JSON library.
 */
export function voucherCanonical(v: UnsignedVoucher): string {
  return [
    PROTOCOL_TAG,
    'VOUCHER',
    v.payer,
    v.payee,
    v.amount,
    v.currency,
    v.seq,
    v.prev,
    v.cum,
    v.ts,
    textToHex(v.memo),
  ].join('|');
}

export function voucherHash(v: UnsignedVoucher): string {
  return sha256Hex(voucherCanonical(v));
}

export function signVoucher(unsigned: UnsignedVoucher, secretKey: string): Voucher {
  return { ...unsigned, sig: signDigest(voucherHash(unsigned), secretKey) };
}

export type VoucherFormatError =
  | 'bad_format'
  | 'bad_key'
  | 'bad_amount'
  | 'over_voucher_limit'
  | 'bad_currency'
  | 'bad_seq'
  | 'bad_prev'
  | 'bad_cum'
  | 'bad_memo'
  | 'self_payment'
  | 'bad_signature';

/** Checks format and signature. It does not check balance or forks (see ledger.ts). */
export function verifyVoucher(v: Voucher): { ok: true } | { ok: false; reason: VoucherFormatError } {
  if (v?.v !== 1 || v.kind !== 'voucher') return { ok: false, reason: 'bad_format' };
  if (!isHex(v.payer, 32) || !isHex(v.payee, 32)) return { ok: false, reason: 'bad_key' };
  if (v.payer === v.payee) return { ok: false, reason: 'self_payment' };
  if (!isPositiveInt(v.amount)) return { ok: false, reason: 'bad_amount' };
  if (v.amount > MAX_VOUCHER_CENTS) return { ok: false, reason: 'over_voucher_limit' };
  if (v.currency !== CURRENCY) return { ok: false, reason: 'bad_currency' };
  if (!isPositiveInt(v.seq)) return { ok: false, reason: 'bad_seq' };
  if (!isHex(v.prev, 32)) return { ok: false, reason: 'bad_prev' };
  if (v.seq === 1 && v.prev !== genesisHash(v.payer)) return { ok: false, reason: 'bad_prev' };
  if (!isPositiveInt(v.cum) || v.cum < v.amount) return { ok: false, reason: 'bad_cum' };
  if (v.seq === 1 && v.cum !== v.amount) return { ok: false, reason: 'bad_cum' };
  if (typeof v.memo !== 'string' || utf8ToBytes(v.memo).length > MAX_MEMO_BYTES) return { ok: false, reason: 'bad_memo' };
  if (!Number.isSafeInteger(v.ts) || v.ts <= 0) return { ok: false, reason: 'bad_format' };
  const { sig, ...unsigned } = v;
  if (!verifyDigest(sig, voucherHash(unsigned), v.payer)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export function isFutureDated(v: Voucher, now = Date.now()): boolean {
  return v.ts > now + FUTURE_SKEW_MS;
}

/** Short, human-friendly ID for UIs and logs. */
export function shortId(hex: string): string {
  return hex.slice(0, 8);
}
