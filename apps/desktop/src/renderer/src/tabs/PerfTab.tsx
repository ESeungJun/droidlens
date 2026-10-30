import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api, type PerfSample, type StartupResult } from '../api';
import { NeedPkg, useApp } from '../App';
import { useT } from '../i18n';

/** 표본 간격과 그래프에 남기는 시간 */
const INTERVAL_MS = 2000;
const WINDOW_MS = 3 * 60_000;

/** 그래프 한 점. v 가 없으면 앱이 떠 있지 않던 구간이라 선을 끊는다 */
type Point = { at: number; v?: number };
interface Series {
  cpu: Point[];
  memory: Point[];
  fps: Point[];
}
const emptySeries = (): Series => ({ cpu: [], memory: [], fps: [] });

const mb = (kb?: number) => (kb === undefined ? '-' : `${(kb / 1024).toFixed(1)} MB`);

export function PerfTab() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [live, setLive] = useState(true);
  const [measuring, setMeasuring] = useState(false);
  const [sample, setSample] = useState<PerfSample | null>(null);
  const [series, setSeries] = useState<Series>(emptySeries);
  const [cold, setCold] = useState(true);
  const [runs, setRuns] = useState(3);
  const [startups, setStartups] = useState<StartupResult[]>([]);

  useEffect(() => {
    setSample(null);
    setSeries(emptySeries());
    setStartups([]);
  }, [serial, pkg]);

  // 시작 시간을 재는 동안에는 표본을 읽지 않는다 (측정에 부하가 섞이지 않게)
  useEffect(() => {
    if (!serial || !pkg || !live || measuring) return;
    let alive = true;
    let inFlight = false;
    let prev: PerfSample | null = null;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await api.perfSample(serial, pkg);
        if (!alive) return;
        const at = Date.now();
        const same = s && prev && prev.pid === s.pid;
        const dt = same ? (s.at - prev!.at) / 1000 : 0;
        // 이전 표본의 덤프(meminfo·gfxinfo)가 깨운 CPU 는 빼고 잰다
        const from = same ? (prev!.cpuAfter ?? prev!.cpu) : undefined;
        const cpu = from && s?.cpu ? cpuPercent(from, s.cpu) : undefined;
        const framesNow = s?.frames?.totalFrames;
        const framesPrev = same ? prev!.frames?.totalFrames : undefined;
        // 초기화하면 누적값이 줄어들어 그 구간은 비운다
        const fps = framesNow !== undefined && framesPrev !== undefined && framesNow >= framesPrev && dt > 0 ? (framesNow - framesPrev) / dt : undefined;
        const cut = at - WINDOW_MS;
        const push = (list: Point[], v?: number) => [...list.filter((p) => p.at >= cut), { at, v }];
        setSeries((cur) => ({
          cpu: push(cur.cpu, cpu),
          memory: push(cur.memory, s?.memory ? s.memory.totalPssKb / 1024 : undefined),
          fps: push(cur.fps, fps),
        }));
        setSample(s);
        prev = s;
      } catch {
        /* 기기가 잠깐 응답하지 않으면 다음 표본에서 다시 읽는다 */
      } finally {
        inFlight = false;
      }
    };
    tick();
    const timer = setInterval(tick, INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [serial, pkg, live, measuring]);

  if (!pkg) return <NeedPkg />;

  const measure = async () => {
    if (!serial) return;
    setMeasuring(true);
    const r = await run(api.perfStartup(serial, pkg, cold, runs));
    setMeasuring(false);
    if (r) setStartups((cur) => [r, ...cur].slice(0, 20));
  };
  const resetFrames = async () => {
    if (!serial) return;
    if ((await run(api.perfResetFrames(serial, pkg))) !== undefined) toast(t('프레임 통계를 초기화했습니다'));
  };

  const lastCpu = series.cpu.at(-1)?.v;
  const lastFps = series.fps.at(-1)?.v;
  const m = sample?.memory;
  const f = sample?.frames;

  return (
    <>
      <div className="toolbar">
        <button className={`btn ${live ? 'primary' : ''}`} onClick={() => setLive(!live)} disabled={measuring}>
          {live ? `⏸ ${t('실시간 측정 멈춤')}` : `▶ ${t('실시간 측정')}`}
        </button>
        <button className="btn" onClick={resetFrames} disabled={!sample} title={t('지금부터 그리는 프레임만 집계합니다')}>
          {t('프레임 통계 초기화')}
        </button>
        <span className="faint" style={{ fontSize: 11 }}>
          {measuring ? t('시작 시간 측정 중이라 실시간 측정을 잠시 멈췄습니다') : sample ? `PID ${sample.pid}` : live ? t('앱이 실행 중이 아닙니다') : ''}
        </span>
      </div>
      <div className="scroll">
        <div className="stats">
          <div className="stat"><b>{lastCpu === undefined ? '-' : `${lastCpu.toFixed(1)}%`}</b><span>{t('CPU (기기 전체 대비)')}</span></div>
          <div className="stat"><b>{mb(m?.totalPssKb)}</b><span>{t('메모리 (PSS)')}</span></div>
          <div className="stat"><b>{lastFps === undefined ? '-' : lastFps.toFixed(0)}</b><span>{t('초당 그린 프레임')}</span></div>
          <div className="stat">
            <b style={{ color: f && f.jankPercent >= 10 ? 'var(--warn)' : undefined }}>{f ? `${f.jankPercent}%` : '-'}</b>
            <span>{t('버벅인 프레임 ({janky}/{total})', { janky: f?.jankyFrames ?? 0, total: f?.totalFrames ?? 0 })}</span>
          </div>
        </div>
        <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
          <div className="card">
            <h5>{t('CPU (기기 전체 대비)')}</h5>
            <LineChart points={series.cpu} format={(v) => `${v.toFixed(1)}%`} minMax={10} />
          </div>
          <div className="card">
            <h5>{t('메모리 (PSS)')}</h5>
            <LineChart points={series.memory} format={(v) => `${v.toFixed(1)} MB`} minMax={50} />
          </div>
          <div className="card">
            <h5>{t('초당 그린 프레임')}</h5>
            <LineChart points={series.fps} format={(v) => v.toFixed(0)} minMax={60} />
            <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{t('화면이 멈춰 있으면 새로 그리지 않아 0 입니다')}</div>
          </div>
          <div className="card">
            <h5>{t('메모리 영역')}</h5>
            <div className="kv">
              <span>Java Heap</span><span>{mb(m?.javaHeapKb)}</span>
              <span>Native Heap</span><span>{mb(m?.nativeHeapKb)}</span>
              <span>Graphics</span><span>{mb(m?.graphicsKb)}</span>
              <span>Code</span><span>{mb(m?.codeKb)}</span>
              <span>Stack</span><span>{mb(m?.stackKb)}</span>
              <span>Private Other</span><span>{mb(m?.privateOtherKb)}</span>
              <span>System</span><span>{mb(m?.systemKb)}</span>
              <span>RSS</span><span>{mb(m?.totalRssKb)}</span>
            </div>
          </div>
          <div className="card">
            <h5>{t('프레임 시간 (초기화 이후 누적)')}</h5>
            <div className="kv">
              <span>p50</span><span>{f?.p50Ms === undefined ? '-' : `${f.p50Ms} ms`}</span>
              <span>p90</span><span>{f?.p90Ms === undefined ? '-' : `${f.p90Ms} ms`}</span>
              <span>p95</span><span>{f?.p95Ms === undefined ? '-' : `${f.p95Ms} ms`}</span>
              <span>p99</span><span>{f?.p99Ms === undefined ? '-' : `${f.p99Ms} ms`}</span>
              <span>{t('놓친 vsync')}</span><span>{f?.missedVsync ?? '-'}</span>
              <span>{t('느린 UI 스레드')}</span><span>{f?.slowUiThread ?? '-'}</span>
            </div>
          </div>
          <div className="card">
            <h5>{t('시작 시간')}</h5>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <select className="input" value={cold ? 'cold' : 'warm'} onChange={(e) => setCold(e.target.value === 'cold')} disabled={measuring}>
                <option value="cold">{t('콜드 (매번 종료 후 실행)')}</option>
                <option value="warm">{t('다시 열기 (홈에서 복귀)')}</option>
              </select>
              <select className="input" value={runs} onChange={(e) => setRuns(Number(e.target.value))} disabled={measuring}>
                {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{t('{n}회', { n })}</option>)}
              </select>
              <button className="btn primary" onClick={measure} disabled={measuring}>{measuring ? t('측정 중…') : t('측정')}</button>
            </div>
            <div className="faint" style={{ fontSize: 11, marginBottom: 6 }}>{t('측정하는 동안 앱이 여러 번 다시 시작됩니다')}</div>
            {startups.map((r, i) => (
              <div key={startups.length - i} className="lib">
                <b>{r.medianMs} ms</b> <span className="faint">{r.cold ? t('콜드') : t('다시 열기')} · {t('중앙값')}</span>
                <div className="ev">{r.runs.map((x) => `${x.ms}ms${x.launchState ? ` ${x.launchState}` : ''}`).join(' · ')}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** core 의 cpuPercent 와 같은 계산. 렌더러는 core(노드 모듈)를 불러올 수 없어 따로 둔다 */
function cpuPercent(a: { proc: number; total: number }, b: { proc: number; total: number }): number | undefined {
  const dt = b.total - a.total;
  const dp = b.proc - a.proc;
  return dt > 0 && dp >= 0 ? (dp / dt) * 100 : undefined;
}

const W = 600;
const H = 120;

/**
 * 한 지표의 시간 그래프. y 는 0부터 (최댓값과 minMax 중 큰 값)까지, x 는 최근 3분.
 * 마우스를 올리면 가장 가까운 표본의 값과 시각을 보여준다
 */
function LineChart({ points, format, minMax }: { points: Point[]; format(v: number): string; minMax: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const end = points.at(-1)?.at ?? Date.now();
  const start = end - WINDOW_MS;
  const max = Math.max(minMax, ...points.map((p) => p.v ?? 0)) * 1.1;
  const x = (at: number) => ((at - start) / WINDOW_MS) * W;
  const y = (v: number) => H - (v / max) * H;
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.v === undefined) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`;
    pen = true;
  }
  const onMove = (e: MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const at = start + ((e.clientX - r.left) / r.width) * WINDOW_MS;
    let best: Point | null = null;
    for (const p of points) if (!best || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
    setHover(best);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
        <line x1={0} y1={H} x2={W} y2={H} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={y(max / 1.1)} x2={W} y2={y(max / 1.1)} stroke="var(--line)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        {d && <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {hover && <line x1={x(hover.at)} y1={0} x2={x(hover.at)} y2={H} stroke="var(--fg-faint)" vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="faint" style={{ position: 'absolute', left: 4, top: y(max / 1.1) - 16, fontSize: 10.5 }}>{format(max / 1.1)}</span>
      {!points.some((p) => p.v !== undefined) && (
        <div className="faint" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12 }}>{t('표본을 모으는 중…')}</div>
      )}
      {hover && (
        <div
          className="mono"
          style={{
            position: 'absolute',
            top: 4,
            left: `${(x(hover.at) / W) * 100}%`,
            transform: x(hover.at) > W * 0.7 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
            padding: '3px 7px',
            fontSize: 11,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {hover.v === undefined ? t('실행 중 아님') : format(hover.v)} <span className="faint">{new Date(hover.at).toLocaleTimeString()}</span>
        </div>
      )}
    </div>
  );
}
