export type Recommendation = 'pay' | 'hold';

export interface PayerAssessment {
  payer: string;
  name: string;
  riskScore: number;
  flags: string[];
  /** Plain-language explanation for the human approver. */
  explanation: string;
  recommendation: Recommendation;
  source: 'llm' | 'rules';
}

export interface LoadCheck {
  orderId: string;
  /** Wallets funded by this order (one checkout can fund several). */
  wallets: string[];
  /** PayPal order status as returned by the PayPal Agent Toolkit `get_order` tool. */
  status: string;
  amountCents: number | null;
  matches: boolean;
  checkedBy: 'agent' | 'code';
}

export interface AgentLogEntry {
  at: number;
  kind: 'info' | 'tool' | 'llm' | 'warn';
  text: string;
}

export interface AgentResult {
  assessments: PayerAssessment[];
  loadChecks: LoadCheck[];
  summary: string;
  model: string | null;
  log: AgentLogEntry[];
}
