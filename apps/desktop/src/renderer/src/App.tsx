import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { ChatPanel } from './ChatPanel';
import { DeviceSetup } from './DeviceSetup';
import { UpdateButton, useUpdater } from './Updater';
import { useT } from './i18n';

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
  const t = useT();
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
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
  const [chatOpen, setChatOpen] = useState(initial.get('chat') === '1');
  const updater = useUpdater();
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

  const toast = useCallback(
    (raw: string, err?: boolean) => {
      const msg = t(raw); // 메인 프로세스의 고정 문구도 사전에 있으면 번역된다
      setToastMsg({ msg, err });
      setTimeout(() => setToastMsg((cur) => (cur?.msg === msg ? null : cur)), err ? 5000 : 2500);
    },
    [t],
  );

  const run = useCallback(
    async <T,>(p: Promise<T>) => {
      try {
        return await p;
      } catch (e) {
        toast((e as Error).message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''), true);
        return undefined;
      }
    },
    [toast],
  );

  const refreshDevices = useCallback(async () => {
    const list = (await run(api.devices())) ?? [];
    setDevices(list);
    setDevicesLoaded(true);
    const online = list.filter((d) => d.state === 'device');
    setSerial((cur) => (cur && online.some((d) => d.serial === cur) ? cur : online[0]?.serial ?? null));
  }, [run]);

  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 4000);
    return () => clearInterval(t);
  }, [refreshDevices]);

  const [pkgTick, setPkgTick] = useState(0);
  const [pkgsLoading, setPkgsLoading] = useState(false);
  useEffect(() => {
    if (!serial) return setPkgs([]);
    setPkgsLoading(true);
    run(api.packages(serial, thirdOnly)).then((p) => {
      setPkgs(p ?? []);
      setPkgsLoading(false);
    });
  }, [serial, thirdOnly, run, pkgTick]);

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

  // 목록은 기기 연결 시 한 번만 받으므로, 그 뒤에 설치한 앱이 포그라운드에 오면 다시 받는다.
  // 시스템 앱처럼 다시 받아도 목록에 없는 패키지는 한 번만 시도한다.
  const missingFg = useRef('');
  useEffect(() => {
    if (!fgPkg || pkgs.length === 0 || pkgs.some((p) => p.packageName === fgPkg)) return;
    if (missingFg.current === fgPkg) return;
    missingFg.current = fgPkg;
    setPkgTick((t) => t + 1);
  }, [fgPkg, pkgs]);

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
            {devices.length === 0 && <option value="">{devicesLoaded ? t('기기 없음') : t('기기 찾는 중…')}</option>}
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
                  ? t('온디바이스 에이전트 실행 중 — 뷰 계층이 빠르고 한글 입력이 됩니다. 클릭하면 중지')
                  : t('에이전트 꺼짐 — uiautomator로 동작 (느림, ASCII 입력만). 클릭하면 시작') + (agent?.error ? '\n' + t('최근 실패: {error}', { error: agent.error }) : '')
              }
              onClick={async () => {
                if (!serial) return;
                setAgentBusy(true);
                const r = await run(agent?.running ? api.agentStop(serial) : api.agentStart(serial));
                setAgentBusy(false);
                if (r) {
                  setAgent(r);
                  if (!r.running && !agent?.running)
                    toast(r.error ? t('에이전트를 시작하지 못했습니다: {error} — uiautomator로 계속 동작합니다', { error: r.error }) : t('에이전트를 시작하지 못했습니다 — uiautomator로 계속 동작합니다'), true);
                }
              }}
            >
              {agentBusy ? t('에이전트 준비 중…') : agent?.running ? t('⚡ 에이전트') : t('에이전트 꺼짐')}
            </button>
          )}
          <div className="spacer" />
          <UpdateButton u={updater} />
          <button className={`btn sm ${chatOpen ? 'primary' : ''}`} onClick={() => setChatOpen((v) => !v)} title={t('에이전트와 대화')}>
            {t('💬 에이전트 대화')}
          </button>
          {fgPkg && (
            <button className="btn sm" onClick={() => setPkg(fgPkg)} title={t('포그라운드 앱 선택')}>
              {t('포그라운드:')} <span className="mono">{fgPkg}</span>
            </button>
          )}
        </header>
        <div className="body" style={{ gridTemplateColumns: chatOpen ? '260px 1fr 400px' : undefined }}>
          <aside className="sidebar">
            <div className="search">
              <input className="input" placeholder={t('패키지 검색')} value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label className="chk">
                  <input type="checkbox" checked={thirdOnly} onChange={(e) => setThirdOnly(e.target.checked)} />
                  {t('사용자 설치 앱만')}
                </label>
                <button className="btn sm" onClick={() => setPkgTick((t) => t + 1)} title={t('앱 목록 새로고침')}>
                  ↻
                </button>
              </div>
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
              {serial && shown.length === 0 && <div className="empty">{pkgsLoading ? t('앱 목록 불러오는 중…') : t('패키지가 없습니다')}</div>}
            </div>
          </aside>
          <main className="main">
            <nav className="tabs">
              {TABS.map(([id, label]) => (
                <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                  {t(label)}
                </button>
              ))}
            </nav>
            <section className="content">
              {!serial && tab !== 'scen' && tab !== 'settings' ? (
                adbOk === null || !devicesLoaded ? (
                  <div className="empty">
                    <div>{t('기기 확인 중…')}</div>
                  </div>
                ) : (
                  <div className="scroll" style={{ height: '100%', display: 'grid', justifyItems: 'center', alignContent: 'start', gap: 16, paddingTop: 40 }}>
                    {adbOk === false ? (
                      <div style={{ textAlign: 'center' }}>
                        {t('adb를 찾지 못했습니다.')}
                        <br />
                        <button className="btn primary" style={{ marginTop: 10 }} onClick={() => setTab('settings')}>
                          {t('설정에서 adb 연결하기')}
                        </button>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center' }}>
                        <b>{t('연결된 기기가 없습니다.')}</b>
                        <br />
                        <span className="muted">{t('폰이나 에뮬레이터가 연결되면 자동으로 인식합니다.')}</span>
                      </div>
                    )}
                    <DeviceSetup />
                  </div>
                )
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
                  {tab === 'settings' && <SettingsTab onAdbChange={(a) => setAdbOk(a.ok)} updater={updater} />}
                </>
              )}
            </section>
          </main>
          {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
        </div>
        {toastMsg && <div className={`toast ${toastMsg.err ? 'err' : ''}`}>{toastMsg.msg}</div>}
      </div>
    </AppCtx.Provider>
  );
}

export function NeedPkg() {
  const t = useT();
  return <div className="empty">{t('왼쪽에서 앱을 선택하세요')}</div>;
}
