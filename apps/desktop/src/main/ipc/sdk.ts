import * as dl from '@droidlens/core';
import { dev, type Handle } from '../context';

/** 앱에 들어간 DroidLens SDK: 네트워크·목·Prefs·DB·이벤트. 렌더러는 아래 목록의 메서드만 부를 수 있다 */
const SDK_METHODS = ['info', 'network', 'networkDetail', 'clearNetwork', 'mocks', 'setMock', 'removeMock', 'clearMocks', 'prefs', 'setPref', 'removePref', 'databases', 'query', 'events'] as const;

export function register(handle: Handle): void {
  handle('sdkApps', (s: string) => dl.listSdkApps(dev(s)));
  handle('sdk', async (s: string, pkg: string, method: (typeof SDK_METHODS)[number], ...args: unknown[]) => {
    if (!SDK_METHODS.includes(method)) throw new Error(`지원하지 않는 SDK 메서드: ${method}`);
    const c = await dl.sdkFor(dev(s), pkg);
    return (c[method] as (...a: unknown[]) => Promise<unknown>).apply(c, args);
  });
}
