import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, type AgentStatus, type CurrentScreen, type DeviceSummary, type PackageSummary } from './api';
import { ScreenTab } from './tabs/ScreenTab';
import { InspectorTab } from './tabs/InspectorTab';
import { FlowTab } from './tabs/FlowTab';
import { LogTab } from './tabs/LogTab';
import { LibsTab } from './tabs/LibsTab';
import { AppInfoTab } from './tabs/AppInfoTab';
import { ScenariosTab } from './tabs/ScenariosTab';
import { SettingsTab } from './tabs/SettingsTab';
import { NetworkTab } from './tabs/NetworkTab';
import { AppDataTab } from './tabs/AppDataTab';

interface Ctx {
  serial: string | null;
  pkg: string | null;
  setPkg(p: string | null): void;
  /** 현재 포그라운드 화면 (App 한 곳에서 2초 간격으로 폴링해 모든 탭이 공유) */
  screen: CurrentScreen | null;
  toast(msg: string, err?: boolean): void;
  run<T>(p: Promise<T>): Promise<T | undefined>;
}

const AppCtx = createContext<Ctx>(null!);
export const useApp = () => useContext(AppCtx);

const TABS = [
  ['screen', '화면'],
  ['inspect', '뷰 계층'],
  ['flow', '화면 흐름'],
  ['logs', '로그'],
  ['network', '네트워크'],
  ['data', '앱 데이터'],
  ['libs', '라이브러리'],
  ['info', '앱 정보'],
  ['scen', '시나리오'],
  ['settings', '설정·연동'],
] as const;
type TabId = (typeof TABS)[number][0];

const initial = new URLSearchParams(location.hash.slice(1));

