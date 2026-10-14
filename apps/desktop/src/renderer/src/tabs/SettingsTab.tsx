import { useEffect, useState } from 'react';
import { api, type AdbStatus, type Integration } from '../api';
import { useApp } from '../App';
import type { useUpdater } from '../Updater';

const REPO = 'https://github.com/ESeungJun/droidlens';

export function SettingsTab({ onAdbChange, updater }: { onAdbChange?(s: AdbStatus): void; updater: ReturnType<typeof useUpdater> }) {
  const { run, toast } = useApp();
  const [adb, setAdb] = useState<AdbStatus | null>(null);
  const [adbPath, setAdbPath] = useState('');
  const [integ, setInteg] = useState<Integration | null>(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState('');
  const [home, setHome] = useState('');

  const load = async () => {
    const [a, i, v, h] = await Promise.all([run(api.adbStatus()), run(api.integration()), run(api.appVersion()), run(api.home())]);
    if (a) {
      setAdb(a);
      onAdbChange?.(a);
    }
    setInteg(i ?? null);
    setVersion(v ?? '');
    setHome(h ?? '');
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveAdb = async () => {
    const r = await run(api.setAdbPath(adbPath.trim()));
    if (r) {
      toast(r.ok ? `adb ${r.version} 연결됨` : `adb 실행 실패: ${r.error}`, !r.ok);
      load();
    }
  };

  const register = async () => {
    setBusy('mcp');
    const r = await run(api.registerMcp());
    setBusy('');
    if (r !== undefined) toast('Claude Code에 droidlens MCP를 등록했습니다. Claude Code를 재시작하세요.');
    load();
  };

  const agents = async () => {
    setBusy('agents');
    const r = await run(api.installAgents());
    setBusy('');
    if (r) toast(`에이전트 ${r.length}개 설치: ${r.join(', ')}`);
    load();
  };

  return (
    <div className="scroll">
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
        <div className="card">
          <h5>adb</h5>
          {adb?.ok ? (
            <p>
              <span className="pill accent">연결됨</span> <span className="mono">adb {adb.version}</span>
              <br />
              <span className="faint mono" style={{ fontSize: 11 }}>{adb.path}</span>
            </p>
          ) : (
            <div>
              <p className="error">adb를 찾지 못했습니다.</p>
              <p className="muted" style={{ fontSize: 12 }}>
                Android Studio를 설치했거나, 아래 중 하나로 platform-tools를 설치하세요.
              </p>
              <pre className="mono card" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
{`macOS   brew install --cask android-platform-tools
Windows winget install Google.PlatformTools
Linux   sudo apt install adb`}
              </pre>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input className="input" style={{ flex: 1 }} placeholder="adb 경로 직접 지정 (비우면 자동 탐색)" value={adbPath} onChange={(e) => setAdbPath(e.target.value)} />
            <button className="btn" onClick={saveAdb}>저장</button>
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>탐색 순서</summary>
            <div className="mono faint" style={{ fontSize: 11 }}>{adb?.candidates?.map((c) => <div key={c}>{c}</div>)}</div>
          </details>
        </div>

        <div className="card">
          <h5>Claude Code 연동</h5>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            DroidLens MCP 서버를 Claude Code에 등록하면, 에이전트가 기기를 직접 조작하고 시나리오를 검증할 수 있습니다. 별도 Node 설치 없이 이 앱에 내장된 런타임으로 동작합니다.
          </p>
          <div className="kv" style={{ marginBottom: 8 }}>
            <span>Claude Code</span>
            <span>{integ?.claudeVersion ?? <span className="error">찾지 못함</span>}</span>
            <span>MCP 등록</span>
            <span>{integ?.registered ? <span style={{ color: 'var(--accent)' }}>등록됨</span> : '미등록'}</span>
            <span>MCP 스크립트</span>
            <span style={{ fontSize: 11 }}>{integ?.mcpScriptExists ? integ.mcpScript : <span className="error">없음 (pnpm build 필요)</span>}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!integ?.claudeVersion || busy === 'mcp'} onClick={register}>
              {busy === 'mcp' ? '등록 중…' : integ?.registered ? 'MCP 다시 등록' : 'MCP 자동 등록'}
            </button>
            <button className="btn" onClick={() => integ && api.copy(integ.command).then(() => toast('명령을 복사했습니다'))}>
              등록 명령 복사
            </button>
          </div>
          {integ && <pre className="mono" style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--fg-faint)' }}>{integ.command}</pre>}

          <h5 style={{ marginTop: 14 }}>전용 에이전트</h5>
          {integ?.agents.map((a) => (
            <div key={a.file} className="mono" style={{ fontSize: 12 }}>
              {a.installed ? '✓' : '·'} {a.file.replace('.md', '')}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <button className="btn" disabled={busy === 'agents'} onClick={agents}>
              {integ?.agents.every((a) => a.installed) ? '에이전트 업데이트' : '에이전트 설치'}
            </button>
            <span className="faint mono" style={{ fontSize: 11 }}>{integ?.agentsDir}</span>
          </div>
        </div>

        <div className="card">
          <h5>DroidLens</h5>
          <div className="kv">
            <span>버전</span>
            <span>{version}</span>
            <span>데이터 폴더</span>
            <span>{home}</span>
          </div>
          <h5 style={{ marginTop: 14 }}>업데이트</h5>
          <div style={{ fontSize: 12 }}>
            {updater.checking
              ? '확인 중…'
              : updater.info
                ? updater.info.available
                  ? <span style={{ color: 'var(--accent)' }}>새 버전 {updater.info.latest} 있음 (현재 {updater.info.current})</span>
                  : `최신 버전입니다 (${updater.info.current})`
                : '-'}
            {updater.progress && <div className="mono" style={{ marginTop: 4 }}>{Math.round(updater.progress.p * 100)}% {updater.progress.message}</div>}
            {(updater.error || (updater.info?.available && !updater.info.canInstall)) && (
              <div className="error" style={{ marginTop: 4 }}>{updater.error ?? updater.info?.reason}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {updater.info?.available && (
              <button className="btn primary" disabled={!!updater.progress} onClick={updater.install}>⬆ {updater.info.latest} 설치하고 다시 시작</button>
            )}
            <button className="btn" disabled={updater.checking} onClick={updater.check}>새 버전 확인</button>
            <button className="btn" onClick={() => api.openPath(home)}>데이터 폴더 열기</button>
            <button className="btn" onClick={() => api.openExternal(REPO)}>GitHub</button>
          </div>
        </div>
      </div>
    </div>
  );
}
