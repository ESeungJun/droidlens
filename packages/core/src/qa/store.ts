import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { droidlensHome, ensureDir, readJson, safeName, timestamp, writeFileAtomic, writeJson } from '../workspace.js';
import {
  acceptAgentPlan,
  formatIssues,
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

const locks = new Map<string, Promise<unknown>>();
/** 같은 계획을 읽고-고치고-쓰는 일은 한 프로세스 안에서 차례로 한다 (동시에 문서를 넣어 번호가 겹치지 않게) */
function withPlanLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  void tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

export async function createQaPlan(opts: { name: string; app?: string }): Promise<QaPlan> {
  const now = Date.now();
  const base = `${timestamp()}_${safeName(opts.name)}`;
  await mkdir(join(droidlensHome(), 'qa'), { recursive: true });
  // 같은 초에 같은 이름으로 만들면 뒤에 번호를 붙인다. 폴더 만들기(EEXIST)로 판정해 프로세스가 둘이어도 겹치지 않는다
  let id = base.slice(0, 120);
  for (let n = 2; ; n++) {
    try {
      await mkdir(qaPlanDir(id));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw e;
      id = `${base.slice(0, 116)}_${n}`;
    }
  }
  const plan = validatePlan({
    version: QA_PLAN_VERSION,
    id,
    name: opts.name,
    app: opts.app,
    createdAt: now,
    updatedAt: now,
  });
  await ensureDir('qa', id, 'sources');
  await writeJson(planFile(id), plan);
  return plan;
}

export async function loadQaPlan(id: string): Promise<QaPlan> {
  const raw = await readJson<unknown>(planFile(id));
  if (raw === undefined) throw new Error(`QA 계획이 없습니다: ${id}`);
  return validatePlan(raw);
}

/**
 * 사람이 고친 계획 저장 (형식 검사 후). id·만든 시각·문서 목록은 저장된 것을 지킨다.
 * 사람 전용: 위험 허용·선택·스크립트를 그대로 저장하므로 MCP 도구나 대화창 에이전트에서 부르지 않는다.
 * 에이전트 결과는 saveAgentQaPlan 으로 저장한다.
 */
export function saveQaPlan(plan: QaPlan): Promise<QaPlan> {
  return withPlanLock(plan.id, () => writeHumanPlan(plan));
}

async function writeHumanPlan(plan: QaPlan): Promise<QaPlan> {
  const prev = await loadQaPlan(plan.id);
  const next = validatePlan({
    ...plan,
    createdAt: prev.createdAt,
    sources: prev.sources,
    updatedAt: Date.now(),
  });
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
  return withPlanLock(id, async () => {
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
  });
}

/** 사람이 TC 하나를 고칠 때 (선택·위험 허용·문구). 사람 전용: MCP 도구나 대화창 에이전트에서 부르지 않는다 */
export function updateQaCase(id: string, caseId: string, patch: Partial<Omit<QaCase, 'id'>>): Promise<QaPlan> {
  return withPlanLock(id, async () => {
    const plan = await loadQaPlan(id);
    const i = plan.cases.findIndex((c) => c.id === caseId);
    if (i < 0) throw new Error(`TC 가 없습니다: ${caseId}`);
    // 사람이 선택·허용을 정하면 확인한 것으로 보고 다시 확인 표시를 지운다
    const decided = 'selected' in patch || 'allowDanger' in patch;
    const parsed = qaCaseSchema.safeParse({
      ...plan.cases[i],
      ...(decided ? { review: undefined } : {}),
      ...patch,
      id: caseId,
    });
    if (!parsed.success) throw new Error(`TC 형식 오류:\n${formatIssues(parsed.error)}`);
    const merged = parsed.data;
    const cases = plan.cases.slice();
    cases[i] = merged;
    return writeHumanPlan({ ...plan, cases });
  });
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

/**
 * 문서 하나 넣기: 파일은 사본과 글을 저장하고, 링크는 목록에만 적는다.
 * 받은 경로를 그대로 읽으므로 사람이 고른 파일(대화상자·끌어다 놓기)만 넘긴다. 에이전트가 정한 경로는 받지 않는다.
 */
export function addQaSource(id: string, input: string): Promise<AddedQaSource> {
  return withPlanLock(id, () => addSource(id, input));
}

async function addSource(id: string, input: string): Promise<AddedQaSource> {
  const plan = await loadQaPlan(id);
  const c = classifyQaSource(input);
  const sid = nextId(
    plan.sources.map((s) => s.id),
    'S',
  );
  let source: QaSource;
  let warnings: string[] = [];
  let textLength: number | undefined;
  if ('link' in c) {
    const same = plan.sources.find((s) => s.ref === c.link.ref);
    if (same) return { source: same, duplicate: true, warnings };
    source = {
      id: sid,
      kind: c.link.kind,
      ref: c.link.ref,
      addedAt: Date.now(),
    };
  } else {
    const f = await readQaSourceFile(c.file);
    const same = plan.sources.find((s) => s.hash === f.hash);
    if (same)
      return {
        source: same,
        duplicate: true,
        warnings: f.warnings,
        textLength: f.text.length,
      };
    const dir = await ensureDir('qa', id, 'sources');
    const ext = c.file.slice(c.file.lastIndexOf('.')).toLowerCase();
    await writeFile(join(dir, `${sid}${ext}`), f.bytes);
    await writeFileAtomic(join(dir, `${sid}.md`), f.text);
    source = {
      id: sid,
      kind: f.kind,
      ref: f.ref,
      title: f.title,
      hash: f.hash,
      addedAt: Date.now(),
    };
    warnings = f.warnings;
    textLength = f.text.length;
  }
  const next = validatePlan({
    ...plan,
    sources: [...plan.sources, source],
    updatedAt: Date.now(),
  });
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
