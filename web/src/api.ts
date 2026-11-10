import type { LoadCert, Voucher } from '@meshtab/protocol';

export interface ServerConfig {
  paypalMode: 'sandbox' | 'mock';
  paypalClientId: string | null;
  gatewayPublicKey: string;
  approvalLimitCents: number;
  maxLoadCents: number;
  ai: { enabled: boolean; model: string | null; provider: string };
  demoReceivers: Record<string, string>;
}

export interface AgentLogEntry { at: number; kind: 'info' | 'tool' | 'llm' | 'warn'; text: string }
export interface Assessment { payer: string; name: string; riskScore: number; flags: string[]; explanation: string; recommendation: 'pay' | 'hold'; source: 'llm' | 'rules' }
export interface LoadCheck { orderId: string; wallets: string[]; status: string; amountCents: number | null; matches: boolean; checkedBy: 'agent' | 'code' }
export interface Proposal {
  id: string; kind: 'payout' | 'shortfall'; payee: string; payeeName: string; receiver: string | null; amountCents: number;
  voucherHashes: string[]; payers: string[]; status: string; reasons: string[]; decidedBy: string | null;
  batchId: string | null; paypalStatus: string | null; error: string | null;
}
export interface RunView {
  id: string; status: 'running' | 'done' | 'failed'; error: string | null; log: AgentLogEntry[]; assessments: Assessment[];
  loadChecks: LoadCheck[]; summary: string | null; model: string | null; proposals: Proposal[];
  forks: { payerName: string; kind: string; a: { payee: string; amount: number }; b: { payee: string; amount: number } }[];
}
export interface Ledger {
  rows: Record<string, unknown>[];
  payers: Record<string, unknown>[];
  proposals: Proposal[];
  orders: Record<string, unknown>[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path.slice(1), { // relative to the page, so /meshtab/ works too
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${method} ${path} failed (${res.status})`);
  return json as T;
}

export const api = {
  config: () => call<ServerConfig>('GET', '/api/config'),
  createRoom: () => call<{ roomId: string }>('POST', '/api/rooms'),
  registerWallet: (room: string, w: { publicKey: string; name: string; payoutEmail?: string | null }) =>
    call('POST', `/api/rooms/${room}/wallets`, w),
  createOrder: (room: string, allocations: { wallet: string; amountCents: number }[]) =>
    call<{ id: string; amountCents: number }>('POST', `/api/rooms/${room}/orders`, { allocations }),
  payWithTestCard: (room: string, allocations: { wallet: string; amountCents: number }[]) =>
    call<{ id: string; amountCents: number; certs: LoadCert[]; order: { id: string; status: string; captureId?: string } }>(
      'POST', `/api/rooms/${room}/orders`, { allocations, method: 'test_card' }),
  capture: (room: string, orderId: string) =>
    call<{ certs: LoadCert[]; order: { id: string; status: string; captureId?: string } }>('POST', `/api/rooms/${room}/orders/${orderId}/capture`),
  sync: (room: string, vouchers: Voucher[], via: string) =>
    call<{ added: number; duplicates: number; invalid: number }>('POST', `/api/rooms/${room}/sync`, { vouchers, via }),
  settle: (room: string) => call<{ runId: string }>('POST', `/api/rooms/${room}/settle`),
  run: (room: string, runId: string) => call<RunView>('GET', `/api/rooms/${room}/runs/${runId}`),
  approve: (room: string, id: string) => call<Proposal>('POST', `/api/rooms/${room}/proposals/${id}/approve`, { approver: 'demo organiser' }),
  reject: (room: string, id: string) => call<Proposal>('POST', `/api/rooms/${room}/proposals/${id}/reject`, { approver: 'demo organiser' }),
  ledger: (room: string) => call<Ledger>('GET', `/api/rooms/${room}/ledger`),
};
