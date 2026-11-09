import { useEffect, useMemo, useState } from 'react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { api, type Ledger } from '../api';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({ accentColor: '#0b6bcb', fontSize: 13, headerFontWeight: 700, spacing: 6 });

type Row = Record<string, unknown>;

const statusStyle = (value: unknown) => {
  const v = String(value ?? '');
  if (['paid', 'payable', 'SUCCESS'].includes(v)) return { color: '#15803d', fontWeight: 700 };
  if (['uncovered', 'invalid', 'rejected', 'failed'].includes(v)) return { color: '#dc2626', fontWeight: 700 };
  if (['needs_approval', 'awaiting_details'].includes(v)) return { color: '#b45309', fontWeight: 700 };
  return null;
};

/** The organiser's ledger: every voucher, its protocol status, risk flags and PayPal payout state. */
export function Console({ room }: { room: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const l = await api.ledger(room);
        if (!stop) setLedger(l);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [room]);

  const voucherCols = useMemo<ColDef<Row>[]>(() => [
    { field: 'voucher', headerName: 'Voucher', width: 110, cellClass: 'mono' },
    { field: 'payer', width: 100, filter: true },
    { field: 'payee', width: 100, filter: true },
    { field: 'amount', headerName: 'USD', width: 90, valueFormatter: (p) => `$${Number(p.value).toFixed(2)}`, type: 'rightAligned' },
    { field: 'seq', width: 70 },
    { field: 'time', width: 110, valueFormatter: (p) => new Date(Number(p.value)).toLocaleTimeString() },
    { field: 'protocolStatus', headerName: 'Protocol', width: 120, cellStyle: (p) => statusStyle(p.value) },
    { field: 'inFork', headerName: 'Fork', width: 80, cellStyle: (p) => (p.value ? { color: '#dc2626', fontWeight: 700 } : null) },
    { field: 'flags', flex: 1, minWidth: 160 },
    { field: 'payoutStatus', headerName: 'Payout', width: 140, cellStyle: (p) => statusStyle(p.value) },
    { field: 'paypalBatch', headerName: 'PayPal batch', width: 150, cellClass: 'mono' },
    { field: 'paypalStatus', headerName: 'PayPal status', width: 120, cellStyle: (p) => statusStyle(p.value) },
    { field: 'syncedVia', headerName: 'Synced by', width: 110 },
  ], []);

  const payerCols = useMemo<ColDef<Row>[]>(() => [
    { field: 'name', width: 110 },
    { field: 'wallet', width: 110, cellClass: 'mono' },
    { field: 'loaded', headerName: 'Loaded (PayPal)', valueFormatter: (p) => `$${Number(p.value).toFixed(2)}`, width: 140 },
    { field: 'spent', headerName: 'Spent offline', valueFormatter: (p) => `$${Number(p.value).toFixed(2)}`, width: 130 },
    { field: 'payable', valueFormatter: (p) => `$${Number(p.value).toFixed(2)}`, width: 110 },
    { field: 'shortfall', valueFormatter: (p) => `$${Number(p.value).toFixed(2)}`, width: 110, cellStyle: (p) => (Number(p.value) > 0 ? { color: '#dc2626', fontWeight: 700 } : null) },
    { field: 'forks', width: 80 },
    { field: 'frozen', width: 90, cellStyle: (p) => (p.value ? { color: '#dc2626', fontWeight: 700 } : null) },
  ], []);

  const orderCols = useMemo<ColDef<Row>[]>(() => [
    { field: 'orderId', headerName: 'PayPal order', width: 200, cellClass: 'mono' },
    { field: 'status', width: 120, cellStyle: (p) => statusStyle(p.value === 'COMPLETED' ? 'paid' : p.value) },
    { field: 'amountCents', headerName: 'USD', valueFormatter: (p) => `$${(Number(p.value) / 100).toFixed(2)}`, width: 100 },
    { field: 'captureId', headerName: 'Capture', width: 200, cellClass: 'mono' },
    { colId: 'wallets', headerName: 'Funded wallets', flex: 1, valueGetter: (p) => ((p.data?.wallets as { name: string; amount: number }[]) ?? []).map((w) => `${w.name} $${w.amount.toFixed(2)}`).join(', ') },
  ], []);

  return (
    <div className="console">
      <div className="card">
        <h2>Voucher ledger</h2>
        <div className="hint">Every voucher uploaded by any phone. Protocol status comes from code (signatures, hash chains, escrow). Payout status comes from the PayPal Payouts API.</div>
        <div className="grid-wrap">
          <AgGridReact<Row> theme={theme} rowData={ledger?.rows ?? []} columnDefs={voucherCols} getRowId={(p) => String(p.data.id)} animateRows />
        </div>
      </div>
      <div className="card">
        <h2>Payers</h2>
        <div className="grid-wrap small">
          <AgGridReact<Row> theme={theme} rowData={ledger?.payers ?? []} columnDefs={payerCols} getRowId={(p) => String(p.data.wallet)} />
        </div>
      </div>
      <div className="card">
        <h2>PayPal top-ups (Orders v2)</h2>
        <div className="grid-wrap small">
          <AgGridReact<Row> theme={theme} rowData={ledger?.orders ?? []} columnDefs={orderCols} getRowId={(p) => String(p.data.orderId)} />
        </div>
      </div>
      {error && <div className="err">{error}</div>}
    </div>
  );
}
