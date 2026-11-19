import type { Selector } from '../hierarchy.js';
import { MASK, redactUrl, redactValue } from '../redact.js';
import type { ScenarioAction, ScenarioStep } from '../scenario-view.js';
import type { Assertion, Script, ScriptStep } from './schema.js';

/** 단계·검사·준비를 사람이 읽는 말로 바꾼다 (진행 표시·리포트용). 기기는 건드리지 않는다 */

export const selText = (s: Selector) =>
  Object.entries(s)
    .filter(([k, v]) => v !== undefined && !['timeout', 'optional', 'gone'].includes(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');

/** 셀렉터를 사람이 읽는 짧은 말로: "상점정보/후기" · #login_button · [설정] */
export function selectorLabel(s: Selector): string {
  if (s.text) return `"${s.text}"`;
  if (s.textContains) return `"…${s.textContains}…"`;
  if (s.desc) return `[${s.desc}]`;
  if (s.descContains) return `[…${s.descContains}…]`;
  if (s.id) return `#${s.id.split(':id/').pop()}`;
  return s.className ?? '요소';
}

/** 검사 조건을 사람이 읽는 기대 문장으로 (리포트의 "기대" 칸) */
export function describeAssertion(a: Assertion): string {
  const parts: string[] = [];
  if (a.visible) parts.push(`${selectorLabel(a.visible)} 보임`);
  if (a.notVisible) parts.push(`${selectorLabel(a.notVisible)} 안 보임`);
  if (a.text) parts.push(`${selectorLabel(a.text.of)} 글자 ${a.text.equals !== undefined ? `= "${a.text.equals}"` : `에 "${a.text.contains ?? ''}" 포함`}`);
  if (a.activity) parts.push(`화면 ${a.activity}`);
  if (a.package) parts.push(`앱 ${a.package}`);
  if (a.network) parts.push(`요청 ${a.network.method ?? ''} ${a.network.url}${a.network.status ? ` → ${a.network.status}` : ''}`.replace('  ', ' '));
  if (a.pref) parts.push(`설정 ${a.pref.file}.${a.pref.key} = ${redactValue(a.pref.key, JSON.stringify(a.pref.equals))}`);
  if (a.db) parts.push(`DB ${a.db.sql} = ${JSON.stringify(a.db.equals)}`);
  if (a.event) parts.push(`이벤트 ${a.event} 기록`);
  if (a.perf) parts.push([a.perf.maxMemoryMb && `메모리 ${a.perf.maxMemoryMb}MB 이하`, a.perf.maxJankPercent !== undefined && `버벅임 ${a.perf.maxJankPercent}% 이하`].filter(Boolean).join(', '));
  if (a.noCrash) parts.push('크래시 없음');
  return parts.join(' · ') || '검사';
}

/** 준비 단계 설명 (리포트용): 무엇을 했는지만 남기고 Prefs 값·목 URL 의 쿼리 같은 값은 가린다 */
export function describeSetup(setup: Script['setup']): string | undefined {
  if (!setup) return undefined;
  const parts = [
    setup.clearData && '앱 데이터 지움',
    setup.restart !== false && '앱 재시작',
    ...(setup.prefs ?? []).map((p) => `설정 ${p.file}.${p.key} = ${redactValue(p.key, String(p.value))}`),
    ...(setup.mocks ?? []).map((m) => `네트워크 목 ${m.method ?? '*'} ${redactUrl(m.url)}`),
  ];
  return parts.filter(Boolean).join('\n') || undefined;
}

export function describeStep(step: ScriptStep): string {
  const [kind, arg] = Object.entries(step)[0] as [string, unknown];
  switch (kind) {
    case 'tap':
    case 'longPress':
    case 'wait':
      return `${kind} ${selText(arg as Selector)}`;
    case 'type': {
      const t = arg as { text: string; into?: Selector };
      return `type "${t.text}"${t.into ? ` → ${selText(t.into)}` : ''}`;
    }
    case 'swipe':
      return typeof arg === 'string' ? `swipe ${arg}` : `swipe ${(arg as { direction: string }).direction}${(arg as { until?: Selector }).until ? ` until ${selText((arg as { until: Selector }).until)}` : ''}`;
    case 'assert':
      return `assert ${Object.entries(arg as object)
        .filter(([k]) => k !== 'timeout')
        .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ')}`;
    default:
      return `${kind}${arg !== undefined && arg !== null ? ' ' + (typeof arg === 'object' ? JSON.stringify(arg) : arg) : ''}`;
  }
}

/** 한 단계를 리포트에 남기는 모양 */
export interface StepReport {
  /** 리포트 단계 제목. 입력값·딥링크 쿼리는 가리고, 검사 단계는 기대 문장 */
  title: string;
  /** 판정 단계(검사·스크린샷)라 통과해도 스크린샷을 남긴다 */
  shot: boolean;
  /** 리포트의 검사 칸(검사 단계) 또는 조작 로그(그 밖). actual 은 통과 근거·실패 문구에서 뽑은 실제 값 */
  extra(actual?: string): { actions?: ScenarioAction[]; check?: ScenarioStep['check'] };
}

/**
 * 단계를 리포트에 어떻게 남길지. 검사 단계는 판정 방식을, 그 밖(조작·스샷 찍기)은 조작 로그를 남긴다.
 * 리포트는 공유되므로 입력값은 가린다. title 은 describeStep 결과 (조작 로그 문구로 쓴다)
 */
export function stepReport(step: ScriptStep, title: string): StepReport {
  // 검사·스크린샷이 아닌 단계는 그 자체가 조작이라 조작 로그로도 남긴다
  const isCheck = 'assert' in step || 'screenshot' in step || 'matchScreenshot' in step;
  const reportTitle =
    'type' in step
      ? `type ${MASK} (${step.type.text.length}자)${step.type.into ? ` → ${selText(step.type.into)}` : ''}`
      : 'deeplink' in step
        ? `deeplink ${redactUrl(step.deeplink)}`
        : 'assert' in step
          ? describeAssertion(step.assert)
          : title;
  const check = 'assert' in step || 'matchScreenshot' in step;
  return {
    title: reportTitle,
    shot: isCheck,
    extra: (actual?: string) =>
      check
        ? { check: { by: 'assert' as const, ...('assert' in step ? { expect: describeAssertion(step.assert) } : {}), ...(actual ? { actual } : {}) } }
        : { actions: [{ at: Date.now(), text: reportTitle }] },
  };
}
