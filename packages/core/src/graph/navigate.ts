/**
 * 기기에서 행동하고 화면 지도를 따라 움직이기: 행동 실행(performAction), 행동 전후 화면을 지도에 기록(recordTransition·startTransition),
 * 기록된 경로 다시 따라가기(followPath), 지금 화면에서 목표 화면까지 단계 짜기(planRoute), 앱을 다시 열고 그 화면으로 이동(navigateTo).
 * 다시 따라갈 때는 기록된 좌표 대신 같은 요소를 지금 화면에서 다시 찾아 누르고, 위험 버튼·다시 실행할 수 없는 연결은 쓰지 않는다.
 * 자동 탐색(explore)·흐름 수집(flow)·MCP graph 도구가 쓴다.
 */
import type { DeviceAdb } from '../adb.js';
import { launchApp } from '../app.js';
import { KEYCODES, longPress, pressKey, screenSize, swipe, swipeVector, tap } from '../device.js';
import {
  actionKey,
  actionLabel,
  DANGEROUS_LABELS,
  isReplayable,
  type GraphAction,
  type ScreenEdge,
  type ScreenNode,
} from '../graph-model.js';
import { center } from '../hierarchy.js';
import {
  candidateActions,
  captureSnapshot,
  launchAndSettle,
  screenId,
  shortName,
  targetAt,
  waitForSettle,
  type Candidate,
  type Snapshot,
} from './snapshot.js';
import type { ScreenGraph } from './store.js';

// ---------- 행동 실행 ----------

export async function performAction(dev: DeviceAdb, a: GraphAction, pkg?: string): Promise<void> {
  switch (a.type) {
    case 'tap':
      return tap(dev, a.x, a.y);
    case 'longpress':
      return longPress(dev, a.x, a.y);
    case 'swipe':
      return swipe(dev, a.x1, a.y1, a.x2, a.y2, a.durationMs);
    case 'key':
      // 가져온 지도 파일의 값일 수 있으므로 아는 키 이름만 누른다
      if (!Object.hasOwn(KEYCODES, a.key)) throw new Error(`알 수 없는 키: ${a.key}`);
      return pressKey(dev, a.key as keyof typeof KEYCODES);
    case 'launch':
      if (!pkg) throw new Error('launch에는 패키지가 필요합니다');
      return launchApp(dev, pkg);
    case 'deeplink':
    case 'manual':
      return;
  }
}

/** 요소를 누르는 행동 (탭·길게 누르기). 다시 찾을 수 있도록 라벨과 셀렉터를 함께 남긴다 */
export function pressAction(type: 'tap' | 'longpress', c: Candidate): Extract<GraphAction, { type: 'tap' | 'longpress' }> {
  const { x, y } = center(c.node);
  return { type, x, y, label: c.label, selector: c.node.resourceId ? { id: c.node.resourceId } : { text: c.node.text || undefined } };
}

/**
 * 행동 전후 화면을 그래프에 기록. 탭·길게 누르기는 누른 자리의 요소로 바꿔 남겨서 (셀렉터·라벨로 기록돼 와도)
 * 나중에 경로를 다시 따라갈 때 위치가 달라져도 같은 요소를 찾을 수 있게 하고, 그 요소를 눌러 봤다고 표시한다.
 */
export async function recordTransition(
  dev: DeviceAdb,
  graph: ScreenGraph,
  action: GraphAction,
  before?: Snapshot,
): Promise<{ from: ScreenNode; to: ScreenNode; edge: ScreenEdge; after: Snapshot }> {
  return (await startTransition(dev, graph, action, before)).finish();
}

/**
 * recordTransition 을 두 단계로 나눈 것: 행동 전 화면을 지도에 올리고 행동을 보낸 뒤 돌아온다.
 * finish 가 도착 화면이 안정되길 기다려 연결을 저장한다. 그 사이 signal 이 취소되면 저장하지 않는다
 * (기다리는 동안 다른 조작이 들어와 도착 화면이 이 행동의 결과가 아니게 된 경우).
 */
