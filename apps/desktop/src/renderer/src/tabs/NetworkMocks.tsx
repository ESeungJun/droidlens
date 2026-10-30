import { useState } from 'react';
import { api, type MockRule, type NetworkDetail } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';

type Action = 'respond' | 'fail' | 'delay';

/** 편집 중인 규칙. 숫자·헤더는 입력란 그대로(문자열) 들고 있다가 저장할 때 바꾼다 */
export interface Draft {
  id?: string;
  enabled: boolean;
  url: string;
  method: string;
  action: Action;
  status: string;
  contentType: string;
  body: string;
  headers: string;
  delayMs: string;
}

const METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const toDraft = (r: MockRule): Draft => ({
  id: r.id,
  enabled: r.enabled !== false,
  url: r.url,
  method: r.method ?? '',
  action: r.fail ? 'fail' : r.status ? 'respond' : 'delay',
  status: String(r.status ?? 200),
  contentType: r.contentType ?? '',
  body: r.body ?? '',
  headers: Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  delayMs: r.delayMs ? String(r.delayMs) : '',
});

/** 기록된 요청으로 규칙 초안을 만든다. URL 은 쿼리를 빼고 호스트+경로로 맞춘다 (쿼리 값은 가려져 있을 수 있다) */
export function draftFromRequest(d: NetworkDetail): Draft {
  let url = d.url;
  try {
    const u = new URL(d.url);
    url = u.host + u.pathname;
  } catch {
    /* URL 로 읽히지 않으면 그대로 */
  }
  return {
    enabled: true,
    url,
    method: d.method,
    action: 'respond',
    status: String(d.status || 200),
    contentType: d.responseContentType ?? '',
    body: d.responseBody ?? '',
    headers: '',
    delayMs: '',
  };
}

export const emptyDraft = (): Draft => ({ enabled: true, url: '', method: '', action: 'respond', status: '200', contentType: '', body: '', headers: '', delayMs: '' });

