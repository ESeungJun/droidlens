import { PNG } from 'pngjs';
import { parseFigmaLink, type DesignGuide } from './guide.js';

/**
 * Figma 프레임 이미지 받기 (#89): Figma REST API(`GET /v1/images/:file?ids=…&format=png`)로 프레임을 PNG 로 받아
 * 가이드 옆에 둔다. 보고서는 이 이미지에서 요소 자리를 잘라 화면 조각과 나란히 놓는다.
 *   - 토큰: 환경 변수 FIGMA_TOKEN (또는 DROIDLENS_FIGMA_TOKEN). Figma 개인 토큰(file_content:read)
 *   - 커넥터(get_screenshot)의 이미지는 에이전트 대화 안에만 있어 MCP 서버가 받을 수 없다. 그래서 토큰이 있을 때만 받는다
 *   - 토큰은 요청 머리글에만 쓰고 오류 글·파일에 남기지 않는다
 */

export const FIGMA_API = 'https://api.figma.com';
/** 받은 PNG 의 최대 크기 */
const MAX_BYTES = 25 * 1024 * 1024;
/** 긴 변이 이보다 크지 않게 배율을 낮춘다 */
const MAX_EDGE = 4096;

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' | 'error' },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export function figmaToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = (env.FIGMA_TOKEN ?? env.DROIDLENS_FIGMA_TOKEN ?? '').trim();
  return t || undefined;
}

export interface FigmaImage {
  png: Buffer;
  width: number;
  height: number;
  /** 이미지 px 가 Figma px 몇 개인가 */
  scale: number;
}

/** 이미지 주소는 https 의 Figma·S3 주소만 받는다 (응답이 엉뚱한 곳으로 보내지 않게) */
function imageUrlOk(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (/(^|\.)figma\.com$/.test(u.hostname) || /\.amazonaws\.com$/.test(u.hostname));
  } catch {
    return false;
  }
}

async function readLimited(res: Awaited<ReturnType<FetchLike>>): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`Figma 이미지가 너무 큽니다 (${Math.round(len / 1024 / 1024)}MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`Figma 이미지가 너무 큽니다 (${Math.round(buf.length / 1024 / 1024)}MB)`);
  return buf;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 머리의 너비·높이. PNG 가 아니면 undefined */
function pngHeaderSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 프레임 크기로 요청 배율을 고른다: 2배, 긴 변이 4096 을 넘으면 그 안으로 (Figma 는 0.01~4) */
export function figmaImageScale(frame: { width: number; height: number }): number {
  const s = Math.min(2, MAX_EDGE / Math.max(frame.width, frame.height));
  return Math.max(0.01, Math.round(s * 100) / 100);
}

/** 가이드의 프레임을 PNG 로 받는다. 실패하면 이유를 담아 던진다 (토큰은 담지 않는다) */
export async function fetchFigmaImage(
  guide: Pick<DesignGuide, 'figma' | 'frame'>,
  opts: { token: string; fetch?: FetchLike; timeoutMs?: number },
): Promise<FigmaImage> {
  const link = parseFigmaLink(guide.figma);
  if (!link) throw new Error('Figma 링크에서 파일 키를 찾지 못했습니다');
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const scale = figmaImageScale(guide.frame);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const api = `${FIGMA_API}/v1/images/${encodeURIComponent(link.fileKey)}?ids=${encodeURIComponent(guide.frame.id)}&format=png&scale=${scale}`;
    const res = await f(api, { headers: { 'X-Figma-Token': opts.token }, signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) {
      const why =
        res.status === 403 ? '토큰이 맞지 않거나 이 파일을 볼 권한이 없습니다' : res.status === 404 ? '파일이나 노드를 찾지 못했습니다' : res.status === 429 ? '요청이 너무 많습니다. 잠시 뒤 다시 저장하세요' : '';
      throw new Error(`Figma 이미지 요청이 실패했습니다 (HTTP ${res.status})${why ? `: ${why}` : ''}`);
    }
    const body = (await res.json()) as { err?: unknown; images?: Record<string, unknown> };
    const url = body?.images?.[guide.frame.id];
    if (typeof url !== 'string' || !url) throw new Error(`Figma 가 이 프레임(${guide.frame.id})의 이미지를 만들지 못했습니다`);
    if (!imageUrlOk(url)) throw new Error('Figma 가 알 수 없는 주소의 이미지를 돌려줬습니다');
    const img = await f(url, { signal: ctrl.signal });
    if (!img.ok) throw new Error(`Figma 이미지를 받지 못했습니다 (HTTP ${img.status})`);
    const png = await readLimited(img);
    // 풀기 전에 머리(IHDR)의 크기부터 본다: 작은 파일이 아주 큰 화면으로 풀리며 메모리를 다 쓰지 않게
    const head = pngHeaderSize(png);
    if (!head) throw new Error('Figma 가 돌려준 파일이 PNG 가 아닙니다');
    if (head.width > MAX_EDGE * 2 || head.height > MAX_EDGE * 2)
      throw new Error(`Figma 이미지가 너무 큽니다 (${head.width}×${head.height})`);
    let width: number;
    let height: number;
    try {
      ({ width, height } = PNG.sync.read(png));
    } catch {
      throw new Error('Figma 가 돌려준 파일이 PNG 가 아닙니다');
    }
    return { png, width, height, scale: Math.round((width / guide.frame.width) * 1000) / 1000 };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Figma 이미지 요청이 시간 안에 끝나지 않았습니다');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
