import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import * as dl from '@droidlens/core';
import { resolveClaude, sendChat, stopChat, type ChatRequest } from './chat';
import { checkForUpdate, cleanupOldUpdates, currentVersion, installUpdate, type UpdateInfo } from './updater';

let adb = new dl.Adb();
const run = promisify(execFile);
let win: BrowserWindow | null = null;
/** 화면이 뜨기 전 창 배경. styles.css 의 --bg 와 같은 색 */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0e0f12' : '#f4f5f7');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    title: 'DroidLens',
    // 저장된 테마는 창을 만들기 전에 nativeTheme 에 적용해 둔다 (시작할 때 다른 테마가 비치지 않게)
    backgroundColor: windowBackground(),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 개발용: DROIDLENS_OPEN="tab=network&pkg=com.example"로 시작 탭/앱 지정,
  // DROIDLENS_SNAPSHOT=<png 경로>면 로드 후 화면을 캡처해 저장하고 종료 (UI 자동 확인용)
  const hash = process.env.DROIDLENS_OPEN ?? '';
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  const snapshotPath = process.env.DROIDLENS_SNAPSHOT;
  if (snapshotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        await import('node:fs/promises').then((fs) => fs.writeFile(snapshotPath, img.toPNG()));
        app.quit();
      }, Number(process.env.DROIDLENS_SNAPSHOT_DELAY ?? 8000));
    });
  }
  win.on('closed', () => (win = null));
  // 앱 화면 밖으로의 이동·새 창을 막는다 (외부 링크는 openExternal IPC로만, https만 허용)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
  if (process.env.DROIDLENS_DEBUG) win.webContents.on('console-message', (e) => debug('renderer', e.level, e.message));
}

const dev = (serial: string) => adb.device(serial);
const debug = process.env.DROIDLENS_DEBUG ? (...a: unknown[]) => console.log('[droidlens]', ...a) : () => undefined;
const send = (channel: string, payload: unknown) => {
  if (channel !== 'mirror:packet') debug('send', channel, JSON.stringify(payload)?.slice(0, 200));
  win?.webContents.send(channel, payload);
};

/** 핸들러 에러를 { error } 로 감싸 렌더러가 메시지를 보여줄 수 있게 한다 */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...(args as A)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}

// ---------- 기기 / 화면 ----------
handle('devices', () => dl.listDevices(adb));
// 가상 기기 (이미 만든 AVD 실행·종료)
handle('avds', () => dl.listAvds(adb));
handle('avdStart', (name: string) => dl.startAvd(adb, name, { onProgress: (message) => send('progress', { kind: 'avd', message }) }));
handle('avdStop', (s: string) => dl.stopAvd(adb, s));
handle('deviceInfo', (s: string) => dl.getDeviceInfo(dev(s)));
handle('screenshot', async (s: string) => `data:image/png;base64,${(await dl.screenshot(dev(s))).toString('base64')}`);
// 화면 탭 스냅샷 모드처럼 계속 받는 경우: base64 문자열로 바꾸지 않고 PNG 바이트 그대로 넘긴다 (구조화 복제로 Uint8Array 가 된다)
handle('screenshotPng', (s: string) => dl.screenshot(dev(s)));
handle('saveScreenshot', async (s: string, label?: string) => {
  const dir = await dl.ensureDir('screenshots');
  const p = join(dir, `${dl.timestamp()}_${dl.safeName(label ?? 'shot')}.png`);
  await import('node:fs/promises').then((fs) => dl.screenshot(dev(s)).then((b) => fs.writeFile(p, b)));
  return p;
});
handle('hierarchy', (s: string) => dl.dumpHierarchy(dev(s)));
handle('snapshot', async (s: string) => {
  const snap = await dl.captureSnapshot(dev(s));
  snap.screen.fragments = await dl.topFragments(dev(s)).catch(() => []);
  return {
    screen: snap.screen,
    hierarchy: snap.hierarchy,
    signature: snap.signature,
    stats: dl.hierarchyStats(snap.hierarchy),
    image: `data:image/png;base64,${snap.png!.toString('base64')}`,
  };
});
handle('currentScreen', (s: string, fragments?: boolean) => dl.currentScreen(dev(s), { fragments }));