function toRule(d: Draft, t: (s: string) => string): MockRule {
  const rule: MockRule = { enabled: d.enabled, url: d.url.trim() };
  if (d.id) rule.id = d.id;
  if (d.method) rule.method = d.method;
  const delay = d.delayMs.trim() ? Number(d.delayMs) : 0;
  if (!Number.isInteger(delay) || delay < 0) throw new Error(t('지연은 0 이상의 정수(ms)로 적어 주세요'));
  if (delay) rule.delayMs = delay;
  if (d.action === 'fail') rule.fail = true;
  if (d.action === 'respond') {
    const status = Number(d.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error(t('상태 코드는 200~599 입니다'));
    rule.status = status;
    if (d.contentType.trim()) rule.contentType = d.contentType.trim();
    rule.body = d.body;
    const headers: Record<string, string> = {};
    for (const line of d.headers.split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf(':');
      if (i <= 0) throw new Error(t('헤더는 한 줄에 "이름: 값" 으로 적어 주세요'));
      headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (Object.keys(headers).length) rule.headers = headers;
  }
  if (d.action === 'delay' && !delay) throw new Error(t('지연만 하려면 지연 시간이 필요합니다'));
  return rule;
}

export function describeMock(r: MockRule, t: (s: string, v?: Record<string, string | number>) => string): string {
  const what = r.fail ? t('연결 실패') : r.status ? t('{status} 응답', { status: r.status }) : t('실제 요청');
  return r.delayMs ? `${what} · ${t('{ms}ms 지연', { ms: r.delayMs })}` : what;
}

/** 네트워크 목 규칙 목록·편집. 규칙은 SDK 가 앱 안에 저장한다 */
export function MockPanel({
  mocks,
  draft,
  setDraft,
  reload,
  onClose,
}: {
  mocks: MockRule[];
  draft: Draft | null;
  setDraft(d: Draft | null): void;
  reload(): void;
  onClose(): void;
}) {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [busy, setBusy] = useState(false);

  const call = async <T,>(method: string, ...args: unknown[]) => {
    if (!serial || !pkg) return undefined;
    setBusy(true);
    try {
      return await run(api.sdk<T>(serial, pkg, method, ...args));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const save = async () => {
    if (!draft) return;
    let rule: MockRule;
    try {
      rule = toRule(draft, t);
    } catch (e) {
      toast((e as Error).message, true);
      return;
    }
    if (!rule.url) return toast(t('URL 에 들어 있을 문자열을 적어 주세요'), true);
    if ((await call('setMock', rule)) !== undefined) {
      toast(t('목 규칙을 저장했습니다'));
      setDraft(null);
    }
  };

  const toggle = (r: MockRule) => call('setMock', { ...r, enabled: r.enabled === false });

  const d = draft;
  return (
    <div style={{ borderLeft: '1px solid var(--line)', overflow: 'auto', padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <b>{t('네트워크 목')}</b>
        <div className="spacer" />
        <button className="btn sm" onClick={() => setDraft(emptyDraft())} disabled={busy}>+ {t('새 규칙')}</button>
        {mocks.length > 0 && (
          <button className="btn sm danger" onClick={() => call('clearMocks')} disabled={busy}>{t('모두 지우기')}</button>
        )}
        <button className="btn sm" onClick={onClose}>✕</button>
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginBottom: 10 }}>
        {t('URL 에 적은 문자열이 들어 있는 요청을 서버에 보내지 않고 정한 응답·실패로 끝내거나 늦춥니다. 규칙은 앱 안에 저장돼 앱을 다시 시작해도 남으니, 다 쓰면 끄거나 지우세요.')}
      </div>

      {d && (
        <form className="card" style={{ display: 'grid', gap: 6, marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="input" value={d.method} onChange={(e) => setDraft({ ...d, method: e.target.value })}>
              {METHODS.map((m) => <option key={m} value={m}>{m || t('모든 메서드')}</option>)}
            </select>
            <input className="input mono" style={{ flex: 1 }} autoFocus placeholder={t('URL 에 들어 있는 문자열 (예: api.example.com/v1/orders)')} value={d.url} onChange={(e) => setDraft({ ...d, url: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="input" value={d.action} onChange={(e) => setDraft({ ...d, action: e.target.value as Action })}>
              <option value="respond">{t('응답 바꾸기')}</option>
              <option value="fail">{t('연결 실패')}</option>
              <option value="delay">{t('지연만 (실제로 보냄)')}</option>
            </select>
            {d.action === 'respond' && (
              <input className="input mono" style={{ width: 70 }} placeholder="200" value={d.status} onChange={(e) => setDraft({ ...d, status: e.target.value })} title={t('상태 코드')} />
            )}
            <input className="input mono" style={{ width: 110 }} placeholder={t('지연 ms')} value={d.delayMs} onChange={(e) => setDraft({ ...d, delayMs: e.target.value })} />
          </div>
          {d.action === 'respond' && (
            <>
              <input className="input mono" placeholder="Content-Type (application/json; charset=utf-8)" value={d.contentType} onChange={(e) => setDraft({ ...d, contentType: e.target.value })} />
              <textarea className="input mono" rows={8} placeholder={t('응답 본문')} value={d.body} onChange={(e) => setDraft({ ...d, body: e.target.value })} />
              <textarea className="input mono" rows={2} placeholder={t('응답 헤더 (한 줄에 이름: 값)')} value={d.headers} onChange={(e) => setDraft({ ...d, headers: e.target.value })} />
            </>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary sm" disabled={busy}>{d.id ? t('저장') : t('추가')}</button>
            <button type="button" className="btn sm" onClick={() => setDraft(null)}>{t('취소')}</button>
          </div>
        </form>
      )}

      {mocks.length === 0 && !d && <div className="faint">{t('목 규칙이 없습니다. 요청을 고르고 "목 만들기"를 누르거나 새 규칙을 추가하세요.')}</div>}
      {mocks.map((r) => (
        <div key={r.id} className="lib" style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: r.enabled === false ? 0.55 : 1 }}>
          <input type="checkbox" checked={r.enabled !== false} onChange={() => toggle(r)} disabled={busy} title={t('켜기·끄기')} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>
              {r.method ?? '*'} {r.url}
            </div>
            <div className="ev">{describeMock(r, t)} · {t('{n}회 적용', { n: r.hits ?? 0 })}</div>
          </div>
          <button className="btn sm" onClick={() => setDraft(toDraft(r))} disabled={busy}>{t('편집')}</button>
          <button className="btn sm" onClick={() => r.id && call('removeMock', r.id)} disabled={busy}>✕</button>
        </div>
      ))}
    </div>
  );
}
