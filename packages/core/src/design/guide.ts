import { z } from 'zod';

/**
 * 디자인 가이드 (#77): Figma 커넥터 응답 원문(메타데이터 XML · 디자인 코드)을 파싱해 비교에 쓸 형식으로 만든다.
 * 에이전트는 값을 옮겨 적지 않고 응답을 그대로 넘긴다. 파싱으로 못 얻은 값은 비워 두고 비교에서 뺀다.
 *   - get_metadata: 노드마다 id·이름·x·y·너비·높이 (부모 기준). 글자 노드의 이름이 곧 문구
 *   - get_design_context: React+Tailwind 코드. 노드마다 data-node-id 가 붙고 값이 숫자로 들어 있다
 *     (text-[15px] · font-semibold · leading-[1.4] · text-[#191919] · bg-[#f6f6f6] · px-[20px] · gap-[24px] · rounded-[8px])
 */

export const DESIGN_GUIDE_VERSION = 1;
/** Figma 노드 id: 7:1942, 인스턴스 안은 I7:1979;1:3615 */
export const FIGMA_NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;
const HEX = /^#[0-9a-f]{6}$/;

const rectSchema = z
  .object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().nonnegative(), h: z.number().finite().nonnegative() })
  .strict();

export const guideElementSchema = z
  .object({
    id: z.string().max(200).regex(FIGMA_NODE_ID),
    name: z.string().max(500),
    kind: z.enum(['text', 'box']),
    text: z.string().max(2000).optional(),
    /** 프레임 왼쪽 위 기준 위치·크기 (Figma px). 메타데이터에 없는 노드(인스턴스 안)는 없음 */
    rect: rectSchema.optional(),
    font: z
      .object({
        size: z.number().positive().max(500).optional(),
        weight: z.number().int().min(100).max(1000).optional(),
        /** 줄 높이 (Figma px) */
        lineHeight: z.number().positive().max(1000).optional(),
      })
      .strict()
      .optional(),
    /** 글자 색 */
    color: z.string().regex(HEX).optional(),
    /** 이 노드 자신의 배경 색 */
    background: z.string().regex(HEX).optional(),
    /** 글자 뒤에 보일 배경: 자신 또는 가장 가까운 조상의 배경 */
    behind: z.string().regex(HEX).optional(),
    border: z.string().regex(HEX).optional(),
    radius: z.number().nonnegative().max(10000).optional(),
    /** 안쪽 여백 [위, 오른쪽, 아래, 왼쪽] */
    padding: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    gap: z.number().nonnegative().max(10000).optional(),
    parent: z.string().max(200).regex(FIGMA_NODE_ID).optional(),
    /** 가격·날짜·닉네임처럼 시안에 예시로 넣은 문구: 문구 비교에서 뺀다 */
    example: z.boolean().optional(),
    /** 폭이 부모를 채운다(w-full·self-stretch) true, 고정 폭(w-[320px]) false, 모르면 없음 (#89 상자 크기) */
    fill: z.boolean().optional(),
    /** 부모 주축으로 늘어난다(flex-1·grow): 형제와 폭을 나누므로 폭은 모른다. 크기 비교에서 폭을 뺀다 */
    grow: z.boolean().optional(),
  })
  .strict();