// ---------- 입력 ----------
// 화면 탭은 응답을 기다리지 않고 조작을 연달아 보내므로, 기기에는 들어온 순서대로 하나씩 보낸다
let inputChain: Promise<unknown> = Promise.resolve();
const inOrder = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = inputChain.then(fn);
  inputChain = p.catch(() => undefined);
  return p;
};
handle('tap', (s: string, x: number, y: number) => inOrder(() => dl.tap(dev(s), x, y)));
handle('longPress', (s: string, x: number, y: number) => inOrder(() => dl.longPress(dev(s), x, y)));
handle('swipe', (s: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => inOrder(() => dl.swipe(dev(s), x1, y1, x2, y2, ms)));
handle('key', (s: string, key: keyof typeof dl.KEYCODES) => inOrder(() => dl.pressKey(dev(s), key)));
handle('typeText', (s: string, t: string) => inOrder(() => dl.typeText(dev(s), t)));

// ---------- 고프레임 미러링 (scrcpy) ----------
let mirror: { serial: string; m: dl.Mirror } | null = null;
/**
 * 가장 최근에 요청된 미러링 세션 id (렌더러가 정한다). 연결에 수~십수 초가 걸리는 동안 중지·재시작이 오면
 * 이 값이 바뀌므로, 연결이 끝났을 때 자기 id 가 아니면 바로 멈춘다. 이벤트에도 id 를 실어 렌더러가 이전 세션 패킷을 버리게 한다
 */
let mirrorWant: number | null = null;
const scrcpyServer = () =>
  app.isPackaged ? resourcePath('scrcpy', 'scrcpy-server') : resourcePath('vendor', 'scrcpy', 'scrcpy-server');
handle('mirrorStart', async (s: string, maxSize: number | undefined, id: number) => {
  debug('mirrorStart', s, maxSize, id);
  mirrorWant = id;
  mirror?.m.stop();
  mirror = null;
  if (!existsSync(scrcpyServer())) throw new Error('scrcpy 서버 파일이 없습니다 (node scripts/fetch-scrcpy.mjs)');
  const m = await dl.startMirror(
    dev(s),
    {
      onSession: (width, height) => send('mirror:session', { id, width, height }),
      // Buffer는 구조화 복제로 Uint8Array가 된다
      onPacket: (p) => (debug('packet', p.data.length, p.config ? 'config' : '', p.key ? 'key' : ''), send('mirror:packet', { id, data: p.data, config: p.config, key: p.key, pts: Number(p.pts) })),
      onClose: (reason) => {
        if (mirror?.m === m) mirror = null;
        send('mirror:closed', { id, reason });
      },
    },
    { serverPath: scrcpyServer(), maxSize: maxSize ?? 1280 },
  );
  // 연결하는 사이 중지되거나 다른 세션이 시작됐으면 이 세션은 버린다
  if (mirrorWant !== id) {
    m.stop();
    return false;
  }
  mirror = { serial: s, m };
  debug('mirror connected');
  return true;
});
/** id 를 주면 그 세션이 아직 최신일 때만 멈춘다 (늦게 온 이전 화면의 정리가 새 세션을 끊지 않게) */
handle('mirrorStop', async (id?: number) => {
  debug('mirrorStop', id);
  if (id !== undefined && id !== mirrorWant) return;
  mirrorWant = null;
  mirror?.m.stop();
  mirror = null;
});

// ---------- 녹화 ----------
/**
 * 기기별 녹화. 녹화 상태는 여기가 기준이고 화면은 recordStatus 로 다시 읽는다 (탭을 옮기거나 기기를 바꿔도 잃지 않게).
 * screenrecord 가 180초 제한으로 먼저 끝나도 기기에 파일이 남아 있으므로, 중지하면 그때까지 녹화된 파일을 받아 온다
 */
const recs = new Map<string, dl.Recording>();
handle('recordStatus', async (s: string) => recs.get(s)?.startedAt ?? null);
handle('recordStart', async (s: string) => {
  if (recs.has(s)) throw new Error('이미 녹화 중입니다');
  const r = dl.startRecording(dev(s));
  recs.set(s, r);
  return r.startedAt;
});
handle('recordStop', async (s: string) => {
  const r = recs.get(s);
  if (!r) throw new Error('녹화 중이 아닙니다');
  recs.delete(s);
  const dir = await dl.ensureDir('recordings');
  return r.stop(join(dir, `${dl.timestamp()}_record.mp4`));
});

// ---------- 앱 ----------
handle('packages', (s: string, thirdPartyOnly: boolean) => dl.listPackages(dev(s), { thirdPartyOnly }));
handle('appInfo', (s: string, pkg: string) => dl.appInfo(dev(s), pkg));
handle('launch', (s: string, pkg: string, restart?: boolean) =>
  (restart ? dl.stopApp(dev(s), pkg) : Promise.resolve()).then(() => dl.launchApp(dev(s), pkg)),
);
handle('stop', (s: string, pkg: string) => dl.stopApp(dev(s), pkg));
handle('bringToFront', (s: string, pkg: string) => dl.bringToFront(dev(s), pkg));
handle('deeplink', (s: string, uri: string, pkg?: string) => dl.openDeepLink(dev(s), uri, pkg));
handle('analyzeLibraries', async (s: string, pkg: string) => {
  send('progress', { kind: 'libs', message: 'APK 내려받는 중…' });
  const dir = await dl.ensureDir('apks', dl.safeName(pkg));
  const apks = await dl.pullApk(dev(s), pkg, dir);
  send('progress', { kind: 'libs', message: 'DEX 분석 중…' });
  return dl.analyzeApk(apks, pkg);
});
handle('crashes', (s: string, pkg?: string) => dl.recentCrashes(dev(s), pkg));
handle('perfSample', async (s: string, pkg: string) => (await dl.perfSample(dev(s), pkg)) ?? null);
handle('perfStartup', (s: string, pkg: string, cold: boolean, runs: number) => dl.measureStartup(dev(s), pkg, { cold, runs }));
handle('perfResetFrames', (s: string, pkg: string) => dl.resetFrameStats(dev(s), pkg));

// ---------- logcat ----------
let logStream: { stop(): void } | null = null;
/** 가장 최근에 요청된 로그 스트림 id (렌더러가 정한다). pid 를 찾는 사이 중지·재시작이 오면 바뀌어 이전 요청은 스트림을 열지 않는다 */
let logWant: number | null = null;
handle('logcatStart', async (s: string, pkg: string | undefined, id: number) => {
  logWant = id;
  logStream?.stop();
  logStream = null;
  const pid = pkg ? await dl.pidOf(dev(s), pkg) : undefined;
  if (logWant !== id) return null;
  if (pkg && !pid) {
    logWant = null;
    throw new Error(`${pkg} 프로세스가 실행 중이 아닙니다`);
  }
  let batch: dl.LogLine[] = [];
  const flush = () => {
    if (batch.length) send('logcat', { id, lines: batch.splice(0) });
  };
  const timer = setInterval(flush, 200);
  const st = dl.streamLogcat(dev(s), (l) => batch.push(l), { pid });
  const stream = {
    stop: () => {
      clearInterval(timer);
      st.stop();
    },
  };
  st.proc.on('error', () => undefined);
  // 기기 연결이 끊기는 등으로 스트림이 스스로 끝나면 화면에 알린다 (중지를 눌러 끝난 것은 알리지 않는다)
  st.proc.on('close', () => {
    clearInterval(timer);
    if (logStream !== stream) return;
    flush();
    logStream = null;
    logWant = null;
    send('logcat:closed', { id });
  });
  logStream = stream;
  return pid ?? null;
});
/** id 를 주면 그 스트림이 아직 최신일 때만 멈춘다 */
handle('logcatStop', async (id?: number) => {
  if (id !== undefined && id !== logWant) return;
  logWant = null;
  logStream?.stop();
  logStream = null;
});

// ---------- 화면 그래프 ----------
handle('graphGet', async (pkg: string) => (await dl.ScreenGraph.open(pkg)).toJSON());
handle('graphImage', async (pkg: string, file: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  return `data:image/png;base64,${(await readFile(join(g.dir, basename(file)))).toString('base64')}`;
});
/** 기기를 오래 움직이는 화면 지도 작업 (자동 탐색·화면 이동). 한 번에 하나만 돌고, 그동안 직접 조작은 기록하지 않는다 */
let flowJob: { kind: 'explore' | 'navigate'; abort?: AbortController } | null = null;
const flowGuard = () => {
  if (flowJob) throw new Error(flowJob.kind === 'explore' ? '탐색 중입니다. 끝나거나 중지한 뒤 다시 시도하세요' : '화면 이동 중입니다. 끝난 뒤 다시 시도하세요');
};

/**
 * 화면 탭에서 직접 조작한 행동을 앞뒤 화면과 함께 지도에 기록.
 * 에이전트가 없으면 화면 확인이 1~2초씩 걸려 조작이 굼떠지고, 다른 앱 화면은 이 앱 지도와 상관없으므로 기록 없이 조작만 한다.
 * 조작은 바로 보내고 도착 화면 안정 대기·저장은 그 뒤에 한다. 기다리는 사이 다음 조작이 오면 그 기록은 버리고
 * (도착 화면이 이 행동의 결과가 아니게 되므로) 새 조작은 기록 없이 보낸다. 연달아 조작하는 동안은 기록을 건너뛰고 멈추면 다시 기록한다.
 * 기다리는 기록은 기기마다 따로 둔다 (다른 기기 조작이 이 기기의 기록을 버리지 않게)
 */
const recording = new Map<string, AbortController>();
handle('graphRecord', async (s: string, pkg: string, action: dl.GraphAction) => {
  if (!['tap', 'longpress', 'swipe', 'key'].includes(action?.type)) throw new Error('기록할 수 없는 행동입니다');
  const d = dev(s);
  const pending = recording.get(s);
  if (pending) {
    pending.abort();
    await inOrder(() => dl.performAction(d, action, pkg));
    return { recorded: false as const, skipped: true };
  }
  const job = new AbortController();
  recording.set(s, job);
  try {
    const started = await inOrder(async () => {
      const before = flowJob || !(await dl.ensureAgent(d)) ? undefined : await dl.captureSnapshot(d, { screenshot: false });
      if (!before || before.screen.packageName !== pkg) {
        await dl.performAction(d, action, pkg);
        return undefined;
      }
      return dl.startTransition(d, await dl.ScreenGraph.open(pkg), action, before);
    });
    if (!started) return { recorded: false as const };
    const r = await started.finish(job.signal);
    return { recorded: true as const, from: r.from.id, to: r.to.id, isNew: r.to.visits === 1 };
  } catch (e) {
    if (job.signal.aborted) return { recorded: false as const, skipped: true };
    throw e;
  } finally {
    if (recording.get(s) === job) recording.delete(s);
  }
});
handle('graphRecordHere', async (s: string, pkg: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  const n = await g.addSnapshot(await dl.captureSnapshot(dev(s)), dev(s));
  await g.save();
  return n.id;
});
interface ExploreRequest {
  maxDepth: number;
  fromCurrent?: boolean;
  startAt?: string;
  only?: dl.Interaction[];
  allowDanger?: boolean;
}
handle('explore', async (s: string, pkg: string, req: ExploreRequest) => {
  flowGuard();
  const job = { kind: 'explore' as const, abort: new AbortController() };
  flowJob = job;
  try {
    const r = await dl.explore(dev(s), {
      packageName: pkg,
      maxDepth: req.maxDepth,
      relaunch: !req.fromCurrent,
      startAt: req.startAt,
      only: req.only,
      allowDanger: req.allowDanger,
      signal: job.abort.signal,
      onProgress: (e) => send('progress', { kind: 'explore', ...e }),
    });
    return { steps: r.steps, limited: r.limited, skipped: r.skipped, errors: r.errors, touched: r.touched, startScreen: r.startScreen };
  } finally {
    // 오류로 끝나도 '탐색 중' 상태가 남지 않게
    if (flowJob === job) flowJob = null;
  }
});
handle('exploreStop', async () => flowJob?.abort?.abort());
handle('graphReset', async (pkg: string) => {
  if (flowJob) throw new Error('탐색 중에는 그래프를 초기화할 수 없습니다');
  await dl.ScreenGraph.reset(pkg);
});
/** 지도에 기록된 경로를 따라 기기를 그 화면으로 옮긴다 */
handle('graphNavigate', async (s: string, pkg: string, target: string) => {
  flowGuard();
  const job = { kind: 'navigate' as const };
  flowJob = job;
  try {
    const g = await dl.ScreenGraph.open(pkg);
    const r = await dl.navigateTo(dev(s), g, target, (m) => send('progress', { kind: 'explore', message: m }));
    return { moved: r.moved, steps: r.moved ? (r.path?.length ?? 0) : 0 };
  } finally {
    if (flowJob === job) flowJob = null;
  }
});
handle('graphExport', async (pkg: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  if (!g.nodes.size) throw new Error('내보낼 화면이 없습니다');
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: join(app.getPath('downloads'), `${dl.safeName(pkg)}.droidlens-map.json`),
    filters: [{ name: 'DroidLens map', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return undefined;
  await writeFile(r.filePath, JSON.stringify(await g.exportBundle()));
  return r.filePath;
});
handle('graphImport', async (pkg: string) => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'DroidLens map', extensions: ['json'] }] });
  const file = r.filePaths[0];
  if (r.canceled || !file) return undefined;
  if ((await stat(file)).size > 50 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (50MB 초과)');
  let bundle: unknown;
  try {
    bundle = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('DroidLens 화면 지도 파일이 아닙니다');
  }
  return (await dl.ScreenGraph.open(pkg)).importBundle(bundle);
});

