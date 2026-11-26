/**
 * 자동 탐색 explore(): 시작 화면부터 누를 수 있는 요소를 하나씩 눌러 새 화면을 지도에 올리고(깊이 우선),
 * BACK·반대 스와이프로 돌아온다. 돌아오지 못하면 앱을 다시 열어 기록된 경로로 원래 화면까지 간다.
 * 확인 필수 라벨(결제·삭제 등)·뒤로 가기와 같은 버튼은 누르지 않는다. MCP explore 도구·데스크톱 흐름 탭이 부른다.
 */
import { DeviceAdb, sleep } from '../adb.js';
import { assertPackage } from '../app.js';
import { pressKey, screenSize, swipe, swipeVector, type SwipeDirection } from '../device.js';
import { actionLabel, DANGEROUS_LABELS, type GraphAction, type GraphData, type Interaction, type ScreenNode } from '../graph-model.js';
import { pageWebViews } from '../hierarchy.js';
import { followPath, navigateTo, performAction, pressAction, type PathStep } from './navigate.js';
import { candidateActions, dismissSystemDialog, launchAndSettle, screenId, waitForSettle, type Snapshot } from './snapshot.js';
import { ScreenGraph } from './store.js';

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
  /** only 에 확인 필수 라벨(결제·삭제 등) 요소가 있어도 누른다. 끄면 건너뛴다 (기본 false) */
  allowDanger?: boolean;
  /** 확인 필수 라벨 외에 추가로 피할 라벨 정규식 */
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
  const run = new Exploration(dev, opts, await ScreenGraph.open(pkg));
  await run.start();
  try {
    await run.visit([], 0);
  } finally {
    await run.graph.save();
  }
  run.log(`탐색 완료: 화면 ${run.graph.nodes.size}개, 전이 ${run.graph.edges.size}개, ${run.steps}스텝`);
  return run.result();
}

/**
 * explore() 한 번의 실행 상태와 단계. 단계 함수들이 지금 기기 화면(snap)·누른 횟수(steps)를 같이 쓴다.
 * 흐름: start(시작 화면) → visit(화면마다 행동 고르기) → tryMove(누르고 기다리기 → 지도에 올리기 → 더 들어가기 → 돌아오기).
 * 돌아오기는 returnTo(BACK 두 번) → 실패하면 replay(앱 다시 실행 + 경로 재생).
 */
class Exploration {
  readonly pkg: string;
  readonly maxSteps: number;
  readonly maxDepth: number;
  steps = 0;
  /** 이번 실행에서 해 본 `화면 id|행동 id` */
  private readonly tried = new Set<string>();
  private readonly skipped: ExploreResult['skipped'] = [];
  private readonly errors: string[] = [];
  private readonly touched = { nodes: new Set<string>(), edges: new Set<string>() };
  // 이번 실행에서 이미 들어가 본 화면. 저장된 그래프의 방문 수를 쓰면 다시 탐색할 때 깊이가 무시된다
  private readonly entered = new Set<string>();
  /** 현재 화면부터 시작한 탐색은 앱을 다시 실행해 돌아오지 않는다 (사용자가 열어 둔 상태를 지우지 않게) */
  private readonly canReplay: boolean;
  /** 마지막으로 확인한 기기 화면 */
  private snap!: Snapshot;
  /** 탐색을 시작한 화면 */
  private root!: ScreenNode;

  constructor(
    private readonly dev: DeviceAdb,
    private readonly opts: ExploreOptions,
    readonly graph: ScreenGraph,
  ) {
    this.pkg = opts.packageName;
    this.maxSteps = opts.maxSteps ?? 500;
    this.maxDepth = opts.maxDepth ?? 4;
    this.canReplay = !!opts.startAt || opts.relaunch !== false;
  }

  readonly log = (message: string, screen?: string): void => this.opts.onProgress?.({ step: this.steps, message, screen });

