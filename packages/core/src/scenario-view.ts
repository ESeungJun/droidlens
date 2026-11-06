/**
 * 시나리오 기록을 사람이 읽는 모양으로 정리한다 (HTML 리포트와 데스크톱 시나리오 탭이 같이 쓴다).
 * 브라우저에서도 돌아야 하므로 node 모듈을 가져오지 않는다.
 *
 * 정리 규칙
 * - 앞 단계를 바로잡은 단계(corrects)는 따로 보이지 않고 원래 단계에 합쳐 "정정 → 통과"로 보인다
 * - 사람이 다시 봐야 할 단계(실패·정정·다른 앱 화면·건너뜀)를 "확인할 것"으로 뽑는다
 * - 단계 제목의 "조작 → 확인" 을 나누고, detail 의 "기대: … / 실제: …" 를 칸으로 뽑는다
 */

export type StepStatus = 'pass' | 'fail' | 'info' | 'skip';

/** 단계 사이에 실제로 한 조작 하나 (tap·입력·스와이프 등) */
export interface ScenarioAction {
  at: number;
  text: string;
}

export interface ScenarioStep {
  index: number;
  at: number;
  title: string;
  status: StepStatus;
  detail?: string;
  screenshot?: string;
  screen?: string;
  /** 스크린샷을 찍은 순간 앞 화면이 대상 앱이 아니었으면 그 패키지 (시스템 대화상자·다른 앱이 가린 경우) */
  foreign?: string;
  /** 직전 단계 이후 이 단계까지 한 조작 */
  actions?: ScenarioAction[];
  /** 판정 방식과 기대·실제. assert 로 DroidLens 가 판정했으면 by='assert', 에이전트가 직접 판정했으면 'agent' */
  check?: { by: 'assert' | 'agent'; expect?: string; actual?: string };
  /** 이 단계가 앞 단계(번호)의 판정을 바로잡는다 */
  corrects?: number;
  /** 스크린샷 비교 단계: 어느 기준 이미지와 비교했는지와 지금 화면 파일 (screenshot 은 차이 이미지). 기준으로 받아들일 때 쓴다 */
  baseline?: { app: string; name: string; actual: string };
}

export interface ScenarioData {
  id: string;
  name: string;
  goal?: string;
  packageName?: string;
  device?: string;
  startedAt: number;
  finishedAt?: number;
  verdict?: 'pass' | 'fail' | 'blocked';
  summary?: string;
  steps: ScenarioStep[];
  /** 시나리오 전체 조작 로그 (시간순) */
  actions?: ScenarioAction[];
  dir: string;
}

/** 앱 위를 가리는 것으로 알려진 시스템 창 (에이전트 설치 때 뜨는 Play 프로텍트 등) */
export const BLOCKING_PACKAGES = [
  'com.google.android.finsky',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
];

export function isBlockingPackage(pkg: string | undefined): boolean {
  return !!pkg && BLOCKING_PACKAGES.includes(pkg);
}

export type ReasonCode = 'foreign' | 'overridden' | 'corrected' | 'fail' | 'skip';

/** 사람이 다시 봐야 하는 이유 하나. label 은 고정 문구라 화면에서 번역할 수 있다 */
export interface Reason {
  code: ReasonCode;
  label: string;
  why?: string;
}

export const REASON_LABEL: Record<ReasonCode, string> = {
  foreign: '판정 근거 스샷이 앱 화면이 아닙니다',
  overridden: '자동 검사 실패를 통과로 바꿨습니다',
  corrected: '판정을 바로잡았습니다',
  fail: '실패',
  skip: '건너뜀',
};

export interface StepRow {
  /** 화면에 보이는 번호 (정정 단계를 합친 뒤 1부터) */
  no: number;
  /** 기록상 단계 번호 */
  index: number;
  /** 최종 판정 (정정됐으면 마지막 정정의 판정) */
  status: StepStatus;
  /** 다른 단계가 이 단계 판정을 바로잡았으면 그 내용. 정정을 다시 정정한 경우 마지막 것 */
  corrected?: { from: StepStatus; byIndex: number; times: number; note?: string; screenshot?: string };
  how: 'assert' | 'agent' | 'record' | 'action';
  /** 이 단계(와 정정 단계)까지 한 조작. 예전 기록은 제목에서 뽑아 at 이 없다 */
  actions: { at?: number; text: string }[];
  /** 확인한 것. 조작만 한 단계는 빈 문자열 */
  check: string;
  expect?: string;
  actual?: string;
  /** actual 이 기대와 어긋난 값인지 (실패 칸으로 칠한다) */
  actualBad?: boolean;
  /** 근거 글 (에이전트 detail + 화면 이름) */
  evidence?: string;
  screenshot?: string;
  foreign?: string;
  baseline?: ScenarioStep['baseline'];
  at: number;
  reasons: Reason[];
  /** 행 강조: bad = 실패·다른 앱 화면, flag = 확인할 것 */
  tone: '' | 'flag' | 'bad';
}