/** 가이드와 함께 저장한 Figma 프레임 이미지 (#89). 파일은 guide.json 옆에 둔다 */
export const guideImageSchema = z
  .object({
    file: z.literal('figma.png'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** 이미지 px 가 Figma px 몇 개인가 (2 면 @2x) */
    scale: z.number().positive().max(10),
  })
  .strict();

export const designGuideSchema = z
  .object({
    version: z.literal(DESIGN_GUIDE_VERSION),
    figma: z.string().max(2000),
    frame: z
      .object({
        id: z.string().max(200).regex(FIGMA_NODE_ID),
        name: z.string().max(500),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
    /** Figma px 하나가 몇 dp 인가. 360~480 폭 프레임이면 1, @2x·@3x 로 그린 큰 프레임이면 360/폭 */
    scale: z.number().positive().max(10),
    elements: z.array(guideElementSchema).max(5000),
    image: guideImageSchema.optional(),
    savedAt: z.number().int(),
  })
  .strict();

export type GuideElement = z.infer<typeof guideElementSchema>;
export type DesignGuide = z.infer<typeof designGuideSchema>;
export type GuideImage = z.infer<typeof guideImageSchema>;

/** Figma 링크에서 파일 키와 노드 id. node-id=1-2 → 1:2, 브랜치 링크는 브랜치 키 */
export function parseFigmaLink(link: string): { fileKey: string; nodeId?: string } | undefined {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || !/(^|\.)figma\.com$/.test(u.hostname)) return undefined;
  const m = /^\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/.exec(u.pathname);
  if (!m) return undefined;
  const raw = u.searchParams.get('node-id')?.replace(/-/g, ':');
  return { fileKey: m[2] ?? m[1], ...(raw && FIGMA_NODE_ID.test(raw) ? { nodeId: raw } : {}) };
}

export interface FigmaGuideInput {
  /** TC 의 Figma 프레임 링크 */
  figma: string;
  /** get_metadata 응답 원문 */
  metadata?: string;
  /** get_design_context 응답 원문들 (큰 프레임은 섹션마다 나눠 읽은 것) */
  code?: string[];
  /** 예시값으로 볼 노드 id */
  example?: string[];
  /** 프레임 폭과 상관없이 Figma px 당 dp 를 정할 때 */
  scale?: number;
}

export interface ParsedGuide {
  guide: DesignGuide;
  /** 사람이 볼 알림: 모르는 값으로 둔 것, 무시한 입력 */
  notes: string[];
}

// ---------- 메타데이터 XML ----------

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });

interface MetaNode {
  id: string;
  tag: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parent?: string;
}

const TAG = /<(\/?)([a-z][a-z0-9-]*)((?:\s+[a-z-]+="[^"]*")*)\s*(\/?)>/gi;
const ATTR = /([a-z-]+)="([^"]*)"/gi;

/**
 * 메타데이터 XML 의 노드를 프레임 기준 좌표로 펼친다. 응답 앞뒤의 안내 글은 건너뛴다.
 * 자식 좌표는 부모 기준이고, group 은 좌표 공간을 만들지 않아 그 자식은 group 의 부모 기준이다.
 * 응답에 프레임이 여럿이면(섹션·페이지를 읽었거나 여러 응답을 이어 붙임) rootId 노드를 프레임으로 삼고 그 안쪽만 남긴다 (#89).
 * rootId 가 없거나 못 찾으면 첫 번째 맨 바깥 노드를 쓰고 others 에 나머지 맨 바깥 노드 수를 적는다
 */
