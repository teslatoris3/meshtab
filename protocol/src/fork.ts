import { verifyVoucher, voucherHash, type Voucher } from './voucher.js';

/**
 * Two vouchers signed by the same payer that cannot both be part of one honest chain.
 * Anyone can verify a fork proof offline with only the two vouchers, so a phone can gossip it
 * over the mesh and every phone that receives it can stop accepting the cheater at once.
 */
export interface ForkProof {
  payer: string;
  kind: 'same_seq' | 'same_prev';
  a: Voucher;
  b: Voucher;
}

export function hashOf(v: Voucher): string {
  const { sig: _sig, ...unsigned } = v;
  return voucherHash(unsigned);
}

export function detectFork(a: Voucher, b: Voucher): ForkProof | null {
  if (a.payer !== b.payer) return null;
  const ha = hashOf(a);
  const hb = hashOf(b);
  if (ha === hb) return null;
  if (a.seq === b.seq) return { payer: a.payer, kind: 'same_seq', a, b };
  if (a.prev === b.prev) return { payer: a.payer, kind: 'same_prev', a, b };
  return null;
}

/** Returns true only if both vouchers have valid signatures and really conflict. */
export function verifyForkProof(p: ForkProof): boolean {
  if (!verifyVoucher(p.a).ok || !verifyVoucher(p.b).ok) return false;
  const found = detectFork(p.a, p.b);
  return found !== null && found.payer === p.payer;
}

/** Finds every fork in a set of vouchers. Input may contain duplicates and many payers. */
export function findForks(vouchers: Voucher[]): ForkProof[] {
  const proofs: ForkProof[] = [];
  const seen = new Set<string>();
  const bySeq = new Map<string, Voucher>();
  const byPrev = new Map<string, Voucher>();
  for (const v of vouchers) {
    const h = hashOf(v);
    if (seen.has(h)) continue;
    seen.add(h);
    const seqKey = `${v.payer}:${v.seq}`;
    const prevKey = `${v.payer}:${v.prev}`;
    const sameSeq = bySeq.get(seqKey);
    const samePrev = byPrev.get(prevKey);
    if (sameSeq) proofs.push({ payer: v.payer, kind: 'same_seq', a: sameSeq, b: v });
    else if (samePrev) proofs.push({ payer: v.payer, kind: 'same_prev', a: samePrev, b: v });
    if (!sameSeq) bySeq.set(seqKey, v);
    if (!samePrev) byPrev.set(prevKey, v);
  }
  return proofs;
}
