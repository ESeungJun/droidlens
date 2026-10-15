import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Graph, layout as dagreLayout } from '@dagrejs/dagre';
import { actionKey, shortestPath, startScreenOf as startOf, triedKeys } from '@droidlens/core/graph-model';
import { api, type GraphAction, type GraphData, type Interaction, type ScreenNode } from '../api';
import { NeedPkg, useApp } from '../App';
import { useT } from '../i18n';

const imgCache = new Map<string, string>();

function useShot(pkg: string, file?: string) {
  const key = file ? pkg + file : '';
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null);
  useEffect(() => {
    if (!file || imgCache.has(key)) return;
    let alive = true;
    api.graphImage(pkg, file).then((d) => {
      imgCache.set(key, d);
      if (alive) setLoaded({ key, src: d });
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pkg, file, key]);
  // 다른 화면을 고르면 그 화면의 이미지로 (이전 화면의 이미지를 붙들고 있지 않게)
  if (!file) return undefined;
  return imgCache.get(key) ?? (loaded?.key === key ? loaded.src : undefined);
}

type SNodeData = { screen: ScreenNode; pkg: string; selected: boolean; start: boolean; dim: boolean; done: number };

const ScreenCard = memo(({ data }: NodeProps<Node<SNodeData>>) => {
  const src = useShot(data.pkg, data.screen.screenshot);
  const t = useT();
  return (
    <div className={`screen-node ${data.selected ? 'sel' : ''} ${data.dim ? 'dim' : ''}`}>
      <Handle type="target" position={Position.Left} />
      {src ? <img src={src} alt="" /> : <img alt="" />}
      <div className="t" title={data.screen.label}>
        {data.start && <span className="pill accent" style={{ marginRight: 4, padding: '0 6px', fontSize: 10 }}>{t('시작')}</span>}
        {data.screen.label}
      </div>
      <div className="s">
        {t('{n}회', { n: data.screen.visits })}
        {data.screen.targets?.length ? (
          <span className={data.done >= data.screen.targets.length ? 'cov full' : 'cov'} title={t('눌러 본 요소 / 누를 수 있는 요소')}>
            {' · '}
            {t('버튼 {d}/{n}', { d: data.done, n: data.screen.targets.length })}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
      {/* 되돌아가는 연결은 카드 아래로 나가고 들어와 앞으로 가는 연결과 겹치지 않는다 */}
      <Handle type="source" id="back-out" position={Position.Bottom} />
      <Handle type="target" id="back-in" position={Position.Bottom} />
    </div>
  );
});

const nodeTypes = { screen: ScreenCard };

type Pos = { x: number; y: number };
// 화면 카드 크기 (styles.css .screen-node 150px + 여백, 세로 스크린샷 기준)
const CARD_W = 162;
const CARD_H = 380;

/** 연결선·목록에 쓰는 행동 이름 */
function actionName(a: GraphAction): string {
  switch (a.type) {
    case 'tap':
      return a.label ?? 'tap';
    case 'longpress':
      return `⏱ ${a.label ?? 'long press'}`;
    case 'swipe':
      return `swipe ${a.direction ?? ''}`.trim();
    case 'key':
      return a.key;
    default:
      return a.type;
  }
}

/** 강조해서 보여 줄 부분 (지정 탐색 결과·경로). 나머지 화면과 연결은 흐리게 */
type Focus = { title: string; nodes: Set<string>; edges: Set<string> };

/**
 * 시작 화면 기준으로 왼쪽 → 오른쪽 배치. 시작 화면에서 연결선을 따라 몇 단계인지(BFS)로 열을 정하고,
 * 다음 단계로 가는 연결만 배치에 써서 '홈으로 돌아가기' 같은 되돌아가는 연결이 시작 화면을 밀어내지 않게 한다.
 * 같은 열 안의 순서는 dagre 가 선이 덜 엇갈리게 정한다.
 */
/**
 * 시작 화면에서 연결선을 따라 몇 단계 떨어졌는지 (BFS).
 * 시작 화면에서 닿지 않는 화면(현재 화면부터 탐색·직접 추가한 화면)은 기록된 순서대로 새 출발점으로 삼아 이어서 센다
 */
function levels(g: GraphData): Map<string, number> {
  const level = new Map<string, number>();
  const bfs = (root: string) => {
    level.set(root, 0);
    const q = [root];
    while (q.length) {
      const cur = q.shift()!;
      for (const e of g.edges) {
        if (e.from === cur && !level.has(e.to)) {
          level.set(e.to, level.get(cur)! + 1);
          q.push(e.to);
        }
      }
    }
  };
  const start = startOf(g);
  if (start) bfs(start);
  for (const n of [...g.nodes].sort((a, b) => a.firstSeen - b.firstSeen)) if (!level.has(n.id)) bfs(n.id);
  return level;
}

function layout(g: GraphData): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  if (!startOf(g)) return pos;
  const level = levels(g);
  const d = new Graph();
  d.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 110, marginx: 20, marginy: 20 });
  d.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) d.setNode(n.id, { width: CARD_W, height: CARD_H });
  for (const e of g.edges) {
    const lf = level.get(e.from);
    const lt = level.get(e.to);
    if (lf !== undefined && lt === lf + 1) d.setEdge(e.from, e.to);
  }
  dagreLayout(d);
  // 열(x)은 출발점에서의 단계로 고정, 줄(y)은 dagre 결과
  for (const n of g.nodes) {
    const p = d.node(n.id);
    pos.set(n.id, { x: (level.get(n.id) ?? 0) * (CARD_W + 110), y: p.y - CARD_H / 2 });
  }
  return pos;
}

