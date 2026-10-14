import { useEffect, useRef, useState } from 'react';
import { api, type ChatEvent } from './api';
import { useApp } from './App';
import { useT, type Vars } from './i18n';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'note'; text: string; vars?: Vars; error?: boolean };

const AGENTS = [
  { id: 'droidlens-verifier', label: '시나리오 검증', hint: '예: 메모 추가 버튼을 누르면 목록에 새 메모가 생기는지 확인해줘' },
  { id: 'droidlens-analyst', label: '앱 분석', hint: '예: 이 앱 기술 스택이랑 화면 구조 분석해줘' },
] as const;

const short = (name: string) => name.replace(/^mcp__droidlens__/, '');

/** Claude Code(헤드리스)로 DroidLens 전용 에이전트와 대화. 사용자의 Claude Code 로그인을 그대로 쓴다 */
export function ChatPanel({ onClose }: { onClose(): void }) {
  const { serial, pkg } = useApp();
  const t = useT();
  const [agent, setAgent] = useState<(typeof AGENTS)[number]['id']>('droidlens-verifier');
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusyState] = useState(false);
  // 확인창처럼 나중에 실행되는 콜백이 오래된 busy 값을 쓰지 않게 ref 로도 들고 있는다
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => {
    busyRef.current = v;
    setBusyState(v);
  };
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [claude, setClaude] = useState<{ version?: string; error?: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // 사용자가 멈춘 실행: 'stop'이면 결과를 "중지했습니다"로, 'reset'이면 새 대화로 넘어갔으니 남은 이벤트를 버린다
  const stopped = useRef<'stop' | 'reset' | null>(null);
  const [confirm, setConfirm] = useState<null | (() => void)>(null);

  useEffect(() => {
    api.chatStatus().then((c) => setClaude({ version: c.version })).catch((e) => setClaude({ error: (e as Error).message }));
  }, []);

  useEffect(
    () =>
      api.onChatEvent((e: ChatEvent) => {
        if (stopped.current === 'reset') {
          if (e.kind === 'done') stopped.current = null;
          return;
        }
        if (e.kind === 'done' && stopped.current === 'stop') {
          stopped.current = null;
          setBusy(false);
          if (e.sessionId) setSessionId(e.sessionId);
          setItems((cur) => [...cur, { kind: 'note', text: '중지했습니다' }]);
          return;
        }
        if (e.kind === 'session') setSessionId(e.sessionId);
        else if (e.kind === 'text') setItems((cur) => [...cur, { kind: 'assistant', text: e.text }]);
        else if (e.kind === 'tool') setItems((cur) => [...cur, { kind: 'tool', id: e.id, name: e.name, input: e.input }]);
        else if (e.kind === 'toolResult')
          setItems((cur) => cur.map((it) => (it.kind === 'tool' && it.id === e.id ? { ...it, result: e.text, isError: e.isError } : it)));
        else if (e.kind === 'done') {
          setBusy(false);
          if (e.sessionId) setSessionId(e.sessionId);
          if (e.error) setItems((cur) => [...cur, { kind: 'note', text: e.error!, error: true }]);
          else if (e.durationMs) setItems((cur) => [...cur, { kind: 'note', text: '완료 · {s}초', vars: { s: (e.durationMs! / 1000).toFixed(0) } }]);
        }
      }),
    [],
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    if (stopped.current === 'stop') stopped.current = null; // 'reset'은 이전 실행의 done이 올 때 풀린다
    setBusy(true);
    setItems((cur) => [...cur, { kind: 'user', text: message }]);
    try {
      await api.chatSend({ message, agent, sessionId, serial: serial ?? undefined, packageName: pkg ?? undefined });
    } catch (e) {
      setBusy(false);
      // 지운 대화의 실행이 시작도 못 하고 실패했으면 done 이 오지 않으니 여기서 정리한다
      if (stopped.current) {
        stopped.current = null;
        return;
      }
      setItems((cur) => [...cur, { kind: 'note', text: (e as Error).message, error: true }]);
    }
  };

  const stop = () => {
    stopped.current = 'stop';
    api.chatStop();
  };

  const reset = () => {
    if (busyRef.current) {
      stopped.current = 'reset';
      api.chatStop();
    }
    setConfirm(null);
    setItems([]);
    setSessionId(undefined);
    setBusy(false);
  };

  /** 작업 중이면 진행 중인 작업을 버려도 되는지 먼저 묻는다 */
  const guard = (action: () => void) => (busyRef.current ? setConfirm(() => action) : action());

  const hint = t(AGENTS.find((a) => a.id === agent)!.hint);

  return (
    <aside className="chat">
      <div className="chat-head">
        <b>{t('에이전트')}</b>
        <select
          className="input"
          value={agent}
          onChange={(e) => {
            const next = e.target.value as typeof agent;
            guard(() => {
              setAgent(next);
              reset();
            });
          }}
        >
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>{t(a.label)}</option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn sm" onClick={() => guard(reset)} title={t('대화 지우기')}>🗑</button>
        <button className="btn sm" onClick={onClose} title={t('닫기')}>✕</button>
      </div>

      {confirm && (
        <div className="chat-note" style={{ margin: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>{t('진행 중인 작업을 중단하고 대화를 지울까요?')}</span>
          <button className="btn sm danger" onClick={confirm}>{t('중단하고 지우기')}</button>
          <button className="btn sm" onClick={() => setConfirm(null)}>{t('계속 진행')}</button>
        </div>
      )}

      <div className="chat-body">
        {claude?.error && (
          <div className="chat-note error">
            {t(claude.error)}
            <div className="faint" style={{ marginTop: 6 }}>{t('대화창은 이 컴퓨터의 Claude Code 로그인을 사용합니다.')}</div>
          </div>
        )}
        {items.length === 0 && !claude?.error && (
          <div className="chat-empty">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('{label} 에이전트', { label: t(AGENTS.find((a) => a.id === agent)!.label) })}</div>
            <div className="faint">
              {serial ? t('기기 {serial}', { serial }) : t('기기 없음')}
              {pkg ? ` · ${pkg}` : ` · ${t('왼쪽에서 앱을 고르면 그 앱을 대상으로 합니다')}`}
            </div>
            <div className="faint" style={{ marginTop: 10 }}>{hint}</div>
            {claude?.version && <div className="faint" style={{ marginTop: 14, fontSize: 11 }}>{t('Claude Code {version} 사용', { version: claude.version })}</div>}
          </div>
        )}
        {items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="msg user">{it.text}</div>
          ) : it.kind === 'assistant' ? (
            <div key={i} className="msg assistant">{it.text}</div>
          ) : it.kind === 'tool' ? (
            <details key={i} className={`tool ${it.isError ? 'err' : ''}`}>
              <summary>
                <span className="tool-dot">{it.result === undefined ? '…' : it.isError ? '✗' : '✓'}</span> {short(it.name)}
                <span className="faint"> {summarize(it.input)}</span>
              </summary>
              {it.result !== undefined && <pre>{it.result.slice(0, 3000)}</pre>}
            </details>
          ) : (
            <div key={i} className={`chat-note ${it.error ? 'error' : ''}`}>{t(it.text, it.vars)}</div>
          ),
        )}
        {busy && <div className="chat-note">{t('작업 중…')}</div>}
        <div ref={bottom} />
      </div>

      <div className="chat-input">
        <textarea
          className="input"
          rows={3}
          placeholder={hint}
          value={input}
          disabled={!!claude?.error}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className="btn danger" onClick={stop}>{t('■ 중지')}</button>
        ) : (
          <button className="btn primary" disabled={!input.trim() || !!claude?.error} onClick={send}>{t('보내기')}</button>
        )}
      </div>
    </aside>
  );
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const s = Object.entries(input as Record<string, unknown>)
    .filter(([k]) => k !== 'serial')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}
