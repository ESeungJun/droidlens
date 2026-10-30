import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

/**
 * 부분 업데이트: 새 파일 중 이미 가진 파일(이전에 받은 설치 파일·지금 AppImage)과 같은 조각은 그대로 쓰고
 * 달라진 조각만 HTTP Range 로 받아 새 파일을 만든다.
 * 조각 목록은 electron-builder 의 blockmap 형식(내용 기준 가변 크기 조각, gzip JSON)을 쓴다. 릴리스가 첨부 파일마다
 * `<이름>.blockmap` 을 함께 올린다. 만든 파일은 호출한 쪽이 SHA256SUMS 로 다시 확인한다
 */

export interface BlockMap {
  checksums: string[];
  sizes: number[];
}

export function parseBlockMap(gz: Buffer): BlockMap {
  const json = JSON.parse(gunzipSync(gz).toString('utf8')) as { files?: { checksums?: unknown; sizes?: unknown }[] };
  const f = json.files?.[0];
  if (!f || !Array.isArray(f.checksums) || !Array.isArray(f.sizes) || f.checksums.length !== f.sizes.length) {
    throw new Error('blockmap 형식이 올바르지 않습니다');
  }
  if (!f.sizes.every((s) => Number.isInteger(s) && s > 0)) throw new Error('blockmap 조각 크기가 올바르지 않습니다');
  return { checksums: f.checksums as string[], sizes: f.sizes as number[] };
}

/** 새 파일을 만드는 순서대로의 조각: 이전 파일에서 복사(old) 하거나 새로 받을(new) 구간 */
export type Piece = { from: 'old' | 'new'; offset: number; size: number };

export interface DeltaPlan {
  pieces: Piece[];
  /** 새로 받을 바이트 범위 [start, end) — 가까운 구간은 합쳐 요청 수를 줄인다 */
  ranges: [number, number][];
  /** 범위 요청으로 받을 바이트 수 */
  download: number;
  total: number;
}

/** 이 크기보다 가까이 붙은 새 구간은 사이까지 한 번에 받는다 (요청 하나의 왕복 비용이 더 크다) */
const MERGE_GAP = 64 * 1024;
const COPY_CHUNK = 4 * 1024 * 1024;

export function planDelta(oldMap: BlockMap, newMap: BlockMap): DeltaPlan {
  const oldAt = new Map<string, number>();
  let off = 0;
  oldMap.checksums.forEach((c, i) => {
    if (!oldAt.has(c)) oldAt.set(c, off);
    off += oldMap.sizes[i];
  });
  const pieces: Piece[] = [];
  const push = (p: Piece) => {
    const last = pieces.at(-1);
    // 이어지는 같은 종류 구간은 하나로 합친다
    if (last && last.from === p.from && last.offset + last.size === p.offset) last.size += p.size;
    else pieces.push(p);
  };
  let pos = 0;
  newMap.checksums.forEach((c, i) => {
    const size = newMap.sizes[i];
    const o = oldAt.get(c);
    push(o === undefined ? { from: 'new', offset: pos, size } : { from: 'old', offset: o, size });
    pos += size;
  });
  const ranges: [number, number][] = [];
  let at = 0;
  for (const p of pieces) {
    if (p.from === 'new') {
      const last = ranges.at(-1);
      if (last && at - last[1] <= MERGE_GAP) last[1] = at + p.size;
      else ranges.push([at, at + p.size]);
    }
    at += p.size;
  }
  return { pieces, ranges, download: ranges.reduce((s, [a, b]) => s + b - a, 0), total: pos };
}

/**
 * 계획대로 새 파일을 만든다. 범위 요청은 순서대로 보내고(동시에 여러 개면 GitHub 가 끊기도 한다),
 * 받은 바이트 수를 onProgress 로 알린다
 */
export async function buildFromDelta(
  plan: DeltaPlan,
  oldFile: string,
  url: string,
  outFile: string,
  opts: { signal?: AbortSignal; onBytes?: (got: number) => void; headers?: Record<string, string> } = {},
): Promise<void> {
  // 받을 양은 전체보다 훨씬 작다는 전제라(그렇지 않으면 부르는 쪽이 전체 다운로드를 고른다) 메모리에 모은다
  const got: { start: number; buf: Buffer }[] = [];
  let bytes = 0;
  for (const [start, end] of plan.ranges) {
    const res = await fetch(url, { headers: { ...opts.headers, Range: `bytes=${start}-${end - 1}` }, signal: opts.signal });
    if (res.status !== 206) throw new Error(`범위 요청을 지원하지 않습니다 (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== end - start) throw new Error(`받은 조각 크기가 다릅니다 (${buf.length} ≠ ${end - start})`);
    got.push({ start, buf });
    bytes += buf.length;
    opts.onBytes?.(bytes);
  }
  const src = await open(oldFile, 'r');
  const out = await open(outFile, 'w');
  const copyBuf = Buffer.allocUnsafe(COPY_CHUNK);
  try {
    let at = 0;
    let r = 0;
    for (const p of plan.pieces) {
      if (p.from === 'old') {
        // 합쳐진 구간은 수십 MB 일 수 있어 나눠 옮긴다
        for (let done = 0; done < p.size; ) {
          const n = Math.min(COPY_CHUNK, p.size - done);
          const { bytesRead } = await src.read(copyBuf, 0, n, p.offset + done);
          if (bytesRead !== n) throw new Error('이전 파일이 blockmap 과 맞지 않습니다');
          await out.write(copyBuf, 0, n);
          done += n;
        }
      } else {
        while (got[r].start + got[r].buf.length <= at) r++;
        const g = got[r];
        await out.write(g.buf.subarray(at - g.start, at - g.start + p.size));
      }
      at += p.size;
    }
  } finally {
    await src.close();
    await out.close();
  }
}
