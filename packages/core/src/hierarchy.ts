import { createHash, randomBytes } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { DeviceAdb, sleep } from './adb.js';
import { stopAgent, withAgent } from './agent.js';

export type Bounds = [left: number, top: number, right: number, bottom: number];

export interface ViewNode {
  /** 트리 내 경로 기반 id (예: 0.2.1) */
  id: string;
  depth: number;
  className: string;
  resourceId: string;
  text: string;
  contentDesc: string;
  packageName: string;
  bounds: Bounds;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  password: boolean;
  children: ViewNode[];
}

export interface Hierarchy {
  root: ViewNode;
  capturedAt: number;
  nodeCount: number;
  maxDepth: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'node',
});

function parseBounds(s: string | undefined): Bounds {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0, 0];
}

type RawNode = Record<string, string> & { node?: RawNode[] };

function toViewNode(raw: RawNode, id: string, depth: number): ViewNode {
  const b = (k: string) => raw[k] === 'true';
  return {
    id,
    depth,
    className: raw.class ?? '',
    resourceId: raw['resource-id'] ?? '',
    text: raw.text ?? '',
    contentDesc: raw['content-desc'] ?? '',
    packageName: raw.package ?? '',
    bounds: parseBounds(raw.bounds),
    clickable: b('clickable'),
    longClickable: b('long-clickable'),
    scrollable: b('scrollable'),
    focusable: b('focusable'),
    focused: b('focused'),
    enabled: b('enabled'),
    checkable: b('checkable'),
    checked: b('checked'),
    selected: b('selected'),
    password: b('password'),
    children: (raw.node ?? []).map((c, i) => toViewNode(c, `${id}.${i}`, depth + 1)),
  };
}

export function parseHierarchyXml(xml: string): Hierarchy {
  const doc = parser.parse(xml);
  const top: RawNode[] = doc?.hierarchy?.node ?? [];
  const root: ViewNode = {
    ...toViewNode({ class: 'hierarchy' } as RawNode, '0', 0),
    children: top.map((n, i) => toViewNode(n, `0.${i}`, 1)),
  };
  // 루트 bounds = 자식 합집합
  if (root.children.length) {
    root.bounds = root.children.reduce<Bounds>(
      (acc, c) => [
        Math.min(acc[0], c.bounds[0]),
        Math.min(acc[1], c.bounds[1]),
        Math.max(acc[2], c.bounds[2]),
        Math.max(acc[3], c.bounds[3]),
      ],
      [...root.children[0].bounds],
    );
  }
  let nodeCount = 0;
  let maxDepth = 0;
  walk(root, (n) => {
    nodeCount++;
    maxDepth = Math.max(maxDepth, n.depth);
  });
  return { root, capturedAt: Date.now(), nodeCount, maxDepth };
}


/**
 * 뷰 계층 덤프. 온디바이스 에이전트가 있으면 그것을 쓰고(0.1~0.3초), 없으면 uiautomator dump.
 * uiautomator dump는 애니메이션 중에는 "could not get idle state"로 실패할 수 있어 재시도한다.
 * 다른 uiautomator 세션(예: Appium)이 떠 있으면 실패한다.
 */
