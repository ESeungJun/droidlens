import * as dl from '@droidlens/core';
import { startClaude, type ClaudeContext, type ClaudeEvent, type ClaudeHandle } from './claude';

/**
 * QA 탭의 실행기 (#78). 한 번에 한 작업만 돈다.
 *   TC 뽑기: droidlens-qa-planner 를 헤드리스로 띄워 넣은 문서로 요구사항·TC 를 저장하게 한다 (기기 도구 없음)
 *   회차 실행: 스크립트가 이어진 TC 는 core runQaScripts 로, 나머지는 TC 마다 droidlens-verifier 를 새로 띄워 돌린다
 * 진행은 'qa:event' 로 화면에 보낸다.
 */

/** TC 하나에 주는 시간 (설계서: 기본 10분) */
export const QA_CASE_TIMEOUT_MS = 10 * 60_000;
/** TC 뽑기에 주는 시간. 문서가 길고 Figma 프레임이 많으면 오래 걸린다 */
export const QA_EXTRACT_TIMEOUT_MS = 30 * 60_000;

/** TC 뽑기에 주는 DroidLens 도구. graph_get 은 저장된 화면 지도 파일만 읽는다(기기 조작 없음, #128) */
const DROIDLENS_PLANNER_TOOLS = ['qa_plan_get', 'qa_source_read', 'qa_plan_save', 'qa_case_update', 'design_guide_save', 'graph_get'].map(
  (n) => `mcp__droidlens__${n}`,
);

/**
 * 추출 실행에만 허용하는 사용자 커넥터의 읽기 도구. 커넥터 서버 이름은 사람마다 달라서(#73: `Atlassian`·`Atlassian MCP`)
 * 흔한 이름을 모두 적는다. 없는 이름은 허용해도 아무 일이 없다
 */
const CONNECTOR_READ_TOOLS = [
  ...['claude_ai_Atlassian', 'claude_ai_Atlassian_MCP', 'Atlassian', 'atlassian'].flatMap((s) =>
    ['getConfluencePage', 'searchConfluenceUsingCql'].map((t) => `mcp__${s}__${t}`),
  ),
  ...['claude_ai_Figma', 'Figma', 'figma'].flatMap((s) =>
    ['create_session', 'get_metadata', 'get_design_context', 'get_screenshot', 'get_variable_defs'].map((t) => `mcp__${s}__${t}`),
  ),
];

export type QaJobKind = 'extract' | 'run';

export type QaEvent =
  | { kind: 'job'; job: QaJobKind; plan: string; state: 'start' }
  | { kind: 'job'; job: QaJobKind; plan: string; state: 'end'; run?: string; error?: string; cancelled?: boolean }
  /** 회차를 열었다 (화면이 결과표를 이 회차로 바꾼다) */
  | { kind: 'run'; plan: string; run: string }
  /** TC 하나를 시작했다. 앞 TC 결과는 이미 회차에 적혀 있다 */
  | { kind: 'case'; plan: string; case: string; mode: 'script' | 'agent'; index: number; total: number }
  /** 스크립트 단계 진행 */
  | { kind: 'step'; plan: string; case: string; title: string; status: 'running' | 'pass' | 'fail' | 'skip'; detail?: string }
  /** 에이전트 실행 이벤트 (글·도구 호출·확인 요청). case 가 없으면 TC 뽑기 */
  | { kind: 'agent'; plan: string; case?: string; event: ClaudeEvent };

interface Job {
  kind: QaJobKind;
  plan: string;
  abort: AbortController;
  agent: ClaudeHandle | null;
}

let job: Job | null = null;

export function qaJob(): { kind: QaJobKind; plan: string } | null {
  return job && { kind: job.kind, plan: job.plan };
}

export function stopQa(): void {
  if (!job) return;
  job.abort.abort();
  job.agent?.stop();
}

/** 확인 요청(되돌릴 수 없는 조작)에 답한다 */
export function confirmQa(id: string, approve: boolean): boolean {
  return !!job?.agent && job.agent.answer(id, approve);
}

function begin(kind: QaJobKind, plan: string, emit: (e: QaEvent) => void): Job {
  if (job)
    throw new Error(
      job.kind === 'extract'
        ? 'TC 를 뽑는 중입니다. 끝나거나 멈춘 뒤 다시 하세요'
        : 'QA 회차를 실행하는 중입니다. 끝나거나 멈춘 뒤 다시 하세요',
    );
  job = { kind, plan, abort: new AbortController(), agent: null };
  emit({ kind: 'job', job: kind, plan, state: 'start' });
  return job;
}

