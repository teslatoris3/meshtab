import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { isHex, issueLoadCert, shortId, verifyVoucher, type Voucher } from '@meshtab/protocol';
import type { Config } from './config.js';
import type { PayPalApi } from './paypal.js';
import { HttpError, type SettlementService } from './settlement.js';
import { newId, type OrderRecord, type Room, type Store } from './store.js';

export interface Deps { cfg: Config; store: Store; paypal: PayPalApi; settlement: SettlementService }

const NAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}$/;

export function createApp({ cfg, store, paypal, settlement }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));

  const limit = rateLimiter();

  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  app.get('/api/config', (_req, res) => {
    res.json({
      paypalMode: paypal.mode,
      paypalClientId: paypal.mode === 'sandbox' ? cfg.paypalClientId : null,
      gatewayPublicKey: cfg.gateway.publicKey,
      approvalLimitCents: cfg.approvalLimitCents,
      maxLoadCents: cfg.maxLoadCents,
      ai: { enabled: cfg.anthropicConfigured, model: cfg.anthropicConfigured ? cfg.llmModel : null, provider: 'Anthropic Claude' },
      demoReceivers: cfg.demoReceivers,
    });
  });

  app.post('/api/rooms', limit('rooms', 30), (_req, res) => {
    const room = store.createRoom();
    res.status(201).json({ roomId: room.id });
  });

  // PayPal has the money: sign one offline load certificate per funded wallet.
  const issueCerts = (rec: OrderRecord) =>
    rec.allocations.map((a, i) => issueLoadCert({ wallet: a.wallet, amount: a.amountCents, loadId: `${rec.orderId}-${i + 1}` }, cfg.gateway));

  const withRoom = (req: Request): Room => {
    const room = store.getRoom(String(req.params.room));
    if (!room) throw new HttpError(404, 'room not found (rooms expire after 24 hours)');
    return room;
  };

  app.post('/api/rooms/:room/wallets', (req, res) => {
    const room = withRoom(req);
    const { publicKey, name, payoutEmail } = req.body ?? {};
    if (!isHex(publicKey, 32)) throw new HttpError(400, 'publicKey must be 32-byte hex');
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, 'name: 1-24 letters, digits, space, _ . -');
    if (payoutEmail != null && (typeof payoutEmail !== 'string' || !EMAIL_RE.test(payoutEmail))) throw new HttpError(400, 'bad payoutEmail');
    const existing = room.wallets.get(publicKey);
    room.wallets.set(publicKey, { publicKey, name, payoutEmail: payoutEmail ?? existing?.payoutEmail ?? null, createdAt: existing?.createdAt ?? Date.now() });
    if (payoutEmail) settlement.receiverAdded(room, publicKey, payoutEmail);
    res.status(201).json({ ok: true });
  });

  // ---- PayPal Orders v2: load a balance (one checkout can fund several wallets) ----
  app.post('/api/rooms/:room/orders', limit('orders', 20), async (req, res) => {
    const room = withRoom(req);
    const raw = Array.isArray(req.body?.allocations) ? req.body.allocations : [{ wallet: req.body?.wallet, amountCents: req.body?.amountCents }];
    if (raw.length < 1 || raw.length > 10) throw new HttpError(400, 'allocations: 1 to 10 wallets');
    const allocations: { wallet: string; amountCents: number }[] = [];
    for (const a of raw) {
      if (!room.wallets.has(a?.wallet)) throw new HttpError(400, 'register every wallet first');
      if (!Number.isSafeInteger(a.amountCents) || a.amountCents < 100 || a.amountCents > cfg.maxLoadCents) {
        throw new HttpError(400, `each amountCents must be between 100 and ${cfg.maxLoadCents}`);
      }
      if (allocations.some((x) => x.wallet === a.wallet)) throw new HttpError(400, 'duplicate wallet');
      allocations.push({ wallet: a.wallet, amountCents: a.amountCents });
    }
    const amountCents = allocations.reduce((s, a) => s + a.amountCents, 0);
    const names = allocations.map((a) => room.wallets.get(a.wallet)!.name).join(', ');
    const args = {
      amountCents,
      customId: `${room.id}:${allocations.length}`,
      description: `MeshTab offline balance: ${names}`.slice(0, 127),
      requestId: `mt-order-${newId(8)}`,
    };
    if (req.body?.method === 'test_card') {
      // One call: PayPal creates and captures the order with the sandbox test card.
      const cap = await paypal.payWithTestCard(args);
      const rec: OrderRecord = { orderId: cap.id, allocations, amountCents, status: cap.status, captureId: cap.captureId, certs: [], createdAt: Date.now() };
      room.orders.set(cap.id, rec);
      if (cap.status !== 'COMPLETED' || cap.captureStatus !== 'COMPLETED' || cap.amountCents !== amountCents) {
        throw new HttpError(402, `PayPal test-card payment not completed (${cap.status}/${cap.captureStatus})`);
      }
      rec.certs = issueCerts(rec);
      res.status(201).json({ id: cap.id, status: cap.status, amountCents, certs: rec.certs, order: { id: cap.id, status: cap.status, captureId: cap.captureId } });
      return;
    }
    const order = await paypal.createOrder(args);
    room.orders.set(order.id, { orderId: order.id, allocations, amountCents, status: order.status, captureId: null, certs: [], createdAt: Date.now() });
    res.status(201).json({ id: order.id, status: order.status, amountCents });
  });

  app.post('/api/rooms/:room/orders/:orderId/capture', limit('capture', 20), async (req, res) => {
    const room = withRoom(req);
    const rec = room.orders.get(String(req.params.orderId));
    if (!rec) throw new HttpError(404, 'order not found in this room');
    if (rec.certs.length) { res.json({ certs: rec.certs, order: { id: rec.orderId, status: rec.status, captureId: rec.captureId } }); return; }
    const cap = await paypal.captureOrder(rec.orderId, `mt-capture-${rec.orderId}`);
    rec.status = cap.status;
    rec.captureId = cap.captureId;
    if (cap.status !== 'COMPLETED' || cap.captureStatus !== 'COMPLETED' || cap.amountCents !== rec.amountCents) {
      throw new HttpError(402, `PayPal capture not completed (${cap.status}/${cap.captureStatus})`);
    }
    // PayPal has the money: sign one offline load certificate per funded wallet.
    rec.certs = issueCerts(rec);
    res.json({ certs: rec.certs, order: { id: rec.orderId, status: rec.status, captureId: rec.captureId } });
  });

  // ---- Sync: any phone uploads every voucher it has seen ----
  app.post('/api/rooms/:room/sync', limit('sync', 120), (req, res) => {
    const room = withRoom(req);
    const list: unknown = req.body?.vouchers;
    if (!Array.isArray(list) || list.length > 500) throw new HttpError(400, 'vouchers must be an array (max 500)');
    const via = typeof req.body?.via === 'string' ? req.body.via.slice(0, 24) : 'unknown';
    const shaped = list.filter(isVoucherShape);
    const invalid = shaped.filter((v) => !verifyVoucher(v).ok).length;
    const r = store.addVouchers(room, shaped, via);
    res.json({ ...r, invalid, rejectedShape: list.length - shaped.length });
  });

  // ---- Settlement ----
  app.post('/api/rooms/:room/settle', limit('settle', 10), (req, res) => {
    const room = withRoom(req);
    const run = settlement.startRun(room);
    res.status(202).json({ runId: run.id });
  });

  app.get('/api/rooms/:room/runs/:runId', (req, res) => {
    const room = withRoom(req);
    const run = room.runs.get(String(req.params.runId));
    if (!run) throw new HttpError(404, 'run not found');
    res.json({
      id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error,
      log: run.log,
      assessments: run.agent?.assessments ?? [],
      loadChecks: run.agent?.loadChecks ?? [],
      summary: run.agent?.summary ?? null,
      model: run.agent?.model ?? null,
      proposals: run.proposalIds.map((id) => room.proposals.get(id)).filter(Boolean),
      forks: (run.report?.payers ?? []).flatMap((p) => p.forks.map((f) => ({
        payer: p.payer, payerName: settlement.nameOf(room, p.payer), kind: f.kind,
        a: { payee: settlement.nameOf(room, f.a.payee), amount: f.a.amount, seq: f.a.seq },
        b: { payee: settlement.nameOf(room, f.b.payee), amount: f.b.amount, seq: f.b.seq },
      }))),
    });
  });

  app.post('/api/rooms/:room/proposals/:id/approve', limit('approve', 60), async (req, res) => {
    const room = withRoom(req);
    const approver = typeof req.body?.approver === 'string' ? req.body.approver.slice(0, 40) : 'demo approver';
    res.json(await settlement.approve(room, String(req.params.id), approver));
  });

  app.post('/api/rooms/:room/proposals/:id/reject', (req, res) => {
    const room = withRoom(req);
    const approver = typeof req.body?.approver === 'string' ? req.body.approver.slice(0, 40) : 'demo approver';
    res.json(settlement.reject(room, String(req.params.id), approver));
  });

  // ---- Ledger for the AG Grid console ----
  app.get('/api/rooms/:room/ledger', (req, res) => {
    const room = withRoom(req);
    const report = settlement.report(room);
    const proposalByHash = new Map<string, { id: string; status: string; batchId: string | null; paypalStatus: string | null }>();
    for (const p of room.proposals.values()) for (const h of p.voucherHashes) proposalByHash.set(h, p);
    const rows = report.verdicts.map((v) => {
      const p = proposalByHash.get(v.hash);
      const rec = room.vouchers.get(v.hash);
      return {
        id: v.hash,
        voucher: shortId(v.hash),
        payer: settlement.nameOf(room, v.voucher.payer),
        payee: settlement.nameOf(room, v.voucher.payee),
        amount: v.voucher.amount / 100,
        seq: v.voucher.seq,
        time: v.voucher.ts,
        syncedVia: rec?.via ?? '',
        protocolStatus: v.status,
        inFork: v.inFork,
        flags: v.reasons.join(', '),
        payoutStatus: p?.status ?? 'not proposed',
        paypalBatch: p?.batchId ?? '',
        paypalStatus: p?.paypalStatus ?? '',
      };
    });
    const payers = report.payers.map((p) => ({
      name: settlement.nameOf(room, p.payer), wallet: shortId(p.payer), loaded: p.cap / 100, spent: p.claimedTotal / 100,
      payable: (p.payableTotal + p.settledTotal) / 100, shortfall: p.uncoveredTotal / 100, forks: p.forks.length, frozen: p.frozen,
    }));
    res.json({ rows, payers, proposals: [...room.proposals.values()], orders: [...room.orders.values()].map(({ certs: _c, ...o }) => ({ ...o, wallets: o.allocations.map((a) => ({ name: settlement.nameOf(room, a.wallet), amount: a.amountCents / 100 })) })) });
  });

  // ---- PayPal webhooks (payout item status). Polling covers the case with no webhook. ----
  app.post('/api/webhooks/paypal', async (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    const ok = await paypal.verifyWebhook(headers, req.body).catch(() => false);
    if (!ok) { res.status(400).json({ error: 'webhook signature not verified' }); return; }
    const type = String(req.body?.event_type ?? '');
    const item = req.body?.resource;
    if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const found = store.findProposal(String(item?.payout_item?.sender_item_id ?? ''));
      if (found) settlement.applyItemStatus(found.proposal, String(item?.transaction_status ?? type.split('.').pop()));
    }
    res.json({ ok: true });
  });

  // ---- Static web app (Mesh Lab + console) ----
  const dist = cfg.webDist ?? path.resolve(process.cwd(), 'web/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: 'index.html' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => { res.sendFile(path.join(dist, 'index.html')); });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : 'internal error';
    console.error('[gateway]', message);
    res.status(status && status >= 400 && status < 600 ? 502 : 500).json({ error: message });
  });

  return app;
}

function isVoucherShape(v: unknown): v is Voucher {
  const x = v as Record<string, unknown>;
  return !!x && typeof x === 'object' && x.kind === 'voucher' && typeof x.payer === 'string' && typeof x.payee === 'string'
    && typeof x.sig === 'string' && typeof x.prev === 'string' && typeof x.memo === 'string'
    && [x.amount, x.seq, x.cum, x.ts].every((n) => typeof n === 'number');
}

/** Tiny fixed-window limiter per IP and route (enough for a public demo). */
function rateLimiter() {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, perMinute: number) => (req: Request, res: Response, next: NextFunction) => {
    const id = `${key}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(id);
    if (!h || h.reset < now) { hits.set(id, { n: 1, reset: now + 60_000 }); next(); return; }
    if (++h.n > perMinute) { res.status(429).json({ error: 'too many requests, wait a minute' }); return; }
    next();
  };
}
