/**
 * 화면 지도의 데이터 형식과 순수 계산 (Node 모듈을 쓰지 않아 데스크톱 렌더러에서도 import 한다).
 * 기기 조작·파일 저장은 graph.ts 에 있다.
 */
import type { SwipeDirection } from './device.js';
import type { Selector } from './hierarchy.js';

export type GraphAction =
  | { type: 'tap'; selector?: Selector; label?: string; x: number; y: number }
  | { type: 'longpress'; selector?: Selector; label?: string; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; direction?: SwipeDirection; durationMs?: number }
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
  /** 누를 수 있는 요소와 위치 (스크린샷 위 표시·지정 탐색용). 예전 기록·가져온 지도는 다음 방문 때 기기 화면에서 채운다 */
  targets?: ScreenTarget[];
  /** 눌러 본 요소의 key (탐색 커버리지) */
  tried?: string[];
  /**
   * 이 화면에서 선택된 상태인 요소의 key (하단 탭·탭 레이아웃의 고른 항목). 선택된 탭은 보통 누를 수 없어 targets 에 없다.
   * 다른 화면에서 같은 key 의 요소를 누르면 이 화면으로 온다고 보고 화면 이동에 쓴다
   */
  selectedKeys?: string[];
  lastSeen?: number;
}

export interface ScreenTarget {
  /** 요소 key (리소스 id + 라벨). 다시 방문해도 같은 요소를 가리킨다 */
  key: string;
  label: string;
  bounds: [number, number, number, number];
  longClickable?: boolean;
  /** 자동 탐색이 누르지 않는 위험 라벨 (결제·삭제·로그아웃 등) */
  danger?: boolean;
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
  /** 앱을 실행하면 처음 뜨는 화면 (경로 찾기·화면 이동의 출발점). 실제로 앱을 실행해 본 적이 있을 때만 있다 */
  launchScreen?: string;
  nodes: ScreenNode[];
  edges: ScreenEdge[];
}

/** 사용자가 화면에서 지정한 인터랙션. 요소는 ScreenTarget.key 로 가리킨다 */
export type Interaction =
  | { kind: 'tap'; key: string }
  | { kind: 'longpress'; key: string }
  | { kind: 'swipe'; direction: SwipeDirection };

/** 탐색 중 절대 누르지 않을 위험 라벨 (결제·삭제·로그아웃·전송 등) */
export const DANGEROUS_LABELS =
  /(log ?out|sign ?out|delete|remove|uninstall|purchase|buy|pay|checkout|order|send|submit|report|block|unsubscribe|deactivate|reset|로그아웃|삭제|탈퇴|결제|구매|주문|송금|전송|보내기|신고|차단|지우기|초기화|해지|구독|등록하기|완료)/i;

/** 경로를 다시 따라갈 때 눌러도 되는 키. enter 는 입력창에서 전송이 될 수 있고 home·recents·power 는 앱 밖으로 나가므로 뺀다 */
const REPLAY_KEYS = new Set(['back']);

export function actionLabel(a: GraphAction): string {
  switch (a.type) {
    case 'tap':
      return a.label ? `tap "${a.label}"` : `tap ${Math.round(a.x)},${Math.round(a.y)}`;
    case 'longpress':
      return a.label ? `long press "${a.label}"` : `long press ${Math.round(a.x)},${Math.round(a.y)}`;
    case 'swipe':
      return a.direction ? `swipe ${a.direction}` : 'swipe';
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

/** 요소를 누른 행동이 가리키는 요소 key (ScreenTarget.key 와 같은 형식) */
export function actionKey(a: GraphAction): string | undefined {
  if ((a.type !== 'tap' && a.type !== 'longpress') || !a.label) return undefined;
  return `${a.selector?.id ?? ''}|${a.label}`;
}

/**
 * 화면 이동·탐색 복귀에서 다시 실행해도 되는 연결인가. 연결은 다른 사람이 준 지도 파일에서 왔을 수 있으므로
 * 기록된 좌표를 그대로 누르는 행동은 쓰지 않는다:
 * - 탭·길게 누르기는 라벨이 있어 기기 화면에서 같은 요소를 다시 찾을 수 있고 위험 라벨이 아닐 때만
 * - 스와이프는 방향이 있을 때만 (재생할 때 화면 크기로 좌표를 다시 계산한다. 좌표가 한 점인 스와이프는 사실상 탭이다)
 * - 키는 back 만. 딥링크·수동 연결은 다시 실행할 수 없다
 */
export function isReplayable(a: GraphAction): boolean {
  switch (a.type) {
    case 'tap':
    case 'longpress':
      return !!a.label && !DANGEROUS_LABELS.test(a.label);
    case 'swipe':
      return !!a.direction;
    case 'key':
      return REPLAY_KEYS.has(a.key);
    default:
      return false;
  }
}

/** 앱 실행 첫 화면. 실행 기록이 없는 지도는 가장 먼저 기록된 화면을 출발점으로 보여 준다 (화면 이동에는 쓰지 않는다) */
export function startScreenOf(g: Pick<GraphData, 'launchScreen' | 'nodes'>): string | undefined {
  if (g.launchScreen && g.nodes.some((n) => n.id === g.launchScreen)) return g.launchScreen;
  return [...g.nodes].sort((a, b) => a.firstSeen - b.firstSeen)[0]?.id;
}

/** 두 화면 사이 최단 경로 (BFS). filter 를 주면 그 연결만 쓴다 */
export function shortestPath(edges: Iterable<ScreenEdge>, from: string, to: string, filter?: (e: ScreenEdge) => boolean): ScreenEdge[] | undefined {
  const out = new Map<string, ScreenEdge[]>();
  for (const e of edges) {
    if (e.from === e.to || (filter && !filter(e))) continue;
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }
  const prev = new Map<string, ScreenEdge>();
  const seen = new Set([from]);
  const q = [from];
  for (let i = 0; i < q.length && !seen.has(to); i++) {
    for (const e of out.get(q[i]) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, e);
      q.push(e.to);
    }
  }
  if (!seen.has(to)) return undefined;
  const path: ScreenEdge[] = [];
  for (let c = to; c !== from; c = prev.get(c)!.from) path.unshift(prev.get(c)!);
  return path;
}

/** 화면에서 눌러 본 요소 key (지금 요소 목록에 있는 것만). 눌러 본 기록이 없던 예전 지도는 나간 연결로 짐작한다 */
export function triedKeys(edges: Iterable<ScreenEdge>, n: ScreenNode): Set<string> {
  const known = new Set((n.targets ?? []).map((t) => t.key));
  const done = new Set((n.tried ?? []).filter((k) => known.has(k)));
  for (const e of edges) {
    const k = e.from === n.id ? actionKey(e.action) : undefined;
    if (k && known.has(k)) done.add(k);
  }
  return done;
}
