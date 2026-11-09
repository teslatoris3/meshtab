import { randomBytes } from 'node:crypto';

export interface CreatedOrder { id: string; status: string }
export interface CapturedOrder { id: string; status: string; captureId: string | null; captureStatus: string | null; amountCents: number | null }
export interface PayoutItemInput { senderItemId: string; receiver: string; amountCents: number; note: string }
export interface PayoutBatch { batchId: string; status: string; items: { senderItemId: string; itemId: string | null; status: string }[] }

/** The PayPal REST calls the gateway needs. Two implementations: sandbox (real HTTP) and mock. */
export interface PayPalApi {
  readonly mode: 'sandbox' | 'mock';
  createOrder(args: { amountCents: number; customId: string; description: string; requestId: string }): Promise<CreatedOrder>;
  captureOrder(orderId: string, requestId: string): Promise<CapturedOrder>;
  getOrder(orderId: string): Promise<unknown>;
  createPayout(args: { senderBatchId: string; items: PayoutItemInput[] }): Promise<PayoutBatch>;
  getPayoutBatch(batchId: string): Promise<PayoutBatch>;
  verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean>;
}

const toValue = (cents: number) => (cents / 100).toFixed(2);
const toCents = (value: unknown) => (value === undefined || value === null ? null : Math.round(Number(value) * 100));

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly details: unknown) {
    super(message);
  }
}

/** Real PayPal REST API (sandbox host only: this project never touches live money). */
export class SandboxPayPal implements PayPalApi {
  readonly mode = 'sandbox' as const;
  private readonly base = 'https://api-m.sandbox.paypal.com';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly webhookId?: string) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new PayPalError('PayPal OAuth failed', res.status, body);
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} failed (${res.status})`, res.status, json);
    return json as T;
  }

  async createOrder(a: { amountCents: number; customId: string; description: string; requestId: string }): Promise<CreatedOrder> {
    const o = await this.call<any>('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [
        { custom_id: a.customId, description: a.description, amount: { currency_code: 'USD', value: toValue(a.amountCents) } },
      ],
      payment_source: {
        paypal: { experience_context: { brand_name: 'MeshTab', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } },
      },
    }, a.requestId);
    return { id: o.id, status: o.status };
  }

  async captureOrder(orderId: string, requestId: string): Promise<CapturedOrder> {
    const o = await this.call<any>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
    const c = o.purchase_units?.[0]?.payments?.captures?.[0];
    return { id: o.id, status: o.status, captureId: c?.id ?? null, captureStatus: c?.status ?? null, amountCents: toCents(c?.amount?.value) };
  }

  getOrder(orderId: string): Promise<unknown> {
    return this.call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  async createPayout(a: { senderBatchId: string; items: PayoutItemInput[] }): Promise<PayoutBatch> {
    const r = await this.call<any>('POST', '/v1/payments/payouts', {
      sender_batch_header: {
        sender_batch_id: a.senderBatchId,
        email_subject: 'MeshTab settlement',
        email_message: 'Money you received offline with MeshTab has been settled to your PayPal account.',
      },
      items: a.items.map((i) => ({
        recipient_type: 'EMAIL',
        receiver: i.receiver,
        amount: { value: toValue(i.amountCents), currency: 'USD' },
        note: i.note,
        sender_item_id: i.senderItemId,
      })),
    }, a.senderBatchId);
    return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status, items: a.items.map((i) => ({ senderItemId: i.senderItemId, itemId: null, status: 'PENDING' })) };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatch> {
    const r = await this.call<any>('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    return {
      batchId,
      status: r.batch_header?.batch_status ?? 'UNKNOWN',
      items: (r.items ?? []).map((it: any) => ({
        senderItemId: it.payout_item?.sender_item_id,
        itemId: it.payout_item_id ?? null,
        status: it.transaction_status ?? 'UNKNOWN',
      })),
    };
  }

  async verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
    if (!this.webhookId) return false;
    const r = await this.call<any>('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: this.webhookId,
      webhook_event: event,
    });
    return r.verification_status === 'SUCCESS';
  }
}

/** In-memory PayPal for tests and for running with no credentials. Never moves money. */
export class MockPayPal implements PayPalApi {
  readonly mode = 'mock' as const;
  private orders = new Map<string, { id: string; status: string; amountCents: number; captureId?: string }>();
  private batches = new Map<string, { createdAt: number; items: PayoutItemInput[] }>();

  private id(prefix: string, len = 17) {
    return (prefix + randomBytes(16).toString('hex').toUpperCase()).slice(0, len);
  }

  async createOrder(a: { amountCents: number }): Promise<CreatedOrder> {
    const id = this.id('MOCK');
    this.orders.set(id, { id, status: 'CREATED', amountCents: a.amountCents });
    return { id, status: 'CREATED' };
  }

  async captureOrder(orderId: string): Promise<CapturedOrder> {
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalError('order not found', 404, { name: 'RESOURCE_NOT_FOUND' });
    o.status = 'COMPLETED';
    o.captureId ??= this.id('CAP');
    return { id: o.id, status: o.status, captureId: o.captureId, captureStatus: 'COMPLETED', amountCents: o.amountCents };
  }

  async getOrder(orderId: string): Promise<unknown> {
    const o = this.orders.get(orderId);
    if (!o) return { name: 'RESOURCE_NOT_FOUND', status: 'NOT_FOUND' };
    return {
      id: o.id,
      status: o.status,
      purchase_units: [{
        amount: { currency_code: 'USD', value: toValue(o.amountCents) },
        payments: o.captureId ? { captures: [{ id: o.captureId, status: 'COMPLETED', amount: { currency_code: 'USD', value: toValue(o.amountCents) } }] } : undefined,
      }],
    };
  }

  async createPayout(a: { senderBatchId: string; items: PayoutItemInput[] }): Promise<PayoutBatch> {
    const batchId = this.id('MOCKBATCH', 13);
    this.batches.set(batchId, { createdAt: Date.now(), items: a.items });
    return { batchId, status: 'PENDING', items: a.items.map((i) => ({ senderItemId: i.senderItemId, itemId: null, status: 'PENDING' })) };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatch> {
    const b = this.batches.get(batchId);
    if (!b) throw new PayPalError('batch not found', 404, {});
    const done = Date.now() - b.createdAt > 1500;
    return {
      batchId,
      status: done ? 'SUCCESS' : 'PROCESSING',
      items: b.items.map((i, n) => ({ senderItemId: i.senderItemId, itemId: `MOCKITEM${n}`, status: done ? 'SUCCESS' : 'PENDING' })),
    };
  }

  async verifyWebhook(): Promise<boolean> {
    return false;
  }
}
