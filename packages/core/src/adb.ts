import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** adb 실행 파일 위치: ADB_PATH > ANDROID_HOME/ANDROID_SDK_ROOT > macOS 기본 SDK > PATH */
export function findAdb(): string {
  const candidates = [
    process.env.ADB_PATH,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? 'adb';
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
}

/** 기기 sh에 넘길 인자를 작은따옴표로 감싼다 */
export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
