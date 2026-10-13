import { Adb, DeviceAdb, quoteShell, sleep } from './adb.js';
import { ensureAgent } from './agent.js';

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
  return dev.execOut('screencap -p', { timeoutMs: 30_000 });
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

/**
 * 포커스된 입력창에 텍스트를 이어서 입력한다.
 * 에이전트가 있으면 ACTION_SET_TEXT(유니코드 지원), 없으면 adb input text(ASCII만, 공백은 %s).
 */
export async function typeText(dev: DeviceAdb, text: string): Promise<void> {
  const agent = await ensureAgent(dev);
  if (agent) {
    await agent.setText(text, true);
    return;
  }
  if (/[^\x20-\x7e]/.test(text)) {
    throw new Error('온디바이스 에이전트 없이는 ASCII만 입력할 수 있습니다 (adb input text 제약).');
  }
  await dev.shell(`input text ${quoteShell(text.replace(/ /g, '%s'))}`);
}

/** 포커스된 입력창의 내용을 통째로 바꾼다 (에이전트 필요) */
export async function replaceText(dev: DeviceAdb, text: string): Promise<void> {
  const agent = await ensureAgent(dev);
  if (!agent) throw new Error('텍스트 교체에는 온디바이스 에이전트가 필요합니다');
  await agent.setText(text, false);
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

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

/**
 * 손가락 이동 방향 기준 스와이프 좌표 (화면 중앙에서 세로 60% / 가로 70% 이동).
 * up = 손가락을 위로 = 내용이 아래로 스크롤.
 */
export function swipeVector(screen: { width: number; height: number }, direction: SwipeDirection): [number, number, number, number] {
  const cx = screen.width / 2;
  const cy = screen.height / 2;
  const dx = screen.width * 0.35;
  const dy = screen.height * 0.3;
  switch (direction) {
    case 'up':
      return [cx, cy + dy, cx, cy - dy];
    case 'down':
      return [cx, cy - dy, cx, cy + dy];
    case 'left':
      return [cx + dx, cy, cx - dx, cy];
    case 'right':
      return [cx - dx, cy, cx + dx, cy];
  }
}

export async function swipeDirection(dev: DeviceAdb, direction: SwipeDirection, durationMs?: number): Promise<void> {
  const { screen } = await getDeviceInfo(dev);
  const [x1, y1, x2, y2] = swipeVector(screen, direction);
  await swipe(dev, x1, y1, x2, y2, durationMs);
}
