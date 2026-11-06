import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, safeName, timestamp, writeJson } from './workspace.js';
import {
  buildScenarioView,
  formatDuration,
  HOW_LABEL,
  STATUS_LABEL,
  VERDICT_LABEL,
  type ScenarioAction,
  type ScenarioData,
  type ScenarioStep,
  type StepStatus,
} from './scenario-view.js';

/**
 * 시나리오 검증 기록. 에이전트(또는 사람)가 단계마다 step()을 남기고 finish()로 리포트(HTML/JSON)를 만든다.
 */

export class Scenario {
  constructor(readonly data: ScenarioData) {}

  static async start(name: string, meta: { goal?: string; packageName?: string; device?: string } = {}): Promise<Scenario> {
    const id = `${timestamp()}_${safeName(name)}`;
    const dir = await ensureDir('scenarios', id);
    const s = new Scenario({ id, name, ...meta, startedAt: Date.now(), steps: [], dir });
    await s.persist();
    return s;
  }

  async step(
    title: string,
    status: StepStatus,
    opts: {
      detail?: string;
      png?: Buffer;
      screen?: string;
      foreign?: string;
      actions?: ScenarioAction[];
      check?: ScenarioStep['check'];
      corrects?: number;
      baseline?: { app: string; name: string; actualPng: Buffer };
    } = {},
  ): Promise<ScenarioStep> {
    const index = this.data.steps.length + 1;
    const prefix = `step-${String(index).padStart(3, '0')}`;
    let screenshot: string | undefined;
    if (opts.png) {
      screenshot = `${prefix}.png`;
      await writeFile(join(this.data.dir, screenshot), opts.png);
    }
    let baseline: ScenarioStep['baseline'];
    if (opts.baseline) {
      const actual = `${prefix}-actual.png`;
      await writeFile(join(this.data.dir, actual), opts.baseline.actualPng);
      baseline = { app: opts.baseline.app, name: opts.baseline.name, actual };
    }
    const step: ScenarioStep = {
      index,
      at: Date.now(),
      title,
      status,
      detail: opts.detail,
      screenshot,
      screen: opts.screen,
      foreign: opts.foreign,
      actions: opts.actions?.length ? opts.actions : undefined,
      check: opts.check,
      corrects: opts.corrects,
      baseline,
    };
    if (opts.actions?.length) (this.data.actions ??= []).push(...opts.actions);
    this.data.steps.push(step);
    await this.persist();
    return step;
  }

  /** trailing: 마지막 단계 뒤에 한 조작 (어느 단계에도 붙지 않아 전체 조작 로그에만 남긴다) */
  async finish(verdict: ScenarioData['verdict'], summary?: string, trailing: ScenarioAction[] = []): Promise<string> {
    if (trailing.length) (this.data.actions ??= []).push(...trailing);
    this.data.finishedAt = Date.now();
    this.data.verdict = verdict;
    this.data.summary = summary;
    await this.persist();
    const html = join(this.data.dir, 'report.html');
    await writeFile(html, renderReport(this.data));
    return html;
  }

