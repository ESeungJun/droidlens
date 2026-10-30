import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { DeviceAdb, quoteShell } from './adb.js';
import { agentFor } from './agent.js';

const PKG_RE = /^[a-zA-Z][\w]*(\.[\w]+)+$/;

export function assertPackage(pkg: string): void {
  if (!PKG_RE.test(pkg)) throw new Error(`잘못된 패키지 이름: ${pkg}`);
}

export interface CurrentScreen {
  packageName: string;
  activity: string;
  /** dumpsys activity top에서 읽은 현재 표시 중인 Fragment 이름들 (best-effort) */
  fragments: string[];
  windowTitle?: string;
}

/**
 * 현재 화면의 패키지/Activity/Fragment.
 * Fragment 조회(dumpsys activity top)는 기기에 따라 1~7초가 걸리므로 opts.fragments=true일 때만 한다.
 * 에이전트가 있으면 Activity를 접근성 이벤트로 즉시 얻는다.
 */
export async function currentScreen(dev: DeviceAdb, opts: { fragments?: boolean } = {}): Promise<CurrentScreen> {
  const agent = agentFor(dev.serial);
  if (agent) {
    const st = await agent.state().catch(() => undefined);
    if (st?.package && st.activity) {
      const fragments = opts.fragments ? await topFragments(dev).catch(() => []) : [];
      return { packageName: st.package, activity: st.activity, fragments, windowTitle: st.lastWindowClass };
    }
  }
  const win = await dev.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
  const m =
    /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([\w.]+)\/([\w.$]+)\}/.exec(win) ??
    /ActivityRecord\{[^ ]+ [^ ]+ ([\w.]+)\/([\w.$]+)/.exec(win);
  const packageName = m?.[1] ?? '';
  let activity = m?.[2] ?? '';
  if (activity.startsWith('.')) activity = packageName + activity;
  const fragments = packageName && opts.fragments ? await topFragments(dev).catch(() => []) : [];
  return { packageName, activity, fragments, windowTitle: /mCurrentFocus=Window\{[^}]*\}/.exec(win)?.[0] };
}

/** dumpsys activity top의 FragmentManager 덤프에서 Added Fragments를 추출 */
export async function topFragments(dev: DeviceAdb): Promise<string[]> {
  const out = await dev.shell('dumpsys activity top', { timeoutMs: 10_000 });
  // 마지막 TASK 블록이 최상위 액티비티
  const lastTask = out.split(/\nTASK /).pop() ?? out;
  const names = new Set<string>();
  const re = /^\s*#\d+: (\w[\w$.]*)\{[0-9a-f]+\}? ?(?:\([^)]*\))?/gm;
  let inAdded = false;
  for (const line of lastTask.split('\n')) {
    if (/Added Fragments:/.test(line)) {
      inAdded = true;
      continue;
    }
    if (inAdded) {
      re.lastIndex = 0;
      const mm = re.exec(line);
      if (mm) {
        if (!/^(SupportRequestManagerFragment|ReportFragment|NavHostFragment)$/.test(mm[1])) names.add(mm[1]);
      } else if (line.trim() && !/^\s+/.test(line)) {
        inAdded = false;
      } else if (/Back Stack|Fragments Created|FragmentManager/.test(line)) {
        inAdded = false;
      }
    }
  }
  return [...names];
}

export interface PackageSummary {
  packageName: string;
  apkPath?: string;
  system: boolean;
}

export async function listPackages(dev: DeviceAdb, opts: { thirdPartyOnly?: boolean } = {}): Promise<PackageSummary[]> {
  const out = await dev.shell(`pm list packages -f ${opts.thirdPartyOnly ? '-3' : ''}`);
  const third = opts.thirdPartyOnly
    ? null
    : new Set((await dev.shell('pm list packages -3')).split('\n').map((l) => l.replace('package:', '').trim()));
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => {
      const body = l.slice('package:'.length);
      const eq = body.lastIndexOf('=');
      const packageName = body.slice(eq + 1);
      return { packageName, apkPath: body.slice(0, eq), system: third ? !third.has(packageName) : false };
    })
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export interface AppInfo {
  packageName: string;
  versionName?: string;
  versionCode?: string;
  minSdk?: string;
  targetSdk?: string;
  firstInstall?: string;
  lastUpdate?: string;
  debuggable: boolean;
  installer?: string;
  apkPaths: string[];
  requestedPermissions: string[];
  grantedPermissions: string[];
  activities: string[];
  launcherActivity?: string;
  pid?: number;
}

