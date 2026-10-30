import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { DeviceAdb, sleep } from './adb.js';
import { ensureAgent } from './agent.js';
import { screenshot } from './device.js';
import { dumpHierarchy, findNodes, type Bounds, type Selector } from './hierarchy.js';
import { ensureDir, safeName, writeFileAtomic } from './workspace.js';

/**
 * 스크린샷 비교 (시각적 회귀). 화면을 기준 이미지와 픽셀 단위로 비교해 달라진 비율과 차이 이미지를 만든다.
 * 기준 이미지는 ~/.droidlens/baselines/<앱>/<이름>@<가로>x<세로>.png 에 둔다. 해상도별로 따로 두어
 * 다른 기기·방향에서 처음 돌리면 그 화면이 새 기준이 된다.
 */

export interface ImageDiff {
  width: number;
  height: number;
  /** 다르다고 본 픽셀 수 (무시 영역 제외) */
  diffPixels: number;
  /** 비교한 픽셀 수 (무시 영역 제외) */
  comparedPixels: number;
  diffPercent: number;
  /** 달라진 픽셀을 감싸는 영역. 같으면 없음 */
  diffBounds?: Bounds;
  /** 지금 화면 위에 달라진 곳을 빨갛게, 무시한 곳을 파랗게 칠한 PNG */
  diffPng: Buffer;
}

/** 채널 차이가 이 값 이하면 같은 색으로 본다 (그림자·글꼴 안티앨리어싱 차이) */
export const DEFAULT_TOLERANCE = 16;
export const DEFAULT_MAX_DIFF_PERCENT = 0.5;

const inside = (x: number, y: number, r: Bounds) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** 두 PNG 를 비교한다. 크기가 다르면 에러 */
export function diffImages(baselinePng: Buffer, actualPng: Buffer, opts: { ignore?: Bounds[]; tolerance?: number } = {}): ImageDiff {
  const a = PNG.sync.read(baselinePng);
  const b = PNG.sync.read(actualPng);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`기준 이미지 크기 ${a.width}x${a.height} 와 지금 화면 ${b.width}x${b.height} 가 다릅니다`);
  }
  const { width, height } = b;
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const ignore = opts.ignore ?? [];
  const out = new PNG({ width, height });
  let diffPixels = 0;
  let compared = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // 바탕은 지금 화면을 흐리게 깐다
      const lum = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
      const faded = 255 - (255 - lum) * 0.35;
      let r = faded, g = faded, bl = faded;
      if (ignore.some((rect) => inside(x, y, rect))) {
        r = faded * 0.75;
        g = faded * 0.85;
      } else {
        compared++;
        const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
        if (d > tol) {
          diffPixels++;
          r = 220;
          g = 38;
          bl = 38;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = bl;
      out.data[i + 3] = 255;
    }
  }
  const diffBounds: Bounds | undefined = maxX >= 0 ? [minX, minY, maxX + 1, maxY + 1] : undefined;
  // 몇 픽셀만 달라도 눈에 띄게 달라진 영역에 테두리를 두른다
  if (diffBounds) strokeRect(out, diffBounds, 4, [220, 38, 38]);
  return {
    width,
    height,
    diffPixels,
    comparedPixels: compared,
    diffPercent: compared ? Math.round((diffPixels / compared) * 10000) / 100 : 0,
    diffBounds,
    diffPng: PNG.sync.write(out),
  };
}

function strokeRect(img: PNG, [l, t, r, b]: Bounds, w: number, [cr, cg, cb]: [number, number, number]): void {
  const pad = w * 2;
  const L = Math.max(0, l - pad), T = Math.max(0, t - pad), R = Math.min(img.width, r + pad), B = Math.min(img.height, b + pad);
  for (let y = T; y < B; y++) {
    for (let x = L; x < R; x++) {
      if (x >= L + w && x < R - w && y >= T + w && y < B - w) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] = cr;
      img.data[i + 1] = cg;
      img.data[i + 2] = cb;
    }
  }
}

/** PNG 머리말(IHDR)에서 크기만 읽는다 */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** 파일 이름으로 쓸 수 없는 글자를 바꾼 이름은 짧은 해시를 붙여 '주문/목록' 과 '주문_목록' 이 같은 파일을 쓰지 않게 한다 */
function baselineStem(name: string): string {
  const safe = safeName(name);
  return safe === name ? safe : `${safe}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

async function baselineFile(app: string, name: string, size: { width: number; height: number }): Promise<string> {
  return join(await ensureDir('baselines', safeName(app)), `${baselineStem(name)}@${size.width}x${size.height}.png`);
}

/** 기준 이미지를 저장(덮어쓰기)한다. 크기는 이미지에서 읽는다 */
export async function saveBaseline(app: string, name: string, png: Buffer): Promise<string> {
  const file = await baselineFile(app, name, pngSize(png));
  await writeFileAtomic(file, png);
  return file;
}

/**
 * 상태바 영역. 시계·배터리·알림 아이콘이 늘 바뀌어 비교에서 뺀다.
 * Android 11+ 는 dumpsys window 의 statusBars 영역, 그 전은 24dp 로 잡는다
 */
export async function statusBarBounds(dev: DeviceAdb, width: number): Promise<Bounds> {
  // Android 14+ 는 type=statusBars, 11~13 은 type=ITYPE_STATUS_BAR 로 적힌다
  const out = await dev.shell('dumpsys window | grep -m1 -E "type=(statusBars|ITYPE_STATUS_BAR) frame=.*visible=true"').catch(() => '');
  const m = /frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(out);
  if (m && Number(m[4]) > 0) return [0, 0, width, Number(m[4])];
  const density = Number(/(\d+)\s*$/.exec((await dev.shell('wm density').catch(() => '')).trim())?.[1]) || 420;
  return [0, 0, width, Math.ceil((24 * density) / 160)];
}

export interface ScreenshotMatch {
  /** 기준 이미지가 없거나 update 라 지금 화면을 기준으로 저장했다 */
  saved: boolean;
  baseline: string;
  actual: Buffer;
  diff?: ImageDiff;
  /** 비교에서 뺀 영역 (상태바 + ignore 셀렉터) */
  ignored: Bounds[];
}

/**
 * 지금 화면을 기준 이미지와 비교한다. 기준이 없으면(또는 update) 지금 화면을 기준으로 저장한다.
 * ignore 셀렉터에 맞는 요소(시계·광고·애니메이션 등)와 상태바는 비교하지 않는다
 */
export async function matchScreenshot(
  dev: DeviceAdb,
  app: string,
  name: string,
  opts: { ignore?: Selector[]; tolerance?: number; update?: boolean } = {},
): Promise<ScreenshotMatch> {
  // 화면 전환·리플 애니메이션이 끝난 뒤 찍는다
  const agent = await ensureAgent(dev);
  if (agent) await agent.waitIdle(500, 3000).catch(() => sleep(800));
  else await sleep(800);
  const actual = await screenshot(dev);
  const size = pngSize(actual);
  const ignored: Bounds[] = [await statusBarBounds(dev, size.width)];
  if (opts.ignore?.length) {
    const root = (await dumpHierarchy(dev)).root;
    for (const sel of opts.ignore) for (const n of findNodes(root, sel)) ignored.push(n.bounds);
  }
  const baseline = await baselineFile(app, name, size);
  if (opts.update || !existsSync(baseline)) {
    await writeFileAtomic(baseline, actual);
    return { saved: true, baseline, actual, ignored };
  }
  const diff = diffImages(await readFile(baseline), actual, { ignore: ignored, tolerance: opts.tolerance });
  return { saved: false, baseline, actual, diff, ignored };
}
