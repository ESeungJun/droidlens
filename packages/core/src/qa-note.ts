/**
 * 앱이 QA 회차 결과에 적는 메모를 코드 값으로 두고 언어별 글로 바꾼다 (#114).
 * 데스크톱 화면과 내보내기 파일이 같이 쓴다. 브라우저에서도 돌아야 하므로 node 모듈을 가져오지 않는다.
 *
 * - 결과에는 note(코드 값)와 detail(한국어 글)을 같이 남긴다. detail 만 읽는 옛 버전·도구·CSV·JUnit 은 그대로 읽는다
 * - note 가 없는 옛 결과는 앱이 적던 한국어 문구를 되짚어 코드로 바꾼다(qaNoteFromDetail). 모르는 글은 사람·에이전트 글로 보고 그대로 둔다
 * - 인자(error·script·more)는 바깥에서 온 글이라 번역하지 않는다
 */

export const QA_NOTE_CODES = [
  'manualSkipped',
  'needsReview',
  'timedOut',
  'agentNotStarted',
  'agentNoResult',
  'scriptChangedDanger',
  'scriptNoHashDanger',
  'scriptNone',
  'scriptMissing',
  'scriptFormat',
  'scriptOtherCase',
  'caseChanged',
] as const;
export type QaNoteCode = (typeof QA_NOTE_CODES)[number];

export interface QaNote {
  code: QaNoteCode;
  /** min(분) · error(오류 원문) · script(스크립트 이름) · more(뒤에 붙는 시나리오 요약) */
  args?: Record<string, string | number>;
}

export type QaNoteLang = 'ko' | 'en';

type Args = Record<string, string | number>;
const s = (a: Args, k: string) => (a[k] === undefined ? '' : String(a[k]));
/** 콜론 뒤에 붙는 오류 원문 (없으면 빈 글자) */
const tail = (a: Args, k: string) => (s(a, k) ? `: ${s(a, k)}` : '');

/** 코드마다 [한국어, 영어]. 한국어는 앱이 예전부터 적던 문구와 같다 (옛 결과 되짚기에 그대로 쓴다) */
const TEXT: Record<QaNoteCode, Record<QaNoteLang, (a: Args) => string>> = {
  manualSkipped: {
    ko: () => '수동 TC 라 자동으로 실행하지 않았습니다. 사람이 확인해야 합니다',
    en: () => 'Manual TC, not run automatically. Needs a person to check',
  },
  needsReview: {
    ko: () => '다시 보기 표시가 있어 실행하지 않았습니다. 사람이 확인해야 합니다',
    en: () => 'Marked for review, so not run. Needs a person to check',
  },
  timedOut: {
    ko: (a) => `시간 제한(${s(a, 'min')}분)을 넘겨 멈췄습니다`,
    en: (a) => `Stopped after the time limit (${s(a, 'min')} min)`,
  },
  agentNotStarted: {
    ko: (a) => `에이전트를 띄우지 못했습니다${tail(a, 'error')}`,
    en: (a) => `Could not start the agent${tail(a, 'error')}`,
  },
  agentNoResult: {
    ko: (a) => `에이전트가 결과를 적지 않고 끝났습니다${tail(a, 'error')}`,
    en: (a) => `The agent ended without recording a result${tail(a, 'error')}`,
  },
  scriptChangedDanger: {
    ko: () => '스크립트 파일이 TC 에 이은 뒤 바뀌어 확인 필수 동작은 누르지 않았습니다',
    en: () => 'The script file changed after it was linked to the TC, so confirm-required actions were not tapped',
  },
  scriptNoHashDanger: {
    ko: () => '해시 없이 이은 스크립트라 확인 필수 동작은 누르지 않았습니다 (다시 실행해 통과하면 새로 이어집니다)',
    en: () => 'The script was linked without a hash, so confirm-required actions were not tapped (it is relinked after a passing rerun)',
  },
  scriptNone: {
    ko: () => '이은 스크립트가 없습니다',
    en: () => 'No linked script',
  },
  scriptMissing: {
    ko: (a) => `스크립트 파일이 없습니다: ${s(a, 'script')}`,
    en: (a) => `Script file not found: ${s(a, 'script')}`,
  },
  scriptFormat: {
    ko: (a) => `스크립트 형식 오류: ${s(a, 'error')}`,
    en: (a) => `Script format error: ${s(a, 'error')}`,
  },
  scriptOtherCase: {
    ko: (a) => `스크립트 ${s(a, 'script')} 가 이 TC 의 것이 아닙니다`,
    en: (a) => `Script ${s(a, 'script')} does not belong to this TC`,
  },
  caseChanged: {
    ko: () => 'TC 내용이 스크립트를 이은 뒤 바뀌었습니다. 바뀐 내용으로 다시 실행해 통과하면 스크립트가 새로 이어집니다',
    en: () => 'The TC changed after the script was linked. Rerun it with the new content; a pass relinks the script',
  },
};

