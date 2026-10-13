import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type SnapshotDTO, type ViewNode } from '../api';
import { useApp } from '../App';

function flatten(n: ViewNode, out: ViewNode[] = []): ViewNode[] {
  out.push(n);
  n.children.forEach((c) => flatten(c, out));
  return out;
}

function nodeAt(root: ViewNode, x: number, y: number): ViewNode | undefined {
  let best: ViewNode | undefined;
  for (const n of flatten(root)) {
    const [l, t, r, b] = n.bounds;
    if (n.depth > 0 && x >= l && x <= r && y >= t && y <= b && (!best || n.depth >= best.depth)) best = n;
  }
  return best;
}

const short = (c: string) => c.split('.').pop() ?? c;
const rid = (r: string) => r.split(':id/')[1] ?? r;

export function InspectorTab() {
  const { serial, run } = useApp();
  const [snap, setSnap] = useState<SnapshotDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<ViewNode | null>(null);
  const [hover, setHover] = useState<ViewNode | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'2d' | '3d'>('2d');

  const load = async () => {
    if (!serial) return;
    setLoading(true);
    const s = await run(api.snapshot(serial));
    setLoading(false);
    if (s) {
      setSnap(s);
      setSel(null);
      setCollapsed(new Set());
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  const all = useMemo(() => (snap ? flatten(snap.hierarchy.root) : []), [snap]);
  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      all
        .filter((n) => [n.className, n.resourceId, n.text, n.contentDesc].some((v) => v.toLowerCase().includes(q)))
        .map((n) => n.id),
    );
  }, [all, query]);

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={load} disabled={loading}>
          {loading ? '캡처 중…' : '↻ 현재 화면 캡처'}
        </button>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className={`btn sm ${mode === '2d' ? 'primary' : ''}`} onClick={() => setMode('2d')}>트리</button>
          <button className={`btn sm ${mode === '3d' ? 'primary' : ''}`} onClick={() => setMode('3d')}>3D 깊이</button>
        </div>
        <input className="input" placeholder="클래스·id·텍스트 검색" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }} />
        {snap && (
          <span className="muted">
            {short(snap.screen.activity)} · 노드 {snap.stats.nodeCount} · 최대 깊이 {snap.stats.maxDepth}
            {snap.stats.likelyCompose && <span className="pill" style={{ marginLeft: 8 }}>Compose 추정</span>}
            {matchIds && <span className="pill accent" style={{ marginLeft: 8 }}>검색 {matchIds.size}</span>}
          </span>
        )}
      </div>
      {!snap ? (
        <div className="empty">{loading ? '뷰 계층을 가져오는 중…' : '캡처 버튼을 눌러 뷰 계층을 가져오세요'}</div>
      ) : mode === '3d' ? (
        <ThreeD snap={snap} sel={sel} setSel={setSel} />
      ) : (
        <div className="inspector">
          <ShotPane snap={snap} sel={sel} hover={hover} onPick={setSel} onHover={setHover} />
          <div className="tree">
            <TreeRow
              n={snap.hierarchy.root}
              sel={sel}
              collapsed={collapsed}
              matchIds={matchIds}
              onToggle={(id) =>
                setCollapsed((c) => {
                  const nx = new Set(c);
                  nx.has(id) ? nx.delete(id) : nx.add(id);
                  return nx;
                })
              }
              onSel={setSel}
              onHover={setHover}
            />
          </div>
          <Props snap={snap} n={sel} />
        </div>
      )}
    </>
  );
}

