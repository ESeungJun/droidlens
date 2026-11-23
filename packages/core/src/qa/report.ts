import { isAbsolute, join, relative } from 'node:path';
import { writeFileAtomic } from '../workspace.js';
import { CASE_KIND_LABEL, type QaPlan } from './plan.js';
import { xmlEscape as xml } from '../report-junit.js';
import { QA_STATUS_LABEL, qaRunDir, qaRunSummary, type QaRun, type QaRunSummary } from './run.js';

/**
 * QA 회차 결과표 (#76): 사람이 보는 HTML, 엑셀에서 여는 CSV, CI 가 읽는 JUnit XML.
 *   ~/.droidlens/qa/<계획 id>/runs/<회차 id>/report.html · results.csv · junit.xml
 * 글은 모두 문서·에이전트가 쓴 것이라 그대로 넣지 않고 이스케이프한다.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * CSV 칸 하나. 따옴표로 감싸고, 엑셀이 수식으로 읽는 첫 글자(= + - @ 탭 CR)면 앞에 ' 를 붙인다
 * (문서에서 온 글이 수식으로 실행되지 않게)
 */
export function csvCell(v: string | number | undefined): string {
  let s = v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const STATUS_CLASS: Record<string, string> = { pass: 'ok', fail: 'bad', blocked: 'bad', skip: 'mute', 'not-run': 'mute' };
const MODE_LABEL = { script: '스크립트', agent: '에이전트', manual: '직접 기록' } as const;

const fmtTime = (ms: number) => new Date(ms).toLocaleString('ko-KR', { hour12: false });
const fmtDur = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)}초`);

export function qaReportHtml(plan: QaPlan, run: QaRun, s: QaRunSummary = qaRunSummary(plan, run), reportBase?: string): string {
  const link = (p?: string) => {
    // 실행기가 만든 시나리오 리포트(절대 경로 .html)만 잇는다
    if (!p || !isAbsolute(p) || !p.endsWith('.html')) return '';
    // 같은 droidlens 폴더 안의 시나리오 리포트는 상대 경로로 잇는다 (파일을 옮겨도 열리게)
    const href = reportBase ? relative(reportBase, p) : p;
    return `<a href="${esc(href.split('\\').join('/'))}">리포트</a>`;
  };
  const counts = (['pass', 'fail', 'blocked', 'skip', 'not-run'] as const)
    .map((k) => `<span class="pill ${STATUS_CLASS[k]}">${QA_STATUS_LABEL[k]} ${s.counts[k]}</span>`)
    .join(' ');
  const reqRows = s.requirements
    .map(
      (r) =>
        `<tr><td class="id">${esc(r.id)}</td><td>${esc(r.text)}</td><td><span class="pill ${STATUS_CLASS[r.status]}">${r.status === 'pass' ? '통과' : r.status === 'fail' ? '실패' : '안 돌림'}</span></td><td class="id">${esc(r.cases.join(', ') || '고른 TC 없음')}</td></tr>`,
    )
    .join('');
  const caseRows = s.rows
    .map(({ case: c, result: r, status }) => {
      const detail = [r?.detail, status === 'not-run' && !c.selected ? '이번 회차에 고르지 않음' : ''].filter(Boolean).join(' · ');
      return `<tr><td class="id">${esc(c.id)}</td><td>${esc(c.priority)}</td><td>${esc(CASE_KIND_LABEL[c.kind])}</td><td>${esc(c.title)}${c.danger ? ' <span class="pill warn">확인 필수</span>' : ''}</td><td class="id">${esc(c.requirements.join(', '))}</td><td><span class="pill ${STATUS_CLASS[status]}">${QA_STATUS_LABEL[status]}</span></td><td>${r ? MODE_LABEL[r.mode] : ''}${r?.script ? `<br><code>${esc(r.script)}</code>` : ''}</td><td>${fmtDur(r?.durationMs)}</td><td>${esc(detail)}</td><td>${link(r?.report)}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(plan.name)} · QA 결과 ${esc(run.id)}</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1d2330;--mute:#677086;--line:#e2e6ee;--ok:#0f7b46;--okbg:#e3f5ea;--bad:#b42318;--badbg:#fdeceb;--warn:#8a5a00;--warnbg:#fff4d6;--mbg:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1a1e26;--fg:#e6e9ef;--mute:#98a1b3;--line:#2b313c;--ok:#5fd394;--okbg:#173626;--bad:#ff8a80;--badbg:#3a1d1b;--warn:#ffcc66;--warnbg:#3a2f12;--mbg:#262b35;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo",sans-serif;padding:24px max(16px,env(safe-area-inset-left))}
