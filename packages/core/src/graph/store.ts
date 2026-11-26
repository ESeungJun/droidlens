/**
 * 앱별 화면 지도 저장소 ScreenGraph: 화면(노드)·연결(엣지)을 모으고 ~/.droidlens/graphs/<앱>/graph.json 에 저장한다.
 * 한 프로세스 안에서는 앱마다 인스턴스 하나를 같이 쓰고, MCP 서버·데스크톱 앱 같은 다른 프로세스가 고친 파일은
 * 저장 전에 다시 읽어 합집합으로 합친다. 초기화 표식(resetAt)으로 초기화 전 기록이 되살아나지 않게 한다.
 * 지도 파일 내보내기·가져오기도 여기서 한다 (형식 검증은 bundle.ts).
 * 탐색(explore)·경로 이동(navigate)·흐름 수집(flow)·MCP graph 도구·데스크톱 흐름 탭이 이 저장소를 쓴다.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DeviceAdb } from '../adb.js';
import { assertPackage, topFragments } from '../app.js';
import type { z } from 'zod';
import { PNG_MAGIC, screenshot } from '../device.js';
import {
  actionLabel,
  DANGEROUS_LABELS,
  isReplayable,
  shortestPath,
  startScreenOf,
  type GraphAction,
  type GraphData,
  type ScreenEdge,
  type ScreenNode,
} from '../graph-model.js';
import { flatten, screenSignature } from '../hierarchy.js';
import { droidlensHome, ensureDir, readJson, safeName, writeFileAtomic, writeJson } from '../workspace.js';
import { bundleSchema, clean, edgeSchema, MAP_FORMAT, MAP_LIMITS, nodeSchema, type MapBundle } from './bundle.js';
import { candidateActions, elementLabel, screenId, shortName, type Snapshot } from './snapshot.js';

export class ScreenGraph {
  nodes = new Map<string, ScreenNode>();
  edges = new Map<string, ScreenEdge>();
  createdAt = Date.now();
  updatedAt = Date.now();
  launchScreen?: string;
  /** 마지막으로 읽거나 쓴 graph.json 의 수정 시각 (다른 프로세스가 고쳤는지 확인). 0 이면 아직 파일과 맞춘 적 없음 */
  private mtime = 0;
  /**
   * 초기화 표식. reset 은 폴더를 지운 뒤 빈 graph.json 에 그 시각(resetAt)을 적어 둔다.
   * - resetAt: 마지막으로 본 디스크의 초기화 시각. 저장할 때 그대로 적는다 (0 = 초기화된 적 없음, 예전 파일 포함)
   * - since: 메모리 내용이 가장 이르게는 언제부터 모인 것인지. 만들거나 비운 시각이고, 파일을 합치면 그 파일의 resetAt 까지 내려간다
   * 규칙: 디스크 resetAt 이 since 보다 늦으면 내 메모리에 초기화 전 기록이 섞였을 수 있으므로 버린다.
   * 그 밖에는(처음 만들기 경합으로 서로 덮어쓴 경우 등) 합집합으로 합친다
   */
  private resetAt = 0;
  private since = Date.now();
  /** 저장·초기화를 한 번에 하나씩 돌리는 체인 */
  private saving: Promise<unknown> = Promise.resolve();
  /** saveSoon 으로 미뤄 둔 저장 */
  private pending?: ReturnType<typeof setTimeout>;
  /** 미뤄 둔 저장이 있거나 저장 중인 인스턴스. reset 으로 opened 에서 빠진 인스턴스도 flushAll 이 마저 쓰게 한다 */
  private static unsaved = new Set<ScreenGraph>();

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
    const resetAt = Date.now();
    const p = ScreenGraph.opened.get(dir);
    ScreenGraph.opened.delete(dir);
    // 지운 뒤 빈 graph.json 에 초기화 시각을 남긴다. 옛 내용을 쥔 다른 인스턴스·프로세스는 이 표식을 보고 메모리를 버린다
    const wipe = async () => {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const empty: GraphData = { packageName, resetAt, createdAt: resetAt, updatedAt: resetAt, nodes: [], edges: [] };
      await writeJson(join(dir, 'graph.json'), empty);
    };
    // 이미 열린 인스턴스(스크립트 실행 중인 흐름 수집 등)는 저장 체인 안에서 비우고 지운다.
    // 진행 중인 저장이 끝난 뒤에 돌고, 그 뒤에 들어온 저장은 지운 다음에 돈다 (지우는 사이에 옛 내용을 쓰지 않게)
    const g = await p?.catch(() => undefined);
    if (!g) return wipe();
    if (g.pending) clearTimeout(g.pending);
    g.pending = undefined;
    await g.serial(async () => {
      g.clear();
      await wipe();
    });
  }

  /**
   * 열린 그래프의 미뤄 둔 저장(saveSoon)을 모두 바로 쓰고 끝나길 기다린다.
   * 프로세스를 끝내기 전에 불러 모아 둔 기록이 사라지지 않게 한다 (실패한 저장은 건너뛴다)
   */
  static async flushAll(): Promise<void> {
    const opened = [...ScreenGraph.opened.values()].map((p) => p.then((g) => g.flush()));
    const unsaved = [...ScreenGraph.unsaved].map((g) => g.flush());
    await Promise.all([...opened, ...unsaved].map((p) => p.catch(() => undefined)));
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
   * 화면·연결은 초기화 말고는 지우는 일이 없으므로 합집합으로 두면 어느 쪽 기록도 사라지지 않는다.
   * 초기화됐으면(파일이 없어졌거나 내 내용보다 늦은 초기화 표식) 메모리 내용을 버린다
   */
  private async refresh(): Promise<void> {
    const file = join(this.dir, 'graph.json');
    const m = await stat(file).then((st) => st.mtimeMs).catch(() => 0);
    if (!m) {
      // 맞춰 둔 파일이 없어졌으면 누가 폴더를 지운 것이다 (예전 버전의 초기화, 또는 초기화가 빈 파일을 쓰기 전).
      // 어느 것이 초기화 뒤에 생긴 기록인지 알 수 없어 메모리 내용을 모두 버리고, 지금을 초기화 시각으로 적는다
      if (this.mtime) {
        this.clear();
        this.resetAt = this.since;
      }
      return;
    }
    if (m === this.mtime) return;
    // 예전 버전이 쓰는 도중이라 깨진 파일이면 이번엔 합치지 않는다 (다음 저장 때 다시 본다)
    const data = await readJson<GraphData>(file).catch(() => undefined);
    if (!data) return;
    const resetAt = data.resetAt ?? 0;
    if (resetAt > this.since) this.clear();
    this.resetAt = Math.max(this.resetAt, resetAt);
    this.since = Math.min(this.since, resetAt);
    this.mtime = m;
    this.merge(data);
  }

  /** 메모리 내용을 버리고 빈 그래프로 돌아간다 */
  private clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.launchScreen = undefined;
    this.createdAt = this.updatedAt = this.since = Date.now();
    this.mtime = 0;
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
        // 다른 프로세스가 초기화하며 폴더를 지웠을 수 있다
        await mkdir(this.dir, { recursive: true });
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
      resetAt: this.resetAt || undefined,
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
    return this.serial(async () => {
      await this.refresh();
      await mkdir(this.dir, { recursive: true });
      await writeJson(p, this.toJSON());
      await writeFileAtomic(join(this.dir, 'graph.mmd'), this.toMermaid());
      this.mtime = await stat(p).then((st) => st.mtimeMs).catch(() => this.mtime);
      return p;
    });
  }

  /** 저장·초기화를 앞의 작업이 끝난 뒤에 돌린다 (앞의 작업이 실패해도 돈다) */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    ScreenGraph.unsaved.add(this);
    const next = this.saving.then(task, task);
    const tail = next.catch(() => undefined);
    this.saving = tail;
    // 마지막 작업이 끝났고 새로 미뤄 둔 저장이 없으면 목록에서 뺀다
    void tail.then(() => {
      if (this.saving === tail && !this.pending) ScreenGraph.unsaved.delete(this);
    });
    return next;
  }

  /**
   * 잦은 기록(탐색 한 걸음·흐름 수집)용: 모았다가 잠시 뒤 한 번에 저장한다.
   * 작업이 끝나면 flush() 로 마저 쓴다 (타이머가 남아 있는 동안은 프로세스도 끝나지 않는다)
   */
  saveSoon(delayMs = 1000): void {
    if (this.pending) return;
    ScreenGraph.unsaved.add(this);
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

  /** 다시 따라가도 안전한 연결만 쓴 최단 경로 (확인 필수 버튼·앱 밖으로 나가는 키·딥링크 제외) */
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
