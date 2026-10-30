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
import { PerfTab } from './tabs/PerfTab';
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
  ['perf', '성능'],
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
  // 이 컴퓨터의 가상 기기(AVD). 꺼져 있는 것은 기기 목록에서 고르면 띄운다
  const [avds, setAvds] = useState<{ name: string; serial?: string }[]>([]);
  const [booting, setBooting] = useState<{ name: string; message: string } | null>(null);
  const [serial, setSerial] = useState<string | null>(null);
  const [pkgs, setPkgs] = useState<PackageSummary[]>([]);
  const [pkg, setPkg] = useState<string | null>(initial.get('pkg'));
  const [screen, setScreen] = useState<CurrentScreen | null>(null);
  const fgPkg = screen?.packageName ?? '';
  // 왼쪽 목록에서 앱을 고르면 그 앱을 기기 화면 앞으로 가져온다 (작업 중인 앱 = 화면에 보이는 앱이 되도록)
  const [openOnSelect, setOpenOnSelect] = useState(() => {
    try {
      return localStorage.getItem('droidlens.openOnSelect') !== '0';
    } catch {
      return true;
    }
  });
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
  // 늦게 온 이전 기기의 응답이 새 기기 상태를 덮지 않게 alive 로 막는다
  useEffect(() => {
    setAgent(null);
    if (!serial) return;
    let alive = true;
    setAgentBusy(true);
    api
      .agentStart(serial)
      .then((a) => alive && setAgent(a))
      .catch(() => undefined)
      .finally(() => alive && setAgentBusy(false));
    return () => {
      alive = false;
      setAgentBusy(false);
    };
  }, [serial]);

  // 다른 기기로 바꾸면 이전 기기에서 고른 앱 선택을 지운다 (처음 기기가 잡힐 때는 시작 옵션으로 받은 앱을 그대로 둔다).
  // 기기가 잠깐 빠졌다(null) 같은 기기가 다시 붙는 경우(Wi-Fi adb 등)는 바뀐 것으로 보지 않게 마지막 기기만 기억한다
  const prevSerial = useRef<string | null>(null);
  useEffect(() => {
    if (!serial) return;
    if (prevSerial.current && prevSerial.current !== serial) setPkg(null);
    prevSerial.current = serial;
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

  const selectApp = (p: string) => {
    setPkg(p);
    if (serial && openOnSelect && fgPkg !== p) run(api.bringToFront(serial, p));
  };

  // 기기 목록 조회가 실패 중인지. 한 번 실패했다고 목록을 비우면 모든 탭이 닫히므로 이전 목록을 유지하고,
  // 실패를 알리는 토스트도 4초마다가 아니라 실패로 바뀔 때 한 번만 띄운다
  const devicesFailed = useRef(false);
  const refreshDevices = useCallback(async () => {
    let list: DeviceSummary[];
    try {
      list = await api.devices();
      devicesFailed.current = false;
    } catch (e) {
      if (!devicesFailed.current) toast((e as Error).message, true);
      devicesFailed.current = true;
      setDevicesLoaded(true);
      return;
    }
    setDevices(list);
    setDevicesLoaded(true);
    const online = list.filter((d) => d.state === 'device');
    setSerial((cur) => (cur && online.some((d) => d.serial === cur) ? cur : online[0]?.serial ?? null));
  }, [toast]);

  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 4000);
    return () => clearInterval(t);
  }, [refreshDevices]);

  // AVD 목록은 emulator 실행 파일을 불러야 해서, 연결된 기기 구성이 바뀔 때만 다시 읽는다
  const deviceKey = devices.map((d) => `${d.serial}:${d.state}`).join(',');
  const refreshAvds = useCallback(() => {
    api.avds().then((r) => setAvds(r.avds)).catch(() => setAvds([]));
  }, []);
  useEffect(refreshAvds, [deviceKey, refreshAvds]);
  useEffect(() => api.onProgress((p) => p.kind === 'avd' && setBooting((b) => (b ? { ...b, message: p.message } : b))), []);

  const launchAvd = async (name: string) => {
    setBooting({ name, message: t('{name} 실행 중…', { name }) });
    const s = await run(api.avdStart(name));
    setBooting(null);
    if (!s) return;
    await refreshDevices();
    setSerial(s);
    toast(t('가상 기기를 켰습니다: {name}', { name }));
  };

  const stopAvd = async (s: string) => {
    if ((await run(api.avdStop(s))) === undefined) return;
    toast(t('가상 기기를 껐습니다'));
    setTimeout(refreshDevices, 1500);
  };
  const offAvds = avds.filter((a) => !a.serial);
  const current = devices.find((d) => d.serial === serial);

  const [pkgTick, setPkgTick] = useState(0);
  const [pkgsLoading, setPkgsLoading] = useState(false);
  useEffect(() => {
    if (!serial) return setPkgs([]);
    let alive = true;
    setPkgsLoading(true);
    run(api.packages(serial, thirdOnly)).then((p) => {
      if (!alive) return;
      setPkgs(p ?? []);
      setPkgsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [serial, thirdOnly, run, pkgTick]);

  // 포그라운드 화면: 여기서만 폴링하고 컨텍스트로 공유 (탭마다 따로 폴링하면 기기 부하가 커진다)
  useEffect(() => {
    setScreen(null);
    if (!serial) return;
    let alive = true;
    // 기기가 느려 응답이 2초를 넘기면 요청이 쌓이지 않게, 앞 요청이 끝나기 전에는 다시 묻지 않는다
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      api
        .currentScreen(serial)
        .then((s) => alive && setScreen(s))
        .catch(() => undefined)
        .finally(() => (inFlight = false));
    };
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
          <select
            className="input"
            value={serial ?? ''}
            disabled={!!booting}
            onChange={(e) => (e.target.value.startsWith('avd:') ? launchAvd(e.target.value.slice(4)) : setSerial(e.target.value || null))}
            style={{ minWidth: 220 }}
          >
            {devices.length === 0 && <option value="">{devicesLoaded ? t('기기 없음') : t('기기 찾는 중…')}</option>}
            {devices.map((d) => (
              <option key={d.serial} value={d.serial} disabled={d.state !== 'device'}>
                {(d.emulator && avds.find((a) => a.serial === d.serial)?.name) || d.model || d.serial} · {d.serial} {d.state !== 'device' ? `(${d.state})` : ''}
              </option>
            ))}
            {offAvds.length > 0 && (
              <optgroup label={t('가상 기기 (고르면 실행)')}>
                {offAvds.map((a) => (
                  <option key={a.name} value={`avd:${a.name}`}>▶ {a.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {booting && <span className="muted" style={{ fontSize: 12 }}>{booting.message}</span>}
          {current?.emulator && !booting && (
            <button className="btn sm" onClick={() => stopAvd(current.serial)} title={t('이 가상 기기(에뮬레이터)를 끕니다')}>
              {t('■ 가상 기기 끄기')}
            </button>
          )}
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
          {pkg && fgPkg && fgPkg !== pkg ? (
            // 고른 앱과 화면에 떠 있는 앱이 다르면 지금 무엇을 보고 있는지 분명히 알린다
            <span className="pill warn-pill" title={t('선택한 앱과 기기 화면에 떠 있는 앱이 다릅니다')}>
              ⚠ {t('화면:')} <span className="mono">{fgPkg}</span>
              <button className="btn sm" onClick={() => serial && run(api.bringToFront(serial, pkg))}>{t('선택한 앱 열기')}</button>
              <button className="btn sm" onClick={() => setPkg(fgPkg)}>{t('이 앱으로 바꾸기')}</button>
            </span>
          ) : (
            !pkg &&
            fgPkg && (
              <button className="btn sm" onClick={() => setPkg(fgPkg)} title={t('포그라운드 앱 선택')}>
                {t('포그라운드:')} <span className="mono">{fgPkg}</span>
              </button>
            )
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
              <label className="chk" title={t('앱을 고르면 기기에서 그 앱을 앞으로 가져옵니다 (실행 중이면 보던 화면 그대로)')}>
                <input
                  type="checkbox"
                  checked={openOnSelect}
                  onChange={(e) => {
                    setOpenOnSelect(e.target.checked);
                    try {
                      localStorage.setItem('droidlens.openOnSelect', e.target.checked ? '1' : '0');
                    } catch {
                      /* 이번 실행 동안만 유지 */
                    }
                  }}
                />
                {t('누르면 앱 열기')}
              </label>
            </div>
            <div className="pkglist">
              {shown.map((p) => (
                <button
                  key={p.packageName}
                  className={`pkg ${pkg === p.packageName ? 'active' : ''} ${fgPkg === p.packageName ? 'fg' : ''}`}
                  onClick={() => selectApp(p.packageName)}
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
                    {offAvds.length > 0 && (
                      <div className="card" style={{ maxWidth: 760, width: '100%', textAlign: 'left' }}>
                        <h5>{t('이 컴퓨터의 가상 기기')}</h5>
                        <p className="muted" style={{ marginTop: 0 }}>{t('폰이나 태블릿 없이 에뮬레이터로 바로 시작할 수 있습니다. 처음 켤 때는 1~2분 걸립니다.')}</p>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {offAvds.map((a) => (
                            <button key={a.name} className="btn" disabled={!!booting} onClick={() => launchAvd(a.name)}>
                              ▶ {a.name}
                            </button>
                          ))}
                          {booting && <span className="muted">{booting.message}</span>}
                        </div>
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
                  {tab === 'perf' && <PerfTab />}
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
