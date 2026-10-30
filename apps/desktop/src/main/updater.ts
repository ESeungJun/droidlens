import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, chmod, constants, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { quoteShell as shq } from '@droidlens/core';
import { buildFromDelta, parseBlockMap, planDelta, type BlockMap } from './delta';

/**
 * GitHub Releases 기반 자체 업데이트.
 * 처음에 macOS 앱이 임시(ad-hoc) 서명만 되어 있어 Squirrel(electron-updater)을 쓸 수 없었으므로 플랫폼별로 직접 교체한다.
 * 받은 파일은 릴리스의 SHA256SUMS 와 대조해 다르면 설치하지 않는다.
 * 가능하면 달라진 조각만 받는다 (delta.ts). 이전 파일은 macOS·Windows 는 지난번에 받아 둔 설치 파일(update-cache),
 * Linux 는 지금 실행 중인 AppImage 다. 처음이거나 조각 정보가 없으면 전체를 받는다.
 *  - macOS: zip을 받아 풀고, 앱이 종료되면 번들을 교체한 뒤 다시 연다 (분리된 셸 스크립트)
 *  - Windows: NSIS 설치 파일을 조용히(/S) 실행하고 설치 후 자동 실행(--force-run)
 *  - Linux: AppImage 파일을 바꾸고 다시 실행
 */

const REPO = 'ESeungJun/droidlens';
const run = promisify(execFile);
/** 다운로드가 이 시간 동안 한 바이트도 진행되지 않으면 끊는다 (무응답이면 진행률이 영원히 멈춰 있지 않게) */
const STALL_MS = 30_000;
/** 부분 다운로드할 양이 전체의 이 비율을 넘으면 전체를 받는다 (요청 수만 늘고 이득이 적다) */
const DELTA_MAX_RATIO = 0.6;
const UA = { 'User-Agent': 'DroidLens' };

const writable = (p: string) => access(p, constants.W_OK).then(
  () => true,
  () => false,
);

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

/** 교체할 앱 파일(번들)과 그 폴더에 쓸 수 있는지. Windows 는 설치 프로그램이 권한을 따로 다루므로 보지 않는다 */
async function installTargetWritable(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const target = macBundle();
    return (await writable(dirname(target))) && (await writable(target));
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) return writable(dirname(process.env.APPIMAGE));
  return true;
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
  const page = await fetch(`https://github.com/${REPO}/releases/latest`, { headers: UA, signal: AbortSignal.timeout(15_000) });
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
  // 버전은 파일 이름과 설치 스크립트에 들어가므로 형식이 다른 태그는 받지 않는다
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(latest)) throw new Error('업데이트 확인 실패 (릴리스 버전 형식이 올바르지 않습니다)');
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
  } else if (process.platform === 'darwin' && macBundle().includes('/AppTranslocation/')) {
    // 다운로드 폴더에서 바로 연 앱은 macOS 가 읽기 전용 임시 위치(App Translocation)에서 실행하므로 교체할 수 없다
    canInstall = false;
    reason = '앱이 macOS 임시 위치에서 실행 중이라 자동 업데이트를 할 수 없습니다. DroidLens 를 응용 프로그램 폴더로 옮긴 뒤 다시 여세요';
  } else if (!(await installTargetWritable())) {
    canInstall = false;
    reason = '앱이 있는 폴더에 쓸 권한이 없어 자동 업데이트를 할 수 없습니다';
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

/** 진행률을 알리며 내려받는다. STALL_MS 동안 받은 바이트가 없으면 끊는다 */
async function download(url: string, file: string, size: number, onProgress: (p: number, msg: string) => void): Promise<void> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), STALL_MS);
  };
  kick();
  try {
    const res = await fetch(url, { headers: UA, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
    const total = Number(res.headers.get('content-length')) || size;
    let got = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (c: Buffer) => {
      kick();
      got += c.length;
      onProgress(total ? Math.min(got / total, 1) : 0, `다운로드 ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)}MB`);
    });
    await pipeline(body, createWriteStream(file));
  } catch (e) {
    if (ac.signal.aborted) throw new Error('다운로드가 30초 동안 진행되지 않아 중단했습니다');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function expectedSum(info: UpdateInfo, name: string): Promise<string> {
  if (!info.sumsUrl) throw new Error('릴리스에 SHA256SUMS 가 없어 파일을 확인할 수 없습니다');
  const sums = await fetchBuffer(info.sumsUrl).catch((e: Error) => {
    throw new Error(`SHA256SUMS 를 받지 못했습니다 (${e.message})`);
  });
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+\*?/))
    .find(([, n]) => n === name)?.[0];
  if (!expected) throw new Error(`SHA256SUMS 에 ${name} 이 없어 파일을 확인할 수 없습니다`);
  return expected.toLowerCase();
}