export async function dumpHierarchy(dev: DeviceAdb, retries = 3): Promise<Hierarchy> {
  try {
    const r = await withAgent(dev, async (a) => parseHierarchyXml(await a.hierarchyXml()));
    if (r) return r.value;
  } catch (e) {
    // 에이전트가 UiAutomation을 쥐고 있으면 uiautomator dump가 실패하므로 내리고 대체한다.
    // 실패로 기록해 잠시 uiautomator 만 쓴다 (덤프마다 에이전트를 다시 띄우지 않게)
    await stopAgent(dev, `뷰 계층 조회 실패: ${(e as Error).message}`);
  }
  // 덤프 파일은 호출마다 다른 이름으로 쓰고 지운다 (동시에 덤프하는 다른 호출·프로세스와 파일을 겹쳐 쓰지 않게)
  const remote = `/data/local/tmp/droidlens_ui_${randomBytes(6).toString('hex')}.xml`;
  let lastErr: unknown;
  try {
    for (let i = 0; i < retries; i++) {
      try {
        const out = await dev.shell(`uiautomator dump --compressed ${remote}`, { timeoutMs: 20_000 });
        if (!out.includes('dumped')) throw new Error(out.trim() || 'uiautomator dump 실패');
        const xml = (await dev.execOut(`cat ${remote}`)).toString('utf8');
        return parseHierarchyXml(xml);
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
  } finally {
    await dev.shell(`rm -f ${remote}`).catch(() => undefined);
  }
  throw lastErr;
}

export function walk(node: ViewNode, fn: (n: ViewNode, parent?: ViewNode) => void, parent?: ViewNode): void {
  fn(node, parent);
  for (const c of node.children) walk(c, fn, node);
}

export function flatten(root: ViewNode): ViewNode[] {
  const out: ViewNode[] = [];
  walk(root, (n) => out.push(n));
  return out;
}

// ---------- 셀렉터 ----------

export interface Selector {
  /** resource-id 전체 또는 ':id/' 뒤 이름 */
  id?: string;
  text?: string;
  textContains?: string;
  desc?: string;
  descContains?: string;
  className?: string;
  clickable?: boolean;
  /** 여러 개 매칭될 때 n번째 (0부터) */
  index?: number;
}

export function matches(n: ViewNode, s: Selector): boolean {
  if (s.id && n.resourceId !== s.id && !n.resourceId.endsWith(`:id/${s.id}`)) return false;
  if (s.text !== undefined && n.text !== s.text) return false;
  if (s.textContains && !n.text.toLowerCase().includes(s.textContains.toLowerCase())) return false;
  if (s.desc !== undefined && n.contentDesc !== s.desc) return false;
  if (s.descContains && !n.contentDesc.toLowerCase().includes(s.descContains.toLowerCase())) return false;
  if (s.className && n.className !== s.className && !n.className.endsWith(`.${s.className}`)) return false;
  if (s.clickable !== undefined && n.clickable !== s.clickable) return false;
  return true;
}

export function findNodes(root: ViewNode, s: Selector): ViewNode[] {
  const all = flatten(root).filter((n) => n.depth > 0 && matches(n, s));
  return s.index !== undefined ? all.slice(s.index, s.index + 1) : all;
}

export function center(n: ViewNode): { x: number; y: number } {
  const [l, t, r, b] = n.bounds;
  return { x: (l + r) / 2, y: (t + b) / 2 };
}

/** 좌표를 포함하는 가장 깊은(가장 작은) 노드 */
export function nodeAt(root: ViewNode, x: number, y: number): ViewNode | undefined {
  let best: ViewNode | undefined;
  walk(root, (n) => {
    const [l, t, r, b] = n.bounds;
    if (n.depth > 0 && x >= l && x <= r && y >= t && y <= b) {
      if (!best || n.depth >= best.depth) best = n;
    }
  });
  return best;
}

/** 텍스트 요약/아이콘 버튼 판단에 쓸 사람 친화적 라벨 */
export function labelOf(n: ViewNode): string {
  const short = n.resourceId.split(':id/')[1];
  return n.text || n.contentDesc || short || n.className.split('.').pop() || '';
}

/**
 * 에이전트·사람이 읽기 좋은 압축 트리. 의미 없는 래퍼 레이아웃은 건너뛰고 depth를 유지한다.
 * 각 줄: [id] 클래스 #resId "text" (desc) {플래그} @bounds
 */
export function toCompactText(root: ViewNode, opts: { maxDepth?: number; interactiveOnly?: boolean } = {}): string {
  const lines: string[] = [];
  const visit = (n: ViewNode, indent: number) => {
    if (opts.maxDepth !== undefined && n.depth > opts.maxDepth) return;
    const interesting =
      n.depth === 0 || n.text || n.contentDesc || n.resourceId || n.clickable || n.scrollable || n.checkable;
    const show = interesting && (!opts.interactiveOnly || n.clickable || n.scrollable || n.checkable || n.text);
    if (show) {
      const flags = [
        n.clickable && 'click',
        n.longClickable && 'long',
        n.scrollable && 'scroll',
        n.checkable && (n.checked ? 'checked' : 'unchecked'),
        n.selected && 'selected',
        n.focused && 'focused',
        !n.enabled && 'disabled',
      ].filter(Boolean);
      const parts = [
        `${'  '.repeat(indent)}[${n.id}]`,
        n.className.split('.').pop(),
        n.resourceId && `#${n.resourceId.split(':id/')[1] ?? n.resourceId}`,
        n.text && JSON.stringify(n.text.slice(0, 80)),
        n.contentDesc && `(${n.contentDesc.slice(0, 60)})`,
        flags.length ? `{${flags.join(',')}}` : '',
        n.depth > 0 ? `@${n.bounds.join(',')}` : '',
      ].filter(Boolean);
      lines.push(parts.join(' '));
    }
    for (const c of n.children) visit(c, show ? indent + 1 : indent);
  };
  visit(root, 0);
  return lines.join('\n');
}

/**
 * 화면 구조 시그니처. 텍스트·리스트 항목 개수 변화에는 둔감하도록
 * (클래스, resource-id) 골격만 depth 6까지 쓰고, 같은 부모 아래 반복 형제는 하나로 접는다.
 */
export function structureSignature(root: ViewNode, maxDepth = 6): string {
  const skel = (n: ViewNode, base = 0): string => {
    if (n.depth - base > maxDepth) return '';
    const kids = [...new Set(n.children.map((c) => skel(c, base)))].join(',');
    return `${n.className.split('.').pop()}#${n.resourceId.split(':id/')[1] ?? ''}(${kids})`;
  };
  return createHash('sha1').update(skel(root) + webPages(root, skel)).digest('hex').slice(0, 12);
}

/**
 * WebView 안 웹 페이지의 뼈대. 앱 뼈대는 maxDepth 에서 잘리고 WebView 는 스크롤 영역이라 내용이 빠져서,
 * 웹 페이지끼리 이동해도 시그니처가 그대로다. WebView 마다 그 아래를 WebView 깊이부터 다시 세어 붙인다.
 * 페이지 WebView 가 없으면 빈 문자열이라 네이티브 화면의 시그니처는 바뀌지 않는다
 */
function webPages(root: ViewNode, skel: (n: ViewNode, base: number) => string): string {
  const pages = pageWebViews(root).map((w) => [...new Set(w.children.map((c) => skel(c, w.depth)))].join(','));
  return pages.length ? `|web:${pages.join('|')}` : '';
}

const isWebView = (n: ViewNode) => n.className.endsWith('WebView');
const area = ({ bounds: [l, t, r, b] }: ViewNode) => Math.max(0, r - l) * Math.max(0, b - t);

/**
 * 화면 자체가 웹 페이지인 WebView: 화면의 절반 이상을 덮는 것만 (광고 배너·약관 칸 같은 작은 WebView 는 내용이 바뀌어도 다른 화면이 아니다).
 * WebView 는 두 겹(WebView 아래 WebView)으로 잡히기도 해서 가장 바깥 것만 쓴다
 */
export function pageWebViews(root: ViewNode): ViewNode[] {
  const screen = Math.max(0, ...root.children.map(area));
  const out: ViewNode[] = [];
  walk(root, (n, parent) => {
    if (isWebView(n) && !(parent && isWebView(parent)) && area(n) * 2 >= screen) out.push(n);
  });
  return out;
}

/**
 * 화면 그래프에서 '같은 화면'을 판단하는 시그니처. structureSignature 와 같되
 * - 스크롤 영역의 내용은 빼서 피드·목록의 항목 종류가 바뀌어도(배너가 끼거나 로딩 중이거나) 같은 화면으로 보고
 * - 페이저(ViewPager·ViewPager2)의 페이지는 화면 자체가 바뀌는 것이라 스크롤 영역이어도 내용을 남기고
 * - 선택 상태(하단 탭·탭 레이아웃의 고른 항목)를 넣어, 틀이 같은 탭 화면들이 하나로 합쳐지지 않게 한다
 * - WebView 안 웹 페이지의 뼈대를 붙여, 웹 페이지끼리 이동한 것을 다른 화면으로 본다
 */
export function screenSignature(root: ViewNode, maxDepth = 6): string {
  const isPager = (n: ViewNode) => /Pager/.test(n.className);
  const pages = new Set(pageWebViews(root));
  const skel = (n: ViewNode, base = 0, inPager = false): string => {
    if (n.depth - base > maxDepth) return '';
    // 페이지 WebView 는 페이지가 길어지면 스크롤 영역이 되는데, 그 내용이 곧 화면이라 접지 않는다
    const collapse = n.scrollable && !isPager(n) && !inPager && !pages.has(n);
    const kids = collapse ? '' : [...new Set(n.children.map((c) => skel(c, base, isPager(n))))].join(',');
    return `${n.className.split('.').pop()}#${n.resourceId.split(':id/')[1] ?? ''}${n.selected ? '*' : ''}(${kids})`;
  };
  // 뼈대는 maxDepth 에서 잘리는데, 하단 탭(BottomNavigationView 등)의 선택 상태는 보통 그보다 깊다.
  // 잘린 곳의 선택 항목만 따로 붙여서 탭 화면들이 하나로 합쳐지지 않게 한다 (얕은 곳만으로 구분되던 화면의 값은 그대로).
  // 세로 목록 안의 선택 항목은 화면을 쪼개지 않도록 넣지 않는다
  const deepSelected = new Set<string>();
  const walkSelected = (n: ViewNode, inList: boolean) => {
    if (n.depth > maxDepth && n.selected && !inList && (n.resourceId || n.text)) deepSelected.add(n.resourceId.split(':id/')[1] || `"${n.text}"`);
    const list = inList || (n.scrollable && !isPager(n) && !/HorizontalScrollView|TabLayout/.test(n.className));
    for (const c of n.children) walkSelected(c, list);
  };
  walkSelected(root, false);
  const extra = deepSelected.size ? `|${[...deepSelected].sort().join(',')}` : '';
  return createHash('sha1').update(skel(root) + extra + webPages(root, skel)).digest('hex').slice(0, 12);
}

/** 깊이별 노드 수 등 뷰 계층 통계 (오버드로/과도한 중첩 진단용) */
export function hierarchyStats(h: Hierarchy) {
  const byDepth: number[] = [];
  const byClass = new Map<string, number>();
  walk(h.root, (n) => {
    byDepth[n.depth] = (byDepth[n.depth] ?? 0) + 1;
    const c = n.className || '(root)';
    byClass.set(c, (byClass.get(c) ?? 0) + 1);
  });
  const isCompose = [...byClass.keys()].some((c) => c.includes('ComposeView') || c === 'android.view.View');
  return {
    nodeCount: h.nodeCount,
    maxDepth: h.maxDepth,
    byDepth,
    topClasses: [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    likelyCompose: isCompose,
  };
}
