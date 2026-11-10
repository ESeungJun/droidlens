import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function configuredAdb(): string | undefined {
  try {
    const home = process.env.DROIDLENS_HOME ?? join(homedir(), '.droidlens');
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { adbPath?: string };
    return cfg.adbPath || undefined;
  } catch {
    return undefined;
  }
}

/** adb 후보 경로. 앞에서부터 존재하는 첫 파일을 쓴다 */
export function adbCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const sdkTools = (root: string | undefined) => root && join(root, 'platform-tools', exe);
  return [
    process.env.ADB_PATH,
    configuredAdb(),
    sdkTools(process.env.ANDROID_HOME),
    sdkTools(process.env.ANDROID_SDK_ROOT),
    sdkTools(join(homedir(), 'Library', 'Android', 'sdk')), // macOS Android Studio
    sdkTools(join(homedir(), 'Android', 'Sdk')), // Linux Android Studio
    process.env.LOCALAPPDATA && sdkTools(join(process.env.LOCALAPPDATA, 'Android', 'Sdk')), // Windows
    '/opt/homebrew/bin/adb', // brew (Apple Silicon) — GUI 앱은 셸 PATH를 물려받지 않는다
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  ].filter((p): p is string => !!p);
}

/** adb 실행 파일 위치: ADB_PATH > ~/.droidlens/config.json > ANDROID_HOME > 기본 SDK 경로 > brew > PATH */
export function findAdb(): string {
  return adbCandidates().find((p) => existsSync(p)) ?? 'adb';
}

/** adb 실패 원인. 원인별로 사용자가 할 일이 달라 메시지를 다르게 쓴다 */
export type AdbErrorKind = 'timeout' | 'unauthorized' | 'offline' | 'no-adb' | 'other';

export class AdbError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string, readonly kind: AdbErrorKind = 'other') {
    super(message);
    this.name = 'AdbError';
  }
}

/**
 * 오류 메시지에 넣을 명령: 앞 80자만. 입력한 글자(input text …)는 메시지에 싣지 않는다
 * (오류는 에이전트 응답·리포트로 나가므로 비밀번호가 따라가지 않게)
 */
export function describeAdbArgs(args: string[]): string {
  const cmd = args.join(' ').replace(/\binput text .*/s, 'input text …');
  return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
}

/**
 * adb 실패를 원인별로 나눠 다음에 할 일을 알려 주는 메시지로 바꾼다.
 * err: execFile 이 준 오류 (시간 초과면 killed, 실행 파일이 없으면 code ENOENT)
 */
export function describeAdbFailure(
  args: string[],
  stderr: string,
  err: { message: string; killed?: boolean; code?: unknown },
  timeoutMs: number,
): { kind: AdbErrorKind; message: string } {
  const cmd = describeAdbArgs(args);
  const serial = args[0] === '-s' ? args[1] : undefined;
  const who = serial ? `기기 ${serial}` : '기기';
  if (err.code === 'ENOENT') {
    return { kind: 'no-adb', message: 'adb 실행 파일을 찾지 못했습니다. Android platform-tools 를 설치하거나 ADB_PATH 로 경로를 지정하세요' };
  }
  // adb 자신이 낸 줄만 본다 (기기 셸 명령의 출력에 같은 말이 섞여도 연결 문제로 보지 않게)
  if (/^(?:adb: |error: )+device unauthorized/im.test(stderr)) {
    return { kind: 'unauthorized', message: `${who}가 이 PC 의 USB 디버깅을 허용하지 않았습니다. 기기 화면에서 "USB 디버깅 허용"을 누르세요` };
  }
  if (/^(?:adb: |error: )+(?:device offline|device '[^']*' not found|no devices\/emulators found|device still (?:connecting|authorizing))/im.test(stderr)) {
    return { kind: 'offline', message: `${who} 연결이 끊겼습니다. 케이블·에뮬레이터를 확인하고 devices 로 연결된 기기를 다시 보세요` };
  }
  if (err.killed) {
    return {
      kind: 'timeout',
      message: `adb ${cmd} 가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다. 기기가 응답하는지 devices 로 확인하세요`,
    };
  }
  // stderr 가 비면 execFile 의 메시지("Command failed: <명령 전체>")뿐이라 명령만 두 번 나온다. 종료 코드만 남긴다
  const detail = stderr.trim() || (typeof err.code === 'number' ? `종료 코드 ${err.code}` : err.message.split('\n')[0].slice(0, 200));
  return { kind: 'other', message: `adb ${cmd} 실패: ${detail}` };
}

export interface RunOptions {
  timeoutMs?: number;
}

export class Adb {
  readonly bin: string;

  constructor(bin = findAdb()) {
    this.bin = bin;
  }

