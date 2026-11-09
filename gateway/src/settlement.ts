import type Anthropic from '@anthropic-ai/sdk';
import { runSettlementAgent, type AgentResult, type OrderTool } from '@meshtab/agent';
import { settle, shortId, type SettlementReport } from '@meshtab/protocol';
import type { Config } from './config.js';
import type { PayPalApi } from './paypal.js';
import { newId, type PayoutProposal, type Room, type SettlementRun, type Store } from './store.js';

const PAID = new Set(['SUCCESS', 'UNCLAIMED']);
const FAILED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'DENIED', 'REFUNDED', 'REVERSED']);

/**
 * Turns uploaded vouchers into PayPal payouts:
 *   1. settle()  - deterministic: signatures, chains, forks, escrow (protocol package)
 *   2. AI agent  - checks PayPal loads with the PayPal Agent Toolkit, scores risk, explains
 *   3. policy    - code decides what is auto-paid and what needs a human
 *   4. Payouts   - PayPal Payouts API (sandbox)
 */
export class SettlementService {
  private llmDay = '';
  private llmRuns = 0;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly paypal: PayPalApi,
    private readonly orderTool: OrderTool,
    private readonly anthropic: Anthropic | null,
  ) {}

  startRun(room: Room): SettlementRun {
    const running = [...room.runs.values()].find((r) => r.status === 'running');
    if (running) return running;
    const run: SettlementRun = {
      id: newId(), status: 'running', startedAt: Date.now(), finishedAt: null, log: [], report: null, agent: null, proposalIds: [], error: null,
    };
    room.runs.set(run.id, run);
    void this.execute(room, run).catch((err) => {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = Date.now();
    });
    return run;
  }

  /** Hashes whose escrow is already used (payout proposals that were not rejected). */
  private escrowUsed(room: Room): Set<string> {
    const used = new Set<string>();
    for (const p of room.proposals.values()) {
      if (p.kind === 'payout' && p.status !== 'rejected') p.voucherHashes.forEach((h) => used.add(h));
    }
    return used;
  }

  report(room: Room): SettlementReport {
    return settle({
      vouchers: [...room.vouchers.values()].map((r) => r.voucher),
      loads: this.store.certs(room),
      gateway: this.cfg.gateway.publicKey,
      settled: this.escrowUsed(room),
    });
  }

  nameOf(room: Room, key: string): string {
    return room.wallets.get(key)?.name ?? `wallet ${shortId(key)}`;
  }

  private takeLlmBudget(): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.llmDay) { this.llmDay = day; this.llmRuns = 0; }
    if (this.llmRuns >= this.cfg.llmRunsPerDay) return false;
    this.llmRuns++;
    return true;
  }

  private async execute(room: Room, run: SettlementRun) {
    const log = (kind: 'info' | 'warn', text: string) => run.log.push({ at: Date.now(), kind, text });
    const report = this.report(room);
    run.report = report;
    const proposed = new Set([...room.proposals.values()].flatMap((p) => p.voucherHashes));
    const fresh = report.verdicts.filter((v) => !proposed.has(v.hash) && v.status !== 'settled');
    log('info', `Code checked ${report.verdicts.length} voucher(s): ${count(report, 'payable')} payable, ${count(report, 'uncovered')} uncovered, ${count(report, 'invalid')} invalid, ${report.payers.reduce((s, p) => s + p.forks.length, 0)} fork(s).`);

    const names: Record<string, string> = {};
    for (const w of room.wallets.values()) names[w.publicKey] = w.name;
    const loads: Record<string, string[]> = {};
    const expectedLoads = [];
    for (const o of room.orders.values()) {
      if (!o.cert) continue;
      (loads[o.wallet] ??= []).push(o.orderId);
      expectedLoads.push({ orderId: o.orderId, wallet: o.wallet, amountCents: o.amountCents });
    }
    const involvedPayers = new Set(report.payers.map((p) => p.payer));
    const client = this.anthropic && report.payers.length > 0 && this.takeLlmBudget() ? this.anthropic : null;
    if (this.anthropic && !client && report.payers.length > 0) log('warn', 'Daily AI budget used up: rule-based assessments only.');

    const agent: AgentResult = await runSettlementAgent({
      report,
      directory: { names, loads },
      expectedLoads: expectedLoads.filter((l) => involvedPayers.has(l.wallet)),
      orderTool: this.orderTool,
      client,
      model: this.cfg.llmModel,
      effort: this.cfg.llmEffort,
      onLog: (e) => run.log.push(e),
    });
    run.agent = agent;

    // ---- Policy (code). The AI can only add holds. ----
    const assessment = new Map(agent.assessments.map((a) => [a.payer, a]));
    const payerReport = new Map(report.payers.map((p) => [p.payer, p]));
    const badLoads = new Set(agent.loadChecks.filter((c) => !c.matches).map((c) => c.wallet));
    const groups = new Map<string, PayoutProposal>();

    for (const v of fresh) {
      if (v.status === 'invalid') continue;
      const payer = v.voucher.payer;
      const reasons: string[] = [];
      if (v.status === 'uncovered') reasons.push('escrow_exhausted');
      if (v.inFork) reasons.push('fork_involved');
      if (payerReport.get(payer)?.frozen) reasons.push(`payer_frozen:${this.nameOf(room, payer)}`);
      if (assessment.get(payer)?.recommendation === 'hold') reasons.push(`ai_hold:${this.nameOf(room, payer)}`);
      if (badLoads.has(payer)) reasons.push(`paypal_load_unverified:${this.nameOf(room, payer)}`);
      const kind = v.status === 'uncovered' ? 'shortfall' : 'payout';
      const flagged = reasons.length > 0;
      const key = `${v.voucher.payee}|${kind}|${flagged}`;
      let g = groups.get(key);
      if (!g) {
        const wallet = room.wallets.get(v.voucher.payee);
        g = {
          id: newId(), runId: run.id, kind, payee: v.voucher.payee, payeeName: this.nameOf(room, v.voucher.payee),
          receiver: wallet?.payoutEmail ?? null, amountCents: 0, voucherHashes: [], payers: [], status: 'auto_approved',
          reasons: [], createdAt: Date.now(), decidedBy: null, decidedAt: null, batchId: null, paypalStatus: null, error: null,
        };
        groups.set(key, g);
      }
      g.amountCents += v.voucher.amount;
      g.voucherHashes.push(v.hash);
      if (!g.payers.includes(payer)) g.payers.push(payer);
      for (const r of reasons) if (!g.reasons.includes(r)) g.reasons.push(r);
    }

    const auto: PayoutProposal[] = [];
    for (const g of groups.values()) {
      if (g.amountCents > this.cfg.approvalLimitCents) g.reasons.push('over_approval_limit');
      g.status = !g.receiver ? 'awaiting_details' : g.reasons.length ? 'needs_approval' : 'auto_approved';
      this.store.addProposal(room, g);
      run.proposalIds.push(g.id);
      if (g.status === 'auto_approved') auto.push(g);
    }
    log('info', `Policy: ${auto.length} payout(s) auto-approved, ${run.proposalIds.length - auto.length} waiting for a human.`);
    if (auto.length) await this.pay(room, auto, run);
    run.status = 'done';
    run.finishedAt = Date.now();
  }

  async approve(room: Room, proposalId: string, approver: string): Promise<PayoutProposal> {
    const p = room.proposals.get(proposalId);
    if (!p) throw new HttpError(404, 'proposal not found');
    if (p.status !== 'needs_approval' && p.status !== 'failed') throw new HttpError(409, `proposal is ${p.status}`);
    if (!p.receiver) throw new HttpError(409, 'payee has no PayPal email yet');
    p.status = 'approved';
    p.decidedBy = approver;
    p.decidedAt = Date.now();
    await this.pay(room, [p]);
    return p;
  }

  reject(room: Room, proposalId: string, approver: string): PayoutProposal {
    const p = room.proposals.get(proposalId);
    if (!p) throw new HttpError(404, 'proposal not found');
    if (p.status !== 'needs_approval' && p.status !== 'awaiting_details') throw new HttpError(409, `proposal is ${p.status}`);
    p.status = 'rejected';
    p.decidedBy = approver;
    p.decidedAt = Date.now();
    return p;
  }

  /** Called when a payee adds a PayPal email after a proposal was made. */
  receiverAdded(room: Room, wallet: string, email: string) {
    for (const p of room.proposals.values()) {
      if (p.payee === wallet && p.status === 'awaiting_details') {
        p.receiver = email;
        p.status = 'needs_approval';
      }
    }
  }

  private async pay(room: Room, proposals: PayoutProposal[], run?: SettlementRun) {
    for (const p of proposals) p.status = 'processing';
    try {
      const batch = await this.paypal.createPayout({
        senderBatchId: `mt-${room.id}-${newId(4)}`,
        items: proposals.map((p) => ({
          senderItemId: p.id,
          receiver: p.receiver!,
          amountCents: p.amountCents,
          note: `MeshTab: ${p.voucherHashes.length} offline payment(s) settled${p.kind === 'shortfall' ? ' (covered by community pool)' : ''}`,
        })),
      });
      for (const p of proposals) { p.batchId = batch.batchId; p.paypalStatus = batch.status; }
      run?.log.push({ at: Date.now(), kind: 'tool', text: `PayPal Payouts batch ${batch.batchId} created for ${proposals.length} payee(s) (${this.paypal.mode}).` });
      this.poll(room, batch.batchId, 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const p of proposals) { p.status = 'failed'; p.error = msg; }
      run?.log.push({ at: Date.now(), kind: 'warn', text: `PayPal Payouts failed: ${msg}` });
    }
  }

  private poll(room: Room, batchId: string, attempt: number) {
    if (attempt > 12) return;
    setTimeout(async () => {
      try {
        const b = await this.paypal.getPayoutBatch(batchId);
        let pending = false;
        for (const item of b.items) {
          const p = room.proposals.get(item.senderItemId);
          if (!p) continue;
          this.applyItemStatus(p, item.status);
          if (p.status === 'processing') pending = true;
        }
        if (pending || b.items.length === 0) this.poll(room, batchId, attempt + 1);
      } catch {
        this.poll(room, batchId, attempt + 1);
      }
    }, Math.min(2000 * 2 ** Math.min(attempt, 3), 15_000)).unref?.();
  }

  applyItemStatus(p: PayoutProposal, status: string) {
    p.paypalStatus = status;
    if (PAID.has(status)) p.status = 'paid';
    else if (FAILED.has(status)) { p.status = 'failed'; p.error = `PayPal item status ${status}`; }
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function count(r: SettlementReport, status: string) {
  return r.verdicts.filter((v) => v.status === status).length;
}