  /** 시작 화면 잡기: startAt 이면 기록된 경로로 그 화면까지, relaunch:false 면 지금 화면, 아니면 앱을 다시 실행한 첫 화면 */
  async start(): Promise<void> {
    const { dev, graph, opts, pkg } = this;
    if (opts.startAt) {
      this.snap = (await navigateTo(dev, graph, opts.startAt, this.log)).snap;
    } else if (opts.relaunch === false) {
      this.snap = await waitForSettle(dev);
      if (this.snap.screen.packageName !== pkg) throw new Error(`지금 화면이 ${pkg} 앱이 아닙니다. 앱을 열어 둔 상태에서 시작하세요`);
    } else {
      this.snap = await launchAndSettle(dev, pkg, { restart: true });
      graph.launchScreen = screenId(this.snap);
    }
    this.root = await graph.addSnapshot(this.snap, dev);
    this.touched.nodes.add(this.root.id);
    this.log(`시작 화면: ${this.root.label}`, this.root.id);
  }

  result(): ExploreResult {
    return {
      graph: this.graph.toJSON(),
      startScreen: this.root.id,
      steps: this.steps,
      limited: this.steps >= this.maxSteps,
      skipped: this.skipped,
      errors: this.errors,
      touched: { nodes: [...this.touched.nodes], edges: [...this.touched.edges] },
    };
  }

  /** 지금 화면(depth 단계)에서 해 볼 행동을 하나씩 시도한다. 상한·취소·돌아오지 못함이면 이 화면을 그만둔다 */
  async visit(path: PathStep[], depth: number): Promise<void> {
    const hereId = screenId(this.snap);
    this.entered.add(hereId);
    for (const move of this.movesFor(this.snap, depth)) {
      if (this.steps >= this.maxSteps || this.opts.signal?.aborted) return;
      const tkey = `${hereId}|${move.id}`;
      if (this.tried.has(tkey)) continue;
      this.tried.add(tkey);
      if (this.skipByLabel(move, hereId)) continue;
      // 실제로 이 화면에 있는지 확인: 돌아오지 못했으면 다른 화면의 버튼을 이 화면 것으로 기록하게 되므로 멈춘다
      if (screenId(this.snap) !== hereId && !(await this.backHere(hereId, path))) return;
      const action = await this.actionFor(move, hereId);
      if (!action) continue;
      await this.tryMove(action, move, hereId, path, depth);
    }
  }

  /** 이 화면에서 해 볼 행동: 시작 화면에 지정한 인터랙션이 있으면 그것만, 아니면 누를 수 있는 요소 전부 */
  private movesFor(s: Snapshot, depth: number): Move[] {
    const cands = candidateActions(s, this.pkg);
    if (depth === 0 && this.opts.only?.length) {
      return this.opts.only.map((m): Move => {
        if (m.kind === 'swipe') return { id: `swipe:${m.direction}`, label: `swipe ${m.direction}`, kind: 'swipe', direction: m.direction, explicit: true };
        const label = cands.find((c) => c.key === m.key)?.label ?? m.key.split('|').slice(1).join('|');
        return { id: `${m.kind}:${m.key}`, label, kind: m.kind, key: m.key, explicit: true };
      });
    }
    return cands.map((c) => ({ id: `tap:${c.key}`, label: c.label, kind: 'tap', key: c.key, explicit: false }));
  }

  /** 라벨만 보고 누르지 않을 행동: 뒤로 가기와 같은 버튼(기록 없이), 확인 필수 라벨·피할 라벨(건너뜀으로 기록). 직접 고른 행동은 여기서 거르지 않는다 */
  private skipByLabel(move: Move, hereId: string): boolean {
    if (!move.explicit && NAV_ONLY_LABELS.test(move.label.trim())) return true;
    if (!move.explicit && (DANGEROUS_LABELS.test(move.label) || this.opts.avoid?.test(move.label))) {
      this.skipped.push({ screen: hereId, label: move.label, reason: '확인 필수 라벨' });
      return true;
    }
    return false;
  }