  /** adb 명령 실행 후 stdout을 Buffer로 반환 */
  raw(args: string[], opts: RunOptions = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      execFile(
        this.bin,
        args,
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (err) {
            const text = stderr?.toString() ?? '';
            const f = describeAdbFailure(args, text, err, timeoutMs);
            reject(new AdbError(f.message, args, text, f.kind));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async text(args: string[], opts?: RunOptions): Promise<string> {
    return (await this.raw(args, opts)).toString('utf8');
  }

  /** 특정 기기 대상 명령 */
  device(serial: string): DeviceAdb {
    return new DeviceAdb(this, serial);
  }

  spawn(args: string[]): ChildProcess {
    return spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** adb 사용 가능 여부와 버전 */
  async version(): Promise<{ ok: boolean; path: string; version?: string; error?: string }> {
    try {
      const out = await this.text(['version'], { timeoutMs: 5000 });
      return { ok: true, path: this.bin, version: /version ([\d.]+)/.exec(out)?.[1] };
    } catch (e) {
      return { ok: false, path: this.bin, error: (e as Error).message };
    }
  }
}

export class DeviceAdb {
  constructor(readonly adb: Adb, readonly serial: string) {}

  raw(args: string[], opts?: RunOptions): Promise<Buffer> {
    return this.adb.raw(['-s', this.serial, ...args], opts);
  }

  text(args: string[], opts?: RunOptions): Promise<string> {
    return this.adb.text(['-s', this.serial, ...args], opts);
  }

  /** adb shell 명령. 인자는 기기 쪽 sh가 다시 해석하므로 호출부에서 quoteShell로 감싼다 */
  shell(command: string, opts?: RunOptions): Promise<string> {
    return this.text(['shell', command], opts);
  }

  execOut(command: string, opts?: RunOptions): Promise<Buffer> {
    return this.raw(['exec-out', command], opts);
  }

  spawn(args: string[]): ChildProcess {
    return this.adb.spawn(['-s', this.serial, ...args]);
  }

  /** 호스트 tcp 포트 → 기기 remote(예: localabstract:name) 포워딩. 이미 걸려 있으면 그 포트를 재사용 */
  async forward(remote: string): Promise<number> {
    const list = await this.adb.text(['forward', '--list']).catch(() => '');
    const existing = list
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([s, , r]) => s === this.serial && r === remote);
    if (existing) return Number(existing[1].replace('tcp:', ''));
    return Number((await this.text(['forward', 'tcp:0', remote])).trim());
  }
}

/** 기기 sh에 넘길 인자를 작은따옴표로 감싼다 */
export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** serial|패키지 → 패키지 uid */
const packageUids = new Map<string, number>();

/** 여러 사용자(user 10 등)에서는 같은 앱도 사용자마다 uid 가 달라 앱 id(uid % 100000)로 비교한다 */
const appId = (uid: number) => uid % 100_000;

/**
 * pid 프로세스가 그 패키지의 uid 로 도는지. 프로세스 이름(pidof)은 앱이 매니페스트 android:process 로
 * 아무렇게나 지을 수 있어 믿지 않는다 (uid 는 같은 서명의 앱끼리만 나눠 쓸 수 있다).
 * 프로세스 uid 와 패키지 uid 를 셸 명령 한 번으로 읽고, 패키지 uid 는 캐시해 다음부터는 프로세스 uid 만 읽는다
 */
export async function isPackageProcess(dev: DeviceAdb, pkg: string, pid: number): Promise<boolean> {
  if (!/^[\w.]+$/.test(pkg) || !Number.isInteger(pid) || pid <= 0) return false;
  const key = `${dev.serial}|${pkg}`;
  const check = async (lookup: boolean) => {
    // cmd package list packages -U 가 없는 예전 기기는 dumpsys 의 userId=(최근 버전은 appId=)로 대신한다
    const pkgCmd = `cmd package list packages -U ${pkg} 2>/dev/null | grep -F 'package:${pkg} uid:' || dumpsys package ${pkg} | grep -m1 -E 'userId=|appId='`;
    const out = await dev.shell(`stat -c %u /proc/${pid} 2>/dev/null${lookup ? `; echo '--'; ${pkgCmd}` : ''}`).catch(() => '');
    const [proc, info = ''] = out.split('--');
    if (lookup) {
      const uid = Number(/(?:uid:|userId=|appId=)(\d+)/.exec(info)?.[1]);
      if (uid > 0) packageUids.set(key, uid);
      else packageUids.delete(key);
    }
    const procUid = /^\s*(\d+)\s*$/.exec(proc)?.[1];
    const pkgUid = packageUids.get(key);
    return procUid !== undefined && pkgUid !== undefined && appId(Number(procUid)) === appId(pkgUid);
  };
  // 캐시와 맞지 않으면 앱을 다시 설치해 uid 가 바뀌었을 수 있어 한 번 새로 읽는다
  return (packageUids.has(key) && (await check(false))) || check(true);
}