// ---------- 앱 SDK ----------
const SDK_METHODS = ['info', 'network', 'networkDetail', 'clearNetwork', 'mocks', 'setMock', 'removeMock', 'clearMocks', 'prefs', 'setPref', 'removePref', 'databases', 'query', 'events'] as const;
handle('sdkApps', (s: string) => dl.listSdkApps(dev(s)));
handle('sdk', async (s: string, pkg: string, method: (typeof SDK_METHODS)[number], ...args: unknown[]) => {
  if (!SDK_METHODS.includes(method)) throw new Error(`지원하지 않는 SDK 메서드: ${method}`);
  const c = await dl.sdkFor(dev(s), pkg);
  return (c[method] as (...a: unknown[]) => Promise<unknown>).apply(c, args);
});

// ---------- 시나리오 스크립트 ----------
let scriptAbort: AbortController | null = null;
/** 스크립트 경로는 scripts 폴더 안의 파일 이름으로만 받는다 */
const scriptFile = async (name: string) => join(await dl.scriptsDir(), basename(name));
handle('scriptsList', async () => {
  const dir = await dl.scriptsDir();
  const files = await dl.collectScripts(dir);
  return Promise.all(
    files.map(async (f) => {
      try {
        const s = await dl.loadScript(f);
        return { file: basename(f), name: s.name, app: s.app, steps: s.steps.length };
      } catch (e) {
        return { file: basename(f), name: basename(f), error: (e as Error).message };
      }
    }),
  );
});
handle('scriptRead', async (name: string) => readFile(await scriptFile(name), 'utf8'));
handle('scriptWrite', async (name: string, yaml: string) => {
  const script = dl.parseScript(yaml); // 형식 오류면 저장하지 않고 에러
  const file = name ? basename(name) : `${dl.safeName(script.name)}.yaml`;
  await import('node:fs/promises').then(async (fs) => fs.writeFile(await scriptFile(file), yaml));
  return file;
});
handle('scriptDelete', async (name: string) => import('node:fs/promises').then(async (fs) => fs.unlink(await scriptFile(name))));
handle('scriptRun', async (s: string, names: string[]) => {
  scriptAbort?.abort();
  scriptAbort = new AbortController();
  const signal = scriptAbort.signal;
  const results = [];
  for (const [i, name] of names.entries()) {
    if (signal.aborted) break;
    const path = await scriptFile(name);
    send('script:progress', { kind: 'script', file: name, index: i, total: names.length });
    try {
      const r = await dl.runScript(dev(s), await dl.loadScript(path), {
        sourcePath: path,
        signal,
        onStep: (e) => send('script:progress', { kind: 'step', file: name, ...e }),
      });
      results.push({ file: name, verdict: r.verdict, passed: r.passed, failed: r.failed, skipped: r.skipped, durationMs: r.durationMs, report: r.report });
    } catch (e) {
      results.push({ file: name, verdict: 'blocked', error: (e as Error).message });
    }
  }
  scriptAbort = null;
  return results;
});
handle('scriptStop', async () => scriptAbort?.abort());

