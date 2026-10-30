import { Adb, DeviceAdb, quoteShell, sleep } from './adb.js';
import { withAgent } from './agent.js';

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

const sizeCache = new Map<string, { at: number; size: { width: number; height: number } }>();

/**
 * 지금 화면 크기 (회전 반영). getDeviceInfo 의 wm size 는 회전과 무관한 자연 크기라 가로 화면에서 스와이프 좌표가 화면 밖이 된다.
 * 논리 디스플레이 0 의 현재 크기(dumpsys window displays 의 cur=WxH)를 읽고, 스와이프마다 조회하지 않게 2초 캐시한다.
 * 읽지 못하면 자연 크기를 쓴다
 */
export async function screenSize(dev: DeviceAdb): Promise<{ width: number; height: number }> {
  const hit = sizeCache.get(dev.serial);
  if (hit && Date.now() - hit.at < 2000) return hit.size;
  const out = await dev.shell('dumpsys window displays | grep -E "mDisplayId=|cur="').catch(() => '');
  let display: string | undefined;
  let size: { width: number; height: number } | undefined;
  for (const line of out.split('\n')) {
    display = /mDisplayId=(\d+)/.exec(line)?.[1] ?? display;
    const m = display === '0' ? /\bcur=(\d+)x(\d+)/.exec(line) : null;
    if (m) {
      size = { width: Number(m[1]), height: Number(m[2]) };
      break;
    }
  }
  size ??= (await getDeviceInfo(dev)).screen;
  sizeCache.set(dev.serial, { at: Date.now(), size });
  return size;
}

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** screencap 이 다중 디스플레이 경고를 낸 기기 serial */
const multiDisplaySerials = new Set<string>();
/** serial → 논리 디스플레이 0 에 연결된 물리 디스플레이 id (스크린샷마다 dumpsys display 를 돌리지 않게 잠시 캐시) */
const displayIds = new Map<string, { at: number; id?: string }>();

/**
 * 논리 디스플레이 0(탭·입력·뷰 계층이 쓰는 화면)에 지금 연결된 물리 디스플레이.
 * 폴더블은 접고 펼 때 연결이 바뀌므로 5초만 캐시한다. 못 찾으면 undefined (-d 없이 찍는다)
 */
async function activeDisplayId(dev: DeviceAdb): Promise<string | undefined> {
  const hit = displayIds.get(dev.serial);
  if (hit && Date.now() - hit.at < 5000) return hit.id;
  const out = await dev
    .shell(`dumpsys display | grep -o "displayId=0, uniqueId='local:[0-9]*" | head -1 | grep -o '[0-9]*$'`)
    .catch(() => '');
  const id = /^\d+$/.test(out.trim()) ? out.trim() : undefined;
  displayIds.set(dev.serial, { at: Date.now(), id });
  return id;
}

/**
 * PNG 스크린샷. 디스플레이가 여럿인 기기(갤럭시 Z 플립·폴드의 커버 화면 등)는 screencap 이
 * "[Warning] Multiple displays were found..." 문구를 PNG 앞에 stdout 으로 내보낸다.
 * 시그니처 앞을 잘라내고, 그 기기는 다음부터 디스플레이를 지정해 찍는다
 */
export async function screenshot(dev: DeviceAdb): Promise<Buffer> {
  const id = multiDisplaySerials.has(dev.serial) ? await activeDisplayId(dev) : undefined;
  const out = await dev.execOut(id ? `screencap -p -d ${id}` : 'screencap -p', { timeoutMs: 30_000 });
  const start = out.indexOf(PNG_MAGIC);
  if (start <= 0) return out;
  multiDisplaySerials.add(dev.serial);
  return out.subarray(start);
}

// ---------- 입력 ----------

export async function tap(dev: DeviceAdb, x: number, y: number): Promise<void> {
  await dev.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
}

export async function longPress(dev: DeviceAdb, x: number, y: number, durationMs = 800): Promise<void> {
  const xi = Math.round(x);
  const yi = Math.round(y);
  await dev.shell(`input swipe ${xi} ${yi} ${xi} ${yi} ${Math.round(durationMs) || 800}`);
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
    `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs) || 300}`,
  );
}

/**
 * 포커스된 입력창에 텍스트를 이어서 입력한다.
 * 에이전트가 있으면 ACTION_SET_TEXT(유니코드 지원), 없으면 adb input text(ASCII만, 공백은 %s).
 */
export async function typeText(dev: DeviceAdb, text: string): Promise<void> {
  if (await withAgent(dev, (a) => a.setText(text, true))) return;
  if (/[^\x20-\x7e]/.test(text)) {
    throw new Error('온디바이스 에이전트 없이는 ASCII만 입력할 수 있습니다 (adb input text 제약).');
  }
  await dev.shell(`input text ${quoteShell(text.replace(/ /g, '%s'))}`);
}

/** 포커스된 입력창의 내용을 통째로 바꾼다 (에이전트 필요) */
export async function replaceText(dev: DeviceAdb, text: string): Promise<void> {
  if (!(await withAgent(dev, (a) => a.setText(text, false)))) throw new Error('텍스트 교체에는 온디바이스 에이전트가 필요합니다');
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
  if (opts.size) {
    // 기기 sh 가 다시 해석하는 인자라 형식을 확인한다
    if (!/^\d+x\d+$/.test(opts.size)) throw new Error(`잘못된 녹화 크기: ${opts.size} (예: 1280x720)`);
    args.push('--size', opts.size);
  }
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
  const [x1, y1, x2, y2] = swipeVector(await screenSize(dev), direction);
  await swipe(dev, x1, y1, x2, y2, durationMs);
}
