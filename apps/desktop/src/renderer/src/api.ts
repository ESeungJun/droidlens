import type {
  ApkAnalysis,
  AppInfo,
  CurrentScreen,
  DeviceInfo,
  DeviceSummary,
  GraphData,
  Hierarchy,
  LogLine,
  PackageSummary,
  ScenarioData,
  hierarchyStats,
} from '@droidlens/core';

declare global {
  interface Window {
    dl: {
      invoke(channel: string, ...args: unknown[]): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
      on(channel: string, fn: (payload: unknown) => void): () => void;
    };
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.dl.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

export interface SnapshotDTO {
  screen: CurrentScreen;
  hierarchy: Hierarchy;
  signature: string;
  stats: ReturnType<typeof hierarchyStats>;
  image: string;
}

export interface AgentStatus {
  installed?: number;
  running: boolean;
  apk?: string;
  disabled: boolean;
}

export interface AdbStatus {
  ok: boolean;
  path: string;
  version?: string;
  error?: string;
  candidates?: string[];
}

export interface Integration {
  mcpScript: string;
  mcpScriptExists: boolean;
  command: string;
  claudeVersion: string | null;
  registered: boolean;
  agents: { file: string; installed: boolean }[];
  agentsDir: string;
}

export interface Progress {
  kind: 'libs' | 'explore';
  message: string;
  step?: number;
  screen?: string;
}

export const api = {
  devices: () => call<DeviceSummary[]>('devices'),
  deviceInfo: (s: string) => call<DeviceInfo>('deviceInfo', s),
  screenshot: (s: string) => call<string>('screenshot', s),
  saveScreenshot: (s: string, label?: string) => call<string>('saveScreenshot', s, label),
  snapshot: (s: string) => call<SnapshotDTO>('snapshot', s),
  currentScreen: (s: string) => call<CurrentScreen>('currentScreen', s),
  tap: (s: string, x: number, y: number) => call<void>('tap', s, x, y),
  longPress: (s: string, x: number, y: number) => call<void>('longPress', s, x, y),
  swipe: (s: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => call<void>('swipe', s, x1, y1, x2, y2, ms),
  key: (s: string, key: string) => call<void>('key', s, key),
  typeText: (s: string, t: string) => call<void>('typeText', s, t),
  recordStart: (s: string) => call<number>('recordStart', s),
  recordStop: (s: string) => call<string>('recordStop', s),
  packages: (s: string, thirdPartyOnly: boolean) => call<PackageSummary[]>('packages', s, thirdPartyOnly),
  appInfo: (s: string, pkg: string) => call<AppInfo>('appInfo', s, pkg),
  launch: (s: string, pkg: string, restart?: boolean) => call<void>('launch', s, pkg, restart),
  stop: (s: string, pkg: string) => call<void>('stop', s, pkg),
  deeplink: (s: string, uri: string, pkg?: string) => call<string>('deeplink', s, uri, pkg),
  analyzeLibraries: (s: string, pkg: string) => call<ApkAnalysis>('analyzeLibraries', s, pkg),
  crashes: (s: string, pkg?: string) => call<string[]>('crashes', s, pkg),
  logcatStart: (s: string, pkg?: string) => call<number | null>('logcatStart', s, pkg),
  logcatStop: () => call<void>('logcatStop'),
  graphGet: (pkg: string) => call<GraphData>('graphGet', pkg),
  graphImage: (pkg: string, file: string) => call<string>('graphImage', pkg, file),
  graphRecordTap: (s: string, pkg: string, x: number, y: number, label?: string) =>
    call<{ from: string; to: string; isNew: boolean }>('graphRecordTap', s, pkg, x, y, label),
  graphRecordKey: (s: string, pkg: string, key: string) => call<{ from: string; to: string; isNew: boolean }>('graphRecordKey', s, pkg, key),
  graphRecordHere: (s: string, pkg: string) => call<string>('graphRecordHere', s, pkg),
  explore: (s: string, pkg: string, maxSteps: number, maxDepth: number) =>
    call<{ steps: number; skipped: { label: string }[]; errors: string[] }>('explore', s, pkg, maxSteps, maxDepth),
  exploreStop: () => call<void>('exploreStop'),
  reveal: (p: string) => call<void>('reveal', p),
  openPath: (p: string) => call<string>('openPath', p),
  home: () => call<string>('home'),
  scenarios: () => call<ScenarioData[]>('scenarios'),
  scenarioImage: (dir: string, file: string) => call<string>('scenarioImage', dir, file),
  agentStatus: (s: string) => call<AgentStatus>('agentStatus', s),
  agentStart: (s: string) => call<AgentStatus>('agentStart', s),
  agentStop: (s: string) => call<AgentStatus>('agentStop', s),
  sdkApps: (s: string) => call<string[]>('sdkApps', s),
  sdk: <T,>(s: string, pkg: string, method: string, ...args: unknown[]) => call<T>('sdk', s, pkg, method, ...args),
  appVersion: () => call<string>('appVersion'),
  adbStatus: () => call<AdbStatus>('adbStatus'),
  setAdbPath: (p: string) => call<AdbStatus>('setAdbPath', p),
  integration: () => call<Integration>('integration'),
  registerMcp: () => call<string>('registerMcp'),
  installAgents: () => call<string[]>('installAgents'),
  copy: (t: string) => call<void>('copy', t),
  openExternal: (url: string) => call<void>('openExternal', url),
  onLogcat: (fn: (lines: LogLine[]) => void) => window.dl.on('logcat', (p) => fn(p as LogLine[])),
  onProgress: (fn: (p: Progress) => void) => window.dl.on('progress', (p) => fn(p as Progress)),
};

export type { ApkAnalysis, AppInfo, CurrentScreen, DeviceInfo, DeviceSummary, GraphData, Hierarchy, LogLine, PackageSummary, ScenarioData };
export type { ViewNode, ScreenNode, NetworkEntry, NetworkDetail, PrefsFile, DbInfo, QueryResult, SdkEvent, SdkInfo } from '@droidlens/core';
