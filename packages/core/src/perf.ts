import { DeviceAdb, isPackageProcess, quoteShell, sleep } from './adb.js';
import { assertPackage, launcherComponent } from './app.js';
import { pressKey } from './device.js';

/**
 * 성능 지표: 앱 시작 시간(am start -W), CPU(/proc), 메모리(dumpsys meminfo), 프레임(dumpsys gfxinfo).
 * 모두 adb 만으로 읽어 SDK 가 없는 앱에도 쓸 수 있다.
 */

// ---------- 시작 시간 ----------

export interface StartupRun {
  ms: number;
  /** COLD / WARM / HOT. 이미 떠 있던 태스크를 앞으로 가져오면 UNKNOWN 으로 나오는 기기가 많다 */
  launchState?: string;
  activity?: string;
}

export interface StartupResult {
  cold: boolean;
  runs: StartupRun[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export const MAX_STARTUP_RUNS = 10;

/** am start -W 출력 → 걸린 시간. 앞으로 가져오기만 하면 TotalTime 없이 WaitTime 만 나온다 */
export function parseStartup(out: string): StartupRun | undefined {
  const num = (k: string) => Number(new RegExp(`^${k}:\\s*(\\d+)`, 'm').exec(out)?.[1]);
  const ms = num('TotalTime') || num('WaitTime');
  if (!ms) return undefined;
  return {
    ms,
    launchState: /^LaunchState:\s*(\w+)/m.exec(out)?.[1],
    activity: /^Activity:\s*(\S+)/m.exec(out)?.[1],
  };
}

/**
 * 런처 아이콘을 누른 것과 같은 인텐트로 앱 시작 시간을 잰다.
 * cold(기본): 매번 강제 종료 후 실행. 아니면 프로세스를 살려 둔 채 홈으로 나갔다가 다시 연다
 */
export async function measureStartup(
  dev: DeviceAdb,
  pkg: string,
  opts: { cold?: boolean; runs?: number; signal?: AbortSignal } = {},
): Promise<StartupResult> {
  assertPackage(pkg);
  const cold = opts.cold ?? true;
  const count = Math.min(Math.max(Math.round(opts.runs ?? 3), 1), MAX_STARTUP_RUNS);
  const component = await launcherComponent(dev, pkg);
  if (!component) throw new Error(`${pkg}: 실행 가능한 런처 액티비티가 없습니다`);
  const start = async () => {
    const out = await dev.shell(
      `am start -W -f 0x10200000 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${quoteShell(component)}`,
      { timeoutMs: 30_000 },
    );
    if (/Error:/.test(out)) throw new Error(out.trim());
    return out;
  };
  if (!cold) {
    // 다시 열기를 재려면 프로세스가 떠 있어야 한다
    if (!(await dev.shell(`pidof ${pkg}`).catch(() => '')).trim()) {
      await start();
      await sleep(2000);
    }
  }
  const runs: StartupRun[] = [];
  for (let i = 0; i < count; i++) {
    if (opts.signal?.aborted) break;
    if (cold) {
      await dev.shell(`am force-stop ${pkg}`);
      await sleep(500);
    } else {
      await pressKey(dev, 'home');
      await sleep(800);
    }
    const out = await start();
    const run = parseStartup(out);
    if (!run) throw new Error(`시작 시간을 읽지 못했습니다:\n${out.trim()}`);
    runs.push(run);
    // 첫 화면이 그려진 뒤에도 초기화가 이어지므로 다음 측정 전에 잠깐 둔다
    if (i < count - 1) await sleep(1500);
  }
  if (!runs.length) throw new Error('측정을 중단했습니다');
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    cold,
    runs,
    medianMs: sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

// ---------- 메모리 ----------

/** dumpsys meminfo 의 App Summary (KB) */
export interface MemoryInfo {
  totalPssKb: number;
  totalRssKb?: number;
  javaHeapKb?: number;
  nativeHeapKb?: number;
  codeKb?: number;
  stackKb?: number;
  graphicsKb?: number;
  privateOtherKb?: number;
  systemKb?: number;
}

export function parseMeminfo(out: string): MemoryInfo | undefined {
  // Android 10 이전은 TOTAL:, 이후는 TOTAL PSS:
  const total = Number(/^\s*TOTAL(?: PSS)?:\s+(\d+)/m.exec(out)?.[1]);
  if (!total) return undefined;
  const summary = out.slice(out.indexOf('App Summary'));
  const row = (label: string) => {
    const v = new RegExp(`^\\s*${label}:\\s+(\\d+)`, 'm').exec(summary)?.[1];
    return v === undefined ? undefined : Number(v);
  };
  return {
    totalPssKb: total,
    totalRssKb: Number(/TOTAL RSS:\s+(\d+)/.exec(out)?.[1]) || undefined,
    javaHeapKb: row('Java Heap'),
    nativeHeapKb: row('Native Heap'),
    codeKb: row('Code'),
    stackKb: row('Stack'),
    graphicsKb: row('Graphics'),
    privateOtherKb: row('Private Other'),
    systemKb: row('System'),
  };
}

// ---------- 프레임 ----------

/** dumpsys gfxinfo 누적 통계 (앱 시작 또는 마지막 초기화 이후) */
export interface FrameStats {
  totalFrames: number;
  jankyFrames: number;
  jankPercent: number;
  p50Ms?: number;
  p90Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  missedVsync?: number;
  slowUiThread?: number;
}

/** 여러 프로세스가 있으면 pid 블록(없으면 첫 블록)만 읽는다 */
export function parseGfxinfo(out: string, pid?: number): FrameStats | undefined {
  const blocks = out.split(/^\*\* Graphics info for pid /m).slice(1);
  const block = (pid && blocks.find((b) => b.startsWith(`${pid} `))) || blocks[0] || out;
  const num = (label: string) => {
    const v = new RegExp(`^${label}:\\s*(\\d+)`, 'm').exec(block)?.[1];
    return v === undefined ? undefined : Number(v);
  };
  const totalFrames = num('Total frames rendered');
  if (totalFrames === undefined) return undefined;
  const jankyFrames = num('Janky frames') ?? 0;
  // 그린 프레임이 없으면 백분위가 히스토그램 끝값(4950ms)으로 나와 버린다
  const pct = (label: string) => (totalFrames ? num(label) : undefined);
  return {
    totalFrames,
    jankyFrames,
    jankPercent: totalFrames ? Math.round((jankyFrames / totalFrames) * 1000) / 10 : 0,
    p50Ms: pct('50th percentile'),
    p90Ms: pct('90th percentile'),
    p95Ms: pct('95th percentile'),
    p99Ms: pct('99th percentile'),
    missedVsync: num('Number Missed Vsync'),
    slowUiThread: num('Number Slow UI thread'),
  };
}

/** 프레임 누적 통계를 0으로 되돌린다. 특정 조작 구간만 재려면 그 전에 부른다 */
export async function resetFrameStats(dev: DeviceAdb, pkg: string): Promise<void> {
  assertPackage(pkg);
  await dev.shell(`dumpsys gfxinfo ${pkg} reset`);
}

// ---------- CPU ----------

/** 누적 CPU 시간 (jiffies). 두 표본의 차이로 사용률을 낸다 */
export interface CpuTicks {
  proc: number;
  total: number;
}

/** /proc/<pid>/stat 의 utime+stime 과 /proc/stat 첫 줄(cpu 전체)의 합 */
export function parseCpuTicks(procStat: string, sysStat: string): CpuTicks | undefined {
  // 프로세스 이름에 공백·괄호가 들어갈 수 있어 마지막 ')' 뒤부터 센다. 그 뒤 11·12번째가 utime·stime
  const rest = procStat.slice(procStat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const proc = Number(rest[11]) + Number(rest[12]);
  const m = /^cpu\s+([\d\s]+)/m.exec(sysStat);
  const total = m ? m[1].trim().split(/\s+/).reduce((s, v) => s + Number(v), 0) : NaN;
  return Number.isFinite(proc) && total > 0 ? { proc, total } : undefined;
}

/** 두 표본 사이 기기 전체 CPU 대비 앱 사용률(%). 표본이 맞지 않으면 undefined */
export function cpuPercent(prev: CpuTicks | undefined, cur: CpuTicks | undefined): number | undefined {
  if (!prev || !cur) return undefined;
  const dt = cur.total - prev.total;
  const dp = cur.proc - prev.proc;
  if (dt <= 0 || dp < 0) return undefined;
  return Math.round((dp / dt) * 1000) / 10;
}

// ---------- 표본 ----------

export interface PerfSample {
  /** 호스트 시각 (ms) */
  at: number;
  pid: number;
  cpu?: CpuTicks;
  /**
   * 덤프를 마친 뒤 다시 읽은 CPU. dumpsys 가 앱 프로세스를 깨워 CPU 를 쓰게 하므로,
   * 다음 표본과 비교할 때는 이것을 시작점으로 삼아 덤프 구간을 빼고 잰다
   */
  cpuAfter?: CpuTicks;
  memory?: MemoryInfo;
  frames?: FrameStats;
}

const MARK = '__DROIDLENS_PERF__';

/**
 * 앱 프로세스의 CPU·메모리·프레임을 셸 명령 한 번으로 읽는다. 앱이 떠 있지 않으면 undefined.
 * CPU 사용률은 표본 하나로는 낼 수 없어 이전 표본과 cpuPercent 로 비교한다
 */
export async function perfSample(
  dev: DeviceAdb,
  pkg: string,
  opts: { memory?: boolean; frames?: boolean; pid?: number } = {},
): Promise<PerfSample | undefined> {
  assertPackage(pkg);
  const memory = opts.memory ?? true;
  const frames = opts.frames ?? true;
  const dumps = memory || frames;
  const cpu = ['cat /proc/$1/stat', `echo ${MARK}`, 'head -1 /proc/stat', `echo ${MARK}`];
  const cmd = [
    opts.pid ? `set -- ${Math.trunc(opts.pid)}` : `set -- $(pidof ${pkg})`,
    '[ -n "$1" ] && [ -e /proc/$1 ] || exit 0',
    'echo "pids $*"',
    // 같은 이름의 프로세스가 여럿이면 덤프하지 않고 pid 만 알린다 (아래에서 맞는 pid 로 다시 부른다)
    '[ $# -eq 1 ] || exit 0',
    ...cpu,
    memory ? 'dumpsys meminfo $1' : 'true',
    `echo ${MARK}`,
    frames ? `dumpsys gfxinfo ${pkg}` : 'true',
    `echo ${MARK}`,
    ...(dumps ? cpu : []),
  ].join('; ');
  const out = await dev.shell(cmd, { timeoutMs: 15_000 });
  const pids = (/^pids (.*)$/m.exec(out)?.[1] ?? '').trim().split(/\s+/).map(Number).filter((n) => n > 0);
  if (!pids.length) return undefined;
  if (pids.length > 1 && !opts.pid) {
    // 같은 이름의 프로세스가 여럿이면(재시작 중이거나 다른 앱이 같은 이름을 쓴 경우) 그 패키지 uid 로 도는 것을 고른다
    for (const p of pids) if (await isPackageProcess(dev, pkg, p)) return perfSample(dev, pkg, { ...opts, pid: p });
    return undefined;
  }
  const pid = pids[0];
  const [procStat = '', sysStat = '', mem = '', gfx = '', procAfter = '', sysAfter = ''] = out.slice(out.indexOf('\n') + 1).split(MARK);
  return {
    at: Date.now(),
    pid,
    cpu: parseCpuTicks(procStat, sysStat),
    cpuAfter: dumps ? parseCpuTicks(procAfter, sysAfter) : undefined,
    memory: memory ? parseMeminfo(mem) : undefined,
    frames: frames ? parseGfxinfo(gfx, pid) : undefined,
  };
}

export interface PerfStats {
  pid: number;
  cpuPercent?: number;
  memory?: MemoryInfo;
  frames?: FrameStats;
}

/** 지금 상태 한 번 읽기: CPU 는 intervalMs(기본 1초) 사이의 사용률 */
export async function perfStats(dev: DeviceAdb, pkg: string, opts: { intervalMs?: number } = {}): Promise<PerfStats | undefined> {
  const first = await perfSample(dev, pkg);
  if (!first) return undefined;
  await sleep(opts.intervalMs ?? 1000);
  const second = await perfSample(dev, pkg, { memory: false, frames: false });
  return {
    pid: first.pid,
    // 그 사이 앱이 다시 시작됐으면 다른 프로세스라 비교하지 않는다
    cpuPercent: second?.pid === first.pid ? cpuPercent(first.cpuAfter ?? first.cpu, second.cpu) : undefined,
    memory: first.memory,
    frames: first.frames,
  };
}

export const kbToMb = (kb: number | undefined) => (kb === undefined ? undefined : Math.round((kb / 1024) * 10) / 10);