function ShotPane(p: {
  snap: SnapshotDTO;
  sel: ViewNode | null;
  hover: ViewNode | null;
  onPick(n: ViewNode | null): void;
  onHover(n: ViewNode | null): void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(0);
  const box = (n: ViewNode, cls: string) => {
    const [l, t, r, b] = n.bounds;
    return <div className={`hl ${cls}`} style={{ left: l * scale, top: t * scale, width: (r - l) * scale, height: (b - t) * scale }} />;
  };
  const pt = (e: React.MouseEvent) => {
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    return nodeAt(p.snap.hierarchy.root, ((e.clientX - rect.left) / rect.width) * el.naturalWidth, ((e.clientY - rect.top) / rect.height) * el.naturalHeight);
  };
  return (
    <div className="shot-pane">
      <div className="shot-box">
        <img
          ref={ref}
          src={p.snap.image}
          onLoad={(e) => setScale(e.currentTarget.clientWidth / e.currentTarget.naturalWidth)}
          onMouseMove={(e) => p.onHover(pt(e) ?? null)}
          onMouseLeave={() => p.onHover(null)}
          onClick={(e) => p.onPick(pt(e) ?? null)}
          alt=""
        />
        {scale > 0 && p.hover && box(p.hover, 'hover')}
        {scale > 0 && p.sel && box(p.sel, '')}
      </div>
    </div>
  );
}

function TreeRow(p: {
  n: ViewNode;
  sel: ViewNode | null;
  collapsed: Set<string>;
  matchIds: Set<string> | null;
  onToggle(id: string): void;
  onSel(n: ViewNode): void;
  onHover(n: ViewNode | null): void;
}) {
  const { n } = p;
  const open = !p.collapsed.has(n.id);
  const isSel = p.sel?.id === n.id;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isSel) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isSel]);
  const dim = p.matchIds && !p.matchIds.has(n.id);
  return (
    <>
      <div
        ref={ref}
        className={`row ${isSel ? 'sel' : ''}`}
        style={{ paddingLeft: 8 + n.depth * 14, opacity: dim ? 0.35 : 1 }}
        onClick={() => p.onSel(n)}
        onMouseEnter={() => p.onHover(n)}
        onMouseLeave={() => p.onHover(null)}
      >
        <span
          className="tw"
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle(n.id);
          }}
        >
          {n.children.length ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="cls">{short(n.className) || 'root'}</span>
        {n.resourceId && <span className="rid">#{rid(n.resourceId)}</span>}
        {(n.text || n.contentDesc) && <span className="txt">"{n.text || n.contentDesc}"</span>}
        {n.children.length > 0 && !open && <span className="dpt">+{n.children.length}</span>}
      </div>
      {open && n.children.map((c) => <TreeRow key={c.id} {...p} n={c} />)}
    </>
  );
}

