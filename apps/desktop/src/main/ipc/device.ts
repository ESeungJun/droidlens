import { join } from 'node:path';
import * as dl from '@droidlens/core';
import { adb, dev, inOrder, send, type Handle } from '../context';

/** 기기·가상 기기·화면 읽기·입력 */
export function register(handle: Handle): void {
  // ---------- 기기 / 화면 ----------
  handle('devices', () => dl.listDevices(adb()));
  // 가상 기기 (이미 만든 AVD 실행·종료)
  handle('avds', () => dl.listAvds(adb()));
  handle('avdStart', (name: string) => dl.startAvd(adb(), name, { onProgress: (message) => send('progress', { kind: 'avd', message }) }));
  handle('avdStop', (s: string) => dl.stopAvd(adb(), s));
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
  handle('tap', (s: string, x: number, y: number) => inOrder(() => dl.tap(dev(s), x, y)));
  handle('longPress', (s: string, x: number, y: number) => inOrder(() => dl.longPress(dev(s), x, y)));
  handle('swipe', (s: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => inOrder(() => dl.swipe(dev(s), x1, y1, x2, y2, ms)));
  handle('key', (s: string, key: keyof typeof dl.KEYCODES) => inOrder(() => dl.pressKey(dev(s), key)));
  handle('typeText', (s: string, t: string) => inOrder(() => dl.typeText(dev(s), t)));
}
