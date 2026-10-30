import { contextBridge, ipcRenderer } from 'electron';

/**
 * 렌더러가 부를 수 있는 채널. 화면(renderer/src/api.ts)이 실제로 쓰는 것만 열어 둔다.
 * 메인에 handle 을 추가하고 화면에서 쓰려면 여기에도 넣어야 한다 (빠뜨리면 '허용되지 않은 채널' 에러)
 */
const INVOKE = new Set([
  'adbStatus', 'agentStart', 'agentStatus', 'agentStop', 'analyzeLibraries', 'appInfo', 'appVersion', 'avds', 'avdStart', 'avdStop', 'baselineAccept',
  'bringToFront', 'chatSend', 'chatStatus', 'chatStop', 'copy', 'crashes', 'currentScreen', 'deeplink', 'deviceInfo', 'devices',
  'explore', 'exploreStop', 'graphExport', 'graphGet', 'graphImage', 'graphImport', 'graphNavigate', 'graphRecord', 'graphRecordHere',
  'graphReset', 'home', 'installAgents', 'integration', 'key', 'launch', 'logcatStart', 'logcatStop', 'longPress', 'mirrorStart',
  'mirrorStop', 'openExternal', 'openPath', 'packages', 'perfResetFrames', 'perfSample', 'perfStartup', 'platform', 'recordStart', 'recordStatus', 'recordStop', 'registerMcp', 'reveal',
  'saveScreenshot', 'scenarioDelete', 'scenarioImage', 'scenarios', 'screenshot', 'screenshotPng', 'scriptDelete', 'scriptRead',
  'scriptRun', 'scriptsList', 'scriptStop', 'scriptWrite', 'sdk', 'sdkApps', 'setAdbPath', 'setTheme', 'snapshot', 'stop', 'swipe', 'tap',
  'typeText', 'updateCheck', 'updateInstall',
]);
/** 메인이 보내는 이벤트 채널 */
const EVENTS = new Set([
  'chat:event', 'logcat', 'logcat:closed', 'mirror:closed', 'mirror:packet', 'mirror:session', 'progress', 'script:progress', 'update:progress',
]);

contextBridge.exposeInMainWorld('dl', {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) return Promise.resolve({ ok: false, error: `허용되지 않은 채널: ${channel}` });
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, fn: (payload: unknown) => void) => {
    if (!EVENTS.has(channel)) throw new Error(`허용되지 않은 채널: ${channel}`);
    const listener = (_e: unknown, payload: unknown) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
