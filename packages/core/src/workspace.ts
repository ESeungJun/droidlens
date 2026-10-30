import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 모든 산출물(스크린샷, 녹화, 화면 그래프, 시나리오 리포트, APK 캐시)의 루트. DROIDLENS_HOME으로 변경 가능 */
export function droidlensHome(): string {
  return process.env.DROIDLENS_HOME ?? join(homedir(), '.droidlens');
}

export async function ensureDir(...parts: string[]): Promise<string> {
  const dir = join(droidlensHome(), ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function safeName(s: string): string {
  // 한글 등 유니코드 글자는 살리고 경로에 위험한 문자만 바꾼다
  return s.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '_').slice(0, 80) || 'unnamed';
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2));
}

/** 임시 파일에 쓴 뒤 이름을 바꿔 덮는다. 다른 프로세스가 쓰는 도중의 반쪽 파일을 읽지 않게 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