export interface Attention {
  no: number;
  index: number;
  title: string;
  reasons: Reason[];
}

export type TallyKey = 'auto' | 'manual' | 'action' | 'fail' | 'corrected' | 'skip' | 'info' | 'noShot';
export type Tone = 'pass' | 'info' | 'fail' | 'warn' | 'mute';

export const TALLY: { key: TallyKey; label: string; tone: Tone }[] = [
  { key: 'auto', label: '자동 검사 통과', tone: 'pass' },
  { key: 'manual', label: '직접 판정 통과', tone: 'info' },
  { key: 'action', label: '조작 단계', tone: 'mute' },
  { key: 'fail', label: '실패', tone: 'fail' },
  { key: 'corrected', label: '정정', tone: 'warn' },
  { key: 'skip', label: '건너뜀', tone: 'mute' },
  { key: 'info', label: '진행 기록', tone: 'mute' },
  { key: 'noShot', label: '스샷 없음', tone: 'mute' },
];

export interface ScenarioView {
  verdict: 'pass' | 'fail' | 'blocked' | 'running';
  /** corrected 는 다른 칸과 겹칠 수 있다 (정정 끝에 실패한 단계는 실패에도 센다) */
  counts: Record<TallyKey, number>;
  /** 0 이 아닌 집계만, 표시 순서대로 */
  tally: { key: TallyKey; label: string; tone: Tone; count: number }[];
  attention: Attention[];
  rows: StepRow[];
  durationMs?: number;
}

const CORRECTION_TITLE = /^\s*\(\s*(?:step|단계)\s*(\d+)\s*정정\s*\)\s*/i;
const EXPECT_ACTUAL = /^기대:\s*(.+?)\s*\/\s*실제:\s*(.+)$/;
/** evaluateAssertion 이 통과 근거로 남기는 줄 (예전 기록 해석에만 쓴다) */
const EVIDENCE_LINE = /^(보임|안 보임|크래시 없음|화면|텍스트|요청|이벤트|메모리|버벅인 프레임)(?=[:\s]|$)/;
/** evaluateAssertion 실패 문구의 기대 부분 (셀렉터 표기). 예전 기록에서 자동 검사 실패와 직접 쓴 "기대/실제"를 가른다 */
const ASSERT_EXPECT = /^(?:(?:id|text|textContains|desc|descContains|className)=|이벤트 |\S*\.\S+ = |\S+ (?:GET|POST|PUT|PATCH|DELETE) )/;

/** 클래스 전체 이름 → 마지막 이름 (presentation.feature.x.ProductDetailActivity / a, Frag → ProductDetailActivity) */
export function shortScreen(screen: string | undefined): string | undefined {
  if (!screen) return undefined;
  const first = screen.split(' / ')[0].trim().split(' ').pop()!;
  return first.split('.').pop();
}

/** 예전 기록처럼 foreign 이 없으면 화면 이름으로 시스템 창을 알아본다 */
function foreignOf(s: ScenarioStep): string | undefined {
  if (s.foreign) return s.foreign;
  const scr = s.screen ?? '';
  return BLOCKING_PACKAGES.find((p) => scr.includes(p + '.') || scr.startsWith(p + ' '));
}

function correctsOf(s: ScenarioStep): number | undefined {
  if (s.corrects) return s.corrects;
  const m = CORRECTION_TITLE.exec(s.title);
  return m ? Number(m[1]) : undefined;
}

