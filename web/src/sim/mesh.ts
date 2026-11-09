import {
  addCert, availableBalance, checkIncoming, detectFork, hashOf, newWallet, pay, verifyForkProof,
  type ForkProof, type LoadCert, type PaymentPacket, type Voucher, type WalletState,
} from '@meshtab/protocol';

/**
 * A small Bluetooth-mesh simulator modelled on Bitchat: phones in range form links, messages
 * flood with a TTL and are de-duplicated by ID, and phones exchange their stores when a new link
 * forms (like Bitchat's sync request). All money logic comes from @meshtab/protocol.
 */

export const RANGE = 250;
export const HOP_MS = 650;
const TTL = 7;

export interface SimNode {
  id: string;
  name: string;
  role: 'buyer' | 'shop' | 'relay' | 'evil';
  x: number;
  y: number;
  wallet: WalletState;
  /** Eve keeps a copy of an old wallet state to replay it (the double-spend). */
  stash: WalletState | null;
  received: Voucher[];
  known: Map<string, Voucher>;
  proofs: ForkProof[];
  blacklist: Set<string>;
  seen: Set<string>;
  payoutEmail: string | null;
}

export type EventKind = 'pay' | 'accept' | 'reject' | 'relay' | 'fork' | 'sync' | 'info' | 'paypal' | 'online';
export interface SimEvent { id: number; at: number; kind: EventKind; text: string }

interface Message {
  id: string;
  kind: 'payment' | 'fork_proof';
  ttl: number;
  hops: number;
  packet?: PaymentPacket;
  proof?: ForkProof;
}

export interface Flight {
  id: string;
  from: string;
  to: string;
  start: number;
  duration: number;
  kind: 'payment' | 'fork_proof' | 'sync' | 'upload';
  arrive: () => void;
}

interface Move { node: string; fromX: number; fromY: number; toX: number; toY: number; start: number; duration: number; done?: () => void }

