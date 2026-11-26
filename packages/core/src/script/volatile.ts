import type { ScriptStep } from './schema.js';

/**
 * 다시 돌리면 바뀔 값을 정확히 일치로 기다리거나 검사하는 단계 (#115).
 * 에이전트가 TC 를 통과시키며 본 값("note #9")이 그대로 스크립트에 녹화되면 다음 실행에서 실패한다.
 * 숫자가 든 글자를 `text`(정확 일치)·`text.equals` 로 보는 wait·assert 를 찾아, 숫자 앞까지의 `textContains` 를 제안한다.
 * 숫자가 늘 같은 값(버전·고정 가격)일 수도 있어 막지는 않고 알리기만 한다.
 */
export interface VolatileCheck {
  /** 스크립트 단계 번호(1부터) */
  step: number;
  /** 어느 칸인지: wait.text · assert.visible.text · assert.notVisible.text · assert.text.equals */
  where: string;
  value: string;
  /** 바꿔 쓸 만한 textContains 값 (숫자 앞부분이 없으면 undefined) */
  suggest?: string;
}

const HAS_DIGIT = /\d/;
const suggestOf = (v: string) => {
  const head = v.slice(0, v.search(HAS_DIGIT)).trimEnd();
  return head ? head : undefined;
};

export function volatileChecks(steps: readonly ScriptStep[]): VolatileCheck[] {
  const out: VolatileCheck[] = [];
  const add = (step: number, where: string, v: unknown) => {
    if (typeof v === 'string' && HAS_DIGIT.test(v)) out.push({ step, where, value: v, suggest: suggestOf(v) });
  };
  steps.forEach((st, i) => {
    const s = st as Record<string, any>;
    const n = i + 1;
    if (s.wait && !s.wait.gone) add(n, 'wait.text', s.wait.text);
    const a = s.assert;
    if (a) {
      add(n, 'assert.visible.text', a.visible?.text);
      add(n, 'assert.text.equals', a.text?.equals);
    }
  });
  return out;
}

/** scenario_finish 결과에 붙일 경고 문구 (없으면 빈 배열) */
export function volatileWarning(found: VolatileCheck[]): string[] {
  if (!found.length) return [];
  return [
    `경고: 다시 돌리면 바뀌는 값을 정확히 일치로 보는 단계가 ${found.length}개 있어요. 다음 실행에서 실패할 수 있어요.`,
    ...found.map(
      (f) =>
        `  - ${f.step}단계 ${f.where} = "${f.value}"${f.suggest ? ` → textContains: "${f.suggest}" 로 고치세요` : ' → 바뀌지 않는 부분만 textContains 로 고치세요'}`,
    ),
    '  늘 같은 값이 아니면 script_read 로 열어 고친 뒤 script_write 로 저장하고, script_run 으로 한 번 다시 돌려 통과를 확인하세요.',
  ];
}