const lines = (s: string | undefined) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/** 단계의 기대·실제·근거와 판정 방식 */
function readCheck(s: ScenarioStep): { by: 'assert' | 'agent'; expect?: string; actual?: string; rest: string[] } {
  if (s.check) {
    // 새 기록: 판정 결과는 check 에 따로 있다. detail 에서 그 결과 줄만 빼고 에이전트가 쓴 글은 그대로 둔다
    const own = new Set(lines(s.check.actual));
    // 실제 값이 따로 없으면(이 필드가 생기기 전 실행기 기록) 실패 문구의 "실제:" 를 쓴다
    const failLine = s.check.by === 'assert' ? lines(s.detail).map((l) => EXPECT_ACTUAL.exec(l)).find(Boolean) : undefined;
    const rest = lines(s.detail).filter((l) => !own.has(l) && !(s.check!.by === 'assert' && EXPECT_ACTUAL.test(l)));
    return { by: s.check.by, expect: s.check.expect ?? failLine?.[1], actual: s.check.actual ?? failLine?.[2], rest };
  }
  // 예전 기록: detail 줄 모양으로 짐작한다
  const rest: string[] = [];
  const evidence: string[] = [];
  let expect: string | undefined;
  let actual: string | undefined;
  for (const line of lines(s.detail)) {
    const m = EXPECT_ACTUAL.exec(line);
    if (m && expect === undefined) [, expect, actual] = m;
    else if (EVIDENCE_LINE.test(line)) evidence.push(line);
    else rest.push(line);
  }
  const auto = (expect !== undefined && ASSERT_EXPECT.test(expect)) || evidence.length > 0;
  if (expect === undefined && evidence.length === 1) {
    const v = /^(안 보임|보임):\s*(.+)$/.exec(evidence[0]);
    if (v) return { by: 'assert', expect: `"${v[2]}" ${v[1]}`, actual: v[1], rest };
  }
  if (expect === undefined && evidence.length) actual = evidence.join(' · ');
  else rest.push(...evidence);
  if (expect !== undefined && !auto) {
    // 에이전트가 직접 쓴 "기대/실제" 는 근거 글로 남긴다 (자동 검사로 보이게 하지 않는다)
    rest.unshift(`기대: ${expect} / 실제: ${actual}`);
    return { by: 'agent', rest };
  }
  return { by: auto ? 'assert' : 'agent', expect, actual, rest };
}