// ---------- 에이전트 대화 ----------
handle('chatStatus', async () => {
  const c = await resolveClaude();
  return { version: c.version };
});
handle('chatSend', async (req: ChatRequest) => {
  await sendChat(req, { execPath: process.execPath, mcpScript: mcpScript(), agentsDir: agentsSrc() }, (e) => send('chat:event', e));
  return true;
});
handle('chatStop', async () => stopChat());

// ---------- 기타 ----------
/** 렌더러가 넘긴 경로는 DroidLens 데이터 폴더 안쪽만 허용 (openPath는 실행 파일도 열 수 있으므로) */
function insideHome(p: string): string {
  const full = resolve(p);
  const home = resolve(dl.droidlensHome());
  if (full !== home && !full.startsWith(home + sep)) throw new Error('DroidLens 데이터 폴더 밖의 경로는 열 수 없습니다');
  return full;
}
handle('reveal', async (p: string) => shell.showItemInFolder(insideHome(p)));
handle('openPath', async (p: string) => {
  const full = insideHome(p);
  if (!/\.(html|png|mp4|json|mmd|apk)$/i.test(full) && full !== resolve(dl.droidlensHome())) throw new Error('열 수 없는 파일 형식입니다');
  return shell.openPath(full);
});
handle('home', async () => dl.droidlensHome());
handle('scenarios', async () => {
  const fs = await import('node:fs/promises');
  const dir = await dl.ensureDir('scenarios');
  const ids = (await fs.readdir(dir)).sort().reverse();
  const out = [];
  for (const id of ids.slice(0, 100)) {
    const d = await dl.readJson<dl.ScenarioData>(join(dir, id, 'scenario.json'));
    if (d) out.push(d);
  }
  return out;
});
handle('scenarioDelete', async (ids: string[]) => {
  if (!Array.isArray(ids)) throw new Error('잘못된 요청입니다');
  const fs = await import('node:fs/promises');
  const dir = await dl.ensureDir('scenarios');
  for (const id of ids) {
    // 시나리오 폴더 바로 아래의 기록만 지운다 (경로 조작 방지)
    if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id.startsWith('.')) throw new Error(`잘못된 시나리오 id: ${id}`);
    // 에이전트가 아직 기록 중인 리포트를 지우면 다음 단계 저장이 실패한다.
    // 끝나지 않았어도 1시간이 지났으면 에이전트가 중간에 멈춘 것으로 보고 지울 수 있게 한다
    const d = await dl.readJson<dl.ScenarioData>(join(dir, id, 'scenario.json'));
    if (d && !d.finishedAt && Date.now() - d.startedAt < 60 * 60 * 1000) throw new Error('진행 중인 시나리오는 지울 수 없습니다');
    await fs.rm(join(dir, id), { recursive: true, force: true });
  }
});
handle('scenarioImage', async (dir: string, file: string) =>
  `data:image/png;base64,${(await readFile(insideHome(join(dir, basename(file))))).toString('base64')}`,
);

