import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from '../workspace.js';
import { CASE_ID, formatIssues } from '../qa/plan.js';
import { qaRunDir } from '../qa/run.js';
import { loadQaPlan, qaPlanDir, withPlanLock } from '../qa/store.js';
import type { DesignCompareResult, Severity } from './compare.js';
import { buildDesignGuide, designGuideSchema, type DesignGuide, type FigmaGuideInput, type ParsedGuide } from './guide.js';

/**
 * 디자인 TC 저장 (#77):
 *   ~/.droidlens/qa/<계획>/design/<TC>/guide.json   Figma 에서 읽어 둔 가이드 (회차와 상관없이 TC 마다 하나)
 *   ~/.droidlens/qa/<계획>/runs/<회차>/design/<TC>/  그 회차의 비교 결과
 *   ~/.droidlens/qa/<계획>/design/<TC>/last/         회차 없이 돌린 마지막 결과
 */

function caseDir(planId: string, caseId: string): string {
  if (!CASE_ID.test(caseId)) throw new Error(`TC 번호 형식이 아닙니다: ${caseId}`);
  return join(qaPlanDir(planId), 'design', caseId);
}

export const designGuideFile = (planId: string, caseId: string) => join(caseDir(planId, caseId), 'guide.json');

export function designResultDir(planId: string, caseId: string, runId?: string): string {
  if (!runId) return join(caseDir(planId, caseId), 'last');
  if (!CASE_ID.test(caseId)) throw new Error(`TC 번호 형식이 아닙니다: ${caseId}`);
  return join(qaRunDir(planId, runId), 'design', caseId);
}

async function designCase(planId: string, caseId: string) {
  const plan = await loadQaPlan(planId);
  const c = plan.cases.find((x) => x.id === caseId);
  if (!c) throw new Error(`${planId} 에 ${caseId} 가 없습니다`);
  if (!c.design?.figma)
    throw new Error(`${caseId} 에 비교할 Figma 링크(design.figma)가 없습니다. TC 를 디자인 TC 로 고치고 링크를 넣으세요`);
  return { plan, case: c, figma: c.design.figma };
}

/** Figma 커넥터 응답으로 가이드를 만들어 TC 에 저장한다. 링크는 TC 의 것을 쓴다 (에이전트가 다른 프레임을 넣지 않게) */
export function saveDesignGuide(
  planId: string,
  caseId: string,
  input: Omit<FigmaGuideInput, 'figma'>,
): Promise<ParsedGuide & { path: string }> {
  return withPlanLock(planId, async () => {
    const { figma } = await designCase(planId, caseId);
    const parsed = buildDesignGuide({ ...input, figma });
    const path = designGuideFile(planId, caseId);
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, parsed.guide);
    return { ...parsed, path };
  });
}

export async function loadDesignGuide(planId: string, caseId: string): Promise<DesignGuide | undefined> {
  const raw = await readJson<unknown>(designGuideFile(planId, caseId));
  if (raw === undefined) return undefined;
  const r = designGuideSchema.safeParse(raw);
  if (!r.success)
    throw new Error(`${caseId} 의 디자인 가이드 형식이 맞지 않습니다: ${formatIssues(r.error)}. design_guide_save 로 다시 저장하세요`);
  return r.data;
}

export { designCase as loadDesignCase };

export interface DesignRunSummary {
  counts: Record<Severity, number>;
  warnings: number;
  /** 결과 폴더의 report.html */
  report: string;
}

/** 회차 결과표에 붙일 TC 별 디자인 차이 요약 */
export async function loadDesignSummaries(planId: string, runId: string, caseIds: string[]): Promise<Map<string, DesignRunSummary>> {
  const out = new Map<string, DesignRunSummary>();
  for (const id of caseIds) {
    if (!CASE_ID.test(id)) continue;
    const dir = designResultDir(planId, id, runId);
    const r = await readJson<DesignCompareResult>(join(dir, 'diff.json')).catch(() => undefined);
    if (!r?.counts) continue;
    out.set(id, { counts: r.counts, warnings: r.warnings?.length ?? 0, report: join(dir, 'report.html') });
  }
  return out;
}
