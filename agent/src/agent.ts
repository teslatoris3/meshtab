import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { shortId, type SettlementReport } from '@meshtab/protocol';
import { extractFeatures, type Directory, type PayerFeatures } from './features.js';
import { summarizeOrder, type OrderTool } from './paypalTools.js';
import type { AgentLogEntry, AgentResult, LoadCheck, PayerAssessment } from './types.js';

export interface ExpectedLoad {
  orderId: string;
  wallets: string[];
  /** Total amount of the PayPal order, in cents. */
  amountCents: number;
}

export interface AgentOptions {
  report: SettlementReport;
  directory: Directory;
  expectedLoads: ExpectedLoad[];
  orderTool: OrderTool;
  /** null = no LLM configured: rule-based assessments only. */
  client: Anthropic | null;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  onLog?: (entry: AgentLogEntry) => void;
}

const SYSTEM_PROMPT = `You are the settlement agent for MeshTab, an offline community payment system used during blackouts, disasters and in rural areas with unreliable internet.

People load a balance with PayPal while online. Offline, they pay each other with signed vouchers over a Bluetooth mesh. When a phone is back online it uploads the vouchers. Code has already checked every signature, every hash chain and every balance. Those results are final facts. You do not decide whether a voucher is valid, and you cannot make an uncovered voucher payable.

Your job:
1. Call paypal_get_order once for each PayPal order ID in the input to confirm that each balance load was really paid (status COMPLETED, capture COMPLETED, amount matches).
2. Call record_assessment once for every payer in the input. Give a risk score from 0 to 100, short flags, a recommendation, and a plain-language explanation.
3. Then reply with a summary of 2 to 4 sentences for the human approver.

Rules for assessments:
- Recommend "hold" when there is a double-spend fork, an escrow shortfall, a running-total lie, a PayPal load that does not match, or a pattern you think a careful human should check. Otherwise recommend "pay".
- Your recommendation can only add caution. A "hold" sends the payout to a human. A "pay" does not override the code or the approval limit.
- Write each explanation for a non-technical community organiser: at most 3 short sentences, use the people's names, write amounts in dollars, no jargon such as "hash" or "seq".
- Be fair to honest payees. When one payer cheats, say clearly that the people who received the money did nothing wrong.
- The baseline risk and flags in the input come from simple rules. Use them as a starting point, not as the answer.`;

export async function runSettlementAgent(opts: AgentOptions): Promise<AgentResult> {
  const log: AgentLogEntry[] = [];
  const emit = (kind: AgentLogEntry['kind'], text: string) => {
    const entry = { at: Date.now(), kind, text };
    log.push(entry);
    opts.onLog?.(entry);
  };

  const features = extractFeatures(opts.report, opts.directory);
  const byShort = new Map(features.map((f) => [shortId(f.payer), f]));
  const assessments = new Map<string, PayerAssessment>();
  const loadChecks = new Map<string, LoadCheck>();
  const expected = new Map(opts.expectedLoads.map((l) => [l.orderId, l]));
  let summary = '';

  const checkOrder = async (orderId: string, by: LoadCheck['checkedBy']) => {
    const exp = expected.get(orderId);
    const s = summarizeOrder(await opts.orderTool.lookup(orderId));
    const matches =
      !!exp && s.status === 'COMPLETED' && (s.captureStatus ?? 'COMPLETED') === 'COMPLETED' && s.amountCents === exp.amountCents;
    loadChecks.set(orderId, { orderId, wallets: exp?.wallets ?? [], status: s.status, amountCents: s.amountCents, matches, checkedBy: by });
    return { ...s, expectedAmountCents: exp?.amountCents ?? null, matchesLedger: matches };
  };

  if (opts.client && features.length > 0) {
    emit('info', `AI agent started (${opts.model}). ${features.length} payer(s), ${opts.expectedLoads.length} PayPal load(s) to check.`);
    try {
      summary = await runLlm(opts, features, byShort, assessments, checkOrder, emit);
    } catch (err) {
      emit('warn', `AI agent failed, using rule-based assessments: ${errorText(err)}`);
    }
  } else if (features.length > 0) {
    emit('info', 'No LLM configured: using rule-based assessments.');
  }

  // Code-level safety net: every PayPal load is checked even if the LLM skipped one.
  for (const l of opts.expectedLoads) {
    if (loadChecks.has(l.orderId)) continue;
    try {
      await checkOrder(l.orderId, 'code');
      emit('tool', `Code checked PayPal order ${l.orderId}: ${loadChecks.get(l.orderId)?.status}`);
    } catch (err) {
      loadChecks.set(l.orderId, { orderId: l.orderId, wallets: l.wallets, status: 'LOOKUP_FAILED', amountCents: null, matches: false, checkedBy: 'code' });
      emit('warn', `Could not check PayPal order ${l.orderId}: ${errorText(err)}`);
    }
  }

  for (const f of features) {
    if (!assessments.has(f.payer)) assessments.set(f.payer, ruleAssessment(f));
  }
  if (!summary) summary = ruleSummary(features);

  return {
    assessments: [...assessments.values()],
    loadChecks: [...loadChecks.values()],
    summary,
    model: opts.client ? opts.model : null,
    log,
  };
}