main{max-width:1200px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.sub{color:var(--mute);margin:0 0 12px}.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:720px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
.id{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:nowrap}code{font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;white-space:nowrap;background:var(--mbg);color:var(--mute)}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}
a{color:inherit}
</style></head><body><main>
<h1>${esc(plan.name)} — QA 결과</h1>
<p class="sub">회차 ${esc(run.id)} · 시작 ${esc(fmtTime(run.startedAt))}${plan.app ? ` · 앱 <code>${esc(plan.app)}</code>` : ''}</p>
<p>${counts}</p>
<h2>요구사항별</h2>
<div class="wrap"><table><thead><tr><th>번호</th><th>요구사항</th><th>결과</th><th>TC</th></tr></thead><tbody>${reqRows}</tbody></table></div>
<h2>TC별</h2>
<div class="wrap"><table><thead><tr><th>TC</th><th>우선</th><th>종류</th><th>제목</th><th>요구사항</th><th>결과</th><th>방법</th><th>시간</th><th>메모</th><th></th></tr></thead><tbody>${caseRows}</tbody></table></div>
</main></body></html>`;
}

/** 엑셀에서 여는 CSV (BOM 포함). 입력값(data)은 계정·비밀번호가 있을 수 있어 넣지 않는다 */
export function qaReportCsv(plan: QaPlan, run: QaRun, s: QaRunSummary = qaRunSummary(plan, run)): string {
  const head = ['TC', '우선순위', '종류', '제목', '요구사항', '결과', '방법', '스크립트', '시간(초)', '메모', '기록 시각'];
  const rows = s.rows.map(({ case: c, result: r, status }) =>
    [
      c.id,
      c.priority,
      CASE_KIND_LABEL[c.kind],
      c.title,
      c.requirements.join(' '),
      QA_STATUS_LABEL[status],
      r ? MODE_LABEL[r.mode] : '',
      r?.script,
      r?.durationMs === undefined ? '' : (r.durationMs / 1000).toFixed(1),
      r?.detail,
      r ? fmtTime(r.at) : '',
    ]
      .map(csvCell)
      .join(','),
  );
  return '\ufeff' + [head.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}

/** CI 용 JUnit XML. 고른 TC 중 안 돌린 것은 skipped 로 둔다 */
export function qaReportJunit(plan: QaPlan, run: QaRun, s: QaRunSummary = qaRunSummary(plan, run)): string {
  const n = (k: keyof QaRunSummary['counts']) => s.counts[k];
  const time = (ms?: number) => ((ms ?? 0) / 1000).toFixed(3);
  const total = s.rows.reduce((a, r) => a + (r.result?.durationMs ?? 0), 0);
  const cases = s.rows
    .map(({ case: c, result: r, status }) => {
      const attrs = `classname="${xml(plan.id)}" name="${xml(`${c.id} ${c.title}`)}" time="${time(r?.durationMs)}"`;
      const detail = r?.detail ?? '';
      const msg = xml(detail.split('\n')[0]);
      if (status === 'pass') return `    <testcase ${attrs}/>`;
      if (status === 'fail') return `    <testcase ${attrs}><failure message="${msg || '실패'}">${xml(detail)}</failure></testcase>`;
      if (status === 'blocked') return `    <testcase ${attrs}><error message="${msg || '막힘'}">${xml(detail)}</error></testcase>`;
      return `    <testcase ${attrs}><skipped message="${status === 'skip' ? msg || '건너뜀' : '안 돌림'}"/></testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="droidlens-qa" tests="${s.rows.length}" failures="${n('fail')}" errors="${n('blocked')}" skipped="${n('skip') + n('not-run')}" time="${time(total)}">
  <testsuite name="${xml(plan.name)}" id="${xml(run.id)}" tests="${s.rows.length}" failures="${n('fail')}" errors="${n('blocked')}" skipped="${n('skip') + n('not-run')}" time="${time(total)}">
${cases}
  </testsuite>
</testsuites>
`;
}

export interface QaReportFiles {
  html: string;
  csv: string;
  junit: string;
  summary: QaRunSummary;
}

/** 회차 폴더에 결과표 세 가지를 쓴다 */
export async function writeQaReport(plan: QaPlan, run: QaRun): Promise<QaReportFiles> {
  const dir = qaRunDir(plan.id, run.id);
  const summary = qaRunSummary(plan, run);
  const files = { html: join(dir, 'report.html'), csv: join(dir, 'results.csv'), junit: join(dir, 'junit.xml') };
  await writeFileAtomic(files.html, qaReportHtml(plan, run, summary, dir));
  await writeFileAtomic(files.csv, qaReportCsv(plan, run, summary));
  await writeFileAtomic(files.junit, qaReportJunit(plan, run, summary));
  return { ...files, summary };
}
