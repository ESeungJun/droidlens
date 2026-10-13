import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeviceAdb, sleep } from './adb.js';
import { currentScreen, launchApp, type CurrentScreen } from './app.js';
import { pressKey, screenshot, swipe, tap } from './device.js';
import {
  center,
  dumpHierarchy,
  flatten,
  labelOf,
  structureSignature,
  type Hierarchy,
  type Selector,
  type ViewNode,
} from './hierarchy.js';
import { ensureDir, readJson, safeName, writeJson } from './workspace.js';

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
  // 앱 전환 직후 dumpsys의 포커스 정보가 이전 앱을 가리킬 수 있어, 실제 그려진 뷰의 패키지를 우선한다
  const drawnPkg = hierarchy.root.children.at(-1)?.packageName;
  if (drawnPkg && drawnPkg !== screen.packageName && drawnPkg !== 'com.android.systemui') {
    screen.packageName = drawnPkg;
    screen.activity = '';
    screen.fragments = [];
  }
  return { screen, hierarchy, signature: structureSignature(hierarchy.root), png };
}

/** 앱 실행 후 해당 패키지가 포그라운드에 그려지고, 스플래시가 지나 화면이 안정될 때까지 대기 */
export async function launchAndSettle(dev: DeviceAdb, pkg: string, opts: { restart?: boolean; timeoutMs?: number } = {}): Promise<Snapshot> {
  if (opts.restart) await dev.shell(`am force-stop ${pkg}`);
  await launchApp(dev, pkg);
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let snap = await waitForSettle(dev);
  while (Date.now() < deadline) {
    const drawn = snap.hierarchy.root.children.some((c) => c.packageName === pkg);
    // 스플래시는 클릭 가능한 요소가 거의 없다: 인앱 + 활동명 확인 + 클릭 요소 1개 이상이면 준비 완료로 본다
    const ready = drawn && snap.screen.packageName === pkg && snap.screen.activity !== '' && candidateActions(snap, pkg).length > 0;
    if (ready) return snap;
    await sleep(700);
    snap = await waitForSettle(dev);
  }
  return snap;
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
  return `${shortName(s.screen.activity) || 'unknown'}@${s.signature}`;
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

  /** 스냅샷을 그래프 노드로 등록(이미 있으면 방문 수 증가). 스크린샷은 최초 1회 저장 */
  async addSnapshot(s: Snapshot): Promise<ScreenNode> {
    const id = screenId(s);
    let node = this.nodes.get(id);
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
        signature: s.signature,
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
  const from = await graph.addSnapshot(b);
  await performAction(dev, action, graph.packageName);
  const after = await waitForSettle(dev);
  const to = await graph.addSnapshot(after);
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

export interface ExploreOptions {
  packageName: string;
  maxSteps?: number;
  maxDepth?: number;
  /** true면 앱을 재시작하고 시작 (기본 true) */
  relaunch?: boolean;
  /** 위험 라벨 외에 추가로 피할 라벨 정규식 */
  avoid?: RegExp;
  signal?: AbortSignal;
  onProgress?: (e: { step: number; message: string; screen?: string }) => void;
}

export interface ExploreResult {
  graph: GraphData;
  steps: number;
  skipped: { screen: string; label: string; reason: string }[];
  errors: string[];
}

/**
 * DFS 자동 탐색. 각 화면의 클릭 가능한 요소를 하나씩 눌러 새 화면을 그래프에 추가하고 BACK으로 복귀한다.
 * 복귀에 실패하면 앱을 재실행하고 루트에서 경로를 재생한다.
 */
export async function explore(dev: DeviceAdb, opts: ExploreOptions): Promise<ExploreResult> {
  const pkg = opts.packageName;
  const maxSteps = opts.maxSteps ?? 40;
  const maxDepth = opts.maxDepth ?? 4;
  const graph = await ScreenGraph.open(pkg);
  const tried = new Set<string>();
  const skipped: ExploreResult['skipped'] = [];
  const errors: string[] = [];
  let steps = 0;
  const log = (message: string, screen?: string) => opts.onProgress?.({ step: steps, message, screen });

  let snap = opts.relaunch !== false ? await launchAndSettle(dev, pkg, { restart: true }) : await waitForSettle(dev);
  const root = await graph.addSnapshot(snap);
  log(`시작 화면: ${root.label}`, root.id);

  const replay = async (path: GraphAction[]): Promise<Snapshot> => {
    let s = await launchAndSettle(dev, pkg, { restart: true });
    for (const a of path) {
      await performAction(dev, a, pkg);
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
    log('BACK 복귀 실패 → 재실행 후 경로 재생');
    snap = await replay(path);
  };

  const visit = async (path: GraphAction[], depth: number): Promise<void> => {
    const hereId = screenId(snap);
    for (const cand of candidateActions(snap, pkg)) {
      if (steps >= maxSteps || opts.signal?.aborted) return;
      const tkey = `${hereId}|${cand.key}`;
      if (tried.has(tkey)) continue;
      tried.add(tkey);
      if (NAV_ONLY_LABELS.test(cand.label.trim())) continue;
      if (DANGEROUS_LABELS.test(cand.label) || opts.avoid?.test(cand.label)) {
        skipped.push({ screen: hereId, label: cand.label, reason: '위험 라벨' });
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
        const after = await waitForSettle(dev);
        if (after.screen.packageName && after.screen.packageName !== pkg) {
          log(`"${cand.label}" → 앱 밖(${after.screen.packageName}), 복귀`);
          await returnTo(hereId, path);
          continue;
        }
        const to = await graph.addSnapshot(after);
        graph.addEdge(hereId, to.id, action);
        await graph.save();
        if (to.id === hereId) {
          snap = after;
          continue;
        }
        log(`"${cand.label}" → ${to.label}`, to.id);
        snap = after;
        if (depth + 1 < maxDepth && to.visits === 1) await visit([...path, action], depth + 1);
        if (screenId(snap) !== hereId) await returnTo(hereId, path);
      } catch (e) {
        errors.push(`${hereId} "${cand.label}": ${(e as Error).message}`);
        snap = await replay(path).catch(() => snap);
      }
    }
  };

  await visit([], 0);
  await graph.save();
  log(`탐색 완료: 화면 ${graph.nodes.size}개, 전이 ${graph.edges.size}개, ${steps}스텝`);
  return { graph: graph.toJSON(), steps, skipped, errors };
}
