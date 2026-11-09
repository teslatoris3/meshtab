import { generateKeyPair, isHex, publicKeyFromSecret } from '@meshtab/protocol';

export interface Config {
  port: number;
  paypalMode: 'sandbox' | 'mock';
  paypalClientId: string | null;
  paypalClientSecret: string | null;
  paypalWebhookId: string | null;
  gateway: { publicKey: string; secretKey: string; ephemeral: boolean };
  approvalLimitCents: number;
  maxLoadCents: number;
  anthropicConfigured: boolean;
  llmModel: string;
  llmEffort: 'low' | 'medium' | 'high';
  llmRunsPerDay: number;
  demoReceivers: Record<string, string>;
  webDist: string | null;
}

/** Reads configuration from environment variables. Secrets come only from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env.PAYPAL_CLIENT_ID?.trim() || null;
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() || null;
  const wanted = env.PAYPAL_MODE?.trim().toLowerCase();
  if (wanted === 'live') throw new Error('PAYPAL_MODE=live is not supported. MeshTab uses the PayPal sandbox only.');
  const paypalMode = wanted === 'mock' || !clientId || !clientSecret ? 'mock' : 'sandbox';

  let gateway: Config['gateway'];
  const sk = env.GATEWAY_SECRET_KEY?.trim().toLowerCase();
  if (sk && isHex(sk, 32)) {
    gateway = { secretKey: sk, publicKey: publicKeyFromSecret(sk), ephemeral: false };
  } else {
    const k = generateKeyPair();
    gateway = { ...k, ephemeral: true };
  }

  const effort = (env.LLM_EFFORT ?? 'low').toLowerCase();
  return {
    port: Number(env.PORT ?? 8787),
    paypalMode,
    paypalClientId: clientId,
    paypalClientSecret: clientSecret,
    paypalWebhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null,
    gateway,
    approvalLimitCents: Number(env.APPROVAL_LIMIT_CENTS ?? 2500),
    maxLoadCents: Number(env.MAX_LOAD_CENTS ?? 10000),
    anthropicConfigured: !!(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()),
    llmModel: env.LLM_MODEL?.trim() || 'claude-opus-5-5',
    llmEffort: effort === 'medium' || effort === 'high' ? effort : 'low',
    llmRunsPerDay: Number(env.LLM_RUNS_PER_DAY ?? 300),
    demoReceivers: parseReceivers(env.DEMO_PAYOUT_RECEIVERS),
    webDist: env.WEB_DIST ?? null,
  };
}

/** "Bob=sb-bob@personal.example.com,Carol=sb-carol@personal.example.com" -> { Bob: ..., Carol: ... } */
export function parseReceivers(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? '').split(',')) {
    const [name, email] = part.split('=').map((s) => s.trim());
    if (name && email && /^[^@\s]+@[^@\s]+$/.test(email)) out[name] = email;
  }
  return out;
}
