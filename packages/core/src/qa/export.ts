import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { downscaleToJpeg } from '../image.js';
import { readJson, droidlensHome, writeFileAtomic } from '../workspace.js';
import { buildScenarioView, HOW_LABEL, STATUS_LABEL, VERDICT_LABEL, type ScenarioData } from '../scenario-view.js';
import { loadQaPlan, qaPlanDir } from './store.js';
import { listQaRunIds, loadQaRun, maskCaseData, QA_STATUS_LABEL, qaRunDir, qaRunSummary, type QaRun, type QaRunSummary } from './run.js';
import { PLAN_ID, type QaPlan } from './plan.js';
import { htmlEscape as esc } from './report.js';

/**
 * QA 회차 묶어 보기·내보내기 (#98).
 *   - qaRunIndex: 계획마다 회차와 그 회차의 시나리오 기록 id (검증 기록 목록에서 회차로 묶는 데 쓴다)
 *   - 결과.xlsx: 시트 '요약'(TC 별) + '단계'(TC 의 단계별 판정)
 *   - 단계별.html: 회차 요약 → TC 마다 단계·캡처. 캡처를 줄여 넣어 파일 하나로 끝난다
 * 공유되는 파일이라 시나리오 기록의 글 칸마다 TC 입력값을 가리고(maskCaseData, 결과표 메모와 같은 규칙), TC 입력값 칸 자체는 넣지 않는다.
 * 기록은 이 계획·TC·회차 것이고 시나리오 폴더 안(심볼릭 링크를 푼 뒤)에 있을 때만 붙인다.
 */

const MODE_LABEL = { script: '스크립트', agent: '에이전트', manual: '직접 기록' } as const;

export interface QaRunIndexItem {
  plan: string;
  planName: string;
  app?: string;
  run: string;
  startedAt: number;
  counts: QaRunSummary['counts'];
  /** 이 회차 결과가 가리키는 시나리오 기록 id (시나리오 폴더 이름) */
  scenarios: string[];
}

/** 시나리오 폴더 바로 아래 폴더인지, 심볼릭 링크를 푼 실제 경로로 본다 (회차 기록이 바뀌어도 그 밖의 파일은 읽지 않는다) */
async function scenarioDirOf(report: string | undefined): Promise<string | undefined> {
  if (!report) return undefined;
  const root = await realpath(join(droidlensHome(), 'scenarios')).catch(() => undefined);
  const dir = await realpath(dirname(report)).catch(() => undefined);
  if (!root || !dir) return undefined;
  const base = root + sep;
  return dir.startsWith(base) && !dir.slice(base.length).includes(sep) ? dir : undefined;
}

const mtime = (p: string) => stat(p).then((x) => x.mtimeMs, () => -1);
/** 회차 목록은 검증 기록 화면이 5초마다 부른다. plan.json·run.json 이 바뀐 회차만 다시 읽는다 */
const indexCache = new Map<string, { stamp: string; item: QaRunIndexItem }>();
const planCache = new Map<string, { stamp: number; plan: QaPlan }>();

/** 계획마다 최근 회차 perPlan 개까지, 시작이 늦은 것부터 */
export async function qaRunIndex(perPlan = 20): Promise<QaRunIndexItem[]> {
  const root = join(droidlensHome(), 'qa');
  if (!existsSync(root)) return [];
  const out: QaRunIndexItem[] = [];
  const seen = new Set<string>();
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !PLAN_ID.test(e.name)) continue;
    const planStamp = await mtime(join(qaPlanDir(e.name), 'plan.json'));
    let plan = planCache.get(e.name)?.stamp === planStamp ? planCache.get(e.name)!.plan : undefined;
    if (!plan) {
      plan = await loadQaPlan(e.name).catch(() => undefined);
      if (!plan) continue;
      planCache.set(e.name, { stamp: planStamp, plan });
    }
    for (const id of (await listQaRunIds(e.name)).slice(0, perPlan)) {
      const key = `${e.name}/${id}`;
      seen.add(key);
      const stamp = `${planStamp}:${await mtime(join(qaRunDir(e.name, id), 'run.json'))}`;
      const hit = indexCache.get(key);
      if (hit?.stamp === stamp) {
        out.push(hit.item);
        continue;
      }
      const run = await loadQaRun(e.name, id).catch(() => undefined);
      if (!run) continue;
      const dirs = await Promise.all(run.results.map((r) => scenarioDirOf(r.report)));
      const item: QaRunIndexItem = {
        plan: e.name,
        planName: plan.name,
        app: plan.app,
        run: id,
        startedAt: run.startedAt,
        counts: qaRunSummary(plan, run).counts,
        scenarios: dirs.filter((d): d is string => !!d).map((d) => basename(d)),
      };
      indexCache.set(key, { stamp, item });
      out.push(item);
    }
  }
  for (const k of [...indexCache.keys()]) if (!seen.has(k)) indexCache.delete(k);
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

