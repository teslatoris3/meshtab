import { createClaudeClient, mockOrderTool, payPalToolkitOrderTool } from '@meshtab/agent';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { MockPayPal, SandboxPayPal, type PayPalApi } from './paypal.js';
import { SettlementService } from './settlement.js';
import { Store } from './store.js';

const cfg = loadConfig();
const paypal: PayPalApi = cfg.paypalMode === 'sandbox'
  ? new SandboxPayPal(cfg.paypalClientId!, cfg.paypalClientSecret!, cfg.paypalWebhookId ?? undefined)
  : new MockPayPal();
const orderTool = cfg.paypalMode === 'sandbox'
  ? payPalToolkitOrderTool({ clientId: cfg.paypalClientId!, clientSecret: cfg.paypalClientSecret!, sandbox: true })
  : mockOrderTool((id) => paypal.getOrder(id));
const anthropic = createClaudeClient()?.client ?? null;

const store = new Store();
const settlement = new SettlementService(cfg, store, paypal, orderTool, anthropic);
const app = createApp({ cfg, store, paypal, settlement });

app.listen(cfg.port, () => {
  console.log(`[gateway] MeshTab listening on :${cfg.port}`);
  console.log(`[gateway] PayPal: ${paypal.mode}${paypal.mode === 'mock' ? ' (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for sandbox)' : ''}`);
  console.log(`[gateway] AI: ${anthropic ? `${cfg.llmModel} via ${cfg.llmProvider} (effort ${cfg.llmEffort})` : 'off (set ANTHROPIC_API_KEY); rule-based fallback'}`);
  if (cfg.gateway.ephemeral) console.warn('[gateway] GATEWAY_SECRET_KEY not set: using a temporary key. Load certificates become invalid on restart.');
});