export function App() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [serial, setSerial] = useState<string | null>(null);
  const [pkgs, setPkgs] = useState<PackageSummary[]>([]);
  const [pkg, setPkg] = useState<string | null>(initial.get('pkg'));
  const [screen, setScreen] = useState<CurrentScreen | null>(null);
  const fgPkg = screen?.packageName ?? '';
  const [filter, setFilter] = useState('');
  const [thirdOnly, setThirdOnly] = useState(true);
  const [tab, setTab] = useState<TabId>((initial.get('tab') as TabId) || 'screen');
  const [toastMsg, setToastMsg] = useState<{ msg: string; err?: boolean } | null>(null);
  const [adbOk, setAdbOk] = useState<boolean | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);

  // 기기가 바뀌면 온디바이스 에이전트를 자동으로 준비 (없으면 uiautomator로 동작)
  useEffect(() => {
    setAgent(null);
    if (!serial) return;
    setAgentBusy(true);
    api.agentStart(serial).then(setAgent).catch(() => undefined).finally(() => setAgentBusy(false));
  }, [serial]);

  useEffect(() => {
    api.adbStatus().then((s) => setAdbOk(s.ok)).catch(() => setAdbOk(false));
  }, []);

  const toast = useCallback((msg: string, err?: boolean) => {
    setToastMsg({ msg, err });
    setTimeout(() => setToastMsg((t) => (t?.msg === msg ? null : t)), err ? 5000 : 2500);
  }, []);

  const run = useCallback(
    async <T,>(p: Promise<T>) => {
      try {
        return await p;
      } catch (e) {
        toast((e as Error).message, true);
        return undefined;
      }
    },
    [toast],
  );

  const refreshDevices = useCallback(async () => {
    const list = (await run(api.devices())) ?? [];
    setDevices(list);
    const online = list.filter((d) => d.state === 'device');
    setSerial((cur) => (cur && online.some((d) => d.serial === cur) ? cur : online[0]?.serial ?? null));
  }, [run]);

  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 4000);
    return () => clearInterval(t);
  }, [refreshDevices]);

  useEffect(() => {
    if (!serial) return setPkgs([]);
    run(api.packages(serial, thirdOnly)).then((p) => setPkgs(p ?? []));
  }, [serial, thirdOnly, run]);

  // 포그라운드 화면: 여기서만 폴링하고 컨텍스트로 공유 (탭마다 따로 폴링하면 기기 부하가 커진다)
  useEffect(() => {
    setScreen(null);
    if (!serial) return;
    let alive = true;
    const tick = () => api.currentScreen(serial).then((s) => alive && setScreen(s)).catch(() => undefined);
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [serial]);

  // DroidLens 온디바이스 에이전트 자체는 분석 대상이 아니므로 숨긴다
  const shown = useMemo(
    () => pkgs.filter((p) => p.packageName !== 'io.github.eseungjun.droidlens.agent' && p.packageName.includes(filter.trim())),
    [pkgs, filter],
  );
  const ctx = useMemo<Ctx>(() => ({ serial, pkg, setPkg, screen, toast, run }), [serial, pkg, screen, toast, run]);

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <span className="brand">
            Droid<em>Lens</em>
          </span>
          <select className="input" value={serial ?? ''} onChange={(e) => setSerial(e.target.value || null)} style={{ minWidth: 220 }}>
            {devices.length === 0 && <option value="">기기 없음</option>}
            {devices.map((d) => (
              <option key={d.serial} value={d.serial} disabled={d.state !== 'device'}>
                {d.model ?? d.serial} · {d.serial} {d.state !== 'device' ? `(${d.state})` : ''}
              </option>
            ))}
          </select>
          {pkg && <span className="pill accent mono">{pkg}</span>}
          {serial && (
            <button
              className={`pill ${agent?.running ? 'accent' : ''}`}
              style={{ cursor: 'pointer' }}
              disabled={agentBusy}
              title={
                agent?.running
                  ? '온디바이스 에이전트 실행 중 — 뷰 계층이 빠르고 한글 입력이 됩니다. 클릭하면 중지'
                  : '에이전트 없음 — uiautomator로 동작 (느림, ASCII 입력만). 클릭하면 시작'
              }
              onClick={async () => {
                if (!serial) return;
                setAgentBusy(true);
                const r = await run(agent?.running ? api.agentStop(serial) : api.agentStart(serial));
                setAgentBusy(false);
                if (r) {
                  setAgent(r);
                  if (!r.running && !agent?.running) toast('에이전트를 시작하지 못했습니다. uiautomator로 계속 동작합니다.', true);
                }
              }}
            >
              {agentBusy ? '에이전트 준비 중…' : agent?.running ? '⚡ 에이전트' : '에이전트 꺼짐'}
            </button>
          )}
          <div className="spacer" />
          {fgPkg && (
            <button className="btn sm" onClick={() => setPkg(fgPkg)} title="포그라운드 앱 선택">
              포그라운드: <span className="mono">{fgPkg}</span>
            </button>
          )}
        </header>
        <div className="body">
          <aside className="sidebar">
            <div className="search">
              <input className="input" placeholder="패키지 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <label className="chk">
                <input type="checkbox" checked={thirdOnly} onChange={(e) => setThirdOnly(e.target.checked)} />
                사용자 설치 앱만
              </label>
            </div>
            <div className="pkglist">
              {shown.map((p) => (
                <button
                  key={p.packageName}
                  className={`pkg ${pkg === p.packageName ? 'active' : ''} ${fgPkg === p.packageName ? 'fg' : ''}`}
                  onClick={() => setPkg(p.packageName)}
                  title={p.packageName}
                >
                  {p.packageName}
                </button>
              ))}
              {serial && shown.length === 0 && <div className="empty">패키지가 없습니다</div>}
            </div>
          </aside>
          <main className="main">
            <nav className="tabs">
              {TABS.map(([id, label]) => (
                <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </nav>
            <section className="content">
              {!serial && tab !== 'scen' && tab !== 'settings' ? (
                <div className="empty">
                  {adbOk === false ? (
                    <div>
                      adb를 찾지 못했습니다.
                      <br />
                      <button className="btn primary" style={{ marginTop: 10 }} onClick={() => setTab('settings')}>
                        설정에서 adb 연결하기
                      </button>
                    </div>
                  ) : (
                    <div>
                      연결된 기기가 없습니다.
                      <br />
                      USB 디버깅을 켜거나 에뮬레이터를 실행하세요.
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {tab === 'screen' && <ScreenTab />}
                  {tab === 'inspect' && <InspectorTab />}
                  {tab === 'flow' && <FlowTab />}
                  {tab === 'logs' && <LogTab />}
                  {tab === 'network' && <NetworkTab />}
                  {tab === 'data' && <AppDataTab />}
                  {tab === 'libs' && <LibsTab />}
                  {tab === 'info' && <AppInfoTab />}
                  {tab === 'scen' && <ScenariosTab />}
                  {tab === 'settings' && <SettingsTab onAdbChange={(a) => setAdbOk(a.ok)} />}
                </>
              )}
            </section>
          </main>
        </div>
        {toastMsg && <div className={`toast ${toastMsg.err ? 'err' : ''}`}>{toastMsg.msg}</div>}
      </div>
    </AppCtx.Provider>
  );
}

export function NeedPkg() {
  return <div className="empty">왼쪽에서 앱을 선택하세요</div>;
}