async function runLlm(
  opts: AgentOptions,
  features: PayerFeatures[],
  byShort: Map<string, PayerFeatures>,
  assessments: Map<string, PayerAssessment>,
  checkOrder: (orderId: string, by: 'agent') => Promise<unknown>,
  emit: (kind: AgentLogEntry['kind'], text: string) => void,
): Promise<string> {
  const client = opts.client!;
  const knownOrders = new Set(opts.expectedLoads.map((l) => l.orderId));

  const getOrder = betaTool({
    name: opts.orderTool.name,
    description: opts.orderTool.description,
    inputSchema: opts.orderTool.inputSchema as { type: 'object'; properties: { id: { type: 'string' } }; required: ['id'] },
    run: async (input) => {
      const id = String((input as { id: string }).id);
      if (!knownOrders.has(id)) return JSON.stringify({ error: 'Not a load order in this settlement. Only check the listed order IDs.' });
      const out = await checkOrder(id, 'agent');
      emit('tool', `PayPal Agent Toolkit get_order(${id}) -> ${JSON.stringify(out)}`);
      return JSON.stringify(out);
    },
  });

  const recordAssessment = betaTool({
    name: 'record_assessment',
    description: 'Record the risk assessment for one payer. Call once per payer.',
    strict: true,
    inputSchema: {
      type: 'object',
      properties: {
        payer_id: { type: 'string', description: 'The payer_id from the input (8 hex characters).' },
        risk_score: { type: 'integer', description: '0 = no concern, 100 = certain fraud.' },
        flags: { type: 'array', items: { type: 'string' }, description: 'Short snake_case flags.' },
        recommendation: { type: 'string', enum: ['pay', 'hold'] },
        explanation: { type: 'string', description: 'At most 3 short plain-language sentences for a non-technical approver.' },
      },
      required: ['payer_id', 'risk_score', 'flags', 'recommendation', 'explanation'],
      additionalProperties: false,
    },
    run: async (input) => {
      const f = byShort.get(input.payer_id);
      if (!f) return `Unknown payer_id ${input.payer_id}. Use one of: ${[...byShort.keys()].join(', ')}`;
      // The AI can only add caution: a code-frozen payer is always "hold".
      const recommendation = f.frozen ? 'hold' : input.recommendation;
      assessments.set(f.payer, {
        payer: f.payer,
        name: f.name,
        riskScore: Math.max(0, Math.min(100, Math.round(input.risk_score))),
        flags: input.flags.slice(0, 8).map((x) => x.slice(0, 40)),
        explanation: input.explanation.slice(0, 600),
        recommendation,
        source: 'llm',
      });
      emit('llm', `Assessment for ${f.name}: risk ${input.risk_score}, ${recommendation}. ${input.explanation}`);
      return 'recorded';
    },
  });

  const input = {
    payers: features.map((f) => ({
      payer_id: shortId(f.payer),
      name: f.name,
      loaded_usd: usd(f.loadedCents),
      spent_offline_usd: usd(f.claimedCents),
      payable_usd: usd(f.payableCents),
      shortfall_usd: usd(f.uncoveredCents),
      vouchers: f.voucherCount,
      distinct_payees: f.distinctPayees,
      forks: f.forks.map((k) => ({ paid: k.payees, amounts_usd: k.amounts.map(usd), minutes_apart: k.minutesApart })),
      chain_issues: f.chainIssues,
      max_vouchers_in_10_min: f.maxVouchersIn10Min,
      near_limit_amounts: f.nearLimitCount,
      round_trip_with: f.roundTripWith,
      future_dated_vouchers: f.futureDated,
      frozen_by_code: f.frozen,
      paypal_order_ids: f.loadOrderIds,
      baseline_risk: f.baselineRisk,
      baseline_flags: f.baselineFlags,
    })),
  };

  const useFallbacks = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(opts.model);
  const runner = client.beta.messages.toolRunner(
    {
      model: opts.model,
      max_tokens: 16000,
      thread: false,
      max_iterations: 4 + opts.expectedLoads.length + features.length,
      output_config: { effort: opts.effort },
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      system: SYSTEM_PROMPT,
      tools: [getOrder, recordAssessment],
      messages: [
        {
          role: 'user',
          content: `Settlement input (facts computed by code):\n${JSON.stringify(input, null, 2)}`,
        },
      ],
    },
    { signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) },
  );

  let final: Anthropic.Beta.BetaMessage | null = null;
  for await (const message of runner) {
    final = message;
    for (const block of message.content) {
      if (block.type === 'tool_use') emit('llm', `Agent calls ${block.name}`);
    }
  }
  if (!final) throw new Error('no response from model');
  if (final.stop_reason === 'refusal') throw new Error('model declined the request');
  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  emit('llm', `Agent summary: ${text}`);
  return text;
}

