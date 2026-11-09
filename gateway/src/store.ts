import { randomBytes } from 'node:crypto';
import { hashOf, type LoadCert, type SettlementReport, type Voucher } from '@meshtab/protocol';
import type { AgentLogEntry, AgentResult } from '@meshtab/agent';

export interface WalletRecord { publicKey: string; name: string; payoutEmail: string | null; createdAt: number }
export interface OrderRecord { orderId: string; wallet: string; amountCents: number; status: string; captureId: string | null; cert: LoadCert | null; createdAt: number }
export interface VoucherRecord { voucher: Voucher; hash: string; receivedAt: number; via: string }

export type ProposalStatus =
  | 'auto_approved' | 'needs_approval' | 'awaiting_details' | 'approved' | 'rejected' | 'processing' | 'paid' | 'failed';

export interface PayoutProposal {
  id: string;
  runId: string;
  kind: 'payout' | 'shortfall';
  payee: string;
  payeeName: string;
  receiver: string | null;
  amountCents: number;
  voucherHashes: string[];
  payers: string[];
  status: ProposalStatus;
  reasons: string[];
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  batchId: string | null;
  paypalStatus: string | null;
  error: string | null;
}

export interface SettlementRun {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  log: AgentLogEntry[];
  report: SettlementReport | null;
  agent: AgentResult | null;
  proposalIds: string[];
  error: string | null;
}

export interface Room {
  id: string;
  createdAt: number;
  lastActive: number;
  wallets: Map<string, WalletRecord>;
  orders: Map<string, OrderRecord>;
  vouchers: Map<string, VoucherRecord>;
  proposals: Map<string, PayoutProposal>;
  runs: Map<string, SettlementRun>;
}

export const newId = (bytes = 6) => randomBytes(bytes).toString('hex');

const MAX_ROOMS = 1000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VOUCHERS_PER_ROOM = 2000;

/** In-memory demo storage. Each browser session gets its own room so judges do not collide. */
export class Store {
  private rooms = new Map<string, Room>();
  /** proposal id -> room id, for PayPal webhooks */
  private proposalIndex = new Map<string, string>();

  createRoom(): Room {
    this.gc();
    if (this.rooms.size >= MAX_ROOMS) {
      const oldest = [...this.rooms.values()].sort((a, b) => a.lastActive - b.lastActive)[0];
      if (oldest) this.rooms.delete(oldest.id);
    }
    const now = Date.now();
    const room: Room = {
      id: newId(8), createdAt: now, lastActive: now,
      wallets: new Map(), orders: new Map(), vouchers: new Map(), proposals: new Map(), runs: new Map(),
    };
    this.rooms.set(room.id, room);
    return room;
  }

  getRoom(id: string): Room | undefined {
    const room = this.rooms.get(id);
    if (room) room.lastActive = Date.now();
    return room;
  }

  addVouchers(room: Room, vouchers: Voucher[], via: string): { added: number; duplicates: number } {
    let added = 0;
    let duplicates = 0;
    for (const v of vouchers) {
      const hash = hashOf(v);
      if (room.vouchers.has(hash)) { duplicates++; continue; }
      if (room.vouchers.size >= MAX_VOUCHERS_PER_ROOM) break;
      room.vouchers.set(hash, { voucher: v, hash, receivedAt: Date.now(), via });
      added++;
    }
    return { added, duplicates };
  }

  addProposal(room: Room, p: PayoutProposal) {
    room.proposals.set(p.id, p);
    this.proposalIndex.set(p.id, room.id);
  }

  findProposal(id: string): { room: Room; proposal: PayoutProposal } | null {
    const roomId = this.proposalIndex.get(id);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    const proposal = room?.proposals.get(id);
    return room && proposal ? { room, proposal } : null;
  }

  certs(room: Room): LoadCert[] {
    return [...room.orders.values()].flatMap((o) => (o.cert ? [o.cert] : []));
  }

  private gc() {
    const cutoff = Date.now() - ROOM_TTL_MS;
    for (const [id, r] of this.rooms) {
      if (r.lastActive < cutoff) {
        this.rooms.delete(id);
        for (const p of r.proposals.keys()) this.proposalIndex.delete(p);
      }
    }
  }
}
