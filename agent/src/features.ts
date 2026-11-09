import { MAX_VOUCHER_CENTS, shortId, type SettlementReport, type Voucher } from '@meshtab/protocol';

/** Plain facts about one payer, computed by code. The LLM reads these; it never computes them. */
export interface PayerFeatures {
  payer: string;
  name: string;
  loadedCents: number;
  claimedCents: number;
  payableCents: number;
  uncoveredCents: number;
  voucherCount: number;
  distinctPayees: number;
  forkCount: number;
  forks: { seq: number; payees: string[]; amounts: number[]; minutesApart: number }[];
  chainIssues: string[];
  maxVouchersIn10Min: number;
  nearLimitCount: number;
  roundTripWith: string[];
  futureDated: number;
  loadOrderIds: string[];
  frozen: boolean;
  /** Heuristic score 0-100. A baseline for the LLM and the fallback when no LLM is configured. */
  baselineRisk: number;
  baselineFlags: string[];
}

export interface Directory {
  /** wallet public key -> display name */
  names: Record<string, string>;
  /** wallet public key -> PayPal order IDs that funded it */
  loads: Record<string, string[]>;
}

const nameOf = (dir: Directory, key: string) => dir.names[key] ?? `wallet ${shortId(key)}`;

export function extractFeatures(report: SettlementReport, dir: Directory): PayerFeatures[] {
  const valid = report.verdicts.filter((v) => v.status !== 'invalid').map((v) => v.voucher);
  const edges = new Set(valid.map((v) => `${v.payer}>${v.payee}`));

  return report.payers.map((p) => {
    const mine = valid.filter((v) => v.payer === p.payer).sort((a, b) => a.ts - b.ts);
    const flags: string[] = [];
    let risk = 0;

    const forks = p.forks.map((f) => ({
      seq: f.a.seq,
      payees: [nameOf(dir, f.a.payee), nameOf(dir, f.b.payee)],
      amounts: [f.a.amount, f.b.amount],
      minutesApart: Math.round(Math.abs(f.b.ts - f.a.ts) / 60_000),
    }));
    if (forks.length) { risk += 60; flags.push('double_spend_fork'); }
    if (p.uncoveredTotal > 0) { risk += 20; flags.push('escrow_shortfall'); }
    if (p.chainIssues.some((i) => i.includes('cum'))) { risk += 30; flags.push('running_total_lie'); }
    if (p.cap === 0) { risk += 40; flags.push('no_paypal_load'); }

    const maxIn10 = maxInWindow(mine, 10 * 60_000);
    if (maxIn10 >= 6) { risk += 10; flags.push('high_velocity'); }
    const nearLimit = mine.filter((v) => v.amount >= MAX_VOUCHER_CENTS * 0.9).length;
    if (nearLimit >= 3) { risk += 10; flags.push('many_near_limit_amounts'); }
    const roundTrip = [...new Set(mine.filter((v) => edges.has(`${v.payee}>${v.payer}`)).map((v) => nameOf(dir, v.payee)))];
    if (roundTrip.length) { risk += 10; flags.push('round_trip_payments'); }
    const futureDated = report.verdicts.filter((v) => v.voucher.payer === p.payer && v.reasons.includes('future_timestamp')).length;
    if (futureDated) { risk += 10; flags.push('future_timestamps'); }

    return {
      payer: p.payer,
      name: nameOf(dir, p.payer),
      loadedCents: p.cap,
      claimedCents: p.claimedTotal,
      payableCents: p.payableTotal,
      uncoveredCents: p.uncoveredTotal,
      voucherCount: p.voucherCount,
      distinctPayees: new Set(mine.map((v) => v.payee)).size,
      forkCount: forks.length,
      forks,
      chainIssues: p.chainIssues,
      maxVouchersIn10Min: maxIn10,
      nearLimitCount: nearLimit,
      roundTripWith: roundTrip,
      futureDated,
      loadOrderIds: dir.loads[p.payer] ?? [],
      frozen: p.frozen,
      baselineRisk: Math.min(100, risk),
      baselineFlags: flags,
    };
  });
}

function maxInWindow(sorted: Voucher[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end]!.ts - sorted[start]!.ts > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}