  private persist(): Promise<void> {
    return writeJson(join(this.data.dir, 'scenario.json'), this.data);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const STATUS_TONE = { pass: 'pass', fail: 'fail', info: 'info', skip: 'mute' } as const;

const clock = (at: number) => {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

const REPORT_CSS = `
:root{--bg:#f6f7f6;--card:#fff;--fg:#151917;--muted:#5f6763;--line:#dfe3e0;--soft:#eef1ef;
--pass:#17803d;--pass-bg:#e6f4ea;--fail:#c62828;--fail-bg:#fdecec;--warn:#a15c00;--warn-bg:#fff3dc;--info:#2b5fb4;--info-bg:#e8effb;--accent:#0f6b5c;
--sans:-apple-system,"Apple SD Gothic Neo","Pretendard",system-ui,sans-serif;--mono:ui-monospace,Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1211;--card:#171b19;--fg:#e7ebe9;--muted:#97a19c;--line:#2a312e;--soft:#1e2422;
--pass:#5cc882;--pass-bg:#16301f;--fail:#ff7b72;--fail-bg:#3a1a1a;--warn:#f0b14a;--warn-bg:#35280f;--info:#82aaf0;--info-bg:#172440;--accent:#4fc2ab;color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);font-variant-numeric:tabular-nums}
main{max-width:920px;margin:0 auto;padding:28px 16px 64px;display:grid;gap:20px}
h1{font-size:22px;line-height:1.35;margin:0;word-break:keep-all;overflow-wrap:anywhere}
main>*{min-width:0}
.attn li,.meta>*{overflow-wrap:anywhere}
h2{font-size:15px;margin:0}
code,.mono{font-family:var(--mono);font-size:12px}
.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 14px}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
.chip b{font-weight:700}
.pass{color:var(--pass);background:var(--pass-bg)}.fail{color:var(--fail);background:var(--fail-bg)}
.warn{color:var(--warn);background:var(--warn-bg)}.info{color:var(--info);background:var(--info-bg)}.mute{color:var(--muted);background:var(--soft)}
.verdict{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;display:grid;gap:12px}
.verdict .top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.big{font-size:20px;font-weight:700;padding:4px 14px;border-radius:10px}
.goal{color:var(--muted);font-size:14px;margin:0}.goal b{color:var(--fg)}
.conclusion{margin:0}
.tally{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid var(--line);padding-top:12px}
.attn{background:var(--warn-bg);border-radius:14px;padding:16px 18px;display:grid;gap:10px}
.attn h2{color:var(--warn)}
.attn ol{margin:0;padding-left:20px;display:grid;gap:8px}
.attn a{color:var(--fg);font-weight:600;text-decoration:underline;text-underline-offset:3px}
.attn .why{color:var(--muted);font-size:13px;display:block}
.ok{background:var(--pass-bg);color:var(--pass);border-radius:14px;padding:12px 18px;font-weight:600}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.filters h2{margin-right:auto}
.filters button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.legend{font-size:12px;color:var(--muted)}
.steps{display:grid;gap:10px}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:16px;scroll-margin-top:16px}
.step.wide{grid-template-columns:minmax(0,1fr)}
.step.flag{border-color:var(--warn);box-shadow:inset 3px 0 0 var(--warn)}
.step.bad{border-color:var(--fail);box-shadow:inset 3px 0 0 var(--fail)}
.step:target{outline:2px solid var(--accent)}
.body{min-width:0;display:grid;gap:8px;align-content:start}
.head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.no{font-family:var(--mono);font-size:13px;color:var(--muted);min-width:22px}
.how{font-size:12px;color:var(--muted);margin-left:auto}
dl.kv{display:grid;grid-template-columns:58px minmax(0,1fr);gap:4px 10px;margin:0;font-size:14px}
dl.kv dt{color:var(--muted);font-size:13px}
dl.kv dd{margin:0;word-break:keep-all;overflow-wrap:anywhere}
dl.kv ol{margin:0;padding-left:18px}
dl.kv li .t{color:var(--muted);font-family:var(--mono);font-size:11px;margin-right:6px}
.ea{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ea div{background:var(--soft);border-radius:8px;padding:8px 10px;font-size:13px;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.ea b{display:block;font-size:11px;color:var(--muted);font-weight:600}
.ea .bad{background:var(--fail-bg)}
.note{font-size:13px;border-radius:8px;padding:8px 10px;background:var(--warn-bg)}
.note b{color:var(--warn)}
.history{font-size:12px;color:var(--muted)}.history s{color:var(--fail)}
.evid{font-size:13px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.evid a{color:inherit}
.shots{display:grid;gap:8px;align-self:start;width:132px}
.shot{display:block;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--soft);cursor:zoom-in;width:100%;position:relative}
.shot img{display:block;width:100%;height:auto}
.shot .tag{position:absolute;left:6px;bottom:6px;font-size:11px;font-weight:600;padding:1px 6px;border-radius:6px;background:var(--warn);color:#fff}
.noshot{width:132px;aspect-ratio:9/19;border:1px dashed var(--line);border-radius:10px;display:grid;place-items:center;text-align:center;font-size:12px;color:var(--muted);padding:8px}
.log{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.log summary{cursor:pointer;font-weight:600}
.log ol{margin:10px 0 0;padding-left:22px;font-size:13px;display:grid;gap:2px}
.log .t{color:var(--muted);font-family:var(--mono);font-size:11px;margin-right:8px}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.8);display:grid;place-items:center;padding:24px;z-index:20;cursor:zoom-out}
.lb img{max-height:92vh;max-width:100%;width:auto;border-radius:12px}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:560px){.step:not(.wide){grid-template-columns:minmax(0,1fr) 92px;gap:12px}.shots,.noshot{width:92px}.ea{grid-template-columns:1fr}.how{margin-left:0;width:100%}}
`;

const REPORT_JS = `
const lb=document.getElementById('lb'),lbimg=document.getElementById('lbimg');
document.querySelectorAll('.shot').forEach(b=>b.addEventListener('click',()=>{lbimg.src=b.querySelector('img').src;lb.hidden=false;}));
lb.addEventListener('click',()=>{lb.hidden=true;});
document.addEventListener('keydown',e=>{if(e.key==='Escape')lb.hidden=true;});
document.querySelectorAll('.filters button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.filters button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
  const only=b.dataset.f==='attn';
  document.querySelectorAll('.step').forEach(s=>{s.hidden=only&&!s.hasAttribute('data-attn');});
}));
`;

export function renderReport(d: ScenarioData): string {
  const v = buildScenarioView(d);
  const c = v.counts;
  const verdictCls = v.verdict === 'pass' ? 'pass' : v.verdict === 'fail' ? 'fail' : 'warn';
  const tally = v.tally.map((x) => `<span class="chip ${x.tone}">${esc(x.label)} <b>${x.count}</b></span>`).join('');
  const attn = v.attention.length
    ? `<section class="attn" aria-label="확인할 것"><h2>사람이 확인할 것 ${v.attention.length}건</h2><ol>${v.attention
        .map((a) => {
          const why = a.reasons.map((x) => x.why).filter(Boolean).join(' ');
          return `<li><a href="#s${a.index}">${a.no}단계 ${esc(a.title)}</a> — ${esc(a.reasons.map((x) => x.label).join(' · '))}${why ? `<span class="why">${esc(why)}</span>` : ''}</li>`;
        })
        .join('')}</ol></section>`
    : v.rows.length && d.finishedAt
      ? `<div class="ok">다시 볼 단계가 없습니다. 모든 단계가 기록대로 통과했습니다.</div>`
      : '';

  const shotButton = (file: string, label: string, tag?: string) =>
    `<button class="shot" type="button" aria-label="${esc(label)} 크게 보기"><img loading="lazy" src="${esc(file)}" alt="${esc(label)}">${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</button>`;

  const rows = v.rows
    .map((r) => {
      const chips = [
        r.corrected
          ? `<span class="chip warn">정정 → ${STATUS_LABEL[r.status]}</span>`
          : `<span class="chip ${STATUS_TONE[r.status]}">${STATUS_LABEL[r.status]}</span>`,
        r.foreign ? `<span class="chip fail">다른 앱 화면</span>` : '',
      ].join('');
      const how = r.corrected ? `${HOW_LABEL[r.how]} 후 정정` : HOW_LABEL[r.how];
      const actionList = r.actions.length
        ? `<ol>${r.actions.map((a) => `<li>${a.at ? `<span class="t">${clock(a.at)}</span>` : ''}${esc(a.text)}</li>`).join('')}</ol>`
        : '';
      const ea =
        r.expect !== undefined
          ? `<div class="ea"><div><b>기대</b>${esc(r.expect)}</div><div class="${r.actualBad ? 'bad' : ''}"><b>${r.corrected ? '자동 검사 결과' : '실제'}</b>${esc(r.actual ?? '-')}</div></div>`
          : '';
      const note = [
        r.foreign
          ? `<div class="note"><b>주의</b> 스샷 순간 앞 화면이 대상 앱이 아니라 <code>${esc(r.foreign)}</code> 입니다. 이 창이 판정에 영향을 줬을 수 있습니다.</div>`
          : '',
        r.corrected?.note ? `<div class="note"><b>정정</b> ${esc(r.corrected.note)}</div>` : '',
        r.corrected
          ? `<div class="history">처음 판정 <s>${STATUS_LABEL[r.corrected.from]}</s> · 정정 ${r.corrected.times > 1 ? `${r.corrected.times}회, 마지막은` : '기록은'} 원래 ${r.corrected.byIndex}단계</div>`
          : '',
      ].join('');
      const shots = [
        r.screenshot ? shotButton(r.screenshot, `${r.no}단계 화면`, r.foreign && !r.corrected?.screenshot ? '다른 앱' : r.corrected?.screenshot ? '처음' : undefined) : '',
        r.corrected?.screenshot ? shotButton(r.corrected.screenshot, `${r.no}단계 정정 근거 화면`, '정정 근거') : '',
      ].join('');
      const shot = shots
        ? `<div class="shots">${shots}</div>`
        : r.how === 'action' || r.how === 'record'
          ? ''
          : `<div class="noshot">스샷 없음</div>`;
      return `<article class="step ${r.tone}${shot ? '' : ' wide'}" id="s${r.index}"${r.reasons.length ? ' data-attn' : ''}>
<div class="body">
<div class="head"><span class="no">${r.no}</span>${chips}<span class="how">${how} · ${clock(r.at)}</span></div>
<dl class="kv">${actionList ? `<dt>조작</dt><dd>${actionList}</dd>` : ''}${r.check ? `<dt>확인</dt><dd>${esc(r.check)}</dd>` : ''}</dl>
${ea}${note}
${r.evidence ? `<div class="evid">${esc(r.evidence)}</div>` : ''}
${r.baseline ? `<div class="evid">지금 화면: <a href="${esc(r.baseline.actual)}">${esc(r.baseline.actual)}</a></div>` : ''}
</div>
${shot}
</article>`;
    })
    .join('\n');

  const log = d.actions?.length
    ? `<details class="log"><summary>전체 조작 로그 ${d.actions.length}건</summary><ol>${d.actions
        .map((a) => `<li><span class="t">${clock(a.at)}</span>${esc(a.text)}</li>`)
        .join('')}</ol></details>`
    : '';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.name)} — 시나리오 리포트</title>
<style>${REPORT_CSS}</style></head><body><main>
<header style="display:grid;gap:8px">
<h1>${esc(d.name)}</h1>
<div class="meta">${d.device ? `<span>${esc(d.device)}</span>` : ''}${d.packageName ? `<code>${esc(d.packageName)}</code>` : ''}<span>${new Date(d.startedAt).toLocaleString('ko-KR')}</span><span>${formatDuration(v.durationMs)}</span></div>
</header>
<section class="verdict" aria-label="결론">
<div class="top"><span class="big ${verdictCls}">${VERDICT_LABEL[v.verdict]}</span>${c.corrected ? `<span class="chip warn">사람이 정정한 판정 ${c.corrected}건 포함</span>` : ''}</div>
${d.goal ? `<p class="goal"><b>목표</b> ${esc(d.goal)}</p>` : ''}
${d.summary ? `<p class="conclusion">${esc(d.summary)}</p>` : ''}
${tally ? `<div class="tally">${tally}</div>` : ''}
</section>
${attn}
<section style="display:grid;gap:10px" aria-label="단계">
<div class="filters" role="group" aria-label="단계 거르기"><h2>단계 ${v.rows.length}개</h2>${v.attention.length ? '<button type="button" aria-pressed="true" data-f="all">전체</button><button type="button" aria-pressed="false" data-f="attn">확인할 것만</button>' : ''}</div>
<div class="legend">자동 검사는 DroidLens 가 화면·로그로 직접 판정한 단계, 직접 판정은 에이전트가 화면을 보고 판정한 단계입니다.</div>
<div class="steps">
${rows}
</div>
</section>
${log}
</main>
<div class="lb" hidden id="lb"><img alt="스샷 크게 보기" id="lbimg"></div>
<script>${REPORT_JS}</script>
</body></html>`;
}
