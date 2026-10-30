import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type MockRule, type NetworkDetail, type NetworkEntry } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';
import { describeMock, draftFromRequest, MockPanel, type Draft } from './NetworkMocks';
import { SdkGate } from './SdkGate';

export function NetworkTab() {
  const { serial, pkg } = useApp();
  // 기기나 앱이 바뀌면 목록·마지막 id·선택을 모두 새로 시작한다 (이전 앱의 요청이 섞이지 않게)
  return <SdkGate>{(info) => <NetworkInspector key={`${serial}|${pkg}`} mockSupported={info.plugins.includes('mock')} />}</SdkGate>;
}

const statusColor = (e: NetworkEntry) =>
  e.state === 'failed' || e.status >= 500 ? 'var(--err)' : e.status >= 400 ? 'var(--warn)' : e.state === 'pending' ? 'var(--fg-faint)' : 'var(--accent)';

/** POSIX 셸 홑따옴표 인용. 안의 ' 는 '\'' 로 끊어 넣어, 붙여 넣은 명령이 값 때문에 다른 명령으로 바뀌지 않게 한다 */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const size = (n: number) => (n < 0 ? '-' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);

function pretty(body?: string): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function NetworkInspector({ mockSupported }: { mockSupported: boolean }) {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [entries, setEntries] = useState<NetworkEntry[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<NetworkDetail | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyErr, setOnlyErr] = useState(false);
  const [live, setLive] = useState(true);
  const [pane, setPane] = useState<'res' | 'req' | 'headers'>('res');
  const lastId = useRef(0);
  const pollCount = useRef(0);
  const [mocks, setMocks] = useState<MockRule[]>([]);
  const [mockOpen, setMockOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  // 켜 둔 규칙 수와 적용 횟수를 보여 주려고 주기적으로 다시 읽는다
  const loadMocks = useCallback(async () => {
    if (!serial || !pkg || !mockSupported) return;
    const list = await api.sdk<MockRule[]>(serial, pkg, 'mocks').catch(() => null);
    if (list) setMocks(list);
  }, [serial, pkg, mockSupported]);
  useEffect(() => {
    loadMocks();
    const timer = setInterval(loadMocks, 3000);
    return () => clearInterval(timer);
  }, [loadMocks]);
  const activeMocks = mocks.filter((m) => m.enabled !== false).length;

  // 앞 요청이 끝나기 전에는 다시 묻지 않는다 (응답이 1.5초를 넘기면 요청이 쌓이고 순서가 뒤바뀐다)
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (!serial || !pkg || inFlight.current) return;
    inFlight.current = true;
    try {
      // 진행 중(pending)인 가장 오래된 요청 직전부터 다시 받아, 새 요청 + 상태가 바뀐 요청만 반영한다.
      // 10번에 한 번은 전체를 받아 앱 재시작(id가 1부터 다시 시작)이나 SDK 쪽 삭제를 반영한다.
      const full = ++pollCount.current % 10 === 0;
      const pendingFrom = entriesRef.current.find((e) => e.state === 'pending')?.id;
      const since = full ? 0 : pendingFrom !== undefined ? pendingFrom - 1 : lastId.current;
      const fresh = await api.sdk<NetworkEntry[]>(serial, pkg, 'network', { since, limit: 500 }).catch(() => null);
      if (!fresh) return;
      if (full) {
        setEntries(fresh);
        lastId.current = fresh.at(-1)?.id ?? 0;
        return;
      }
      if (!fresh.length) return;
      setEntries((cur) => [...cur.filter((e) => e.id <= since), ...fresh].slice(-500));
      lastId.current = Math.max(lastId.current, fresh[fresh.length - 1].id);
    } finally {
      inFlight.current = false;
    }
  }, [serial, pkg]);
  const entriesRef = useRef<NetworkEntry[]>([]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    poll();
    if (!live) return;
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [poll, live]);

  useEffect(() => {
    if (sel == null || !serial || !pkg) return setDetail(null);
    // 다른 요청을 빠르게 연달아 고르면 늦게 온 이전 상세가 덮지 않게 한다
    let alive = true;
    api
      .sdk<NetworkDetail>(serial, pkg, 'networkDetail', sel)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null));
    return () => {
      alive = false;
    };
  }, [sel, serial, pkg, entries.find((e) => e.id === sel)?.state]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return entries
      .filter((e) => (!f || e.url.toLowerCase().includes(f)) && (!onlyErr || e.state === 'failed' || e.status >= 400))
      .slice()
      .reverse();
  }, [entries, filter, onlyErr]);

  const copyCurl = () => {
    if (!detail) return;
    // 메서드·헤더·본문·URL 모두 앱이 보낸 값이라 그대로 셸에 붙이면 명령이 실행될 수 있다. 전부 같은 인용을 거친다.
    // POSIX 셸 인용이라 cmd·PowerShell 에서는 안전하지 않다 (cmd 는 따옴표 안의 %VAR% 를 막을 방법이 없어 cmd 용은 만들지 않는다).
    // 본문은 @ 로 시작해도 파일로 읽지 않게 --data-raw, URL 은 - 로 시작해도 옵션이 되지 않게 --url 로 넘긴다
    const h = Object.entries(detail.requestHeaders).flatMap(([k, vs]) => vs.map((v) => `-H ${shq(`${k}: ${v}`)}`));
    const body = detail.requestBody ? ` --data-raw ${shq(detail.requestBody)}` : '';
    api.copy(`curl -X ${shq(detail.method)} ${h.join(' ')}${body} --url ${shq(detail.url)}`);
  };

  return (
    <>
      <div className="toolbar">
        <button className={`btn ${live ? 'on' : 'primary'}`} onClick={() => setLive((v) => !v)}>{live ? t('⏸ 실시간') : t('▶ 실시간')}</button>
        <input className="input" placeholder={t('URL 필터')} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 260 }} />
        <label className="chk"><input type="checkbox" checked={onlyErr} onChange={(e) => setOnlyErr(e.target.checked)} />{t('실패·4xx/5xx만')}</label>
        <button className="btn" onClick={async () => { if (serial && pkg) { await run(api.sdk(serial, pkg, 'clearNetwork')); setSel(null); lastId.current = 0; setEntries([]); } }}>{t('지우기')}</button>
        <span className="muted">{shown.length} / {entries.length}</span>
        <div className="spacer" />
        <button
          className={`btn ${mockOpen ? 'primary' : ''}`}
          style={activeMocks && !mockOpen ? { color: 'var(--warn)', borderColor: 'var(--warn)' } : undefined}
          onClick={() => (mockSupported ? setMockOpen((v) => !v) : toast(t('네트워크 목은 최신 SDK 에서 쓸 수 있습니다. 앱의 DroidLens SDK 버전을 올려 주세요'), true))}
          title={activeMocks ? t('켜진 목 규칙이 있어 일치하는 요청은 실제 서버로 가지 않습니다') : undefined}
        >
          {t('목 규칙')}{mocks.length ? ` (${activeMocks}/${mocks.length})` : ''}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: detail || mockOpen ? '1fr 46%' : '1fr', height: 'calc(100% - 45px)' }}>
        <div className="logs" style={{ height: '100%' }}>
          <div className="ll" style={{ gridTemplateColumns: '54px 44px 60px 1fr 70px 64px', color: 'var(--fg-faint)', position: 'sticky', top: 0, background: 'var(--bg)' }}>
            <span>#</span><span>{t('메서드')}</span><span>{t('상태')}</span><span>URL</span><span>{t('시간')}</span><span>{t('크기')}</span>
          </div>
          {shown.map((e) => (
            <div
              key={e.id}
              className="ll"
              style={{ gridTemplateColumns: '54px 44px 60px 1fr 70px 64px', cursor: 'pointer', background: sel === e.id ? 'var(--accent-dim)' : undefined }}
              onClick={() => {
                setSel(e.id);
                // 목을 편집하던 중이 아니면 고른 요청의 상세로 바꿔 보여 준다
                if (!draft) setMockOpen(false);
              }}
            >
              <span className="faint">{e.id}</span>
              <span>{e.method}</span>
              <span style={{ color: statusColor(e) }}>{e.state === 'failed' ? 'FAIL' : e.state === 'pending' ? '…' : e.status}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.url}>
                {e.mockId && <span className="pill" style={{ color: 'var(--warn)', marginRight: 6 }}>MOCK</span>}
                {e.url.replace(/^https?:\/\//, '')}
              </span>
              <span className="faint">{e.durationMs >= 0 ? `${e.durationMs}ms` : ''}</span>
              <span className="faint">{size(e.responseSize)}</span>
            </div>
          ))}
          {entries.length === 0 && <div className="empty" style={{ height: 'auto', padding: 30 }}>{t('아직 요청이 없습니다. OkHttp에 DroidLensInterceptor를 추가했는지 확인하세요.')}</div>}
        </div>
        {mockOpen && (
          <MockPanel mocks={mocks} draft={draft} setDraft={setDraft} reload={loadMocks} onClose={() => { setMockOpen(false); setDraft(null); }} />
        )}
        {detail && !mockOpen && (
          <div style={{ borderLeft: '1px solid var(--line)', overflow: 'auto', padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <b style={{ color: statusColor(detail) }}>{detail.state === 'failed' ? 'FAIL' : `${detail.status} ${detail.message ?? ''}`}</b>
              <span className="faint">{detail.durationMs}ms · {detail.protocol}</span>
              <div className="spacer" />
              {mockSupported && (
                <button className="btn sm" onClick={() => { setDraft(draftFromRequest(detail)); setMockOpen(true); }} title={t('이 요청과 같은 URL 에 돌려줄 응답을 정합니다')}>
                  {t('목 만들기')}
                </button>
              )}
              <button className="btn sm" onClick={copyCurl} title={t('bash·zsh 같은 POSIX 셸용 인용입니다. Windows cmd·PowerShell 에 붙이면 값 때문에 다른 명령이 실행될 수 있습니다')}>
                {t('cURL 복사 (bash)')}
              </button>
              <button className="btn sm" onClick={() => setSel(null)}>✕</button>
            </div>
            <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', marginBottom: 8 }}>{detail.method} {detail.url}</div>
            {detail.mockId && (
              <div className="pill" style={{ color: 'var(--warn)', marginBottom: 8 }}>
                {t('목 규칙 {id} 로 처리됨', { id: detail.mockId })}
                {(() => {
                  const m = mocks.find((x) => x.id === detail.mockId);
                  return m ? ` · ${describeMock(m, t)}` : '';
                })()}
              </div>
            )}
            {detail.error && <pre className="mono error" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5 }}>{detail.error}</pre>}
            <div style={{ display: 'flex', gap: 2, marginBottom: 8 }}>
              {([['res', '응답'], ['req', '요청'], ['headers', '헤더']] as const).map(([k, l]) => (
                <button key={k} className={`btn sm ${pane === k ? 'primary' : ''}`} onClick={() => setPane(k)}>{t(l)}</button>
              ))}
            </div>
            {pane === 'headers' ? (
              <div className="props">
                <h4 className="faint">{t('요청 헤더')}</h4>
                <Headers h={detail.requestHeaders} />
                <h4 className="faint" style={{ marginTop: 12 }}>{t('응답 헤더')}</h4>
                <Headers h={detail.responseHeaders} />
              </div>
            ) : (
              <Body
                text={pane === 'res' ? detail.responseBody : detail.requestBody}
                b64={pane === 'res' ? detail.responseBodyBase64 : detail.requestBodyBase64}
                ct={pane === 'res' ? detail.responseContentType : detail.requestContentType}
                truncated={pane === 'res' ? detail.responseTruncated : detail.requestTruncated}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Headers({ h }: { h: Record<string, string[]> }) {
  const t = useT();
  const rows = Object.entries(h ?? {});
  if (!rows.length) return <div className="faint">{t('없음')}</div>;
  return (
    <table>
      <tbody>
        {rows.map(([k, vs]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{vs.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({ text, b64, ct, truncated }: { text?: string; b64?: string; ct?: string; truncated: boolean }) {
  const t = useT();
  if (b64) {
    if (ct?.startsWith('image/')) return <img src={`data:${ct};base64,${b64}`} style={{ maxWidth: '100%' }} alt="" />;
    return <div className="faint">{t('바이너리 {n}B', { n: Math.floor(b64.length * 0.75) })} ({ct ?? t('알 수 없는 형식')})</div>;
  }
  if (!text) return <div className="faint">{t('본문 없음')}</div>;
  return (
    <>
      {truncated && <div className="pill" style={{ marginBottom: 6 }}>{t('앞부분만 기록됨')}</div>}
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11.5, margin: 0 }}>{pretty(text)}</pre>
    </>
  );
}
