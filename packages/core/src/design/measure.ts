import { PNG } from 'pngjs';
import { flatten, type Bounds, type ViewNode } from '../hierarchy.js';
import { rgbToHex, type Rgb } from './color.js';

/**
 * 실제 화면 재기 (#77, #89): 뷰 계층과 같은 순간의 스크린샷에서 글자 노드마다 문구·위치(dp)·글자 크기·색을 잰다.
 *   - 위치·크기: 노드 bounds(px) ÷ (density/160)
 *   - 글자 크기: 에이전트 렌더링 정보가 있으면 그 값(측정), 없으면 비교할 때 글자 높이로 추정
 *   - 배경 색: 노드 영역 가장자리의 가장 많은 색
 *   - 글자 색: 배경과 먼 화소를 색 무리로 나눠 가장 큰 무리의 가운데 색. 아이콘처럼 다른 색이 섞이면 무리가 둘 나오고,
 *     비교할 때 가이드 색에 가까운 쪽을 고른다
 *   - 획 두께(굵기 추정)·줄 간격(줄 높이 추정): 글자 화소의 가로 획 폭 중앙값, 글자 화소가 있는 행 묶음 사이 간격
 *   - 상자: 있어야 할 자리 둘레에서 상자 색 화소의 행·열 분포로 가장자리를 찾고, 네 모서리의 대각선으로 반경을 어림한다
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
  /** 글자 화소의 색 무리 (큰 것부터, 둘까지). 둘이면 아이콘 등 다른 색이 섞인 것 */
  inks?: { hex: string; share: number }[];
  /** 가로 획 폭 중앙값 (기기 px). 굵기 추정에 쓴다 */
  stroke?: number;
  /** 글자 줄 수와 줄 간격 (기기 px, 간격은 두 줄 이상일 때만) */
  lines?: { count: number; pitch?: number };
  /** 스크롤 영역이나 화면의 위·아래 끝에 닿아 잘렸을 수 있다 */
  clipped?: boolean;
  /** 문구 없이 contentDescription 만 있는 노드 (아이콘 버튼). text 는 그 설명 */
  description?: boolean;
  /** 여러 글자가 한 노드로 합쳐진 것을 나눈 조각 (Compose mergeDescendants). 자리·크기·색은 조각마다 모른다 */
  merged?: boolean;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function toDpRect([l, t, r, b]: Bounds, density: number): DpRect {
  const k = 160 / (density || 160);
  return { x: round(l * k), y: round(t * k), w: round((r - l) * k), h: round((b - t) * k) };
}

const visible = (n: ViewNode, screen: { width: number; height: number }) => {
  const [l, t, r, b] = n.bounds;
  return r > l && b > t && r > 0 && b > 0 && l < screen.width && t < screen.height;
};

/**
 * 비교할 글자 노드: 문구가 있고 화면 안에 보이는 것. 시스템 UI(상태 표시줄)는 뺀다. 같은 문구를 품은 바깥 노드는 안쪽 것만 남긴다.
 * 문구 없이 contentDescription 만 있는 노드(아이콘 버튼)도 함께 낸다 (#89). 안쪽에 글자 노드가 있으면 그 글자를 되풀이한 설명이라 뺀다
 */
export function textNodes(root: ViewNode, screen: { width: number; height: number }, packageName?: string): ViewNode[] {
  const own = (n: ViewNode) => {
    if (n.depth === 0 || n.password) return false;
    if (n.packageName === 'com.android.systemui') return false;
    if (packageName && n.packageName && n.packageName !== packageName) return false;
    return visible(n, screen);
  };
  const flat = flatten(root).filter(own);
  const all = flat.filter((n) => n.text.trim());
  const norm = (s: string) => s.replace(/\s+/g, '');
  const inside = (a: Bounds, b: Bounds) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
  const texts = all.filter(
    (n) => !all.some((m) => m !== n && m.id.startsWith(`${n.id}.`) && inside(m.bounds, n.bounds) && norm(m.text) === norm(n.text)),
  );
  const descs = flat.filter((n) => !n.text.trim() && n.contentDesc.trim());
  const onlyDesc = descs.filter(
    (n) =>
      !all.some((m) => m.id.startsWith(`${n.id}.`)) &&
      !descs.some((m) => m !== n && m.id.startsWith(`${n.id}.`) && norm(m.contentDesc) === norm(n.contentDesc)),
  );
  return [...texts, ...onlyDesc];
}

