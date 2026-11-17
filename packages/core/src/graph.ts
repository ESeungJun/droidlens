import { DeviceAdb, sleep } from './adb.js';
import { ensureAgent } from './agent.js';
import { assertPackage } from './app.js';
import { pressKey, screenSize, swipe, swipeVector, type SwipeDirection } from './device.js';
import { actionLabel, DANGEROUS_LABELS, type GraphAction, type GraphData, type Interaction } from './graph-model.js';
import { pageWebViews } from './hierarchy.js';
import {
  candidateActions,
  dismissSystemDialog,
  launchAndSettle,
  screenId,
  targetAt,
  waitForSettle,
  captureSnapshot,
  type Snapshot,
} from './graph/snapshot.js';
import { ScreenGraph } from './graph/store.js';
import { followPath, navigateTo, performAction, pressAction, type PathStep } from './graph/navigate.js';

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
export {
  followPath,
  navigateTo,
  performAction,
  planRoute,
  recordTransition,
  startTransition,
  type PathStep,
} from './graph/navigate.js';

// ---------- 화면 그래프 ----------

export * from './graph-model.js';
// ---------- 자동 탐색 ----------

/** BACK과 같은 효과라 탐색 가치가 없는 라벨 */
const NAV_ONLY_LABELS = /^(위로 탐색|navigate up|up|뒤로|뒤로 가기|back|닫기|close)$/i;

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
