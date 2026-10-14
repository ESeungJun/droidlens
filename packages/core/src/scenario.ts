import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, safeName, timestamp, writeJson } from './workspace.js';

/**
 * 시나리오 검증 기록. 에이전트(또는 사람)가 단계마다 step()을 남기고 finish()로 리포트(HTML/JSON)를 만든다.
 */

export type StepStatus = 'pass' | 'fail' | 'info' | 'skip';

export interface ScenarioStep {
  index: number;
  at: number;
  title: string;
  status: StepStatus;
  detail?: string;
  screenshot?: string;
  screen?: string;
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
  dir: string;
}

export class Scenario {
  constructor(readonly data: ScenarioData) {}

  static async start(name: string, meta: { goal?: string; packageName?: string; device?: string } = {}): Promise<Scenario> {
    const id = `${timestamp()}_${safeName(name)}`;
    const dir = await ensureDir('scenarios', id);
    const s = new Scenario({ id, name, ...meta, startedAt: Date.now(), steps: [], dir });
    await s.persist();
    return s;
  }

  async step(title: string, status: StepStatus, opts: { detail?: string; png?: Buffer; screen?: string } = {}): Promise<ScenarioStep> {
    const index = this.data.steps.length + 1;
    let screenshot: string | undefined;
    if (opts.png) {
      screenshot = `step-${String(index).padStart(3, '0')}.png`;
      await writeFile(join(this.data.dir, screenshot), opts.png);
    }
    const step: ScenarioStep = { index, at: Date.now(), title, status, detail: opts.detail, screenshot, screen: opts.screen };
    this.data.steps.push(step);
    await this.persist();
    return step;
  }

  async finish(verdict: ScenarioData['verdict'], summary?: string): Promise<string> {
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

export function renderReport(d: ScenarioData): string {
  const color = { pass: '#16a34a', fail: '#dc2626', info: '#2563eb', skip: '#9ca3af', blocked: '#d97706' } as const;
  const dur = d.finishedAt ? `${((d.finishedAt - d.startedAt) / 1000).toFixed(1)}s` : '진행 중';
  const rows = d.steps
    .map(
      (s) => `<article class="step">
  <div class="head"><span class="badge" style="background:${color[s.status]}">${s.status.toUpperCase()}</span>
  <b>${s.index}. ${esc(s.title)}</b><time>${new Date(s.at).toLocaleTimeString()}</time></div>
  ${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}
  ${s.screen ? `<div class="screen">${esc(s.screen)}</div>` : ''}
  ${s.screenshot ? `<img loading="lazy" src="${s.screenshot}" alt="step ${s.index}">` : ''}
</article>`,
    )
    .join('\n');
  const v = d.verdict ?? 'blocked';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.name)} — 시나리오 리포트</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--card:#fff;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#eee;--card:#16161a;--line:#2a2a30}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px}
.verdict{display:inline-block;padding:4px 12px;border-radius:999px;color:#fff;font-weight:700;background:${color[v]}}
.meta{color:#888;margin:8px 0 20px}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.head{display:flex;gap:8px;align-items:center}.head time{margin-left:auto;color:#888;font-size:12px}
.badge{color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px}
pre{white-space:pre-wrap;background:rgba(127,127,127,.1);padding:8px;border-radius:8px;font-size:12px}
.screen{color:#888;font-size:12px}
img{display:block;max-width:280px;margin:10px auto 0;border-radius:10px;border:1px solid var(--line)}
</style></head><body><main>
<h1>${esc(d.name)}</h1>
<span class="verdict">${v.toUpperCase()}</span>
<div class="meta">${d.packageName ? esc(d.packageName) + ' · ' : ''}${d.device ? esc(d.device) + ' · ' : ''}${new Date(d.startedAt).toLocaleString()} · ${dur} · ${d.steps.length} steps</div>
${d.goal ? `<p><b>목표</b> ${esc(d.goal)}</p>` : ''}
${d.summary ? `<p><b>결론</b> ${esc(d.summary)}</p>` : ''}
${rows}
</main></body></html>`;
}
