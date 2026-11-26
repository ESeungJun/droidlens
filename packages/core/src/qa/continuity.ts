import type { Script } from '../script/schema.js';
import type { QaStatus } from './run.js';

/**
 * QA 회차를 빨리 돌리는 판단 (#130). 기기를 건드리지 않는 순수 함수만 둔다.
 *   needsRestart: 앞 TC 에 이어 앱 프로세스를 유지할지, 강제 종료 후 새로 띄울지
 *   unmetVersionCondition: TC 사전 조건의 앱 버전("13.9.0 미만")이 설치된 버전과 맞는지 실행 전에 본다
 */

// ── 재시작 판단 ──

/** 바로 앞에서 실행한 TC */
export interface PrevCaseRun {
  status: QaStatus;
  preconditions: readonly string[];
  /** 앱 데이터를 바꾸는 조작을 했는지 (데이터 지우기·Prefs·DB 쓰기·목·확인 필수 동작) */
  changedData: boolean;
}

/** 이제 실행할 TC */
export interface NextCaseRun {
  preconditions: readonly string[];
  /** 준비 단계가 데이터를 바꾸는지 (스크립트 setup 의 clearData·prefs·mocks) */
  changesData: boolean;
}

const condKey = (xs: readonly string[]) => JSON.stringify(xs.map((x) => x.trim()).filter(Boolean));

/**
 * 앱을 강제 종료하고 새로 띄워야 하는지.
 * 앞 TC 가 통과했고, 사전 조건이 같고, 앞 TC 와 이 TC 준비가 데이터를 바꾸지 않았을 때만 프로세스를 유지한다.
 * 실패·막힘 뒤에는 앞 TC 의 상태가 다음 판정에 섞이지 않게 늘 새로 띄운다
 */
export function needsRestart(prev: PrevCaseRun | undefined, next: NextCaseRun): boolean {
  if (!prev || prev.status !== 'pass') return true;
  if (prev.changedData || next.changesData) return true;
  return condKey(prev.preconditions) !== condKey(next.preconditions);
}

/** 스크립트 준비 단계가 앱 데이터를 바꾸는지. 목은 앱 안에 저장되고 재시작해야 적용된다 */
export function scriptSetupChangesData(setup: Script['setup']): boolean {
  return !!(setup?.clearData || setup?.prefs?.length || setup?.mocks?.length);
}

/** 늘 데이터를 바꾸는 DroidLens 도구 */
const DATA_TOOLS = new Set([
  'clear_app_data',
  'prefs_set',
  'prefs_remove',
  'network_mock_set',
  'network_mock_remove',
  // 앱을 바꾸거나, 스크립트 setup(clearData·prefs·mocks)·자동 탐색으로 무엇을 누를지 모른다
  'install_apk',
  'script_run',
  'suite_run',
  'explore',
]);

/**
 * 에이전트의 도구 호출 하나가 앱 데이터를 바꾸는지. DroidLens 도구(mcp__droidlens__ 또는 접두어 없는 이름)만 본다.
 * db_query 는 write=true, 기기를 누르는 도구는 allowDanger=true(확인 필수 동작을 실제로 누름)일 때
 */
export function changesAppData(name: string, input: unknown): boolean {
  const m = /^(?:mcp__droidlens__)?([a-z_]+)$/.exec(name);
  if (!m) return false;
  const tool = m[1];
  if (DATA_TOOLS.has(tool)) return true;
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'db_query') return a.write === true;
  return a.allowDanger === true;
}

// ── 앱 버전 사전 조건 ──

export type VersionOp = 'lt' | 'lte' | 'gt' | 'gte';

export interface VersionCondition {
  op: VersionOp;
  version: string;
  /** 사전 조건 원문 */
  text: string;
}