export function FlowTab() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [g, setG] = useState<GraphData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const [depth, setDepth] = useState(3);
  const [progress, setProgress] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [fromCurrent, setFromCurrent] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [navigating, setNavigating] = useState(false);
  // 카드: 처음엔 자동 배치, 드래그하면 그 위치를 유지하고 '정리'로 다시 자동 배치.
  // React Flow 가 잰 카드 크기(measured)를 잃지 않도록 변경분만 applyNodeChanges 로 반영한다 (새로 만들면 매번 다시 재며 깜빡인다)
  const [rfNodes, setRfNodes] = useState<Node<SNodeData>[]>([]);
  const moved = useRef(false);
  const rf = useRef<ReactFlowInstance<Node<SNodeData>, Edge> | null>(null);

  const arrange = useCallback(() => {
    if (!g) return;
    moved.current = false;
    const auto = layout(g);
    setRfNodes((cur) => cur.map((n) => ({ ...n, position: auto.get(n.id) ?? n.position })));
    requestAnimationFrame(() => rf.current?.fitView({ padding: 0.15, duration: 300 }));
  }, [g]);

  // 그래프가 바뀌면: 직접 옮긴 적이 없으면 전체 다시 배치, 옮겼으면 새 화면만 자동 위치에 추가
  useEffect(() => {
    if (!g || !pkg) return setRfNodes([]);
    const auto = layout(g);
    const start = startOf(g);
    setRfNodes((cur) => {
      const old = new Map(cur.map((n) => [n.id, n]));
      return g.nodes.map((s) => {
        const o = old.get(s.id);
        return {
          ...o,
          id: s.id,
          type: 'screen',
          position: moved.current && o ? o.position : auto.get(s.id) ?? { x: 0, y: 0 },
          data: {
            screen: s,
            pkg,
            selected: o?.data.selected ?? false,
            start: s.id === start,
            dim: o?.data.dim ?? false,
            done: triedKeys(g.edges, s).size,
          },
        };
      });
    });
  }, [g, pkg]);

  // 강조가 바뀐 카드만 data 를 바꾼다
  useEffect(() => {
    setRfNodes((cur) =>
      cur.map((n) => {
        const dim = !!focus && !focus.nodes.has(n.id);
        return n.data.dim === dim ? n : { ...n, data: { ...n.data, dim } };
      }),
    );
  }, [focus, g]);

  // 선택이 바뀐 카드만 data 를 바꾼다
  useEffect(() => {
    setRfNodes((cur) =>
      cur.map((n) => (n.data.selected === (n.id === sel) ? n : { ...n, data: { ...n.data, selected: n.id === sel } })),
    );
  }, [sel]);

  const onNodesChange = useCallback((changes: NodeChange<Node<SNodeData>>[]) => {
    if (changes.some((c) => c.type === 'position' && c.dragging)) moved.current = true;
    setRfNodes((cur) => applyNodeChanges(changes, cur));
  }, []);

  const reload = useCallback(async () => {
    if (pkg) setG((await run(api.graphGet(pkg))) ?? null);
  }, [pkg, run]);

  useEffect(() => {
    setSel(null);
    setFocus(null);
    moved.current = false; // 다른 앱으로 바뀌면 직접 옮긴 배치는 의미가 없다
    reload();
  }, [reload]);

  useEffect(
    () =>
      api.onProgress((p) => {
        if (p.kind !== 'explore') return;
        setProgress((l) => [`${p.step !== undefined ? `#${p.step} ` : ''}${p.message}`, ...l].slice(0, 200));
        if (p.step !== undefined) setTapCount(p.step);
        if (p.screen) reload();
      }),
    [reload],
  );

  const edges = useMemo<Edge[]>(() => {
    if (!g) return [];
    const level = levels(g);
    return g.edges
      .filter((e) => e.from !== e.to)
      .map((e) => {
        const name = actionName(e.action);
        // 시작 화면 쪽으로 되돌아가는 연결은 앞으로 가는 연결과 겹치지 않게 아래로 돌아가는 점선으로
        const back = (level.get(e.to) ?? Infinity) <= (level.get(e.from) ?? Infinity);
        const focused = focus?.edges.has(e.id);
        const on = focused || (!focus && sel && (e.from === sel || e.to === sel));
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: back ? 'smoothstep' : 'default',
          sourceHandle: back ? 'back-out' : undefined,
          targetHandle: back ? 'back-in' : undefined,
          pathOptions: back ? { offset: 36, borderRadius: 16 } : undefined,
          label: back ? `↩ ${name}` : name,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: {
            stroke: on ? '#7dd3a8' : back ? '#6b7280' : '#4a505c',
            strokeDasharray: back ? '5 4' : undefined,
            opacity: focus && !focused ? 0.15 : 1,
          },
          labelStyle: focus && !focused ? { opacity: 0.2 } : undefined,
          animated: focus ? !!focused : !!sel && e.from === sel,
        };
      });
  }, [g, sel, focus]);

  if (!pkg) return <NeedPkg />;
  const selNode = g?.nodes.find((n) => n.id === sel);

  const start = async () => {
    if (!serial) return;
    setExploring(true);
    setProgress([]);
    setTapCount(0);
    setFocus(null);
    const r = await run(api.explore(serial, pkg, { maxDepth: depth, fromCurrent }));
    setExploring(false);
    await reload();
    if (r) {
      const danger = r.skipped.filter((s) => s.reason === '위험 라벨').length;
      const missing = r.skipped.length - danger;
      toast(
        t('탐색 완료: 버튼 {n}번 누름', { n: r.steps }) +
          (danger ? t(', 위험 라벨 {n}개 건너뜀', { n: danger }) : '') +
          (missing ? t(', 화면에서 못 찾은 버튼 {n}개', { n: missing }) : '') +
          (r.limited ? t(' — 안전 상한({n}번)에 닿아 멈췄습니다. 깊이를 줄여 보세요', { n: r.steps }) : ''),
        r.limited,
      );
    }
  };

  /** 고른 화면에서 지정한 인터랙션만 먼저 실행하고, 열린 화면부터는 최대 깊이까지 탐색. 끝나면 지나간 흐름만 강조 */
  const exploreFrom = async (screen: ScreenNode, only: Interaction[], allowDanger: boolean) => {
    if (!serial || !only.length) return;
    setExploring(true);
    setProgress([]);
    setTapCount(0);
    setFocus(null);
    const r = await run(api.explore(serial, pkg, { maxDepth: depth, startAt: screen.id, only, allowDanger }));
    setExploring(false);
    await reload();
    if (!r) return;
    setFocus({ title: t('{s}에서 지정한 동작의 흐름', { s: screen.label }), nodes: new Set(r.touched.nodes), edges: new Set(r.touched.edges) });
    // 시작 화면에서 건너뛴 것 = 지정했지만 실행하지 못한 동작 (화면에서 못 찾았거나 위험 버튼을 허용하지 않음)
    const missed = r.skipped.filter((x) => x.screen === r.startScreen);
    toast(
      t('지정한 동작 {n}개로 화면 {s}개, 연결 {e}개를 따라갔습니다', { n: only.length, s: r.touched.nodes.length - 1, e: r.touched.edges.length }) +
        (missed.length ? t(' — 실행하지 못한 동작 {n}개: {list}', { n: missed.length, list: missed.map((x) => `${x.label} (${t(x.reason)})`).join(', ') }) : '') +
        (r.errors.length ? t(' (오류 {n}개, 탐색 로그 참고)', { n: r.errors.length }) : ''),
      r.errors.length > 0 || missed.length > 0,
    );
  };

  /** 지도에 기록된 경로로 기기를 그 화면까지 옮긴다 */
  const navigate = async (screen: ScreenNode) => {
    if (!serial) return;
    setNavigating(true);
    setProgress([]);
    const r = await run(api.graphNavigate(serial, pkg, screen.id));
    setNavigating(false);
    await reload();
    if (r) toast(r.moved ? t('{n}단계로 이동했습니다: {s}', { n: r.steps, s: screen.label }) : t('이미 이 화면입니다'));
  };

  const showPath = (screen: ScreenNode) => {
    if (!g) return;
    const from = startOf(g);
    const p = from ? shortestPath(g.edges, from, screen.id) : undefined;
    if (!from || !p) return toast(t('첫 화면에서 이 화면까지 기록된 경로가 없습니다'), true);
    setFocus({ title: t('첫 화면 → {s} 경로', { s: screen.label }), nodes: new Set([from, ...p.map((e) => e.to)]), edges: new Set(p.map((e) => e.id)) });
  };

  const exportMap = async () => {
    const p = await run(api.graphExport(pkg));
    if (p) toast(t('지도를 내보냈습니다: {path} — 화면 스크린샷이 그대로 들어 있으니 공유 전에 확인하세요', { path: p }));
  };

  const importMap = async () => {
    const r = await run(api.graphImport(pkg));
    if (!r) return;
    await reload();
    toast(
      t('지도를 합쳤습니다: 새 화면 {n}개, 새 연결 {e}개', { n: r.nodes, e: r.edges }) +
        (r.dropped ? t(' (형식이 맞지 않아 버린 항목 {n}개)', { n: r.dropped }) : ''),
    );
  };

  const reset = async () => {
    setConfirmReset(false);
    if ((await run(api.graphReset(pkg))) !== undefined) {
      setSel(null);
      setFocus(null);
      moved.current = false;
      // 초기화 뒤 같은 이름으로 다시 기록되는 화면에 예전 스크린샷이 보이지 않게
      for (const k of [...imgCache.keys()]) if (k.startsWith(pkg)) imgCache.delete(k);
      setProgress([]);
      await reload();
      toast(t('화면 그래프를 초기화했습니다'));
    }
  };

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={start} disabled={exploring || navigating}>
          {exploring ? t('탐색 중…') : t('▶ 자동 탐색')}
        </button>
        {exploring && <button className="btn danger" onClick={() => api.exploreStop()}>{t('중지')}</button>}
        <select className="input" value={fromCurrent ? 'current' : 'launch'} onChange={(e) => setFromCurrent(e.target.value === 'current')} disabled={exploring}>
          <option value="launch">{t('앱 첫 화면부터')}</option>
          <option value="current">{t('현재 화면부터')}</option>
        </select>
        <label className="muted" title={t('시작 화면에서 몇 화면 안쪽까지 들어갈지 정합니다. 1이면 시작 화면의 버튼만 눌러 보고, 2면 거기서 열린 화면의 버튼까지 눌러 봅니다.')}>
          {t('최대 깊이')} <input className="input" type="number" min={1} max={10} value={depth} onChange={(e) => setDepth(+e.target.value)} style={{ width: 52 }} />
        </label>
        {exploring && <span className="muted">{t('버튼 {n}번 누름', { n: tapCount })}</span>}
        <button className="btn" onClick={async () => serial && (await run(api.graphRecordHere(serial, pkg))) && reload()}>{t('＋ 현재 화면 추가')}</button>
        <button className="btn" onClick={reload}>↻</button>
        <button className="btn" disabled={!g?.nodes.length} onClick={arrange} title={t('화면 카드를 자동으로 다시 배치하고 전체가 보이게 맞춥니다')}>{t('⊞ 정리')}</button>
        <button className="btn" disabled={!g?.nodes.length} onClick={exportMap} title={t('스크린샷을 포함한 지도 파일로 저장합니다. 다른 사람이 가져오면 그 사람 지도에 합쳐집니다. 화면 스크린샷(계정·메시지 등)이 그대로 들어갑니다')}>{t('내보내기')}</button>
        <button className="btn" disabled={exploring} onClick={importMap} title={t('내보낸 지도 파일을 지금 지도에 합칩니다 (같은 화면은 하나로 합침)')}>{t('가져오기')}</button>
        {confirmReset ? (
          <>
            <span className="muted">{t('이 앱의 화면과 연결을 모두 지울까요?')}</span>
            <button className="btn danger" onClick={reset}>{t('초기화')}</button>
            <button className="btn" onClick={() => setConfirmReset(false)}>{t('취소')}</button>
          </>
        ) : (
          <button className="btn" disabled={exploring || !g?.nodes.length} onClick={() => setConfirmReset(true)}>{t('그래프 초기화')}</button>
        )}
        <span className="muted">{t('화면 {n} · 전이 {e}', { n: g?.nodes.length ?? 0, e: g?.edges.length ?? 0 })}</span>
        <span
          className="faint"
          style={{ fontSize: 11, cursor: 'help' }}
          title={t('지금 화면의 누를 수 있는 버튼을 위에서부터 하나씩 누릅니다. 새 화면이 열리면 최대 깊이 안에서 그 화면으로 들어가 같은 방식으로 탐색하고, 다 보면 뒤로 가기로 돌아와 다음 버튼을 누릅니다. 결제·삭제·로그아웃·전송 같은 버튼과 뒤로·닫기는 누르지 않습니다.')}
        >
          ⓘ {t('탐색 방식')}
        </span>
      </div>
      <div className="flow" style={{ position: 'relative' }}>
        {focus && (
          <div className="flow-focus">
            {focus.title} · {t('화면 {n} · 전이 {e}', { n: focus.nodes.size, e: focus.edges.size })}
            <button className="btn sm" onClick={() => setFocus(null)}>{t('전체 보기')}</button>
          </div>
        )}
        {g && g.nodes.length ? (
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSel(n.id)}
            onNodesChange={onNodesChange}
            onInit={(i) => (rf.current = i)}
            onPaneClick={() => setSel(null)}
            fitView
            colorMode="dark"
            minZoom={0.1}
          >
            <Background gap={24} color="#22262d" />
            <Controls />
            <MiniMap pannable zoomable style={{ background: '#15171c' }} />
          </ReactFlow>
        ) : (
          <div className="empty">
            {t('아직 기록된 화면이 없습니다.')}
            <br />
            {t('자동 탐색을 실행하거나, 화면 탭에서 "화면 흐름 기록"을 켜고 직접 조작하세요.')}
          </div>
        )}
        {(selNode || progress.length > 0) && (
          <div className="flow-side">
            {selNode ? (
              <ScreenDetail
                key={selNode.id}
                g={g!}
                n={selNode}
                pkg={pkg}
                busy={exploring || navigating}
                depth={depth}
                onExplore={(only, allowDanger) => exploreFrom(selNode, only, allowDanger)}
                onNavigate={() => navigate(selNode)}
                onPath={() => showPath(selNode)}
              />
            ) : null}
            {progress.length > 0 && (
              <>
                <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>{t('탐색 로그')}</h4>
                <div className="log-mini">{progress.join('\n')}</div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const SWIPES = [
  { direction: 'up', icon: '↑' },
  { direction: 'down', icon: '↓' },
  { direction: 'left', icon: '←' },
  { direction: 'right', icon: '→' },
] as const;

const sameMove = (a: Interaction, b: Interaction) =>
  a.kind === b.kind && (a.kind === 'swipe' ? a.direction === (b as typeof a).direction : a.key === (b as typeof a).key);

function ScreenDetail({
  g,
  n,
  pkg,
  busy,
  depth,
  onExplore,
  onNavigate,
  onPath,
}: {
  g: GraphData;
  n: ScreenNode;
  pkg: string;
  busy: boolean;
  depth: number;
  onExplore(only: Interaction[], allowDanger: boolean): void;
  onNavigate(): void;
  onPath(): void;
}) {
  const t = useT();
  const src = useShot(pkg, n.screenshot);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [picks, setPicks] = useState<Interaction[]>([]);
  const [press, setPress] = useState<'tap' | 'longpress'>('tap');
  const [allowDanger, setAllowDanger] = useState(false);
  const outs = g.edges.filter((e) => e.from === n.id && e.to !== n.id);
  const ins = g.edges.filter((e) => e.to === n.id && e.from !== n.id);
  const name = (id: string) => g.nodes.find((x) => x.id === id)?.label ?? id;
  const done = triedKeys(g.edges, n);
  const targets = n.targets ?? [];
  const labelOfKey = (key: string) => targets.find((x) => x.key === key)?.label ?? key;
  // 요소를 눌러 열린 화면 (같은 요소 key 로 나간 연결)
  const leadsTo = (key: string) => outs.find((e) => actionKey(e.action) === key);

  const toggle = (m: Interaction) => setPicks((cur) => (cur.some((x) => sameMove(x, m)) ? cur.filter((x) => !sameMove(x, m)) : [...cur, m]));
  /** 요소 선택 켜고 끄기: 이미 골라 둔 요소면 (탭이든 길게 누르기든) 빼고, 아니면 지금 고른 방식으로 넣는다 */
  const toggleKey = (key: string) =>
    setPicks((cur) => (cur.some((x) => x.kind !== 'swipe' && x.key === key) ? cur.filter((x) => x.kind === 'swipe' || x.key !== key) : [...cur, { kind: press, key }]));
  const dangerPicked = picks.some((m) => m.kind !== 'swipe' && targets.find((x) => x.key === m.key)?.danger);
  const picked = (m: Interaction) => picks.some((x) => sameMove(x, m));
  const pickedKey = (key: string) => picks.some((x) => x.kind !== 'swipe' && x.key === key);

  return (
    <div>
      <div className="shot-pick">
        {src && <img src={src} alt="" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />}
        {src &&
          size &&
          targets.map((tg) => {
            const [l, tp, r, b] = tg.bounds;
            const cls = ['box', pickedKey(tg.key) && 'on', done.has(tg.key) && 'done', tg.danger && 'danger'].filter(Boolean).join(' ');
            return (
              <button
                key={tg.key}
                className={cls}
                title={`${tg.label}${tg.danger ? ' ⚠' : ''}`}
                style={{ left: `${(l / size.w) * 100}%`, top: `${(tp / size.h) * 100}%`, width: `${((r - l) / size.w) * 100}%`, height: `${((b - tp) / size.h) * 100}%` }}
                onClick={() => toggleKey(tg.key)}
              />
            );
          })}
      </div>
      <div style={{ fontWeight: 600, marginTop: 8 }}>{n.label}</div>
      <div className="btn-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={busy} onClick={onNavigate} title={t('지도에 기록된 경로를 따라 기기를 이 화면으로 옮깁니다')}>{t('이 화면으로 이동')}</button>
        <button className="btn sm" onClick={onPath} title={t('앱 첫 화면에서 이 화면까지 가는 경로만 강조합니다')}>{t('첫 화면에서 경로')}</button>
      </div>

      <h4 className="faint" style={{ margin: '12px 0 4px', fontSize: 11 }}>{t('동작 지정해서 흐름 그리기')}</h4>
      {targets.length ? (
        <div className="faint" style={{ fontSize: 11, marginBottom: 6 }}>{t('스크린샷의 상자나 아래 목록에서 누를 요소를 고르세요. 고른 것만 먼저 실행하고, 열린 화면부터는 최대 깊이만큼 이어서 탐색합니다.')}</div>
      ) : (
        <div className="faint" style={{ fontSize: 11, marginBottom: 6 }}>{t('이 화면은 요소 위치가 없는 예전 기록입니다. 한 번 다시 방문하면 스크린샷 위에서 고를 수 있습니다.')}</div>
      )}
      <div className="btn-row" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="seg">
          <button className={press === 'tap' ? 'on' : ''} onClick={() => setPress('tap')}>{t('탭')}</button>
          <button className={press === 'longpress' ? 'on' : ''} onClick={() => setPress('longpress')}>{t('길게 누르기')}</button>
        </div>
        <span className="faint" style={{ fontSize: 11, marginLeft: 4 }}>{t('스와이프')}</span>
        {SWIPES.map((sw) => (
          <button key={sw.direction} className={`btn sm ${picked({ kind: 'swipe', direction: sw.direction }) ? 'primary' : ''}`} onClick={() => toggle({ kind: 'swipe', direction: sw.direction })}>
            {sw.icon}
          </button>
        ))}
      </div>
      {picks.length > 0 && (
        <div className="picks">
          {picks.map((m, i) => (
            <span key={i} className="pill accent">
              {m.kind === 'swipe' ? `swipe ${m.direction}` : `${m.kind === 'longpress' ? '⏱ ' : ''}${labelOfKey(m.key)}`}
              <button onClick={() => toggle(m)} aria-label={t('빼기')}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="btn-row" style={{ gap: 6, marginTop: 6 }}>
        <button className="btn primary sm" disabled={busy || !picks.length} onClick={() => onExplore(picks, dangerPicked && allowDanger)}>
          {t('▶ 지정한 {n}개로 탐색 (깊이 {d})', { n: picks.length, d: depth })}
        </button>
        {picks.length > 0 && <button className="btn sm" onClick={() => setPicks([])}>{t('선택 해제')}</button>}
      </div>
      {dangerPicked && (
        <label className="chk warn-text" style={{ fontSize: 11, marginTop: 4 }}>
          <input type="checkbox" checked={allowDanger} onChange={(e) => setAllowDanger(e.target.checked)} />
          {t('⚠ 결제·삭제·전송 같은 위험 버튼이 포함돼 있습니다. 체크하면 실제로 누르고, 체크하지 않으면 건너뜁니다.')}
        </label>
      )}

      <h4 className="faint" style={{ margin: '12px 0 4px', fontSize: 11 }}>
        {t('누를 수 있는 요소 ({d}/{n} 눌러 봄)', { d: targets.filter((x) => done.has(x.key)).length, n: targets.length || n.actions.length })}
      </h4>
      {targets.length ? (
        <div className="target-list">
          {targets.map((tg) => {
            const e = leadsTo(tg.key);
            return (
              <label key={tg.key} className="chk">
                <input type="checkbox" checked={pickedKey(tg.key)} onChange={() => toggleKey(tg.key)} />
                <span className={done.has(tg.key) ? '' : 'faint'}>{tg.label || '-'}</span>
                {tg.danger && <span className="warn-text">⚠</span>}
                {e ? <span className="faint mono" style={{ fontSize: 10 }}>→ {name(e.to)}</span> : done.has(tg.key) ? <span className="faint">✓</span> : null}
              </label>
            );
          })}
        </div>
      ) : (
        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{n.actions.join(' · ')}</div>
      )}

      <div className="kv" style={{ marginTop: 10 }}>
        <span>Activity</span><span>{n.activity}</span>
        <span>{t('시그니처')}</span><span>{n.signature}</span>
        <span>{t('노드/깊이')}</span><span>{n.nodeCount} / {n.maxDepth}</span>
        <span>{t('방문')}</span><span>{n.visits}</span>
      </div>
      {ins.length > 0 && (
        <>
          <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>{t('들어오는 경로')}</h4>
          {ins.map((e) => <div key={e.id} className="mono" style={{ fontSize: 11 }}>{name(e.from)} → {actionName(e.action)}</div>)}
        </>
      )}
      {outs.length > 0 && (
        <>
          <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>{t('나가는 경로')}</h4>
          {outs.map((e) => <div key={e.id} className="mono" style={{ fontSize: 11 }}>{actionName(e.action)} → {name(e.to)}</div>)}
        </>
      )}
    </div>
  );
}