export async function startTransition(
  dev: DeviceAdb,
  graph: ScreenGraph,
  action: GraphAction,
  before?: Snapshot,
): Promise<{ finish(signal?: AbortSignal): Promise<{ from: ScreenNode; to: ScreenNode; edge: ScreenEdge; after: Snapshot }> }> {
  const b = before ?? (await captureSnapshot(dev, { screenshot: false }));
  const from = await graph.addSnapshot(b, dev);
  let act = action;
  let target: Candidate | undefined;
  if (action.type === 'tap' || action.type === 'longpress') {
    target = targetAt(b, graph.packageName, action.x, action.y);
    if (target) act = { ...pressAction(action.type, target), x: action.x, y: action.y };
  }
  await performAction(dev, act, graph.packageName);
  return {
    async finish(signal) {
      // 안정된 화면을 받은 뒤에 취소되지 않았다면 그 화면은 다음 조작 전에 찍힌 것이라 이 행동의 결과다
      const after = await waitForSettle(dev, { signal });
      signal?.throwIfAborted();
      // 눌러 봤다는 표시는 연결과 함께 남긴다 (연결 없이 표시만 남으면 탐색이 그 요소를 다시 누르지 않는다)
      if (target) graph.markTried(from.id, target.key);
      const to = await graph.addSnapshot(after, dev);
      const edge = graph.addEdge(from.id, to.id, act);
      await graph.save();
      return { from, to, edge, after };
    },
  };
}

/** 경로의 한 단계: 이 행동을 하면 이 화면에 도착해야 한다 */
export type PathStep = Pick<ScreenEdge, 'action' | 'to'>;

/**
 * 기록된 경로를 지금 화면부터 차례로 다시 실행. 탭·길게 누르기는 기록한 좌표가 아니라
 * 같은 요소(라벨·리소스 id)를 지금 화면에서 다시 찾아 누른다.
 * 위험 버튼·앱 밖으로 나가는 키·다시 실행할 수 없는 연결은 누르지 않고, 단계마다 기록된 화면에 도착했는지 확인해
 * 어긋나면 멈춘다 (엉뚱한 화면에서 다음 단계를 누르지 않게).
 */
export async function followPath(dev: DeviceAdb, pkg: string, start: Snapshot, path: PathStep[]): Promise<Snapshot> {
  let s = start;
  for (const { action: a, to } of path) {
    if (!isReplayable(a)) throw new Error(`다시 실행하지 않는 동작이라 멈춥니다: ${actionLabel(a)}`);
    // 기록된 좌표·시간은 쓰지 않는다: 요소는 지금 화면에서 다시 찾아 그 중심을 누르고, 스와이프는 방향으로 다시 계산한다
    if (a.type === 'tap' || a.type === 'longpress') {
      const c = locate(s, a, pkg);
      if (!c) throw new Error(`경로 재생 실패: "${a.label}"을(를) 찾을 수 없습니다`);
      if (DANGEROUS_LABELS.test(c.label)) throw new Error(`위험 버튼("${c.label}")을 누르게 되어 멈춥니다`);
      const { x, y } = center(c.node);
      await (a.type === 'tap' ? tap(dev, x, y) : longPress(dev, x, y));
    } else if (a.type === 'swipe') {
      const [x1, y1, x2, y2] = swipeVector(await screenSize(dev), a.direction!);
      await swipe(dev, x1, y1, x2, y2);
    } else await pressKey(dev, 'back');
    s = await waitForSettle(dev);
    if (screenId(s) !== to) throw new Error(`경로를 따라가다 예상과 다른 화면(${s.screen.packageName} ${shortName(s.screen.activity)})에 도착해 멈췄습니다`);
  }
  return s;
}

/**
 * 지금 화면에서 target 까지 다시 따라갈 단계. 기록된 연결이 있으면 그대로 쓴다.
 * 없으면 (다시 열 때 마지막 탭을 띄우는 앱처럼 지도의 첫 화면과 다른 화면에서 시작하면) 지금 화면에 있는 같은 요소를
 * 실마리로 아는 화면으로 건너간 뒤 기록된 경로를 따른다:
 * - 다른 화면에서 같은 요소(key)를 눌러 간 연결이 있으면 그 도착 화면
 * - 그 요소가 선택된 상태(선택된 탭)로 기록된 화면
 * 건너가는 첫 단계는 짐작이므로 followPath 가 도착 화면을 확인해 어긋나면 멈춘다. 위험 라벨 요소는 쓰지 않는다.
 */