/**
 * 에이전트 하나를 띄워 끝날 때까지 기다린다. 시간이 지나거나 작업을 멈추면 끝낸다.
 * timedOut: 시간 제한으로 끝냈는지
 */
async function runAgent(
  j: Job,
  req: Parameters<typeof startClaude>[0],
  ctx: ClaudeContext,
  onEvent: (e: ClaudeEvent) => void,
  timeoutMs: number,
): Promise<{ timedOut: boolean; error?: string }> {
  let error: string | undefined;
  const handle = await startClaude(
    req,
    ctx,
    (e) => {
      if (e.kind === 'done' && e.error) error = e.error;
      onEvent(e);
    },
    () => j.abort.signal.aborted,
  );
  if (!handle) return { timedOut: false };
  j.agent = handle;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    handle.stop();
  }, timeoutMs);
  const onAbort = () => handle.stop();
  j.abort.signal.addEventListener('abort', onAbort);
  if (j.abort.signal.aborted) handle.stop();
  try {
    await handle.exited;
  } finally {
    clearTimeout(timer);
    j.abort.signal.removeEventListener('abort', onAbort);
    j.agent = null;
  }
  return { timedOut, error };
}

/** 넣은 문서로 요구사항·TC 를 뽑는다. 끝나면 job end 이벤트 */
export function extractQaPlan(planId: string, note: string | undefined, ctx: ClaudeContext, emit: (e: QaEvent) => void): void {
  const j = begin('extract', planId, emit);
  void (async () => {
    const plan = await dl.loadQaPlan(planId);
    if (!plan.sources.length) throw new Error('넣은 문서가 없습니다. 먼저 기획서·TC 문서를 넣으세요');
    const links = plan.sources.some((s) => s.kind === 'confluence' || s.kind === 'figma');
    const message = [
      `QA 계획 id "${plan.id}" 의 문서로 요구사항과 TC 를 뽑아 qa_plan_save 로 저장하라.`,
      '문서는 사용자가 DroidLens 앱에서 이미 넣었다. qa_plan_get 으로 문서 목록을 보고 qa_source_read 로 읽는다(qa_source_add 는 쓰지 않는다).',
      plan.cases.length
        ? '이미 저장된 TC 가 있다. qa_plan_get(full=true) 로 받아 이어서 고친다(사람이 고른 값은 저장할 때 그대로 남는다).'
        : '',
      plan.cases.some((c) => c.track === 'tc')
        ? `TC 문서에서 원문 그대로 가져온 TC ${plan.cases.filter((c) => c.track === 'tc').length}개가 이미 있다(TC 문서 갈래). 옮겨 적거나 다시 만들지 말고 {id, requirements, danger?} 로 요구사항만 잇는다. 새 TC 는 문서가 덮지 못한 요구사항에만 낸다(추가 제안이 된다).`
        : '',
      plan.app ? `대상 앱 패키지: ${plan.app}` : '',
      note?.trim() ? `사용자 요청: ${note.trim().slice(0, 2000)}` : '',
      '끝나면 최종 보고 형식으로 보고한다.',
    ]
      .filter(Boolean)
      .join('\n');
    const context = [
      '이 실행은 DroidLens 데스크톱 앱 QA 탭의 "TC 뽑기" 다. 사용자는 실행 중에 대답할 수 없다: 묻지 말고, 문서로 알 수 없는 것은 TC 의 notes 와 최종 보고에 적는다.',
      '기기 도구는 없다. 계획 저장 도구와 문서 읽기 도구만 쓴다.',
      links
        ? 'Confluence·Figma 링크는 사용자의 커넥터 읽기 도구로 읽는다. 커넥터가 없거나 거부되면 그 문서를 PDF 로 내보내 넣어 달라고 보고한다.'
        : '',
      '보고는 한국어로.',
    ]
      .filter(Boolean)
      .join('\n');
    const r = await runAgent(
      j,
      {
        agent: 'droidlens-qa-planner',
        message,
        context,
        allowedTools: [...DROIDLENS_PLANNER_TOOLS, ...(links ? CONNECTOR_READ_TOOLS : [])],
        strictMcp: !links,
        workDir: 'qa',
      },
      ctx,
      (event) => emit({ kind: 'agent', plan: planId, event }),
      QA_EXTRACT_TIMEOUT_MS,
    );
    if (r.timedOut) throw new Error(`시간 제한(${QA_EXTRACT_TIMEOUT_MS / 60_000}분)을 넘겨 멈췄습니다. 저장된 데까지는 남아 있습니다`);
    if (r.error && !j.abort.signal.aborted) throw new Error(r.error);
  })()
    .then(
      () => emit({ kind: 'job', job: 'extract', plan: planId, state: 'end', cancelled: j.abort.signal.aborted }),
      (e) =>
        emit({ kind: 'job', job: 'extract', plan: planId, state: 'end', error: (e as Error).message, cancelled: j.abort.signal.aborted }),
    )
    .finally(() => {
      if (job === j) job = null;
    });
}