// ---------- 설정 / Claude Code 연동 ----------
const resourcePath = (...p: string[]) =>
  app.isPackaged ? join(process.resourcesPath, ...p) : resolve(app.getAppPath(), '../..', ...p);
const mcpScript = () =>
  app.isPackaged ? resourcePath('mcp', 'droidlens-mcp.mjs') : resourcePath('packages', 'mcp', 'dist', 'droidlens-mcp.mjs');
const agentsSrc = () => resourcePath('agents');
const agentsDst = () => join(homedir(), '.claude', 'agents');
const q = (s: string) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

function mcpAddArgs(): string[] {
  return ['mcp', 'add', '--scope', 'user', 'droidlens', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', process.execPath, mcpScript()];
}

/** GUI 앱은 로그인 셸 PATH를 못 받으므로 로그인 셸을 거쳐 claude를 실행한다 */
async function runClaude(args: string[]): Promise<string> {
  // claude 위치·PATH는 resolveClaude()가 로그인 셸에서 한 번만 찾아 캐시한다 (매번 로그인 셸을 띄우면 수 초씩 걸림)
  const c = await resolveClaude();
  const env = { ...process.env, PATH: c.path };
  if (process.platform === 'win32') {
    // claude.cmd 는 셸로 실행해야 하는데, shell 모드에서는 Node 가 인자를 따옴표 없이 이어 붙인다.
    // 'C:\Program Files\DroidLens\DroidLens.exe' 같은 공백 경로가 깨지지 않게 직접 감싼다
    const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const { stdout } = await run(quote(c.bin), args.map(quote), { timeout: 30_000, env, shell: true });
    return stdout;
  }
  const { stdout } = await run(c.bin, args, { timeout: 30_000, env });
  return stdout;
}

/** user 범위 MCP 등록 여부. `claude mcp list`는 등록된 서버를 하나씩 띄워 검사해 느리므로 설정 파일을 직접 읽는다 */
async function droidlensRegistered(): Promise<boolean> {
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    return !!cfg.mcpServers?.droidlens;
  } catch {
    return false;
  }
}

