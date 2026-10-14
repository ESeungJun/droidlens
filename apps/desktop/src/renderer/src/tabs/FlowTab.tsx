import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Graph, layout as dagreLayout } from '@dagrejs/dagre';
import { api, type GraphData, type ScreenNode } from '../api';
import { NeedPkg, useApp } from '../App';
import { useT } from '../i18n';

const imgCache = new Map<string, string>();

function useShot(pkg: string, file?: string) {
  const [src, setSrc] = useState(file ? imgCache.get(pkg + file) : undefined);
  useEffect(() => {
    if (!file || imgCache.has(pkg + file)) return;
    api.graphImage(pkg, file).then((d) => {
      imgCache.set(pkg + file, d);
      setSrc(d);
    }).catch(() => undefined);
  }, [pkg, file]);
  return src;
}

type SNodeData = { screen: ScreenNode; pkg: string; selected: boolean };

const ScreenCard = memo(({ data }: NodeProps<Node<SNodeData>>) => {
  const src = useShot(data.pkg, data.screen.screenshot);
  const t = useT();
  return (
    <div className={`screen-node ${data.selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      {src ? <img src={src} alt="" /> : <img alt="" />}
      <div className="t" title={data.screen.label}>{data.screen.label}</div>
      <div className="s">{data.screen.signature} · {t('{n}회', { n: data.screen.visits })}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { screen: ScreenCard };

type Pos = { x: number; y: number };
// 화면 카드 크기 (styles.css .screen-node 150px + 여백, 세로 스크린샷 기준)
const CARD_W = 162;
const CARD_H = 380;

/** 화면 흐름을 왼쪽 → 오른쪽 계층으로 배치 (연결이 겹치지 않게 dagre 로 정렬) */
function layout(g: GraphData): Map<string, Pos> {
  const d = new Graph();
  d.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 110, marginx: 20, marginy: 20 });
  d.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) d.setNode(n.id, { width: CARD_W, height: CARD_H });
  for (const e of g.edges) if (e.from !== e.to && d.hasNode(e.from) && d.hasNode(e.to)) d.setEdge(e.from, e.to);
  dagreLayout(d);
  const pos = new Map<string, Pos>();
  // dagre 는 카드 중심 좌표를 준다 → React Flow 는 왼쪽 위 기준
  for (const n of g.nodes) {
    const p = d.node(n.id);
    pos.set(n.id, { x: p.x - CARD_W / 2, y: p.y - CARD_H / 2 });
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
  // 카드 위치: 처음엔 자동 배치, 사용자가 드래그하면 그 위치를 유지하고 '정리'로 다시 자동 배치
  const [pos, setPos] = useState<Map<string, Pos>>(new Map());
  const moved = useRef(false);
  const rf = useRef<ReactFlowInstance<Node<SNodeData>, Edge> | null>(null);

  const arrange = useCallback(() => {
    if (!g) return;
    moved.current = false;
    setPos(layout(g));
    requestAnimationFrame(() => rf.current?.fitView({ padding: 0.15, duration: 300 }));
  }, [g]);

  // 그래프가 바뀌면: 직접 옮긴 적이 없으면 전체 다시 배치, 옮겼으면 새 화면만 자동 위치에 추가
  useEffect(() => {
    if (!g) return;
    const auto = layout(g);
    setPos((cur) => {
      if (!moved.current) return auto;
      const next = new Map(cur);
      for (const [id, p] of auto) if (!next.has(id)) next.set(id, p);
      return next;
    });
  }, [g]);

  const onNodesChange = useCallback((changes: NodeChange<Node<SNodeData>>[]) => {
    const drags = changes.filter((c) => c.type === 'position' && c.position);
    if (!drags.length) return;
    moved.current = true;
    setPos((cur) => {
      const next = new Map(cur);
      for (const c of drags) if (c.type === 'position' && c.position) next.set(c.id, c.position);
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    if (pkg) setG((await run(api.graphGet(pkg))) ?? null);
  }, [pkg, run]);

  useEffect(() => {
    setSel(null);
    reload();
  }, [reload]);

  useEffect(
    () =>
      api.onProgress((p) => {
        if (p.kind !== 'explore') return;
        setProgress((l) => [`#${p.step} ${p.message}`, ...l].slice(0, 200));
        if (p.step !== undefined) setTapCount(p.step);
        if (p.screen) reload();
      }),
    [reload],
  );

  const { nodes, edges } = useMemo(() => {
    if (!g || !pkg) return { nodes: [], edges: [] };
    const nodes: Node<SNodeData>[] = g.nodes.map((n) => ({
      id: n.id,
      type: 'screen',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { screen: n, pkg, selected: n.id === sel },
    }));
    const edges: Edge[] = g.edges
      .filter((e) => e.from !== e.to)
      .map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.action.type === 'tap' ? (e.action.label ?? 'tap') : e.action.type === 'key' ? e.action.key : e.action.type,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: sel && (e.from === sel || e.to === sel) ? '#7dd3a8' : '#4a505c' },
        animated: !!sel && e.from === sel,
      }));
    return { nodes, edges };
  }, [g, pkg, sel, pos]);

  if (!pkg) return <NeedPkg />;
  const selNode = g?.nodes.find((n) => n.id === sel);

  const start = async () => {
    if (!serial) return;
    setExploring(true);
    setProgress([]);
    setTapCount(0);
    const r = await run(api.explore(serial, pkg, depth, fromCurrent));
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

  const reset = async () => {
    setConfirmReset(false);
    if ((await run(api.graphReset(pkg))) !== undefined) {
      setSel(null);
      setProgress([]);
      await reload();
      toast(t('화면 그래프를 초기화했습니다'));
    }
  };

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={start} disabled={exploring}>
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
        {g && g.nodes.length ? (
          <ReactFlow
            nodes={nodes}
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
            {selNode ? <ScreenDetail g={g!} n={selNode} pkg={pkg} /> : null}
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

function ScreenDetail({ g, n, pkg }: { g: GraphData; n: ScreenNode; pkg: string }) {
  const t = useT();
  const src = useShot(pkg, n.screenshot);
  const outs = g.edges.filter((e) => e.from === n.id && e.to !== n.id);
  const ins = g.edges.filter((e) => e.to === n.id && e.from !== n.id);
  const name = (id: string) => g.nodes.find((x) => x.id === id)?.label ?? id;
  return (
    <div>
      {src && <img src={src} alt="" />}
      <div style={{ fontWeight: 600, marginTop: 8 }}>{n.label}</div>
      <div className="kv" style={{ marginTop: 6 }}>
        <span>Activity</span><span>{n.activity}</span>
        <span>{t('시그니처')}</span><span>{n.signature}</span>
        <span>{t('노드/깊이')}</span><span>{n.nodeCount} / {n.maxDepth}</span>
        <span>{t('방문')}</span><span>{n.visits}</span>
      </div>
      {ins.length > 0 && (
        <>
          <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>{t('들어오는 경로')}</h4>
          {ins.map((e) => <div key={e.id} className="mono" style={{ fontSize: 11 }}>{name(e.from)} → {e.action.type === 'tap' ? e.action.label : e.action.type}</div>)}
        </>
      )}
      {outs.length > 0 && (
        <>
          <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>{t('나가는 경로')}</h4>
          {outs.map((e) => <div key={e.id} className="mono" style={{ fontSize: 11 }}>{e.action.type === 'tap' ? e.action.label : e.action.type} → {name(e.to)}</div>)}
        </>
      )}
      <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>{t('탭 가능한 요소 ({n})', { n: n.actions.length })}</h4>
      <div className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{n.actions.join(' · ')}</div>
    </div>
  );
}
