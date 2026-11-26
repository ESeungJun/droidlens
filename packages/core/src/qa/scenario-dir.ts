import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { droidlensHome } from '../workspace.js';

/**
 * 디스크의 시나리오 기록을 다시 읽는 곳(내보내기·열린 기록 정리)이 같이 쓰는 경로 검사 (#113).
 * 기록 폴더나 그 안의 파일은 손댄 것일 수 있다: 심볼릭 링크를 따라 시나리오 폴더 밖을 읽거나 쓰지 않는다.
 */

/** 시나리오 폴더 바로 아래 폴더인지, 심볼릭 링크를 푼 실제 경로로 본다. 맞으면 실제 경로 */
export async function scenarioDirReal(dir: string | undefined): Promise<string | undefined> {
  if (!dir) return undefined;
  const root = await realpath(join(droidlensHome(), 'scenarios')).catch(() => undefined);
  const real = await realpath(dir).catch(() => undefined);
  if (!root || !real) return undefined;
  const base = root + sep;
  return real.startsWith(base) && !real.slice(base.length).includes(sep) ? real : undefined;
}

/** 일반 파일(링크가 아닌)이고 max 바이트 이하일 때만 읽는다 */
export async function readRegularFile(path: string, max = 32 * 1024 * 1024): Promise<Buffer | undefined> {
  const st = await lstat(path).catch(() => undefined);
  if (!st?.isFile() || st.size > max) return undefined;
  return readFile(path).catch(() => undefined);
}

/** JPEG 표지(FF D8)로 시작하는지 */
export const isJpeg = (b: Buffer | undefined): b is Buffer => !!b && b.length > 2 && b[0] === 0xff && b[1] === 0xd8;
