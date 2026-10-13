import { Adb, DeviceAdb, quoteShell, sleep } from './adb.js';

export interface DeviceSummary {
  serial: string;
  state: string; // device | offline | unauthorized ...
  model?: string;
  product?: string;
  transportId?: string;
  emulator: boolean;
}

export interface DeviceInfo {
  serial: string;
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdk: number;
  abi: string;
  screen: { width: number; height: number; density: number };
}

export async function listDevices(adb: Adb): Promise<DeviceSummary[]> {
  const out = await adb.text(['devices', '-l']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const kv = Object.fromEntries(
        rest.filter((t) => t.includes(':')).map((t) => t.split(':') as [string, string]),
      );
      return {
        serial,
        state,
        model: kv.model,
        product: kv.product,
        transportId: kv.transport_id,
        emulator: serial.startsWith('emulator-'),
      };
    });
}

export async function getDeviceInfo(dev: DeviceAdb): Promise<DeviceInfo> {
  const props = await dev.shell(
    'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi; wm size; wm density',
  );
  const lines = props.split('\n').map((l) => l.trim());
  const size = /(\d+)x(\d+)/.exec(lines.filter((l) => l.includes('size')).pop() ?? '') ?? [];
  const density = /(\d+)/.exec(lines.filter((l) => l.includes('density')).pop() ?? '') ?? [];
  return {
    serial: dev.serial,
    manufacturer: lines[0] ?? '',
    model: lines[1] ?? '',
    androidVersion: lines[2] ?? '',
    sdk: Number(lines[3]) || 0,
    abi: lines[4] ?? '',
    screen: { width: Number(size[1]) || 0, height: Number(size[2]) || 0, density: Number(density[1]) || 0 },
  };
}

/** PNG 스크린샷 */
export async function screenshot(dev: DeviceAdb): Promise<Buffer> {
  return dev.execOut('screencap -p', { timeoutMs: 15_000 });
}

// ---------- 입력 ----------

export async function tap(dev: DeviceAdb, x: number, y: number): Promise<void> {
  await dev.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
}

export async function longPress(dev: DeviceAdb, x: number, y: number, durationMs = 800): Promise<void> {
  const xi = Math.round(x);
  const yi = Math.round(y);
  await dev.shell(`input swipe ${xi} ${yi} ${xi} ${yi} ${durationMs}`);
}

export async function swipe(
  dev: DeviceAdb,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 300,
): Promise<void> {
  await dev.shell(
    `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${durationMs}`,
  );
}

/** input text는 공백을 %s로 받아야 하고 한글 등 비ASCII는 지원하지 않는다 */
export async function typeText(dev: DeviceAdb, text: string): Promise<void> {
  if (/[^\x20-\x7e]/.test(text)) {
    throw new Error('adb input text는 ASCII만 지원합니다. 한글 입력은 ADBKeyboard 같은 IME가 필요합니다.');
  }
  await dev.shell(`input text ${quoteShell(text.replace(/ /g, '%s'))}`);
}

export const KEYCODES = {
  back: 4,
  home: 3,
  menu: 82,
  enter: 66,
  delete: 67,
  recents: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  tab: 61,
  escape: 111,
} as const;

export async function pressKey(dev: DeviceAdb, key: keyof typeof KEYCODES | number): Promise<void> {
  const code = typeof key === 'number' ? key : KEYCODES[key];
  await dev.shell(`input keyevent ${code}`);
}

// ---------- 화면 녹화 ----------

export interface Recording {
  remotePath: string;
  startedAt: number;
  stop(localPath: string): Promise<string>;
}

/** screenrecord는 최대 180초. stop 시 기기 쪽 프로세스에 SIGINT를 보내 mp4를 정상 종료시킨 뒤 pull */
export function startRecording(
  dev: DeviceAdb,
  opts: { maxSeconds?: number; bitRateMbps?: number; size?: string } = {},
): Recording {
  const remotePath = `/sdcard/droidlens_${Date.now()}.mp4`;
  const args = ['shell', 'screenrecord', '--time-limit', String(Math.min(opts.maxSeconds ?? 180, 180))];
  if (opts.bitRateMbps) args.push('--bit-rate', String(opts.bitRateMbps * 1_000_000));
  if (opts.size) args.push('--size', opts.size);
  args.push(remotePath);
  const proc = dev.spawn(args);
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  return {
    remotePath,
    startedAt: Date.now(),
    async stop(localPath: string) {
      await dev.shell('pkill -INT screenrecord').catch(() => undefined);
      await Promise.race([exited, sleep(5000)]);
      proc.kill();
      await sleep(500); // mp4 moov atom 기록 대기
      await dev.raw(['pull', remotePath, localPath], { timeoutMs: 120_000 });
      await dev.shell(`rm -f ${remotePath}`).catch(() => undefined);
      return localPath;
    },
  };
}
