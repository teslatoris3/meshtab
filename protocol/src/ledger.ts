import { verifyLoadCert, type LoadCert } from './cert.js';
import { findForks, hashOf, type ForkProof } from './fork.js';
import { genesisHash, isFutureDated, verifyVoucher, type Voucher } from './voucher.js';

export type VoucherStatus =
  /** Valid and covered by the payer's escrowed PayPal balance. */
  | 'payable'
  /** Valid signature, but the payer spent more than the escrow holds (double-spend shortfall). */
  | 'uncovered'
  /** Bad format or bad signature. Never paid. */
  | 'invalid'
  /** Paid in an earlier settlement run. */
  | 'settled';

export interface VoucherVerdict {
  hash: string;
  voucher: Voucher;
  status: VoucherStatus;
  inFork: boolean;
  reasons: string[];
}

export interface PayerReport {
  payer: string;
  cap: number;
  claimedTotal: number;
  settledTotal: number;
  payableTotal: number;
  uncoveredTotal: number;
  voucherCount: number;
  forks: ForkProof[];
  chainIssues: string[];
  /** True when the payer must be frozen: a fork, a shortfall or a broken chain. */
  frozen: boolean;
}

export interface SettlementReport {
  verdicts: VoucherVerdict[];
  payers: PayerReport[];
  /** Total payable per payee, in cents (only `payable` vouchers). */
  payeeTotals: Record<string, number>;
  generatedAt: number;
}

export interface SettlementInput {
  vouchers: Voucher[];
  /** Load certificates that the gateway issued (authoritative list). */
  loads: LoadCert[];
  gateway: string;
  /** Hashes of vouchers already paid out in earlier runs. */
  settled?: Set<string>;
  now?: number;
}

/**
 * Deterministic settlement. This function alone decides validity and how much each payee is owed.
 * The AI agent may add holds and explanations on top of it, but it cannot make an invalid or
 * uncovered voucher payable.
 *
 * Rule for a double-spend: the payer's escrow pays vouchers in chain order (seq, then time,
 * then hash) until the escrow is used up. Vouchers past that point are `uncovered`. They go to
 * human review, and the payer's wallet is frozen.
 */
export function settle(input: SettlementInput): SettlementReport {
  const now = input.now ?? Date.now();
  const settled = input.settled ?? new Set<string>();
  const verdicts: VoucherVerdict[] = [];
  const seen = new Set<string>();
  const validByPayer = new Map<string, VoucherVerdict[]>();

  const capByPayer = new Map<string, number>();
  const loadIds = new Set<string>();
  for (const c of input.loads) {
    if (!verifyLoadCert(c, input.gateway).ok || loadIds.has(c.loadId)) continue;
    loadIds.add(c.loadId);
    capByPayer.set(c.wallet, (capByPayer.get(c.wallet) ?? 0) + c.amount);
  }

  for (const v of input.vouchers) {
    const hash = hashOf(v);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const fmt = verifyVoucher(v);
    if (!fmt.ok) {
      verdicts.push({ hash, voucher: v, status: 'invalid', inFork: false, reasons: [fmt.reason] });
      continue;
    }
    const verdict: VoucherVerdict = { hash, voucher: v, status: 'payable', inFork: false, reasons: [] };
    if (isFutureDated(v, now)) verdict.reasons.push('future_timestamp');
    verdicts.push(verdict);
    const list = validByPayer.get(v.payer) ?? [];
    list.push(verdict);
    validByPayer.set(v.payer, list);
  }

  const payers: PayerReport[] = [];
  for (const [payer, list] of validByPayer) {
    const cap = capByPayer.get(payer) ?? 0;
    const vouchers = list.map((x) => x.voucher);
    const forks = findForks(vouchers);
    const forkHashes = new Set(forks.flatMap((f) => [hashOf(f.a), hashOf(f.b)]));
    const byHash = new Map(list.map((x) => [x.hash, x]));
    const chainIssues: string[] = [];

    for (const x of list) {
      if (forkHashes.has(x.hash)) {
        x.inFork = true;
        x.reasons.push('fork');
      }
      const v = x.voucher;
      if (v.seq > 1 && v.prev !== genesisHash(payer)) {
        const parent = byHash.get(v.prev);
        if (parent) {
          if (parent.voucher.seq !== v.seq - 1) chainIssues.push(`seq ${v.seq}: parent has seq ${parent.voucher.seq}`);
          if (parent.voucher.cum + v.amount !== v.cum) {
            chainIssues.push(`seq ${v.seq}: cum ${v.cum} != parent cum ${parent.voucher.cum} + ${v.amount}`);
            x.reasons.push('cum_mismatch');
          }
        } else {
          x.reasons.push('gap_before');
        }
      }
      if (v.cum > cap) x.reasons.push('claims_over_cap');
    }
    if (cap === 0) chainIssues.push('no PayPal load found for this payer');

    // Pay in chain order until the escrow is used up.
    const ordered = [...list].sort(
      (a, b) => a.voucher.seq - b.voucher.seq || a.voucher.ts - b.voucher.ts || a.hash.localeCompare(b.hash),
    );
    let used = 0;
    let settledTotal = 0;
    for (const x of ordered) {
      if (settled.has(x.hash)) {
        x.status = 'settled';
        used += x.voucher.amount;
        settledTotal += x.voucher.amount;
      }
    }
    let payableTotal = 0;
    let uncoveredTotal = 0;
    for (const x of ordered) {
      if (x.status === 'settled') continue;
      if (used + x.voucher.amount <= cap) {
        x.status = 'payable';
        used += x.voucher.amount;
        payableTotal += x.voucher.amount;
      } else {
        x.status = 'uncovered';
        x.reasons.push('escrow_exhausted');
        uncoveredTotal += x.voucher.amount;
      }
    }

    payers.push({
      payer,
      cap,
      claimedTotal: list.reduce((s, x) => s + x.voucher.amount, 0),
      settledTotal,
      payableTotal,
      uncoveredTotal,
      voucherCount: list.length,
      forks,
      chainIssues,
      frozen: forks.length > 0 || uncoveredTotal > 0 || chainIssues.some((i) => i.includes('cum')),
    });
  }

  const payeeTotals: Record<string, number> = {};
  for (const x of verdicts) {
    if (x.status === 'payable') payeeTotals[x.voucher.payee] = (payeeTotals[x.voucher.payee] ?? 0) + x.voucher.amount;
  }
  return { verdicts, payers, payeeTotals, generatedAt: now };
}