export interface QaRunOptions {
  serial: string;
  /** 이어서 적을 회차. 없으면 새 회차 */
  run?: string;
  /** 스크립트로 실패·막힘이 난 TC 를 에이전트로 다시 확인할지 */
  recheckFailed?: boolean;
  timeoutMs?: number;
}

/** 고른 TC 를 차례로 돌린다. 끝나면 결과표를 쓰고 job end(run) 이벤트 */
export function runQaPlan(planId: string, opts: QaRunOptions, dev: dl.DeviceAdb, ctx: ClaudeContext, emit: (e: QaEvent) => void): void {
  if (typeof opts.serial !== 'string' || !opts.serial) throw new Error('기기를 고르세요');
  const j = begin('run', planId, emit);
  const signal = j.abort.signal;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? QA_CASE_TIMEOUT_MS, 60_000), 60 * 60_000);
  let runId: string | undefined = opts.run;
  // 이 실행이 띄운 기록만 정리한다. 같은 회차를 이어 적는 밖(다른 세션)의 기록은 두려고 (#113)
  const startedAt = Date.now();
  void (async () => {
    const plan = await dl.loadQaPlan(planId);
    if (!dl.orderQaCases(plan).length) throw new Error('고른 TC 가 없습니다. 검토 단계에서 실행할 TC 를 고르세요');
    const run = runId ? await dl.loadQaRun(planId, runId) : await dl.createQaRun(planId);
    runId = run.id;
    emit({ kind: 'run', plan: planId, run: run.id });
    let current = '';
    const scripted = await dl.runQaScripts(dev, planId, {
      run: run.id,
      signal,
      onCase: (c, i, total) => {
        current = c.id;
        emit({ kind: 'case', plan: planId, case: c.id, mode: 'script', index: i, total });
      },
      onStep: (e) => emit({ kind: 'step', plan: planId, case: current, title: e.title, status: e.status, detail: e.detail }),
    });
    const recheck = opts.recheckFailed ? scripted.ran.filter((x) => x.status === 'fail' || x.status === 'blocked').map((x) => x.case) : [];
    const byId = new Map(plan.cases.map((c) => [c.id, c]));
    for (const c of signal.aborted ? [] : scripted.pending.filter((x) => x.automatable === 'manual')) {
      await dl
        .recordQaResult(planId, run.id, {
          case: c.id,
          status: 'skip',
          mode: 'manual',
          note: { code: 'manualSkipped' },
        })
        .catch(() => undefined);
    }
    const queue = [...scripted.pending.filter((x) => x.automatable !== 'manual'), ...recheck.map((id) => byId.get(id)!).filter(Boolean)];
    for (const [i, c] of queue.entries()) {
      if (signal.aborted) break;
      emit({ kind: 'case', plan: planId, case: c.id, mode: 'agent', index: i, total: queue.length });
      const t0 = Date.now();
      // 에이전트를 띄우지 못해도(설정 파일·claude 문제) 회차를 끊지 않고 그 TC 를 막힘으로 적고 다음으로 간다
      const r = await runAgent(
        j,
        {
          agent: 'droidlens-verifier',
          message: [
            `QA 계획 "${planId}" 회차 "${run.id}" 의 TC 하나만 실행한다: ${c.id}.`,
            `scenario_start(name, tc: {plan: "${planId}", case: "${c.id}", run: "${run.id}"}) 로 시작해 TC 모드 절차대로 기대 결과마다 판정하고 scenario_finish 로 끝낸다.`,
            'qa_run_scripts·qa_report 는 부르지 않는다. 다른 TC 는 실행하지 않는다.',
          ].join('\n'),
          context: [
            '이 실행은 DroidLens 데스크톱 앱 QA 탭의 회차 실행이다. 사용자는 실행 중에 대답할 수 없다: 로그인 정보가 없거나 막히면 blocked 로 끝내고 이유를 적는다.',
            `연결된 기기 serial: ${opts.serial}`,
            plan.app ? `대상 앱: ${plan.app}` : '',
            '앱 데이터 삭제·DB 쓰기·확인 필수 버튼 누르기는 화면에 승인·거부 버튼이 떠서 사용자가 정한다. 거부되거나 시간이 지나면 같은 호출을 되풀이하지 않는다.',
            `TC 하나에 ${Math.round(timeoutMs / 60_000)}분이 주어진다. 보고는 한국어로, 짧게.`,
          ]
            .filter(Boolean)
            .join('\n'),
          allowedTools: ['mcp__droidlens__*'],
          mcpEnv: { DROIDLENS_SERIAL: opts.serial, ...(plan.app ? { DROIDLENS_APP: plan.app } : {}) },
          workDir: 'qa',
        },
        ctx,
        (event) => emit({ kind: 'agent', plan: planId, case: c.id, event }),
        timeoutMs,
      ).catch((e: Error) => ({ timedOut: false, error: e.message, notStarted: true }));
      if (signal.aborted) break;
      // 에이전트가 scenario_finish 없이 끝났으면 열린 기록을 막힘으로 마무리한다 (MCP 서버도 같이 꺼져 기록이 '진행 중' 으로 남지 않게, #101)
      const closed = await dl
        .closeOpenTcScenarios(planId, run.id, r.timedOut ? '시간 제한을 넘겨 멈춤' : '에이전트가 scenario_finish 없이 끝남', { caseId: c.id, since: t0 })
        .catch(() => []);
      // 에이전트가 scenario_finish 로 결과를 적지 않고 끝났으면 막힘으로 남긴다 (실행해서 나온 앞 결과가 있으면 그대로 둔다)
      const after = await dl.loadQaRun(planId, run.id);
      if (!after.results.some((x) => x.case === c.id && x.at >= t0)) {
        // 앱 메모는 코드 값으로 적는다. 화면·내보내기가 언어에 맞춰 보여 준다 (#114)
        const why: dl.QaNote = r.timedOut
          ? { code: 'timedOut', args: { min: Math.round(timeoutMs / 60_000) } }
          : 'notStarted' in r
            ? { code: 'agentNotStarted', args: { error: r.error.slice(0, 300) } }
            : { code: 'agentNoResult', ...(r.error ? { args: { error: r.error.slice(0, 300) } } : {}) };
        const report = closed.find((x) => x.case === c.id)?.report;
        await dl.recordQaResult(planId, run.id, { case: c.id, status: 'blocked', mode: 'manual', note: why, ...(report ? { report } : {}) }).catch(() => undefined);
      }
    }
  })()
    .then(
      () => undefined,
      (e: Error) => e,
    )
    .then(async (err) => {
      // 중간에 멈추거나 기기가 끊겨도 그때까지 적힌 결과로 결과표를 쓴다
      let reportErr: Error | undefined;
      if (runId) {
        // 멈추거나 오류로 끝난 TC 의 열린 기록은 결과를 적지 않고(남은 TC 로 둔다) 기록만 막힘으로 마무리한다 (#101, #113)
        if (signal.aborted || err) {
          const why = signal.aborted ? '회차를 멈춰 끝나지 않음' : '회차가 오류로 끝나 끝나지 않음';
          await dl.closeOpenTcScenarios(planId, runId, why, { since: startedAt }).catch(() => undefined);
        }
        try {
          await dl.writeQaReport(await dl.loadQaPlan(planId), await dl.loadQaRun(planId, runId));
        } catch (e) {
          reportErr = e as Error;
        }
      }
      const error = err?.message ?? reportErr?.message;
      emit({ kind: 'job', job: 'run', plan: planId, state: 'end', run: runId, ...(error ? { error } : {}), cancelled: signal.aborted });
    })
    .finally(() => {
      if (job === j) job = null;
    });
}
