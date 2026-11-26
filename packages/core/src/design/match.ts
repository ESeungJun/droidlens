import type { GuideElement } from './guide.js';
import type { MeasuredText } from './measure.js';

/**
 * 짝짓기 (#77): 가이드의 글자 요소와 화면의 글자 노드를
 *   문구가 같은 것 → 공백·줄바꿈을 정규화해 같은 것 → 비슷한 문구(편집 거리) → 위치(가까운 짝 기준으로 옮긴 자리)
 * 순서로 맞춘다. 문구가 한 번만 나오는 것부터 짝짓고, 같은 문구가 여럿이면(목록의 '장바구니' 버튼) 이미 짝지은 요소로
 * 옮긴 자리에 가장 가까운 것과 짝짓는다 (스크롤된 목록에서 줄이 밀리지 않게).
 */

export type MatchHow = 'exact' | 'normalized' | 'similar' | 'position';

export interface MatchedPair {
  guide: GuideElement;
  node: MeasuredText;
  how: MatchHow;
}

export interface MatchResult {
  pairs: MatchedPair[];
  /** 여러 글자가 한 노드로 합쳐져 나눈 노드 수 (Compose mergeDescendants) */
  merged: number;
  /** 짝이 없는 가이드 글자 요소 */
  guideOnly: GuideElement[];
  /** 짝이 없는 화면 글자 노드 */
  screenOnly: MeasuredText[];
}

export interface MatchContext {
  /** Figma px 당 dp */
  scale: number;
  /** 프레임 폭 (Figma px) */
  frameWidth: number;
  /** 화면 폭·높이 (dp) */
  screenWidth: number;
  screenHeight: number;
}

/** 비슷한 문구로 짝지을 때 있어야 할 자리에서 세로로 이만큼(dp) 안의 노드만 본다 */
const SIMILAR_MAX_DY = 160;
const SIMILAR_MIN = 0.6;

const spaced = (s: string) => s.replace(/\s+/g, ' ').trim();
const compact = (s: string) => s.replace(/\s+/g, '');

/** 편집 거리 기반 비슷함 (0~1). 긴 글은 앞 200자만 본다 */
export function similarity(a: string, b: string): number {
  const x = compact(a).slice(0, 200);
  const y = compact(b).slice(0, 200);
  if (!x.length || !y.length) return 0;
  // 길이 차이만으로 이미 기준(0.6) 아래면 편집 거리를 계산하지 않는다
  if (Math.min(x.length, y.length) / Math.max(x.length, y.length) < SIMILAR_MIN) return 0;
  const max = Math.max(x.length, y.length);
  /** 이 거리를 넘으면 비슷함이 기준 아래라 더 계산하지 않는다 */
  const cutoff = Math.floor(max * (1 - SIMILAR_MIN));
  let prev = Uint16Array.from({ length: y.length + 1 }, (_, j) => j);
  let cur = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cutoff) return 0;
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[y.length] / max;
}

/**
 * 여러 글자가 한 노드로 합쳐진 노드(Compose 의 mergeDescendants 는 문구를 ", " 로 잇는다)를 가이드 문구 단위로 나눈다.
 * 노드 전체 문구가 가이드에 없고, 쉼표·줄바꿈으로 나눈 조각 중 둘 이상이 가이드 문구일 때만 나눈다 (#89)
 */
export function splitMerged(n: MeasuredText, guideTexts: Set<string>): MeasuredText[] {
  if (n.description || guideTexts.has(compact(n.text))) return [n];
  const parts = n.text
    .split(/,\s+|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.filter((p) => guideTexts.has(compact(p))).length < 2) return [n];
  return parts.map((text) => ({ ...n, text, merged: true }));
}

/** 자리 기준으로 쓸 수 있는 짝: 잘리지 않고, 합쳐진 조각·설명만 있는 노드가 아닌 것 */
const reliable = (n: MeasuredText) => !n.clipped && !n.merged && !n.description;