/** 노드가 가장 가까운 스크롤 영역이나 화면의 위·아래 끝에 닿았나 (반쯤 걸친 노드는 bounds 가 잘려 온다) */
function clippedOf(n: ViewNode, byId: Map<string, ViewNode>, screen: { height: number }): boolean {
  const [, t, , b] = n.bounds;
  if (t <= 0 || b >= screen.height) return true;
  for (let id = n.id; id.includes('.'); ) {
    id = id.slice(0, id.lastIndexOf('.'));
    const p = byId.get(id);
    if (p?.scrollable) return Math.abs(t - p.bounds[1]) <= 1 || Math.abs(b - p.bounds[3]) <= 1;
  }
  return false;
}

function fontSizeOf(n: ViewNode, s: ScreenMetrics): MeasuredText['fontSize'] {
  if (!n.textSize) return undefined;
  const d = (s.density || 160) / 160;
  // TypedValue: 0 px, 1 dip, 2 sp
  if (n.textSize.unit === 2) return { value: round(n.textSize.sp ?? n.textSize.px / d / (s.fontScale || 1), 2), unit: 'sp' };
  return { value: round(n.textSize.px / d, 2), unit: n.textSize.unit === 1 ? 'dp' : 'px' };
}

const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * 화소 c 가 색 o → 색 a 선의 어디쯤인가 (0 이면 o, 1 이면 a, 0~1 로 자름) 와 그 선(a 너머로 늘린 반직선)에서 떨어진 거리.
 * a 가 안티에일리어싱으로 옅어진 색이어도 더 진한 같은 색 화소가 같은 선 위에 오게 a 너머로 늘린다
 */
