import { useState } from 'react';
import { PayPalOneTimePaymentButton, PayPalProvider } from '@paypal/react-paypal-js/sdk-v6';
import { api, type ServerConfig } from '../api';
import type { MeshEngine } from '../sim/mesh';

/** The aid organiser's top-up before the storm (cents). Shops start empty and only receive. */
export const TOPUP: Record<string, number> = { alice: 3000, dave: 1500, eve: 2000 };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function TopUp({ cfg, room, engine, onDone }: {
  cfg: ServerConfig;
  room: string;
  engine: MeshEngine;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allocations = Object.entries(TOPUP).map(([id, amountCents]) => ({ wallet: engine.node(id).wallet.keys.publicKey, amountCents }));
  const total = allocations.reduce((s, a) => s + a.amountCents, 0);
  const disabled = !engine.internet;

  const createOrder = async () => {
    setError(null);
    const o = await api.createOrder(room, allocations);
    engine.log('paypal', `PayPal order ${o.id} created for ${money(o.amountCents)} (Orders v2, ${cfg.paypalMode}).`);
    return { orderId: o.id };
  };

  const capture = async (orderId: string) => {
    const r = await api.capture(room, orderId);
    engine.log('paypal', `PayPal captured the payment (order ${r.order.id}, ${r.order.status}). The money is held in escrow.`);
    engine.addCerts(r.certs);
    onDone();
  };

  const payByCard = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.payWithTestCard(room, allocations);
      engine.log('paypal', `PayPal order ${r.id} paid with a sandbox test card and captured (${r.order.status}). The money is held in escrow.`);
      engine.addCerts(r.certs);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="hint">
        One PayPal checkout of <b>{money(total)}</b> loads offline balances:{' '}
        {Object.entries(TOPUP).map(([id, c]) => `${engine.node(id).name} ${money(c)}`).join(', ')}.
      </div>
      {disabled && <div className="hint">Turn the internet on to pay with PayPal.</div>}
      {cfg.paypalMode === 'sandbox' && (
        <div style={{ marginBottom: 10 }}>
          <button className="btn primary" disabled={disabled || busy} onClick={payByCard}>
            {busy ? 'Paying...' : `Pay ${money(total)} with a PayPal sandbox test card (no login)`}
          </button>
          <div className="hint" style={{ marginTop: 6 }}>Real PayPal sandbox order, created and captured in one call. Or use the PayPal button below:</div>
        </div>
      )}
      {cfg.paypalMode === 'sandbox' && cfg.paypalClientId ? (
        <div style={{ maxWidth: 320, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
          <PayPalProvider clientId={cfg.paypalClientId} environment="sandbox" components={['paypal-payments']} pageType="checkout">
            <PayPalOneTimePaymentButton
              presentationMode="auto"
              createOrder={createOrder}
              onApprove={async ({ orderId }: { orderId: string }) => {
                await capture(orderId);
              }}
              onError={(e: unknown) => setError(e instanceof Error ? e.message : 'PayPal error')}
              onCancel={() => setError('Checkout cancelled.')}
            />
          </PayPalProvider>
          <div className="hint" style={{ marginTop: 6 }}>Needs a PayPal sandbox buyer login.</div>
        </div>
      ) : (
        <button
          className="btn primary"
          disabled={disabled || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { orderId } = await createOrder();
              await capture(orderId);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Pay {money(total)} with PayPal (MOCK mode)
        </button>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
