import type { Bounds } from '../hierarchy.js';
import { deltaE2000, hexToRgb } from './color.js';
import type { DesignGuide, GuideElement } from './guide.js';
import { anchorOf, expectedPosition, horizontalOffset, matchTexts, type MatchedPair, type MatchHow } from './match.js';
import type { MeasuredText, ScreenMetrics } from './measure.js';

/**
 * 차이 판정 (#77): 짝지은 요소마다 문구·글자 크기·글자 색·배경 색·가로 여백·위 요소와의 간격을 비교하고
 * 허용치를 넘는 것만 남긴다. 추정값으로만 나온 차이는 '낮음'(사람이 확인)으로 둔다.
 */

export const DESIGN_TOLERANCE = {
  /** sp (추정값은 1sp) */
  fontSize: 0.5,
  fontSizeEstimated: 1,
  /** dp */
  spacing: 2,
  /** CIEDE2000 */
  color: 3,
} as const;

export const DIFF_PROPS = ['text', 'missing', 'extra', 'fontSize', 'color', 'background', 'inset', 'gap'] as const;
export type DiffProp = (typeof DIFF_PROPS)[number];
export const DIFF_PROP_LABEL: Record<DiffProp, string> = {
  text: '문구',
  missing: '화면에 없음',
  extra: '가이드에 없음',
  fontSize: '글자 크기',
  color: '글자 색',
  background: '배경 색',
  inset: '가로 여백',
  gap: '위 요소와 간격',
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
  /** 화면 밖(스크롤해야 보임)이라 비교하지 못한 가이드 글자 */
  offscreen: string[];
  items: DesignDiffItem[];
  warnings: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const label = (g: GuideElement) => (g.text || g.name || g.id).replace(/\s+/g, ' ').slice(0, 60);

function sizeSeverity(delta: number, high: number): Severity {
  return delta >= high ? 'high' : 'medium';
}

function colorItem(
  prop: 'color' | 'background',
  p: MatchedPair,
  want: string | undefined,
  got: { hex: string; measured: boolean } | undefined,
): DesignDiffItem | undefined {
  if (!want || !got) return undefined;
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
  };
}

/** 렌더링 정보가 없을 때: 노드 높이를 줄 수와 가이드의 줄 높이 비율로 나눠 글자 크기를 어림한다 */
export function estimateFontSize(heightDp: number, guideSize: number, guideLineHeight: number | undefined, fontScale: number): number {
  const ratio = (guideLineHeight ?? guideSize * 1.25) / guideSize;
  const h = heightDp / (fontScale || 1);
  const lines = Math.max(1, Math.round(h / (guideSize * ratio)));
  return h / lines / ratio;
}

function fontItem(p: MatchedPair, s: ScreenMetrics, scale: number): DesignDiffItem | undefined {
  const want = p.guide.font?.size;
  if (!want) return undefined;
  const wantDp = want * scale;
  const measured = p.node.fontSize;
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

export function compareDesign(guide: DesignGuide, texts: MeasuredText[], screen: ScreenMetrics, rendering: boolean): DesignCompareResult {
  const k = 160 / (screen.density || 160);
  const screenDp = { width: screen.width * k, height: screen.height * k };
  const ctx = { scale: guide.scale, frameWidth: guide.frame.width, screenWidth: screenDp.width, screenHeight: screenDp.height };
  const m = matchTexts(guide.elements, texts, ctx);
  const items: DesignDiffItem[] = [];
  const warnings: string[] = [];
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
    const font = fontItem(p, screen, s);
    if (font) items.push(font);
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
      if (q) {
        const gq = q.guide.rect!;
        const want2 = (p.guide.rect.y - (gq.y + gq.h)) * s;
        const got2 = p.node.rect.y - (q.node.rect.y + q.node.rect.h);
        const gap = spacingItem('gap', p, want2, got2, `위 요소 "${label(q.guide)}" 와의 간격`);
        if (gap) items.push(gap);
      }
    }
  }

  const textPairs = m.pairs.filter((p) => p.how !== 'position');
  const offscreen: string[] = [];
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
      const at = want && rect ? expectedBounds(want, rect.w * s, rect.h * s, screenDp.width, k) : undefined;
      // 있어야 할 자리가 화면 밖(스크롤·가로 캐러셀)이면 비교하지 않고 알리기만 한다
      if (at && (at[3] <= 0 || at[1] >= screen.height || at[2] <= 0 || at[0] >= screen.width)) {
        offscreen.push(label(g));
        continue;
      }
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
      if (n.rect.y + n.rect.h < lo || n.rect.y > hi) continue;
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
  }
  if (!rendering)
    warnings.push('글자 렌더링 정보가 없어 글자 크기는 글자 높이로 추정했습니다 (Android 11 미만이거나 에이전트를 쓰지 못함)');
  else if (m.pairs.length && m.pairs.every((p) => !p.node.fontSize))
    warnings.push('화면이 글자 크기를 알려 주지 않아(Android 11 미만이거나 Compose 화면) 글자 높이로 추정했습니다');

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
    screenTexts: texts.length,
    offscreen,
    items,
    warnings,
  };
}
