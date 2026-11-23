import { useSyncExternalStore } from 'react';
import { api, type QaEvent, type QaJobKind } from './api';

/**
 * QA 작업 진행 상태. 다른 탭으로 옮겨 QA 탭이 내려가도 진행 기록과 확인 요청을 잃지 않게 화면 밖(모듈)에 둔다.
 * 위쪽 막대도 이 상태로 확인 요청이 기다리는지 보여 준다.
 */

export interface QaLogLine {
  id: number;
  case?: string;
  kind: 'text' | 'tool' | 'error' | 'step' | 'case';
  text: string;
  at: number;
  /** 스크립트 단계·TC 결과 */
  status?: 'running' | 'pass' | 'fail' | 'skip';
}

export interface QaConfirmRequest {
  id: string;
  what: string;
  case?: string;
  timeoutMs: number;
  at: number;
}

export interface QaState {
  job: { kind: QaJobKind; plan: string } | null;
  /** 지금 도는 TC */
  current: { case: string; mode: 'script' | 'agent'; index: number; total: number } | null;
  /** 실행 중인(또는 마지막으로 돈) 회차 */
  run: { plan: string; id: string } | null;
  log: QaLogLine[];
  confirms: QaConfirmRequest[];
  /** 마지막으로 끝난 작업 */
  last: { job: QaJobKind; plan: string; run?: string; error?: string; cancelled?: boolean } | null;
  /** 계획·회차 파일이 바뀌었을 수 있는 때마다 1씩 오른다 (화면이 다시 읽는다) */
  tick: number;
}

const LOG_MAX = 400;
let state: QaState = { job: null, current: null, run: null, log: [], confirms: [], last: null, tick: 0 };
const listeners = new Set<() => void>();
let seq = 0;

function set(patch: Partial<QaState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function push(line: Omit<QaLogLine, 'id' | 'at'>): QaLogLine[] {
  return [...state.log, { ...line, id: ++seq, at: Date.now() }].slice(-LOG_MAX);
}

/** 도구 이름에서 DroidLens 접두어를 뗀다 (mcp__droidlens__tap → tap) */
const toolName = (n: string) => n.replace(/^mcp__droidlens__/, '').replace(/^mcp__/, '');

function onEvent(e: QaEvent): void {
  if (e.kind === 'job') {
    if (e.state === 'start') {
      set({
        job: { kind: e.job, plan: e.plan },
        current: null,
        log: [],
        confirms: [],
        last: null,
        run: e.job === 'run' ? null : state.run,
      });
    } else {
      set({
        job: null,
        current: null,
        confirms: [],
        last: { job: e.job, plan: e.plan, run: e.run, error: e.error, cancelled: e.cancelled },
        log: e.error ? push({ kind: 'error', text: e.error }) : state.log,
        tick: state.tick + 1,
      });
    }
  } else if (e.kind === 'run') {
    set({ run: { plan: e.plan, id: e.run }, tick: state.tick + 1 });
  } else if (e.kind === 'case') {
    set({
      current: { case: e.case, mode: e.mode, index: e.index, total: e.total },
      log: push({ kind: 'case', case: e.case, text: e.case }),
      tick: state.tick + 1,
    });
  } else if (e.kind === 'step') {
    if (e.status === 'running') return;
    set({
      log: push({
        kind: 'step',
        case: e.case,
        text: e.detail && e.status === 'fail' ? `${e.title} — ${e.detail}` : e.title,
        status: e.status,
      }),
    });
  } else if (e.kind === 'agent') {
    const ev = e.event;
    if (ev.kind === 'text') set({ log: push({ kind: 'text', case: e.case, text: ev.text }) });
    else if (ev.kind === 'tool') set({ log: push({ kind: 'tool', case: e.case, text: toolName(ev.name) }), tick: state.tick + 1 });
    else if (ev.kind === 'done' && ev.error) set({ log: push({ kind: 'error', case: e.case, text: ev.error }) });
    else if (ev.kind === 'confirm')
      set({ confirms: [...state.confirms, { id: ev.id, what: ev.what, case: e.case, timeoutMs: ev.timeoutMs, at: Date.now() }] });
    else if (ev.kind === 'confirmClosed') set({ confirms: state.confirms.filter((c) => c.id !== ev.id) });
  }
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  api.onQaEvent(onEvent);
  // 앱을 새로 띄운 게 아니라 화면만 다시 그린 경우 돌고 있는 작업을 이어 보여 준다
  api
    .qaJob()
    .then((j) => j && !state.job && set({ job: j }))
    .catch(() => undefined);
}

function subscribe(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useQaState(): QaState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 확인 요청에 답하고 목록에서 뺀다 */
export async function answerQaConfirm(id: string, approve: boolean): Promise<void> {
  set({ confirms: state.confirms.filter((c) => c.id !== id) });
  await api.qaConfirm(id, approve);
}