  /** 원래 화면으로 돌아와 본다. 끝내 못 오면 오류로 남기고 false */
  private async backHere(hereId: string, path: PathStep[]): Promise<boolean> {
    await this.returnTo(hereId, path).catch(() => undefined);
    if (screenId(this.snap) === hereId) return true;
    this.errors.push(`${hereId}: 원래 화면으로 돌아오지 못해 남은 버튼은 건너뜀`);
    this.log('원래 화면으로 돌아오지 못해 이 화면의 남은 버튼은 건너뜁니다');
    return false;
  }

  /** 행동을 기기에 보낼 모양으로 만든다. 지금 화면에서 요소를 못 찾거나 허용하지 않은 확인 필수 요소면 건너뜀으로 기록하고 undefined */
  private async actionFor(move: Move, hereId: string): Promise<GraphAction | undefined> {
    if (move.kind === 'swipe') {
      const [x1, y1, x2, y2] = swipeVector(await screenSize(this.dev), move.direction!);
      return { type: 'swipe', x1, y1, x2, y2, direction: move.direction };
    }
    // 처음 본 좌표가 아니라 지금 화면에서 같은 버튼을 다시 찾는다 (돌아왔을 때 스크롤 위치가 바뀌었을 수 있다)
    const cand = candidateActions(this.snap, this.pkg).find((c) => c.key === move.key);
    if (!cand) {
      this.skipped.push({ screen: hereId, label: move.label, reason: '현재 화면에서 찾을 수 없음' });
      return undefined;
    }
    // 직접 고른 것도 확인 필수 여부는 지도 파일이 아니라 지금 기기 화면의 라벨로 판단한다
    if (move.explicit && !this.opts.allowDanger && DANGEROUS_LABELS.test(cand.label)) {
      this.skipped.push({ screen: hereId, label: cand.label, reason: '확인 필수 라벨 (허용하지 않음)' });
      return undefined;
    }
    const action = pressAction(move.kind, cand);
    this.graph.markTried(hereId, cand.key);
    return action;
  }

  /**
   * 한 걸음: 1. 누르고 화면이 멈추길 기다린다 2. 앱 밖이면 돌아온다 3. 새 화면이면 지도에 연결을 남기고
   * 4. 깊이가 남았으면 그 화면으로 들어가 탐색한 뒤 5. 원래 화면으로 돌아온다. 오류가 나면 기록하고 원래 화면을 다시 잡는다
   */
  private async tryMove(action: GraphAction, move: Move, hereId: string, path: PathStep[], depth: number): Promise<void> {
    const name = actionLabel(action);
    this.steps++;
    try {
      const after = await this.actAndSettle(action, hereId, name);
      if (after.screen.packageName && after.screen.packageName !== this.pkg) {
        this.log(`${name} → 앱 밖(${after.screen.packageName}), 복귀`);
        await this.returnTo(hereId, path);
        return;
      }
      const to = await this.graph.addSnapshot(after, this.dev);
      if (to.id === hereId) {
        if (move.explicit) this.log(`${name} → 같은 화면 (화면이 바뀌지 않음)`, hereId);
        this.snap = after;
        return;
      }
      const edge = this.graph.addEdge(hereId, to.id, action);
      this.touched.nodes.add(to.id);
      this.touched.edges.add(edge.id);
      this.graph.saveSoon();
      this.log(`${name} → ${to.label}`, to.id);
      this.snap = after;
      if (depth + 1 < this.maxDepth && !this.entered.has(to.id)) await this.visit([...path, { action, to: to.id }], depth + 1);
      await this.comeBack(hereId, path, action, move);
    } catch (e) {
      this.errors.push(`${hereId} ${name}: ${(e as Error).message}`);
      // 오류가 나면 지금 화면을 알 수 없으므로 경로를 다시 따라가거나, 그것도 안 되면 실제 화면을 다시 잡는다.
      // 누르기 전 스냅샷을 그대로 두면 다음 버튼을 다른 화면에 누르고 엉뚱한 연결을 기록하게 된다
      this.snap = await this.replay(path)
        .catch(() => waitForSettle(this.dev))
        .catch(() => this.snap);
    }
  }

