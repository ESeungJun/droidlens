import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { scenarioStale, type ScenarioData } from '../scenario-view.js';
import { parseScript } from '../script/schema.js';
import { droidlensHome, readJson } from '../workspace.js';
import { listQaRunIds } from './run.js';
import { scenarioDirReal } from './scenario-dir.js';
import { loadQaPlan, qaPlanDir, withPlanLock } from './store.js';

/**
 * QA 계획 지우기 (#133). 사람이 QA 탭에서 확인한 뒤에만 부른다 (MCP 도구로 열지 않는다: 에이전트가 계획을 지우면 안 된다).
 * 계획 폴더(문서·회차·결과표)를 지운다. 그 계획에 이어진 TC 기록·스크립트는 withRecords 일 때만 같이 지운다.
 * 폴더는 손댄 것일 수 있다: 심볼릭 링크를 따라 계획 폴더·시나리오 폴더·스크립트 폴더 밖을 지우지 않는다.
 */

export interface QaPlanDeleteInfo {
  id: string;
  name: string;
  runs: number;
  /** 이 계획을 가리키는 TC 기록(시나리오) 수 */
  records: number;
  /** 이 계획의 TC 에 이은 스크립트 수 */
  scripts: number;
  /** 끝나지 않은 TC 기록이 있다 (회차가 돌고 있다) */
  running: boolean;
}

export interface QaPlanDeleteResult {
  id: string;
  records: number;
  scripts: number;
}

/** 실제 경로가 root 바로 아래 항목인지 */
async function directChild(root: string, path: string): Promise<string | undefined> {
  const r = await realpath(root).catch(() => undefined);
  const p = await realpath(path).catch(() => undefined);
  if (!r || !p) return undefined;
  const base = r + sep;
  return p.startsWith(base) && !p.slice(base.length).includes(sep) ? p : undefined;
}

/** 이 계획을 가리키는 시나리오 기록 (실제 폴더 경로와 끝났는지) */
async function planRecords(planId: string): Promise<{ dir: string; open: boolean }[]> {
  const root = join(droidlensHome(), 'scenarios');
  if (!existsSync(root)) return [];
  const out: { dir: string; open: boolean }[] = [];
  for (const id of await readdir(root)) {
    const d = await readJson<ScenarioData>(join(root, id, 'scenario.json')).catch(() => undefined);
    if (!d || d.tc?.plan !== planId) continue;
    const dir = await scenarioDirReal(join(root, id));
    if (!dir) continue;
    const open = !d.finishedAt && Array.isArray(d.steps) && !scenarioStale(d);
    out.push({ dir, open });
  }
  return out;
}

/** 이 계획의 TC 에 이은 스크립트 (스크립트의 tc.plan 으로 본다). 스크립트 폴더 바로 아래 일반 파일만 */
async function planScripts(planId: string): Promise<string[]> {
  const root = join(droidlensHome(), 'scripts');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const f of await readdir(root)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const p = join(root, f);
    const st = await lstat(p).catch(() => undefined);
    if (!st?.isFile() || st.size > 4 * 1024 * 1024) continue;
    try {
      if (parseScript(await readFile(p, 'utf8')).tc?.plan !== planId) continue;
    } catch {
      continue;
    }
    if (await directChild(root, p)) out.push(p);
  }
  return out;
}

/** 지우기 전에 보여 줄 것: 이름·회차 수·같이 지울 수 있는 기록·스크립트 수 */
export async function qaPlanDeleteInfo(id: string): Promise<QaPlanDeleteInfo> {
  const plan = await loadQaPlan(id);
  const [runs, records, scripts] = await Promise.all([listQaRunIds(id), planRecords(id), planScripts(id)]);
  return { id, name: plan.name, runs: runs.length, records: records.length, scripts: scripts.length, running: records.some((r) => r.open) };
}

export async function deleteQaPlan(id: string, opts: { withRecords?: boolean } = {}): Promise<QaPlanDeleteResult> {
  const dir = qaPlanDir(id); // id 형식 검사 (틀리면 거부된 Promise 로)
  return withPlanLock(id, async () => {
    // 계획 폴더는 qa 폴더 바로 아래 실제 폴더여야 한다 (링크면 지우지 않는다)
    const st = await lstat(dir).catch(() => undefined);
    if (!st) throw new Error(`QA 계획이 없습니다: ${id}`);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('QA 계획 폴더가 아닙니다');
    const real = await directChild(dirname(dir), dir);
    if (!real) throw new Error('QA 계획 폴더가 아닙니다');
    const records = await planRecords(id);
    if (records.some((r) => r.open)) throw new Error('이 계획의 회차가 돌고 있어 지울 수 없습니다. 회차를 멈추거나 끝난 뒤에 지워 주세요');
    let scripts: string[] = [];
    if (opts.withRecords) {
      scripts = await planScripts(id);
      for (const r of records) await rm(r.dir, { recursive: true, force: true });
      for (const p of scripts) await rm(p, { force: true });
    }
    await rm(real, { recursive: true, force: true });
    return { id, records: opts.withRecords ? records.length : 0, scripts: scripts.length };
  });
}
