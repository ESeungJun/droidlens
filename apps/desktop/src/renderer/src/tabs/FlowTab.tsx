import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
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

/** 시작 화면부터 BFS 깊이로 열을 나누는 단순 레이아웃 */
function layout(g: GraphData): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  if (!g.nodes.length) return pos;
  const start = [...g.nodes].sort((a, b) => a.firstSeen - b.firstSeen)[0].id;
  const level = new Map([[start, 0]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift()!;
    for (const e of g.edges) {
      if (e.from === cur && !level.has(e.to)) {
        level.set(e.to, level.get(cur)! + 1);
        q.push(e.to);
      }
    }
  }
  let maxL = Math.max(...level.values());
  for (const n of g.nodes) if (!level.has(n.id)) level.set(n.id, ++maxL);
  const cols = new Map<number, string[]>();
  for (const n of [...g.nodes].sort((a, b) => a.firstSeen - b.firstSeen)) {
    const l = level.get(n.id)!;
    cols.set(l, [...(cols.get(l) ?? []), n.id]);
  }
  for (const [l, ids] of cols) ids.forEach((id, i) => pos.set(id, { x: l * 240, y: i * 400 - ((ids.length - 1) * 400) / 2 }));
  return pos;
}

export function FlowTab() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [g, setG] = useState<GraphData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [steps, setSteps] = useState(30);
  const [depth, setDepth] = useState(3);
  const [progress, setProgress] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);

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
        if (p.screen) reload();
      }),
    [reload],
  );

  const { nodes, edges } = useMemo(() => {
    if (!g || !pkg) return { nodes: [], edges: [] };
    const pos = layout(g);
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
  }, [g, pkg, sel]);

  if (!pkg) return <NeedPkg />;
  const selNode = g?.nodes.find((n) => n.id === sel);

  const start = async () => {
    if (!serial) return;
    setExploring(true);
    setProgress([]);
    const r = await run(api.explore(serial, pkg, steps, depth));
    setExploring(false);
    await reload();
    if (r) {
      const danger = r.skipped.filter((s) => s.reason === '위험 라벨').length;
      const missing = r.skipped.length - danger;
      toast(
        t('탐색 완료: 버튼 {n}번 누름', { n: r.steps }) +
          (danger ? t(', 위험 라벨 {n}개 건너뜀', { n: danger }) : '') +
          (missing ? t(', 화면에서 못 찾은 버튼 {n}개', { n: missing }) : ''),
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
        <label className="muted" title={t('자동 탐색이 버튼을 누르는 총 횟수의 상한입니다. 클수록 더 많은 화면을 찾지만 오래 걸립니다.')}>
          {t('최대 탭 수')} <input className="input" type="number" min={1} max={300} value={steps} onChange={(e) => setSteps(+e.target.value)} style={{ width: 64 }} />
        </label>
        <label className="muted" title={t('시작 화면에서 몇 화면 안쪽까지 들어갈지 정합니다. 1이면 시작 화면의 버튼만 눌러 보고, 2면 거기서 열린 화면의 버튼까지 눌러 봅니다.')}>
          {t('최대 깊이')} <input className="input" type="number" min={1} max={10} value={depth} onChange={(e) => setDepth(+e.target.value)} style={{ width: 52 }} />
        </label>
        <button className="btn" onClick={async () => serial && (await run(api.graphRecordHere(serial, pkg))) && reload()}>{t('＋ 현재 화면 추가')}</button>
        <button className="btn" onClick={reload}>↻</button>
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
        <span className="faint" style={{ fontSize: 11 }}>{t('결제·삭제·로그아웃·전송 같은 버튼은 자동 탐색에서 누르지 않습니다')}</span>
      </div>
      <div className="flow" style={{ position: 'relative' }}>
        {g && g.nodes.length ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSel(n.id)}
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
