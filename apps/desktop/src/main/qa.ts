import * as dl from '@droidlens/core';
import { startClaude, type ClaudeContext, type ClaudeEvent, type ClaudeHandle } from './claude';

/**
 * QA 탭의 실행기 (#78). 한 번에 한 작업만 돈다.
 *   TC 뽑기: droidlens-qa-planner 를 헤드리스로 띄워 넣은 문서로 요구사항·TC 를 저장하게 한다 (기기 도구 없음)
 *   회차 실행: 스크립트가 이어진 TC 는 core runQaScripts 로, 나머지는 droidlens-verifier 대화 하나에 TC 를 하나씩 보내 돌린다 (#130).
 *     TC 마다 시간 제한을 두고, 넘기면 그 대화를 끝내고 다음 TC 는 새 대화로 시작한다
 * 진행은 'qa:event' 로 화면에 보낸다.
 */

/** TC 하나에 주는 시간 (설계서: 기본 10분) */
export const QA_CASE_TIMEOUT_MS = 10 * 60_000;
/** 대화 하나에 보내는 TC 수 상한. 맥락이 커져 뒤 TC 가 느려지거나 앞 TC 관찰이 섞이지 않게 넘으면 새 대화로 (#130) */
export const QA_TURNS_PER_CONVERSATION = 10;
/** TC 뽑기에 주는 시간. 문서가 길고 Figma 프레임이 많으면 오래 걸린다 */
export const QA_EXTRACT_TIMEOUT_MS = 30 * 60_000;

/**
 * TC 뽑기에 주는 DroidLens 도구. graph_get 은 저장된 화면 지도 파일만 읽는다(기기 조작 없음, #128).
 * figma_outline 은 Claude Code 가 파일로 저장한 큰 Figma get_metadata 응답에서 프레임 목록만 읽는다(그 자리·이름의 파일만, #156)
 */