export function ruleAssessment(f: PayerFeatures): PayerAssessment {
  const parts: string[] = [];
  if (f.forkCount) {
    const k = f.forks[0]!;
    parts.push(`${f.name} spent the same balance twice: ${usd(k.amounts[0]!)} to ${k.payees[0]} and ${usd(k.amounts[1]!)} to ${k.payees[1]}, ${k.minutesApart} minutes apart.`);
  }
  if (f.uncoveredCents) parts.push(`${usd(f.uncoveredCents)} is not covered by ${f.name}'s PayPal balance and needs a human decision.`);
  if (f.chainIssues.length && !f.forkCount) parts.push(`${f.name}'s payment history does not add up.`);
  if (f.forkCount || f.uncoveredCents) parts.push('The people who received these payments did nothing wrong.');
  if (!parts.length) parts.push(`${f.name} made ${f.voucherCount} payment(s) within the ${usd(f.loadedCents)} loaded with PayPal. Nothing unusual.`);
  const hold = f.frozen || f.baselineRisk >= 50;
  return {
    payer: f.payer,
    name: f.name,
    riskScore: f.baselineRisk,
    flags: f.baselineFlags,
    explanation: parts.join(' '),
    recommendation: hold ? 'hold' : 'pay',
    source: 'rules',
  };
}

function ruleSummary(features: PayerFeatures[]): string {
  const bad = features.filter((f) => f.frozen);
  if (!bad.length) return `All ${features.length} payer(s) stayed within their PayPal balance. Payouts can go ahead.`;
  return `${bad.map((f) => f.name).join(', ')} broke the rules and ${bad.length === 1 ? 'is' : 'are'} frozen. Honest payees are paid from the escrow first; any shortfall waits for a human decision.`;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function errorText(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `Claude API ${err.status ?? ''} ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}
