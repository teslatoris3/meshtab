import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Looks up a PayPal order by ID and returns the raw order JSON. */
export type OrderLookup = (orderId: string) => Promise<unknown>;

export interface OrderTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  lookup: OrderLookup;
}

/**
 * Wraps the PayPal Agent Toolkit `get_order` tool so that Claude (through the Anthropic SDK)
 * can call it. The toolkit owns the PayPal auth and the HTTP call; we only adapt the schema.
 */
export function payPalToolkitOrderTool(opts: { clientId: string; clientSecret: string; sandbox: boolean }): OrderTool {
  // ponytail: a new toolkit for every lookup. Toolkit 1.11.0 fetches its OAuth token once and never renews it,
  // and PayPal tokens expire after about 9 hours (a long-running server then gets 401). Cost: one OAuth call per lookup.
  const getOrder = () => new PayPalAgentToolkit({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    configuration: { actions: { orders: { get: true } }, context: { sandbox: opts.sandbox } },
  }).getTools()['get_order'];
  const tool = getOrder();
  if (!tool?.execute) throw new Error('PayPal Agent Toolkit did not expose get_order');
  const { $schema: _ignored, ...schema } = zodToJsonSchema(tool.parameters as never) as Record<string, unknown>;
  return {
    name: 'paypal_get_order',
    description: (tool.description ?? 'Retrieve a PayPal order by ID.').trim(),
    inputSchema: schema as OrderTool['inputSchema'],
    lookup: async (orderId) => {
      const out = await getOrder()!.execute!({ id: orderId }, { toolCallId: `meshtab-${orderId}`, messages: [] });
      return typeof out === 'string' ? safeJson(out) : out;
    },
  };
}

/** Order tool for MOCK mode (no PayPal credentials). Same shape, local data. */
export function mockOrderTool(lookup: OrderLookup): OrderTool {
  return {
    name: 'paypal_get_order',
    description: 'Retrieves the order details from PayPal for a given order ID (MOCK mode: local simulated orders).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The order id generated during create call' } },
      required: ['id'],
      additionalProperties: false,
    },
    lookup,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Reduces a PayPal order to the fields the agent needs (keeps the LLM context small). */
export function summarizeOrder(order: unknown): { id: string; status: string; captureStatus: string | null; amountCents: number | null } {
  const o = (order ?? {}) as Record<string, any>;
  const unit = o.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const value = capture?.amount?.value ?? unit?.amount?.value;
  return {
    id: String(o.id ?? ''),
    status: String(o.status ?? o.error ?? 'UNKNOWN'),
    captureStatus: capture?.status ?? null,
    amountCents: value !== undefined ? Math.round(Number(value) * 100) : null,
  };
}