function Props({ snap, n }: { snap: SnapshotDTO; n: ViewNode | null }) {
  const max = Math.max(...snap.stats.byDepth.map((v) => v ?? 0));
  return (
    <div className="props">
      {n ? (
        <table>
          <tbody>
            {(
              [
                ['class', n.className],
                ['resource-id', n.resourceId],
                ['text', n.text],
                ['content-desc', n.contentDesc],
                ['package', n.packageName],
                ['bounds', `[${n.bounds[0]},${n.bounds[1]}][${n.bounds[2]},${n.bounds[3]}]`],
                ['size', `${n.bounds[2] - n.bounds[0]} × ${n.bounds[3] - n.bounds[1]}`],
                ['depth', String(n.depth)],
                ['children', String(n.children.length)],
                ['node id', n.id],
                [
                  'flags',
                  Object.entries({
                    clickable: n.clickable,
                    longClickable: n.longClickable,
                    scrollable: n.scrollable,
                    focusable: n.focusable,
                    focused: n.focused,
                    enabled: n.enabled,
                    checkable: n.checkable,
                    checked: n.checked,
                    selected: n.selected,
                    password: n.password,
                  })
                    .filter(([, v]) => v)
                    .map(([k]) => k)
                    .join(', '),
                ],
                ['selector', n.resourceId ? `id=${rid(n.resourceId)}` : n.text ? `text="${n.text}"` : n.contentDesc ? `desc="${n.contentDesc}"` : '-'],
              ] as const
            ).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v || <span className="faint">-</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">노드를 선택하세요 (스크린샷 클릭 또는 트리)</div>
      )}
      <h4 style={{ marginTop: 18 }} className="faint">깊이별 노드 수</h4>
      <div className="bars">
        {snap.stats.byDepth.map((v, d) => (
          <div className="bar" key={d}>
            <span>{d}</span>
            <i style={{ width: `${((v ?? 0) / max) * 100}%` }} />
            <span>{v ?? 0}</span>
          </div>
        ))}
      </div>
      <h4 style={{ marginTop: 18 }} className="faint">많이 쓰인 클래스</h4>
      <div className="mono" style={{ fontSize: 11 }}>
        {snap.stats.topClasses.map(([c, k]) => (
          <div key={c}>
            {k} · {short(c)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** CSS 3D로 뷰를 깊이만큼 띄워 보여주는 분해도 */
function ThreeD({ snap, sel, setSel }: { snap: SnapshotDTO; sel: ViewNode | null; setSel(n: ViewNode | null): void }) {
  const [rot, setRot] = useState({ x: 20, y: -30 });
  const [gap, setGap] = useState(28);
  const [zoom, setZoom] = useState(1);
  const [hov, setHov] = useState<string | null>(null);
  const [minArea, setMinArea] = useState(true);
  const dragging = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const root = snap.hierarchy.root;
  const W = root.bounds[2] - root.bounds[0] || 1080;
  const H = root.bounds[3] - root.bounds[1] || 2400;
  const scale = (Math.min(window.innerHeight - 220, 760) / H) * zoom;
  const nodes = useMemo(
    () =>
      flatten(root).filter((n) => {
        if (n.depth === 0) return false;
        const [l, t, r, b] = n.bounds;
        return !minArea || (r - l) * (b - t) > 400;
      }),
    [root, minArea],
  );

  return (
    <div style={{ position: 'relative', height: 'calc(100% - 45px)' }}>
      <div style={{ position: 'absolute', zIndex: 2, left: 12, top: 10, display: 'flex', gap: 12, alignItems: 'center' }} className="muted">
        <label>간격 <input type="range" min={0} max={80} value={gap} onChange={(e) => setGap(+e.target.value)} /></label>
        <label>확대 <input type="range" min={0.5} max={2} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} /></label>
        <label className="chk"><input type="checkbox" checked={minArea} onChange={(e) => setMinArea(e.target.checked)} />작은 뷰 숨기기</label>
        <button className="btn sm" onClick={() => setRot({ x: 20, y: -30 })}>시점 초기화</button>
        <button className="btn sm" onClick={() => setRot({ x: 0, y: 0 })}>정면</button>
        <span>{sel ? `${short(sel.className)} ${sel.resourceId ? '#' + rid(sel.resourceId) : ''} · depth ${sel.depth}` : '드래그로 회전 · 클릭으로 선택'}</span>
      </div>
      <div
        className="three"
        style={{ height: '100%' }}
        onMouseDown={(e) => (dragging.current = { x: e.clientX, y: e.clientY, rx: rot.x, ry: rot.y })}
        onMouseMove={(e) => {
          const d = dragging.current;
          if (d) setRot({ x: Math.max(-80, Math.min(80, d.rx - (e.clientY - d.y) * 0.3)), y: d.ry + (e.clientX - d.x) * 0.3 });
        }}
        onMouseUp={() => (dragging.current = null)}
        onMouseLeave={() => (dragging.current = null)}
        onWheel={(e) => setZoom((z) => Math.max(0.5, Math.min(2, z - e.deltaY * 0.001)))}
      >
        <div
          className="three-scene"
          style={{ width: W * scale, height: H * scale, transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)` }}
        >
          <img className="three-base" src={snap.image} style={{ width: '100%', height: '100%' }} alt="" />
          {nodes.map((n) => {
            const [l, t, r, b] = n.bounds;
            return (
              <div
                key={n.id}
                className={`layer ${sel?.id === n.id ? 'sel' : ''} ${hov === n.id ? 'hov' : ''}`}
                style={{
                  left: (l - root.bounds[0]) * scale,
                  top: (t - root.bounds[1]) * scale,
                  width: (r - l) * scale,
                  height: (b - t) * scale,
                  transform: `translateZ(${n.depth * gap}px)`,
                  borderColor: sel?.id === n.id || hov === n.id ? undefined : `hsla(${150 + n.depth * 18}, 60%, 65%, .45)`,
                }}
                onMouseEnter={() => setHov(n.id)}
                onMouseLeave={() => setHov((h) => (h === n.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation();
                  setSel(n);
                }}
                title={`${short(n.className)} ${rid(n.resourceId)} ${n.text}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