const str = (v: unknown): v is string => typeof v === 'string';

/**
 * 시나리오 기록을 공유용으로: 글 칸마다 TC 입력값을 가리고, 형식이 틀린 칸은 버린다.
 * 단계가 배열이 아니거나 단계에 번호·제목·판정이 없으면 undefined (그 TC 는 기록 없이 낸다)
 */
export function maskScenario(d: ScenarioData, data: string | undefined): ScenarioData | undefined {
  if (!d || !Array.isArray(d.steps) || !str(d.name) || typeof d.startedAt !== 'number') return undefined;
  const m = (v: unknown) => (str(v) ? maskCaseData(v, data) : undefined);
  const acts = (a: unknown): ScenarioData['actions'] =>
    Array.isArray(a)
      ? a.filter((x) => x && str(x.text)).map((x) => ({ at: typeof x.at === 'number' ? x.at : 0, text: maskCaseData(x.text, data) }))
      : undefined;
  const steps: ScenarioData['steps'] = [];
  for (const st of d.steps as unknown[]) {
    const x = st as ScenarioData['steps'][number];
    if (!x || typeof x.index !== 'number' || !str(x.title) || !['pass', 'fail', 'info', 'skip'].includes(x.status)) return undefined;
    steps.push({
      ...x,
      title: maskCaseData(x.title, data),
      detail: m(x.detail),
      screen: m(x.screen),
      screenshot: str(x.screenshot) ? x.screenshot : undefined,
      foreign: m(x.foreign),
      actions: acts(x.actions),
      check: x.check && (x.check.by === 'assert' || x.check.by === 'agent') ? { by: x.check.by, expect: m(x.check.expect), actual: m(x.check.actual) } : undefined,
    });
  }
  return {
    ...d,
    name: maskCaseData(d.name, data),
    goal: m(d.goal),
    summary: m(d.summary),
    device: m(d.device),
    packageName: m(d.packageName),
    steps,
    actions: acts(d.actions),
  };
}

export interface QaRunBundle {
  plan: QaPlan;
  run: QaRun;
  summary: QaRunSummary;
  /** TC id → 그 TC 의 시나리오 기록 */
  scenarios: Map<string, ScenarioData>;
}

export async function loadQaRunBundle(planId: string, runId: string): Promise<QaRunBundle> {
  const plan = await loadQaPlan(planId);
  const run = await loadQaRun(planId, runId);
  const scenarios = new Map<string, ScenarioData>();
  for (const r of run.results) {
    const dir = await scenarioDirOf(r.report);
    if (!dir) continue;
    const d = await readJson<ScenarioData>(join(dir, 'scenario.json')).catch(() => undefined);
    // 이 계획·TC(기록에 회차가 적혀 있으면 회차까지)의 기록만 붙인다
    if (!d?.tc || d.tc.plan !== planId || d.tc.case !== r.case || (d.tc.run && d.tc.run !== runId)) continue;
    // 기록 안의 dir 은 믿지 않고 실제로 읽은 폴더로 고친다 (캡처를 그 폴더에서만 읽게)
    const safe = maskScenario({ ...d, dir }, plan.cases.find((c) => c.id === r.case)?.data);
    if (safe) scenarios.set(r.case, safe);
  }
  return { plan, run, summary: qaRunSummary(plan, run), scenarios };
}

// ---------- 엑셀 ----------

type Cell = string | number | undefined;

