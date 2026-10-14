import { useCallback, useEffect, useState } from 'react';
import { api, type DbInfo, type PrefsFile, type QueryResult, type SdkEvent } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';
import { SdkGate } from './SdkGate';

export function AppDataTab() {
  const t = useT();
  const [view, setView] = useState<'prefs' | 'db' | 'events'>('prefs');
  return (
    <SdkGate>
      {(info) => (
        <>
          <div className="toolbar">
            {([['prefs', 'SharedPreferences'], ['db', '데이터베이스'], ['events', '커스텀 이벤트']] as const).map(([k, l]) => (
              <button key={k} className={`btn ${view === k ? 'primary' : ''}`} onClick={() => setView(k)}>{t(l)}</button>
            ))}
            <span className="faint" style={{ fontSize: 11 }}>SDK {info.sdkVersion} · PID {info.pid}</span>
          </div>
          {view === 'prefs' && <Prefs />}
          {view === 'db' && <Db />}
          {view === 'events' && <Events />}
        </>
      )}
    </SdkGate>
  );
}

function Prefs() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [files, setFiles] = useState<PrefsFile[] | null>(null);
  const [editing, setEditing] = useState<{ file: string; key: string; type: string; value: string } | null>(null);
  const load = useCallback(async () => {
    if (serial && pkg) setFiles((await run(api.sdk<PrefsFile[]>(serial, pkg, 'prefs'))) ?? []);
  }, [serial, pkg, run]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editing || !serial || !pkg) return;
    const r = await run(api.sdk(serial, pkg, 'setPref', editing.file, editing.key, editing.type, editing.value));
    if (r !== undefined) {
      toast(t('{key} 저장됨', { key: editing.key }));
      setEditing(null);
      load();
    }
  };

  return (
    <div className="scroll">
      <button className="btn sm" onClick={load} style={{ marginBottom: 10 }}>↻ {t('새로고침')}</button>
      {files === null ? <div className="faint">{t('불러오는 중…')}</div> : files.length === 0 && <div className="faint">{t('SharedPreferences 파일이 없습니다')}</div>}
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
        {(files ?? []).map((f) => (
          <div className="card" key={f.name}>
            <h5>{f.name}.xml</h5>
            <div className="props" style={{ padding: 0 }}>
              <table>
                <tbody>
                  {Object.entries(f.entries).map(([k, v]) => {
                    const isEdit = editing?.file === f.name && editing.key === k;
                    return (
                      <tr key={k}>
                        <td title={v.type}>{k}</td>
                        <td>
                          {isEdit ? (
                            <form style={{ display: 'flex', gap: 4 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
                              {v.type === 'boolean' ? (
                                <select className="input" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })}>
                                  <option>true</option>
                                  <option>false</option>
                                </select>
                              ) : (
                                <input className="input" style={{ flex: 1 }} autoFocus value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
                              )}
                              <button className="btn sm primary">{t('저장')}</button>
                              <button type="button" className="btn sm" onClick={() => setEditing(null)}>{t('취소')}</button>
                            </form>
                          ) : (
                            <span
                              style={{ cursor: v.type === 'unknown' ? 'default' : 'pointer' }}
                              title={t('클릭해서 편집')}
                              onClick={() => v.type !== 'unknown' && setEditing({ file: f.name, key: k, type: v.type, value: typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value) })}
                            >
                              {typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value)} <span className="faint">{v.type}</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Db() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [dbs, setDbs] = useState<DbInfo[] | null>(null);
  const [db, setDb] = useState('');
  const [sql, setSql] = useState('');
  const [write, setWrite] = useState(false);
  const [res, setRes] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!serial || !pkg) return;
    const l = (await run(api.sdk<DbInfo[]>(serial, pkg, 'databases'))) ?? [];
    setDbs(l);
    setDb((cur) => cur || l[0]?.name || '');
  }, [serial, pkg, run]);
  useEffect(() => {
    load();
  }, [load]);

  const exec = async (q = sql, dbName = db) => {
    if (!serial || !pkg || !dbName || !q.trim()) return;
    setBusy(true);
    const r = await run(api.sdk<QueryResult>(serial, pkg, 'query', dbName, q, write));
    setBusy(false);
    if (r) {
      setRes(r);
      if (r.changes !== undefined) {
        toast(t('{n}행 변경', { n: r.changes }));
        load();
      }
    }
  };

  const openTable = (dbName: string, table: string) => {
    const q = `SELECT * FROM "${table}" LIMIT 200`;
    setDb(dbName);
    setSql(q);
    exec(q, dbName);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: 'calc(100% - 45px)' }}>
      <div style={{ borderRight: '1px solid var(--line)', overflow: 'auto', padding: 10 }}>
        {dbs === null ? <div className="faint">{t('불러오는 중…')}</div> : dbs.length === 0 && <div className="faint">{t('DB가 없습니다')}</div>}
        {(dbs ?? []).map((d) => (
          <div key={d.name} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>{d.name} <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>{(d.size / 1024).toFixed(0)}KB</span></div>
            {d.error && <div className="error" style={{ fontSize: 11 }}>{d.error}</div>}
            {d.tables.map((tb) => (
              <div key={tb.name} className="pkg" style={{ padding: '3px 8px' }} onClick={() => openTable(d.name, tb.name)} title={tb.columns.map((c) => `${c.name} ${c.type}`).join('\n')}>
                {tb.type === 'view' ? '👁 ' : ''}{tb.name} <span className="faint">{tb.rowCount ?? ''}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
        <div style={{ padding: 10, borderBottom: '1px solid var(--line)', display: 'grid', gap: 6 }}>
          <textarea
            className="input mono"
            rows={3}
            placeholder="SELECT * FROM ..."
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) exec();
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="input" value={db} onChange={(e) => setDb(e.target.value)}>
              {(dbs ?? []).map((d) => <option key={d.name}>{d.name}</option>)}
            </select>
            <button className="btn primary" disabled={busy} onClick={() => exec()}>{t('실행 (⌘↵)')}</button>
            <label className="chk" title={t('INSERT/UPDATE/DELETE 등 앱 데이터를 바꾸는 SQL 허용')}>
              <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
              <span style={{ color: write ? 'var(--warn)' : undefined }}>{t('쓰기 허용')}</span>
            </label>
            {res?.total !== undefined && <span className="muted">{res.truncated ? t('{n}행 중 500행', { n: res.total }) : t('{n}행', { n: res.total })}</span>}
          </div>
        </div>
        <div style={{ overflow: 'auto' }}>
          {res?.columns && (
            <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 11.5, width: 'max-content', minWidth: '100%' }}>
              <thead>
                <tr>
                  {res.columns.map((c) => (
                    <th key={c} style={{ textAlign: 'left', padding: '5px 10px', borderBottom: '1px solid var(--line-2)', position: 'sticky', top: 0, background: 'var(--panel)' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res.rows!.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} style={{ padding: '3px 10px', borderBottom: '1px solid var(--line)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: v === null ? 'var(--fg-faint)' : undefined }} title={String(v)}>
                        {v === null ? 'NULL' : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!res && <div className="empty">{t('왼쪽에서 테이블을 고르거나 SQL을 실행하세요')}</div>}
        </div>
      </div>
    </div>
  );
}

function Events() {
  const { serial, pkg } = useApp();
  const t = useT();
  const [events, setEvents] = useState<SdkEvent[]>([]);
  useEffect(() => {
    if (!serial || !pkg) return;
    const tick = () => api.sdk<SdkEvent[]>(serial, pkg, 'events', 0).then(setEvents).catch(() => undefined);
    tick();
    const timer = setInterval(tick, 1500);
    return () => clearInterval(timer);
  }, [serial, pkg]);
  return (
    <div className="logs">
      {events.length === 0 && (
        <div className="empty">
          {t('앱에서')} <span className="mono">DroidLens.event("name", data)</span>{t('로 남긴 이벤트가 여기에 표시됩니다')}
        </div>
      )}
      {events.slice().reverse().map((e) => (
        <div key={e.id} className="ll" style={{ gridTemplateColumns: '90px 200px 1fr' }}>
          <span className="tm">{new Date(e.at).toLocaleTimeString()}</span>
          <span className="tg" style={{ color: 'var(--accent)' }}>{e.name}</span>
          <span>{e.data ? JSON.stringify(e.data) : ''}</span>
        </div>
      ))}
    </div>
  );
}
