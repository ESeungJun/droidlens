import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

/**
 * GitHub Releases 기반 자체 업데이트.
 * macOS 앱이 Apple 인증서 없이 임시(ad-hoc) 서명만 되어 있어 Squirrel(electron-updater)을 쓸 수 없으므로 플랫폼별로 직접 교체한다.
 * 받은 파일은 릴리스의 SHA256SUMS 와 대조해 다르면 설치하지 않는다.
 *  - macOS: zip을 받아 풀고, 앱이 종료되면 번들을 교체한 뒤 다시 연다 (분리된 셸 스크립트)
 *  - Windows: NSIS 설치 파일을 조용히(/S) 실행하고 설치 후 자동 실행(--force-run)
 *  - Linux: AppImage 파일을 바꾸고 다시 실행
 */

const REPO = 'ESeungJun/droidlens';
const run = promisify(execFile);

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes?: string;
  url: string;
  asset?: { name: string; url: string; size: number };
  /** 릴리스 첨부 파일의 SHA-256 목록 (SHA256SUMS) */
  sumsUrl?: string;
  /** 이 실행 형태에서 자동 설치가 가능한지 (개발 모드·지원하지 않는 설치 형태면 false) */
  canInstall: boolean;
  reason?: string;
}

/** 개발용: DROIDLENS_FAKE_VERSION으로 현재 버전을 낮춰 업데이트 흐름을 시험한다 */
export function currentVersion(): string {
  return process.env.DROIDLENS_FAKE_VERSION ?? app.getVersion();
}

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Rosetta 로 실행 중인 Intel 빌드면 Apple 칩용으로 바꿔 받도록 실제 CPU 를 본다 */
async function cpuArch(): Promise<'arm64' | 'x64'> {
  if (process.arch === 'arm64') return 'arm64';
  if (process.platform === 'darwin') {
    const out = await run('sysctl', ['-in', 'sysctl.proc_translated']).then((r) => r.stdout.trim()).catch(() => '');
    if (out === '1') return 'arm64';
  }
  return 'x64';
}

function assetName(version: string, arch: 'arm64' | 'x64'): string | undefined {
  if (process.platform === 'darwin') return `DroidLens-${version}-mac-${arch}.zip`;
  if (process.platform === 'win32') return `DroidLens-${version}-win-${arch}.exe`;
  if (process.platform === 'linux') return `DroidLens-${version}-linux-x86_64.AppImage`;
  return undefined;
}

/** 현재 실행 중인 macOS 앱 번들 경로 (…/DroidLens.app) */
function macBundle(): string {
  return resolve(dirname(process.execPath), '..', '..');
}

type Release = { tag_name: string; body?: string; html_url: string; assets: { name: string; browser_download_url: string; size: number }[] };

/**
 * 최신 릴리스. GitHub API 는 비로그인 시 IP 당 시간당 60회라 회사처럼 IP 를 함께 쓰면 금방 막힌다.
 * 막히면 releases/latest 주소의 리다이렉트로 태그를 알아내고 파일 주소는 이름 규칙으로 만든다 (노트·크기는 없음)
 */
async function latestRelease(arch: 'arm64' | 'x64'): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DroidLens' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (res?.ok) return (await res.json()) as Release;
  const page = await fetch(`https://github.com/${REPO}/releases/latest`, { headers: { 'User-Agent': 'DroidLens' }, signal: AbortSignal.timeout(15_000) });
  const tag = page.url.split('/tag/')[1];
  if (!page.ok || !tag || !/^v\d/.test(tag)) throw new Error(`업데이트 확인 실패 (GitHub ${res?.status ?? page.status})`);
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const names = [assetName(tag.replace(/^v/, ''), arch), 'SHA256SUMS'].filter((x): x is string => !!x);
  return { tag_name: tag, html_url: page.url, assets: names.map((name) => ({ name, browser_download_url: `${base}/${name}`, size: 0 })) };
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const arch = await cpuArch();
  const rel = await latestRelease(arch);
  const latest = rel.tag_name.replace(/^v/, '');
  const current = currentVersion();
  const name = assetName(latest, arch);
  const a = rel.assets.find((x) => x.name === name);
  const sums = rel.assets.find((x) => x.name === 'SHA256SUMS');
  let canInstall = app.isPackaged && !!a;
  let reason: string | undefined;
  if (!app.isPackaged) reason = '개발 모드에서는 자동 설치를 하지 않습니다 (git pull 후 다시 빌드)';
  else if (!a) reason = `이 플랫폼용 파일(${name})이 릴리스에 없습니다`;
  else if (process.platform === 'linux' && !process.env.APPIMAGE) {
    canInstall = false;
    reason = 'AppImage로 실행한 경우에만 자동 업데이트를 지원합니다';
  }
  return {
    current,
    latest,
    available: newer(latest, current),
    notes: rel.body,
    url: rel.html_url,
    asset: a ? { name: a.name, url: a.browser_download_url, size: a.size } : undefined,
    sumsUrl: sums?.browser_download_url,
    canInstall,
    reason,
  };
}