/** XML 에 넣을 수 없는 글자(제어 문자·짝 없는 서러게이트)를 빼고, 엑셀 칸 한도 안으로 자른 뒤 이스케이프한다 */
function xmlText(s: string): string {
  const clean = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .slice(0, 32000)
    // 자르다 반쪽이 된 것까지 짝 없는 서러게이트를 뺀다
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return esc(clean);
}

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 시트 하나. 글은 inlineStr 이라 '=' 로 시작해도 수식으로 읽히지 않는다 */
function sheetXml(head: string[], rows: Cell[][], widths: number[]): string {
  const cell = (v: Cell, r: number, c: number, style = 0) => {
    const ref = `${colName(c)}${r}`;
    const s = style ? ` s="${style}"` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    const t = v === undefined ? '' : String(v);
    return t ? `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(t)}</t></is></c>` : '';
  };
  const lines = [head.map((h, c) => cell(h, 1, c, 1)).join(''), ...rows.map((row, i) => row.map((v, c) => cell(v, i + 2, c, 2)).join(''))];
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${lines.map((l, i) => `<row r="${i + 1}">${l}</row>`).join('')}</sheetData>` +
    (rows.length ? `<autoFilter ref="A1:${colName(head.length - 1)}${rows.length + 1}"/>` : '') +
    '</worksheet>'
  );
}

const fmtTime = (ms?: number) => (ms === undefined ? '' : new Date(ms).toLocaleString('ko-KR', { hour12: false }));

/** 회차 결과를 .xlsx 바이트로 */
export function qaRunXlsx(b: QaRunBundle): Uint8Array {
  const summary = sheetXml(
    ['TC', '우선순위', '제목', '요구사항', '결과', '방식', '시간(초)', '메모', '기록 시각'],
    b.summary.rows.map(({ case: c, result: r, status }) => [
      c.id,
      c.priority,
      c.title,
      c.requirements.join(' '),
      QA_STATUS_LABEL[status],
      r ? MODE_LABEL[r.mode] : '',
      r?.durationMs === undefined ? undefined : Math.round(r.durationMs / 100) / 10,
      r?.detail,
      fmtTime(r?.at),
    ]),
    [10, 9, 40, 14, 9, 10, 9, 60, 20],
  );
  const stepRows: Cell[][] = [];
  for (const { case: c } of b.summary.rows) {
    const s = b.scenarios.get(c.id);
    if (!s) continue;
    for (const r of buildScenarioView(s).rows) {
      stepRows.push([
        c.id,
        r.no,
        STATUS_LABEL[r.status],
        HOW_LABEL[r.how],
        r.check,
        r.expect,
        r.actual,
        r.actions.map((a) => a.text).join('\n'),
        r.evidence,
        fmtTime(r.at),
      ]);
    }
  }
  const steps = sheetXml(['TC', '단계', '판정', '방식', '확인', '기대', '실제', '조작', '근거', '시각'], stepRows, [10, 6, 8, 10, 40, 30, 30, 40, 40, 20]);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="요약" sheetId="1" r:id="rId1"/><sheet name="단계" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    // 0 기본, 1 머리줄(굵게·배경), 2 본문(위 정렬·줄바꿈)
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEFF2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
        '</styleSheet>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(summary),
    'xl/worksheets/sheet2.xml': strToU8(steps),
  };
  return zipSync(files, { level: 6 });
}

// ---------- 단계별 HTML ----------

/** 캡처를 긴 변 480px JPEG data URI 로. 못 읽으면 undefined */
async function shotUri(dir: string, file: string | undefined): Promise<string | undefined> {
  if (!file || file.includes('/') || file.includes('\\') || file.startsWith('.')) return undefined;
  const buf = await readFile(join(dir, file)).catch(() => undefined);
  if (!buf) return undefined;
  const ext = extname(file).toLowerCase();
  try {
    if (ext === '.png') return `data:image/jpeg;base64,${downscaleToJpeg(buf, 480, 70).toString('base64')}`;
  } catch {
    return undefined;
  }
  return ext === '.jpg' || ext === '.jpeg' ? `data:image/jpeg;base64,${buf.toString('base64')}` : undefined;
}

const TONE: Record<string, string> = { pass: 'ok', fail: 'bad', blocked: 'warn', skip: 'mute', 'not-run': 'mute', info: 'info' };

/** 회차 단계별 리포트 (파일 하나, 라이트·다크) */
/** 캡처 확대 스크립트. CSP 는 이 스크립트(해시)와 data: 이미지만 허용한다 — 기록 글이 새어 들어가도 실행·외부 요청이 안 된다 */
const ZOOM_JS = "document.addEventListener('click',function(e){var t=e.target;if(t&&t.classList&&t.classList.contains('shot'))t.classList.toggle('big');});";
const CSP = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(ZOOM_JS).digest('base64')}'; base-uri 'none'; form-action 'none'`;

export async function qaRunStepsHtml(b: QaRunBundle): Promise<string> {
  const { plan, run, summary } = b;
  const c = summary.counts;
  const pill = (tone: string, text: string) => `<span class="pill ${tone}">${esc(text)}</span>`;
  const counts = (['pass', 'fail', 'blocked', 'skip', 'not-run'] as const).map((k) => pill(TONE[k], `${QA_STATUS_LABEL[k]} ${c[k]}`)).join(' ');
  const toc = summary.rows
    .map(
      ({ case: tc, result: r, status }) =>
        `<tr><td class="mono"><a href="#${esc(tc.id)}">${esc(tc.id)}</a></td><td>${esc(tc.title)}</td><td>${pill(TONE[status], QA_STATUS_LABEL[status])}</td><td>${r ? MODE_LABEL[r.mode] : ''}</td><td class="faint">${esc(r?.detail ?? '')}</td></tr>`,
    )
    .join('');
  const sections: string[] = [];
  for (const { case: tc, result: r, status } of summary.rows) {
    const s = b.scenarios.get(tc.id);
    const head = `<h2 id="${esc(tc.id)}"><span class="mono">${esc(tc.id)}</span> ${esc(tc.title)} ${pill(TONE[status], QA_STATUS_LABEL[status])}</h2>`;
    if (!s) {
      sections.push(`<section>${head}<p class="faint">${esc(r?.detail ?? '단계 기록이 없습니다')}</p></section>`);
      continue;
    }
    const v = buildScenarioView(s);
    const rows: string[] = [];
    for (const row of v.rows) {
      const img = await shotUri(s.dir, row.screenshot);
      const acts = row.actions.length ? `<ol class="acts">${row.actions.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ol>` : '';
      const ea =
        row.expect || row.actual
          ? `<div class="ea">${row.expect ? `<div><b>기대</b> ${esc(row.expect)}</div>` : ''}${row.actual ? `<div class="${row.actualBad ? 'badtxt' : ''}"><b>실제</b> ${esc(row.actual)}</div>` : ''}</div>`
          : '';
      rows.push(
        `<div class="step ${row.tone}"><div class="no">${row.no}</div><div class="body">` +
          `<div>${pill(TONE[row.status], STATUS_LABEL[row.status])} <span class="faint">${HOW_LABEL[row.how]}</span></div>` +
          (row.check ? `<div class="check">${esc(row.check)}</div>` : '') +
          ea +
          acts +
          (row.evidence ? `<div class="faint">${esc(row.evidence)}</div>` : '') +
          `</div>${img ? `<img class="shot" src="${img}" alt="" />` : ''}</div>`,
      );
    }
    const verdict = s.verdict ? VERDICT_LABEL[s.verdict] : VERDICT_LABEL.running;
    sections.push(
      `<section>${head}<p class="faint">${esc(s.goal ?? '')}${s.goal ? ' · ' : ''}기록 판정 ${esc(verdict)} · ${v.rows.length}단계${s.device ? ` · ${esc(s.device)}` : ''}</p>` +
        (s.summary ? `<p>${esc(s.summary)}</p>` : '') +
        rows.join('') +
        '</section>',
    );
  }
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(plan.name)} · 회차 ${esc(run.id)}</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--fg:#1d2127;--faint:#6b7280;--line:#e3e6ea;--ok:#1f7a4d;--bad:#c0392b;--warn:#a5640c;--info:#2563eb;--mute:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1b1e23;--fg:#e6e8eb;--faint:#9aa1ab;--line:#2c3138;--ok:#4cc38a;--bad:#f07167;--warn:#e3a33b;--info:#7aa7ff;--mute:#9aa1ab}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo","Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
section,.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:14px}
.faint{color:var(--faint)}.mono{font-family:ui-monospace,Menlo,monospace}a{color:var(--info)}
.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.info{color:var(--info)}.mute{color:var(--mute)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--faint);font-weight:600;font-size:12px}
.step{display:grid;grid-template-columns:32px 1fr auto;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.step.bad{background:color-mix(in srgb,var(--bad) 7%,transparent)}.step.flag{background:color-mix(in srgb,var(--warn) 7%,transparent)}
.no{font-weight:700;color:var(--faint);text-align:right}.check{font-weight:600;margin-top:4px}.ea{margin-top:4px}.badtxt{color:var(--bad)}
.acts{margin:6px 0 0;padding-left:20px;color:var(--faint)}
.shot{width:160px;border-radius:8px;border:1px solid var(--line);cursor:zoom-in}
.shot.big{position:fixed;inset:0;margin:auto;width:auto;max-width:94vw;max-height:94vh;z-index:9;cursor:zoom-out;box-shadow:0 0 0 100vmax rgba(0,0,0,.6)}
@media (max-width:640px){.step{grid-template-columns:24px 1fr}.shot{grid-column:2;width:140px}}
</style></head><body><main>
<h1>${esc(plan.name)}</h1>
<div class="faint">${plan.app ? `<span class="mono">${esc(plan.app)}</span> · ` : ''}회차 ${esc(run.id)} · 시작 ${esc(fmtTime(run.startedAt))}</div>
<div class="card"><div>${counts}</div>
<table style="margin-top:10px"><thead><tr><th>TC</th><th>제목</th><th>결과</th><th>방식</th><th>메모</th></tr></thead><tbody>${toc}</tbody></table></div>
${sections.join('\n')}
</main>
<script>${ZOOM_JS}</script>
</body></html>`;
}

/** 회차 폴더에 내보낼 파일을 쓴다 */
export async function writeQaRunExport(planId: string, runId: string, kind: 'xlsx' | 'html'): Promise<{ path: string; bytes: number }> {
  const b = await loadQaRunBundle(planId, runId);
  const dir = qaRunDir(planId, runId);
  const path = join(dir, kind === 'xlsx' ? 'results.xlsx' : 'steps.html');
  const body = kind === 'xlsx' ? qaRunXlsx(b) : Buffer.from(await qaRunStepsHtml(b), 'utf8');
  await writeFileAtomic(path, body);
  return { path, bytes: body.byteLength };
}
