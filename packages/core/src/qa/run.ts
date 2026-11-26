import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { DeviceAdb } from '../adb.js';
import { parseScript, scriptsDir, type Script } from '../script/schema.js';
import { runScript, type ScriptRunOptions } from '../script/run.js';
import { readJson, timestamp, writeJson } from '../workspace.js';
import { CASE_ID, PLAN_ID, PRIORITIES, caseContentHash, type QaCase, type QaPlan } from './plan.js';
import type { ScenarioData } from '../scenario-view.js';
import { sha256 } from './sources.js';
import { loadQaPlan, qaPlanDir, withPlanLock } from './store.js';

/**
 * QA 회차 (#76): 고른 TC 를 우선순위 순서로 돌리고 TC 마다 결과를 남긴다.
 *   ~/.droidlens/qa/<계획 id>/runs/<회차 id>/run.json
 * 스크립트가 이어진 TC 는 스크립트로, 나머지는 에이전트(scenario_start(tc.run))가 돌린다.
 */

export const QA_RUN_VERSION = 1;
export const RUN_ID = /^\d{8}-\d{6}(_\d{1,2})?$/;
export const QA_STATUSES = ['pass', 'fail', 'blocked', 'skip'] as const;
export type QaStatus = (typeof QA_STATUSES)[number];
export const QA_STATUS_LABEL: Record<QaStatus | 'not-run', string> = {
  pass: '통과',
  fail: '실패',
  blocked: '막힘',
  skip: '건너뜀',
  'not-run': '안 돌림',
};

export const qaCaseResultSchema = z
  .object({
    case: z.string().regex(CASE_ID),
    status: z.enum(QA_STATUSES),
    /** script: 이은 스크립트로, agent: 에이전트가 시나리오로, manual: 사람·에이전트가 결과만 적음 */
    mode: z.enum(['script', 'agent', 'manual']),
    script: z.string().max(200).optional(),
    /** 시나리오 리포트(HTML) 경로 */
    report: z.string().max(2000).optional(),
    detail: z.string().max(2000).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    at: z.number().int(),
    /** 같은 회차에서 이 결과로 바뀐 앞 실행 결과 (최근 5개). 스크립트 실패 → 에이전트 재확인 통과 같은 흐름을 결과표에 남긴다 */
    history: z
      .array(z.object({ status: z.enum(QA_STATUSES), mode: z.enum(['script', 'agent', 'manual']), at: z.number().int() }).strict())
      .max(5)
      .optional(),
  })
  .strict();

export const qaRunSchema = z
  .object({
    version: z.literal(QA_RUN_VERSION),
    id: z.string().regex(RUN_ID),
    plan: z.string().max(120).regex(PLAN_ID),
    startedAt: z.number().int(),
    /** 같은 TC 를 다시 돌리면 마지막 결과가 남는다 */
    results: z.array(qaCaseResultSchema).default([]),
  })
  .strict();

export type QaCaseResult = z.infer<typeof qaCaseResultSchema>;
export type QaRun = z.infer<typeof qaRunSchema>;

function runsDir(planId: string): string {
  return join(qaPlanDir(planId), 'runs');
}

export function qaRunDir(planId: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`회차 id 형식이 아닙니다: ${runId}`);
  return join(runsDir(planId), runId);
}

const runFile = (planId: string, runId: string) => join(qaRunDir(planId, runId), 'run.json');