export function parseFigmaMetadata(
  xml: string,
  rootId?: string,
): { frame?: MetaNode; nodes: MetaNode[]; others: number; outside: Set<string> } {
  const all: MetaNode[] = [];
  /** space: 이 노드의 자식 좌표가 기준으로 삼는 원점 (보통 노드 자신, group 이면 그 부모의 원점) */
  const stack: { node: MetaNode; space: { x: number; y: number } }[] = [];
  const tops: MetaNode[] = [];
  for (const m of xml.matchAll(TAG)) {
    const [, close, tag, attrs, self] = m;
    if (close) {
      if (stack.length && stack[stack.length - 1].node.tag === tag.toLowerCase()) stack.pop();
      continue;
    }
    const a: Record<string, string> = {};
    for (const [, k, v] of attrs.matchAll(ATTR)) a[k.toLowerCase()] = unescapeXml(v);
    if (!a.id || !FIGMA_NODE_ID.test(a.id)) continue;
    const num = (k: string) => (Number.isFinite(Number(a[k])) ? Number(a[k]) : 0);
    const top = stack[stack.length - 1];
    // 맨 바깥 노드는 캔버스 위치 그대로 두고, 프레임을 고른 뒤 그 프레임 기준으로 옮긴다
    const x = top ? top.space.x + num('x') : num('x');
    const y = top ? top.space.y + num('y') : num('y');
    const node: MetaNode = { id: a.id, tag: tag.toLowerCase(), name: a.name ?? '', x, y, w: num('width'), h: num('height'), parent: top?.node.id };
    if (!top) tops.push(node);
    all.push(node);
    if (!self) stack.push({ node, space: node.tag === 'group' && top ? top.space : { x, y } });
  }
  // 링크의 노드가 자식을 가진 틀(글자가 아닌 노드)일 때만 그 노드를 프레임으로 삼는다
  const linked = rootId ? all.find((n) => n.id === rootId && n.tag !== 'text') : undefined;
  const frame = (linked && all.some((n) => n.parent === linked.id) ? linked : undefined) ?? tops[0];
  if (!frame) return { nodes: [], others: 0, outside: new Set() };
  // 프레임 안쪽만: 부모를 따라 올라가 프레임에 닿는 노드
  const byId = new Map(all.map((n) => [n.id, n]));
  const memo = new Map<MetaNode, boolean>([[frame, true]]);
  const inside = (n: MetaNode): boolean => {
    const path: MetaNode[] = [];
    let p: MetaNode | undefined = n;
    let hit = false;
    for (; p; p = p.parent ? byId.get(p.parent) : undefined) {
      const known = memo.get(p);
      if (known !== undefined) {
        hit = known;
        break;
      }
      path.push(p);
    }
    for (const q of path) memo.set(q, hit);
    return hit;
  };
  const nodes = all
    .filter(inside)
    .map((n) => ({ ...n, x: n.x - frame.x, y: n.y - frame.y, ...(n === frame ? { parent: undefined } : {}) }));
  return {
    frame: nodes[0],
    nodes,
    others: tops.filter((t) => t !== frame && !inside(t)).length,
    outside: new Set(all.filter((n) => !inside(n)).map((n) => n.id)),
  };
}

// ---------- 디자인 코드 (React + Tailwind) ----------

interface CodeNode {
  id: string;
  name?: string;
  parent?: string;
  /** 이 노드에 붙은 클래스 (자신 → 안쪽 래퍼 순) */
  classes: string[];
  text: string;
  hasText: boolean;
}

/** 파싱 상한: 이보다 깊거나 많으면 디자인 코드가 아니라고 보고 멈춘다 (악의적인 입력으로 서버가 멈추지 않게) */
const MAX_DEPTH = 512;
const MAX_CODE_NODES = 5000;

interface JsxTag {
  close: boolean;
  self: boolean;
  tag: string;
  /** 속성 이름 → 값 원문 (따옴표 안 글자, 또는 { } 안의 식) */
  attrs: Map<string, { quoted?: string; expr?: string }>;
  start: number;
  end: number;
}

/**
 * 짝이 안 맞는 긴 입력에서 제곱 시간이 되지 않게 (#89): 괄호 하나를 훑는 글자 수에 상한을 두고,
 * 끝(또는 상한)까지 짝을 못 찾은 훑기는 그 구간 안 모든 { 의 짝을 한 번에 적어 둔다(스택). 그 구간 안의 { 는 다시 훑지 않고
 * 적어 둔 짝을 쓴다. 짝 없는 { 하나 때문에 뒤의 정상 속성까지 버리지 않는다.
 * 따옴표 속성도 한 번 짝을 못 찾으면 그 위치 뒤로는 같은 따옴표를 다시 찾지 않는다
 */
