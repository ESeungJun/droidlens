import { DeviceAdb, sleep } from './adb.js';
import { ensureAgent } from './agent.js';
import { assertPackage, launchApp } from './app.js';
import { KEYCODES, longPress, pressKey, screenSize, swipe, swipeVector, tap, type SwipeDirection } from './device.js';
import {
  actionKey,
  actionLabel,
  DANGEROUS_LABELS,
  isReplayable,
  type GraphAction,
  type GraphData,
  type Interaction,
  type ScreenEdge,
  type ScreenNode,
} from './graph-model.js';
import { center, pageWebViews } from './hierarchy.js';
import {
  candidateActions,
  dismissSystemDialog,
  launchAndSettle,
  screenId,
  shortName,
  targetAt,
  waitForSettle,
  captureSnapshot,
  type Candidate,
  type Snapshot,
} from './graph/snapshot.js';
import { ScreenGraph } from './graph/store.js';

export {
  candidateActions,
  captureSnapshot,
  dismissSystemDialog,
  launchAndSettle,
  screenId,
  targetAt,
  waitForSettle,
  type Candidate,
  type Snapshot,
} from './graph/snapshot.js';
export { MAP_LIMITS, type MapBundle } from './graph/bundle.js';
export { ScreenGraph } from './graph/store.js';

// ---------- 화면 그래프 ----------