let msgCounter = 0;
const newMsgId = () => `m${Date.now().toString(36)}${(msgCounter++).toString(36)}`;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export class MeshEngine {
  nodes = new Map<string, SimNode>();
  flights: Flight[] = [];
  moves: Move[] = [];
  events: SimEvent[] = [];
  internet = false;
  gatewayKey = '';
  version = 0;
  private links = new Set<string>();
  private listeners = new Set<() => void>();
  private eventId = 0;
  private now = () => performance.now();

  constructor(gatewayKey: string) {
    this.gatewayKey = gatewayKey;
  }

  // ---------- React glue ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
  get busy() {
    return this.flights.length > 0 || this.moves.length > 0;
  }

  log(kind: EventKind, text: string) {
    this.events = [{ id: ++this.eventId, at: Date.now(), kind, text }, ...this.events].slice(0, 80);
    this.changed();
  }

  // ---------- Setup ----------
  addNode(n: Pick<SimNode, 'id' | 'name' | 'role' | 'x' | 'y'> & { payoutEmail?: string | null }) {
    this.nodes.set(n.id, {
      ...n, wallet: newWallet(), stash: null, received: [], known: new Map(), proofs: [], blacklist: new Set(), seen: new Set(),
      payoutEmail: n.payoutEmail ?? null,
    });
    this.links = this.computeLinks();
    this.changed();
  }

  node(id: string): SimNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  byKey(publicKey: string): SimNode | undefined {
    for (const n of this.nodes.values()) if (n.wallet.keys.publicKey === publicKey) return n;
    return undefined;
  }

  nameOfKey(publicKey: string) {
    return this.byKey(publicKey)?.name ?? publicKey.slice(0, 8);
  }

  balance(id: string) {
    return availableBalance(this.node(id).wallet);
  }

  receivedTotal(id: string) {
    return this.node(id).received.reduce((s, v) => s + v.amount, 0);
  }

  addCerts(certs: LoadCert[]) {
    for (const c of certs) {
      const n = this.byKey(c.wallet);
      if (!n) continue;
      n.wallet = addCert(n.wallet, c);
      this.log('paypal', `${n.name}'s phone got a signed load certificate for ${usd(c.amount)} (PayPal order ${c.loadId.split('-')[0]}).`);
    }
    this.changed();
  }

  setInternet(on: boolean) {
    this.internet = on;
    this.log('online', on ? 'Internet is back. Phones can sync with the MeshTab gateway.' : 'Internet is down. Phones can only talk to each other over Bluetooth.');
  }

  // ---------- Geometry ----------
  private computeLinks(): Set<string> {
    const out = new Set<string>();
    const list = [...this.nodes.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= RANGE) out.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
      }
    }
    return out;
  }

  linkList(): [string, string][] {
    return [...this.links].map((k) => k.split('|') as [string, string]);
  }

  neighbors(id: string): string[] {
    const out: string[] = [];
    for (const k of this.links) {
      const [a, b] = k.split('|') as [string, string];
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }

  setPosition(id: string, x: number, y: number) {
    const n = this.node(id);
    n.x = x;
    n.y = y;
    this.refreshLinks();
  }

  moveTo(id: string, x: number, y: number, duration = 1400): Promise<void> {
    const n = this.node(id);
    return new Promise((resolve) => {
      this.moves = this.moves.filter((m) => m.node !== id);
      this.moves.push({ node: id, fromX: n.x, fromY: n.y, toX: x, toY: y, start: this.now(), duration, done: resolve });
      this.changed();
    });
  }

  /** New links trigger a store exchange in both directions (gossip sync). */
  private refreshLinks() {
    const next = this.computeLinks();
    for (const k of next) {
      if (this.links.has(k)) continue;
      const [a, b] = k.split('|') as [string, string];
      this.gossip(a, b);
      this.gossip(b, a);
    }
    this.links = next;
    this.changed();
  }

  // ---------- Animation step ----------
  step() {
    const t = this.now();
    let moved = false;
    for (const m of [...this.moves]) {
      const p = Math.min(1, (t - m.start) / m.duration);
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      const n = this.node(m.node);
      n.x = m.fromX + (m.toX - m.fromX) * e;
      n.y = m.fromY + (m.toY - m.fromY) * e;
      moved = true;
      if (p >= 1) {
        this.moves = this.moves.filter((x) => x !== m);
        m.done?.();
      }
    }
    if (moved) this.refreshLinks();
    const due = this.flights.filter((f) => t >= f.start + f.duration);
    if (due.length) {
      this.flights = this.flights.filter((f) => t < f.start + f.duration);
      for (const f of due) f.arrive();
    }
    if (moved || due.length || this.flights.length) this.changed();
  }

  private fly(from: string, to: string, kind: Flight['kind'], arrive: () => void, delay = 0) {
    this.flights.push({ id: newMsgId(), from, to, kind, start: this.now() + delay, duration: HOP_MS, arrive });
  }

  // ---------- Payments ----------
  /** The payer's phone signs a voucher and floods it into the mesh. */
  pay(fromId: string, toId: string, cents: number, memo = '', opts: { fromStash?: boolean } = {}) {
    const from = this.node(fromId);
    const to = this.node(toId);
    const base = opts.fromStash && from.stash ? from.stash : from.wallet;
    const { packet, wallet } = pay(base, to.wallet.keys.publicKey, cents, memo);
    from.wallet = wallet;
    from.known.set(hashOf(packet.voucher), packet.voucher);
    this.log('pay', `${from.name} signed a voucher: ${usd(cents)} to ${to.name}${opts.fromStash ? ' (replaying an OLD wallet copy)' : ''}.`);
    const msg: Message = { id: newMsgId(), kind: 'payment', ttl: TTL, hops: 0, packet };
    from.seen.add(msg.id);
    this.forward(fromId, msg, null);
    if (!this.neighbors(fromId).length) this.log('info', `${from.name} has no phones in Bluetooth range. The voucher waits on the phone.`);
    this.changed();
  }

  stash(id: string) {
    const n = this.node(id);
    n.stash = structuredClone(n.wallet);
  }

  private forward(fromId: string, msg: Message, cameFrom: string | null) {
    if (msg.ttl <= 0) return;
    for (const nb of this.neighbors(fromId)) {
      if (nb === cameFrom) continue;
      const next: Message = { ...msg, ttl: msg.ttl - 1, hops: msg.hops + 1 };
      this.fly(fromId, nb, msg.kind, () => this.deliver(nb, next, fromId));
    }
  }

  private deliver(id: string, msg: Message, cameFrom: string) {
    const n = this.node(id);
    if (n.seen.has(msg.id)) return;
    n.seen.add(msg.id);
    if (msg.kind === 'payment' && msg.packet) this.onPayment(n, msg.packet, msg.hops);
    if (msg.kind === 'fork_proof' && msg.proof) this.onProof(n, msg.proof);
    // A cheater's phone runs modified software: it does not relay other people's messages.
    if (n.role !== 'evil') this.forward(id, msg, cameFrom);
    this.changed();
  }

  private onPayment(n: SimNode, packet: PaymentPacket, hops: number) {
    const v = packet.voucher;
    const known = [...n.known.values()];
    if (v.payee === n.wallet.keys.publicKey) {
      const r = checkIncoming(packet, { me: v.payee, gateway: this.gatewayKey, known, blacklist: n.blacklist });
      const payer = this.nameOfKey(v.payer);
      if (r.ok) {
        n.received.push(v);
        this.log('accept', `${n.name} accepted ${usd(v.amount)} from ${payer} after ${hops} hop${hops === 1 ? '' : 's'}. Signature and PayPal balance certificate checked offline.`);
      } else {
        this.log('reject', `${n.name} REJECTED ${usd(v.amount)} from ${payer}: ${rejectText(r.reason)}.`);
        if (r.proof) this.raiseFork(n, r.proof);
      }
    } else {
      this.log('relay', `${n.name}'s phone relayed a voucher (${hops} hop${hops === 1 ? '' : 's'}).`);
    }
    this.learn(n, v);
  }

  /** Store a voucher this phone has seen, and look for a conflict with what it already knows. */
  private learn(n: SimNode, v: Voucher) {
    const h = hashOf(v);
    if (n.known.has(h)) return;
    for (const k of n.known.values()) {
      const proof = detectFork(k, v);
      if (proof) {
        n.known.set(h, v);
        this.raiseFork(n, proof);
        return;
      }
    }
    n.known.set(h, v);
  }

  private raiseFork(n: SimNode, proof: ForkProof) {
    if (n.blacklist.has(proof.payer)) return;
    n.blacklist.add(proof.payer);
    n.proofs.push(proof);
    const cheat = this.nameOfKey(proof.payer);
    this.log('fork', `${n.name}'s phone found a DOUBLE-SPEND: ${cheat} signed two different payments from the same balance (to ${this.nameOfKey(proof.a.payee)} and ${this.nameOfKey(proof.b.payee)}). It broadcasts the proof.`);
    const msg: Message = { id: `fork-${hashOf(proof.a).slice(0, 8)}-${hashOf(proof.b).slice(0, 8)}`, kind: 'fork_proof', ttl: TTL, hops: 0, proof };
    n.seen.add(msg.id);
    this.forward(n.id, msg, null);
  }

  private onProof(n: SimNode, proof: ForkProof) {
    if (proof.payer === n.wallet.keys.publicKey) return; // the cheater's own phone
    if (!verifyForkProof(proof)) {
      this.log('reject', `${n.name} ignored a fake fork proof.`);
      return;
    }
    for (const v of [proof.a, proof.b]) n.known.set(hashOf(v), v);
    if (!n.blacklist.has(proof.payer)) {
      n.blacklist.add(proof.payer);
      n.proofs.push(proof);
      this.log('fork', `${n.name}'s phone verified the proof and now refuses payments from ${this.nameOfKey(proof.payer)}.`);
    }
  }

  /** When a link forms, each side sends the vouchers and proofs it knows (Bitchat-style sync). */
  private gossip(fromId: string, toId: string) {
    const from = this.node(fromId);
    // A cheater's phone hides its own spending history from the phones it meets.
    if (from.role === 'evil') return;
    const vouchers = [...from.known.values()];
    const proofs = [...from.proofs];
    if (!vouchers.length && !proofs.length) return;
    this.fly(fromId, toId, 'sync', () => {
      const to = this.node(toId);
      let fresh = 0;
      for (const p of proofs) this.onProof(to, p);
      for (const v of vouchers) {
        if (!to.known.has(hashOf(v))) fresh++;
        this.learn(to, v);
      }
      if (fresh) this.log('sync', `${from.name} and ${to.name} came into range and synced ${fresh} voucher${fresh === 1 ? '' : 's'} over Bluetooth.`);
      this.changed();
    });
  }

  /** Every voucher any phone holds (what gets uploaded when the internet comes back). */
  allKnown(): { via: string; vouchers: Voucher[] }[] {
    return [...this.nodes.values()].map((n) => ({ via: n.name, vouchers: [...n.known.values()] }));
  }

  animateUpload(ids: string[]) {
    for (const id of ids) this.fly(id, '__cloud__', 'upload', () => this.changed());
    this.changed();
  }
}

function rejectText(reason: string | undefined): string {
  switch (reason) {
    case 'fork': return 'this payer already spent that money (double-spend)';
    case 'blacklisted': return 'this payer is blocked by a verified double-spend proof';
    case 'over_cap': return 'the voucher claims more than the PayPal balance';
    case 'bad_certificate': return 'the balance certificate is not signed by the MeshTab gateway';
    case 'cum_inconsistent': return 'the running total does not add up';
    case 'duplicate': return 'already received';
    default: return reason ?? 'invalid';
  }
}
