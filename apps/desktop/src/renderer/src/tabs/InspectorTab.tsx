import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type SnapshotDTO, type ViewNode } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';

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
/** 드래그로 바꾼 패널 너비처럼 다음 실행에도 유지할 숫자 */
function useStoredNumber(key: string, initial: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return n > 0 ? n : initial;
    } catch {
      return initial;
    }
  });
  const set = (n: number) => {
    setV(n);
    try {
      localStorage.setItem(key, String(Math.round(n)));
    } catch {
      /* 이번 실행 동안만 유지 */
    }
  };
  return [v, set];
}

/** 패널 사이 경계선. 드래그해 옆 패널 너비를 바꾼다 (reverse: 오른쪽 패널) */
function Splitter({ width, onResize, reverse }: { width: number; onResize(w: number): void; reverse?: boolean }) {
  const [active, setActive] = useState(false);
  return (
    <div
      className={`splitter ${active ? 'active' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        const x0 = e.clientX;
        setActive(true);
        const move = (ev: MouseEvent) => onResize(Math.max(180, Math.min(900, width + (reverse ? x0 - ev.clientX : ev.clientX - x0))));
        const up = () => {
          setActive(false);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

/** 접고 펼 수 있는 패널의 열림 상태. 다음 실행에도 유지되도록 저장한다 */
function usePanel(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== '0';
    } catch {
      return true;
    }
  });
  const toggle = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* 이번 실행 동안만 유지 */
    }
  };
  return [open, toggle];
}
/** 선택한 뷰이거나 그 조상인지 (id 가 0.2.1 같은 경로라 접두어로 판단) */
const onPath = (n: ViewNode, sel: ViewNode | null) => !!sel && (sel.id === n.id || sel.id.startsWith(n.id + '.'));
/** 깊이별 색: 3D 층 테두리와 트리의 색 점이 같은 색을 써서 조각과 목록을 맞춰 볼 수 있다 */
/** 깊이별 색. 글자·테두리는 테마에 맞는 밝기, 깊이 배지 바탕은 글자가 어두워 늘 밝은 색 */
const depthColor = (d: number, a = 1, l = 'var(--depth-l)') => `hsla(${150 + d * 18}, 60%, ${l}, ${a})`;
const label = (n: ViewNode) => `${short(n.className) || 'root'}${n.resourceId ? ' #' + rid(n.resourceId) : ''}`;

/**
 * 가리킨 뷰 id 를 들고 있는 작은 저장소. 트리 줄은 "내가 가리켜졌는지"만 구독해서,
 * 마우스가 움직일 때 트리 전체가 아니라 상태가 바뀐 두 줄만 다시 그린다
 */
function createHoverStore() {
  let cur: string | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(id: string | null) {
      if (cur === id) return;
      cur = id;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
type HoverStore = ReturnType<typeof createHoverStore>;

export function InspectorTab() {
  const { serial, run } = useApp();
  const t = useT();
  const [snap, setSnap] = useState<SnapshotDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<ViewNode | null>(null);
  const [hover, setHover] = useState<ViewNode | null>(null);
  const hoverStore = useMemo(createHoverStore, []);
  const onHover = useCallback(
    (n: ViewNode | null) => {
      setHover(n);
      hoverStore.set(n?.id ?? null);
    },
    [hoverStore],
  );
  const onToggle = useCallback(
    (id: string) =>
      setCollapsed((c) => {
        const nx = new Set(c);
        nx.has(id) ? nx.delete(id) : nx.add(id);
        return nx;
      }),
    [],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const [treeOpen, toggleTree] = usePanel('droidlens.inspector.tree');
  const [propsOpen, toggleProps] = usePanel('droidlens.inspector.props');
  const [treeW, setTreeW] = useStoredNumber('droidlens.inspector.treeW', 340);
  const [propsW, setPropsW] = useStoredNumber('droidlens.inspector.propsW', 320);
  // [트리 | 경계 | 화면 | 경계 | 속성]. 접힌 패널은 28px 막대만 남고, 남는 너비는 가운데 화면이 차지
  const cols = [
    treeOpen ? `${treeW}px 5px` : '28px',
    'minmax(0, 1fr)',
    propsOpen ? `5px ${propsW}px` : '28px',
  ].join(' ');

  // 캡처하는 사이 기기가 바뀌면 이전 기기의 스냅샷이 새 기기 화면을 덮지 않게 지금 기기를 ref 로 들고 있는다
  const serialRef = useRef(serial);
  serialRef.current = serial;
  const load = async () => {
    if (!serial) return;
    const target = serial;
    setLoading(true);
    const s = await run(api.snapshot(target));
    if (serialRef.current !== target) return;
    setLoading(false);
    if (s) {
      setSnap(s);
      setSel(null);
      setCollapsed(new Set());
    }
  };

  useEffect(() => {
    setSnap(null);
    setSel(null);
    onHover(null);
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
          {loading ? t('캡처 중…') : t('↻ 현재 화면 캡처')}
        </button>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className={`btn sm ${mode === '2d' ? 'primary' : ''}`} onClick={() => setMode('2d')}>{t('트리')}</button>
          <button className={`btn sm ${mode === '3d' ? 'primary' : ''}`} onClick={() => setMode('3d')}>{t('3D 깊이')}</button>
        </div>
        <input className="input" placeholder={t('클래스·id·텍스트 검색')} value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }} />
        {snap && (
          <span className="muted">
            {short(snap.screen.activity)} · {t('노드 {n} · 최대 깊이 {d}', { n: snap.stats.nodeCount, d: snap.stats.maxDepth })}
            {snap.stats.likelyCompose && <span className="pill" style={{ marginLeft: 8 }}>{t('Compose 추정')}</span>}
            {matchIds && <span className="pill accent" style={{ marginLeft: 8 }}>{t('검색 {n}', { n: matchIds.size })}</span>}
          </span>
        )}
      </div>
      {!snap ? (
        <div className="empty">{loading ? t('뷰 계층을 가져오는 중…') : t('캡처 버튼을 눌러 뷰 계층을 가져오세요')}</div>
      ) : (
        <div className={`inspector ${mode === '3d' ? 'is-3d' : ''}`} style={{ gridTemplateColumns: cols }}>
          {!treeOpen ? (
            <button className="panel-rail left" onClick={() => toggleTree(true)} title={t('트리 패널 펴기')}>
              ▸ <span>{t('트리')}</span>
            </button>
          ) : (
            <>
              <div className="panel-col">
                <button className="panel-toggle" onClick={() => toggleTree(false)} title={t('트리 패널 접기')}>◂</button>
                <div className="tree">
                  <TreeRow
                    n={snap.hierarchy.root}
                    sel={sel}
                    hoverStore={hoverStore}
                    depthDots={mode === '3d'}
                    collapsed={collapsed}
                    matchIds={matchIds}
                    onToggle={onToggle}
                    onSel={setSel}
                    onHover={onHover}
                  />
                </div>
              </div>
              <Splitter width={treeW} onResize={setTreeW} />
            </>
          )}
          {mode === '3d' ? (
            <ThreeD snap={snap} sel={sel} setSel={setSel} hover={hover} onHover={onHover} />
          ) : (
            <ShotPane snap={snap} sel={sel} hover={hover} onPick={setSel} onHover={onHover} />
          )}
          {propsOpen ? (
            <>
              <Splitter width={propsW} onResize={setPropsW} reverse />
              <div className="panel-col">
                <button className="panel-toggle" onClick={() => toggleProps(false)} title={t('속성 패널 접기')}>▸</button>
                <Props snap={snap} n={sel} />
              </div>
            </>
          ) : (
            <button className="panel-rail" onClick={() => toggleProps(true)} title={t('속성 패널 펴기')}>
              ◂ <span>{t('속성')}</span>
            </button>
          )}
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
  // 패널 너비를 바꾸면 이미지 크기가 바뀌므로 강조 상자 비율을 다시 계산
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.naturalWidth && setScale(el.clientWidth / el.naturalWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

/** 트리 한 줄. props 가 같으면 다시 그리지 않으므로 넘기는 콜백·집합은 안정된 값이어야 한다 */
const TreeRow = memo(function TreeRow(p: {
  n: ViewNode;
  sel: ViewNode | null;
  hoverStore: HoverStore;
  depthDots?: boolean;
  collapsed: Set<string>;
  matchIds: Set<string> | null;
  onToggle(id: string): void;
  onSel(n: ViewNode): void;
  onHover(n: ViewNode | null): void;
}) {
  const { n } = p;
  const open = !p.collapsed.has(n.id);
  const isSel = p.sel?.id === n.id;
  const hovered = useSyncExternalStore(p.hoverStore.subscribe, () => p.hoverStore.get() === n.id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isSel) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isSel]);
  const dim = p.matchIds && !p.matchIds.has(n.id);
  return (
    <>
      <div
        ref={ref}
        className={`row ${isSel ? 'sel' : ''} ${hovered && !isSel ? 'hov' : ''} ${!isSel && onPath(n, p.sel) ? 'path' : ''}`}
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
        {p.depthDots && <span className="ddot" style={{ background: depthColor(n.depth, 1, '65%') }} title={`depth ${n.depth}`}>{n.depth}</span>}
        <span className="cls">{short(n.className) || 'root'}</span>
        {n.resourceId && <span className="rid">#{rid(n.resourceId)}</span>}
        {(n.text || n.contentDesc) && <span className="txt">"{n.text || n.contentDesc}"</span>}
        {n.children.length > 0 && !open && <span className="dpt">+{n.children.length}</span>}
      </div>
      {open && n.children.map((c) => <TreeRow key={c.id} {...p} n={c} />)}
    </>
  );
});

function Props({ snap, n }: { snap: SnapshotDTO; n: ViewNode | null }) {
  const t = useT();
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
        <div className="faint">{t('노드를 선택하세요 (스크린샷 클릭 또는 트리)')}</div>
      )}
      <h4 style={{ marginTop: 18 }} className="faint">{t('깊이별 노드 수')}</h4>
      <div className="bars">
        {snap.stats.byDepth.map((v, d) => (
          <div className="bar" key={d}>
            <span>{d}</span>
            <i style={{ width: `${((v ?? 0) / max) * 100}%` }} />
            <span>{v ?? 0}</span>
          </div>
        ))}
      </div>
      <h4 style={{ marginTop: 18 }} className="faint">{t('많이 쓰인 클래스')}</h4>
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
function ThreeD({ snap, sel, setSel, hover, onHover }: {
  snap: SnapshotDTO;
  sel: ViewNode | null;
  setSel(n: ViewNode | null): void;
  hover: ViewNode | null;
  onHover(n: ViewNode | null): void;
}) {
  const t = useT();
  const [rot, setRot] = useState({ x: 20, y: -30 });
  const [gap, setGap] = useState(28);
  const [zoom, setZoom] = useState(1);
  const hov = hover?.id ?? null;
  const [minArea, setMinArea] = useState(true);
  const [labels, setLabels] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // 스페이스바를 누른 채 드래그하면 회전 대신 장면을 이동(팬)
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  const dragging = useRef<{ x: number; y: number; rx: number; ry: number; px: number; py: number; pan: boolean } | null>(null);
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest?.('input, textarea, select');
    const set = (v: boolean) => {
      spaceRef.current = v;
      setSpace(v);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault();
      if (!spaceRef.current) set(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault(); // 포커스된 버튼이 스페이스로 눌리지 않게
      set(false);
    };
    const blur = () => set(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  const resetView = (r: { x: number; y: number }) => {
    setRot(r);
    setPan({ x: 0, y: 0 });
  };
  const root = snap.hierarchy.root;
  const W = root.bounds[2] - root.bounds[0] || 1080;
  const H = root.bounds[3] - root.bounds[1] || 2400;
  const scale = (Math.min(window.innerHeight - 220, 760) / H) * zoom;
  const nodes = useMemo(
    () =>
      flatten(root).filter((n) => {
        if (n.depth === 0) return false;
        const [l, t, r, b] = n.bounds;
        // 작은 뷰를 숨겨도 목록에서 고르거나 가리킨 뷰는 보여준다
        return !minArea || (r - l) * (b - t) > 400 || n.id === sel?.id || n.id === hov;
      }),
    [root, minArea, sel, hov],
  );

  return (
    <div style={{ position: 'relative', height: '100%', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', zIndex: 2, left: 12, right: 12, top: 10, display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center' }} className="muted">
        <label>{t('간격')} <input type="range" min={0} max={80} value={gap} onChange={(e) => setGap(+e.target.value)} /></label>
        <label>{t('확대')} <input type="range" min={0.5} max={2} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} /></label>
        <label className="chk"><input type="checkbox" checked={minArea} onChange={(e) => setMinArea(e.target.checked)} />{t('작은 뷰 숨기기')}</label>
        <label className="chk"><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />{t('클래스 이름 표시')}</label>
        <button className="btn sm" onClick={() => resetView({ x: 20, y: -30 })}>{t('시점 초기화')}</button>
        <button className="btn sm" onClick={() => resetView({ x: 0, y: 0 })}>{t('정면')}</button>
        <span>{hover ?? sel ? `${label((hover ?? sel)!)} · depth ${(hover ?? sel)!.depth}` : t('드래그로 회전 · 스페이스+드래그로 이동 · 클릭으로 선택')}</span>
      </div>
      <div
        className="three"
        style={{ height: '100%', cursor: space ? 'move' : undefined }}
        onMouseDown={(e) => (dragging.current = { x: e.clientX, y: e.clientY, rx: rot.x, ry: rot.y, px: pan.x, py: pan.y, pan: spaceRef.current })}
        onMouseMove={(e) => {
          const d = dragging.current;
          if (!d) return;
          if (d.pan) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
          else setRot({ x: Math.max(-80, Math.min(80, d.rx - (e.clientY - d.y) * 0.3)), y: d.ry + (e.clientX - d.x) * 0.3 });
        }}
        onMouseUp={(e) => {
          const d = dragging.current;
          dragging.current = null;
          // 회전·이동 없이 빈 곳을 누르면 선택 해제
          if (d && !d.pan && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 4 && !(e.target as HTMLElement).closest('.layer')) setSel(null);
        }}
        onMouseLeave={() => (dragging.current = null)}
        onWheel={(e) => setZoom((z) => Math.max(0.5, Math.min(2, z - e.deltaY * 0.001)))}
      >
        <div
          className="three-scene"
          style={{ width: W * scale, height: H * scale, transform: `translate(${pan.x}px, ${pan.y}px) rotateX(${rot.x}deg) rotateY(${rot.y}deg)` }}
        >
          <img className="three-base" src={snap.image} style={{ width: '100%', height: '100%', opacity: sel ? 0.1 : undefined }} alt="" />
          {nodes.map((n) => {
            const [l, t, r, b] = n.bounds;
            const w = (r - l) * scale;
            const on = sel?.id === n.id || hov === n.id;
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
                  borderColor: on ? undefined : depthColor(n.depth, 0.45),
                  zIndex: on ? 1 : undefined,
                  // 선택이 있으면 선택한 뷰까지의 경로만 또렷하게, 나머지는 흐리게
                  opacity: sel && !onPath(n, sel) && hov !== n.id ? 0.1 : 1,
                }}
                onMouseEnter={() => onHover(n)}
                onMouseLeave={() => hover?.id === n.id && onHover(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!spaceRef.current) setSel(n); // 이동 중에는 선택하지 않음
                }}
                title={`${label(n)} ${n.text}`}
              >
                {(on || (labels && w > 56)) && (
                  <span className="layer-label" style={{ borderColor: depthColor(n.depth), maxWidth: on ? undefined : w - 4 }}>
                    <b style={{ color: depthColor(n.depth) }}>{n.depth}</b> {label(n)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
