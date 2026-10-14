import { useEffect, useState } from 'react';
import { api, type AppInfo } from '../api';
import { NeedPkg, useApp } from '../App';

export function AppInfoTab() {
  const { serial, pkg, run, toast } = useApp();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [uri, setUri] = useState('');

  const load = async () => {
    if (serial && pkg) setInfo((await run(api.appInfo(serial, pkg))) ?? null);
  };
  useEffect(() => {
    setInfo(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, pkg]);

  if (!pkg) return <NeedPkg />;

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={async () => { await run(api.launch(serial!, pkg)); load(); }}>▶ 실행</button>
        <button className="btn" onClick={async () => { await run(api.launch(serial!, pkg, true)); load(); }}>↻ 재시작</button>
        <button className="btn danger" onClick={async () => { await run(api.stop(serial!, pkg)); load(); }}>■ 강제 종료</button>
        <form style={{ display: 'flex', gap: 6, flex: 1, maxWidth: 640 }} onSubmit={async (e) => { e.preventDefault(); if (uri) { const r = await run(api.deeplink(serial!, uri, pkg)); if (r) toast('딥링크 실행됨'); } }}>
          <input className="input" placeholder="딥링크 (예: myapp://home)" value={uri} onChange={(e) => setUri(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="btn">열기</button>
        </form>
      </div>
      {!info ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        <div className="scroll fill">
          <div className="stats">
            <div className="stat"><b>{info.versionName ?? '-'}</b><span>버전 ({info.versionCode})</span></div>
            <div className="stat"><b>{info.minSdk ?? '-'} / {info.targetSdk ?? '-'}</b><span>minSdk / targetSdk</span></div>
            <div className="stat"><b>{info.pid ?? '-'}</b><span>{info.pid ? '실행 중 PID' : '실행 중 아님'}</span></div>
            <div className="stat"><b>{info.debuggable ? '예' : '아니오'}</b><span>debuggable</span></div>
          </div>
          <div className="cards fill">
            <div className="card col">
              <h5>설치</h5>
              <div className="kv">
                <span>설치자</span><span>{info.installer ?? '-'}</span>
                <span>최초 설치</span><span>{info.firstInstall ?? '-'}</span>
                <span>업데이트</span><span>{info.lastUpdate ?? '-'}</span>
                <span>런처</span><span>{info.launcherActivity ?? '-'}</span>
              </div>
              <h5 style={{ marginTop: 12 }}>APK</h5>
              {info.apkPaths.map((p) => <div key={p} className="ev mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{p}</div>)}
            </div>
            <div className="card col">
              <h5>Activity ({info.activities.length})</h5>
              <div className="grow">
                {info.activities.map((a) => (
                  <div key={a} className="mono" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', gap: 6, padding: '2px 0' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={a}>{a.replace(pkg, '')}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card col">
              <h5>권한 (요청 {info.requestedPermissions.length} · 허용 {info.grantedPermissions.length})</h5>
              <div className="grow">
                {info.requestedPermissions.map((p) => {
                  const g = info.grantedPermissions.includes(p.split(':')[0]);
                  return (
                    <div key={p} className="mono" style={{ fontSize: 11, color: g ? 'var(--accent)' : 'var(--fg-dim)' }}>
                      {g ? '✓' : '·'} {p.replace('android.permission.', '')}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
