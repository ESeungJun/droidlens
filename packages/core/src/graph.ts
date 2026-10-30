import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DeviceAdb, sleep } from './adb.js';
import { ensureAgent } from './agent.js';
import { assertPackage, currentScreen, launchApp, topFragments, type CurrentScreen } from './app.js';
import { z } from 'zod';
import { KEYCODES, longPress, PNG_MAGIC, pressKey, screenshot, screenSize, swipe, swipeVector, tap, type SwipeDirection } from './device.js';
import {
  actionKey,
  actionLabel,
  DANGEROUS_LABELS,
  isReplayable,
  shortestPath,
  startScreenOf,
  type GraphAction,
  type GraphData,
  type Interaction,
  type ScreenEdge,
  type ScreenNode,
} from './graph-model.js';
import {
  center,
  dumpHierarchy,
  flatten,
  labelOf,
  pageWebViews,
  screenSignature,
  structureSignature,
  type Hierarchy,
  type ViewNode,
} from './hierarchy.js';
import { droidlensHome, ensureDir, readJson, safeName, writeFileAtomic, writeJson } from './workspace.js';

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

/** 취소되면 p 를 기다리지 않고 바로 던진다 (p 자체는 끝까지 돈다) */
function orAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
}

/**
 * 화면이 안정될 때까지 대기. uiautomator dump(1.5~2.5초)보다 훨씬 빠른 screencap 해시를 연속 비교하고,
 * 안정되면 뷰 계층·Activity를 한 번만 가져온다. 커서 깜빡임 등으로 계속 변하면 timeout에서 멈춘다.
 * 에이전트가 있으면 덤프로 안정을 확인하고 스크린샷은 담지 않는다 (필요하면 addSnapshot 에 dev 를 주면 새 화면일 때만 찍는다).
 * signal 이 취소되면 기다리기를 그만두고 던진다 (더 이상 기기에 덤프·스크린샷을 요청하지 않게).
 */
