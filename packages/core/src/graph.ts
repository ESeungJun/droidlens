import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeviceAdb, sleep } from './adb.js';
import { ensureAgent } from './agent.js';
import { assertPackage, currentScreen, launchApp, topFragments, type CurrentScreen } from './app.js';
import { pressKey, screenshot, swipe, tap } from './device.js';
import {
  center,
  dumpHierarchy,
  flatten,
  labelOf,
  screenSignature,
  structureSignature,
  type Hierarchy,
  type Selector,
  type ViewNode,
} from './hierarchy.js';
import { droidlensHome, ensureDir, readJson, safeName, writeJson } from './workspace.js';

// ---------- 스냅샷 ----------

export interface Snapshot {
  screen: CurrentScreen;
  hierarchy: Hierarchy;
  signature: string;
  png?: Buffer;
}

export async function captureSnapshot(dev: DeviceAdb, opts: { screenshot?: boolean } = {}): Promise<Snapshot> {
  const [screen, hierarchy, png] = await Promise.all([
    currentScreen(dev),
    dumpHierarchy(dev),
    opts.screenshot === false ? Promise.resolve(undefined) : screenshot(dev),
  ]);
  return { screen, hierarchy, signature: structureSignature(hierarchy.root), png };
}

/**
 * 화면이 안정될 때까지 대기. uiautomator dump(1.5~2.5초)보다 훨씬 빠른 screencap 해시를 연속 비교하고,
 * 안정되면 뷰 계층·Activity를 한 번만 가져온다. 커서 깜빡임 등으로 계속 변하면 timeout에서 멈춘다.
 */
