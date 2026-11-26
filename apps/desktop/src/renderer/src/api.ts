import type {
  ApkAnalysis,
  ClaudeAuthStatus,
  AppInfo,
  CurrentScreen,
  DeviceInfo,
  DeviceSummary,
  GraphAction,
  GraphData,
  Hierarchy,
  Interaction,
  LogLine,
  PackageSummary,
  PerfSample,
  QaCase,
  QaPlan,
  QaPlanSummary,
  QaPlanDeleteInfo,
  QaPlanDeleteResult,
  QaRun,
  QaRunSummary,
  QaRunIndexItem,
  DesignRunSummary,
  ScenarioData,
  StartupResult,
  hierarchyStats,
  qaCoverage,
  qaReviewList,
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

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes?: string;
  url: string;
  canInstall: boolean;
  reason?: string;
}

export interface AgentStatus {
  installed?: number;
  expected?: number;
  error?: string;
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
  /** 앱이 claude 를 실행할 때 쓰는 로그인 (#120) */
  auth: ClaudeAuthStatus;
  /** 그 로그인이 쓰는 설정 폴더 */
  configDir: string;
  /** 설정에서 직접 고른 폴더 (비면 기본) */
  configDirSetting: string;
  /** 다시 로그인하는 명령 */
  loginCommand: string;
}

export type ChatEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'toolResult'; id: string; text: string; isError: boolean }
  | { kind: 'done'; sessionId?: string; costUsd?: number; durationMs?: number; error?: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'confirm'; id: string; what: string; serial?: string; app?: string; tool?: string; timeoutMs: number }
  | { kind: 'confirmClosed'; id: string; reason: 'timeout' | 'cancelled' };
/** 메인이 보내는 대화 이벤트. run 은 보낼 때 준 실행 번호 */
export type ChatMessage = ChatEvent & { run: number };

export interface ScriptEntry {
  file: string;
  name: string;
  app?: string;
  steps?: number;
  error?: string;
}
export interface ScriptRunResult {
  file: string;
  verdict: 'pass' | 'fail' | 'blocked';
  passed?: number;
  failed?: number;
  skipped?: number;
  durationMs?: number;
  report?: string;
  error?: string;
}
export type ScriptProgress =
  | { kind: 'script'; file: string; index: number; total: number }
  | { kind: 'step'; file: string; index: number; total: number; title: string; status: 'running' | 'pass' | 'fail' | 'skip'; detail?: string };

export interface QaPlanView {
  plan: QaPlan;
  coverage: ReturnType<typeof qaCoverage>;
  review: ReturnType<typeof qaReviewList>;
  /** 회차 id (최근 것부터) */
  runs: string[];
}
export interface QaRunView {
  run: QaRun;
  summary: QaRunSummary;
  design: Record<string, DesignRunSummary>;
  /** 결과표 파일 (아직 만들지 않았으면 없음) */
  files?: { html: string; csv: string; junit: string };
}
export interface QaSourceAdded {
  id?: string;
  title: string;
  duplicate?: boolean;
  warnings?: string[];
  error?: string;
  /** TC 표를 알아보고 원문 그대로 가져온 결과 (#129) */
  tcImport?: { cases: number; warnings: string[] };
  /** 머리글을 못 알아본 표: 열 고르기 후보 */
  tcTables?: { sheet: string; headerRow: number; headers: string[]; guess: Record<string, number | undefined> }[];
}
export type QaJobKind = 'extract' | 'run';
export type QaEvent =
  | { kind: 'job'; job: QaJobKind; plan: string; state: 'start' }
  | { kind: 'job'; job: QaJobKind; plan: string; state: 'end'; run?: string; error?: string; cancelled?: boolean }
  | { kind: 'run'; plan: string; run: string }
  | { kind: 'case'; plan: string; case: string; mode: 'script' | 'agent'; index: number; total: number }
  | { kind: 'step'; plan: string; case: string; title: string; status: 'running' | 'pass' | 'fail' | 'skip'; detail?: string }
  | { kind: 'agent'; plan: string; case?: string; event: ChatEvent };

export interface Progress {
  kind: 'libs' | 'explore' | 'avd';
  message: string;
  /** libs: 분석 중인 앱 */
  pkg?: string;
  step?: number;
  screen?: string;
}

