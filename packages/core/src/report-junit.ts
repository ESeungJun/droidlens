import { join } from 'node:path';
import type { SuiteResult } from './script.js';

/**
 * 스위트 실행 결과를 CI 가 읽는 형식으로 바꾼다 (순수 함수).
 * JUnit XML: 스크립트 하나가 testsuite, 단계 하나가 testcase. Markdown: PR 댓글·작업 요약에 붙일 표
 */

/** XML 1.0 에 쓸 수 없는 제어 문자를 빼고 이스케이프한다 */
function esc(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

export function suiteToJUnit(r: SuiteResult): string {
  const suites = r.results.map((x) => {
    if (!x.result) {
      // 스크립트를 읽지 못했거나 실행 전에 실패
      return `  <testsuite name="${esc(x.name)}" tests="1" failures="0" errors="1" skipped="0" time="0">\n    <testcase name="${esc(x.name)}" classname="${esc(x.path)}" time="0">\n      <error message="${esc((x.error ?? '').split('\n')[0])}">${esc(x.error ?? '')}</error>\n    </testcase>\n  </testsuite>`;
    }
    const d = x.result.scenario;
    // info 단계(조작 기록)는 판정이 아니라 시험 수에 넣지 않는다
    const steps = d.steps.filter((s) => s.status !== 'info');
    const cases = steps.map((s, i) => {
      const prevAt = i === 0 ? d.startedAt : steps[i - 1].at;
      const head = `    <testcase name="${esc(`${s.index}. ${s.title}`)}" classname="${esc(x.name)}" time="${sec(s.at - prevAt)}"`;
      if (s.status === 'fail') {
        const shot = s.screenshot ? `\n스크린샷: ${join(d.dir, s.screenshot)}` : '';
        return `${head}>\n      <failure message="${esc((s.detail ?? '실패').split('\n')[0])}">${esc(`${s.detail ?? ''}${s.screen ? `\n화면: ${s.screen}` : ''}${shot}`)}</failure>\n    </testcase>`;
      }
      if (s.status === 'skip') return `${head}>\n      <skipped/>\n    </testcase>`;
      return `${head}/>`;
    });
    const failures = steps.filter((s) => s.status === 'fail').length;
    const skipped = steps.filter((s) => s.status === 'skip').length;
    // 단계는 다 통과했는데 판정이 통과가 아니면(준비 단계 실패 등) 스위트 오류로 남긴다
    const blocked = x.result.verdict !== 'pass' && !failures
      ? `\n    <testcase name="${esc(x.name)}" classname="${esc(x.name)}" time="0">\n      <error message="${esc(d.summary ?? x.result.verdict)}">${esc(d.summary ?? '')}</error>\n    </testcase>`
      : '';
    return `  <testsuite name="${esc(x.name)}" tests="${steps.length + (blocked ? 1 : 0)}" failures="${failures}" errors="${blocked ? 1 : 0}" skipped="${skipped}" time="${sec(x.result.durationMs)}">\n${cases.join('\n')}${blocked}\n  </testsuite>`;
  });
  const failed = r.results.filter((x) => !x.result || x.result.verdict !== 'pass').length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="droidlens" tests="${r.results.length}" failures="${failed}" time="${sec(r.durationMs)}">\n${suites.join('\n')}\n</testsuites>\n`;
}

/** 표 칸에 넣을 글: 줄바꿈·세로선이 표를 깨지 않게 한다 */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').slice(0, 300);

export function suiteToMarkdown(r: SuiteResult): string {
  const lines = [
    `## DroidLens 회귀 테스트: ${r.passed}/${r.results.length} 통과 (${(r.durationMs / 1000).toFixed(1)}초)`,
    '',
    '| 결과 | 스크립트 | 단계 | 시간 |',
    '|---|---|---|---|',
    ...r.results.map((x) =>
      x.result
        ? `| ${x.result.verdict === 'pass' ? '통과' : '실패'} | ${cell(x.name)} | ${x.result.passed}/${x.result.passed + x.result.failed + x.result.skipped} | ${(x.result.durationMs / 1000).toFixed(1)}초 |`
        : `| 오류 | ${cell(x.name)} | - | - |`,
    ),
  ];
  const bad = r.results.filter((x) => !x.result || x.result.verdict !== 'pass');
  if (bad.length) lines.push('', '### 실패');
  for (const x of bad) {
    if (!x.result) {
      lines.push(`- **${cell(x.name)}**: ${cell(x.error ?? '')}`);
      continue;
    }
    const d = x.result.scenario;
    const fails = d.steps.filter((s) => s.status === 'fail');
    lines.push(`- **${cell(x.name)}** — 리포트 \`${x.result.report}\``);
    if (!fails.length && d.summary) lines.push(`  - ${cell(d.summary)}`);
    for (const s of fails) {
      lines.push(`  - ${s.index}단계 ${cell(s.title)}: ${cell(s.detail ?? '')}${s.screenshot ? ` (스크린샷 \`${join(d.dir, s.screenshot)}\`)` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}