export async function appInfo(dev: DeviceAdb, pkg: string): Promise<AppInfo> {
  assertPackage(pkg);
  const [dump, paths, pid, resolve] = await Promise.all([
    dev.shell(`dumpsys package ${pkg}`, { timeoutMs: 20_000 }),
    dev.shell(`pm path ${pkg}`),
    dev.shell(`pidof ${pkg}`).catch(() => ''),
    dev.shell(`cmd package resolve-activity --brief ${pkg}`).catch(() => ''),
  ]);
  const get = (re: RegExp) => re.exec(dump)?.[1];
  const section = (title: string) => {
    const idx = dump.indexOf(title);
    if (idx < 0) return [];
    const rest = dump.slice(idx + title.length).split('\n').slice(1);
    const out: string[] = [];
    for (const l of rest) {
      if (!/^\s{6,}/.test(l)) break;
      out.push(l.trim());
    }
    return out;
  };
  const activities = new Set<string>();
  for (const m of dump.matchAll(new RegExp(`${pkg.replace(/\./g, '\\.')}/([\\w.$]+)`, 'g'))) {
    const a = m[1].startsWith('.') ? pkg + m[1] : m[1];
    activities.add(a);
  }
  const launcher = resolve.trim().split('\n').pop();
  return {
    packageName: pkg,
    versionName: get(/versionName=(\S+)/),
    versionCode: get(/versionCode=(\d+)/),
    minSdk: get(/minSdk=(\d+)/),
    targetSdk: get(/targetSdk=(\d+)/),
    firstInstall: get(/firstInstallTime=(.+)/)?.trim(),
    lastUpdate: get(/lastUpdateTime=(.+)/)?.trim(),
    debuggable: /pkgFlags=\[[^\]]*DEBUGGABLE/.test(dump),
    installer: get(/installerPackageName=(\S+)/),
    apkPaths: paths.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean),
    requestedPermissions: section('requested permissions:').filter((p) => p.includes('.')),
    grantedPermissions: section('runtime permissions:')
      .concat(section('install permissions:'))
      .filter((p) => p.includes('granted=true'))
      .map((p) => p.split(':')[0]),
    activities: [...activities].sort(),
    launcherActivity: launcher?.includes('/') ? launcher : undefined,
    pid: Number(pid.trim().split(/\s+/)[0]) || undefined,
  };
}

export async function launchApp(dev: DeviceAdb, pkg: string, activity?: string): Promise<void> {
  assertPackage(pkg);
  // NEW_TASK|CLEAR_TASK(0x10008000): 이전에 같은 태스크에 쌓인 화면(다른 패키지 포함)을 비우고 첫 화면부터 시작
  const component =
    activity ? `${pkg}/${activity}` : await launcherComponent(dev, pkg);
  if (component) {
    const out = await dev.shell(`am start -W -f 0x10008000 -n ${quoteShell(component)}`, { timeoutMs: 30_000 });
    if (/Error:/.test(out)) throw new Error(out.trim());
    return;
  }
  const out = await dev.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  if (/No activities found/.test(out)) throw new Error(`${pkg}: 실행 가능한 런처 액티비티가 없습니다`);
}

/**
 * 홈에서 아이콘을 누른 것처럼 앱을 앞으로 가져온다. 실행 중이면 보던 화면 그대로, 꺼져 있으면 새로 실행.
 * (launchApp 은 태스크를 비우고 첫 화면부터 시작한다)
 */
export async function bringToFront(dev: DeviceAdb, pkg: string): Promise<void> {
  assertPackage(pkg);
  const component = await launcherComponent(dev, pkg);
  if (component) {
    // NEW_TASK|RESET_TASK_IF_NEEDED(0x10200000) + MAIN/LAUNCHER: 런처가 보내는 것과 같은 인텐트
    const out = await dev.shell(
      `am start -f 0x10200000 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${quoteShell(component)}`,
      { timeoutMs: 15_000 },
    );
    if (/Error:/.test(out)) throw new Error(out.trim());
    return;
  }
  const out = await dev.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  if (/No activities found/.test(out)) throw new Error(`${pkg}: 실행 가능한 런처 액티비티가 없습니다`);
}

