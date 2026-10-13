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

export class AdbError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message);
    this.name = 'AdbError';
  }
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
      execFile(
        this.bin,
        args,
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 30_000 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = stderr?.toString().trim() || err.message;
            reject(new AdbError(`adb ${args.join(' ')} 실패: ${msg}`, args, stderr?.toString() ?? ''));
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