export async function waitForSettle(dev: DeviceAdb, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Snapshot> {
  // 에이전트가 있으면 접근성 이벤트가 잠잠해질 때까지 기다리는 쪽이 훨씬 빠르고 정확하다
  const agent = await ensureAgent(dev);
  if (agent) {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    await sleep(150);
    await agent.waitIdle(300, opts.timeoutMs ?? 4000).catch(() => undefined);
    // 프래그먼트 전환 애니메이션은 접근성 이벤트를 거의 내지 않아 idle이 일찍 끝날 수 있다:
    // 덤프(~50ms)를 반복해 구조 시그니처가 연속 두 번 같을 때까지 확인
    let hierarchy = await dumpHierarchy(dev);
    let sig = structureSignature(hierarchy.root);
    while (Date.now() < deadline) {
      await sleep(250);
      const next = await dumpHierarchy(dev);
      const nextSig = structureSignature(next.root);
      hierarchy = next;
      if (nextSig === sig) break;
      sig = nextSig;
    }
    const [screen, png] = await Promise.all([currentScreen(dev), screenshot(dev)]);
    return fixPackage({ screen, hierarchy, signature: sig, png });
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  await sleep(opts.intervalMs ?? 250);
  let png = await screenshot(dev);
  let hash = createHash('sha1').update(png).digest('hex');
  while (Date.now() < deadline) {
    await sleep(opts.intervalMs ?? 250);
    const next = await screenshot(dev);
    const h = createHash('sha1').update(next).digest('hex');
    png = next;
    if (h === hash) break;
    hash = h;
  }
  const [screen, hierarchy] = await Promise.all([currentScreen(dev), dumpHierarchy(dev)]);
  return fixPackage({ screen, hierarchy, signature: structureSignature(hierarchy.root), png });
}

/** 앱 전환 직후 dumpsys의 포커스 정보가 이전 앱을 가리킬 수 있어, 실제 그려진 뷰의 패키지를 우선한다 */
function fixPackage(s: Snapshot): Snapshot {
  const drawnPkg = s.hierarchy.root.children.at(-1)?.packageName;
  if (drawnPkg && drawnPkg !== s.screen.packageName && drawnPkg !== 'com.android.systemui') {
    s.screen.packageName = drawnPkg;
    s.screen.activity = '';
    s.screen.fragments = [];
  }
  return s;
}

/** 앱 실행 후 해당 패키지가 포그라운드에 그려지고, 스플래시가 지나 화면이 안정될 때까지 대기 */
export async function launchAndSettle(dev: DeviceAdb, pkg: string, opts: { restart?: boolean; timeoutMs?: number } = {}): Promise<Snapshot> {
  assertPackage(pkg);
  if (opts.restart) await dev.shell(`am force-stop ${pkg}`);
  await launchApp(dev, pkg);
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const agent = await ensureAgent(dev);
  // 준비 판정은 스크린샷 없이 (뷰 계층 + 현재 Activity만) 빠르게 반복하고, 끝나면 한 번만 전체 스냅샷
  while (Date.now() < deadline) {
    if (agent) await agent.waitIdle(300, 2000).catch(() => undefined);
    else await sleep(700);
    const [screen, hierarchy] = await Promise.all([currentScreen(dev), dumpHierarchy(dev)]);
    const s = fixPackage({ screen, hierarchy, signature: structureSignature(hierarchy.root) });
    if (await dismissSystemDialog(dev, s)) continue;
    const drawn = hierarchy.root.children.some((c) => c.packageName === pkg);
    // 스플래시는 클릭 가능한 요소가 거의 없다: 인앱 + Activity 확인 + 클릭 요소 1개 이상이면 준비 완료
    if (drawn && s.screen.packageName === pkg && s.screen.activity !== '' && candidateActions(s, pkg).length > 0) break;
  }
  return waitForSettle(dev);
}

/**
 * 시스템 ANR/크래시 대화상자 처리. ANR("응답하지 않음")은 '대기', 크래시("중지됨")는 '닫기'를 누른다.
 * 처리했으면 무엇이었는지 반환 (탐색·시나리오에서 오류로 기록).
 */
export async function dismissSystemDialog(dev: DeviceAdb, s: Snapshot): Promise<'anr' | 'crash' | undefined> {
  const nodes = flatten(s.hierarchy.root);
  const wait = nodes.find((n) => n.resourceId === 'android:id/aerr_wait');
  const close = nodes.find((n) => n.resourceId === 'android:id/aerr_close');
  if (!wait && !close) return undefined;
  const target = wait ?? close!;
  const { x, y } = center(target);
  await tap(dev, x, y);
  await sleep(500);
  return wait ? 'anr' : 'crash';
}

// ---------- 화면 그래프 ----------

export type GraphAction =
  | { type: 'tap'; selector?: Selector; label?: string; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'key'; key: string }
  | { type: 'launch' }
  | { type: 'deeplink'; uri: string }
  | { type: 'manual'; note?: string };

export interface ScreenNode {
  id: string;
  packageName: string;
  activity: string;
  fragments: string[];
  signature: string;
  label: string;
  screenshot?: string;
  firstSeen: number;
  visits: number;
  nodeCount: number;
  maxDepth: number;
  /** 화면에서 탭 가능한 요소 라벨 (탐색 후보/요약용) */
  actions: string[];
}

export interface ScreenEdge {
  id: string;
  from: string;
  to: string;
  action: GraphAction;
  count: number;
}

export interface GraphData {
  packageName: string;
  createdAt: number;
  updatedAt: number;
  nodes: ScreenNode[];
  edges: ScreenEdge[];
}

function shortName(cls: string): string {
  return cls.split('.').pop() ?? cls;
}

export function screenId(s: Snapshot): string {
  return `${shortName(s.screen.activity) || 'unknown'}@${screenSignature(s.hierarchy.root)}`;
}

export function actionLabel(a: GraphAction): string {
  switch (a.type) {
    case 'tap':
      return a.label ? `tap "${a.label}"` : `tap ${Math.round(a.x)},${Math.round(a.y)}`;
    case 'swipe':
      return 'swipe';
    case 'key':
      return `key ${a.key}`;
    case 'launch':
      return 'launch';
    case 'deeplink':
      return `deeplink ${a.uri}`;
    case 'manual':
      return a.note ?? 'manual';
  }
}

export class ScreenGraph {
  nodes = new Map<string, ScreenNode>();
  edges = new Map<string, ScreenEdge>();
  createdAt = Date.now();
  updatedAt = Date.now();

  constructor(readonly packageName: string, readonly dir: string) {}

  /** 앱의 화면 그래프(화면·연결·스크린샷)를 모두 지운다 */
  static async reset(packageName: string): Promise<void> {
    assertPackage(packageName);
    await rm(join(droidlensHome(), 'graphs', safeName(packageName)), { recursive: true, force: true });
  }

  static async open(packageName: string): Promise<ScreenGraph> {
    const dir = await ensureDir('graphs', safeName(packageName));
    const g = new ScreenGraph(packageName, dir);
    const data = await readJson<GraphData>(join(dir, 'graph.json'));
    if (data) {
      g.createdAt = data.createdAt;
      g.updatedAt = data.updatedAt;
      data.nodes.forEach((n) => g.nodes.set(n.id, n));
      data.edges.forEach((e) => g.edges.set(e.id, e));
    }
    return g;
  }

  /**
   * 스냅샷을 그래프 노드로 등록(이미 있으면 방문 수 증가). 스크린샷은 최초 1회 저장.
   * dev를 주면 새 화면일 때만 Fragment 목록을 조회해 라벨에 붙인다 (느린 조회라 재방문 때는 생략).
   */
  async addSnapshot(s: Snapshot, dev?: DeviceAdb): Promise<ScreenNode> {
    const id = screenId(s);
    let node = this.nodes.get(id);
    if (!node && dev && !s.screen.fragments.length && s.screen.packageName === this.packageName) {
      s.screen.fragments = await topFragments(dev).catch(() => []);
    }
    if (!node) {
      let shot: string | undefined;
      if (s.png) {
        shot = `${safeName(id)}.png`;
        await writeFile(join(this.dir, shot), s.png);
      }
      const frag = s.screen.fragments.length ? ` / ${s.screen.fragments.join(', ')}` : '';
      const outside = s.screen.packageName && s.screen.packageName !== this.packageName ? `↗ ${s.screen.packageName} · ` : '';
      node = {
        id,
        packageName: s.screen.packageName,
        activity: s.screen.activity,
        fragments: s.screen.fragments,
        signature: screenSignature(s.hierarchy.root),
        label: `${outside}${shortName(s.screen.activity)}${frag}`,
        screenshot: shot,
        firstSeen: Date.now(),
        visits: 0,
        nodeCount: s.hierarchy.nodeCount,
        maxDepth: s.hierarchy.maxDepth,
        actions: candidateActions(s, this.packageName).map((c) => c.label),
      };
      this.nodes.set(id, node);
    }
    node.visits++;
    this.updatedAt = Date.now();
    return node;
  }

  addEdge(from: string, to: string, action: GraphAction): ScreenEdge {
    const id = `${from}->${to}:${actionLabel(action)}`;
    const e = this.edges.get(id) ?? { id, from, to, action, count: 0 };
    e.count++;
    this.edges.set(id, e);
    this.updatedAt = Date.now();
    return e;
  }

  toJSON(): GraphData {
    return {
      packageName: this.packageName,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  async save(): Promise<string> {
    const p = join(this.dir, 'graph.json');
    await writeJson(p, this.toJSON());
    await writeFile(join(this.dir, 'graph.mmd'), this.toMermaid());
    return p;
  }

  toMermaid(): string {
    const idx = new Map([...this.nodes.keys()].map((k, i) => [k, `S${i}`]));
    const esc = (s: string) => s.replace(/"/g, "'");
    const lines = ['flowchart LR'];
    for (const n of this.nodes.values()) lines.push(`  ${idx.get(n.id)}["${esc(n.label)}"]`);
    for (const e of this.edges.values()) {
      if (e.from === e.to) continue;
      lines.push(`  ${idx.get(e.from)} -->|"${esc(actionLabel(e.action))}"| ${idx.get(e.to)}`);
    }
    return lines.join('\n');
  }

  /** 두 화면 사이 최단 경로 (BFS) */
  path(from: string, to: string): ScreenEdge[] | undefined {
    const prev = new Map<string, ScreenEdge>();
    const q = [from];
    const seen = new Set([from]);
    while (q.length) {
      const cur = q.shift()!;
      if (cur === to) break;
      for (const e of this.edges.values()) {
        if (e.from === cur && !seen.has(e.to)) {
          seen.add(e.to);
          prev.set(e.to, e);
          q.push(e.to);
        }
      }
    }
    if (!seen.has(to)) return undefined;
    const out: ScreenEdge[] = [];
    for (let c = to; c !== from; c = prev.get(c)!.from) out.unshift(prev.get(c)!);
    return out;
  }
}

// ---------- 행동 실행 ----------

export async function performAction(dev: DeviceAdb, a: GraphAction, pkg?: string): Promise<void> {
  switch (a.type) {
    case 'tap':
      return tap(dev, a.x, a.y);
    case 'swipe':
      return swipe(dev, a.x1, a.y1, a.x2, a.y2);
    case 'key':
      return pressKey(dev, a.key as never);
    case 'launch':
      if (!pkg) throw new Error('launch에는 패키지가 필요합니다');
      return launchApp(dev, pkg);
    case 'deeplink':
    case 'manual':
      return;
  }
}

/** 행동 전후 화면을 그래프에 기록 */
export async function recordTransition(
  dev: DeviceAdb,
  graph: ScreenGraph,
  action: GraphAction,
  before?: Snapshot,
): Promise<{ from: ScreenNode; to: ScreenNode; edge: ScreenEdge; after: Snapshot }> {
  const b = before ?? (await captureSnapshot(dev));
  const from = await graph.addSnapshot(b, dev);
  await performAction(dev, action, graph.packageName);
  const after = await waitForSettle(dev);
  const to = await graph.addSnapshot(after, dev);
  const edge = graph.addEdge(from.id, to.id, action);
  await graph.save();
  return { from, to, edge, after };
}

// ---------- 자동 탐색 ----------

/** 탐색 중 절대 누르지 않을 위험 라벨 (결제·삭제·로그아웃·전송 등) */
export const DANGEROUS_LABELS =
  /(log ?out|sign ?out|delete|remove|uninstall|purchase|buy|pay|checkout|order|send|submit|report|block|unsubscribe|deactivate|reset|로그아웃|삭제|탈퇴|결제|구매|주문|송금|전송|보내기|신고|차단|초기화|해지|구독|등록하기|완료)/i;

/** BACK과 같은 효과라 탐색 가치가 없는 라벨 */
const NAV_ONLY_LABELS = /^(위로 탐색|navigate up|up|뒤로|뒤로 가기|back|닫기|close)$/i;

export interface Candidate {
  node: ViewNode;
  label: string;
  key: string;
}

export function candidateActions(s: Snapshot, pkg?: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const n of flatten(s.hierarchy.root)) {
    if (!n.clickable || !n.enabled || n.depth === 0) continue;
    if (pkg && n.packageName && n.packageName !== pkg) continue;
    const [l, t, r, b] = n.bounds;
    if (r - l < 8 || b - t < 8) continue;
    if (n.className.endsWith('EditText')) continue;
    // 클릭 가능한 컨테이너는 자식 텍스트로 라벨을 만든다
    const label =
      labelOf(n) && !/Layout$|View$|Group$/.test(labelOf(n))
        ? labelOf(n)
        : flatten(n).map((c) => c.text || c.contentDesc).find(Boolean) ?? labelOf(n);
    const key = `${n.resourceId}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ node: n, label, key });
  }
  return out;
}

/** 기록한 탭 행동(id·라벨)에 해당하는 버튼을 현재 화면에서 다시 찾는다 */
function locate(s: Snapshot, a: Extract<GraphAction, { type: 'tap' }>, pkg: string): Candidate | undefined {
  return candidateActions(s, pkg).find((c) => c.label === (a.label ?? '') && c.node.resourceId === (a.selector?.id ?? ''));
}

export interface ExploreOptions {
  packageName: string;
  /** 누르는 횟수의 안전 상한 (기본 500). 탐색 범위는 maxDepth 로 정하고 이건 끝없이 도는 것만 막는다 */
  maxSteps?: number;
  maxDepth?: number;
  /** true면 앱을 재시작해 첫 화면부터, false면 지금 화면부터 탐색 (기본 true) */
  relaunch?: boolean;
  /** 위험 라벨 외에 추가로 피할 라벨 정규식 */
  avoid?: RegExp;
  signal?: AbortSignal;
  onProgress?: (e: { step: number; message: string; screen?: string }) => void;
}

export interface ExploreResult {
  graph: GraphData;
  steps: number;
  /** 안전 상한에 닿아 멈췄는지 */
  limited: boolean;
  skipped: { screen: string; label: string; reason: string }[];
  errors: string[];
}

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
  let steps = 0;
  const log = (message: string, screen?: string) => opts.onProgress?.({ step: steps, message, screen });

  const fromCurrent = opts.relaunch === false;
  let snap = fromCurrent ? await waitForSettle(dev) : await launchAndSettle(dev, pkg, { restart: true });
  if (fromCurrent && snap.screen.packageName !== pkg) throw new Error(`지금 화면이 ${pkg} 앱이 아닙니다. 앱을 열어 둔 상태에서 시작하세요`);
  const root = await graph.addSnapshot(snap, dev);
  log(`시작 화면: ${root.label}`, root.id);

  const replay = async (path: GraphAction[]): Promise<Snapshot> => {
    // 현재 화면부터 시작했으면 앱을 재시작해 같은 경로로 돌아갈 수 없다
    if (fromCurrent) throw new Error('현재 화면부터 시작한 탐색이라 경로를 다시 따라갈 수 없습니다');
    let s = await launchAndSettle(dev, pkg, { restart: true });
    for (const a of path) {
      if (a.type === 'tap') {
        const c = locate(s, a, pkg);
        if (!c) throw new Error(`경로 재생 실패: "${a.label}"을(를) 찾을 수 없습니다`);
        const { x, y } = center(c.node);
        await tap(dev, x, y);
      } else await performAction(dev, a, pkg);
      s = await waitForSettle(dev);
    }
    return s;
  };

  /** BACK을 최대 2번(키보드·다이얼로그 닫기 포함) 눌러 원래 화면으로 돌아가고, 실패하면 재실행 후 경로 재생 */
  const returnTo = async (target: string, path: GraphAction[]): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      await pressKey(dev, 'back');
      snap = await waitForSettle(dev);
      if (screenId(snap) === target) return;
      if (snap.screen.packageName && snap.screen.packageName !== pkg && i === 1) break;
    }
    if (fromCurrent) {
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

  // 이번 실행에서 이미 들어가 본 화면. 저장된 그래프의 방문 수를 쓰면 다시 탐색할 때 깊이가 무시된다
  const entered = new Set<string>();
  const visit = async (path: GraphAction[], depth: number): Promise<void> => {
    const hereId = screenId(snap);
    entered.add(hereId);
    for (const first of candidateActions(snap, pkg)) {
      if (steps >= maxSteps || opts.signal?.aborted) return;
      const tkey = `${hereId}|${first.key}`;
      if (tried.has(tkey)) continue;
      tried.add(tkey);
      if (NAV_ONLY_LABELS.test(first.label.trim())) continue;
      if (DANGEROUS_LABELS.test(first.label) || opts.avoid?.test(first.label)) {
        skipped.push({ screen: hereId, label: first.label, reason: '위험 라벨' });
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
      // 처음 본 좌표가 아니라 지금 화면에서 같은 버튼을 다시 찾는다 (돌아왔을 때 스크롤 위치가 바뀌었을 수 있다)
      const cand = candidateActions(snap, pkg).find((c) => c.key === first.key);
      if (!cand) {
        skipped.push({ screen: hereId, label: first.label, reason: '현재 화면에서 찾을 수 없음' });
        continue;
      }
      const { x, y } = center(cand.node);
      const action: GraphAction = {
        type: 'tap',
        x,
        y,
        label: cand.label,
        selector: cand.node.resourceId ? { id: cand.node.resourceId } : { text: cand.node.text || undefined },
      };
      steps++;
      try {
        await performAction(dev, action, pkg);
        let after = await waitForSettle(dev);
        const dialog = await dismissSystemDialog(dev, after);
        if (dialog) {
          errors.push(`${hereId} "${cand.label}": ${dialog === 'anr' ? 'ANR (응답 없음)' : '크래시'} 대화상자`);
          log(`"${cand.label}" → ${dialog === 'anr' ? 'ANR' : '크래시'} 감지, 기록 후 계속`);
          after = await waitForSettle(dev);
        }
        if (after.screen.packageName && after.screen.packageName !== pkg) {
          log(`"${cand.label}" → 앱 밖(${after.screen.packageName}), 복귀`);
          await returnTo(hereId, path);
          continue;
        }
        const to = await graph.addSnapshot(after, dev);
        if (to.id === hereId) {
          snap = after;
          continue;
        }
        graph.addEdge(hereId, to.id, action);
        await graph.save();
        log(`"${cand.label}" → ${to.label}`, to.id);
        snap = after;
        if (depth + 1 < maxDepth && !entered.has(to.id)) await visit([...path, action], depth + 1);
        if (screenId(snap) !== hereId) await returnTo(hereId, path);
      } catch (e) {
        errors.push(`${hereId} "${cand.label}": ${(e as Error).message}`);
        // 오류가 나면 지금 화면을 알 수 없으므로 경로를 다시 따라가거나, 그것도 안 되면 실제 화면을 다시 잡는다.
        // 누르기 전 스냅샷을 그대로 두면 다음 버튼을 다른 화면에 누르고 엉뚱한 연결을 기록하게 된다
        snap = await replay(path).catch(() => waitForSettle(dev)).catch(() => snap);
      }
    }
  };

  await visit([], 0);
  await graph.save();
  log(`탐색 완료: 화면 ${graph.nodes.size}개, 전이 ${graph.edges.size}개, ${steps}스텝`);
  return { graph: graph.toJSON(), steps, limited: steps >= maxSteps, skipped, errors };
}