/** 지난번에 받은 설치 파일과 그 조각 정보를 두는 곳 (macOS·Windows) */
const deltaDir = () => join(app.getPath('userData'), 'update-cache');

/** 조각을 재사용할 이전 파일. 없으면 undefined (전체 다운로드) */
async function deltaBase(): Promise<{ file: string; map: BlockMap } | undefined> {
  if (process.platform === 'linux') {
    const file = process.env.APPIMAGE;
    const name = assetName(app.getVersion(), 'x64');
    if (!file || !name) return undefined;
    // 지금 AppImage 의 조각 정보는 이 버전 릴리스에 있다 (부분 업데이트를 넣기 전 버전에는 없다)
    const map = await fetchBuffer(`https://github.com/${REPO}/releases/download/v${app.getVersion()}/${name}.blockmap`).catch(() => undefined);
    return map ? { file, map: parseBlockMap(map) } : undefined;
  }
  const file = join(deltaDir(), 'base');
  const map = await readFile(`${file}.blockmap`).catch(() => undefined);
  return map ? { file, map: parseBlockMap(map) } : undefined;
}

async function saveDeltaBase(file: string, map: Buffer): Promise<void> {
  const dir = deltaDir();
  await mkdir(dir, { recursive: true });
  const base = join(dir, 'base');
  // 파일과 조각 정보가 어긋나지 않게 조각 정보를 먼저 지우고, 파일을 바꾼 뒤 다시 쓴다
  await rm(`${base}.blockmap`, { force: true });
  await copyFile(file, `${base}.tmp`);
  await rename(`${base}.tmp`, base);
  await writeFile(`${base}.blockmap`, map);
}

/**
 * 달라진 조각만 받아 file 을 만든다. 체크섬까지 맞으면 true, 할 수 없거나 실패하면 false (그때는 전체를 받는다)
 */
async function tryDelta(
  asset: NonNullable<UpdateInfo['asset']>,
  mapGz: Buffer,
  file: string,
  expected: string,
  onProgress: (p: number, msg: string) => void,
): Promise<boolean> {
  try {
    const base = await deltaBase();
    if (!base) return false;
    const plan = planDelta(base.map, parseBlockMap(mapGz));
    if (plan.download > plan.total * DELTA_MAX_RATIO) return false;
    const mb = (n: number) => (n / 1048576).toFixed(1);
    onProgress(0, `부분 다운로드 0 / ${mb(plan.download)}MB (전체 ${mb(plan.total)}MB)`);
    await buildFromDelta(plan, base.file, asset.url, file, {
      headers: UA,
      signal: AbortSignal.timeout(5 * 60_000),
      onBytes: (got) => onProgress(got / plan.download, `부분 다운로드 ${mb(got)} / ${mb(plan.download)}MB (전체 ${mb(plan.total)}MB)`),
    });
    onProgress(1, '파일 확인 중…');
    if ((await sha256(file)) === expected) return true;
    console.warn('부분 다운로드로 만든 파일의 체크섬이 달라 전체를 다시 받습니다');
  } catch (e) {
    console.warn('부분 다운로드 실패, 전체를 받습니다', e);
  }
  await rm(file, { force: true }).catch(() => undefined);
  return false;
}