export function planRoute(graph: ScreenGraph, s: Snapshot, target: string): PathStep[] | undefined {
  const here = screenId(s);
  if (here === target) return [];
  const direct = graph.replayPath(here, target);
  if (direct) return direct;
  const cands = new Map(
    candidateActions(s, graph.packageName)
      .filter((c) => !DANGEROUS_LABELS.test(c.label))
      .map((c) => [c.key, c]),
  );
  // 도착 화면 → 지금 화면에서 누를 요소
  const hops = new Map<string, { c: Candidate; type: 'tap' | 'longpress' }>();
  for (const e of graph.edges.values()) {
    const k = isReplayable(e.action) ? actionKey(e.action) : undefined;
    const c = k ? cands.get(k) : undefined;
    if (c && e.to !== here && !hops.has(e.to)) hops.set(e.to, { c, type: e.action.type === 'longpress' ? 'longpress' : 'tap' });
  }
  for (const n of graph.nodes.values()) {
    if (n.id === here || hops.has(n.id)) continue;
    const k = n.selectedKeys?.find((x) => cands.has(x));
    if (k) hops.set(n.id, { c: cands.get(k)!, type: 'tap' });
  }
  let best: PathStep[] | undefined;
  for (const [to, { c, type }] of hops) {
    const rest = to === target ? [] : graph.replayPath(to, target);
    if (rest && (!best || rest.length + 1 < best.length)) best = [{ action: pressAction(type, c), to }, ...rest];
  }
  return best;
}

/**
 * 지도에 기록된 경로를 따라 기기를 그 화면으로 옮긴다. 이미 그 화면이면 그대로 두고,
 * 아니면 앱을 다시 실행해 뜬 화면에서 planRoute 로 짠 단계를 따라간다.
 * 기록에 없던 첫 단계로 도착했으면 그 연결을 지도에 배운다 (다음부터는 기록된 경로로 간다).
 */
export async function navigateTo(
  dev: DeviceAdb,
  graph: ScreenGraph,
  target: string,
  log: (m: string) => void = () => undefined,
): Promise<{ snap: Snapshot; path: PathStep[]; moved: boolean }> {
  const pkg = graph.packageName;
  if (!graph.nodes.has(target)) throw new Error('지도에 없는 화면입니다');
  const here = await waitForSettle(dev);
  if (screenId(here) === target) return { snap: here, path: [], moved: false };
  const launched = await launchAndSettle(dev, pkg, { restart: true });
  const root = screenId(launched);
  graph.launchScreen = root;
  await graph.addSnapshot(launched, dev);
  await graph.save();
  const path = planRoute(graph, launched, target);
  if (!path) {
    throw new Error(
      graph.path(root, target)
        ? '위험 버튼·딥링크·앱 밖 이동을 거치는 경로만 기록돼 있어 자동으로 이동하지 않습니다. 기기에서 직접 이 화면을 열어 두고 다시 시도하세요'
        : '앱 첫 화면에서 이 화면까지 기록된 경로가 없습니다. 기기에서 직접 이 화면을 열어 두고 다시 시도하세요',
    );
  }
  if (!path.length) return { snap: launched, path, moved: true };
  log(`기록된 경로로 이동: ${path.map((e) => actionLabel(e.action)).join(' → ')}`);
  const snap = await followPath(dev, pkg, launched, path);
  if (![...graph.edges.values()].some((e) => e.from === root && e.to === path[0].to)) {
    graph.addEdge(root, path[0].to, path[0].action);
    await graph.save();
  }
  return { snap, path, moved: true };
}

/** 기록한 탭·길게 누르기(id·라벨)에 해당하는 버튼을 현재 화면에서 다시 찾는다 */
function locate(s: Snapshot, a: Extract<GraphAction, { type: 'tap' | 'longpress' }>, pkg: string): Candidate | undefined {
  return candidateActions(s, pkg).find((c) => c.label === (a.label ?? '') && c.node.resourceId === (a.selector?.id ?? ''));
}