const MAX_BRACE_SCAN = 100_000;
interface ScanState {
  /** 짝을 못 찾은 훑기가 지나간 구간 [from, to). 이 안의 { 는 brace 에서 짝을 찾는다(없으면 짝 없음) */
  scanned: { from: number; to: number } | null;
  /** { 위치 → 짝이 맞는 닫는 괄호 다음 위치 */
  brace: Map<number, number>;
  /** 따옴표별로, 이 위치 뒤에는 그 따옴표가 없다 */
  noQuoteAfter: Record<string, number>;
}
const newScanState = (): ScanState => ({ scanned: null, brace: new Map(), noQuoteAfter: {} });

/** i 가 여는 괄호({)일 때 짝이 맞는 닫는 괄호 다음 위치. 문자열·템플릿 안의 괄호는 세지 않는다 */
function skipBraces(code: string, i: number, st: ScanState): number {
  if (st.scanned && i >= st.scanned.from && i < st.scanned.to) return st.brace.get(i) ?? -1;
  const start = i;
  const end = Math.min(code.length, i + MAX_BRACE_SCAN);
  const open: number[] = [];
  const found = new Map<number, number>();
  for (; i < end; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < end && code[i] !== q; i++) if (code[i] === '\\') i++;
    } else if (c === '{') open.push(i);
    else if (c === '}' && open.length) {
      const o = open.pop()!;
      if (o === start) return i + 1;
      found.set(o, i + 1);
    }
  }
  st.scanned = { from: start, to: end };
  st.brace = found;
  return -1;
}

/** code[i] 가 '<' 일 때 JSX 태그 하나를 읽는다. 태그가 아니면(비교 연산자·타입 인자 등) undefined */
function readTag(code: string, i: number, st: ScanState = newScanState()): JsxTag | undefined {
  let j = i + 1;
  const close = code[j] === '/';
  if (close) j++;
  const name = /^[A-Za-z][\w.]*/.exec(code.slice(j, j + 200))?.[0];
  if (!name) return undefined;
  j += name.length;
  const attrs: JsxTag['attrs'] = new Map();
  for (;;) {
    while (j < code.length && /\s/.test(code[j])) j++;
    const c = code[j];
    if (c === undefined) return undefined;
    if (c === '>') return { close, self: false, tag: name, attrs, start: i, end: j + 1 };
    if (c === '/' && code[j + 1] === '>') return { close, self: true, tag: name, attrs, start: i, end: j + 2 };
    if (c === '{') {
      // {...props}
      j = skipBraces(code, j, st);
      if (j < 0) return undefined;
      continue;
    }
    const key = /^[\w-]+/.exec(code.slice(j, j + 200))?.[0];
    if (!key) return undefined;
    j += key.length;
    if (code[j] !== '=') {
      attrs.set(key, {});
      continue;
    }
    j++;
    const q = code[j];
    if (q === '"' || q === "'") {
      if (j >= (st.noQuoteAfter[q] ?? Infinity)) return undefined;
      const e = code.indexOf(q, j + 1);
      if (e < 0) {
        st.noQuoteAfter[q] = j;
        return undefined;
      }
      attrs.set(key, { quoted: code.slice(j + 1, e) });
      j = e + 1;
    } else if (q === '{') {
      const e = skipBraces(code, j, st);
      if (e < 0) return undefined;
      attrs.set(key, { expr: code.slice(j + 1, e - 1) });
      j = e;
    } else return undefined;
  }
}

function attrValue(t: JsxTag, name: string): string | undefined {
  const v = t.attrs.get(name);
  if (!v) return undefined;
  if (v.quoted !== undefined) return v.quoted;
  // className={className || "h-[30px] relative"}: 식 안의 문자열만 모은다
  return [...(v.expr ?? '').matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2] ?? x[3]).join(' ');
}

