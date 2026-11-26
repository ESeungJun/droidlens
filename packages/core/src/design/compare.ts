import type { Bounds } from '../hierarchy.js';
import { deltaE2000, hexToRgb } from './color.js';
import type { DesignGuide, GuideElement } from './guide.js';
import { anchorOf, expectedPosition, horizontalOffset, matchTexts, type MatchedPair, type MatchHow } from './match.js';
import { measureBox, type MeasuredText, type Raster, type ScreenMetrics } from './measure.js';

/**
 * 차이 판정 (#77, #89): 짝지은 요소마다 문구·글자 크기·굵기·줄 높이·글자 색·배경 색·가로 여백·위 요소와의 간격을,
 * 배경이 있는 상자마다 크기·모서리를 비교하고 허용치를 넘는 것만 남긴다. 추정값으로만 나온 차이는 '낮음'(사람이 확인)으로 둔다.
 */

export const DESIGN_TOLERANCE = {
  /** sp (추정값은 1sp) */
  fontSize: 0.5,
  fontSizeEstimated: 1,
  /** dp (간격·상자 크기·모서리·줄 높이) */
  spacing: 2,
  /** CIEDE2000 */
  color: 3,
  /** 획 두께가 보통 굵기 글자의 이 배 이상이면 굵은 글자로 본다 */
  boldStroke: 1.25,
} as const;

export const DIFF_PROPS = [
  'text',
  'missing',
  'extra',
  'fontSize',
  'weight',
  'lineHeight',
  'color',
  'background',
  'inset',
  'gap',
  'size',
  'radius',
] as const;
export type DiffProp = (typeof DIFF_PROPS)[number];
export const DIFF_PROP_LABEL: Record<DiffProp, string> = {
  text: '문구',
  missing: '화면에 없음',
  extra: '가이드에 없음',
  fontSize: '글자 크기',
  weight: '글자 굵기',
  lineHeight: '줄 높이',
  color: '글자 색',
  background: '배경 색',
  inset: '가로 여백',
  gap: '위 요소와 간격',
  size: '상자 크기',
  radius: '모서리',
};
export type Severity = 'high' | 'medium' | 'low';
export const SEVERITY_LABEL: Record<Severity, string> = { high: '높음', medium: '중간', low: '낮음' };

export interface DesignDiffItem {
  prop: DiffProp;
  /** 사람이 알아볼 요소 이름 (문구 또는 레이어 이름) */
  element: string;
  guideId?: string;
  nodeId?: string;
  expected?: string;
  actual?: string;
  /** 차이 크기 (단위는 unit) */
  delta?: number;
  unit?: 'sp' | 'dp' | 'ΔE';
  accuracy: 'measured' | 'estimated';
  severity: Severity;
  /** 표시할 화면 영역 (기기 px) */
  bounds?: Bounds;
  note?: string;
}