async function launcherComponent(dev: DeviceAdb, pkg: string): Promise<string | undefined> {
  const out = await dev
    .shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`)
    .catch(() => '');
  const last = out.trim().split('\n').pop()?.trim();
  return last && last.includes('/') ? last : undefined;
}

export async function stopApp(dev: DeviceAdb, pkg: string): Promise<void> {
  assertPackage(pkg);
  await dev.shell(`am force-stop ${pkg}`);
}

/** 앱 데이터 초기화 (되돌릴 수 없음) */
export async function clearAppData(dev: DeviceAdb, pkg: string): Promise<void> {
  assertPackage(pkg);
  await dev.shell(`pm clear ${pkg}`);
}

export async function openDeepLink(dev: DeviceAdb, uri: string, pkg?: string): Promise<string> {
  if (pkg) assertPackage(pkg);
  const out = await dev.shell(`am start -W -a android.intent.action.VIEW -d ${quoteShell(uri)}${pkg ? ` ${pkg}` : ''}`);
  // 받을 앱이 없는 등 실패해도 am 은 0 으로 끝나므로 출력으로 판단한다 (launchApp 과 같은 방식)
  if (/Error:/.test(out)) throw new Error(out.trim());
  return out;
}

/** base.apk와 split APK를 로컬로 내려받는다 */
export async function pullApk(dev: DeviceAdb, pkg: string, outDir: string): Promise<string[]> {
  assertPackage(pkg);
  const paths = (await dev.shell(`pm path ${pkg}`))
    .split('\n')
    .map((l) => l.replace('package:', '').trim())
    .filter(Boolean);
  if (!paths.length) throw new Error(`${pkg}: 설치된 APK를 찾을 수 없습니다`);
  await mkdir(outDir, { recursive: true });
  const local: string[] = [];
  for (const p of paths) {
    const dest = join(outDir, p.split('/').pop()!);
    await dev.raw(['pull', p, dest], { timeoutMs: 300_000 });
    local.push(dest);
  }
  return local;
}

// ---------- logcat ----------

export interface LogLine {
  time: string;
  pid: number;
  tid: number;
  level: 'V' | 'D' | 'I' | 'W' | 'E' | 'F' | 'S';
  tag: string;
  message: string;
}

const LOG_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*: (.*)$/;

export function parseLogLine(line: string): LogLine | undefined {
  const m = LOG_RE.exec(line);
  if (!m) return undefined;
  return {
    time: m[1],
    pid: Number(m[2]),
    tid: Number(m[3]),
    level: m[4] as LogLine['level'],
    tag: m[5],
    message: m[6],
  };
}

async function pidOf(dev: DeviceAdb, pkg: string): Promise<number | undefined> {
  assertPackage(pkg);
  const out = await dev.shell(`pidof ${pkg}`).catch(() => '');
  return Number(out.trim().split(/\s+/)[0]) || undefined;
}

/** 최근 로그 덤프 (-d) */
export async function readLogcat(
  dev: DeviceAdb,
  opts: { pkg?: string; lines?: number; minLevel?: LogLine['level']; grep?: string } = {},
): Promise<LogLine[]> {
  const args = ['logcat', '-d', '-v', 'threadtime', '-t', String(opts.lines ?? 500)];
  if (opts.pkg) {
    const pid = await pidOf(dev, opts.pkg);
    if (!pid) throw new Error(`${opts.pkg} 프로세스가 실행 중이 아닙니다`);
    args.push(`--pid=${pid}`);
  }
  if (opts.minLevel) args.push(`*:${opts.minLevel}`);
  const out = await dev.text(args, { timeoutMs: 20_000 });
  const lines = out.split('\n').map(parseLogLine).filter((l): l is LogLine => !!l);
  if (!opts.grep) return lines;
  const g = opts.grep.toLowerCase();
  return lines.filter((l) => l.tag.toLowerCase().includes(g) || l.message.toLowerCase().includes(g));
}

/** 실시간 logcat 스트림. 반환값의 stop()으로 종료 */
export function streamLogcat(
  dev: DeviceAdb,
  onLine: (l: LogLine) => void,
  opts: { pid?: number; since?: 'now' | 'all' } = {},
): { stop(): void; proc: ChildProcess } {
  const args = ['logcat', '-v', 'threadtime'];
  if (opts.since !== 'all') args.push('-T', '1');
  if (opts.pid) args.push(`--pid=${opts.pid}`);
  const proc = dev.spawn(args);
  let buf = '';
  // 청크 경계에서 잘린 한글 등 여러 바이트 글자가 깨지지 않게 문자열 디코딩을 스트림에 맡긴다
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const l = parseLogLine(p);
      if (l) onLine(l);
    }
  });
  return { proc, stop: () => proc.kill() };
}

/**
 * 최근 크래시(FATAL EXCEPTION / ANR) 로그.
 * opts.since(기기 시계 기준 epoch ms, deviceTime 참고)를 주면 그 뒤의 것만. 이때는 시각을 epoch 로 받아 비교한다
 * (threadtime 시각은 기기 시간대·연도 없는 값이라 호스트 시계와 비교할 수 없다)
 */
export async function recentCrashes(dev: DeviceAdb, pkg?: string, opts: { since?: number } = {}): Promise<string[]> {
  const format = opts.since === undefined ? 'threadtime' : 'epoch';
  const out = await dev.text(['logcat', '-d', '-b', 'crash', '-v', format], { timeoutMs: 20_000 });
  let blocks = out.split(/(?=^.*FATAL EXCEPTION)/m).filter((b) => b.includes('FATAL EXCEPTION'));
  if (opts.since !== undefined) {
    const since = opts.since;
    blocks = blocks.filter((b) => {
      const m = /^\s*(\d+)\.(\d+)/m.exec(b);
      return !m || Number(m[1]) * 1000 + Number(m[2].slice(0, 3).padEnd(3, '0')) >= since;
    });
  }
  return pkg ? blocks.filter((b) => b.includes(pkg)) : blocks;
}

/** 기기 시계 (epoch ms). 기기가 남긴 시각(SDK 네트워크·이벤트, logcat)과 비교할 기준은 호스트가 아니라 이 값으로 잡는다 */
export async function deviceTime(dev: DeviceAdb): Promise<number> {
  const sec = Number((await dev.shell('date +%s')).trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error('기기 시각을 읽지 못했습니다');
  return sec * 1000;
}

export { pidOf };