/** 태그 사이 글자. {"글자"} 는 풀고, 그 밖의 { } 식(변수·조건)이 남으면 글자가 아니라 코드로 본다 */
function jsxText(s: string): string | undefined {
  const t = s.replace(/\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\}/g, (_, a, b, c) => a ?? b ?? c ?? '');
  if (/[{}]/.test(t)) return undefined;
  return unescapeXml(t.replace(/&nbsp;/g, ' '));
}

/** 디자인 코드에서 data-node-id 가 붙은 요소마다 클래스와 글자를 모은다 */
export function parseFigmaCode(code: string): CodeNode[] {
  const out = new Map<string, CodeNode>();
  /** node: 이 태그 또는 가장 가까운 바깥 태그의 노드 */
  const stack: { tag: string; node?: CodeNode }[] = [];
  const current = () => stack[stack.length - 1]?.node;
  let last = 0;
  const st = newScanState();
  for (let i = code.indexOf('<'); i >= 0; i = code.indexOf('<', i + 1)) {
    const t = readTag(code, i, st);
    if (!t) continue;
    // 태그 사이 글자는 JSX 안(스택이 있을 때)에서만 모은다: import·타입 선언·return 문은 건너뛴다
    const holder = current();
    const between = code.slice(last, t.start);
    if (holder && /\S/.test(between)) {
      const text = jsxText(between);
      if (text !== undefined) {
        holder.text += text;
        holder.hasText = true;
      }
    }
    last = t.end;
    i = t.end - 1;
    if (t.close) {
      for (let k = stack.length - 1; k >= 0; k--)
        if (stack[k].tag === t.tag) {
          stack.length = k;
          break;
        }
      continue;
    }
    const id = attrValue(t, 'data-node-id');
    const classes = (attrValue(t, 'className') ?? '').split(/\s+/).filter(Boolean);
    let node = holder;
    if (id && FIGMA_NODE_ID.test(id)) {
      node = out.get(id);
      if (!node) {
        if (out.size >= MAX_CODE_NODES)
          throw new Error(`디자인 코드의 노드가 ${MAX_CODE_NODES}개를 넘습니다. 프레임을 섹션으로 나눠 읽으세요`);
        node = { id, parent: holder?.id, classes: [], text: '', hasText: false };
        out.set(id, node);
      }
      const name = attrValue(t, 'data-name');
      if (name) node.name = name;
      node.classes.push(...classes);
    } else if (/^[a-z]/.test(t.tag)) {
      // id 없는 HTML 래퍼의 클래스는 바깥 노드 것. 컴포넌트(<Button className=…/>)의 클래스는 그 컴포넌트 정의 쪽 노드 것이라 붙이지 않는다
      holder?.classes.push(...classes);
    }
    if (!t.self) {
      if (stack.length >= MAX_DEPTH) throw new Error(`디자인 코드가 ${MAX_DEPTH}단보다 깊습니다`);
      stack.push({ tag: t.tag, node });
    }
  }
  return [...out.values()];
}

// ---------- Tailwind 클래스 → 값 ----------

const WEIGHT: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
  heavy: 900,
};

/** #abc · #aabbcc · #aabbccdd(불투명만) · white · black · var(--x,#aabbcc) → #aabbcc */
export function cssColor(v: string): string | undefined {
  const s = v.trim().toLowerCase();
  if (s === 'white') return '#ffffff';
  if (s === 'black') return '#000000';
  const fallback = /var\(--[^,()]+,\s*([^()]+)\)/.exec(s);
  if (fallback) return cssColor(fallback[1]);
  const m = /^(?:color:)?#([0-9a-f]{3,8})$/.exec(s);
  if (!m) return undefined;
  const h = m[1];
  if (h.length === 3) return `#${[...h].map((c) => c + c).join('')}`;
  if (h.length === 6) return `#${h}`;
  if (h.length === 8 && h.endsWith('ff')) return `#${h.slice(0, 6)}`;
  return undefined;
}

