import { useEffect, useState } from 'react';
import { api, type Proposal, type RunView, type ServerConfig } from '../api';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const STATUS: Record<string, { label: string; cls: string }> = {
  auto_approved: { label: 'auto-approved', cls: 'info' },
  needs_approval: { label: 'needs a human', cls: 'warn' },
  awaiting_details: { label: 'no PayPal email', cls: 'warn' },
  approved: { label: 'approved', cls: 'info' },
  processing: { label: 'PayPal processing', cls: 'info' },
  paid: { label: 'paid with PayPal', cls: 'good' },
  rejected: { label: 'rejected', cls: 'bad' },
  failed: { label: 'payout failed', cls: 'bad' },
};

const REASON: Record<string, string> = {
  escrow_exhausted: "not covered by the payer's PayPal balance",
  fork_involved: 'part of a double-spend',
  over_approval_limit: 'above the approval limit',
};

function reasonText(r: string): string {
  const [key, who] = r.split(':');
  if (key && REASON[key]) return REASON[key]!;
  if (key === 'payer_frozen') return `${who} is frozen`;
  if (key === 'ai_hold') return `AI agent asked for a human check on ${who}`;
  if (key === 'paypal_load_unverified') return `${who}'s PayPal load could not be verified`;
  return r;
}

export function Settlement({ cfg, room, runId, onFinished }: {
  cfg: ServerConfig;
  room: string;
  runId: string;
  onFinished?: (run: RunView) => void;
}) {
  const [run, setRun] = useState<RunView | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(true);

  useEffect(() => {
    let stop = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api.run(room, runId);
        if (stop) return;
        setRun(r);
        if (r.status !== 'running' && !finished) {
          finished = true;
          onFinished?.(r);
        }
        let mine: Proposal[] = [];
        if (r.status !== 'running') {
          const ledger = await api.ledger(room);
          if (stop) return;
          const ids = new Set(r.proposals.map((p) => p.id));
          mine = ledger.proposals.filter((p) => ids.has(p.id));
          setProposals(mine);
        }
        const pending = r.status === 'running' || mine.some((p) => p.status === 'processing' || p.status === 'approved');
        timer = setTimeout(tick, pending ? 800 : 2500);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, runId]);

  const act = async (p: Proposal, kind: 'approve' | 'reject') => {
    setActing(p.id);
    setError(null);
    try {
      const updated = kind === 'approve' ? await api.approve(room, p.id) : await api.reject(room, p.id);
      setProposals((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  };

  if (!run) return <div className="hint">Starting the settlement agent...</div>;

  return (
    <div>
      <div className="hint">
        {run.model ? (
          <>AI agent: <b>{run.model}</b> (Anthropic Claude) with the PayPal Agent Toolkit. </>
        ) : run.status === 'running' ? (
          <>AI settlement agent is running. </> // run.model is only known when the run ends
        ) : (
          <>AI agent offline: rule-based explanations. </>
        )}
        Code decides validity; the AI explains, scores risk and can only add holds.
      </div>

      {run.status === 'running' && <div className="summary">The agent is checking PayPal orders and scoring risk...</div>}
      {run.status === 'failed' && <div className="err">Settlement failed: {run.error}</div>}
      {run.summary && <div className="summary">{run.summary}</div>}

      {run.forks.length > 0 && (
        <>
          <h3>Double-spend proofs</h3>
          {run.forks.map((f, i) => (
            <div key={i} className="hint">
              <span className="chip bad">fork</span> {f.payerName} signed {money(f.a.amount)} to {f.a.payee} and {money(f.b.amount)} to {f.b.payee} from the same balance.
            </div>
          ))}
        </>
      )}

      {run.assessments.length > 0 && <h3>AI risk assessment</h3>}
      {run.assessments.map((a) => (
        <div key={a.payer} className={`assess ${a.recommendation === 'hold' ? 'hold' : ''}`}>
          <div className="assess-head">
            {a.name}
            <span className={`chip ${a.recommendation === 'hold' ? 'bad' : 'good'}`}>{a.recommendation === 'hold' ? 'hold' : 'ok to pay'}</span>
            <div className="risk" title={`risk ${a.riskScore}/100`}><span style={{ width: `${a.riskScore}%` }} /></div>
            <span className="chip">{a.riskScore}/100 · {a.source === 'llm' ? 'Claude' : 'rules'}</span>
          </div>
          <p>{a.explanation}</p>
        </div>
      ))}

      {run.loadChecks.length > 0 && (
        <>
          <h3>PayPal loads checked</h3>
          <div className="checks">
            {run.loadChecks.map((c) => (
              <div key={c.orderId}>
                <span className={`chip ${c.matches ? 'good' : 'bad'}`}>{c.matches ? 'verified' : 'mismatch'}</span>{' '}
                <span className="mono">{c.orderId}</span> {c.status}
                {c.amountCents != null ? ` · ${money(c.amountCents)}` : ''} · {c.checkedBy === 'agent' ? 'by AI agent (PayPal Agent Toolkit get_order)' : 'by code'}
              </div>
            ))}
          </div>
        </>
      )}

      {proposals.length > 0 && (
        <>
          <h3>Payouts (PayPal Payouts API, {cfg.paypalMode})</h3>
          <div>
            {proposals.map((p) => {
              const s = STATUS[p.status] ?? { label: p.status, cls: '' };
              return (
                <div key={p.id} className="proposal">
                  <div className="who">
                    {money(p.amountCents)} to {p.payeeName} {p.kind === 'shortfall' && <span className="chip warn">shortfall</span>}
                  </div>
                  <div className="acts">
                    <span className={`chip ${s.cls}`}>{s.label}</span>
                    {(p.status === 'needs_approval' || p.status === 'failed') && (
                      <>
                        <button className="btn good" disabled={acting === p.id} onClick={() => act(p, 'approve')}>
                          {p.kind === 'shortfall' ? 'Cover from pool' : 'Approve'}
                        </button>
                        {p.status === 'needs_approval' && (
                          <button className="btn" disabled={acting === p.id} onClick={() => act(p, 'reject')}>Reject</button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="why">
                    {p.voucherHashes.length} voucher(s){p.receiver ? ` → ${p.receiver}` : ''}
                    {p.reasons.length > 0 && ` · ${p.reasons.map(reasonText).join('; ')}`}
                    {p.batchId && <> · batch <span className="mono">{p.batchId}</span>{p.paypalStatus ? ` (${p.paypalStatus})` : ''}</>}
                    {p.error && <span className="err"> · {p.error}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {error && <div className="err">{error}</div>}

      <h3>
        Agent log{' '}
        <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? 'hide' : 'show'}</button>
      </h3>
      {showLog && (
        <div className="log">
          {run.log.map((l, i) => (
            <div key={i} className={l.kind}>
              {new Date(l.at).toLocaleTimeString()} · {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
