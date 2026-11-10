import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, type ServerConfig } from './api';
import { MeshCanvas } from './components/MeshCanvas';
import { Settlement } from './components/Settlement';
import { TopUp } from './components/TopUp';
import { MeshEngine, type SimNode } from './sim/mesh';

// AG Grid is large: load the console only when it is opened.
const Console = lazy(() => import('./components/Console').then((m) => ({ default: m.Console })));

const CAST: (Pick<SimNode, 'id' | 'name' | 'role' | 'x' | 'y'>)[] = [
  { id: 'alice', name: 'Alice', role: 'buyer', x: 140, y: 330 },
  { id: 'bob', name: 'Bob', role: 'shop', x: 290, y: 210 },
  { id: 'eve', name: 'Eve', role: 'evil', x: 300, y: 440 },
  { id: 'dave', name: 'Dave', role: 'relay', x: 500, y: 320 },
  { id: 'carol', name: 'Carol', role: 'shop', x: 720, y: 260 },
];
const DAVE_HOME = { x: 520, y: 590 };
const DAVE_MIDDLE = { x: 500, y: 320 };
const EVE_EAST = { x: 770, y: 430 };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tab = 'lab' | 'console';

export function App() {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const engineRef = useRef<MeshEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await api.config();
        const { roomId } = await api.createRoom();
        const engine = new MeshEngine(c.gatewayPublicKey);
        for (const p of CAST) {
          const email = c.demoReceivers[p.name] ?? (c.paypalMode === 'mock' ? `${p.id}@example.com` : null);
          engine.addNode({ ...p, payoutEmail: email });
        }
        engine.internet = true; // start online, before the storm (no log line)
        await Promise.all(
          [...engine.nodes.values()].map((n) =>
            api.registerWallet(roomId, { publicKey: n.wallet.keys.publicKey, name: n.name, payoutEmail: n.payoutEmail }),
          ),
        );
        if (cancelled) return;
        engineRef.current = engine;
        setCfg(c);
        setRoom(roomId);
      } catch (e) {
        if (!cancelled) setFatal(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (fatal) return <div className="card" style={{ margin: 24 }}>Could not start: {fatal}</div>;
  if (!cfg || !room || !engineRef.current) return <div className="hint" style={{ padding: 24 }}>Starting MeshTab...</div>;
  return <Lab cfg={cfg} room={room} engine={engineRef.current} />;
}

function Lab({ cfg, room, engine }: { cfg: ServerConfig; room: string; engine: MeshEngine }) {
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  const [tab, setTab] = useState<Tab>('lab');
  const [selected, setSelected] = useState<string | null>('alice');
  const [caption, setCaption] = useState<string | null>('Five phones in a town after a storm. Start with step 1: load balances with PayPal while the internet still works.');
  const [loaded, setLoaded] = useState(false);
  const [paidOnce, setPaidOnce] = useState(false);
  const [eveDone, setEveDone] = useState(false);
  const [synced, setSynced] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Animation loop for packets and walking phones.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      engine.step();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const quickPay = (from: string, to: string, cents: number, memo: string) => {
    setError(null);
    try {
      engine.pay(from, to, cents, memo);
      setPaidOnce(true);
      setCaption(`${engine.node(from).name} pays ${engine.node(to).name} ${money(cents)} offline. The voucher hops phone to phone over Bluetooth.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runEve = () => guard(async () => {
    if (engine.internet) engine.setInternet(false);
    setCaption('Dave walks home. The west and east markets lose their Bluetooth link.');
    await engine.moveTo('dave', DAVE_HOME.x, DAVE_HOME.y, 1600);
    await sleep(500);
    setCaption('Eve secretly saves a copy of her wallet, then pays Bob $15 for a battery.');
    engine.stash('eve');
    engine.pay('eve', 'bob', 1500, 'battery');
    await sleep(2400);
    setCaption('Eve walks to the east market, out of range of Bob.');
    await engine.moveTo('eve', EVE_EAST.x, EVE_EAST.y, 1800);
    await sleep(400);
    setCaption('Eve restores the old copy and pays Carol $15 with the SAME money. Carol cannot know yet. No offline system can stop this moment; MeshTab makes it provable.');
    engine.pay('eve', 'carol', 1500, 'medicine', { fromStash: true });
    await sleep(2800);
    setCaption('Dave walks back. Phones that meet sync their vouchers over Bluetooth...');
    await engine.moveTo('dave', DAVE_MIDDLE.x, DAVE_MIDDLE.y, 1600);
    await sleep(4200);
    setCaption("Dave's phone now holds both of Eve's vouchers: a signed proof of the double-spend. The proof floods the mesh and every phone refuses Eve. The money is sorted out when the internet returns.");
    setEveDone(true);
  });

  const goOnline = () => guard(async () => {
    engine.setInternet(true);
    const batches = engine.allKnown().filter((b) => b.vouchers.length > 0);
    engine.animateUpload(batches.map((b) => [...engine.nodes.values()].find((n) => n.name === b.via)!.id));
    let added = 0;
    let duplicates = 0;
    for (const b of batches) {
      const r = await api.sync(room, b.vouchers, b.via);
      added += r.added;
      duplicates += r.duplicates;
    }
    engine.log('online', `Phones uploaded their vouchers: ${added} new, ${duplicates} duplicates ignored. Any phone can carry anyone's vouchers.`);
    setCaption('Back online. Every phone uploaded what it saw. Now the AI settlement agent checks PayPal and explains the risks.');
    setSynced(true);
  });

  const settle = () => guard(async () => {
    const r = await api.settle(room);
    setRunId(r.runId);
    setCaption('The settlement agent is running: code checks every signature and chain, Claude checks the PayPal orders with the PayPal Agent Toolkit and explains each risk.');
  });

  const steps = [
    { title: 'Load balances with PayPal', done: loaded },
    { title: 'The internet goes down', done: loaded && !engine.internet || paidOnce || eveDone },
    { title: 'Pay offline over the Bluetooth mesh', done: paidOnce },
    { title: 'Evil Eve tries a double-spend', done: eveDone },
    { title: 'Back online: sync and AI settlement', done: !!runId },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <>
      <header className="top">
        <div className="brand">
          <img src="icon.svg" width={28} height={28} alt="" />
          MeshTab <small>offline community payments</small>
        </div>
        <nav className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === 'lab'} onClick={() => setTab('lab')}>Mesh Lab</button>
          <button className="tab" role="tab" aria-selected={tab === 'console'} onClick={() => setTab('console')}>Ledger console</button>
        </nav>
        <div className="badges">
          <span className={`badge ${cfg.paypalMode === 'sandbox' ? 'live' : ''}`}>PayPal {cfg.paypalMode}</span>
          <span className={`badge ${cfg.ai.enabled ? 'live' : ''}`}>{cfg.ai.enabled ? `AI: ${cfg.ai.model}` : 'AI: rule-based fallback'}</span>
          <span className="badge">approval limit {money(cfg.approvalLimitCents)}</span>
        </div>
      </header>

      {tab === 'console' ? (
        <Suspense fallback={<div className="hint" style={{ padding: 24 }}>Loading the ledger console...</div>}>
          <Console room={room} />
        </Suspense>
      ) : (
        <main className="lab">
          <div className="col">
            <MeshCanvas engine={engine} selected={selected} onSelect={setSelected} caption={caption} />
            <div className="card">
              <h2>What the phones see</h2>
              <div className="hint">Tip: drag phones on the map to move them in and out of Bluetooth range. Lines show live links.</div>
              <ul className="feed" aria-live="polite">
                {engine.events.map((e) => (
                  <li key={e.id} className={e.kind}>
                    <span className="k">{e.kind}</span>
                    <span>{e.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="col">
            <div className="card">
              <h2>Demo story</h2>
              <ol className="steps">
                <Step n={1} title={steps[0]!.title} state={stateOf(0, current, steps)}>
                  <p>Before the storm, an aid organiser pays once with PayPal. The gateway signs a balance certificate for each phone, so phones can check balances later with no internet.</p>
                  <div className="actions">
                    <TopUp cfg={cfg} room={room} engine={engine} onDone={() => {
                      setLoaded(true);
                      setCaption('PayPal holds the money in escrow. Each phone now carries a signed balance certificate. Next: the internet goes down.');
                    }} />
                  </div>
                </Step>
                <Step n={2} title={steps[1]!.title} state={stateOf(1, current, steps)}>
                  <p>A blackout. No mobile data, no bank, no card terminal. Phones can still talk over Bluetooth.</p>
                  <div className="actions">
                    <button className="btn" disabled={!engine.internet} onClick={() => { engine.setInternet(false); setCaption('Blackout. From now on, phones only talk to phones that are in Bluetooth range.'); }}>
                      Cut the internet
                    </button>
                  </div>
                </Step>
                <Step n={3} title={steps[2]!.title} state={stateOf(2, current, steps)} keepOpen>
                  <p>Each payment is an Ed25519-signed voucher in the payer's hash chain. The shop checks the signature and the balance certificate offline.</p>
                  <div className="actions">
                    <button className="btn" disabled={!loaded} onClick={() => quickPay('alice', 'bob', 800, 'water')}>Alice pays Bob $8 (1 hop)</button>
                    <button className="btn" disabled={!loaded} onClick={() => quickPay('alice', 'carol', 1200, 'medicine')}>Alice pays Carol $12 (3 hops)</button>
                  </div>
                </Step>
                <Step n={4} title={steps[3]!.title} state={stateOf(3, current, steps)}>
                  <p>Eve copies her wallet and spends the same $15 twice, in two places that cannot hear each other.</p>
                  <div className="actions">
                    <button className="btn danger" disabled={!loaded || busy || eveDone} onClick={runEve}>Run Evil Eve</button>
                  </div>
                </Step>
                <Step n={5} title={steps[4]!.title} state={stateOf(4, current, steps)} keepOpen>
                  <p>Any phone with internet uploads every voucher it carries. Code settles; Claude explains; people approve; PayPal pays out.</p>
                  <div className="actions">
                    <button className="btn" disabled={busy || (engine.internet && synced)} onClick={goOnline}>Restore internet and sync</button>
                    <button className="btn primary" disabled={busy || !synced} onClick={settle}>Run AI settlement</button>
                  </div>
                </Step>
              </ol>
              {error && <div className="err">{error}</div>}
            </div>

            {runId && (
              <div className="card">
                <h2>Settlement</h2>
                <Settlement
                  key={runId}
                  cfg={cfg}
                  room={room}
                  runId={runId}
                  onFinished={(r) => {
                    const waiting = r.proposals.filter((p) => p.status === 'needs_approval').length;
                    setCaption(`Settlement done. Clean payouts went straight to PayPal${waiting ? `; ${waiting} payout(s) wait for a human decision in the panel on the right` : ''}.`);
                  }}
                />
                <div className="actions" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={settle} disabled={busy}>Run settlement again</button>
                  <button className="btn" onClick={() => setTab('console')}>Open ledger console</button>
                </div>
              </div>
            )}

            <People engine={engine} selected={selected} onSelect={setSelected} onPaid={() => setPaidOnce(true)} />
          </div>
        </main>
      )}
      <footer>
        MeshTab is open source (GPL-3.0). Sandbox money only. Built for the PayPal AI Hackathon with PayPal Orders v2, Payouts, the PayPal Agent Toolkit and Anthropic Claude.
      </footer>
    </>
  );
}

function stateOf(i: number, current: number, steps: { done: boolean }[]): 'done' | 'current' | 'todo' {
  if (steps[i]!.done) return 'done';
  return i === current ? 'current' : 'todo';
}

function Step({ n, title, state, keepOpen, children }: {
  n: number;
  title: string;
  state: 'done' | 'current' | 'todo';
  keepOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={`step ${state}`}>
      <div className="step-head">
        <span className="num">{state === 'done' ? '✓' : n}</span>
        {title}
      </div>
      {(state !== 'done' || keepOpen) && children}
    </li>
  );
}

function People({ engine, selected, onSelect, onPaid }: { engine: MeshEngine; selected: string | null; onSelect: (id: string) => void; onPaid: () => void }) {
  const nodes = [...engine.nodes.values()];
  const me = selected ? engine.nodes.get(selected) : undefined;
  const [to, setTo] = useState('bob');
  const [amount, setAmount] = useState('5.00');
  const [error, setError] = useState<string | null>(null);
  const eveKey = engine.nodes.get('eve')?.wallet.keys.publicKey;

  return (
    <div className="card">
      <h2>Phones</h2>
      <div className="people">
        {nodes.map((n) => (
          <button key={n.id} className="person" aria-pressed={selected === n.id} onClick={() => onSelect(n.id)}>
            <div className="name">
              {n.name}
              {n.id === 'eve' && nodes.some((x) => x.id !== 'eve' && x.blacklist.has(n.wallet.keys.publicKey)) && <span className="chip bad">blocked</span>}
              {n.id !== 'eve' && eveKey && n.blacklist.has(eveKey) && <span className="chip warn">has proof</span>}
            </div>
            <div className="row"><span>wallet</span><span>{money(engine.balance(n.id))}</span></div>
            <div className="row"><span>received</span><span>{money(engine.receivedTotal(n.id))}</span></div>
            <div className="row"><span>vouchers seen</span><span>{n.known.size}</span></div>
          </button>
        ))}
      </div>
      {me && (
        <div className="payform">
          <b>{me.name}</b> pays
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Payee">
            {nodes.filter((n) => n.id !== me.id).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in dollars" />
          <button
            className="btn primary"
            disabled={to === me.id}
            onClick={() => {
              setError(null);
              try {
                engine.pay(me.id, to, Math.round(Number(amount) * 100), 'manual');
                onPaid();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Pay offline
          </button>
        </div>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