/** 15px · 15 · var(--x,15px) · length:var(--x,15px) → 15 */
function cssPx(v: string): number | undefined {
  const s = v.replace(/^length:/, '').trim();
  const fallback = /var\(--[^,()]+,\s*([^()]+)\)/.exec(s);
  if (fallback) return cssPx(fallback[1]);
  const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(s);
  return m ? Number(m[1]) : undefined;
}

const arb = (cls: string, prefix: string) =>
  cls.startsWith(`${prefix}-[`) && cls.endsWith(']') ? cls.slice(prefix.length + 2, -1).replace(/_/g, ' ') : undefined;

interface Style {
  fontSize?: number;
  weight?: number;
  /** 배수(1.4) 또는 px */
  leading?: { ratio?: number; px?: number };
  color?: string;
  background?: string;
  border?: string;
  radius?: number;
  padding: [number?, number?, number?, number?];
  gap?: number;
  /** 폭이 부모를 채우나 (w-full·self-stretch → true, w-[320px] → false) */
  fill?: boolean;
  /** flex-1·grow: 부모 주축으로 형제와 나눠 늘어난다. 폭을 알 수 없다 */
  grow?: boolean;
}

export function parseClasses(classes: string[]): Style {
  const st: Style = { padding: [] };
  for (const raw of classes) {
    const c = raw.replace(/^!/, '');
    let v: string | undefined;
    if ((v = arb(c, 'text')) !== undefined) {
      const col = cssColor(v);
      if (col) st.color = col;
      else if (cssPx(v) !== undefined) st.fontSize = cssPx(v);
    } else if (c === 'text-white' || c === 'text-black') st.color = cssColor(c.slice(5));
    else if ((v = arb(c, 'leading')) !== undefined) {
      const px = /px\)?$/.test(v) ? cssPx(v) : undefined;
      const n = Number(v);
      if (px) st.leading = { px };
      else if (Number.isFinite(n) && n > 0) st.leading = { ratio: n };
    } else if (c.startsWith('font-')) {
      const named = WEIGHT[c.slice(5)];
      if (named) st.weight = named;
      // font-['Pretendard:SemiBold'] · font-['Pretendard_Variable:Bold']
      const fam = /^font-\['[^':]*:([A-Za-z]+)'/.exec(c);
      if (fam && st.weight === undefined) st.weight = WEIGHT[fam[1].toLowerCase()];
      const num = arb(c, 'font');
      if (num && /^\d{3}$/.test(num)) st.weight = Number(num);
    } else if ((v = arb(c, 'bg')) !== undefined) {
      const col = cssColor(v);
      if (col) st.background = col;
    } else if (c === 'bg-white' || c === 'bg-black') st.background = cssColor(c.slice(3));
    else if ((v = arb(c, 'border')) !== undefined) {
      const col = cssColor(v);
      if (col) st.border = col;
    } else if (c === 'rounded-full') st.radius = 9999;
    else if ((v = arb(c, 'rounded')) !== undefined) {
      const px = cssPx(v);
      if (px !== undefined) st.radius = px;
    } else if ((v = arb(c, 'gap')) !== undefined) {
      const px = cssPx(v);
      if (px !== undefined) st.gap = px;
    } else if (/^(w-full|self-stretch|inset-x-0)$/.test(c)) st.fill = true;
    else if (/^(flex-1|grow|flex-grow|flex-\[1_.*\])$/.test(c)) st.grow = true;
    else if ((v = arb(c, 'w')) !== undefined) {
      if (cssPx(v) !== undefined && st.fill === undefined) st.fill = false;
    } else {
      const pad = /^p([xytrbl]?)-\[(.+)\]$/.exec(c);
      const px = pad ? cssPx(pad[2].replace(/_/g, ' ')) : undefined;
      if (pad && px !== undefined) {
        const sides = { '': [0, 1, 2, 3], x: [1, 3], y: [0, 2], t: [0], r: [1], b: [2], l: [3] }[pad[1]] ?? [];
        for (const i of sides) st.padding[i] = px;
      }
    }
  }
  return st;
}