export interface DesignCompareResult {
  figma: string;
  frame: DesignGuide['frame'];
  scale: number;
  screen: { width: number; height: number; density: number; fontScale: number };
  /** 에이전트 렌더링 정보로 글자 크기를 쟀는가 */
  rendering: boolean;
  counts: Record<Severity, number>;
  matched: { exact: number; normalized: number; similar: number; position: number };
  guideTexts: number;
  screenTexts: number;
  /** 크기·모서리를 비교한 가이드 상자 수 (#89) */
  boxes?: number;
  /** 화면이 오른쪽에서 왼쪽으로 배치돼 좌우를 뒤집어 비교했다 (#89) */
  rtl?: boolean;
  /** 화면 밖(스크롤해야 보임)이라 비교하지 못한 가이드 글자 */
  offscreen: string[];
  items: DesignDiffItem[];
  warnings: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const label = (g: GuideElement) => (g.text || g.name || g.id).replace(/\s+/g, ' ').slice(0, 60);
const median = (vs: number[]) => {
  const s = [...vs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function sizeSeverity(delta: number, high: number): Severity {
  return delta >= high ? 'high' : 'medium';
}

/** 자리·크기를 믿을 수 없는 짝: 합쳐진 조각, 설명만 있는 노드 */
const geometryless = (p: MatchedPair) => !!p.node.merged || !!p.node.description;

function colorItem(
  prop: 'color' | 'background',
  p: MatchedPair,
  want: string | undefined,
  measured: { hex: string; measured: boolean } | undefined,
): DesignDiffItem | undefined {
  if (!want || !measured) return undefined;
  let got = measured;
  let note: string | undefined;
  // 글자 영역에 다른 색(아이콘·강조 글자)이 섞였으면 가이드 색에 가까운 무리를 고른다
  if (prop === 'color' && p.node.inks && p.node.inks.length > 1) {
    const best = [...p.node.inks].sort((a, b) => deltaE2000(hexToRgb(want), hexToRgb(a.hex)) - deltaE2000(hexToRgb(want), hexToRgb(b.hex)))[0];
    got = { hex: best.hex, measured: false };
    note = `글자 영역에 다른 색(${p.node.inks.map((i) => i.hex).join(', ')})이 섞여 가이드 색에 가까운 쪽을 골랐습니다 (아이콘 등)`;
  }
  const d = deltaE2000(hexToRgb(want), hexToRgb(got.hex));
  if (d <= DESIGN_TOLERANCE.color) return undefined;
  return {
    prop,
    element: label(p.guide),
    guideId: p.guide.id,
    nodeId: p.node.nodeId,
    expected: want,
    actual: got.hex,
    delta: r1(d),
    unit: 'ΔE',
    accuracy: got.measured ? 'measured' : 'estimated',
    severity: got.measured ? (d >= 10 ? 'high' : 'medium') : 'low',
    bounds: p.node.bounds,
    ...(note ? { note } : {}),
  };
}

/** 렌더링 정보가 없을 때: 노드 높이를 줄 수와 가이드의 줄 높이 비율로 나눠 글자 크기를 어림한다 */
export function estimateFontSize(heightDp: number, guideSize: number, guideLineHeight: number | undefined, fontScale: number): number {
  const ratio = (guideLineHeight ?? guideSize * 1.25) / guideSize;
  const h = heightDp / (fontScale || 1);
  const lines = Math.max(1, Math.round(h / (guideSize * ratio)));
  return h / lines / ratio;
}

/** 잘린 노드(스크롤 경계에 반쯤 걸침): 높이가 가이드보다 눈에 띄게 작으면 높이로 재는 값(글자 크기 추정·간격)을 쓰지 않는다 */
function cut(p: MatchedPair, scale: number, fontScale: number): boolean {
  if (!p.node.clipped) return false;
  return !p.guide.rect || p.node.rect.h < p.guide.rect.h * scale * Math.min(1, fontScale) * 0.9;
}

function fontItem(p: MatchedPair, s: ScreenMetrics, scale: number): DesignDiffItem | undefined {
  const want = p.guide.font?.size;
  if (!want) return undefined;
  const wantDp = want * scale;
  const measured = p.node.fontSize;
  if (!measured && cut(p, scale, s.fontScale)) return undefined;
  const got =
    measured?.value ?? estimateFontSize(p.node.rect.h, wantDp, p.guide.font?.lineHeight && p.guide.font.lineHeight * scale, s.fontScale);
  const d = Math.abs(got - wantDp);
  if (d <= (measured ? DESIGN_TOLERANCE.fontSize : DESIGN_TOLERANCE.fontSizeEstimated)) return undefined;
  return {
    prop: 'fontSize',
    element: label(p.guide),
    guideId: p.guide.id,
    nodeId: p.node.nodeId,
    expected: `${r1(wantDp)}sp`,
    actual: `${r1(got)}${measured && measured.unit !== 'sp' ? 'dp' : 'sp'}`,
    delta: r1(d),
    unit: 'sp',
    accuracy: measured ? 'measured' : 'estimated',
    severity: measured ? sizeSeverity(d, 2) : 'low',
    bounds: p.node.bounds,
    ...(measured && measured.unit !== 'sp'
      ? { note: `앱이 글자 크기를 ${measured.unit} 로 정해 시스템 글자 크기 설정을 따르지 않습니다` }
      : {}),
  };
}

/** 글자 크기(기기 px): 잰 값이 있으면 그것, 없으면 가이드 크기 */
function sizePxOf(p: MatchedPair, s: ScreenMetrics, scale: number): number | undefined {
  const d = (s.density || 160) / 160;
  const f = p.node.fontSize;
  if (f) return f.value * d * (f.unit === 'sp' ? s.fontScale || 1 : 1);
  return p.guide.font?.size ? p.guide.font.size * scale * d * (s.fontScale || 1) : undefined;
}

/**
 * 굵기 (추정): 획 두께 ÷ 글자 크기를 보통 굵기(500 이하) 가이드 글자들의 중앙값과 견줘 굵은 글자(600 이상)인지 가른다.
 * 같은 화면의 글자끼리 견주므로 글꼴이 달라도 기준이 맞는다. 보통 굵기 글자가 없거나 글자가 너무 작으면 비교하지 않는다
 */
function weightItems(pairs: MatchedPair[], s: ScreenMetrics, scale: number, warnings: string[]): DesignDiffItem[] {
  const rows = pairs
    .filter((p) => !geometryless(p) && p.node.stroke && p.guide.font?.weight)
    .map((p) => ({ p, size: sizePxOf(p, s, scale) }))
    .filter((r): r is { p: MatchedPair; size: number } => !!r.size && r.size >= 20)
    .map(({ p, size }) => ({ p, ratio: p.node.stroke! / size }));
  if (!rows.length) return [];
  const regular = rows.filter((r) => r.p.guide.font!.weight! <= 500).map((r) => r.ratio);
  if (!regular.length) {
    warnings.push('견줄 보통 굵기 글자가 없어 글자 굵기는 비교하지 않았습니다');
    return [];
  }
  const base = median(regular);
  const out: DesignDiffItem[] = [];
  for (const { p, ratio } of rows) {
    const want = p.guide.font!.weight!;
    const k = ratio / base;
    const bold = k >= DESIGN_TOLERANCE.boldStroke;
    if (bold === want >= 600) continue;
    out.push({
      prop: 'weight',
      element: label(p.guide),
      guideId: p.guide.id,
      nodeId: p.node.nodeId,
      expected: `${want}`,
      actual: bold ? '굵게 (600 이상)' : '보통 (500 이하)',
      accuracy: 'estimated',
      severity: 'low',
      bounds: p.node.bounds,
      note: `획 두께가 보통 굵기 글자의 ${Math.round(k * 100) / 100}배`,
    });
  }
  return out;
}

/** 줄 높이 (추정): 두 줄 이상인 글자의 줄 간격. 시스템 글자 크기 배율을 빼고 sp 로 견준다 */
function lineHeightItem(p: MatchedPair, s: ScreenMetrics, scale: number): DesignDiffItem | undefined {
  const lh = p.guide.font?.lineHeight;
  const pitch = p.node.lines?.pitch;
  if (!lh || !pitch || geometryless(p) || cut(p, scale, s.fontScale)) return undefined;
  const want = lh * scale;
  const got = (pitch * 160) / (s.density || 160) / (s.fontScale || 1);
  const d = Math.abs(got - want);
  if (d <= DESIGN_TOLERANCE.spacing) return undefined;
  return {
    prop: 'lineHeight',
    element: label(p.guide),
    guideId: p.guide.id,
    nodeId: p.node.nodeId,
    expected: `${r1(want)}sp`,
    actual: `${r1(got)}sp`,
    delta: r1(d),
    unit: 'sp',
    accuracy: 'estimated',
    severity: 'low',
    bounds: p.node.bounds,
    note: `${p.node.lines!.count}줄의 줄 간격`,
  };
}

function spacingItem(prop: 'inset' | 'gap', p: MatchedPair, want: number, got: number, note?: string): DesignDiffItem | undefined {
  const d = Math.abs(got - want);
  if (d <= DESIGN_TOLERANCE.spacing) return undefined;
  return {
    prop,
    element: label(p.guide),
    guideId: p.guide.id,
    nodeId: p.node.nodeId,
    expected: `${r1(want)}dp`,
    actual: `${r1(got)}dp`,
    delta: r1(d),
    unit: 'dp',
    accuracy: 'measured',
    severity: sizeSeverity(d, 8),
    bounds: p.node.bounds,
    ...(note ? { note } : {}),
  };
}

const ANCHOR_NOTE = { left: '왼쪽 끝에서', right: '오른쪽 끝에서', center: '가운데에서' } as const;

/** 위에 있는 가장 가까운 짝 (가로로 겹치는 것을 먼저) */
function above(p: MatchedPair, pairs: MatchedPair[]): MatchedPair | undefined {
  const g = p.guide.rect!;
  let best: { q: MatchedPair; score: number } | undefined;
  for (const q of pairs) {
    const r = q.guide.rect;
    if (q === p || !r || r.y + r.h > g.y + 1) continue;
    const overlap = Math.min(r.x + r.w, g.x + g.w) - Math.max(r.x, g.x) > 0;
    const score = g.y - (r.y + r.h) + (overlap ? 0 : 10_000);
    if (!best || score < best.score) best = { q, score };
  }
  return best?.q;
}

/** 빠진 요소가 있어야 할 자리 (기기 px) */
function expectedBounds(
  want: { top: number; anchor: 'left' | 'right' | 'center'; offset: number },
  w: number,
  h: number,
  width: number,
  k: number,
): Bounds {
  const x = want.anchor === 'left' ? want.offset : want.anchor === 'right' ? width - want.offset - w : width / 2 + want.offset - w / 2;
  return [x / k, want.top / k, (x + w) / k, (want.top + h) / k].map(Math.round) as Bounds;
}

/**
 * RTL 화면인가: 양쪽에 한 번씩만 나오는 문구 중 왼쪽·오른쪽에 붙은 것의 가로 여백이, 좌우를 뒤집었을 때 더 잘 맞는 쪽이 많으면 RTL 로 본다.
 * 아랍어·히브리어처럼 시스템이 레이아웃을 좌우로 뒤집는 화면을 LTR 시안과 비교할 때 (#89)
 */
export function detectRtl(guide: DesignGuide, texts: MeasuredText[], screenWidthDp: number): boolean {
  const s = guide.scale;
  const once = <T>(items: T[], key: (v: T) => string) => {
    const m = new Map<string, T[]>();
    for (const v of items) m.set(key(v), [...(m.get(key(v)) ?? []), v]);
    return m;
  };
  const gs = once(
    guide.elements.filter((e) => e.kind === 'text' && e.text && e.rect),
    (e) => e.text!,
  );
  const ns = once(
    texts.filter((t) => !t.description && !t.merged),
    (t) => t.text,
  );
  let ltr = 0;
  let rtl = 0;
  for (const [text, [g, ...more]] of gs) {
    const n = ns.get(text);
    if (more.length || n?.length !== 1) continue;
    const a = anchorOf(g, guide.frame.width);
    if (a === 'center') continue;
    const want = horizontalOffset(a, { x: g.rect!.x * s, w: g.rect!.w * s }, guide.frame.width * s);
    const r = n[0].rect;
    const got = Math.abs(horizontalOffset(a, r, screenWidthDp) - want);
    const mirrored = Math.abs(horizontalOffset(a, { x: screenWidthDp - r.x - r.w, w: r.w }, screenWidthDp) - want);
    if (mirrored + 4 < got) rtl++;
    else if (got + 4 < mirrored) ltr++;
  }
  return rtl >= 2 && rtl > ltr * 2;
}

/** 크기·모서리를 비교할 가이드 상자: 배경이 있고, 부모 배경과 구분되고, 프레임 전체를 덮지 않는 것 */
function comparableBoxes(guide: DesignGuide): GuideElement[] {
  const byId = new Map(guide.elements.map((e) => [e.id, e]));
  const frameArea = guide.frame.width * guide.frame.height;
  return guide.elements.filter((e) => {
    if (e.kind !== 'box' || !e.rect || !e.background || e.rect.w < 4 || e.rect.h < 4) return false;
    if (e.rect.w * e.rect.h > frameArea * 0.6) return false;
    const seen = new Set<string>([e.id]);
    for (let p = e.parent ? byId.get(e.parent) : undefined; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
      seen.add(p.id);
      if (p.background) return deltaE2000(hexToRgb(p.background), hexToRgb(e.background)) > DESIGN_TOLERANCE.color;
    }
    return true;
  });
}

const MAX_BOXES = 60;

interface BoxContext {
  guide: DesignGuide;
  pairs: MatchedPair[];
  ctx: { scale: number; frameWidth: number; screenWidth: number; screenHeight: number };
  img: Raster;
  screen: ScreenMetrics;
  rtl: boolean;
}

/** 상자 크기·모서리 (#89). 폭이 부모를 채우는 상자(fill, 모르면 가운데 붙고 프레임 폭의 80% 이상)는 양쪽 여백을 뺀 폭과 견준다.
 * flex-1·grow 상자(grow)는 폭을 모르므로 높이만 견준다 */
function boxItems(b: BoxContext): { items: DesignDiffItem[]; compared: number } {
  const { guide, ctx, img, screen } = b;
  const s = guide.scale;
  const k = 160 / (screen.density || 160);
  const items: DesignDiffItem[] = [];
  let compared = 0;
  // 상자마다 화소를 훑으므로 개수를 묶는다 (카드가 많은 목록에서 비교가 느려지지 않게)
  for (const g of comparableBoxes(guide).slice(0, MAX_BOXES)) {
    const r = g.rect!;
    const want = expectedPosition(g, b.pairs, ctx);
    if (!want) continue;
    // flex-1·grow 는 형제와 폭을 나누므로 폭을 모른다: 자리는 시안 폭으로 찾고 크기는 높이만 견준다
    const grow = g.grow === true && g.fill === undefined;
    const fill = !grow && (g.fill ?? (want.anchor === 'center' && r.w >= guide.frame.width * 0.8));
    const wDp = fill ? ctx.screenWidth - (guide.frame.width - r.w) * s : r.w * s;
    const hDp = r.h * s;
    let at = fill
      ? ([(r.x * s) / k, want.top / k, (r.x * s + wDp) / k, (want.top + hDp) / k].map(Math.round) as Bounds)
      : expectedBounds(want, wDp, hDp, ctx.screenWidth, k);
    // 있어야 할 자리가 화면에 다 들어오지 않으면 크기를 잴 수 없다
    if (at[1] < 0 || at[3] > screen.height || at[0] < -2 || at[2] > screen.width + 2) continue;
    if (b.rtl) at = [screen.width - at[2], at[1], screen.width - at[0], at[3]];
    const margin = Math.max(16 / k, Math.min(at[2] - at[0], at[3] - at[1]) * 0.5);
    const box = measureBox(img, at, margin);
    if (!box) continue;
    compared++;
    const mw = (box.bounds[2] - box.bounds[0]) * k;
    const mh = (box.bounds[3] - box.bounds[1]) * k;
    const d = grow ? Math.abs(mh - hDp) : Math.max(Math.abs(mw - wDp), Math.abs(mh - hDp));
    const base = { element: label(g), guideId: g.id, bounds: box.bounds };
    if (d > DESIGN_TOLERANCE.spacing) {
      const notes = [
        fill ? '폭은 부모를 채우는 것으로 보고 양쪽 여백을 뺀 폭과 견줬습니다' : '',
        grow ? '폭은 형제와 나눠 늘어나는 상자(flex-1)라 높이만 견줬습니다' : '',
        box.edge ? '찾는 범위 끝까지 이어져 실제로는 더 클 수 있습니다' : '',
      ].filter(Boolean);
      items.push({
        prop: 'size',
        ...base,
        expected: grow ? `?×${r1(hDp)}dp` : `${r1(wDp)}×${r1(hDp)}dp`,
        actual: `${r1(mw)}×${r1(mh)}dp`,
        delta: r1(d),
        unit: 'dp',
        accuracy: box.edge ? 'estimated' : 'measured',
        severity: box.edge ? 'low' : sizeSeverity(d, 8),
        ...(notes.length ? { note: notes.join(' · ') } : {}),
      });
    }
    // 모서리: 가이드에 반경이 없으면 0. 반경은 짧은 변의 절반을 넘지 않는다 (rounded-full)
    const wantR = Math.min((g.radius ?? 0) * s, grow ? mw / 2 : wDp / 2, hDp / 2);
    const gotR = Math.min(box.radius * k, mw / 2, mh / 2);
    const dr = Math.abs(gotR - wantR);
    if (dr > DESIGN_TOLERANCE.spacing)
      items.push({
        prop: 'radius',
        ...base,
        expected: `${r1(wantR)}dp`,
        actual: `${r1(gotR)}dp`,
        delta: r1(dr),
        unit: 'dp',
        accuracy: 'estimated',
        severity: 'low',
        note: '모서리 화소로 어림한 값',
      });
  }
  return { items, compared };
}

/**
 * 가이드와 화면을 비교한다. img(스크린샷)를 주면 배경이 있는 가이드 상자의 크기·모서리도 비교한다 (#89)
 */
export function compareDesign(
  guide: DesignGuide,
  textsIn: MeasuredText[],
  screen: ScreenMetrics,
  rendering: boolean,
  img?: Raster,
): DesignCompareResult {
  const k = 160 / (screen.density || 160);
  const screenDp = { width: screen.width * k, height: screen.height * k };
  const ctx = { scale: guide.scale, frameWidth: guide.frame.width, screenWidth: screenDp.width, screenHeight: screenDp.height };
  const warnings: string[] = [];
  // RTL 이면 화면 쪽 가로 자리를 뒤집어(dp 자리만, 표시용 bounds 는 그대로) 시안과 같은 방향으로 견준다
  const rtl = detectRtl(guide, textsIn, screenDp.width);
  const texts = rtl
    ? textsIn.map((t) => ({ ...t, rect: { ...t.rect, x: Math.round((screenDp.width - t.rect.x - t.rect.w) * 10) / 10 } }))
    : textsIn;
  if (rtl) warnings.push('화면이 오른쪽에서 왼쪽(RTL)으로 배치돼 좌우를 뒤집어 비교했습니다');
  const m = matchTexts(guide.elements, texts, ctx);
  const items: DesignDiffItem[] = [];
  const s = guide.scale;

  for (const p of m.pairs) {
    if (!p.guide.example && p.how !== 'exact' && p.how !== 'normalized') {
      items.push({
        prop: 'text',
        element: label(p.guide),
        guideId: p.guide.id,
        nodeId: p.node.nodeId,
        expected: p.guide.text,
        actual: p.node.text,
        accuracy: 'measured',
        severity: 'high',
        bounds: p.node.bounds,
      });
    }
    // 합쳐진 조각·설명만 있는 노드는 그 글자 하나의 자리·크기·색을 모른다
    if (geometryless(p)) continue;
    const font = fontItem(p, screen, s);
    if (font) items.push(font);
    const lh = lineHeightItem(p, screen, s);
    if (lh) items.push(lh);
    const color = colorItem('color', p, p.guide.color, p.node.color);
    if (color) items.push(color);
    const bg = colorItem('background', p, p.guide.behind, p.node.background);
    if (bg) items.push(bg);
    if (p.guide.rect) {
      const anchor = anchorOf(p.guide, guide.frame.width);
      const want = horizontalOffset(anchor, { x: p.guide.rect.x * s, w: p.guide.rect.w * s }, guide.frame.width * s);
      const got = horizontalOffset(anchor, p.node.rect, screenDp.width);
      const inset = spacingItem('inset', p, want, got, `${ANCHOR_NOTE[anchor]} 잰 거리`);
      if (inset) items.push(inset);
      const q = above(p, m.pairs);
      if (q && !geometryless(q) && !cut(p, s, screen.fontScale) && !cut(q, s, screen.fontScale)) {
        const gq = q.guide.rect!;
        const want2 = (p.guide.rect.y - (gq.y + gq.h)) * s;
        const got2 = p.node.rect.y - (q.node.rect.y + q.node.rect.h);
        const gap = spacingItem('gap', p, want2, got2, `위 요소 "${label(q.guide)}" 와의 간격`);
        if (gap) items.push(gap);
      }
    }
  }
  items.push(...weightItems(m.pairs, screen, s, warnings));

  const textPairs = m.pairs.filter((p) => p.how !== 'position');
  const offscreen: string[] = [];
  let boxes = 0;
  if (!textPairs.length && m.guideOnly.length) {
    warnings.push('가이드의 문구를 화면에서 하나도 찾지 못했습니다. 가이드와 같은 화면인지, 화면이 다 그려졌는지 확인하세요');
  } else {
    const byId = new Map(guide.elements.map((e) => [e.id, e]));
    /** 위치를 모르면(인스턴스 안) 위치를 아는 가장 가까운 조상의 자리 */
    const area = (g: GuideElement) => {
      const seen = new Set<string>();
      for (let p: GuideElement | undefined = g; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
        seen.add(p.id);
        if (p.rect) return p.rect;
      }
      return undefined;
    };
    // 화면에만 있는 글자는 가이드가 차지하는 세로 범위(짝지은 요소 + 빠진 요소가 있어야 할 자리) 안의 것만 센다 (가이드가 그리지 않은 상태 표시줄 등은 빼려고)
    const tops = m.pairs.map((p) => p.node.rect.y);
    const bottoms = m.pairs.map((p) => p.node.rect.y + p.node.rect.h);
    for (const g of m.guideOnly) {
      const rect = area(g);
      const want = rect && expectedPosition({ ...g, rect }, m.pairs, ctx);
      let at = want && rect ? expectedBounds(want, rect.w * s, rect.h * s, screenDp.width, k) : undefined;
      // 있어야 할 자리가 화면 밖(스크롤·가로 캐러셀)이면 비교하지 않고 알리기만 한다
      if (at && (at[3] <= 0 || at[1] >= screen.height || at[2] <= 0 || at[0] >= screen.width)) {
        offscreen.push(label(g));
        continue;
      }
      if (at && rtl) at = [screen.width - at[2], at[1], screen.width - at[0], at[3]];
      if (want && rect) {
        tops.push(want.top);
        bottoms.push(want.top + rect.h * s);
      }
      const note = !g.rect
        ? rect
          ? '가이드에 위치가 없어(인스턴스 안) 감싼 요소의 자리로 봤습니다'
          : '가이드에 위치가 없어(인스턴스 안) 화면 밖에 있는지 알 수 없습니다'
        : g.example
          ? '예시값 문구라 자리로만 찾았습니다'
          : undefined;
      items.push({
        prop: 'missing',
        element: label(g),
        guideId: g.id,
        expected: g.text,
        accuracy: 'measured',
        severity: g.rect ? 'high' : 'medium',
        ...(at ? { bounds: at } : {}),
        ...(note ? { note } : {}),
      });
    }
    const lo = Math.min(...tops);
    const hi = Math.max(...bottoms);
    for (const n of m.screenOnly) {
      // 설명만 있는 노드(아이콘)는 가이드에 글자로 없는 것이 보통이라 세지 않는다
      if (n.description || n.rect.y + n.rect.h < lo || n.rect.y > hi) continue;
      items.push({
        prop: 'extra',
        element: n.text.replace(/\s+/g, ' ').slice(0, 60),
        nodeId: n.nodeId,
        actual: n.text,
        accuracy: 'measured',
        severity: 'medium',
        bounds: n.bounds,
      });
    }
    if (img) {
      const b = boxItems({ guide, pairs: m.pairs, ctx, img, screen, rtl });
      items.push(...b.items);
      boxes = b.compared;
    }
  }
  if (!rendering)
    warnings.push('글자 렌더링 정보가 없어 글자 크기는 글자 높이로 추정했습니다 (Android 11 미만이거나 에이전트를 쓰지 못함)');
  else if (m.pairs.length && m.pairs.every((p) => !p.node.fontSize))
    warnings.push('화면이 글자 크기를 알려 주지 않아(Android 11 미만이거나 Compose 화면) 글자 높이로 추정했습니다');
  if (m.merged)
    warnings.push(
      `여러 글자가 한 노드로 합쳐진 곳 ${m.merged}개(Compose 의 mergeDescendants 등)는 문구만 비교했습니다 (글자마다의 자리·크기·색은 모름)`,
    );

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || DIFF_PROPS.indexOf(a.prop) - DIFF_PROPS.indexOf(b.prop));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const it of items) counts[it.severity]++;
  const matched: Record<MatchHow, number> = { exact: 0, normalized: 0, similar: 0, position: 0 };
  for (const p of m.pairs) matched[p.how]++;
  return {
    figma: guide.figma,
    frame: guide.frame,
    scale: guide.scale,
    screen: { width: r1(screenDp.width), height: r1(screenDp.height), density: screen.density, fontScale: screen.fontScale },
    rendering,
    counts,
    matched,
    guideTexts: m.pairs.length + m.guideOnly.length,
    screenTexts: textsIn.length,
    ...(img ? { boxes } : {}),
    ...(rtl ? { rtl } : {}),
    offscreen,
    items,
    warnings,
  };
}
