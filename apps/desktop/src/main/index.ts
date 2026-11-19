import { app, BrowserWindow, nativeTheme } from 'electron';
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as dl from '@droidlens/core';
import { stopChat } from './chat';
import { debug, getWindow, handle, readConfig, resourcePath, setWindow, windowBackground } from './context';
import * as appIpc from './ipc/app';
import * as chatIpc from './ipc/chat';
import * as deviceIpc from './ipc/device';
import * as filesIpc from './ipc/files';
import * as graphIpc from './ipc/graph';
import * as logcatIpc from './ipc/logcat';
import * as mirrorIpc from './ipc/mirror';
import * as recordIpc from './ipc/record';
import * as scriptIpc from './ipc/script';
import * as sdkIpc from './ipc/sdk';
import * as settingsIpc from './ipc/settings';
import { checkForUpdate, cleanupOldUpdates, installUpdate } from './updater';

/**
 * main 프로세스 입구: 창 만들기·수명 주기·IPC 등록·종료 정리.
 * 렌더러가 부르는 채널은 기능별로 ipc/*.ts 에 있다 (preload/index.ts 의 INVOKE 목록에도 넣어야 화면에서 부를 수 있다).
 * 공용 도구(handle·send·dev·adb·입력 순서·경로·설정 파일)는 context.ts.
 */

function createWindow(): void {
  const win = new BrowserWindow({
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
  setWindow(win);
  // 개발용: DROIDLENS_OPEN="tab=network&pkg=com.example"로 시작 탭/앱 지정,
  // DROIDLENS_SNAPSHOT=<png 경로>면 로드 후 화면을 캡처해 저장하고 종료 (UI 자동 확인용)
  const hash = process.env.DROIDLENS_OPEN ?? '';
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  const snapshotPath = process.env.DROIDLENS_SNAPSHOT;
  if (snapshotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await getWindow()!.webContents.capturePage();
        await import('node:fs/promises').then((fs) => fs.writeFile(snapshotPath, img.toPNG()));
        app.quit();
      }, Number(process.env.DROIDLENS_SNAPSHOT_DELAY ?? 8000));
    });
  }
  win.on('closed', () => setWindow(null));
  // 앱 화면 밖으로의 이동·새 창을 막는다 (외부 링크는 openExternal IPC로만, https만 허용)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
  if (process.env.DROIDLENS_DEBUG) win.webContents.on('console-message', (e) => debug('renderer', e.level, e.message));
}

// ---------- IPC 등록 ----------
for (const m of [deviceIpc, mirrorIpc, recordIpc, appIpc, logcatIpc, graphIpc, sdkIpc, scriptIpc, chatIpc, filesIpc, settingsIpc]) m.register(handle);

/** 번들된 에이전트 APK를 ~/.droidlens/agent로 복사해 MCP 서버(별도 프로세스)도 쓸 수 있게 한다 */
async function installAgentApk(): Promise<void> {
  const src = app.isPackaged
    ? resourcePath('agent', 'droidlens-agent.apk')
    : resourcePath('android', 'agent', 'build', 'outputs', 'apk', 'release', 'agent-release.apk');
  if (!existsSync(src)) return;
  const dir = await dl.ensureDir('agent');
  await copyFile(src, join(dir, 'droidlens-agent.apk'));
}

app.whenReady().then(async () => {
  const { theme } = await readConfig().catch(() => ({}) as Record<string, unknown>);
  if (settingsIpc.isThemeSource(theme)) nativeTheme.themeSource = theme;
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
  logcatIpc.stop();
  mirrorIpc.stop();
  recordIpc.stop();
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