export async function waitForSettle(
  dev: DeviceAdb,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<Snapshot> {
  const { signal } = opts;
  // 에이전트가 있으면 접근성 이벤트가 잠잠해질 때까지 기다리는 쪽이 훨씬 빠르고 정확하다
  const agent = await ensureAgent(dev);
  if (agent) {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    await orAbort(sleep(150), signal);
    await orAbort(agent.waitIdle(300, opts.timeoutMs ?? 4000).catch(() => undefined), signal);
    // 프래그먼트 전환 애니메이션은 접근성 이벤트를 거의 내지 않아 idle이 일찍 끝날 수 있다:
    // 덤프(~50ms)를 반복해 구조 시그니처가 연속 두 번 같을 때까지 확인한다.
    // 단 웹 페이지 화면은 틀이 먼저 그려지고 데이터가 0.5~1초 뒤에 채워져서, 같은 구조가 1초 유지돼야 안정으로 본다
    let hierarchy = await dumpHierarchy(dev);
    let sig = structureSignature(hierarchy.root);
    let since = Date.now();
    while (Date.now() < deadline) {
      await orAbort(sleep(250), signal);
      const next = await dumpHierarchy(dev);
      const nextSig = structureSignature(next.root);
      hierarchy = next;
      if (nextSig !== sig) {
        sig = nextSig;
        since = Date.now();
      } else if (Date.now() - since >= (pageWebViews(next.root).length ? 1000 : 0)) break;
    }
    // 스크린샷은 찍지 않는다: 새 화면을 지도에 올릴 때만 addSnapshot 이 찍는다 (재방문·앱 밖 화면마다 PNG 를 받지 않게)
    return fixPackage({ screen: await currentScreen(dev), hierarchy, signature: sig });
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  await orAbort(sleep(opts.intervalMs ?? 250), signal);
  let png = await screenshot(dev);
  let hash = createHash('sha1').update(png).digest('hex');
  while (Date.now() < deadline) {
    await orAbort(sleep(opts.intervalMs ?? 250), signal);
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

export * from './graph-model.js';

function shortName(cls: string): string {
  return cls.split('.').pop() ?? cls;
}

export function screenId(s: Snapshot): string {
  return `${shortName(s.screen.activity) || 'unknown'}@${screenSignature(s.hierarchy.root)}`;
}

/** 가져온 지도 파일 한도 (렌더러가 매번 배치를 다시 계산하므로 크게 두지 않는다) */
export const MAP_LIMITS = { nodes: 2000, edges: 10_000, screenshotBytes: 5 * 1024 * 1024 };

export class ScreenGraph {
  nodes = new Map<string, ScreenNode>();
  edges = new Map<string, ScreenEdge>();
  createdAt = Date.now();
  updatedAt = Date.now();
  launchScreen?: string;
  /** 마지막으로 읽거나 쓴 graph.json 의 수정 시각 (다른 프로세스가 고쳤는지 확인) */
  private mtime = 0;
  private saving: Promise<unknown> = Promise.resolve();
  /** saveSoon 으로 미뤄 둔 저장 */
  private pending?: ReturnType<typeof setTimeout>;

  /**
   * 한 프로세스 안에서는 앱마다 그래프 하나를 같이 쓴다. 기능마다 따로 열어 저장하면
   * 탐색·시나리오 수집·가져오기가 서로의 변경을 덮어쓰기 때문이다.
   */
  private static opened = new Map<string, Promise<ScreenGraph>>();

  constructor(readonly packageName: string, readonly dir: string) {}

  private static dirOf(packageName: string): string {
    return join(droidlensHome(), 'graphs', safeName(packageName));
  }

  /** 앱의 화면 그래프(화면·연결·스크린샷)를 모두 지운다 */
  static async reset(packageName: string): Promise<void> {
    assertPackage(packageName);
    const dir = ScreenGraph.dirOf(packageName);
    ScreenGraph.opened.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * 열린 그래프의 미뤄 둔 저장(saveSoon)을 모두 바로 쓰고 끝나길 기다린다.
   * 프로세스를 끝내기 전에 불러 모아 둔 기록이 사라지지 않게 한다 (실패한 저장은 건너뛴다)
   */
  static async flushAll(): Promise<void> {
    await Promise.all([...ScreenGraph.opened.values()].map((p) => p.then((g) => g.flush()).catch(() => undefined)));
  }

  static async open(packageName: string): Promise<ScreenGraph> {
    assertPackage(packageName);
    const key = ScreenGraph.dirOf(packageName);
    let p = ScreenGraph.opened.get(key);
    if (!p) {
      p = (async () => new ScreenGraph(packageName, await ensureDir('graphs', safeName(packageName))))();
      ScreenGraph.opened.set(key, p);
    }
    const g = await p.catch((e) => {
      ScreenGraph.opened.delete(key);
      throw e;
    });
    await g.refresh();
    return g;
  }

  /**
   * 다른 프로세스(MCP 서버·데스크톱 앱)가 graph.json 을 고쳤으면 다시 읽어 지금 것과 합친다.
   * 화면·연결은 지우는 일이 없으므로 합집합으로 두면 어느 쪽 기록도 사라지지 않는다
   */
  private async refresh(): Promise<void> {
    const file = join(this.dir, 'graph.json');
    const m = await stat(file).then((st) => st.mtimeMs).catch(() => 0);
    if (!m || m === this.mtime) return;
    // 예전 버전이 쓰는 도중이라 깨진 파일이면 이번엔 합치지 않는다 (다음 저장 때 다시 본다)
    const data = await readJson<GraphData>(file).catch(() => undefined);
    if (!data) return;
    this.mtime = m;
    this.merge(data);
  }

  private merge(data: GraphData): void {
    this.createdAt = Math.min(this.createdAt, data.createdAt);
    this.updatedAt = Math.max(this.updatedAt, data.updatedAt);
    this.launchScreen ??= data.launchScreen;
    for (const n of data.nodes) {
      const cur = this.nodes.get(n.id);
      if (!cur) {
        this.nodes.set(n.id, n);
        continue;
      }
      cur.visits = Math.max(cur.visits, n.visits);
      cur.firstSeen = Math.min(cur.firstSeen, n.firstSeen);
      cur.lastSeen = Math.max(cur.lastSeen ?? 0, n.lastSeen ?? 0) || undefined;
      cur.screenshot ??= n.screenshot;
      if (!cur.targets && n.targets) {
        cur.targets = n.targets;
        cur.actions = n.actions;
        cur.selectedKeys = n.selectedKeys;
      }
      if (n.tried?.length) cur.tried = [...new Set([...(cur.tried ?? []), ...n.tried])];
    }
    for (const e of data.edges) {
      const cur = this.edges.get(e.id);
      if (cur) cur.count = Math.max(cur.count, e.count);
      else this.edges.set(e.id, e);
    }
  }

  /** 앱 실행 첫 화면. 실행 기록이 없던 예전 지도는 가장 먼저 기록된 화면 (표시용, 화면 이동에는 launchScreen 만 쓴다) */
  get startScreen(): string | undefined {
    return startScreenOf({ launchScreen: this.launchScreen, nodes: [...this.nodes.values()] });
  }

  /**
   * 스냅샷을 그래프 노드로 등록(이미 있으면 방문 수 증가). 스크린샷은 최초 1회 저장하며,
   * 스냅샷에 스크린샷이 없고 dev를 주면 새 화면일 때만 찍는다 (재방문마다 찍지 않아 기록이 가볍다).
   * dev를 주면 새 화면일 때만 Fragment 목록을 조회해 라벨에 붙인다 (느린 조회라 재방문 때는 생략).
   */
  async addSnapshot(s: Snapshot, dev?: DeviceAdb): Promise<ScreenNode> {
    const id = screenId(s);
    let node = this.nodes.get(id);
    if (!node && dev && !s.screen.fragments.length && s.screen.packageName === this.packageName) {
      s.screen.fragments = await topFragments(dev).catch(() => []);
    }
    if (!node) {
      const png = s.png ?? (dev ? await screenshot(dev).catch(() => undefined) : undefined);
      let shot: string | undefined;
      if (png) {
        shot = `${safeName(id)}.png`;
        await writeFile(join(this.dir, shot), png);
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
        actions: [],
      };
      this.nodes.set(id, node);
    }
    // 스크린샷을 찍은 순간의 요소 위치를 남긴다 (스크린샷 위에 상자로 그림). 예전 기록·가져온 화면엔 없으므로 방문 때 채운다
    if (!node.targets) {
      const cands = candidateActions(s, this.packageName);
      node.actions = cands.map((c) => c.label);
      node.targets = cands.map((c) => ({
        key: c.key,
        label: c.label,
        bounds: c.node.bounds,
        longClickable: c.node.longClickable || undefined,
        danger: DANGEROUS_LABELS.test(c.label) || undefined,
      }));
      const sel = flatten(s.hierarchy.root).filter((n) => n.selected && n.depth > 0 && (n.resourceId || n.text || n.contentDesc));
      node.selectedKeys = [...new Set(sel.map((n) => `${n.resourceId}|${elementLabel(n)}`))];
    }
    node.visits++;
    node.lastSeen = Date.now();
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

  /** 화면의 요소를 눌러 봤다고 기록 (커버리지) */
  markTried(screen: string, key: string): void {
    const n = this.nodes.get(screen);
    if (!n) return;
    n.tried ??= [];
    if (!n.tried.includes(key)) n.tried.push(key);
  }

  toJSON(): GraphData {
    return {
      packageName: this.packageName,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      launchScreen: this.launchScreen,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  /**
   * 지금 바로 저장. 한 번에 하나씩 쓰고, 그사이 다른 프로세스가 고쳤으면 먼저 합친다 (마지막 저장이 앞선 기록을 지우지 않게).
   * 임시 파일에 쓰고 이름을 바꿔 덮으므로 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다
   */
  save(): Promise<string> {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    const p = join(this.dir, 'graph.json');
    const write = async () => {
      await this.refresh();
      await writeJson(p, this.toJSON());
      await writeFileAtomic(join(this.dir, 'graph.mmd'), this.toMermaid());
      this.mtime = await stat(p).then((st) => st.mtimeMs).catch(() => this.mtime);
      return p;
    };
    const next = this.saving.then(write, write);
    this.saving = next.catch(() => undefined);
    return next;
  }

  /**
   * 잦은 기록(탐색 한 걸음·흐름 수집)용: 모았다가 잠시 뒤 한 번에 저장한다.
   * 작업이 끝나면 flush() 로 마저 쓴다 (타이머가 남아 있는 동안은 프로세스도 끝나지 않는다)
   */
  saveSoon(delayMs = 1000): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.save().catch(() => undefined);
    }, delayMs);
  }

  /** 미뤄 둔 저장을 바로 쓰고 진행 중인 저장까지 끝나길 기다린다 */
  async flush(): Promise<void> {
    if (this.pending) await this.save();
    else await this.saving;
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
    return shortestPath(this.edges.values(), from, to);
  }

  /** 다시 따라가도 안전한 연결만 쓴 최단 경로 (위험 버튼·앱 밖으로 나가는 키·딥링크 제외) */
  replayPath(from: string, to: string): ScreenEdge[] | undefined {
    return shortestPath(this.edges.values(), from, to, (e) => isReplayable(e.action));
  }

  /** 스크린샷을 함께 담은 한 파일짜리 지도 (다른 사람·다른 PC 와 주고받기용) */
  async exportBundle(): Promise<MapBundle> {
    const screenshots: Record<string, string> = {};
    for (const n of this.nodes.values()) {
      if (!n.screenshot) continue;
      const buf = await readFile(join(this.dir, basename(n.screenshot))).catch(() => undefined);
      if (buf) screenshots[n.screenshot] = buf.toString('base64');
    }
    return { format: MAP_FORMAT, version: 1, exportedAt: Date.now(), graph: this.toJSON(), screenshots };
  }

  /**
   * 내보낸 지도를 지금 지도에 합친다. 같은 화면(id)·연결은 하나로 두고, 없는 화면·연결·스크린샷만 추가한다.
   * 파일은 남이 만든 것일 수 있으므로 형식을 검증해 틀린 항목은 버리고, 요소 목록·눌러 본 기록은 받지 않는다
   * (다음 방문 때 기기 화면에서 다시 채운다). 연결은 화면 이동에 쓰일 때 isReplayable 로 한 번 더 거른다.
   */
  async importBundle(input: unknown): Promise<{ nodes: number; edges: number; dropped: number }> {
    const b = bundleSchema.safeParse(input);
    if (!b.success) throw new Error('DroidLens 화면 지도 파일이 아닙니다');
    const { graph, screenshots } = b.data;
    if (graph.packageName !== this.packageName) throw new Error(`다른 앱의 지도입니다 (${clean(graph.packageName, 100)})`);
    if (graph.nodes.length > MAP_LIMITS.nodes || graph.edges.length > MAP_LIMITS.edges) {
      throw new Error(`화면 ${MAP_LIMITS.nodes}개, 연결 ${MAP_LIMITS.edges}개를 넘는 지도는 가져올 수 없습니다`);
    }
    let dropped = 0;
    const nodes: z.infer<typeof nodeSchema>[] = [];
    for (const raw of graph.nodes) {
      const n = nodeSchema.safeParse(raw);
      if (n.success) nodes.push(n.data);
      else dropped++;
    }
    const added = nodes.filter((n) => !this.nodes.has(n.id)).length;
    if (this.nodes.size + added > MAP_LIMITS.nodes) throw new Error(`합치면 화면이 ${MAP_LIMITS.nodes}개를 넘습니다`);

    for (const n of nodes) {
      const cur = this.nodes.get(n.id);
      if (cur?.screenshot) {
        cur.firstSeen = Math.min(cur.firstSeen, n.firstSeen);
        continue;
      }
      const shot = n.screenshot && Object.hasOwn(screenshots, n.screenshot) ? await this.writeImportedShot(n.id, screenshots[n.screenshot]) : undefined;
      if (cur) {
        cur.screenshot = shot;
        cur.firstSeen = Math.min(cur.firstSeen, n.firstSeen);
      } else this.nodes.set(n.id, { ...n, screenshot: shot, actions: [] });
    }
    let edges = 0;
    for (const raw of graph.edges) {
      const e = edgeSchema.safeParse(raw);
      if (!e.success || !this.nodes.has(e.data.from) || !this.nodes.has(e.data.to)) {
        dropped++;
        continue;
      }
      // id 는 파일 값을 쓰지 않고 다시 만든다. 같은 파일을 여러 번 가져와도 수치가 불어나지 않게 큰 쪽을 남긴다
      const { from, to, action, count } = e.data;
      const id = `${from}->${to}:${actionLabel(action)}`;
      const cur = this.edges.get(id);
      if (cur) cur.count = Math.max(cur.count, count);
      else if (this.edges.size < MAP_LIMITS.edges) {
        this.edges.set(id, { id, from, to, action, count });
        edges++;
      } else dropped++;
    }
    if (!this.launchScreen && graph.launchScreen && this.nodes.has(graph.launchScreen)) this.launchScreen = graph.launchScreen;
    this.updatedAt = Date.now();
    await this.save();
    return { nodes: added, edges, dropped };
  }

  /** 가져온 스크린샷 저장. 파일 이름에 화면 id 해시를 붙여 기존 스크린샷과 겹치지 않게 하고, 이미 있으면 덮어쓰지 않는다 */
  private async writeImportedShot(id: string, base64: string): Promise<string | undefined> {
    const png = Buffer.from(base64, 'base64');
    if (png.length > MAP_LIMITS.screenshotBytes || !png.subarray(0, 8).equals(PNG_MAGIC)) return undefined;
    const name = `${safeName(id)}-${createHash('sha1').update(id).digest('hex').slice(0, 8)}.png`;
    try {
      await writeFile(join(this.dir, name), png, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    return name;
  }
}

const MAP_FORMAT = 'droidlens-map';

/** 가져온 문자열 정리: 제어문자를 없애고 길이를 자른다 (화면·MCP 출력에 그대로 실리므로) */
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max);
const text = (max: number) => z.string().transform((s) => clean(s, max));
const num = z.number().finite();
const count = z.number().int().min(0).max(1e9);
/** screenId 형식: Activity 짧은 이름 @ 시그니처 12자 */
const screenIdSchema = z.string().regex(/^[\w$.-]{1,120}@[0-9a-f]{12}$/);
const selectorSchema = z.object({ id: text(200).optional(), text: text(200).optional() }).strip();
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: num, y: num, label: text(120).optional(), selector: selectorSchema.optional() }).strip(),
  z.object({ type: z.literal('longpress'), x: num, y: num, label: text(120).optional(), selector: selectorSchema.optional() }).strip(),
  z
    .object({
      type: z.literal('swipe'),
      x1: num,
      y1: num,
      x2: num,
      y2: num,
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      durationMs: z.number().int().min(50).max(5000).optional(),
    })
    .strip(),
  z.object({ type: z.literal('key'), key: z.enum(Object.keys(KEYCODES) as [keyof typeof KEYCODES]) }).strip(),
  z.object({ type: z.literal('launch') }).strip(),
  z.object({ type: z.literal('deeplink'), uri: text(500) }).strip(),
  z.object({ type: z.literal('manual'), note: text(120).optional() }).strip(),
]);
const nodeSchema = z
  .object({
    id: screenIdSchema,
    packageName: text(200),
    activity: text(300),
    fragments: z.array(text(120)).max(20),
    signature: z.string().regex(/^[0-9a-f]{12}$/),
    label: text(200),
    screenshot: z.string().max(300).optional(),
    firstSeen: num,
    visits: count,
    nodeCount: count,
    maxDepth: count,
  })
  .strip();
const edgeSchema = z.object({ from: screenIdSchema, to: screenIdSchema, action: actionSchema, count: count }).strip();
const bundleSchema = z.object({
  format: z.literal(MAP_FORMAT),
  graph: z.object({
    packageName: z.string(),
    launchScreen: screenIdSchema.optional(),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
  }),
  screenshots: z.record(z.string()),
});

export interface MapBundle {
  format: typeof MAP_FORMAT;
  version: 1;
  exportedAt: number;
  graph: GraphData;
  /** 스크린샷 파일 이름 → PNG base64 */
  screenshots: Record<string, string>;
}

/** 화면의 한 점을 누르면 어떤 요소가 눌리는지 (겹치면 가장 작은 요소) */
export function targetAt(s: Snapshot, pkg: string, x: number, y: number): Candidate | undefined {
  return candidateActions(s, pkg)
    .filter(({ node: { bounds: [l, t, r, b] } }) => x >= l && x <= r && y >= t && y <= b)
    .sort((a, b) => area(a.node) - area(b.node))[0];
}

const area = (n: ViewNode) => (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);

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

export interface Candidate {
  node: ViewNode;
  label: string;
  key: string;
}

/** 요소 라벨. 컨테이너(…Layout 등)는 자식 텍스트로 만든다. 요소 key 는 `리소스 id|라벨` */
function elementLabel(n: ViewNode): string {
  const own = labelOf(n);
  return own && !/Layout$|View$|Group$/.test(own) ? own : flatten(n).map((c) => c.text || c.contentDesc).find(Boolean) ?? own;
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
    const label = elementLabel(n);
    const key = `${n.resourceId}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ node: n, label, key });
  }
  return out;
}

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
