import { app, ipcMain, nativeTheme, type BrowserWindow } from 'electron';
import { join, resolve } from 'node:path';
import * as dl from '@droidlens/core';

/**
 * main 프로세스의 공용 도구. 기능별 IPC 파일(ipc/*.ts)과 index.ts 가 함께 쓴다.
 * 바뀌는 값(adb·창)은 변수로 내보내지 않고 함수로만 읽는다 (설정에서 adb 를 바꿔 끼워도 옛 값을 쥐지 않게).
 */

// ---------- adb · 기기 ----------
let adbInstance = new dl.Adb();
export const adb = () => adbInstance;
/** 설정에서 adb 경로를 바꾼 뒤 새로 만든다 */
export function resetAdb(): dl.Adb {
  adbInstance = new dl.Adb();
  return adbInstance;
}
export const dev = (serial: string) => adbInstance.device(serial);

// ---------- 창 · 렌더러로 보내기 ----------
let win: BrowserWindow | null = null;
export const getWindow = () => win;
export const setWindow = (w: BrowserWindow | null) => {
  win = w;
};
/** 화면이 뜨기 전 창 배경. renderer/src/tokens.css 의 --bg 와 같은 색 */
export const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0e0f12' : '#f4f5f7');

export const debug = process.env.DROIDLENS_DEBUG ? (...a: unknown[]) => console.log('[droidlens]', ...a) : () => undefined;
export const send = (channel: string, payload: unknown) => {
  // 디버그가 꺼져 있을 때는 직렬화하지 않는다 (logcat 묶음·대화 이벤트마다 JSON.stringify 가 한 번씩 더 돌았다)
  if (process.env.DROIDLENS_DEBUG && channel !== 'mirror:packet') debug('send', channel, JSON.stringify(payload)?.slice(0, 200));
  win?.webContents.send(channel, payload);
};

// ---------- IPC 등록 ----------
export type Handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>) => void;

/** 핸들러 에러를 { error } 로 감싸 렌더러가 메시지를 보여줄 수 있게 한다 */
export const handle: Handle = (channel, fn) => {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...(args as Parameters<typeof fn>)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
};

// ---------- 입력 순서 ----------
// 화면 탭은 응답을 기다리지 않고 조작을 연달아 보내므로, 기기에는 들어온 순서대로 하나씩 보낸다
let inputChain: Promise<unknown> = Promise.resolve();
export const inOrder = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = inputChain.then(fn);
  inputChain = p.catch(() => undefined);
  return p;
};

// ---------- 경로 ----------
export const resourcePath = (...p: string[]) =>
  app.isPackaged ? join(process.resourcesPath, ...p) : resolve(app.getAppPath(), '../..', ...p);
export const mcpScript = () =>
  app.isPackaged ? resourcePath('mcp', 'droidlens-mcp.mjs') : resourcePath('packages', 'mcp', 'dist', 'droidlens-mcp.mjs');
export const agentsSrc = () => resourcePath('agents');

// ---------- 설정 파일 (~/.droidlens/config.json) ----------
const configPath = () => join(dl.droidlensHome(), 'config.json');
export const readConfig = async () => (await dl.readJson<Record<string, unknown>>(configPath())) ?? {};
export async function updateConfig(patch: Record<string, unknown>): Promise<void> {
  const cfg = { ...(await readConfig()), ...patch };
  await dl.ensureDir();
  await dl.writeJson(configPath(), cfg);
}
