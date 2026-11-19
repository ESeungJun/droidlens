import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { droidlensHome, ensureDir, readJson, safeName, timestamp, writeFileAtomic, writeJson } from '../workspace.js';
import {
  acceptAgentPlan,
  nextId,
  PLAN_ID,
  QA_PLAN_VERSION,
  qaCaseSchema,
  validatePlan,
  type QaCase,
  type QaPlan,
  type QaSource,
} from './plan.js';
import { classifyQaSource, readQaSourceFile } from './sources.js';

/**
 * QA 계획 저장: ~/.droidlens/qa/<계획 id>/
 *   plan.json          요구사항·TC·문서 목록
 *   sources/S1.<확장자> 넣은 원본 파일 사본
 *   sources/S1.md      에이전트가 읽을 글
 *   runs/<회차>/       실행 결과 (#76)
 */

export function qaPlanDir(id: string): string {
  if (!PLAN_ID.test(id) || id.length > 120) throw new Error(`QA 계획 id 형식이 아닙니다: ${id}`);
  return join(droidlensHome(), 'qa', id);
}

function planFile(id: string): string {
  return join(qaPlanDir(id), 'plan.json');
}

export async function createQaPlan(opts: { name: string; app?: string }): Promise<QaPlan> {
  const now = Date.now();
  let id = `${timestamp()}_${safeName(opts.name)}`.slice(0, 120);
  // 같은 초에 같은 이름으로 두 번 만들 때
  for (let n = 2; existsSync(qaPlanDir(id)); n++) id = `${timestamp()}_${safeName(opts.name)}`.slice(0, 116) + `_${n}`;
  const plan = validatePlan({ version: QA_PLAN_VERSION, id, name: opts.name, app: opts.app, createdAt: now, updatedAt: now });
  await ensureDir('qa', id, 'sources');
  await writeJson(planFile(id), plan);
  return plan;
}

export async function loadQaPlan(id: string): Promise<QaPlan> {
  const raw = await readJson<unknown>(planFile(id));
  if (raw === undefined) throw new Error(`QA 계획이 없습니다: ${id}`);
  return validatePlan(raw);
}

/** 사람이 고친 계획 저장 (형식 검사 후). id·만든 시각·문서 목록은 저장된 것을 지킨다 */
export async function saveQaPlan(plan: QaPlan): Promise<QaPlan> {
  const prev = await loadQaPlan(plan.id);
  const next = validatePlan({ ...plan, createdAt: prev.createdAt, sources: prev.sources, updatedAt: Date.now() });
  await writeJson(planFile(plan.id), next);
  return next;
}

/**
 * 에이전트가 뽑은 요구사항·TC 저장. 문서 목록과 사람이 정한 값(위험 허용·선택·스크립트)은
 * 저장된 계획에서 이어받고, 에이전트가 넣은 allowDanger 는 지운다.
 */
export async function saveAgentQaPlan(
  id: string,
  draft: { name?: string; app?: string; requirements: unknown; cases: unknown },
): Promise<QaPlan> {
  const prev = await loadQaPlan(id);
  const next = acceptAgentPlan(
    {
      ...prev,
      name: draft.name ?? prev.name,
      app: draft.app ?? prev.app,
      requirements: draft.requirements,
      cases: draft.cases,
      updatedAt: Date.now(),
    },
    prev,
  );
  await writeJson(planFile(id), next);
  return next;
}

/** 사람이 TC 하나를 고칠 때 (선택·위험 허용·문구) */
export async function updateQaCase(id: string, caseId: string, patch: Partial<Omit<QaCase, 'id'>>): Promise<QaPlan> {
  const plan = await loadQaPlan(id);
  const i = plan.cases.findIndex((c) => c.id === caseId);
  if (i < 0) throw new Error(`TC 가 없습니다: ${caseId}`);
  const merged = qaCaseSchema.parse({ ...plan.cases[i], ...patch, id: caseId });
  const cases = plan.cases.slice();
  cases[i] = merged;
  return saveQaPlan({ ...plan, cases });
}

export interface QaPlanSummary {
  id: string;
  name: string;
  app?: string;
  updatedAt: number;
  sources: number;
  requirements: number;
  cases: number;
  selected: number;
}

/** 최근 고친 순 */
export async function listQaPlans(): Promise<QaPlanSummary[]> {
  const root = join(droidlensHome(), 'qa');
  if (!existsSync(root)) return [];
  const out: QaPlanSummary[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !PLAN_ID.test(e.name)) continue;
    try {
      const p = await loadQaPlan(e.name);
      out.push({
        id: p.id,
        name: p.name,
        app: p.app,
        updatedAt: p.updatedAt,
        sources: p.sources.length,
        requirements: p.requirements.length,
        cases: p.cases.length,
        selected: p.cases.filter((c) => c.selected).length,
      });
    } catch {
      // 깨진 계획은 목록에서 뺀다 (loadQaPlan 으로 열면 이유가 보인다)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface AddedQaSource {
  source: QaSource;
  /** 이미 같은 내용의 파일이 있어 새로 넣지 않았다 */
  duplicate: boolean;
  warnings: string[];
  /** 파일이면 읽은 글의 길이, 링크면 undefined (에이전트가 커넥터로 읽는다) */
  textLength?: number;
}

/** 문서 하나 넣기: 파일은 사본과 글을 저장하고, 링크는 목록에만 적는다 */
export async function addQaSource(id: string, input: string): Promise<AddedQaSource> {
  const plan = await loadQaPlan(id);
  const c = classifyQaSource(input);
  const sid = nextId(plan.sources.map((s) => s.id), 'S');
  let source: QaSource;
  let warnings: string[] = [];
  let textLength: number | undefined;
  if ('link' in c) {
    const same = plan.sources.find((s) => s.ref === c.link.ref);
    if (same) return { source: same, duplicate: true, warnings };
    source = { id: sid, kind: c.link.kind, ref: c.link.ref, addedAt: Date.now() };
  } else {
    const f = await readQaSourceFile(c.file);
    const same = plan.sources.find((s) => s.hash === f.hash);
    if (same) return { source: same, duplicate: true, warnings: f.warnings, textLength: f.text.length };
    const dir = await ensureDir('qa', id, 'sources');
    const ext = c.file.slice(c.file.lastIndexOf('.')).toLowerCase();
    await writeFile(join(dir, `${sid}${ext}`), f.bytes);
    await writeFileAtomic(join(dir, `${sid}.md`), f.text);
    source = { id: sid, kind: f.kind, ref: f.ref, title: f.title, hash: f.hash, addedAt: Date.now() };
    warnings = f.warnings;
    textLength = f.text.length;
  }
  const next = validatePlan({ ...plan, sources: [...plan.sources, source], updatedAt: Date.now() });
  await writeJson(planFile(id), next);
  return { source, duplicate: false, warnings, textLength };
}

/** 저장해 둔 문서 글. 링크 문서면 undefined (커넥터로 읽어야 한다) */
export async function readQaSourceText(id: string, sourceId: string): Promise<string | undefined> {
  const plan = await loadQaPlan(id);
  const s = plan.sources.find((x) => x.id === sourceId);
  if (!s) throw new Error(`문서가 없습니다: ${sourceId}`);
  if (s.kind === 'confluence' || s.kind === 'figma') return undefined;
  return readFile(join(qaPlanDir(id), 'sources', `${s.id}.md`), 'utf8');
}
