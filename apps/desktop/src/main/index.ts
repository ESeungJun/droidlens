import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { exec, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import * as dl from '@droidlens/core';

let adb = new dl.Adb();
const run = promisify(execFile);
const runShell = promisify(exec);
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
handle('tap', (s: string, x: number, y: number) => dl.tap(dev(s), x, y));
handle('longPress', (s: string, x: number, y: number) => dl.longPress(dev(s), x, y));
handle('swipe', (s: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => dl.swipe(dev(s), x1, y1, x2, y2, ms));
handle('key', (s: string, key: keyof typeof dl.KEYCODES) => dl.pressKey(dev(s), key));
handle('typeText', (s: string, t: string) => dl.typeText(dev(s), t));

// ---------- 고프레임 미러링 (scrcpy) ----------
let mirror: { serial: string; m: dl.Mirror } | null = null;
const scrcpyServer = () =>
  app.isPackaged ? resourcePath('scrcpy', 'scrcpy-server') : resourcePath('vendor', 'scrcpy', 'scrcpy-server');
handle('mirrorStart', async (s: string, maxSize?: number) => {
  debug('mirrorStart', s, maxSize);
  mirror?.m.stop();
  mirror = null;
  if (!existsSync(scrcpyServer())) throw new Error('scrcpy 서버 파일이 없습니다 (node scripts/fetch-scrcpy.mjs)');
  const m = await dl.startMirror(
    dev(s),
    {
      onSession: (width, height) => send('mirror:session', { width, height }),
      // Buffer는 구조화 복제로 Uint8Array가 된다
      onPacket: (p) => (debug('packet', p.data.length, p.config ? 'config' : '', p.key ? 'key' : ''), send('mirror:packet', { data: p.data, config: p.config, key: p.key, pts: Number(p.pts) })),
      onClose: (reason) => {
        if (mirror?.m === m) mirror = null;
        send('mirror:closed', { reason });
      },
    },
    { serverPath: scrcpyServer(), maxSize: maxSize ?? 1280 },
  );
  mirror = { serial: s, m };
  debug('mirror connected');
  return true;
});
handle('mirrorStop', async () => {
  debug('mirrorStop');
  mirror?.m.stop();
  mirror = null;
});

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
  return `data:image/png;base64,${(await readFile(join(g.dir, basename(file)))).toString('base64')}`;
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
  const n = await g.addSnapshot(await dl.captureSnapshot(dev(s)), dev(s));
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

// ---------- 앱 SDK ----------
const SDK_METHODS = ['info', 'network', 'networkDetail', 'clearNetwork', 'prefs', 'setPref', 'removePref', 'databases', 'query', 'events'] as const;
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
  if (process.platform === 'win32') {
    // cmd.exe가 해석하므로 공백·따옴표가 있는 인자만 큰따옴표로 감싼다
    const line = ['claude', ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
    const { stdout } = await runShell(line, { timeout: 30_000 });
    return stdout;
  }
  // -i: .zshrc/.bashrc에 PATH를 둔 경우까지 반영
  const sh = process.env.SHELL || '/bin/zsh';
  const { stdout } = await run(sh, ['-ilc', ['claude', ...args].map(q).join(' ')], { timeout: 30_000 });
  return stdout;
}

handle('appVersion', async () => app.getVersion());
handle('adbStatus', async () => ({ ...(await adb.version()), candidates: dl.adbCandidates() }));
handle('setAdbPath', async (p: string) => {
  const cfgPath = join(dl.droidlensHome(), 'config.json');
  const cfg = (await dl.readJson<Record<string, unknown>>(cfgPath)) ?? {};
  cfg.adbPath = p || undefined;
  await dl.ensureDir();
  await dl.writeJson(cfgPath, cfg);
  adb = new dl.Adb();
  return adb.version();
});
handle('integration', async () => {
  const src = agentsSrc();
  const agents = existsSync(src) ? (await readdir(src)).filter((f) => f.endsWith('.md')) : [];
  let claudeVersion: string | null = null;
  let registered = false;
  try {
    claudeVersion = (await runClaude(['--version'])).trim();
    registered = /droidlens/.test(await runClaude(['mcp', 'list']).catch(() => ''));
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

app.whenReady().then(() => {
  installAgentApk().catch(() => undefined);
  createWindow();
});
app.on('window-all-closed', () => {
  logStream?.stop();
  mirror?.m.stop();
  app.quit();
});