export * from './graph-model.js';

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
function pressAction(type: 'tap' | 'longpress', c: Candidate): Extract<GraphAction, { type: 'tap' | 'longpress' }> {
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

// ---------- 자동 탐색 ----------

/** BACK과 같은 효과라 탐색 가치가 없는 라벨 */
const NAV_ONLY_LABELS = /^(위로 탐색|navigate up|up|뒤로|뒤로 가기|back|닫기|close)$/i;


/** 기록한 탭·길게 누르기(id·라벨)에 해당하는 버튼을 현재 화면에서 다시 찾는다 */
function locate(s: Snapshot, a: Extract<GraphAction, { type: 'tap' | 'longpress' }>, pkg: string): Candidate | undefined {
  return candidateActions(s, pkg).find((c) => c.label === (a.label ?? '') && c.node.resourceId === (a.selector?.id ?? ''));
}

export interface ExploreOptions {
  packageName: string;
  /** 누르는 횟수의 안전 상한 (기본 500). 탐색 범위는 maxDepth 로 정하고 이건 끝없이 도는 것만 막는다 */
  maxSteps?: number;
  maxDepth?: number;
  /** true면 앱을 재시작해 첫 화면부터, false면 지금 화면부터 탐색 (기본 true). startAt 을 주면 무시 */
  relaunch?: boolean;
  /** 지도에 있는 이 화면에서 시작 (기기가 다른 화면이면 기록된 경로로 이동) */
  startAt?: string;
  /** 시작 화면에서는 이 인터랙션만 실행하고, 열린 화면부터는 maxDepth 까지 평소처럼 탐색 */
  only?: Interaction[];
  /** only 에 위험 라벨(결제·삭제 등) 요소가 있어도 누른다. 끄면 건너뛴다 (기본 false) */
  allowDanger?: boolean;
  /** 위험 라벨 외에 추가로 피할 라벨 정규식 */
  avoid?: RegExp;
  signal?: AbortSignal;
  onProgress?: (e: { step: number; message: string; screen?: string }) => void;
}

export interface ExploreResult {
  graph: GraphData;
  /** 탐색을 시작한 화면 */
  startScreen: string;
  steps: number;
  /** 안전 상한에 닿아 멈췄는지 */
  limited: boolean;
  skipped: { screen: string; label: string; reason: string }[];
  errors: string[];
  /** 이번 탐색에서 지나간 화면과 연결 (결과 강조용) */
  touched: { nodes: string[]; edges: string[] };
}

/** 한 화면에서 해 볼 행동 하나 */
interface Move {
  /** 이 화면에서 같은 행동을 두 번 하지 않기 위한 key */
  id: string;
  label: string;
  kind: Interaction['kind'];
  /** 요소를 누르는 행동이면 candidateActions 의 key */
  key?: string;
  direction?: SwipeDirection;
  /** 사용자가 직접 고른 행동 */
  explicit: boolean;
}

const REVERSE: Record<SwipeDirection, SwipeDirection> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/**
 * DFS 자동 탐색. 각 화면의 클릭 가능한 요소를 하나씩 눌러 새 화면을 그래프에 추가하고 BACK으로 복귀한다.
 * 복귀에 실패하면 앱을 재실행하고 루트에서 경로를 재생한다.
 */
export async function explore(dev: DeviceAdb, opts: ExploreOptions): Promise<ExploreResult> {
  const pkg = opts.packageName;
  assertPackage(pkg);
  const maxSteps = opts.maxSteps ?? 500;
  const maxDepth = opts.maxDepth ?? 4;
  const graph = await ScreenGraph.open(pkg);
  const tried = new Set<string>();
  const skipped: ExploreResult['skipped'] = [];
  const errors: string[] = [];
  const touched = { nodes: new Set<string>(), edges: new Set<string>() };
  let steps = 0;
  const log = (message: string, screen?: string) => opts.onProgress?.({ step: steps, message, screen });

  // 현재 화면부터 시작한 탐색은 앱을 다시 실행해 돌아오지 않는다 (사용자가 열어 둔 상태를 지우지 않게)
  const canReplay = !!opts.startAt || opts.relaunch !== false;
  let snap: Snapshot;
  if (opts.startAt) {
    snap = (await navigateTo(dev, graph, opts.startAt, log)).snap;
  } else if (opts.relaunch === false) {
    snap = await waitForSettle(dev);
    if (snap.screen.packageName !== pkg) throw new Error(`지금 화면이 ${pkg} 앱이 아닙니다. 앱을 열어 둔 상태에서 시작하세요`);
  } else {
    snap = await launchAndSettle(dev, pkg, { restart: true });
    graph.launchScreen = screenId(snap);
  }
  const root = await graph.addSnapshot(snap, dev);
  touched.nodes.add(root.id);
  log(`시작 화면: ${root.label}`, root.id);

  /** 앱을 다시 실행해 탐색 시작 화면으로 간 뒤 (다시 열 때 다른 화면이 떠도 navigateTo 가 건너간다) 경로를 따라간다 */
  const replay = async (path: PathStep[]): Promise<Snapshot> => {
    if (!canReplay) throw new Error('현재 화면부터 시작한 탐색이라 경로를 다시 따라갈 수 없습니다');
    const nav = await navigateTo(dev, graph, root.id, log);
    return followPath(dev, pkg, nav.snap, path);
  };

  /** BACK을 최대 2번(키보드·다이얼로그 닫기 포함) 눌러 원래 화면으로 돌아가고, 실패하면 재실행 후 경로 재생 */
  const returnTo = async (target: string, path: PathStep[]): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      await pressKey(dev, 'back');
      snap = await waitForSettle(dev);
      if (screenId(snap) === target) return;
      if (snap.screen.packageName && snap.screen.packageName !== pkg && i === 1) break;
    }
    if (!canReplay) {
      log('BACK 으로 돌아오지 못했습니다 (현재 화면 기준 탐색이라 이 갈래는 멈춤)');
      return;
    }
    log('BACK 복귀 실패 → 재실행 후 경로 재생');
    snap = await replay(path).catch((e: Error) => {
      log(e.message);
      // 재생이 중간에 실패하면 기기 화면은 이미 바뀌었을 수 있으니 실제 화면을 다시 잡는다
      return waitForSettle(dev).catch(() => snap);
    });
  };

  /** 이 화면에서 해 볼 행동: 시작 화면에 지정한 인터랙션이 있으면 그것만, 아니면 누를 수 있는 요소 전부 */
  const movesFor = (s: Snapshot, depth: number): Move[] => {
    const cands = candidateActions(s, pkg);
    if (depth === 0 && opts.only?.length) {
      return opts.only.map((m): Move => {
        if (m.kind === 'swipe') return { id: `swipe:${m.direction}`, label: `swipe ${m.direction}`, kind: 'swipe', direction: m.direction, explicit: true };
        const label = cands.find((c) => c.key === m.key)?.label ?? m.key.split('|').slice(1).join('|');
        return { id: `${m.kind}:${m.key}`, label, kind: m.kind, key: m.key, explicit: true };
      });
    }
    return cands.map((c) => ({ id: `tap:${c.key}`, label: c.label, kind: 'tap', key: c.key, explicit: false }));
  };

  // 이번 실행에서 이미 들어가 본 화면. 저장된 그래프의 방문 수를 쓰면 다시 탐색할 때 깊이가 무시된다
  const entered = new Set<string>();
  const visit = async (path: PathStep[], depth: number): Promise<void> => {
    const hereId = screenId(snap);
    entered.add(hereId);
    for (const move of movesFor(snap, depth)) {
      if (steps >= maxSteps || opts.signal?.aborted) return;
      const tkey = `${hereId}|${move.id}`;
      if (tried.has(tkey)) continue;
      tried.add(tkey);
      if (!move.explicit && NAV_ONLY_LABELS.test(move.label.trim())) continue;
      if (!move.explicit && (DANGEROUS_LABELS.test(move.label) || opts.avoid?.test(move.label))) {
        skipped.push({ screen: hereId, label: move.label, reason: '위험 라벨' });
        continue;
      }
      // 실제로 이 화면에 있는지 확인: 돌아오지 못했으면 다른 화면의 버튼을 이 화면 것으로 기록하게 되므로 멈춘다
      if (screenId(snap) !== hereId) {
        await returnTo(hereId, path).catch(() => undefined);
        if (screenId(snap) !== hereId) {
          errors.push(`${hereId}: 원래 화면으로 돌아오지 못해 남은 버튼은 건너뜀`);
          log('원래 화면으로 돌아오지 못해 이 화면의 남은 버튼은 건너뜁니다');
          return;
        }
      }
      let action: GraphAction;
      if (move.kind === 'swipe') {
        const [x1, y1, x2, y2] = swipeVector(await screenSize(dev), move.direction!);
        action = { type: 'swipe', x1, y1, x2, y2, direction: move.direction };
      } else {
        // 처음 본 좌표가 아니라 지금 화면에서 같은 버튼을 다시 찾는다 (돌아왔을 때 스크롤 위치가 바뀌었을 수 있다)
        const cand = candidateActions(snap, pkg).find((c) => c.key === move.key);
        if (!cand) {
          skipped.push({ screen: hereId, label: move.label, reason: '현재 화면에서 찾을 수 없음' });
          continue;
        }
        // 직접 고른 것도 위험 여부는 지도 파일이 아니라 지금 기기 화면의 라벨로 판단한다
        if (move.explicit && !opts.allowDanger && DANGEROUS_LABELS.test(cand.label)) {
          skipped.push({ screen: hereId, label: cand.label, reason: '위험 라벨 (허용하지 않음)' });
          continue;
        }
        action = pressAction(move.kind, cand);
        graph.markTried(hereId, cand.key);
      }
      const name = actionLabel(action);
      steps++;
      try {
        await performAction(dev, action, pkg);
        let after = await waitForSettle(dev);
        const dialog = await dismissSystemDialog(dev, after);
        if (dialog) {
          errors.push(`${hereId} ${name}: ${dialog === 'anr' ? 'ANR (응답 없음)' : '크래시'} 대화상자`);
          log(`${name} → ${dialog === 'anr' ? 'ANR' : '크래시'} 감지, 기록 후 계속`);
          after = await waitForSettle(dev);
        }
        // 웹 페이지는 누른 뒤 위치·네트워크 응답을 받고 나서야 넘어가기도 해서, 그대로면 한 번 더 기다려 본다
        if (screenId(after) === hereId && pageWebViews(after.hierarchy.root).length) {
          await sleep(1500);
          after = await waitForSettle(dev);
        }
        if (after.screen.packageName && after.screen.packageName !== pkg) {
          log(`${name} → 앱 밖(${after.screen.packageName}), 복귀`);
          await returnTo(hereId, path);
          continue;
        }
        const to = await graph.addSnapshot(after, dev);
        if (to.id === hereId) {
          if (move.explicit) log(`${name} → 같은 화면 (화면이 바뀌지 않음)`, hereId);
          snap = after;
          continue;
        }
        const edge = graph.addEdge(hereId, to.id, action);
        touched.nodes.add(to.id);
        touched.edges.add(edge.id);
        graph.saveSoon();
        log(`${name} → ${to.label}`, to.id);
        snap = after;
        if (depth + 1 < maxDepth && !entered.has(to.id)) await visit([...path, { action, to: to.id }], depth + 1);
        // 페이저처럼 스와이프로 넘긴 화면은 BACK 보다 반대로 스와이프하는 쪽이 원래 화면으로 돌아온다
        if (screenId(snap) !== hereId && action.type === 'swipe' && move.direction) {
          const [x1, y1, x2, y2] = swipeVector(await screenSize(dev), REVERSE[move.direction]);
          await swipe(dev, x1, y1, x2, y2);
          snap = await waitForSettle(dev);
        }
        if (screenId(snap) !== hereId) await returnTo(hereId, path);
      } catch (e) {
        errors.push(`${hereId} ${name}: ${(e as Error).message}`);
        // 오류가 나면 지금 화면을 알 수 없으므로 경로를 다시 따라가거나, 그것도 안 되면 실제 화면을 다시 잡는다.
        // 누르기 전 스냅샷을 그대로 두면 다음 버튼을 다른 화면에 누르고 엉뚱한 연결을 기록하게 된다
        snap = await replay(path).catch(() => waitForSettle(dev)).catch(() => snap);
      }
    }
  };

  try {
    await visit([], 0);
  } finally {
    await graph.save();
  }
  log(`탐색 완료: 화면 ${graph.nodes.size}개, 전이 ${graph.edges.size}개, ${steps}스텝`);
  return {
    graph: graph.toJSON(),
    startScreen: root.id,
    steps,
    limited: steps >= maxSteps,
    skipped,
    errors,
    touched: { nodes: [...touched.nodes], edges: [...touched.edges] },
  };
}

