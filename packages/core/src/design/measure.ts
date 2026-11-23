import { PNG } from 'pngjs';
import { flatten, type Bounds, type ViewNode } from '../hierarchy.js';
import { rgbToHex, type Rgb } from './color.js';

/**
 * 실제 화면 재기 (#77): 뷰 계층과 같은 순간의 스크린샷에서 글자 노드마다 문구·위치(dp)·글자 크기·색을 잰다.
 *   - 위치·크기: 노드 bounds(px) ÷ (density/160)
 *   - 글자 크기: 에이전트 렌더링 정보가 있으면 그 값(측정), 없으면 비교할 때 글자 높이로 추정
 *   - 배경 색: 노드 영역 가장자리의 가장 많은 색 / 글자 색: 배경과 가장 먼 쪽 화소들의 평균
 */

export interface Raster {
  width: number;
  height: number;
  /** RGBA */
  data: Buffer;
}

export function decodePng(png: Buffer): Raster {
  const p = PNG.sync.read(png);
  return { width: p.width, height: p.height, data: p.data };
}

export interface ScreenMetrics {
  /** 화면 픽셀 */
  width: number;
  height: number;
  /** dpi (160 = 1배) */
  density: number;
  /** 시스템 글자 크기 배율 (설정 > 글자 크기, 기본 1) */
  fontScale: number;
}

export interface DpRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MeasuredText {
  nodeId: string;
  text: string;
  className: string;
  bounds: Bounds;
  rect: DpRect;
  /** 렌더링 정보로 잰 글자 크기 (sp 는 글자 크기 배율을 뺀 값이라 Figma px 와 바로 비교된다) */
  fontSize?: { value: number; unit: 'sp' | 'dp' | 'px' };
  color?: { hex: string; measured: boolean };
  background?: { hex: string; measured: boolean };
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function toDpRect([l, t, r, b]: Bounds, density: number): DpRect {
  const k = 160 / (density || 160);
  return { x: round(l * k), y: round(t * k), w: round((r - l) * k), h: round((b - t) * k) };
}

/** 비교할 글자 노드: 문구가 있고 화면 안에 보이는 것. 시스템 UI(상태 표시줄)는 뺀다. 같은 문구를 품은 바깥 노드는 안쪽 것만 남긴다 */
export function textNodes(root: ViewNode, screen: { width: number; height: number }, packageName?: string): ViewNode[] {
  const all = flatten(root).filter((n) => {
    // 비밀번호 칸은 결과 파일(diff.json·report.html)에 글자가 남지 않게 뺀다
    if (n.depth === 0 || !n.text.trim() || n.password) return false;
    if (n.packageName === 'com.android.systemui') return false;
    if (packageName && n.packageName && n.packageName !== packageName) return false;
    const [l, t, r, b] = n.bounds;
    return r > l && b > t && r > 0 && b > 0 && l < screen.width && t < screen.height;
  });
  const norm = (s: string) => s.replace(/\s+/g, '');
  const inside = (a: Bounds, b: Bounds) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
  return all.filter(
    (n) => !all.some((m) => m !== n && m.id.startsWith(`${n.id}.`) && inside(m.bounds, n.bounds) && norm(m.text) === norm(n.text)),
  );
}

function fontSizeOf(n: ViewNode, s: ScreenMetrics): MeasuredText['fontSize'] {
  if (!n.textSize) return undefined;
  const d = (s.density || 160) / 160;
  // TypedValue: 0 px, 1 dip, 2 sp
  if (n.textSize.unit === 2) return { value: round(n.textSize.sp ?? n.textSize.px / d / (s.fontScale || 1), 2), unit: 'sp' };
  return { value: round(n.textSize.px / d, 2), unit: n.textSize.unit === 1 ? 'dp' : 'px' };
}

/** 노드 영역의 배경·글자 색. 배경이 고르지 않으면(그라데이션·이미지 위) measured=false */
export function sampleColors(
  img: Raster,
  [l0, t0, r0, b0]: Bounds,
): { background?: MeasuredText['background']; color?: MeasuredText['color'] } {
  const l = Math.max(0, Math.floor(l0));
  const t = Math.max(0, Math.floor(t0));
  const r = Math.min(img.width, Math.ceil(r0));
  const b = Math.min(img.height, Math.ceil(b0));
  if (r - l < 4 || b - t < 4) return {};
  const px = (x: number, y: number): Rgb => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  // 가장자리 2px 띠에서 가장 많은 색 (5비트로 묶어 센다)
  const buckets = new Map<number, { n: number; sum: Rgb }>();
  let ring = 0;
  const add = (c: Rgb) => {
    const k = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    const v = buckets.get(k) ?? { n: 0, sum: [0, 0, 0] };
    v.n++;
    v.sum[0] += c[0];
    v.sum[1] += c[1];
    v.sum[2] += c[2];
    buckets.set(k, v);
    ring++;
  };
  for (let x = l; x < r; x++) for (const y of [t, t + 1, b - 2, b - 1]) add(px(x, y));
  for (let y = t + 2; y < b - 2; y++) for (const x of [l, l + 1, r - 2, r - 1]) add(px(x, y));
  let top = { n: 0, sum: [0, 0, 0] as Rgb };
  for (const v of buckets.values()) if (v.n > top.n) top = v;
  const bg: Rgb = [top.sum[0] / top.n, top.sum[1] / top.n, top.sum[2] / top.n];
  const uniform = top.n / ring >= 0.6;
  const background = { hex: rgbToHex(bg), measured: uniform };

  // 글자: 배경에서 충분히 먼 화소 중 가장 먼 쪽(안티에일리어싱으로 섞이지 않은 획의 가운데)의 평균
  const far: { d: number; c: Rgb }[] = [];
  for (let y = t + 2; y < b - 2; y++)
    for (let x = l + 2; x < r - 2; x++) {
      const c = px(x, y);
      const d = Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
      if (d > 48) far.push({ d, c });
    }
  if (far.length < 8) return { background };
  far.sort((a, b2) => a.d - b2.d);
  const p95 = far[Math.floor(far.length * 0.95)].d;
  const core = far.filter((f) => f.d >= p95 * 0.85 && f.d <= p95 * 1.05);
  const sum = core.reduce<Rgb>((s, f) => [s[0] + f.c[0], s[1] + f.c[1], s[2] + f.c[2]], [0, 0, 0]);
  const color = {
    hex: rgbToHex([sum[0] / core.length, sum[1] / core.length, sum[2] / core.length]),
    measured: uniform && core.length >= 8,
  };
  return { background, color };
}

export function measureTexts(root: ViewNode, img: Raster, screen: ScreenMetrics, packageName?: string): MeasuredText[] {
  return textNodes(root, screen, packageName).map((n) => ({
    nodeId: n.id,
    text: n.text,
    className: n.className,
    bounds: n.bounds,
    rect: toDpRect(n.bounds, screen.density),
    ...(fontSizeOf(n, screen) ? { fontSize: fontSizeOf(n, screen) } : {}),
    ...sampleColors(img, n.bounds),
  }));
}
