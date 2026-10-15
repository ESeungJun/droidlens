import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sleep, type Adb } from './adb.js';
import { listDevices } from './device.js';
import { ensureDir } from './workspace.js';

/**
 * 이 컴퓨터의 Android 가상 기기(AVD) 실행·종료. AVD 만들기는 기기 연결 도우미(설치 안내)가 맡고,
 * 여기서는 이미 만든 AVD 를 폰처럼 고르고 띄우는 것만 한다.
 */

export interface Avd {
  name: string;
  /** 실행 중이면 adb 시리얼 (emulator-5554 등) */
  serial?: string;
}

/** AVD 이름 (avdmanager 가 허용하는 글자). 명령 인자로만 넘기지만 이상한 값은 처음부터 받지 않는다 */
const AVD_NAME = /^[\w.-]{1,100}$/;

/** emulator 실행 파일 위치. adb 와 같은 SDK 를 먼저 보고, 없으면 흔한 SDK 경로를 본다 */
export function findEmulator(adb: Adb): string | undefined {
  const exe = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  const roots = [
    // adb 가 <sdk>/platform-tools/adb 이면 같은 SDK 의 emulator
    dirname(dirname(adb.bin)),
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ];
  return roots.filter((r): r is string => !!r).map((r) => join(r, 'emulator', exe)).find((p) => existsSync(p));
}

function run(bin: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => (err ? reject(new Error(stderr.toString().trim() || err.message)) : resolve(stdout.toString()))),
  );
}

/** 실행 중인 에뮬레이터의 AVD 이름 → adb 시리얼 */
async function runningAvds(adb: Adb): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of await listDevices(adb)) {
    if (!d.emulator || d.state !== 'device') continue;
    const name = (await adb.text(['-s', d.serial, 'emu', 'avd', 'name'], { timeoutMs: 5000 }).catch(() => '')).split(/\r?\n/)[0].trim();
    if (name) out.set(name, d.serial);
  }
  return out;
}

/** 이 컴퓨터의 AVD 목록과 실행 여부. emulator 가 없으면 available=false */
export async function listAvds(adb: Adb): Promise<{ available: boolean; avds: Avd[] }> {
  const bin = findEmulator(adb);
  if (!bin) return { available: false, avds: [] };
  // -list-avds 는 경고(INFO·WARNING 줄)를 섞어 내보내기도 해서 이름 형식인 줄만 받는다
  const names = (await run(bin, ['-list-avds']).catch(() => ''))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => AVD_NAME.test(l));
  const running = await runningAvds(adb);
  return { available: true, avds: names.map((name) => ({ name, serial: running.get(name) })) };
}

/**
 * AVD 를 띄우고 부팅이 끝날 때까지 기다려 adb 시리얼을 돌려준다. 이미 떠 있으면 그 시리얼.
 * 에뮬레이터는 DroidLens 와 따로 계속 돌도록 분리해서 띄운다 (앱을 닫아도 꺼지지 않음).
 */
export async function startAvd(adb: Adb, name: string, opts: { timeoutMs?: number; onProgress?: (m: string) => void } = {}): Promise<string> {
  if (!AVD_NAME.test(name)) throw new Error(`잘못된 AVD 이름: ${name}`);
  const bin = findEmulator(adb);
  if (!bin) throw new Error('Android 에뮬레이터를 찾지 못했습니다. 기기 연결 도우미로 먼저 설치하세요');
  const already = (await runningAvds(adb)).get(name);
  if (already) return already;

  const log = join(await ensureDir('emulator'), `${name}.log`);
  const out = openSync(log, 'w');
  const child = spawn(bin, ['-avd', name], { detached: true, stdio: ['ignore', out, out] });
  closeSync(out); // 자식이 복제해 가졌으니 이쪽 핸들은 닫는다
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));
  child.on('error', () => (exited = -1));
  child.unref();
  opts.onProgress?.(`${name} 실행 중…`);

  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let serial: string | undefined;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (exited !== undefined) {
      const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-3).join(' / ');
      throw new Error(`에뮬레이터가 시작하지 못하고 종료됐습니다${tail ? `: ${tail}` : ''}`);
    }
    serial ??= (await runningAvds(adb).catch(() => new Map<string, string>())).get(name);
    if (!serial) continue;
    const booted = (await adb.text(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 5000 }).catch(() => '')).trim();
    if (booted === '1') {
      opts.onProgress?.(`${name} 부팅 완료 (${serial})`);
      return serial;
    }
    opts.onProgress?.(`${name} 부팅 중…`);
  }
  throw new Error(`${Math.round((opts.timeoutMs ?? 180_000) / 1000)}초 안에 부팅이 끝나지 않았습니다. 에뮬레이터 창을 확인하세요`);
}

/** 실행 중인 에뮬레이터 종료 */
export async function stopAvd(adb: Adb, serial: string): Promise<void> {
  if (!/^emulator-\d+$/.test(serial)) throw new Error('에뮬레이터가 아닙니다');
  await adb.text(['-s', serial, 'emu', 'kill'], { timeoutMs: 10_000 });
}