/** 메모 하나를 그 언어의 글로. args.more(시나리오 요약)는 ' · ' 뒤에 그대로 붙인다 */
export function qaNoteText(note: QaNote, lang: QaNoteLang): string {
  const a = note.args ?? {};
  const base = TEXT[note.code]?.[lang]?.(a) ?? '';
  return a.more === undefined || a.more === '' ? base : `${base} · ${a.more}`;
}

const reEscape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARK = '\u0000';

/**
 * 한국어 문구를 되짚는 패턴: 인자 자리를 이름 붙은 묶음으로 바꾼다.
 * 인자 없는 문구 뒤에는 ' · 요약'(more)이 올 수 있다. 오류 원문(error)은 끝까지 먹으므로 more 를 붙이지 않는다
 */
const BACK = QA_NOTE_CODES.flatMap((code) => {
  const probe: Args = { min: `${MARK}min${MARK}`, error: `${MARK}error${MARK}`, script: `${MARK}script${MARK}` };
  const withArgs = TEXT[code].ko(probe);
  const used = (['min', 'error', 'script'] as const).filter((k) => withArgs.includes(`${MARK}${k}${MARK}`));
  const body = (t: string) =>
    reEscape(t)
      .replace(`${MARK}min${MARK}`, '(?<min>\\d+)')
      .replace(`${MARK}error${MARK}`, '(?<error>[\\s\\S]+)')
      .replace(`${MARK}script${MARK}`, '(?<script>\\S+)');
  const more = used.includes('error') ? '' : '(?: · (?<more>[\\s\\S]+))?';
  const out = [{ code, re: new RegExp(`^${body(withArgs)}${more}$`) }];
  // 오류 원문이 없어도 되는 문구 (에이전트가 결과 없이 끝남 등): 콜론 없는 꼴도 받는다
  if (used.includes('error') && withArgs.includes(`: ${MARK}error${MARK}`))
    out.push({ code, re: new RegExp(`^${body(TEXT[code].ko({}))}$`) });
  return out;
});

/** note 가 없는 옛 결과의 한국어 메모를 코드로 되짚는다. 앱이 적던 문구와 끝까지 같을 때만, 아니면 undefined */
export function qaNoteFromDetail(detail: string | undefined): QaNote | undefined {
  if (!detail) return undefined;
  for (const { code, re } of BACK) {
    const m = re.exec(detail);
    if (!m) continue;
    const g = m.groups ?? {};
    const args: Args = {};
    if (g.min !== undefined) args.min = Number(g.min);
    for (const k of ['error', 'script', 'more'] as const) if (g[k] !== undefined) args[k] = g[k];
    return Object.keys(args).length ? { code, args } : { code };
  }
  return undefined;
}

/**
 * 결과 메모를 화면·파일 언어로. 한국어는 남은 detail 그대로, 영어는 note(없으면 detail 을 되짚은 코드)를 영어로.
 * 사람·에이전트가 적은 글은 언어와 상관없이 그대로
 */
export function qaResultMemo(r: { detail?: string; note?: QaNote } | undefined, lang: QaNoteLang): string | undefined {
  if (!r) return undefined;
  if (lang === 'ko') return r.detail ?? (r.note ? qaNoteText(r.note, 'ko') : undefined);
  const n = r.note ?? qaNoteFromDetail(r.detail);
  return n ? qaNoteText(n, lang) : r.detail;
}