// ---------- 지도 자동 수집 ----------

/** 수집기에 알려 주는 방금 한 행동. 누른 좌표는 직전 화면의 요소로 바꿔 기록한다 */
export type NotedAction =
  | { type: 'tap' | 'longpress'; x: number; y: number }
  | { type: 'swipe'; direction: SwipeDirection }
  | { type: 'key'; key: string }
  | { type: 'deeplink'; uri: string };

/**
 * 다른 기능(시나리오 실행 등)이 기기를 조작하는 동안 지나간 화면과 연결을 앱 지도에 모은다.
 * 조작 전에 note() 로 행동을 알리고 조작 뒤 observe() 를 부르면, 직전에 본 화면에서 그 행동으로 왔다고 연결한다.
 * 조작이 실패하면 forget() 으로 이어 붙이지 않게 한다.
 * 에이전트가 없으면 화면 확인(uiautomator dump)이 1~2초씩 걸려 원래 작업을 늦추므로 모으지 않는다.
 * 실패해도 원래 작업에 영향을 주지 않게 오류는 삼킨다.
 */
export class FlowCollector {
  private last?: Snapshot;
  private pending?: NotedAction;

  private constructor(private readonly dev: DeviceAdb, readonly graph: ScreenGraph) {}

  static async open(dev: DeviceAdb, pkg: string): Promise<FlowCollector | undefined> {
    if (!(await ensureAgent(dev).catch(() => undefined))) return undefined;
    return new FlowCollector(dev, await ScreenGraph.open(pkg));
  }

