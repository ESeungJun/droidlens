import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { api, type GraphData, type ScreenNode } from '../api';
import { NeedPkg, useApp } from '../App';

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
  return (
    <div className={`screen-node ${data.selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      {src ? <img src={src} alt="" /> : <img alt="" />}
      <div className="t" title={data.screen.label}>{data.screen.label}</div>
      <div className="s">{data.screen.signature} · {data.screen.visits}회</div>
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
  const [g, setG] = useState<GraphData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [steps, setSteps] = useState(30);
  const [depth, setDepth] = useState(3);
  const [progress, setProgress] = useState<string[]>([]);

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
    if (r) toast(`탐색 완료: ${r.steps}스텝${r.skipped.length ? `, 위험 라벨 ${r.skipped.length}개 건너뜀` : ''}`);
  };

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={start} disabled={exploring}>
          {exploring ? '탐색 중…' : '▶ 자동 탐색'}
        </button>
        {exploring && <button className="btn danger" onClick={() => api.exploreStop()}>중지</button>}
        <label className="muted">스텝 <input className="input" type="number" min={1} max={300} value={steps} onChange={(e) => setSteps(+e.target.value)} style={{ width: 64 }} /></label>
        <label className="muted">깊이 <input className="input" type="number" min={1} max={10} value={depth} onChange={(e) => setDepth(+e.target.value)} style={{ width: 52 }} /></label>
        <button className="btn" onClick={async () => serial && (await run(api.graphRecordHere(serial, pkg))) && reload()}>＋ 현재 화면 추가</button>
        <button className="btn" onClick={reload}>↻</button>
        <span className="muted">화면 {g?.nodes.length ?? 0} · 전이 {g?.edges.length ?? 0}</span>
        <span className="faint" style={{ fontSize: 11 }}>결제·삭제·로그아웃·전송 같은 버튼은 자동 탐색에서 누르지 않습니다</span>
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
            아직 기록된 화면이 없습니다.
            <br />
            자동 탐색을 실행하거나, 화면 탭에서 "화면 흐름 기록"을 켜고 직접 조작하세요.
          </div>
        )}
        {(selNode || progress.length > 0) && (
          <div className="flow-side">
            {selNode ? <ScreenDetail g={g!} n={selNode} pkg={pkg} /> : null}
            {progress.length > 0 && (
              <>
                <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>탐색 로그</h4>
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
        <span>시그니처</span><span>{n.signature}</span>
        <span>노드/깊이</span><span>{n.nodeCount} / {n.maxDepth}</span>
        <span>방문</span><span>{n.visits}</span>
      </div>
      {ins.length > 0 && (
        <>
          <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>들어오는 경로</h4>
          {ins.map((e) => <div key={e.id} className="mono" style={{ fontSize: 11 }}>{name(e.from)} → {e.action.type === 'tap' ? e.action.label : e.action.type}</div>)}
        </>
      )}
      {outs.length > 0 && (
        <>
          <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>나가는 경로</h4>
          {outs.map((e) => <div key={e.id} className="mono" style={{ fontSize: 11 }}>{e.action.type === 'tap' ? e.action.label : e.action.type} → {name(e.to)}</div>)}
        </>
      )}
      <h4 className="faint" style={{ margin: '10px 0 4px', fontSize: 11 }}>탭 가능한 요소 ({n.actions.length})</h4>
      <div className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{n.actions.join(' · ')}</div>
    </div>
  );
}