/** 이번 회차에 돌릴 TC: 고른 것만, 우선순위(P0 → P2) 다음 번호 순 */
export function orderQaCases(plan: QaPlan): QaCase[] {
  return plan.cases
    .filter((c) => c.selected)
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export async function createQaRun(planId: string): Promise<QaRun> {
  await loadQaPlan(planId);
  await mkdir(runsDir(planId), { recursive: true });
  const base = timestamp();
  let id = base;
  for (let n = 2; ; n++) {
    try {
      await mkdir(qaRunDir(planId, id));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw e;
      id = `${base}_${n}`;
    }
  }
  const run: QaRun = { version: QA_RUN_VERSION, id, plan: planId, startedAt: Date.now(), results: [] };
  await writeJson(runFile(planId, id), run);
  return run;
}

export async function loadQaRun(planId: string, runId: string): Promise<QaRun> {
  const raw = await readJson<unknown>(runFile(planId, runId));
  if (raw === undefined) throw new Error(`회차가 없습니다: ${runId}`);
  const r = qaRunSchema.safeParse(raw);
  if (!r.success) throw new Error(`회차 기록 형식 오류: ${r.error.issues[0]?.message ?? ''}`);
  if (r.data.plan !== planId || r.data.id !== runId) throw new Error(`회차 기록이 이 계획 것이 아닙니다: ${runId}`);
  return r.data;
}

/** 회차 id 목록 (최근 것부터) */
export async function listQaRunIds(planId: string): Promise<string[]> {
  const dir = runsDir(planId);
  if (!existsSync(dir)) return [];
  // 같은 초의 _2 … _99 는 숫자로 비교한다 (_10 이 _2 보다 앞에 오지 않게)
  const key = (x: string) => {
    const [b, n] = x.split('_');
    return `${b}_${(n ?? '1').padStart(2, '0')}`;
  };
  return (await readdir(dir)).filter((x) => RUN_ID.test(x)).sort((a, b) => key(b).localeCompare(key(a)));
}

/** 가장 최근 회차 (없으면 undefined) */
export async function latestQaRun(planId: string): Promise<QaRun | undefined> {
  for (const id of await listQaRunIds(planId)) {
    const r = await loadQaRun(planId, id).catch(() => undefined);
    if (r) return r;
  }
  return undefined;
}

/**
 * TC 결과 하나를 회차에 적는다 (같은 TC 의 앞 결과는 바꾸고, 바뀐 실행 결과는 history 에 남긴다).
 * manual(실행 없이 적는 건너뜀·막힘)은 고른 TC 에만, 실행해서 나온 결과(막힘 포함)가 없을 때만 적는다 (실패를 건너뜀으로 숨기지 않게).
 * 메모에 TC 입력값이 들어 있으면 가린다
 */
export function recordQaResult(planId: string, runId: string, result: Omit<QaCaseResult, 'at'>): Promise<QaRun> {
  return withPlanLock(planId, async () => {
    const run = await loadQaRun(planId, runId);
    const plan = await loadQaPlan(planId);
    const c = plan.cases.find((x) => x.id === result.case);
    if (!c) throw new Error(`TC 가 없습니다: ${result.case}`);
    const prev = run.results.find((x) => x.case === result.case);
    if (result.mode === 'manual') {
      if (result.status === 'pass' || result.status === 'fail') throw new Error('통과·실패는 실행한 결과로만 적습니다');
      if (!c.selected) throw new Error(`${result.case} 는 고르지 않은 TC 라 결과를 적지 않습니다`);
      if (prev && prev.mode !== 'manual')
        throw new Error(
          `${result.case} 는 이 회차에서 이미 실행해 ${QA_STATUS_LABEL[prev.status]} 했습니다. 실행 결과는 다시 실행해서만 바꿉니다`,
        );
    }
    const history =
      prev && prev.mode !== 'manual'
        ? [...(prev.history ?? []), { status: prev.status, mode: prev.mode, at: prev.at }].slice(-5)
        : prev?.history;
    const r = qaCaseResultSchema.parse({
      ...result,
      ...(result.detail ? { detail: maskCaseData(result.detail, c.data) } : {}),
      at: Date.now(),
      ...(history?.length ? { history } : {}),
    });
    const next: QaRun = { ...run, results: [...run.results.filter((x) => x.case !== r.case), r] };
    await writeJson(runFile(planId, runId), next);
    return next;
  });
}

/**
 * TC 에 이은 스크립트를 읽는다. 스크립트의 tc 칸이 이 TC 를 가리키는지, 이은 뒤 바뀌지 않았는지(sha256) 본다.
 * 바뀌었으면 changed=true: 확인 필수 동작은 누르지 않고 돌린다
 */
export async function readCaseScript(
  planId: string,
  c: QaCase,
): Promise<{ script: Script; path: string; changed: boolean } | { error: string }> {
  if (!c.script) return { error: '이은 스크립트가 없습니다' };
  const path = join(await scriptsDir(), `${c.script}.yaml`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { error: `스크립트 파일이 없습니다: ${c.script}` };
  }
  let script: Script;
  try {
    script = parseScript(bytes.toString('utf8'));
  } catch (e) {
    return { error: `스크립트 형식 오류: ${(e as Error).message.split('\n')[0]}` };
  }
  if (script.tc?.plan !== planId || script.tc.case !== c.id) return { error: `스크립트 ${c.script} 가 이 TC 의 것이 아닙니다` };
  // TC 내용이 바뀌었으면 옛 흐름을 녹화한 스크립트다. 결과도 새 내용의 결과가 아니라 돌리지 않는다
  if (c.scriptCase && c.scriptCase !== caseContentHash(c))
    return { error: 'TC 내용이 스크립트를 이은 뒤 바뀌었습니다. 바뀐 내용으로 다시 실행해 통과하면 스크립트가 새로 이어집니다' };
  // 이은 TC 내용·파일 해시를 모르는 예전 연결도 바뀐 것으로 보고 확인 필수 동작은 누르지 않는다
  return { script, path, changed: !c.scriptCase || c.scriptHash !== sha256(bytes) };
}

export interface QaScriptRunResult {
  run: QaRun;
  /** 이번에 스크립트로 돌린 TC 결과 */
  ran: QaCaseResult[];
  /** 스크립트가 없어 에이전트가 돌려야 할 TC (우선순위 순) */
  pending: QaCase[];
  /** 다시 보기 표시가 있어 돌리지 않고 막힘으로 적은 TC (사람이 확인해야 함) */
  needsReview: QaCase[];
  /** 취소로 돌리지 못한 스크립트 TC */
  remaining: QaCase[];
}

/**
 * 고른 TC 중 스크립트가 이어진 것을 차례로 돌려 회차에 적는다.
 * 확인 필수 동작은 사람이 그 TC 에 허용했고 스크립트가 이은 뒤 그대로일 때만 누른다(아니면 guardDanger).
 * 실패한 TC 를 에이전트로 다시 볼지는 부르는 쪽이 정한다(ran 의 fail·blocked)
 */
export async function runQaScripts(
  dev: DeviceAdb,
  planId: string,
  opts: {
    run?: string;
    signal?: AbortSignal;
    onCase?: (c: QaCase, i: number, total: number) => void;
    onStep?: ScriptRunOptions['onStep'];
  } = {},
): Promise<QaScriptRunResult> {
  const plan = await loadQaPlan(planId);
  let run = opts.run ? await loadQaRun(planId, opts.run) : await createQaRun(planId);
  const selected = orderQaCases(plan);
  // 다시 보기 표시가 남은 TC 는 사람이 확인하기 전까지 돌리지 않는다 (scenario_start(tc) 도 거부한다)
  const needsReview = selected.filter((c) => c.review?.length);
  const ordered = selected.filter((c) => !c.review?.length);
  const scripted = ordered.filter((c) => c.script);
  const pending = ordered.filter((c) => !c.script);
  for (const c of needsReview) {
    run = await recordQaResult(planId, run.id, {
      case: c.id,
      status: 'blocked',
      mode: 'manual',
      detail: '다시 보기 표시가 있어 실행하지 않았습니다. 사람이 확인해야 합니다',
    }).catch(() => run);
  }
  const ran: QaCaseResult[] = [];
  let i = 0;
  for (; i < scripted.length; i++) {
    if (opts.signal?.aborted) break;
    const c = scripted[i];
    opts.onCase?.(c, i, scripted.length);
    const s = await readCaseScript(planId, c);
    let result: Omit<QaCaseResult, 'at'>;
    if ('error' in s) {
      result = { case: c.id, status: 'blocked', mode: 'script', script: c.script, detail: s.error };
    } else {
      const t0 = Date.now();
      try {
        const r = await runScript(dev, s.script, {
          sourcePath: s.path,
          signal: opts.signal,
          onStep: opts.onStep,
          guardDanger: !(c.allowDanger && !s.changed),
          qaRun: run.id,
        });
        const note =
          s.changed && c.danger && c.allowDanger
            ? c.scriptCase
              ? '스크립트 파일이 TC 에 이은 뒤 바뀌어 확인 필수 동작은 누르지 않았습니다'
              : '해시 없이 이은 스크립트라 확인 필수 동작은 누르지 않았습니다 (다시 실행해 통과하면 새로 이어집니다)'
            : undefined;
        result = {
          case: c.id,
          status: r.verdict === 'pass' ? 'pass' : r.verdict === 'blocked' ? 'blocked' : 'fail',
          mode: 'script',
          script: c.script,
          report: r.report,
          durationMs: r.durationMs,
          ...(note || r.scenario.summary ? { detail: [note, r.scenario.summary].filter(Boolean).join(' · ').slice(0, 2000) } : {}),
        };
      } catch (e) {
        result = {
          case: c.id,
          status: 'blocked',
          mode: 'script',
          script: c.script,
          detail: (e as Error).message.slice(0, 2000),
          durationMs: Date.now() - t0,
        };
      }
    }
    // 도중에 멈춘 TC 는 결과를 적지 않고 남은 것으로 둔다 (이미 실패를 본 경우만 남긴다)
    if (opts.signal?.aborted && result.status !== 'fail') break;
    run = await recordQaResult(planId, run.id, result);
    ran.push(run.results.find((x) => x.case === c.id)!);
  }
  return { run, ran, pending, needsReview, remaining: scripted.slice(i) };
}

export interface QaRunRow {
  case: QaCase;
  result?: QaCaseResult;
  status: QaStatus | 'not-run';
}

export interface QaRunSummary {
  rows: QaRunRow[];
  counts: Record<QaStatus | 'not-run', number>;
  /** 요구사항별: 덮는 고른 TC 가 모두 통과면 pass, 하나라도 실패·막힘이면 fail, 아니면 not-run */
  requirements: { id: string; text: string; status: 'pass' | 'fail' | 'not-run'; cases: string[] }[];
}

/** 회차 결과를 계획의 고른 TC 와 맞대어 집계 (결과표·CLI·MCP 공용) */
export function qaRunSummary(plan: QaPlan, run: QaRun): QaRunSummary {
  const byCase = new Map(run.results.map((r) => [r.case, r]));
  const ordered = orderQaCases(plan);
  // 고르지 않았어도 이번 회차에 결과가 있으면 표에 넣는다
  const extra = plan.cases.filter((c) => !c.selected && byCase.has(c.id));
  const rows: QaRunRow[] = [...ordered, ...extra].map((c) => {
    const result = byCase.get(c.id);
    return { case: c, result, status: result?.status ?? 'not-run' };
  });
  const counts = { pass: 0, fail: 0, blocked: 0, skip: 0, 'not-run': 0 } as QaRunSummary['counts'];
  for (const r of rows) counts[r.status]++;
  const status = new Map(rows.map((r) => [r.case.id, r.status]));
  const requirements = plan.requirements.map((req) => {
    const cases = ordered.filter((c) => c.requirements.includes(req.id)).map((c) => c.id);
    const st = cases.map((id) => status.get(id)!);
    const s: 'pass' | 'fail' | 'not-run' = st.some((x) => x === 'fail' || x === 'blocked')
      ? 'fail'
      : st.length && st.every((x) => x === 'pass' || x === 'skip') && st.includes('pass')
        ? 'pass'
        : 'not-run';
    return { id: req.id, text: req.text, status: s, cases };
  });
  return { rows, counts, requirements };
}

/**
 * 메모에 TC 입력값(계정·비밀번호 등)이 들어 있으면 가린다. 입력값을 띄어쓰기·구분 기호로 나눈 4글자 이상 조각을 찾는다
 * (결과표·CSV·JUnit 이 CI 산출물로 나가므로)
 */
export function maskCaseData(text: string, data?: string): string {
  if (!data) return text;
  const parts = [...new Set(data.split(/[\s,;:=|/]+/).filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const p of parts) out = out.split(p).join('***');
  return out;
}

/**
 * 에이전트가 pass 로 끝낸 TC 시나리오에 통과 근거가 있는지. DroidLens 가 직접 검사(assert)해 통과한 단계가 하나 이상이고,
 * 정정 뒤에도 실패로 남은 단계가 없어야 한다. 근거가 없으면 그 이유 (회차에는 막힘으로 적고 스크립트도 잇지 않는다)
 */
export function missingPassEvidence(d: Pick<ScenarioData, 'steps'>): string | undefined {
  const final = new Map<number, string>();
  for (const s of d.steps) if (s.corrects === undefined) final.set(s.index, s.status);
  for (const s of d.steps) if (s.corrects !== undefined) final.set(s.corrects, s.status);
  const base = d.steps.filter((s) => s.corrects === undefined);
  if (base.some((s) => final.get(s.index) === 'fail')) return '실패로 남은 단계가 있습니다';
  if (!base.some((s) => s.check?.by === 'assert' && s.status === 'pass' && final.get(s.index) === 'pass'))
    return 'DroidLens 가 직접 검사(assert)해 통과한 단계가 없습니다';
  return undefined;
}