const DROIDLENS_PLANNER_TOOLS = ['qa_plan_get', 'qa_source_read', 'qa_plan_save', 'qa_case_update', 'design_guide_save', 'graph_get', 'figma_outline'].map(
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

/** VerifierRun.turn 의 결과 */
interface TurnResult {
  /** 턴이 끝까지 돌았다 (대화가 이어진다) */
  ok: boolean;
  timedOut: boolean;
  /** 에이전트를 띄우지 못했다 */
  notStarted: boolean;
  error?: string;
  /** 이 턴에서 앱 데이터를 바꾸는 도구를 불렀다 */
  changedData: boolean;
}

/**
 * 회차의 에이전트 TC 를 대화 하나로 돌린다 (#130). claude·MCP 서버를 TC 마다 새로 띄우지 않고, 앞 TC 에서 찾은 화면 위치를 이어 쓴다.
 * TC 마다 시간 제한을 두고, 넘기거나 대화가 끊기면 그 대화를 끝낸다. 다음 TC 는 새 대화로 시작한다
 */
class VerifierRun {
  private handle: ClaudeHandle | null = null;
  private caseId = '';
  private changedData = false;
  /** 지금 대화에서 보낸 TC 수 */
  turns = 0;

  constructor(
    private readonly j: Job,
    private readonly ctx: ClaudeContext,
    private readonly onEvent: (caseId: string, e: ClaudeEvent) => void,
    private readonly req: Parameters<typeof startClaude>[0],
  ) {}

  /** 지금 이어 갈 대화가 있는지 */
  get alive(): boolean {
    return !!this.handle;
  }

  /** TC 하나를 보내고 그 턴이 끝나거나 시간이 지날 때까지 기다린다 */
  async turn(caseId: string, message: string, timeoutMs: number): Promise<TurnResult> {
    this.caseId = caseId;
    this.changedData = false;
    const fail = (error: string): TurnResult => ({ ok: false, timedOut: false, notStarted: true, error, changedData: false });
    if (!this.handle) {
      try {
        this.handle = await startClaude(
          this.req,
          this.ctx,
          (e) => {
            if (e.kind === 'tool' && dl.changesAppData(e.name, e.input)) this.changedData = true;
            this.onEvent(this.caseId, e);
          },
          () => this.j.abort.signal.aborted,
        );
      } catch (e) {
        return fail((e as Error).message);
      }
      if (!this.handle) return fail('멈춤');
      const h = this.handle;
      this.turns = 0;
      this.j.agent = h;
      // 프로세스가 스스로 끝나면(오류·로그인 끊김) 다음 TC 는 새 대화로
      void h.exited.then(() => {
        if (this.handle === h) this.handle = null;
        if (this.j.agent === h) this.j.agent = null;
      });
    }
    const h = this.handle;
    this.turns++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timedOut = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)));
    const aborted = new Promise<'abort'>((r) => {
      onAbort = () => r('abort');
      if (this.j.abort.signal.aborted) r('abort');
      else this.j.abort.signal.addEventListener('abort', onAbort);
    });
    try {
      const out = await Promise.race([h.send(message), timedOut, aborted]);
      if (out === 'timeout' || out === 'abort') {
        await this.close(true);
        return { ok: false, timedOut: out === 'timeout', notStarted: false, changedData: this.changedData };
      }
      // 턴 도중에 프로세스가 끝났으면 대화를 이어 갈 수 없다. 다음 TC 는 새 대화로
      if (out.ended && this.handle === h) {
        this.handle = null;
        if (this.j.agent === h) this.j.agent = null;
      }
      return { ok: !out.ended, timedOut: false, notStarted: false, error: out.error, changedData: this.changedData };
    } finally {
      clearTimeout(timer);
      if (onAbort) this.j.abort.signal.removeEventListener('abort', onAbort);
      this.caseId = '';
    }
  }

  /** 대화를 끝낸다. force 가 아니면 입력을 닫아 스스로 끝나게 하고, 오래 걸리면 멈춘다 */
  async close(force = false): Promise<void> {
    const h = this.handle;
    if (!h) return;
    this.handle = null;
    if (force) h.stop();
    else {
      h.endInput();
      const t = setTimeout(() => h.stop(), 15_000);
      void h.exited.then(() => clearTimeout(t));
    }
    await h.exited;
    if (this.j.agent === h) this.j.agent = null;
  }
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
      plan.sources.some((s) => s.kind === 'figma')
        ? 'Figma get_metadata 응답이 너무 커서 파일로 저장됐다는 결과가 오면(페이지·큰 섹션 링크) 그 파일 경로를 figma_outline 에 넘겨 화면 프레임 목록을 받는다. Read 는 쓸 수 없다.'
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
    // pending 에는 스크립트가 이은 뒤 바뀐 TC 도 들어온다(#140). 실패 다시 보기와 겹치면 한 번만 돌린다
    const first = scripted.pending.filter((x) => x.automatable !== 'manual');
    const queue = [...first, ...recheck.filter((id) => !first.some((x) => x.id === id)).map((id) => byId.get(id)!).filter(Boolean)];
    // 사전 조건의 앱 버전은 에이전트를 띄우기 전에 설치된 버전과 맞춰 본다. 모르면 검사하지 않는다 (#130)
    const installed =
      scripted.installed ?? (queue.length && plan.app ? (await dl.appInfo(dev, plan.app).catch(() => undefined))?.versionName : undefined);
    // 턴 밖(대화가 끝날 때)의 이벤트는 TC 없이 보낸다. 이미 결과가 적힌 앞 TC 아래 붙지 않게
    const agentRun = new VerifierRun(j, ctx, (caseId, event) => emit({ kind: 'agent', plan: planId, ...(caseId ? { case: caseId } : {}), event }), {
      agent: 'droidlens-verifier',
      message: '',
      stream: true,
      context: [
        '이 실행은 DroidLens 데스크톱 앱 QA 탭의 회차 실행이다. 사용자는 실행 중에 대답할 수 없다: 로그인 정보가 없거나 막히면 blocked 로 끝내고 이유를 적는다.',
        '이 대화에서 TC 를 하나씩 차례로 받는다. 앞 TC 에서 알아낸 화면 위치·이동 경로는 다시 써도 되지만, 판정은 그 TC 에서 새로 본 화면으로만 한다.',
        `연결된 기기 serial: ${opts.serial}`,
        plan.app ? `대상 앱: ${plan.app}` : '',
        '앱 데이터 삭제·DB 쓰기·확인 필수 버튼 누르기는 화면에 승인·거부 버튼이 떠서 사용자가 정한다. 거부되거나 시간이 지나면 같은 호출을 되풀이하지 않는다.',
        `TC 하나에 ${Math.round(timeoutMs / 60_000)}분이 주어진다. 보고는 한국어로, 짧게.`,
      ]
        .filter(Boolean)
        .join('\n'),
      // 계획 편집·허용 켜기·회차 열기는 빼고 실행에 쓰는 도구만 (#140)
      allowedTools: dl.qaRunAllowedTools(),
      mcpEnv: { DROIDLENS_SERIAL: opts.serial, ...(plan.app ? { DROIDLENS_APP: plan.app } : {}) },
      workDir: 'qa',
    });
    // 바로 앞에서 에이전트가 돌린 TC. 통과했고 조건이 같고 데이터를 안 바꿨으면 앱을 끄지 않고 이어 간다 (#130)
    let prev: dl.PrevCaseRun | undefined;
    try {
      for (const [i, c] of queue.entries()) {
        if (signal.aborted) break;
        emit({ kind: 'case', plan: planId, case: c.id, mode: 'agent', index: i, total: queue.length });
        const unmet = dl.unmetVersionCondition(c.preconditions, installed);
        if (unmet) {
          await dl
            .recordQaResult(planId, run.id, {
              case: c.id,
              status: 'blocked',
              mode: 'manual',
              note: { code: 'versionUnmet', args: { cond: unmet.text.slice(0, 200), installed: installed! } },
            })
            .catch(() => undefined);
          continue;
        }
        const t0 = Date.now();
        // 새 대화의 첫 TC 는 늘 새로 띄운다 (앞 대화가 시간 제한으로 끊겼으면 앱 상태를 모른다)
        const restart = !agentRun.alive || dl.needsRestart(prev, { preconditions: c.preconditions, changesData: false });
        // 재시작은 에이전트에게 맡기지 않고 앱이 한다. 따르지 않아도 앞 TC 상태가 섞이지 않게 (스크립트 keepProcess 와 같은 규칙)
        if (restart && plan.app) await dl.stopApp(dev, plan.app).catch(() => undefined);
        // 에이전트를 띄우지 못해도(설정 파일·claude 문제) 회차를 끊지 않고 그 TC 를 막힘으로 적고 다음으로 간다
        const r = await agentRun.turn(
          c.id,
          [
            `QA 계획 "${planId}" 회차 "${run.id}" 의 TC 하나만 실행한다: ${c.id}.`,
            restart
              ? '시작 상태: 앱을 강제 종료해 두었다. launch_app 으로 첫 화면부터 시작한다.'
              : '시작 상태: 앞 TC 가 통과해 앱 프로세스는 그대로 둔다. launch_app(restart=false) 로 첫 화면부터 시작한다.',
            `scenario_start(name, tc: {plan: "${planId}", case: "${c.id}", run: "${run.id}"}) 로 시작해 TC 모드 절차대로 기대 결과마다 판정하고 scenario_finish 로 끝낸다.`,
            '앞 TC 의 판정·관찰은 이 TC 판정의 근거로 쓰지 않는다.',
            'qa_run_scripts·qa_report 는 부르지 않는다. 다른 TC 는 실행하지 않는다. scenario_finish 뒤 짧게 보고하고 다음 TC 를 기다린다.',
          ].join('\n'),
          timeoutMs,
        );
        if (signal.aborted) break;
        let mine = (await dl.loadQaRun(planId, run.id)).results.find((x) => x.case === c.id && x.at >= t0);
        // 결과 없이·실패·막힘·오류로 끝났거나 대화가 길어지면 대화를 닫는다. MCP 서버 메모리에 열린 시나리오·앞 TC 맥락을
        // 다음 TC 로 넘기지 않으려고. 다음 TC 는 새 대화(와 앱 재시작)로 시작한다
        if (r.ok && (!mine || mine.status !== 'pass' || r.error || agentRun.turns >= QA_TURNS_PER_CONVERSATION)) await agentRun.close();
        if (!mine) {
          // 에이전트가 scenario_finish 없이 끝났으면 열린 기록을 막힘으로 마무리한다 (#101). 대화를 닫은 뒤라 MCP 서버가 다시 쓰지 않는다
          const closed = await dl
            .closeOpenTcScenarios(planId, run.id, r.timedOut ? '시간 제한을 넘겨 멈춤' : '에이전트가 scenario_finish 없이 끝남', { caseId: c.id, since: t0 })
            .catch(() => []);
          // 닫는 사이 에이전트가 결과를 적었을 수 있다
          mine = (await dl.loadQaRun(planId, run.id)).results.find((x) => x.case === c.id && x.at >= t0);
          if (!mine) {
            // 앱 메모는 코드 값으로 적는다. 화면·내보내기가 언어에 맞춰 보여 준다 (#114)
            const why: dl.QaNote = r.timedOut
              ? { code: 'timedOut', args: { min: Math.round(timeoutMs / 60_000) } }
              : r.notStarted
                ? { code: 'agentNotStarted', args: { error: (r.error ?? '').slice(0, 300) } }
                : { code: 'agentNoResult', ...(r.error ? { args: { error: r.error.slice(0, 300) } } : {}) };
            const report = closed.find((x) => x.case === c.id)?.report;
            await dl.recordQaResult(planId, run.id, { case: c.id, status: 'blocked', mode: 'manual', note: why, ...(report ? { report } : {}) }).catch(() => undefined);
          }
        }
        prev = { status: mine?.status ?? 'blocked', preconditions: c.preconditions, changedData: r.changedData };
      }
    } finally {
      await agentRun.close();
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
