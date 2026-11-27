import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { droidlensHome, ensureDir, readJson, safeName, timestamp, writeFileAtomic, writeJson } from '../workspace.js';
import {
  acceptAgentPlan,
  dangerFingerprint,
  formatIssues,
  nextId,
  PLAN_ID,
  QA_PLAN_VERSION,
  qaCaseSchema,
  validatePlan,
  type QaCase,
  type QaPlan,
  type QaSource,
  caseContentHash,
  AGENT_TC_TRACK_FIELDS,
} from './plan.js';
import { classifyQaSource, readQaSourceFile } from './sources.js';
import { findTcTable, importTcRows, TC_FIELDS, type QaTable, type TcColumnMap } from './tc-table.js';

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
/** 같은 계획(과 그 회차 기록)을 읽고-고치고-쓰는 일은 한 프로세스 안에서 차례로 한다 (동시에 문서를 넣어 번호가 겹치지 않게) */
export function withPlanLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
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
 * 사람 전용: 실제로 누르기 허용·선택·스크립트를 그대로 저장하므로 MCP 도구나 대화창 에이전트에서 부르지 않는다.
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
 * 에이전트가 뽑은 요구사항·TC 저장. 문서 목록과 사람이 정한 값(실제로 누르기 허용·선택·스크립트)은
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

