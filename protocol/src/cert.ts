import { CURRENCY, PROTOCOL_TAG } from './constants.js';
import { isHex, isPositiveInt, sha256Hex } from './encoding.js';
import { signDigest, verifyDigest } from './keys.js';

/**
 * A load certificate. The gateway signs it after PayPal captures a payment.
 * It proves, offline, that a wallet holds `amount` cents of escrowed balance.
 */
export interface LoadCert {
  v: 1;
  kind: 'load';
  wallet: string;
  amount: number;
  currency: string;
  /** PayPal Orders v2 order ID that funded this load. */
  loadId: string;
  issuedAt: number;
  /** Gateway public key (hex). */
  gateway: string;
  sig: string;
}

export type UnsignedLoadCert = Omit<LoadCert, 'sig'>;

export function certCanonical(c: UnsignedLoadCert): string {
  return [PROTOCOL_TAG, 'LOAD', c.wallet, c.amount, c.currency, c.loadId, c.issuedAt, c.gateway].join('|');
}

export function certHash(c: UnsignedLoadCert): string {
  return sha256Hex(certCanonical(c));
}

export function issueLoadCert(
  args: { wallet: string; amount: number; loadId: string; issuedAt?: number },
  gateway: { publicKey: string; secretKey: string },
): LoadCert {
  if (!isHex(args.wallet, 32)) throw new Error('wallet must be a 32-byte hex public key');
  if (!isPositiveInt(args.amount)) throw new Error('amount must be a positive integer (cents)');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.loadId)) throw new Error('loadId has invalid characters');
  const unsigned: UnsignedLoadCert = {
    v: 1,
    kind: 'load',
    wallet: args.wallet,
    amount: args.amount,
    currency: CURRENCY,
    loadId: args.loadId,
    issuedAt: args.issuedAt ?? Date.now(),
    gateway: gateway.publicKey,
  };
  return { ...unsigned, sig: signDigest(certHash(unsigned), gateway.secretKey) };
}

export function verifyLoadCert(c: LoadCert, trustedGateway: string): { ok: boolean; reason?: string } {
  if (c?.v !== 1 || c.kind !== 'load') return { ok: false, reason: 'bad_format' };
  if (c.gateway !== trustedGateway) return { ok: false, reason: 'unknown_gateway' };
  if (!isPositiveInt(c.amount) || c.currency !== CURRENCY) return { ok: false, reason: 'bad_amount' };
  const { sig, ...unsigned } = c;
  if (!verifyDigest(sig, certHash(unsigned), c.gateway)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