  /** 행동을 보내고 안정된 화면을 받는다. ANR·크래시 대화상자는 닫고 오류로 남기며, 웹 페이지가 그대로면 한 번 더 기다린다 */
  private async actAndSettle(action: GraphAction, hereId: string, name: string): Promise<Snapshot> {
    const { dev } = this;
    await performAction(dev, action, this.pkg);
    let after = await waitForSettle(dev);
    const dialog = await dismissSystemDialog(dev, after);
    if (dialog) {
      this.errors.push(`${hereId} ${name}: ${dialog === 'anr' ? 'ANR (응답 없음)' : '크래시'} 대화상자`);
      this.log(`${name} → ${dialog === 'anr' ? 'ANR' : '크래시'} 감지, 기록 후 계속`);
      after = await waitForSettle(dev);
    }
    // 웹 페이지는 누른 뒤 위치·네트워크 응답을 받고 나서야 넘어가기도 해서, 그대로면 한 번 더 기다려 본다
    if (screenId(after) === hereId && pageWebViews(after.hierarchy.root).length) {
      await sleep(1500);
      after = await waitForSettle(dev);
    }
    return after;
  }

  /** 들어갔던 화면에서 원래 화면으로: 스와이프로 넘긴 화면은 반대로 스와이프, 그래도 아니면 returnTo */
  private async comeBack(hereId: string, path: PathStep[], action: GraphAction, move: Move): Promise<void> {
    // 페이저처럼 스와이프로 넘긴 화면은 BACK 보다 반대로 스와이프하는 쪽이 원래 화면으로 돌아온다
    if (screenId(this.snap) !== hereId && action.type === 'swipe' && move.direction) {
      const [x1, y1, x2, y2] = swipeVector(await screenSize(this.dev), REVERSE[move.direction]);
      await swipe(this.dev, x1, y1, x2, y2);
      this.snap = await waitForSettle(this.dev);
    }
    if (screenId(this.snap) !== hereId) await this.returnTo(hereId, path);
  }

  /** BACK을 최대 2번(키보드·다이얼로그 닫기 포함) 눌러 원래 화면으로 돌아가고, 실패하면 재실행 후 경로 재생 */
  private async returnTo(target: string, path: PathStep[]): Promise<void> {
    const { dev, pkg } = this;
    for (let i = 0; i < 2; i++) {
      await pressKey(dev, 'back');
      this.snap = await waitForSettle(dev);
      if (screenId(this.snap) === target) return;
      if (this.snap.screen.packageName && this.snap.screen.packageName !== pkg && i === 1) break;
    }
    if (!this.canReplay) {
      this.log('BACK 으로 돌아오지 못했습니다 (현재 화면 기준 탐색이라 이 갈래는 멈춤)');
      return;
    }
    this.log('BACK 복귀 실패 → 재실행 후 경로 재생');
    this.snap = await this.replay(path).catch((e: Error) => {
      this.log(e.message);
      // 재생이 중간에 실패하면 기기 화면은 이미 바뀌었을 수 있으니 실제 화면을 다시 잡는다
      return waitForSettle(dev).catch(() => this.snap);
    });
  }

  /** 앱을 다시 실행해 탐색 시작 화면으로 간 뒤 (다시 열 때 다른 화면이 떠도 navigateTo 가 건너간다) 경로를 따라간다 */
  private async replay(path: PathStep[]): Promise<Snapshot> {
    if (!this.canReplay) throw new Error('현재 화면부터 시작한 탐색이라 경로를 다시 따라갈 수 없습니다');
    const nav = await navigateTo(this.dev, this.graph, this.root.id, this.log);
    return followPath(this.dev, this.pkg, nav.snap, path);
  }
}