  note(a: NotedAction): void {
    this.pending = a;
  }

  /** 조작이 실패해 화면 상태를 알 수 없을 때: 다음 관찰부터 새로 시작한다 */
  forget(): void {
    this.pending = undefined;
    this.last = undefined;
  }

  /** 지금 화면을 지도에 모은다. 확인한 스냅샷을 돌려줘 호출부가 같은 조회를 다시 하지 않게 한다 (실패하면 undefined) */
  async observe(): Promise<Snapshot | undefined> {
    const noted = this.pending;
    this.pending = undefined;
    try {
      const s = await captureSnapshot(this.dev, { screenshot: false });
      if (s.screen.packageName !== this.graph.packageName) {
        this.last = undefined;
        return s;
      }
      const node = await this.graph.addSnapshot(s, this.dev);
      const prev = this.last && screenId(this.last);
      if (noted && this.last && prev !== node.id) {
        const action = await this.toAction(noted, this.last, prev!);
        if (action) this.graph.addEdge(prev!, node.id, action);
      }
      this.last = s;
      this.graph.saveSoon();
      return s;
    } catch {
      this.last = undefined;
      return undefined;
    }
  }

  /** 모아 둔 기록을 파일에 마저 쓴다 (수집을 끝낼 때 부른다) */
  flush(): Promise<void> {
    return this.graph.flush();
  }

  private async toAction(a: NotedAction, before: Snapshot, from: string): Promise<GraphAction | undefined> {
    if (a.type === 'tap' || a.type === 'longpress') {
      const c = targetAt(before, this.graph.packageName, a.x, a.y);
      if (!c) return { type: a.type, x: a.x, y: a.y };
      this.graph.markTried(from, c.key);
      return { ...pressAction(a.type, c), x: a.x, y: a.y };
    }
    if (a.type === 'swipe') {
      const [x1, y1, x2, y2] = swipeVector(await screenSize(this.dev), a.direction);
      return { type: 'swipe', x1, y1, x2, y2, direction: a.direction };
    }
    return a;
  }
}