// ---------- 합치기 ----------

const TEXT_TAGS = new Set(['text']);
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();

/** 프레임 폭으로 Figma px 당 dp 를 고른다. 휴대폰 1배 폭(320~480)이면 1, 그보다 크면 @2x·@3x 로 보고 360 폭으로 맞춘다 */
export function defaultScale(frameWidth: number): number {
  if (frameWidth >= 320 && frameWidth <= 480) return 1;
  if (frameWidth > 480) return Math.round((360 / frameWidth) * 1000) / 1000;
  return 1;
}

/** Figma 커넥터 응답 원문으로 가이드를 만든다. 형식이 맞지 않으면 던진다 */
export function buildDesignGuide(input: FigmaGuideInput): ParsedGuide {
  const notes: string[] = [];
  const rootId = parseFigmaLink(input.figma)?.nodeId;
  const meta = input.metadata ? parseFigmaMetadata(input.metadata, rootId) : { nodes: [] as MetaNode[], others: 0, outside: new Set<string>() };
  if (meta.others)
    notes.push(
      meta.frame && meta.frame.id === rootId
        ? `메타데이터에 프레임이 여럿이라 링크의 ${rootId} 안쪽만 썼습니다 (다른 맨 바깥 노드 ${meta.others}개는 뺌)`
        : `메타데이터에 맨 바깥 노드가 여럿이라 첫 번째(${meta.frame?.id})만 썼습니다. 링크의 노드 id 와 같은 프레임을 읽었는지 확인하세요`,
    );
  let code = (input.code ?? []).flatMap((c) => parseFigmaCode(c));
  if (meta.outside.size) {
    // 다른 프레임의 노드는 버린다: 코드의 부모를 따라 올라가다 메타데이터에서 프레임 밖이던 노드에 닿으면 뺀다
    const inMeta = new Set(meta.nodes.map((n) => n.id));
    const codeById = new Map(code.map((c) => [c.id, c]));
    const keep = (c: CodeNode) => {
      const seen = new Set<string>();
      for (let p: CodeNode | undefined = c; p && !seen.has(p.id); p = p.parent ? codeById.get(p.parent) : undefined) {
        if (inMeta.has(p.id)) return true;
        if (meta.outside.has(p.id)) return false;
        seen.add(p.id);
      }
      return true;
    };
    const before = code.length;
    code = code.filter(keep);
    if (code.length < before) notes.push(`디자인 코드의 노드 ${before - code.length}개는 프레임 밖이라 뺐습니다`);
  }
  if (!meta.nodes.length && !code.length)
    throw new Error('메타데이터나 디자인 코드에서 Figma 노드(data-node-id)를 찾지 못했습니다. 커넥터 응답 원문을 그대로 넘기세요');
  if (input.metadata && !meta.nodes.length) notes.push('메타데이터에서 노드를 찾지 못해 위치·크기는 모름으로 둡니다');

  const byId = new Map<string, GuideElement>();
  for (const n of meta.nodes) {
    const text = TEXT_TAGS.has(n.tag);
    byId.set(n.id, {
      id: n.id,
      name: clean(n.name).slice(0, 500),
      kind: text ? 'text' : 'box',
      ...(text ? { text: clean(n.name).slice(0, 2000) } : {}),
      rect: { x: n.x, y: n.y, w: n.w, h: n.h },
      ...(n.parent ? { parent: n.parent } : {}),
    });
  }
  for (const c of code) {
    const st = parseClasses(c.classes);
    const prev = byId.get(c.id);
    const text = c.hasText ? clean(c.text.replace(/\s+/g, ' ')) : undefined;
    const el: GuideElement = prev ?? {
      id: c.id,
      name: clean(c.name ?? text ?? '').slice(0, 500),
      kind: 'box',
      ...(c.parent ? { parent: c.parent } : {}),
    };
    if (text) {
      el.kind = 'text';
      el.text = text.slice(0, 2000);
    }
    const size = st.fontSize;
    const lineHeight = st.leading?.px ?? (st.leading?.ratio && size ? Math.round(st.leading.ratio * size * 100) / 100 : undefined);
    if (size || st.weight || lineHeight)
      el.font = {
        ...el.font,
        ...(size ? { size } : {}),
        ...(st.weight ? { weight: st.weight } : {}),
        ...(lineHeight ? { lineHeight } : {}),
      };
    if (st.color) el.color = st.color;
    if (st.background) el.background = st.background;
    if (st.border) el.border = st.border;
    if (st.radius !== undefined) el.radius = st.radius;
    if (st.gap !== undefined) el.gap = st.gap;
    if (st.fill !== undefined) el.fill = st.fill;
    if (st.grow && st.fill === undefined) el.grow = true;
    if (st.padding.some((p) => p !== undefined))
      el.padding = [0, 1, 2, 3].map((i) => st.padding[i] ?? 0) as [number, number, number, number];
    if (!el.parent && c.parent) el.parent = c.parent;
    byId.set(c.id, el);
  }

  // 글자 뒤 배경: 자신 또는 가장 가까운 조상의 배경
  for (const el of byId.values()) {
    if (el.kind !== 'text') continue;
    const seen = new Set<string>();
    for (let p: GuideElement | undefined = el; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
      seen.add(p.id);
      if (p.background) {
        el.behind = p.background;
        break;
      }
    }
  }

  const examples = new Set(input.example ?? []);
  for (const id of examples) {
    const el = byId.get(id);
    if (el?.kind === 'text') el.example = true;
    else notes.push(`예시값으로 고른 ${id} 는 글자 노드가 아니어서 무시합니다`);
  }

  const frameNode = meta.frame;
  const first = byId.values().next().value as GuideElement | undefined;
  const frame = frameNode
    ? { id: frameNode.id, name: clean(frameNode.name).slice(0, 500) || frameNode.id, width: frameNode.w, height: frameNode.h }
    : first?.rect
      ? { id: first.id, name: first.name || first.id, width: first.rect.w, height: first.rect.h }
      : undefined;
  if (!frame || !(frame.width > 0) || !(frame.height > 0))
    throw new Error('프레임 크기를 알 수 없습니다. 같은 프레임의 get_metadata 응답을 함께 넘기세요');
  if (frameNode) byId.delete(frameNode.id);

  const elements = [...byId.values()];
  const texts = elements.filter((e) => e.kind === 'text');
  const noSize = texts.filter((e) => !e.font?.size).length;
  const noColor = texts.filter((e) => !e.color).length;
  const noRect = texts.filter((e) => !e.rect).length;
  if (!input.code?.length) notes.push('디자인 코드가 없어 글자 크기·색은 모름으로 둡니다 (get_design_context 응답을 넘기면 비교합니다)');
  else {
    if (noSize) notes.push(`글자 노드 ${noSize}개는 글자 크기를 모릅니다 (디자인 코드에 없음)`);
    if (noColor) notes.push(`글자 노드 ${noColor}개는 글자 색을 모릅니다`);
  }
  if (noRect) notes.push(`글자 노드 ${noRect}개는 위치를 모릅니다 (인스턴스 안이라 메타데이터에 없음). 간격은 비교하지 않습니다`);

  const scale = input.scale ?? defaultScale(frame.width);
  if (input.scale === undefined && scale !== 1)
    notes.push(`프레임 폭 ${frame.width} 를 @${(1 / scale).toFixed(1)}x 로 보고 Figma px 당 ${scale}dp 로 맞춥니다`);
  const guide = designGuideSchema.parse({
    version: DESIGN_GUIDE_VERSION,
    figma: input.figma,
    frame,
    scale,
    elements,
    savedAt: Date.now(),
  });
  return { guide, notes };
}