function along(c: Rgb, o: Rgb, a: Rgb): { t: number; raw: number; off: number } {
  const d: Rgb = [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
  const len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
  const raw = Math.max(0, ((c[0] - o[0]) * d[0] + (c[1] - o[1]) * d[1] + (c[2] - o[2]) * d[2]) / len2);
  return { t: Math.min(1, raw), raw, off: dist(c, [o[0] + raw * d[0], o[1] + raw * d[1], o[2] + raw * d[2]]) };
}

function pixel(img: Raster, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** 색을 채널마다 bits 비트로 묶어 센 가장 많은 묶음의 평균과 개수 */
function dominant(cs: Iterable<Rgb>, bits = 4): { rgb: Rgb; n: number; total: number } | undefined {
  const sh = 8 - bits;
  const buckets = new Map<number, { n: number; sum: Rgb }>();
  let total = 0;
  for (const c of cs) {
    const k = ((c[0] >> sh) << (bits * 2)) | ((c[1] >> sh) << bits) | (c[2] >> sh);
    const v = buckets.get(k) ?? { n: 0, sum: [0, 0, 0] };
    v.n++;
    v.sum[0] += c[0];
    v.sum[1] += c[1];
    v.sum[2] += c[2];
    buckets.set(k, v);
    total++;
  }
  let top: { n: number; sum: Rgb } | undefined;
  for (const v of buckets.values()) if (!top || v.n > top.n) top = v;
  return top && { rgb: [top.sum[0] / top.n, top.sum[1] / top.n, top.sum[2] / top.n], n: top.n, total };
}

export interface InkSample {
  background?: MeasuredText['background'];
  color?: MeasuredText['color'];
  inks?: MeasuredText['inks'];
  stroke?: number;
  lines?: MeasuredText['lines'];
}

interface Far {
  x: number;
  y: number;
  d: number;
  c: Rgb;
}

/** 무리 가운데 색: 배경에서 가장 먼 쪽(안티에일리어싱으로 섞이지 않은 획의 가운데) 화소들의 평균 */
function coreColor(m: Far[]): { rgb: Rgb; n: number } {
  const ds = m.map((f) => f.d).sort((a, b) => a - b);
  const p95 = ds[Math.floor(ds.length * 0.95)];
  const c = m.filter((f) => f.d >= p95 * 0.85 && f.d <= p95 * 1.05);
  const sum = c.reduce<Rgb>((s, f) => [s[0] + f.c[0], s[1] + f.c[1], s[2] + f.c[2]], [0, 0, 0]);
  return { rgb: [sum[0] / c.length, sum[1] / c.length, sum[2] / c.length], n: c.length };
}

/** 노드 영역의 배경·글자 색과 획 폭·줄 간격. 배경이 고르지 않거나(그라데이션·이미지 위) 다른 색이 섞이면 measured=false */
export function sampleText(img: Raster, [l0, t0, r0, b0]: Bounds): InkSample {
  const l = Math.max(0, Math.floor(l0));
  const t = Math.max(0, Math.floor(t0));
  const r = Math.min(img.width, Math.ceil(r0));
  const b = Math.min(img.height, Math.ceil(b0));
  if (r - l < 4 || b - t < 4) return {};
  // 가장자리 2px 띠에서 가장 많은 색 (5비트로 묶어 센다)
  const ring: Rgb[] = [];
  for (let x = l; x < r; x++) for (const y of [t, t + 1, b - 2, b - 1]) ring.push(pixel(img, x, y));
  for (let y = t + 2; y < b - 2; y++) for (const x of [l, l + 1, r - 2, r - 1]) ring.push(pixel(img, x, y));
  const top = dominant(ring, 5)!;
  const bg = top.rgb;
  const uniform = top.n / top.total >= 0.6;
  const background = { hex: rgbToHex(bg), measured: uniform };

  const far: Far[] = [];
  for (let y = t + 2; y < b - 2; y++)
    for (let x = l + 2; x < r - 2; x++) {
      const c = pixel(img, x, y);
      const d = dist(c, bg);
      if (d > 48) far.push({ x, y, d, c });
    }
  if (far.length < 8) return { background };

  // 색 무리: 배경에서 먼 절반 화소 중 가장 많은 색 묶음(획 가운데 색)을 씨앗으로, 배경 → 씨앗 선 위의 화소
  // (안티에일리어싱으로 섞인 것 포함, 씨앗보다 30% 넘게 진하면 다른 색)를 한 무리로 본다.
  // 남은 화소가 15% 이상이면 둘째 무리 (아이콘·다른 색 글자. 회색 글자 옆 검은 아이콘처럼 같은 선 위의 다른 진하기도 가른다)
  const clusters: Far[][] = [];
  let rest = far;
  for (let k = 0; k < 2 && rest.length >= 8; k++) {
    const ds = rest.map((f) => f.d).sort((a, c) => a - c);
    const mid = ds[Math.floor(ds.length / 2)];
    const seed = dominant(rest.filter((f) => f.d >= mid).map((f) => f.c))!.rgb;
    const members: Far[] = [];
    const left: Far[] = [];
    for (const f of rest) {
      const a = along(f.c, bg, seed);
      (a.off < 40 && a.raw <= 1.3 ? members : left).push(f);
    }
    if (!members.length || members.length < far.length * 0.15) break;
    clusters.push(members);
    rest = left;
    if (rest.length < far.length * 0.15) break;
  }
  if (!clusters.length) return { background };
  clusters.sort((a, c) => c.length - a.length);
  const cores = clusters.map(coreColor);
  const main = cores[0];
  const color = { hex: rgbToHex(main.rgb), measured: uniform && main.n >= 8 && clusters.length === 1 };
  const inks = clusters.map((c, i) => ({ hex: rgbToHex(cores[i].rgb), share: round(c.length / far.length, 2) }));

  // 덮인 정도(0~1): 가장 큰 무리의 색 쪽으로 얼마나 갔나. 배경에서 48 안쪽이라 빠진 옅은 가장자리도 센다
  const w = r - l;
  const h = b - t;
  const cover = new Float32Array(w * h);
  for (let y = t + 2; y < b - 2; y++)
    for (let x = l + 2; x < r - 2; x++) {
      const a = along(pixel(img, x, y), bg, main.rgb);
      if (a.off < 40 && a.t > 0.1) cover[(y - t) * w + (x - l)] = a.t;
    }
  // 획 폭: 가로 줄마다 이어진 구간의 덮인 정도 합. 그 중앙값
  const runs: number[] = [];
  const rowInk: number[] = [];
  for (let y = 0; y < h; y++) {
    let run = 0;
    let row = 0;
    for (let x = 0; x <= w; x++) {
      const v = x < w ? cover[y * w + x] : 0;
      row += v;
      if (v > 0.15) run += v;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    rowInk.push(row);
  }
  runs.sort((a, c) => a - c);
  const stroke = runs.length >= 4 ? round(runs[Math.floor(runs.length / 2)], 2) : undefined;

  // 줄: 글자 화소가 있는 행 묶음. 아주 얇은 묶음(점·악센트)은 바로 아래 묶음에 붙인다
  const blocks: { top: number; bottom: number }[] = [];
  for (let y = 0; y < h; y++) {
    if (rowInk[y] < 0.5) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.bottom === y) last.bottom = y + 1;
    else blocks.push({ top: y, bottom: y + 1 });
  }
  const tallest = Math.max(0, ...blocks.map((k) => k.bottom - k.top));
  for (let i = 0; i < blocks.length - 1; i++) {
    const k = blocks[i];
    const next = blocks[i + 1];
    if (k.bottom - k.top < tallest * 0.35 && next.top - k.bottom < tallest * 0.5) {
      next.top = k.top;
      blocks.splice(i--, 1);
    }
  }
  const n = blocks.length;
  // 줄 간격: 위끝 간격과 아래끝 간격의 평균 (올라가고 내려가는 획의 차이를 줄이려고)
  const lines = n
    ? n >= 2
      ? { count: n, pitch: round((blocks[n - 1].top - blocks[0].top + blocks[n - 1].bottom - blocks[0].bottom) / 2 / (n - 1), 2) }
      : { count: 1 }
    : undefined;
  return {
    background,
    color,
    ...(clusters.length > 1 ? { inks } : {}),
    ...(stroke !== undefined ? { stroke } : {}),
    ...(lines ? { lines } : {}),
  };
}

/** 노드 영역의 배경·글자 색 */
export function sampleColors(img: Raster, bounds: Bounds): { background?: MeasuredText['background']; color?: MeasuredText['color'] } {
  const { background, color } = sampleText(img, bounds);
  return { ...(background ? { background } : {}), ...(color ? { color } : {}) };
}

export function measureTexts(root: ViewNode, img: Raster, screen: ScreenMetrics, packageName?: string): MeasuredText[] {
  const byId = new Map(flatten(root).map((n) => [n.id, n]));
  return textNodes(root, screen, packageName).map((n) => {
    const description = !n.text.trim();
    const fontSize = description ? undefined : fontSizeOf(n, screen);
    return {
      nodeId: n.id,
      text: description ? n.contentDesc : n.text,
      className: n.className,
      bounds: n.bounds,
      rect: toDpRect(n.bounds, screen.density),
      ...(fontSize ? { fontSize } : {}),
      ...(description ? { description: true } : sampleText(img, n.bounds)),
      ...(clippedOf(n, byId, screen) ? { clipped: true } : {}),
    };
  });
}

// ---------- 상자 (#89) ----------

export interface MeasuredBox {
  /** 기기 px */
  bounds: Bounds;
  /** 상자 색 */
  color: string;
  /** 모서리 반경 어림값 (기기 px) */
  radius: number;
  /** 찾는 범위의 끝까지 이어졌다 (실제로는 더 클 수 있다) */
  edge: boolean;
}

/** 값이 최대의 10% 이상인 구간 중 기준 위치를 품은 것(없으면 가장 긴 것) */
function spanOf(vals: ArrayLike<number>, center: number): [number, number] | undefined {
  let max = 0;
  for (let i = 0; i < vals.length; i++) max = Math.max(max, vals[i]);
  if (!max) return undefined;
  let best: [number, number] | undefined;
  for (let i = 0; i < vals.length; ) {
    if (vals[i] < max * 0.1) {
      i++;
      continue;
    }
    let j = i;
    while (j < vals.length && vals[j] >= max * 0.1) j++;
    if (i <= center && center < j) return [i, j];
    if (!best || j - i > best[1] - best[0]) best = [i, j];
    i = j;
  }
  return best;
}

/**
 * 있어야 할 자리(expected, 기기 px)에서 margin 만큼 넓힌 범위 안의 상자를 찾는다.
 * 상자 색은 자리 안쪽 가운데의 가장 많은 색, 바깥 색은 찾는 범위 테두리의 가장 많은 색. 둘이 비슷하면(상자가 없음) undefined
 */
export function measureBox(img: Raster, expected: Bounds, margin: number): MeasuredBox | undefined {
  const [el, et, er, eb] = expected;
  const l = Math.max(0, Math.floor(el - margin));
  const t = Math.max(0, Math.floor(et - margin));
  const r = Math.min(img.width, Math.ceil(er + margin));
  const b = Math.min(img.height, Math.ceil(eb + margin));
  if (r - l < 8 || b - t < 8) return undefined;
  const cw = er - el;
  const ch = eb - et;
  const inner: Rgb[] = [];
  for (let y = Math.max(t, Math.floor(et + ch * 0.25)); y < Math.min(b, Math.ceil(eb - ch * 0.25)); y++)
    for (let x = Math.max(l, Math.floor(el + cw * 0.25)); x < Math.min(r, Math.ceil(er - cw * 0.25)); x++) inner.push(pixel(img, x, y));
  const edgePx: Rgb[] = [];
  for (let x = l; x < r; x++) edgePx.push(pixel(img, x, t), pixel(img, x, b - 1));
  for (let y = t; y < b; y++) edgePx.push(pixel(img, l, y), pixel(img, r - 1, y));
  const boxC = dominant(inner)?.rgb;
  const out = dominant(edgePx)?.rgb;
  if (!boxC || !out || dist(boxC, out) < 24) return undefined;
  const w = r - l;
  const h = b - t;
  const mask = new Uint8Array(w * h);
  const rows = new Uint32Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (dist(pixel(img, l + x, t + y), boxC) < 30) {
        mask[y * w + x] = 1;
        rows[y]++;
      }
  const ys = spanOf(rows, Math.round((et + eb) / 2) - t);
  if (!ys) return undefined;
  const cols = new Uint32Array(w);
  for (let y = ys[0]; y < ys[1]; y++) for (let x = 0; x < w; x++) cols[x] += mask[y * w + x];
  const xs = spanOf(cols, Math.round((el + er) / 2) - l);
  if (!xs) return undefined;
  const bw = xs[1] - xs[0];
  const bh = ys[1] - ys[0];
  if (bw < 4 || bh < 4) return undefined;
  const bounds: Bounds = [l + xs[0], t + ys[0], l + xs[1], t + ys[1]];
  // 모서리: 꼭짓점에서 대각선으로 들어가며 상자에 덜 덮인 만큼(1 - 덮인 정도)을 더한 값 a 가 r(1 - 1/√2) 이다
  const corner = (x0: number, y0: number, dx: number, dy: number) => {
    let a = 0;
    for (let k = 0; k < Math.min(bw, bh) / 2; k++) {
      const f = along(pixel(img, x0 + dx * k, y0 + dy * k), out, boxC).t;
      if (f >= 0.95) break;
      a += 1 - f;
    }
    return a / (1 - Math.SQRT1_2);
  };
  const [bl, bt, br, bb] = bounds;
  // 네 모서리 중 가운데 두 값의 평균 (한 모서리에 다른 그림이 겹쳐도 덜 흔들리게)
  const rs = [corner(bl, bt, 1, 1), corner(br - 1, bt, -1, 1), corner(bl, bb - 1, 1, -1), corner(br - 1, bb - 1, -1, -1)].sort(
    (a, c) => a - c,
  );
  const radius = Math.min((rs[1] + rs[2]) / 2, Math.min(bw, bh) / 2);
  return { bounds, color: rgbToHex(boxC), radius: round(radius), edge: bl <= l || bt <= t || br >= r || bb >= b };
}
