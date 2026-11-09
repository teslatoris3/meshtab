import { useRef } from 'react';
import { HOP_MS, RANGE, type MeshEngine, type SimNode } from '../sim/mesh';

const W = 1000;
const H = 640;
const CLOUD = { x: 500, y: 34 };
const ROLE_COLOR: Record<SimNode['role'], string> = { buyer: '#38bdf8', shop: '#34d399', relay: '#a78bfa', evil: '#f472b6' };
const FLIGHT_COLOR = { payment: '#fbbf24', fork_proof: '#ef4444', sync: '#a78bfa', upload: '#22c55e' } as const;
const ROLE_LABEL: Record<string, string> = { alice: 'family', bob: 'water stall', carol: 'pharmacy', dave: 'neighbour', eve: 'cheater' };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function MeshCanvas({ engine, selected, onSelect, caption }: {
  engine: MeshEngine;
  selected: string | null;
  onSelect: (id: string) => void;
  caption: string | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string } | null>(null);
  const nodes = [...engine.nodes.values()];
  const now = performance.now();
  const eve = engine.nodes.get('eve');
  const eveBlocked = !!eve && nodes.some((n) => n.id !== 'eve' && n.blacklist.has(eve.wallet.keys.publicKey));

  const toSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: Math.max(30, Math.min(W - 30, p.x)), y: Math.max(70, Math.min(H - 40, p.y)) };
  };

  const pos = (id: string) => (id === '__cloud__' ? CLOUD : engine.node(id));

  return (
    <div className={`stage ${engine.internet ? 'online' : ''}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Simulated Bluetooth mesh of five phones"
        onPointerMove={(e) => {
          if (!drag.current) return;
          const p = toSvg(e);
          engine.setPosition(drag.current.id, p.x, p.y);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerLeave={() => { drag.current = null; }}
      >
        <defs>
          <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" fill="#1e293b" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#dots)" />
        <text x={150} y={610} fill="#334155" fontSize="15" fontWeight={700} letterSpacing="2">WEST MARKET</text>
        <text x={700} y={610} fill="#334155" fontSize="15" fontWeight={700} letterSpacing="2">EAST MARKET</text>

        {engine.internet && (
          <g>
            {nodes.map((n) => (
              <line key={`net-${n.id}`} x1={n.x} y1={n.y} x2={CLOUD.x} y2={CLOUD.y} stroke="#22c55e" strokeOpacity={0.25} strokeDasharray="4 6" />
            ))}
            <g transform={`translate(${CLOUD.x - 70}, ${CLOUD.y - 18})`}>
              <rect width={140} height={36} rx={18} fill="#052e1a" stroke="#22c55e" />
              <text x={70} y={23} textAnchor="middle" fill="#bbf7d0" fontSize="13" fontWeight={700}>MeshTab gateway</text>
            </g>
          </g>
        )}

        {selected && engine.nodes.has(selected) && (
          <circle
            cx={engine.node(selected).x}
            cy={engine.node(selected).y}
            r={RANGE}
            fill="#38bdf8"
            fillOpacity={0.05}
            stroke="#38bdf8"
            strokeOpacity={0.35}
            strokeDasharray="6 6"
          />
        )}

        {engine.linkList().map(([a, b]) => {
          const na = engine.node(a);
          const nb = engine.node(b);
          return <line key={`${a}-${b}`} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke="#38bdf8" strokeOpacity={0.45} strokeWidth={2} />;
        })}

        {engine.flights.map((f) => {
          if (now < f.start) return null;
          const t = Math.max(0, Math.min(1, (now - f.start) / HOP_MS));
          const a = pos(f.from);
          const b = pos(f.to);
          return (
            <circle
              key={f.id}
              cx={a.x + (b.x - a.x) * t}
              cy={a.y + (b.y - a.y) * t}
              r={f.kind === 'fork_proof' ? 8 : 6}
              fill={FLIGHT_COLOR[f.kind]}
              stroke="#0b1220"
              strokeWidth={2}
            />
          );
        })}

        {nodes.map((n) => {
          const blocked = n.id === 'eve' && eveBlocked;
          const balance = engine.balance(n.id);
          const received = engine.receivedTotal(n.id);
          const parts: string[] = [];
          if (balance > 0 || n.role !== 'shop') parts.push(`wallet ${money(balance)}`);
          if (received > 0) parts.push(`got ${money(received)}`);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                drag.current = { id: n.id };
                onSelect(n.id);
              }}
            >
              {blocked && <circle r={40} fill="none" stroke="#ef4444" strokeWidth={3} strokeDasharray="5 4" />}
              <circle r={28} fill="#0f172a" stroke={selected === n.id ? '#f8fafc' : ROLE_COLOR[n.role]} strokeWidth={selected === n.id ? 4 : 3} />
              <rect x={-9} y={-15} width={18} height={30} rx={4} fill="none" stroke={ROLE_COLOR[n.role]} strokeWidth={2} />
              <circle cy={10} r={1.8} fill={ROLE_COLOR[n.role]} />
              <text y={-38} textAnchor="middle" fill="#f8fafc" fontSize="16" fontWeight={700}>{n.name}</text>
              <text y={47} textAnchor="middle" fill="#94a3b8" fontSize="12">{ROLE_LABEL[n.id] ?? n.role}</text>
              <text y={63} textAnchor="middle" fill="#e2e8f0" fontSize="12">{parts.join(' · ')}</text>
              {blocked && <text y={80} textAnchor="middle" fill="#fca5a5" fontSize="12" fontWeight={700}>BLOCKED BY MESH</text>}
            </g>
          );
        })}
      </svg>
      <div className="stage-bar">
        <span className="status-pill">
          <span className={`dot ${engine.internet ? 'on' : ''}`} />
          {engine.internet ? 'Internet: on' : 'Internet: down (blackout)'}
        </span>
      </div>
      {caption && <div className="caption" role="status">{caption}</div>}
    </div>
  );
}