export type Anchor = 'left' | 'right' | 'center';

/** 가이드 요소가 프레임의 어느 쪽에 붙어 있나: 양쪽 여백이 2px 안으로 같으면 가운데, 아니면 더 가까운 쪽 */
export function anchorOf(g: GuideElement, frameWidth: number): Anchor {
  const r = g.rect!;
  const left = r.x;
  const right = frameWidth - (r.x + r.w);
  if (Math.abs(left - right) <= 2) return 'center';
  return left < right ? 'left' : 'right';
}

/** 화면에서 이 가이드 요소가 있어야 할 가로 자리를 붙은 쪽 기준으로 잰다 (dp). 기기 폭이 시안과 달라도 같은 쪽 여백끼리 비교한다 */
export function horizontalOffset(anchor: Anchor, rect: { x: number; w: number }, width: number): number {
  if (anchor === 'left') return rect.x;
  if (anchor === 'right') return width - (rect.x + rect.w);
  return rect.x + rect.w / 2 - width / 2;
}

const byPosition =
  <T>(top: (v: T) => number | undefined, left: (v: T) => number | undefined) =>
  (a: T, b: T) =>
    (top(a) ?? Infinity) - (top(b) ?? Infinity) || (left(a) ?? Infinity) - (left(b) ?? Infinity);