handle('appVersion', async () => currentVersion());
handle('platform', async () => ({ platform: process.platform, arch: process.arch }));
handle('updateCheck', () => checkForUpdate());
handle('updateInstall', async (info: UpdateInfo) => {
  // 렌더러가 넘긴 정보 대신 다시 확인한 결과로 설치한다 (다운로드 URL을 렌더러에서 받지 않음)
  const fresh = await checkForUpdate();
  if (!fresh.available || fresh.latest !== info.latest) throw new Error('설치할 업데이트가 없습니다');
  // 로그·미러·대화는 설치를 예약한 뒤 app.quit() 의 종료 정리(stopAll)에서 멈춘다. 다운로드가 실패하면 그대로 쓸 수 있다
  await installUpdate(fresh, (p, message) => send('update:progress', { p, message }));
});
handle('adbStatus', async () => ({ ...(await adb.version()), candidates: dl.adbCandidates() }));
const configPath = () => join(dl.droidlensHome(), 'config.json');
const readConfig = async () => (await dl.readJson<Record<string, unknown>>(configPath())) ?? {};
async function updateConfig(patch: Record<string, unknown>): Promise<void> {
  const cfg = { ...(await readConfig()), ...patch };
  await dl.ensureDir();
  await dl.writeJson(configPath(), cfg);
}
handle('setAdbPath', async (p: string) => {
  // 여기 등록한 파일은 앱이 계속 실행하므로 adb 실행 파일 경로만 받는다 (비우면 자동 탐색)
  if (p && !(isAbsolute(p) && /^adb(\.exe)?$/i.test(basename(p)))) throw new Error('adb 실행 파일의 전체 경로를 입력하세요 (파일 이름이 adb 또는 adb.exe)');
  await updateConfig({ adbPath: p || undefined });
  adb = new dl.Adb();
  return adb.version();
});

