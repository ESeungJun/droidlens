import * as dl from '@droidlens/core';
import { dev, send, type Handle } from '../context';

/** 설치된 앱: 목록·정보·실행·딥링크·라이브러리 분석·크래시·성능 */
export function register(handle: Handle): void {
  handle('packages', (s: string, thirdPartyOnly: boolean) => dl.listPackages(dev(s), { thirdPartyOnly }));
  handle('appInfo', (s: string, pkg: string) => dl.appInfo(dev(s), pkg));
  handle('launch', (s: string, pkg: string, restart?: boolean) =>
    (restart ? dl.stopApp(dev(s), pkg) : Promise.resolve()).then(() => dl.launchApp(dev(s), pkg)),
  );
  handle('stop', (s: string, pkg: string) => dl.stopApp(dev(s), pkg));
  handle('bringToFront', (s: string, pkg: string) => dl.bringToFront(dev(s), pkg));
  handle('deeplink', (s: string, uri: string, pkg?: string) => dl.openDeepLink(dev(s), uri, pkg));
  handle('analyzeLibraries', async (s: string, pkg: string) => {
    send('progress', { kind: 'libs', message: 'APK 내려받는 중…', pkg });
    const dir = await dl.ensureDir('apks', dl.safeName(pkg));
    const apks = await dl.pullApk(dev(s), pkg, dir);
    send('progress', { kind: 'libs', message: 'DEX 분석 중…', pkg });
    return dl.analyzeApk(apks, pkg);
  });
  handle('crashes', (s: string, pkg?: string) => dl.recentCrashes(dev(s), pkg));
  handle('perfSample', async (s: string, pkg: string) => (await dl.perfSample(dev(s), pkg)) ?? null);
  handle('perfStartup', (s: string, pkg: string, cold: boolean, runs: number) => dl.measureStartup(dev(s), pkg, { cold, runs }));
  handle('perfResetFrames', (s: string, pkg: string) => dl.resetFrameStats(dev(s), pkg));
}