/**
 * 내려받고 설치를 예약한 뒤 앱을 종료한다. onProgress(0~1)
 * 실패하면 임시 폴더를 지우고 에러를 던진다. 실행 중인 서비스(로그·미러·대화)는 여기서 멈추지 않고
 * 설치를 예약한 뒤 app.quit() 이 거치는 종료 정리(will-quit)에서 멈춘다 (다운로드가 실패해도 쓰던 기능이 꺼지지 않게)
 */
export async function installUpdate(info: UpdateInfo, onProgress: (p: number, msg: string) => void): Promise<void> {
  if (!info.asset || !info.canInstall) throw new Error(info.reason ?? '자동 설치를 할 수 없습니다');
  const dir = await mkdtemp(join(tmpdir(), 'droidlens-update-'));
  try {
    await prepareAndLaunch(info, info.asset, dir, onProgress);
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  setTimeout(() => app.quit(), 300);
}

/** 내려받아 확인하고, 앱이 끝나면 교체할 설치 단계를 분리된 프로세스로 띄운다 */
async function prepareAndLaunch(
  info: UpdateInfo,
  asset: NonNullable<UpdateInfo['asset']>,
  dir: string,
  onProgress: (p: number, msg: string) => void,
): Promise<void> {
  const file = join(dir, asset.name);
  // 무결성 확인: 릴리스의 SHA256SUMS 와 대조 (없거나 다르면 설치하지 않는다)
  const expected = await expectedSum(info, asset.name);
  const map = await fetchBuffer(`${asset.url}.blockmap`).catch(() => undefined);
  const viaDelta = map ? await tryDelta(asset, map, file, expected, onProgress) : false;
  if (!viaDelta) {
    await download(asset.url, file, asset.size, onProgress);
    onProgress(1, '파일 확인 중…');
    if ((await sha256(file)) !== expected) throw new Error('내려받은 파일이 릴리스 체크섬과 다릅니다. 설치하지 않습니다');
  }
  // 다음 업데이트에서 이전 파일로 쓰도록 남긴다 (Linux 는 설치된 AppImage 가 그 역할을 한다)
  if (map && process.platform !== 'linux') await saveDeltaBase(file, map).catch((e) => console.warn('업데이트 파일 보관 실패', e));

  if (process.platform === 'darwin') {
    onProgress(1, '압축 해제 중…');
    const unpacked = join(dir, 'unpacked');
    await run('ditto', ['-x', '-k', file, unpacked]);
    const newApp = join(unpacked, 'DroidLens.app');
    const target = macBundle();
    const old = `${target}.old`;
    // 앱이 완전히 종료된 뒤 교체하고 다시 연다. 기존 앱을 못 옮기거나 복사에 실패해도 그 자리의 앱
    // (새 앱 또는 되돌린 기존 앱)을 마지막에 반드시 다시 열도록 set -e 를 쓰지 않는다
    const log = join(app.getPath('home'), '.droidlens', 'update.log');
    await mkdir(dirname(log), { recursive: true });
    const script = `#!/bin/sh
exec >>${shq(log)} 2>&1
echo "[$(date)]" ${shq(`DroidLens 업데이트 ${info.current} -> ${info.latest}`)}
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
set -x
if mv ${shq(target)} ${shq(old)}; then
  if ditto ${shq(newApp)} ${shq(target)}; then
    rm -rf ${shq(old)}
  else
    rm -rf ${shq(target)}; mv ${shq(old)} ${shq(target)}
  fi
else
  echo "기존 앱을 옮기지 못해 업데이트를 건너뜁니다"
fi
xattr -dr com.apple.quarantine ${shq(target)} 2>/dev/null || true
open ${shq(target)}
rm -rf ${shq(dir)}
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
    // 교체에 실패해도 그 자리의 기존 파일로 다시 띄운다
    const script = `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
mv -f ${shq(file)} ${shq(target)} && chmod +x ${shq(target)}
nohup ${shq(target)} >/dev/null 2>&1 &
rm -rf ${shq(dir)}
`;
    const sh = join(dir, 'update.sh');
    await writeFile(sh, script);
    await chmod(sh, 0o755);
    spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
  }
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
