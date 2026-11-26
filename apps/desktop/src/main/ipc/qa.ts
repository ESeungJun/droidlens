import { BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as dl from '@droidlens/core';
import { confirmQa, extractQaPlan, qaJob, runQaPlan, stopQa, type QaRunOptions } from '../qa';
import { agentsSrc, dev, getWindow, mcpScript, send, type Handle } from '../context';

/**
 * QA 탭 (#78): 계획·문서·TC 검토·회차 실행·결과. 실행기는 ../qa.ts.
 * 여기서 부르는 사람 전용 core 함수(updateQaCase·setQaCaseAllowDanger·addQaSource)는 사람이 이 화면에서 한 일에만 쓴다.
 */

/** 화면에서 사람이 고칠 수 있는 TC 칸. 실제로 누르기 허용은 qaCaseAllow, 스크립트·다시 보기 표시는 고치지 않는다 */
const HUMAN_CASE_FIELDS = ['title', 'priority', 'kind', 'preconditions', 'steps', 'expected', 'data', 'notes', 'selected'] as const;

const claudeCtx = () => ({ execPath: process.execPath, mcpScript: mcpScript(), agentsDir: agentsSrc() });
const emit = (e: unknown) => send('qa:event', e);

export function register(handle: Handle): void {
  handle('qaPlans', async () => dl.listQaPlans());
  handle('qaPlanCreate', async (name: string, app?: string) => dl.createQaPlan({ name: String(name ?? '').trim(), app: app || undefined }));
  handle('qaPlanGet', async (id: string) => {
    const plan = await dl.loadQaPlan(id);
    return { plan, coverage: dl.qaCoverage(plan), review: dl.qaReviewList(plan), runs: await dl.listQaRunIds(id) };
  });
  handle('qaPlanRename', async (id: string, name: string, app?: string) => {
    const plan = await dl.loadQaPlan(id);
    return dl.saveQaPlan({ ...plan, name: String(name ?? '').trim(), app: app || undefined });
  });

  // 파일은 사람이 대화상자에서 고른 것만 넣는다 (화면이 경로를 넘기지 않는다)
  handle('qaSourcePick', async (id: string) => {
    await dl.loadQaPlan(id);
    const r = await dialog.showOpenDialog(getWindow()!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'QA 문서', extensions: ['md', 'txt', 'pdf', 'csv', 'tsv', 'xlsx'] }],
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      try {
        const a = await dl.addQaSource(id, f);
        out.push({ id: a.source.id, title: a.source.title ?? a.source.ref, duplicate: a.duplicate, warnings: a.warnings });
      } catch (e) {
        out.push({ title: f.split(/[\\/]/).pop() ?? f, error: (e as Error).message });
      }
    }
    return out;
  });
  handle('qaSourceLink', async (id: string, url: string) => {
    const c = dl.classifyQaSource(String(url ?? '').trim());
    if (!('link' in c)) throw new Error('Confluence·Figma https 링크만 넣을 수 있습니다. 파일은 "파일 고르기…" 로 넣으세요');
    const a = await dl.addQaSource(id, c.link.ref);
    return { id: a.source.id, title: a.source.ref, duplicate: a.duplicate, warnings: a.warnings };
  });

  handle('qaCaseUpdate', async (id: string, caseId: string, patch: Record<string, unknown>) => {
    const extra = Object.keys(patch ?? {}).filter((k) => !(HUMAN_CASE_FIELDS as readonly string[]).includes(k));
    if (extra.length) throw new Error(`이 화면에서 고칠 수 없는 칸입니다: ${extra.join(', ')}`);
    return dl.updateQaCase(id, caseId, patch as Partial<dl.QaCase>);
  });
  handle('qaSelect', async (id: string, caseIds: string[], on: boolean) => {
    if (!Array.isArray(caseIds)) throw new Error('잘못된 요청입니다');
    let plan = await dl.loadQaPlan(id);
    for (const c of caseIds) plan = await dl.updateQaCase(id, String(c), { selected: on === true });
    return plan;
  });
  /** shown: 사람이 화면에서 보고 허용한 TC 내용. 그사이 TC 가 바뀌었으면 허용하지 않는다 */
  handle('qaCaseAllow', async (id: string, caseId: string, allow: boolean, shown?: dl.QaCase) => {
    if (allow !== true) return dl.setQaCaseAllowDanger(id, caseId, false);
    if (!shown || typeof shown !== 'object') throw new Error('허용하려면 화면에 보여 준 TC 내용이 필요합니다');
    return dl.setQaCaseAllowDanger(id, caseId, true, dl.dangerFingerprint(shown));
  });

  handle('qaJob', async () => qaJob());
  handle('qaExtract', async (id: string, note?: string) =>
    extractQaPlan(id, typeof note === 'string' ? note : undefined, claudeCtx(), emit),
  );
  handle('qaRun', async (id: string, opts: QaRunOptions) => {
    if (typeof opts?.serial !== 'string' || !opts.serial) throw new Error('기기를 고르세요');
    runQaPlan(id, opts, dev(opts.serial), claudeCtx(), emit);
  });
  handle('qaStop', async () => stopQa());
  handle('qaConfirm', async (id: string, approve: boolean) => confirmQa(id, approve));

  handle('qaRunGet', async (id: string, runId: string) => {
    const plan = await dl.loadQaPlan(id);
    const run = await dl.loadQaRun(id, runId);
    const summary = dl.qaRunSummary(plan, run);
    const design = await dl.loadDesignSummaries(
      id,
      runId,
      plan.cases.filter((c) => c.design).map((c) => c.id),
    );
    const dir = dl.qaRunDir(id, runId);
    const files = { html: join(dir, 'report.html'), csv: join(dir, 'results.csv'), junit: join(dir, 'junit.xml') };
    return { run, summary, design: Object.fromEntries(design), files: existsSync(files.html) ? files : undefined };
  });
  handle('qaReport', async (id: string, runId: string) => {
    const f = await dl.writeQaReport(await dl.loadQaPlan(id), await dl.loadQaRun(id, runId));
    return { html: f.html, csv: f.csv, junit: f.junit };
  });
  // #98 검증 기록에서 회차로 묶기·내보내기
  handle('qaRunIndex', async () => dl.qaRunIndex());
  const langOf = (v: unknown): dl.ExportLang => (v === 'en' ? 'en' : 'ko');
  handle('qaRunExport', async (id: string, runId: string, kind: 'xlsx' | 'html', lang?: string) => {
    if (kind !== 'xlsx' && kind !== 'html') throw new Error('잘못된 형식입니다');
    return dl.writeQaRunExport(id, runId, kind, langOf(lang));
  });
  handle('qaRunPreview', async (id: string, runId: string, lang?: string) => {
    const { path } = await dl.writeQaRunExport(id, runId, 'html', langOf(lang));
    openPreview(path);
    return path;
  });
}

/**
 * 단계별 리포트를 앱 안 창으로 연다 (#98). 우리가 만든 파일만 띄우고, 노드·preload 없는 sandbox 창이다.
 * 다른 페이지로 가거나 새 창을 열려 하면 막고, http(s) 링크만 기본 브라우저로 넘긴다.
 */
function openPreview(file: string): void {
  const parent = getWindow() ?? undefined;
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    parent,
    title: 'DroidLens',
    backgroundColor: parent?.getBackgroundColor(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const external = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    external(url);
  });
  void win.loadFile(file);
}