export function buildScenarioView(d: ScenarioData): ScenarioView {
  const exists = new Set(d.steps.map((s) => s.index));
  // 정정 단계 → 바로잡는 단계. 앞 단계만 고칠 수 있게 해 고리가 생기지 않는다
  const targetOf = new Map<number, number>();
  for (const s of d.steps) {
    const t = correctsOf(s);
    if (t && t < s.index && exists.has(t)) targetOf.set(s.index, t);
  }
  // 정정을 다시 정정한 사슬은 맨 처음 단계에 모은다 (기록 순서대로)
  const rootOf = (i: number) => {
    let r = i;
    while (targetOf.has(r)) r = targetOf.get(r)!;
    return r;
  };
  const chains = new Map<number, ScenarioStep[]>();
  for (const s of d.steps) {
    if (!targetOf.has(s.index)) continue;
    const root = rootOf(s.index);
    chains.set(root, [...(chains.get(root) ?? []), s]);
  }

  const rows: StepRow[] = [];
  const counts: Record<TallyKey, number> = { auto: 0, manual: 0, action: 0, fail: 0, corrected: 0, skip: 0, noShot: 0, info: 0 };

  for (const s of d.steps) {
    if (targetOf.has(s.index)) continue;
    const no = rows.length + 1;
    const chain = chains.get(s.index) ?? [];
    const fix = chain[chain.length - 1];
    const c = readCheck(s);

    // 조작: 기록된 조작 로그. 예전 기록은 제목의 "조작 → 확인" 앞부분
    const arrow = !s.check && !s.actions?.length ? s.title.indexOf(' → ') : -1;
    const actions: StepRow['actions'] = [...(s.actions ?? []), ...chain.flatMap((f) => f.actions ?? [])];
    if (arrow > 0) actions.unshift({ text: s.title.slice(0, arrow) });
    // 조작 단계 하나만 기록한 경우(스크립트 실행) 제목이 곧 조작이라 확인 칸을 비운다
    const onlyAction = s.actions?.length === 1 && s.actions[0].text === s.title;
    const check = arrow > 0 ? s.title.slice(arrow + 3) : onlyAction ? '' : s.title;
    const how: StepRow['how'] = s.status === 'info' ? 'record' : !s.check && onlyAction ? 'action' : c.by;

    let actual = c.actual;
    if (actual === undefined && s.status === 'pass' && c.expect !== undefined) actual = '기대대로';

    const status: StepStatus = fix ? fix.status : s.status;
    const corrected = fix
      ? {
          from: s.status,
          byIndex: fix.index,
          times: chain.length,
          note: lines(fix.detail).join(' ') || fix.title.replace(CORRECTION_TITLE, '') || undefined,
          // 정정 근거 스샷: 사슬에서 마지막으로 찍힌 것
          screenshot: [...chain].reverse().find((f) => f.screenshot)?.screenshot,
        }
      : undefined;
    // 원래 단계나 정정 단계의 스샷이 다른 앱 화면이면 판정 근거를 믿을 수 없다
    const foreignStep = [s, ...chain].reverse().find((x) => x.screenshot && foreignOf(x));
    const foreign = foreignStep ? foreignOf(foreignStep) : undefined;

    const reasons: Reason[] = [];
    if (foreign) {
      reasons.push({
        code: 'foreign',
        label: REASON_LABEL.foreign,
        why: `${foreignStep === s ? '' : '정정 근거 '}스샷 순간 앞 화면이 ${foreign} 였습니다${isBlockingPackage(foreign) ? ' (시스템 창이 앱을 가림)' : ''}. 이 단계 판정을 다시 확인하세요.`,
      });
    }
    if (corrected) {
      // 자동 검사(assert)가 실패한 것을 통과로 바꾼 경우만 따로 알린다
      const overridden = c.by === 'assert' && corrected.from === 'fail' && status === 'pass';
      reasons.push({
        code: overridden ? 'overridden' : 'corrected',
        label: overridden ? REASON_LABEL.overridden : REASON_LABEL.corrected,
        why: [overridden ? '' : `${STATUS_LABEL[corrected.from]} → ${STATUS_LABEL[status]}.`, corrected.note].filter(Boolean).join(' ') || undefined,
      });
    }
    if (status === 'fail') {
      reasons.push({ code: 'fail', label: REASON_LABEL.fail, why: c.expect !== undefined ? `기대: ${c.expect} / 실제: ${actual ?? '-'}` : lines(s.detail)[0] });
    }
    if (status === 'skip') reasons.push({ code: 'skip', label: REASON_LABEL.skip, why: lines(s.detail)[0] });

    if (corrected) counts.corrected++;
    if (status === 'info') counts.info++;
    else if (status === 'fail') counts.fail++;
    else if (status === 'skip') counts.skip++;
    else if (corrected) {
      /* 정정으로 통과: 정정 칸에만 센다 */
    } else if (how === 'action') counts.action++;
    else if (how === 'assert') counts.auto++;
    else counts.manual++;
    // 스샷이 근거가 되는 판정 단계만 센다 (조작·진행 기록은 원래 스샷이 없을 수 있다)
    if (!s.screenshot && !corrected?.screenshot && how !== 'action' && how !== 'record') counts.noShot++;

    const screen = shortScreen(s.screen);
    // 근거 글에 화면 이름이 이미 있으면 겹쳐 쓰지 않는다
    const evidence = [...c.rest, screen && !c.rest.some((l) => l.includes(screen)) ? `화면 ${screen}` : ''].filter(Boolean).join('\n');

    rows.push({
      no,
      index: s.index,
      status,
      corrected,
      how,
      actions,
      check,
      expect: c.expect,
      actual,
      actualBad: (corrected?.from ?? status) === 'fail',
      evidence: evidence || undefined,
      screenshot: s.screenshot,
      foreign,
      baseline: s.baseline,
      at: s.at,
      reasons,
      tone: foreign || status === 'fail' ? 'bad' : reasons.length ? 'flag' : '',
    });
  }

  const attention: Attention[] = rows
    .filter((r) => r.reasons.length)
    .map((r) => ({ no: r.no, index: r.index, title: r.check || r.actions[0]?.text || '', reasons: r.reasons }))
    // 실패가 먼저, 그다음 기록 순서
    .sort((a, b) => Number(rows[b.no - 1].status === 'fail') - Number(rows[a.no - 1].status === 'fail') || a.no - b.no);

  return {
    verdict: d.verdict ?? (d.finishedAt ? 'blocked' : 'running'),
    counts,
    tally: TALLY.filter((x) => counts[x.key] > 0).map((x) => ({ ...x, count: counts[x.key] })),
    attention,
    rows,
    durationMs: d.finishedAt ? d.finishedAt - d.startedAt : undefined,
  };
}

/** 7분 56초 / 12.3초 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '진행 중';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}초`;
  const m = Math.floor(s / 60);
  return `${m}분 ${Math.round(s - m * 60)}초`;
}

export const VERDICT_LABEL = { pass: '통과', fail: '실패', blocked: '막힘', running: '진행 중' } as const;
export const STATUS_LABEL = { pass: '통과', fail: '실패', info: '기록', skip: '건너뜀' } as const;
export const HOW_LABEL = { assert: '자동 검사', agent: '직접 판정', record: '진행 기록', action: '조작 실행' } as const;