const VERSION = /(?<![\w.])v?\d+(?:\.\d+)+(?:-[\w.]+)?(?![\w.])/gi;
/** 앱이 아니라 OS·SDK 버전을 말하는 조건 ("Android 13", "안드로이드 12.1". "안드로이드 앱 13.9.0" 은 앱 버전) */
const NOT_APP = /(?:android|안드로이드)\s*\d|\bios\b|\bos\b|\bsdk\b|\bapi\b/i;
/** 대상 앱의 버전이라는 말. 없으면 다른 앱·서비스 버전이거나 버전이 아닌 숫자일 수 있다 ("Chrome 120.0 이상", "잔액 1.000.000 이상") */
const APP_WORD = /앱|버전|version|\bapp\b/i;
/** 비교 말 뒤에 붙는 부정 ("이하가 아닌", "미만이 아님") */
const NEGATED = /^\s*(?:버전\s*)?(?:미만|이하|초과|이상|부터|이후)(?:이|가)?\s*아[니닌님]/;
const AFTER: [RegExp, VersionOp][] = [
  [/^\s*(?:버전\s*)?미만/, 'lt'],
  [/^\s*(?:버전\s*)?이하/, 'lte'],
  [/^\s*(?:버전\s*)?초과/, 'gt'],
  [/^\s*(?:버전\s*)?(?:이상|부터|이후)/, 'gte'],
  [/^\s*(?:\+|or (?:later|higher|above|newer)|and (?:later|higher|above|up))/i, 'gte'],
  [/^\s*(?:or (?:lower|earlier|below|older)|and (?:lower|earlier|below))/i, 'lte'],
];
const BEFORE: [RegExp, VersionOp][] = [
  [/(?:>=|≥|at least)\s*$/i, 'gte'],
  [/(?:<=|≤|at most)\s*$/i, 'lte'],
  [/(?:<|below|under|less than|lower than|earlier than|older than|before)\s*$/i, 'lt'],
  [/(?:>|above|greater than|higher than|later than|newer than|after)\s*$/i, 'gt'],
];

/**
 * 사전 조건 한 줄에서 앱 버전 조건을 읽는다("13.9.0 미만", "앱 버전 13.10.0 이상", "app version >= 1.2.3").
 * 버전이 둘 이상이거나, 비교 말이 없거나, OS·SDK 버전이거나, "앱·버전·version" 도 v 접두도 없거나(다른 앱·서비스 버전일 수 있다),
 * 부정문("이하가 아닌", "not below")이면 애매해서 null (검사를 건너뛴다)
 */
export function parseVersionCondition(text: string): VersionCondition | null {
  if (!text || NOT_APP.test(text)) return null;
  const found = [...text.matchAll(VERSION)];
  if (found.length !== 1) return null;
  const m = found[0];
  const version = m[0].replace(/^v/i, '');
  if (!APP_WORD.test(text) && !/^v/i.test(m[0])) return null;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index! + m[0].length);
  if (NEGATED.test(after) || /\bnot\b/i.test(text)) return null;
  const op = AFTER.find(([re]) => re.test(after))?.[1] ?? BEFORE.find(([re]) => re.test(before))?.[1];
  return op ? { op, version, text } : null;
}

const versionParts = (v: string): number[] | null => {
  const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(v);
  return m ? m[1].split('.').map(Number) : null;
};

/** 버전 비교 (자리마다 숫자, 빈 자리는 0, 뒤 꼬리는 뺀다). 숫자로 시작하지 않으면 NaN */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const holds = (op: VersionOp, d: number) => (op === 'lt' ? d < 0 : op === 'lte' ? d <= 0 : op === 'gt' ? d > 0 : d >= 0);

/**
 * 설치된 앱 버전이 맞지 않는 첫 사전 조건. 다 맞거나, 읽을 수 있는 버전 조건이 없거나, 설치 버전을 모르면 null
 */
export function unmetVersionCondition(preconditions: readonly string[], installed: string | undefined): VersionCondition | null {
  if (!installed || !versionParts(installed)) return null;
  for (const p of preconditions) {
    const c = parseVersionCondition(p);
    if (!c) continue;
    const d = compareVersions(installed, c.version);
    if (!Number.isNaN(d) && !holds(c.op, d)) return c;
  }
  return null;
}
