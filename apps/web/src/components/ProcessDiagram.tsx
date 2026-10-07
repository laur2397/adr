/**
 * Process diagram drawn from a definition: steps laid out in columns by distance from the start
 * (longest forward path), forward edges as curves, returns as dashed arcs below.
 */
interface FlowStep {
  key: string;
  name: string;
  type: string;
  paths?: Array<{ key: string; label: string; to: string; kind?: string }>;
  branches?: Array<{ to: string }>;
  next?: string;
}

interface Edge {
  from: string;
  to: string;
  label: string;
  kind: string;
}

const W = 168;
const H = 54;
const GAP_X = 70;
const GAP_Y = 26;

function edgesOf(steps: FlowStep[]): Edge[] {
  const out: Edge[] = [];
  for (const s of steps) {
    for (const p of s.paths ?? []) out.push({ from: s.key, to: p.to, label: p.label, kind: p.kind ?? 'forward' });
    for (const b of s.branches ?? []) out.push({ from: s.key, to: b.to, label: '', kind: 'forward' });
    if (s.next) out.push({ from: s.key, to: s.next, label: '', kind: 'forward' });
  }
  return out;
}

function layout(steps: FlowStep[], edges: Edge[]) {
  const level = new Map<string, number>();
  const start = steps.find((s) => s.type === 'start') ?? steps[0];
  if (!start) return { pos: new Map<string, { x: number; y: number }>(), width: 0, height: 0 };
  // Longest-path levels over forward edges (returns ignored), bounded to avoid cycles.
  level.set(start.key, 0);
  for (let iter = 0; iter < steps.length; iter++) {
    let changed = false;
    for (const e of edges) {
      if (e.kind === 'return') continue;
      const l = level.get(e.from);
      if (l === undefined) continue;
      if ((level.get(e.to) ?? -1) < l + 1 && l + 1 < steps.length) {
        level.set(e.to, l + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const s of steps) if (!level.has(s.key)) level.set(s.key, 0);
  const columns = new Map<number, string[]>();
  for (const s of steps) {
    const l = level.get(s.key)!;
    columns.set(l, [...(columns.get(l) ?? []), s.key]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  for (const [l, keys] of columns) {
    maxRows = Math.max(maxRows, keys.length);
    keys.forEach((k, i) => pos.set(k, { x: 20 + l * (W + GAP_X), y: 20 + i * (H + GAP_Y) }));
  }
  const width = 40 + columns.size * (W + GAP_X) - GAP_X;
  const height = 40 + maxRows * (H + GAP_Y) + 40;
  return { pos, width, height };
}

const TYPE_LABEL: Record<string, string> = {
  start: 'început',
  human: 'pas uman',
  system: 'automat',
  decision: 'decizie',
  parallel_split: 'ramificare',
  parallel_join: 'reunire',
  subflow: 'sub-flux',
  end_positive: 'final',
  end_negative: 'final negativ',
};

export function ProcessDiagram({ steps, states = {} }: { steps: FlowStep[]; states?: Record<string, 'current' | 'done' | 'pending' | 'skipped'> }) {
  const edges = edgesOf(steps);
  const { pos, width, height } = layout(steps, edges);
  return (
    <div className="table-wrap" style={{ border: '1px solid var(--c-border)', borderRadius: 6, background: '#fff' }}>
      <svg width={width} height={height} role="img" aria-label="Diagrama procesului" style={{ display: 'block', fontFamily: 'inherit' }}>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#6b7480" />
          </marker>
          <marker id="arr-ret" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#b45309" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          if (!pos.has(e.from) || !pos.has(e.to)) return null;
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          if (e.kind === 'return' || b.x <= a.x) {
            // return: dashed arc under the boxes
            const x1 = a.x + W / 2;
            const x2 = b.x + W / 2;
            const y = Math.max(a.y, b.y) + H;
            const dip = 26 + (i % 3) * 8;
            return (
              <g key={i}>
                <path d={`M${x1},${a.y + H} C${x1},${y + dip} ${x2},${y + dip} ${x2},${b.y + H + 2}`} fill="none" stroke="#b45309" strokeDasharray="5 4" strokeWidth="1.3" markerEnd="url(#arr-ret)" />
                <title>{`Returnare: ${e.label}`}</title>
              </g>
            );
          }
          const s = { x: a.x + W, y: a.y + H / 2 };
          const t = { x: b.x, y: b.y + H / 2 };
          const mx = (s.x + t.x) / 2;
          return (
            <g key={i}>
              <path d={`M${s.x},${s.y} C${mx},${s.y} ${mx},${t.y} ${t.x - 2},${t.y}`} fill="none" stroke={e.kind === 'reject' ? '#b42318' : '#6b7480'} strokeWidth="1.4" markerEnd="url(#arr)" />
              {e.label && (
                <text x={mx} y={(s.y + t.y) / 2 - 4} fontSize="10" textAnchor="middle" fill="#3e4650">
                  {e.label.length > 26 ? `${e.label.slice(0, 25)}…` : e.label}
                </text>
              )}
            </g>
          );
        })}
        {steps.map((s) => {
          const p = pos.get(s.key);
          if (!p) return null;
          const st = states[s.key];
          const fill = st === 'current' ? '#0f5c5c' : st === 'done' ? '#e5f4e9' : s.type.startsWith('end') ? '#f3f4f6' : '#fff';
          const stroke = st === 'current' ? '#0f5c5c' : st === 'done' ? '#7fbf8f' : s.type === 'decision' ? '#b45309' : '#9aa3ad';
          const color = st === 'current' ? '#fff' : '#1d2329';
          const words = s.name.split(' ');
          const lines: string[] = [];
          for (const w of words) {
            const last = lines[lines.length - 1];
            if (last && (last + ' ' + w).length <= 24) lines[lines.length - 1] = `${last} ${w}`;
            else lines.push(w);
          }
          return (
            <g key={s.key}>
              <rect x={p.x} y={p.y} width={W} height={H} rx={s.type === 'decision' ? 2 : s.type.startsWith('end') || s.type === 'start' ? 26 : 7} fill={fill} stroke={stroke} strokeWidth={st === 'current' ? 2 : 1.2} strokeDasharray={st === 'skipped' ? '4 3' : undefined} />
              {lines.slice(0, 2).map((l, i) => (
                <text key={i} x={p.x + W / 2} y={p.y + 21 + i * 13} fontSize="11.5" fontWeight={600} textAnchor="middle" fill={color}>
                  {l}
                </text>
              ))}
              <text x={p.x + W / 2} y={p.y + H - 7} fontSize="9" textAnchor="middle" fill={st === 'current' ? '#d7ecea' : '#6b7480'}>
                {TYPE_LABEL[s.type] ?? s.type}
              </text>
              <title>{s.name}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