/** 사람이 TC 하나를 고칠 때 (선택·실제로 누르기 허용·문구). 사람 전용: MCP 도구나 대화창 에이전트에서 부르지 않는다 */
export function updateQaCase(id: string, caseId: string, patch: Partial<Omit<QaCase, 'id'>>): Promise<QaPlan> {
  return withPlanLock(id, async () => {
    const plan = await loadQaPlan(id);
    const i = plan.cases.findIndex((c) => c.id === caseId);
    if (i < 0) throw new Error(`TC 가 없습니다: ${caseId}`);
    // 사람이 선택·허용을 정하면 확인한 것으로 보고 다시 보기 표시를 지운다
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

/** 에이전트가 TC 하나를 고칠 때 받는 칸. 실제로 누르기 허용·스크립트·다시 보기 표시는 받지 않는다 */
export const AGENT_CASE_FIELDS = [
  'title',
  'requirements',
  'priority',
  'kind',
  'track',
  'preconditions',
  'steps',
  'expected',
  'data',
  'danger',
  'automatable',
  'design',
  'source',
  'notes',
  'selected',
] as const;
export type AgentCasePatch = Partial<Pick<QaCase, (typeof AGENT_CASE_FIELDS)[number]>>;

/**
 * 에이전트가 TC 하나를 고칠 때 (MCP qa_case_update).
 * 고친 계획을 saveAgentQaPlan 과 같은 규칙(acceptAgentPlan)으로 받아 실행 내용이 바뀌면 허용을 풀고 다시 보기를 단다.
 * 선택: 끄기는 언제나 되고, 켜기는 확인 필수 표시가 없는 TC 만 된다 (확인 필수 TC 는 사람이 고른다)
 */
export function updateQaCaseByAgent(id: string, caseId: string, patch: AgentCasePatch): Promise<QaPlan> {
  const extra = Object.keys(patch).filter((k) => !(AGENT_CASE_FIELDS as readonly string[]).includes(k));
  if (extra.length) return Promise.reject(new Error(`에이전트가 고칠 수 없는 칸입니다: ${extra.join(', ')}`));
  return withPlanLock(id, async () => {
    const prev = await loadQaPlan(id);
    const i = prev.cases.findIndex((c) => c.id === caseId);
    if (i < 0) throw new Error(`TC 가 없습니다: ${caseId}`);
    if (prev.cases[i].track === 'tc') {
      // TC 문서에서 가져온 원문은 에이전트가 바꾸지 못한다 (요구사항 잇기·확인 필수 표시·선택만)
      const bad = Object.keys(patch).filter((k) => !(AGENT_TC_TRACK_FIELDS as readonly string[]).includes(k) && k !== 'selected');
      if (bad.length) throw new Error(`${caseId} 는 TC 문서에서 가져온 TC 라 원문(${bad.join(', ')})을 고칠 수 없습니다. 요구사항·확인 필수 표시만 고칠 수 있어요`);
    }
    const { selected, ...rest } = patch;
    if (selected !== undefined && typeof selected !== 'boolean') throw new Error('selected 는 true 나 false 입니다');
    const parsed = qaCaseSchema.safeParse({ ...prev.cases[i], ...rest, id: caseId });
    if (!parsed.success) throw new Error(`TC 형식 오류:\n${formatIssues(parsed.error)}`);
    const cases = prev.cases.slice();
    cases[i] = parsed.data;
    const next = acceptAgentPlan({ ...prev, cases, updatedAt: Date.now() }, prev);
    const c = next.cases[i];
    // 확인 필수였거나, 지금 확인 필수거나, 다시 보기 표시가 있으면 사람이 고른다 (표시를 지우면서 고르는 것도 막는다)
    if (selected === true && !c.selected && prev.cases[i].suggested) {
      throw new Error(`${caseId} 는 추가 제안 TC 라 사용자가 QA 탭에서 넣어야 고를 수 있습니다`);
    }
    if (selected === true && !c.selected && (c.danger || prev.cases[i].danger || c.review?.length)) {
      throw new Error(`${caseId} 는 확인 필수 TC 이거나 다시 보기 표시가 있어 에이전트가 고를 수 없습니다. 사용자가 고르게 안내하세요`);
    }
    if (selected !== undefined) c.selected = selected;
    const checked = validatePlan(next);
    await writeJson(planFile(id), checked);
    return checked;
  });
}

/**
 * 통과해 저장한 회귀 스크립트를 TC 에 잇는다 (실행기 전용: scenario_finish 가 통과한 TC 에만 부른다)
 */
export function linkQaCaseScript(
  id: string,
  caseId: string,
  script: string,
  opts: { hash: string; fingerprint?: string },
): Promise<QaPlan> {
  const { fingerprint } = opts;
  return withPlanLock(id, async () => {
    const plan = await loadQaPlan(id);
    const i = plan.cases.findIndex((c) => c.id === caseId);
    if (i < 0) throw new Error(`TC 가 없습니다: ${caseId}`);
    if (fingerprint !== undefined && dangerFingerprint(plan.cases[i]) !== fingerprint) throw new Error('실행하는 동안 TC 내용이 바뀌어 스크립트를 잇지 않았습니다');
    // 확인 필수 TC 는 사람이 허용한 것이 녹화된 그 스크립트다. 에이전트가 고친 파일은 잇지 않는다(다음 회차가 막힘으로 적고 에이전트로 넘긴다)
    const cases = plan.cases.slice();
    cases[i] = { ...cases[i], script, scriptHash: opts.hash, scriptCase: caseContentHash(cases[i]) };
    const next = validatePlan({ ...plan, cases, updatedAt: Date.now() });
    await writeJson(planFile(id), next);
    return next;
  });
}

/**
 * 확인 필수 TC 의 실제로 누르기 허용을 켜거나 끈다. 켜면 고른 것으로 보고 다시 보기 표시를 지운다.
 * 켤 때는 사람에게 보여 준 내용의 dangerFingerprint 를 받아, 묻는 동안 TC 가 바뀌었으면 허용하지 않는다.
 * 사람 전용: 사람이 직접 고른 화면·CLI, 또는 사용자 확인 창을 통과한 뒤에만 부른다
 */
export function setQaCaseAllowDanger(id: string, caseId: string, allow: boolean, shownFingerprint?: string): Promise<QaPlan> {
  return withPlanLock(id, async () => {
    const plan = await loadQaPlan(id);
    const i = plan.cases.findIndex((c) => c.id === caseId);
    if (i < 0) throw new Error(`TC 가 없습니다: ${caseId}`);
    if (allow) {
      if (!plan.cases[i].danger) throw new Error(`${caseId} 에는 확인 필수 표시가 없어 허용할 것이 없습니다`);
      if (shownFingerprint === undefined) throw new Error('허용하려면 사람에게 보여 준 TC 내용이 필요합니다');
      if (dangerFingerprint(plan.cases[i]) !== shownFingerprint) throw new Error(`${caseId} 내용이 확인하는 동안 바뀌어 허용하지 않았습니다. 바뀐 내용으로 다시 확인하세요`);
    }
    const cases = plan.cases.slice();
    cases[i] = { ...cases[i], allowDanger: allow, review: undefined, ...(allow ? { selected: true } : {}) };
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
  /** TC 표를 알아보고 원문 그대로 가져온 결과 (#129) */
  tcImport?: QaTcImport;
  /** 표는 있는데 머리글을 못 알아봤을 때 열 고르기 후보 (guess: 찾은 열, 화면에 미리 채움). 사람이 열을 고르면 importQaTcTable 로 가져온다 */
  tcTables?: { sheet: string; headerRow: number; headers: string[]; guess: TcColumnMap }[];
}

export interface QaTcImport {
  /** 가져온 TC 수 */
  cases: number;
  sheets: { sheet: string; cases: number; columns: TcColumnMap }[];
  warnings: string[];
  /** 가져오는 데 걸린 시간 (ms) */
  ms: number;
}

/** 표들에서 TC 표를 찾아 가져온다. 알아본 표가 없으면 열 고르기 후보를 돌려준다 */
function importTables(
  tables: QaTable[],
  sourceId: string,
  existingIds: string[],
): { cases: QaCase[]; tcImport?: QaTcImport; tcTables?: AddedQaSource['tcTables'] } {
  const t0 = performance.now();
  const ids = [...existingIds];
  const cases: QaCase[] = [];
  const sheets: QaTcImport['sheets'] = [];
  const warnings: string[] = [];
  const candidates: NonNullable<AddedQaSource['tcTables']> = [];
  for (const t of tables) {
    const found = findTcTable(t);
    if (!found) continue;
    if (!found.detect.ok) {
      candidates.push({ sheet: found.sheet, headerRow: found.headerRow, headers: found.headers, guess: found.detect.map });
      continue;
    }
    const r = importTcRows(t, found.headerRow, found.detect.map, { sourceId, existingIds: ids });
    if (!r.cases.length) continue;
    ids.push(...r.cases.map((c) => c.id));
    cases.push(...r.cases);
    sheets.push({ sheet: t.sheet, cases: r.cases.length, columns: found.detect.map });
    warnings.push(...r.warnings);
  }
  if (!cases.length) return { cases, tcTables: candidates.length ? candidates : undefined };
  return { cases, tcImport: { cases: cases.length, sheets, warnings, ms: Math.round(performance.now() - t0) } };
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
  let imported: ReturnType<typeof importTables> = { cases: [] };
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
    if (f.tables?.length)
      imported = importTables(
        f.tables,
        sid,
        plan.cases.map((x) => x.id),
      );
  }
  const next = validatePlan({
    ...plan,
    sources: [...plan.sources, source],
    cases: [...plan.cases, ...imported.cases],
    updatedAt: Date.now(),
  });
  await writeJson(planFile(id), next);
  return { source, duplicate: false, warnings, textLength, tcImport: imported.tcImport, tcTables: imported.tcTables };
}

/**
 * 사람이 고른 열로 TC 표를 가져온다 (머리글을 못 알아본 표). 넣어 둔 문서 사본을 다시 읽는다.
 * 사람 전용: 데스크톱 열 고르기 화면에서만 부른다
 */
export function importQaTcTable(
  id: string,
  sourceId: string,
  pick: { sheet: string; headerRow: number; map: TcColumnMap },
): Promise<QaTcImport> {
  return withPlanLock(id, async () => {
    const t0 = performance.now();
    const plan = await loadQaPlan(id);
    const s = plan.sources.find((x) => x.id === sourceId);
    if (!s) throw new Error(`문서가 없습니다: ${sourceId}`);
    if (s.kind !== 'csv' && s.kind !== 'xlsx') throw new Error('TC 표는 CSV·엑셀 문서에서만 가져올 수 있어요');
    if (plan.cases.some((c) => c.track === 'tc' && c.source?.source === sourceId)) throw new Error(`${sourceId} 는 이미 TC 를 가져온 문서예요`);
    const extra = Object.keys(pick.map).filter((k) => !(TC_FIELDS as readonly string[]).includes(k));
    if (extra.length) throw new Error(`모르는 칸입니다: ${extra.join(', ')}`);
    const ext = s.ref.slice(s.ref.lastIndexOf('.')).toLowerCase();
    const f = await readQaSourceFile(join(qaPlanDir(id), 'sources', `${s.id}${ext}`));
    const t = f.tables?.find((x) => x.sheet === pick.sheet);
    if (!t) throw new Error(`시트를 찾지 못했어요: ${pick.sheet || '(CSV)'}`);
    if (!Number.isInteger(pick.headerRow) || pick.headerRow < 0 || pick.headerRow >= t.rows.length) throw new Error('머리줄 위치가 표 밖입니다');
    const r = importTcRows(t, pick.headerRow, pick.map, { sourceId, existingIds: plan.cases.map((c) => c.id) });
    if (!r.cases.length) throw new Error('가져올 행이 없어요. 고른 열을 확인해 주세요');
    const next = validatePlan({ ...plan, cases: [...plan.cases, ...r.cases], updatedAt: Date.now() });
    await writeJson(planFile(id), next);
    return {
      cases: r.cases.length,
      sheets: [{ sheet: t.sheet, cases: r.cases.length, columns: pick.map }],
      warnings: r.warnings,
      ms: Math.round(performance.now() - t0),
    };
  });
}

/** 저장해 둔 문서 글. 링크 문서면 undefined (커넥터로 읽어야 한다) */
export async function readQaSourceText(id: string, sourceId: string): Promise<string | undefined> {
  const plan = await loadQaPlan(id);
  const s = plan.sources.find((x) => x.id === sourceId);
  if (!s) throw new Error(`문서가 없습니다: ${sourceId}`);
  if (s.kind === 'confluence' || s.kind === 'figma') return undefined;
  return readFile(join(qaPlanDir(id), 'sources', `${s.id}.md`), 'utf8');
}