export const api = {
  devices: () => call<DeviceSummary[]>('devices'),
  avds: () => call<{ available: boolean; avds: { name: string; serial?: string }[] }>('avds'),
  avdStart: (name: string) => call<string>('avdStart', name),
  avdStop: (s: string) => call<void>('avdStop', s),
  deviceInfo: (s: string) => call<DeviceInfo>('deviceInfo', s),
  screenshot: (s: string) => call<string>('screenshot', s),
  screenshotPng: (s: string) => call<Uint8Array>('screenshotPng', s),
  saveScreenshot: (s: string, label?: string) => call<string>('saveScreenshot', s, label),
  snapshot: (s: string) => call<SnapshotDTO>('snapshot', s),
  currentScreen: (s: string) => call<CurrentScreen>('currentScreen', s),
  tap: (s: string, x: number, y: number) => call<void>('tap', s, x, y),
  longPress: (s: string, x: number, y: number) => call<void>('longPress', s, x, y),
  swipe: (s: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => call<void>('swipe', s, x1, y1, x2, y2, ms),
  key: (s: string, key: string) => call<void>('key', s, key),
  typeText: (s: string, t: string) => call<void>('typeText', s, t),
  /** 이 기기에서 진행 중인 녹화의 시작 시각 (없으면 null) */
  recordStatus: (s: string) => call<number | null>('recordStatus', s),
  recordStart: (s: string) => call<number>('recordStart', s),
  recordStop: (s: string) => call<string>('recordStop', s),
  packages: (s: string, thirdPartyOnly: boolean) => call<PackageSummary[]>('packages', s, thirdPartyOnly),
  appInfo: (s: string, pkg: string) => call<AppInfo>('appInfo', s, pkg),
  launch: (s: string, pkg: string, restart?: boolean) => call<void>('launch', s, pkg, restart),
  bringToFront: (s: string, pkg: string) => call<void>('bringToFront', s, pkg),
  stop: (s: string, pkg: string) => call<void>('stop', s, pkg),
  deeplink: (s: string, uri: string, pkg?: string) => call<string>('deeplink', s, uri, pkg),
  analyzeLibraries: (s: string, pkg: string) => call<ApkAnalysis>('analyzeLibraries', s, pkg),
  crashes: (s: string, pkg?: string) => call<string[]>('crashes', s, pkg),
  /** 앱이 떠 있지 않으면 null */
  perfSample: (s: string, pkg: string) => call<PerfSample | null>('perfSample', s, pkg),
  perfStartup: (s: string, pkg: string, cold: boolean, runs: number) => call<StartupResult>('perfStartup', s, pkg, cold, runs),
  perfResetFrames: (s: string, pkg: string) => call<void>('perfResetFrames', s, pkg),
  /** id: 이 스트림을 가리키는 번호 (로그·종료 이벤트에 그대로 실려 와 이전 스트림 것과 구분한다) */
  logcatStart: (s: string, pkg: string | undefined, id: number) => call<number | null>('logcatStart', s, pkg, id),
  logcatStop: (id?: number) => call<void>('logcatStop', id),
  graphGet: (pkg: string) => call<GraphData>('graphGet', pkg),
  graphImage: (pkg: string, file: string) => call<string>('graphImage', pkg, file),
  graphRecord: (s: string, pkg: string, action: GraphAction) =>
    call<{ recorded: false; skipped?: boolean } | { recorded: true; from: string; to: string; isNew: boolean }>('graphRecord', s, pkg, action),
  graphRecordHere: (s: string, pkg: string) => call<string>('graphRecordHere', s, pkg),
  explore: (s: string, pkg: string, req: { maxDepth: number; fromCurrent?: boolean; startAt?: string; only?: Interaction[]; allowDanger?: boolean }) =>
    call<{
      steps: number;
      limited: boolean;
      skipped: { screen: string; label: string; reason: string }[];
      errors: string[];
      touched: { nodes: string[]; edges: string[] };
      startScreen: string;
    }>('explore', s, pkg, req),
  graphNavigate: (s: string, pkg: string, target: string) => call<{ moved: boolean; steps: number }>('graphNavigate', s, pkg, target),
  graphExport: (pkg: string) => call<string | undefined>('graphExport', pkg),
  graphImport: (pkg: string) => call<{ nodes: number; edges: number; dropped: number } | undefined>('graphImport', pkg),
  exploreStop: () => call<void>('exploreStop'),
  graphReset: (pkg: string) => call<void>('graphReset', pkg),
  reveal: (p: string) => call<void>('reveal', p),
  openPath: (p: string) => call<string>('openPath', p),
  home: () => call<string>('home'),
  scenarios: () => call<ScenarioData[]>('scenarios'),
  scenarioImage: (dir: string, file: string) => call<string>('scenarioImage', dir, file),
  /** 스크린샷 비교 단계의 지금 화면(file)을 앱·이름의 기준 이미지로 저장하고 그 경로를 돌려준다 */
  baselineAccept: (dir: string, file: string, app: string, name: string) => call<string>('baselineAccept', dir, file, app, name),
  scenarioDelete: (ids: string[]) => call<void>('scenarioDelete', ids),
  agentStatus: (s: string) => call<AgentStatus>('agentStatus', s),
  agentStart: (s: string) => call<AgentStatus>('agentStart', s),
  agentStop: (s: string) => call<AgentStatus>('agentStop', s),
  /** id: 이 세션을 가리키는 번호 (이벤트에 그대로 실려 와 이전 세션 것과 구분한다) */
  mirrorStart: (s: string, maxSize: number | undefined, id: number) => call<boolean>('mirrorStart', s, maxSize, id),
  mirrorStop: (id?: number) => call<void>('mirrorStop', id),
  onMirrorSession: (fn: (p: { id: number; width: number; height: number }) => void) => window.dl.on('mirror:session', (p) => fn(p as never)),
  onMirrorPacket: (fn: (p: { id: number; data: Uint8Array; config: boolean; key: boolean; pts: number }) => void) =>
    window.dl.on('mirror:packet', (p) => fn(p as never)),
  onMirrorClosed: (fn: (p: { id: number; reason?: string }) => void) => window.dl.on('mirror:closed', (p) => fn(p as never)),
  scriptsList: () => call<ScriptEntry[]>('scriptsList'),
  scriptRead: (name: string) => call<string>('scriptRead', name),
  scriptWrite: (name: string, yaml: string) => call<string>('scriptWrite', name, yaml),
  scriptDelete: (name: string) => call<void>('scriptDelete', name),
  scriptRun: (s: string, names: string[]) => call<ScriptRunResult[]>('scriptRun', s, names),
  scriptStop: () => call<void>('scriptStop'),
  onScriptProgress: (fn: (p: ScriptProgress) => void) => window.dl.on('script:progress', (p) => fn(p as ScriptProgress)),
  chatStatus: () => call<{ version: string }>('chatStatus'),
  chatSend: (req: { runId: number; message: string; agent: string; sessionId?: string; serial?: string; packageName?: string }) => call<boolean>('chatSend', req),
  chatStop: () => call<void>('chatStop'),
  /** 되돌릴 수 없는 조작의 승인(true)·거부(false). 이미 끝난 요청이면 false */
  chatConfirm: (id: string, approve: boolean) => call<boolean>('chatConfirm', id, approve),
  onChatEvent: (fn: (e: ChatMessage) => void) => window.dl.on('chat:event', (p) => fn(p as ChatMessage)),
  sdkApps: (s: string) => call<string[]>('sdkApps', s),
  sdk: <T,>(s: string, pkg: string, method: string, ...args: unknown[]) => call<T>('sdk', s, pkg, method, ...args),
  updateCheck: () => call<UpdateInfo>('updateCheck'),
  updateInstall: (info: UpdateInfo) => call<void>('updateInstall', info),
  onUpdateProgress: (fn: (p: { p: number; message: string }) => void) => window.dl.on('update:progress', (x) => fn(x as never)),
  platform: () => call<{ platform: string; arch: string }>('platform'),
  appVersion: () => call<string>('appVersion'),
  adbStatus: () => call<AdbStatus>('adbStatus'),
  setAdbPath: (p: string) => call<AdbStatus>('setAdbPath', p),
  setTheme: (t: 'system' | 'light' | 'dark') => call<void>('setTheme', t),
  integration: () => call<Integration>('integration'),
  registerMcp: () => call<string>('registerMcp'),
  setClaudeConfigDir: (p: string) => call<void>('setClaudeConfigDir', p),
  installAgents: () => call<string[]>('installAgents'),
  copy: (t: string) => call<void>('copy', t),
  openExternal: (url: string) => call<void>('openExternal', url),
  onLogcat: (fn: (p: { id: number; lines: LogLine[] }) => void) => window.dl.on('logcat', (p) => fn(p as never)),
  onLogcatClosed: (fn: (p: { id: number }) => void) => window.dl.on('logcat:closed', (p) => fn(p as never)),
  onProgress: (fn: (p: Progress) => void) => window.dl.on('progress', (p) => fn(p as Progress)),
  qaPlans: () => call<QaPlanSummary[]>('qaPlans'),
  qaPlanCreate: (name: string, app?: string) => call<QaPlan>('qaPlanCreate', name, app),
  qaPlanGet: (id: string) => call<QaPlanView>('qaPlanGet', id),
  qaPlanRename: (id: string, name: string, app?: string) => call<QaPlan>('qaPlanRename', id, name, app),
  qaPlanDeleteInfo: (id: string) => call<QaPlanDeleteInfo>('qaPlanDeleteInfo', id),
  /** 계획 폴더를 지운다. withRecords 면 이 계획의 TC 기록·스크립트도 (#133) */
  qaPlanDelete: (id: string, withRecords: boolean) => call<QaPlanDeleteResult>('qaPlanDelete', id, withRecords),
  /** 파일 대화상자를 띄워 고른 문서를 넣는다 (취소하면 빈 목록) */
  qaSourcePick: (id: string) => call<QaSourceAdded[]>('qaSourcePick', id),
  qaSourceLink: (id: string, url: string) => call<QaSourceAdded>('qaSourceLink', id, url),
  qaTcImport: (id: string, source: string, pick: { sheet: string; headerRow: number; map: Record<string, number> }) =>
    call<{ cases: number; warnings: string[] }>('qaTcImport', id, source, pick),
  qaCaseUpdate: (id: string, caseId: string, patch: Partial<Omit<QaCase, 'suggested'>> & { suggested?: boolean }) => call<QaPlan>('qaCaseUpdate', id, caseId, patch),
  qaSelect: (id: string, caseIds: string[], on: boolean) => call<QaPlan>('qaSelect', id, caseIds, on),
  /** shown: 사람이 보고 허용한 TC 내용 (그사이 바뀌었으면 허용하지 않는다) */
  qaCaseAllow: (id: string, caseId: string, allow: boolean, shown?: QaCase) => call<QaPlan>('qaCaseAllow', id, caseId, allow, shown),
  qaJob: () => call<{ kind: QaJobKind; plan: string } | null>('qaJob'),
  qaExtract: (id: string, note?: string) => call<void>('qaExtract', id, note),
  qaRun: (id: string, opts: { serial: string; run?: string; recheckFailed?: boolean; timeoutMs?: number }) => call<void>('qaRun', id, opts),
  qaStop: () => call<void>('qaStop'),
  qaConfirm: (id: string, approve: boolean) => call<boolean>('qaConfirm', id, approve),
  qaRunGet: (id: string, runId: string) => call<QaRunView>('qaRunGet', id, runId),
  qaReport: (id: string, runId: string) => call<{ html: string; csv: string; junit: string }>('qaReport', id, runId),
  qaRunIndex: () => call<QaRunIndexItem[]>('qaRunIndex'),
  qaRunExport: (id: string, runId: string, kind: 'xlsx' | 'html', lang: 'ko' | 'en') => call<{ path: string; bytes: number }>('qaRunExport', id, runId, kind, lang),
  qaRunPreview: (id: string, runId: string, lang: 'ko' | 'en') => call<string>('qaRunPreview', id, runId, lang),
  onQaEvent: (fn: (e: QaEvent) => void) => window.dl.on('qa:event', (p) => fn(p as QaEvent)),
};

export type { ApkAnalysis, AppInfo, CurrentScreen, DeviceInfo, DeviceSummary, GraphAction, GraphData, Hierarchy, Interaction, LogLine, PackageSummary, ScenarioData };
export type { QaCase, QaPlan, QaPlanSummary, QaPlanDeleteInfo, QaRun, QaRunSummary, QaRunIndexItem, DesignRunSummary };
export type { ViewNode, ScreenNode, NetworkEntry, NetworkDetail, MockRule, PrefsFile, DbInfo, QueryResult, SdkEvent, SdkInfo, PerfSample, StartupResult } from '@droidlens/core';
