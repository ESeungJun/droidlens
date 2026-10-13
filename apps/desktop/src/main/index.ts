import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as dl from '@droidlens/core';

const adb = new dl.Adb();
let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    title: 'DroidLens',
    backgroundColor: '#0e0f12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

const dev = (serial: string) => adb.device(serial);
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

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
handle('deviceInfo', (s: string) => dl.getDeviceInfo(dev(s)));
handle('screenshot', async (s: string) => `data:image/png;base64,${(await dl.screenshot(dev(s))).toString('base64')}`);
handle('saveScreenshot', async (s: string, label?: string) => {
  const dir = await dl.ensureDir('screenshots');
  const p = join(dir, `${dl.timestamp()}_${dl.safeName(label ?? 'shot')}.png`);
  await import('node:fs/promises').then((fs) => dl.screenshot(dev(s)).then((b) => fs.writeFile(p, b)));
  return p;
});
handle('hierarchy', (s: string) => dl.dumpHierarchy(dev(s)));
handle('snapshot', async (s: string) => {
  const snap = await dl.captureSnapshot(dev(s));
  return {
    screen: snap.screen,
    hierarchy: snap.hierarchy,
    signature: snap.signature,
    stats: dl.hierarchyStats(snap.hierarchy),
    image: `data:image/png;base64,${snap.png!.toString('base64')}`,
  };
});
handle('currentScreen', (s: string) => dl.currentScreen(dev(s)));

// ---------- 입력 ----------
handle('tap', (s: string, x: number, y: number) => dl.tap(dev(s), x, y));
handle('longPress', (s: string, x: number, y: number) => dl.longPress(dev(s), x, y));
handle('swipe', (s: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => dl.swipe(dev(s), x1, y1, x2, y2, ms));
handle('key', (s: string, key: keyof typeof dl.KEYCODES) => dl.pressKey(dev(s), key));
handle('typeText', (s: string, t: string) => dl.typeText(dev(s), t));

// ---------- 녹화 ----------
const recs = new Map<string, dl.Recording>();
handle('recordStart', async (s: string) => {
  if (recs.has(s)) throw new Error('이미 녹화 중입니다');
  recs.set(s, dl.startRecording(dev(s)));
  return Date.now();
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
handle('deeplink', (s: string, uri: string, pkg?: string) => dl.openDeepLink(dev(s), uri, pkg));
handle('analyzeLibraries', async (s: string, pkg: string) => {
  send('progress', { kind: 'libs', message: 'APK 내려받는 중…' });
  const dir = await dl.ensureDir('apks', dl.safeName(pkg));
  const apks = await dl.pullApk(dev(s), pkg, dir);
  send('progress', { kind: 'libs', message: 'DEX 분석 중…' });
  return dl.analyzeApk(apks, pkg);
});
handle('crashes', (s: string, pkg?: string) => dl.recentCrashes(dev(s), pkg));

// ---------- logcat ----------
let logStream: { stop(): void } | null = null;
handle('logcatStart', async (s: string, pkg?: string) => {
  logStream?.stop();
  const pid = pkg ? await dl.pidOf(dev(s), pkg) : undefined;
  if (pkg && !pid) throw new Error(`${pkg} 프로세스가 실행 중이 아닙니다`);
  let batch: dl.LogLine[] = [];
  const timer = setInterval(() => {
    if (batch.length) send('logcat', batch.splice(0));
  }, 200);
  const st = dl.streamLogcat(dev(s), (l) => batch.push(l), { pid });
  logStream = {
    stop: () => {
      clearInterval(timer);
      st.stop();
    },
  };
  return pid ?? null;
});
handle('logcatStop', async () => {
  logStream?.stop();
  logStream = null;
});

// ---------- 화면 그래프 ----------
handle('graphGet', async (pkg: string) => (await dl.ScreenGraph.open(pkg)).toJSON());
handle('graphImage', async (pkg: string, file: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  return `data:image/png;base64,${(await readFile(join(g.dir, file))).toString('base64')}`;
});
handle('graphRecordTap', async (s: string, pkg: string, x: number, y: number, label?: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  const r = await dl.recordTransition(dev(s), g, { type: 'tap', x, y, label });
  return { from: r.from.id, to: r.to.id, isNew: r.to.visits === 1 };
});
handle('graphRecordKey', async (s: string, pkg: string, key: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  const r = await dl.recordTransition(dev(s), g, { type: 'key', key });
  return { from: r.from.id, to: r.to.id, isNew: r.to.visits === 1 };
});
handle('graphRecordHere', async (s: string, pkg: string) => {
  const g = await dl.ScreenGraph.open(pkg);
  const n = await g.addSnapshot(await dl.captureSnapshot(dev(s)));
  await g.save();
  return n.id;
});
let exploreAbort: AbortController | null = null;
handle('explore', async (s: string, pkg: string, maxSteps: number, maxDepth: number) => {
  exploreAbort?.abort();
  exploreAbort = new AbortController();
  const r = await dl.explore(dev(s), {
    packageName: pkg,
    maxSteps,
    maxDepth,
    signal: exploreAbort.signal,
    onProgress: (e) => send('progress', { kind: 'explore', ...e }),
  });
  exploreAbort = null;
  return { steps: r.steps, skipped: r.skipped, errors: r.errors };
});
handle('exploreStop', async () => exploreAbort?.abort());

// ---------- 기타 ----------
handle('reveal', async (p: string) => shell.showItemInFolder(p));
handle('openPath', async (p: string) => shell.openPath(p));
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
handle('scenarioImage', async (dir: string, file: string) =>
  `data:image/png;base64,${(await readFile(join(dir, file))).toString('base64')}`,
);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  logStream?.stop();
  app.quit();
});