/** 내려받고 설치를 예약한 뒤 앱을 종료한다. onProgress(0~1) */
export async function installUpdate(info: UpdateInfo, onProgress: (p: number, msg: string) => void): Promise<void> {
  if (!info.asset || !info.canInstall) throw new Error(info.reason ?? '자동 설치를 할 수 없습니다');
  const dir = await mkdtemp(join(tmpdir(), 'droidlens-update-'));
  const file = join(dir, info.asset.name);

  // 다운로드 (진행률)
  const res = await fetch(info.asset.url, { headers: { 'User-Agent': 'DroidLens' } });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.asset.size;
  let got = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    got += c.length;
    onProgress(Math.min(got / total, 1), `다운로드 ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)}MB`);
  });
  await pipeline(body, createWriteStream(file));

  // 무결성 확인: 릴리스의 SHA256SUMS 와 대조 (없거나 다르면 설치하지 않는다)
  onProgress(1, '파일 확인 중…');
  if (!info.sumsUrl) throw new Error('릴리스에 SHA256SUMS 가 없어 파일을 확인할 수 없습니다');
  const sumsRes = await fetch(info.sumsUrl, { headers: { 'User-Agent': 'DroidLens' }, signal: AbortSignal.timeout(15_000) });
  if (!sumsRes.ok) throw new Error(`SHA256SUMS 를 받지 못했습니다 (${sumsRes.status})`);
  const expected = (await sumsRes.text())
    .split('\n')
    .map((l) => l.trim().split(/\s+\*?/))
    .find(([, n]) => n === info.asset!.name)?.[0];
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  if (!expected || expected.toLowerCase() !== actual) {
    await rm(dir, { recursive: true, force: true });
    throw new Error('내려받은 파일이 릴리스 체크섬과 다릅니다. 설치하지 않습니다');
  }

  if (process.platform === 'darwin') {
    onProgress(1, '압축 해제 중…');
    const unpacked = join(dir, 'unpacked');
    await run('ditto', ['-x', '-k', file, unpacked]);
    const newApp = join(unpacked, 'DroidLens.app');
    const target = macBundle();
    // 앱이 완전히 종료된 뒤 교체하고 다시 연다. 실패하면 기존 앱을 되돌린다.
    const log = join(app.getPath('home'), '.droidlens', 'update.log');
    const script = `#!/bin/sh
exec >>"${log}" 2>&1
echo "[$(date)] DroidLens 업데이트 ${info.current} -> ${info.latest}"
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
set -ex
mv "${target}" "${target}.old"
if ditto "${newApp}" "${target}"; then
  rm -rf "${target}.old"
else
  rm -rf "${target}"; mv "${target}.old" "${target}"
fi
xattr -dr com.apple.quarantine "${target}" 2>/dev/null || true
open "${target}"
rm -rf "${dir}"
`;
    const sh = join(dir, 'update.sh');
    await writeFile(sh, script);
    await chmod(sh, 0o755);
    spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
  } else if (process.platform === 'win32') {
    onProgress(1, '설치 프로그램 실행 중…');
    // 조용히 설치(/S)한 뒤 앱을 다시 실행(--force-run). 설치 파일이 실행 중인 앱 종료를 기다린다
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
  } else {
    onProgress(1, '교체 중…');
    const target = process.env.APPIMAGE!;
    await chmod(file, 0o755);
    const script = `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
mv -f "${file}" "${target}" && chmod +x "${target}"
nohup "${target}" >/dev/null 2>&1 &
`;
    const sh = join(dir, 'update.sh');
    await writeFile(sh, script);
    await chmod(sh, 0o755);
    spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
  }
  setTimeout(() => app.quit(), 300);
}

/**
 * 업데이트 뒤 새로 뜨는 앱에 개발·테스트용 환경 변수(DROIDLENS_FAKE_VERSION, DROIDLENS_UPDATE_SELFTEST 등)가
 * 넘어가지 않게 한다. macOS `open`은 호출한 셸의 환경을 새 앱에 넘기므로, 넘어가면 새 앱이 자기를 옛 버전으로
 * 착각해 업데이트를 반복한다.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DROIDLENS_') && k !== 'ELECTRON_RUN_AS_NODE'));
}

export async function cleanupOldUpdates(): Promise<void> {
  if (process.platform === 'darwin' && app.isPackaged) await rm(`${macBundle()}.old`, { recursive: true, force: true }).catch(() => undefined);
}