/** 테마. themeSource 가 렌더러의 prefers-color-scheme 이 되어 화면 색과 OS 화면(파일 대화상자·창 배경)이 함께 바뀐다 */
const isThemeSource = (v: unknown): v is typeof nativeTheme.themeSource => v === 'system' || v === 'light' || v === 'dark';
handle('setTheme', async (t: unknown) => {
  if (!isThemeSource(t)) throw new Error('잘못된 테마');
  if (nativeTheme.themeSource === t) return;
  nativeTheme.themeSource = t;
  win?.setBackgroundColor(windowBackground());
  await updateConfig({ theme: t });
});
handle('integration', async () => {
  const src = agentsSrc();
  const agents = existsSync(src) ? (await readdir(src)).filter((f) => f.endsWith('.md')) : [];
  let claudeVersion: string | null = null;
  const registered = await droidlensRegistered();
  try {
    claudeVersion = (await resolveClaude()).version;
  } catch {
    /* claude CLI 없음 */
  }
  return {
    mcpScript: mcpScript(),
    mcpScriptExists: existsSync(mcpScript()),
    command: ['claude', ...mcpAddArgs()].map((a) => (/[\s'"]/.test(a) ? q(a) : a)).join(' '),
    claudeVersion,
    registered,
    agents: agents.map((f) => ({ file: f, installed: existsSync(join(agentsDst(), f)) })),
    agentsDir: agentsDst(),
  };
});
handle('registerMcp', async () => {
  await runClaude(['mcp', 'remove', '--scope', 'user', 'droidlens']).catch(() => undefined);
  return runClaude(mcpAddArgs());
});
handle('installAgents', async () => {
  await mkdir(agentsDst(), { recursive: true });
  const files = (await readdir(agentsSrc())).filter((f) => f.endsWith('.md'));
  for (const f of files) await copyFile(join(agentsSrc(), f), join(agentsDst(), f));
  return files;
});
handle('copy', async (t: string) => clipboard.writeText(t));
handle('openExternal', async (url: string) => {
  if (/^https:\/\//.test(url)) await shell.openExternal(url);
});

/** 번들된 에이전트 APK를 ~/.droidlens/agent로 복사해 MCP 서버(별도 프로세스)도 쓸 수 있게 한다 */
async function installAgentApk(): Promise<void> {
  const src = app.isPackaged
    ? resourcePath('agent', 'droidlens-agent.apk')
    : resourcePath('android', 'agent', 'build', 'outputs', 'apk', 'release', 'agent-release.apk');
  if (!existsSync(src)) return;
  const dir = await dl.ensureDir('agent');
  await copyFile(src, join(dir, 'droidlens-agent.apk'));
}

handle('agentStatus', (s: string) => dl.agentStatus(dev(s)));
handle('agentStart', async (s: string) => {
  await dl.ensureAgent(dev(s), { force: true });
  return dl.agentStatus(dev(s));
});
handle('agentStop', async (s: string) => {
  await dl.stopAgent(dev(s));
  return dl.agentStatus(dev(s));
});

app.whenReady().then(async () => {
  const { theme } = await readConfig().catch(() => ({}) as Record<string, unknown>);
  if (isThemeSource(theme)) nativeTheme.themeSource = theme;
  installAgentApk().catch(() => undefined);
  cleanupOldUpdates().catch(() => undefined);
  // 개발용 자가 테스트: DROIDLENS_FAKE_VERSION=0.0.1 DROIDLENS_UPDATE_SELFTEST=1 로 실행하면 확인 창 없이 최신 릴리스로 교체
  if (process.env.DROIDLENS_UPDATE_SELFTEST) {
    checkForUpdate()
      .then((u) => {
        debug('selftest update', JSON.stringify(u));
        return u.available ? installUpdate(u, (p, m) => debug('update', Math.round(p * 100), m)) : undefined;
      })
      .catch((e) => debug('selftest failed', (e as Error).message));
  }
  createWindow();
});
/**
 * 앱이 끝날 때 띄워 둔 외부 프로세스(claude·adb logcat·scrcpy·screenrecord)를 모두 정리한다.
 * 창을 닫을 때뿐 아니라 Cmd+Q·업데이트 설치(app.quit)로 끝날 때도 거치도록 will-quit 에서 한다
 */
function stopAll(): void {
  stopChat();
  logWant = null;
  logStream?.stop();
  logStream = null;
  mirrorWant = null;
  mirror?.m.stop();
  mirror = null;
  // 녹화는 기기 쪽 screenrecord 를 멈추고, 받아 올 수 없게 된 파일은 기기에서 지운다 (adb 셸은 앱이 끝나도 마저 돈다).
  // 다른 녹화(MCP record_start 등)는 두도록 우리 파일 경로로 좁힌다. 셸 자신의 명령줄에도 경로가 들어 있어 ^screenrecord 로 묶고,
  // toybox pkill 은 -INT 와 -f 를 함께 쓰면 자기 셸까지 끊어서 신호는 -l INT 로 준다 (LG G8·Flip3 에서 확인)
  for (const [s, r] of recs) {
    const mine = dl.quoteShell(`^screenrecord .*${r.remotePath}$`);
    dev(s).spawn(['shell', `pkill -l INT -f ${mine}; sleep 1; rm -f ${dl.quoteShell(r.remotePath)}`]).on('error', () => undefined);
  }
  recs.clear();
}
app.on('will-quit', stopAll);
// 화면 그래프는 저장을 잠깐 미뤄 두므로(saveSoon) 끝나기 전에 한 번 쓴다. 비동기라 종료를 한 번 미루고, 멈춰도 2초 뒤엔 끝낸다
let graphsFlushed = false;
app.on('before-quit', (e) => {
  if (graphsFlushed) return;
  e.preventDefault();
  graphsFlushed = true;
  void Promise.race([dl.ScreenGraph.flushAll(), new Promise((r) => setTimeout(r, 2000))]).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