export function matchTexts(guideAll: GuideElement[], screenAll: MeasuredText[], ctx: MatchContext): MatchResult {
  const guide = guideAll
    .filter((g) => g.kind === 'text' && g.text?.trim())
    .sort(
      byPosition(
        (g) => g.rect?.y,
        (g) => g.rect?.x,
      ),
    );
  const guideTexts = new Set(guide.map((g) => compact(g.text!)));
  const screen = screenAll.flatMap((n) => splitMerged(n, guideTexts)).sort(
    byPosition(
      (n) => n.rect.y,
      (n) => n.rect.x,
    ),
  );
  const pairs: MatchedPair[] = [];
  const usedG = new Set<GuideElement>();
  const usedN = new Set<MeasuredText>();

  const keys = [
    ['exact', (t: string) => t],
    ['normalized', spaced],
    ['normalized', compact],
  ] as const;
  const pair = (g: GuideElement, n: MeasuredText, how: MatchHow) => {
    pairs.push({ guide: g, node: n, how });
    usedG.add(g);
    usedN.add(n);
  };
  const countBy = <T>(items: T[], key: (v: T) => string) => {
    const m = new Map<string, T[]>();
    for (const v of items) m.set(key(v), [...(m.get(key(v)) ?? []), v]);
    return m;
  };
  // 1) 양쪽에 한 번씩만 나오는 문구
  for (const [how, key] of keys) {
    const gs = countBy(
      guide.filter((g) => !usedG.has(g)),
      (g) => key(g.text!),
    );
    const ns = countBy(
      screen.filter((n) => !usedN.has(n)),
      (n) => key(n.text),
    );
    for (const [k, [g, ...gMore]] of gs) {
      const n = ns.get(k);
      if (!gMore.length && n?.length === 1) pair(g, n[0], how);
    }
  }
  // 2) 여러 번 나오는 문구: 있어야 할 자리와 가까운 짝부터 (기준 짝이 없으면 위에서부터 차례로)
  for (const [how, key] of keys) {
    const ns = countBy(
      screen.filter((n) => !usedN.has(n)),
      (n) => key(n.text),
    );
    const near: { g: GuideElement; n: MeasuredText; dy: number }[] = [];
    for (const g of guide) {
      const cands = usedG.has(g) ? undefined : ns.get(key(g.text!));
      if (!cands?.length) continue;
      const want = expectedPosition(g, pairs, ctx);
      if (!want) {
        const n = cands.find((c) => !usedN.has(c));
        if (n) pair(g, n, how);
        continue;
      }
      if (want.top + (g.rect?.h ?? 0) * ctx.scale < 0 || want.top > ctx.screenHeight) continue;
      for (const n of cands) near.push({ g, n, dy: Math.abs(n.rect.y - want.top) });
    }
    near.sort((a, b) => a.dy - b.dy);
    for (const { g, n } of near) if (!usedG.has(g) && !usedN.has(n)) pair(g, n, how);
  }

  // 3) 비슷한 문구: 있어야 할 자리 근처에서, 가장 비슷한 짝부터 (화면 밖에 있어야 할 요소는 짝짓지 않는다)
  const cands: { g: GuideElement; n: MeasuredText; s: number; dy: number }[] = [];
  for (const g of guide) {
    if (usedG.has(g) || g.example || compact(g.text!).length < 2) continue;
    const want = expectedPosition(g, pairs, ctx);
    if (want && (want.top + (g.rect?.h ?? 0) * ctx.scale < 0 || want.top > ctx.screenHeight)) continue;
    for (const n of screen) {
      if (usedN.has(n) || n.description) continue;
      const dy = want ? Math.abs(n.rect.y - want.top) : 0;
      if (dy > SIMILAR_MAX_DY) continue;
      const sim = similarity(g.text!, n.text);
      if (sim >= SIMILAR_MIN) cands.push({ g, n, s: sim, dy });
    }
  }
  cands.sort((a, b) => b.s - a.s || a.dy - b.dy);
  for (const { g, n } of cands) if (!usedG.has(g) && !usedN.has(n)) pair(g, n, 'similar');

  // 위치: 가장 가까운 짝을 기준으로 옮긴 자리에 있는 남은 노드 (문구를 바꿨거나 예시값인 것)
  for (const g of guide) {
    if (usedG.has(g) || !g.rect) continue;
    const want = expectedPosition(g, pairs, ctx);
    if (!want) continue;
    let best: { n: MeasuredText; cost: number } | undefined;
    for (const n of screen) {
      if (usedN.has(n) || !reliable(n)) continue;
      const dy = Math.abs(n.rect.y - want.top);
      const dx = Math.abs(horizontalOffset(want.anchor, n.rect, ctx.screenWidth) - want.offset);
      if (dy > Math.max(16, g.rect.h * ctx.scale) || dx > 24) continue;
      if (!best || dx + dy < best.cost) best = { n, cost: dx + dy };
    }
    if (best) pair(g, best.n, 'position');
  }

  return {
    pairs,
    merged: new Set(screen.filter((n) => n.merged).map((n) => n.nodeId)).size,
    guideOnly: guide.filter((g) => !usedG.has(g)),
    screenOnly: screen.filter((n) => !usedN.has(n)),
  };
}

/**
 * 가이드 요소가 화면에 있어야 할 자리 (dp): 세로는 문구로 짝지은 요소 중 가이드에서 가장 가까운 것을 기준으로 옮기고,
 * 가로는 붙은 쪽 여백을 그대로 쓴다. 짝이 하나도 없으면 undefined
 */
export function expectedPosition(
  g: GuideElement,
  pairs: MatchedPair[],
  ctx: MatchContext,
): { top: number; anchor: Anchor; offset: number } | undefined {
  if (!g.rect) return undefined;
  let ref: MatchedPair | undefined;
  for (const p of pairs) {
    if (!p.guide.rect || p.how === 'position' || !reliable(p.node)) continue;
    if (!ref || Math.abs(p.guide.rect.y - g.rect.y) < Math.abs(ref.guide.rect!.y - g.rect.y)) ref = p;
  }
  if (!ref) return undefined;
  const anchor = anchorOf(g, ctx.frameWidth);
  const s = ctx.scale;
  return {
    top: ref.node.rect.y + (g.rect.y - ref.guide.rect!.y) * s,
    anchor,
    offset: horizontalOffset(anchor, { x: g.rect.x * s, w: g.rect.w * s }, ctx.frameWidth * s),
  };
}
