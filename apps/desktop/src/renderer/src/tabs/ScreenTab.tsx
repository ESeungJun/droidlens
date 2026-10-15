import { useEffect, useRef, useState } from 'react';
import { api, type DeviceInfo, type GraphAction } from '../api';
import { useApp } from '../App';
import { MirrorCanvas } from '../MirrorCanvas';
import { useT } from '../i18n';

const GRAPH_MODE_KEY = 'droidlens.graphMode';

export function ScreenTab() {
  const { serial, pkg, screen, toast, run } = useApp();
  const t = useT();
  const [img, setImg] = useState<string>('');
  const [live, setLive] = useState(true);
  // stream: scrcpy 고프레임(H.264 + WebCodecs), snapshot: screencap 폴링(2~4fps, 대체 경로)
  const [mode, setMode] = useState<'stream' | 'snapshot'>('stream');
  const [fps, setFps] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [recAt, setRecAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // 직접 조작한 화면 흐름은 기본으로 앱 지도에 모은다. 끄면 그 선택을 기억한다
  const [graphMode, setGraphModeState] = useState(() => {
    try {
      return localStorage.getItem(GRAPH_MODE_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const setGraphMode = (on: boolean) => {
    setGraphModeState(on);
    try {
      localStorage.setItem(GRAPH_MODE_KEY, on ? 'on' : 'off');
    } catch {
      /* 이번 실행 동안만 적용 */
    }
  };
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; t: number } | null>(null);

  // 미러링 루프: 이전 프레임이 끝나야 다음 요청
  useEffect(() => {
    if (!serial || !live || mode !== 'snapshot') return;
    let stop = false;
    (async () => {
      while (!stop) {
        const t0 = Date.now();
        try {
          const d = await api.screenshot(serial);
          if (!stop) setImg(d);
        } catch {
          /* 일시적 실패 무시 */
        }
        await new Promise((r) => setTimeout(r, Math.max(0, 250 - (Date.now() - t0))));
      }
    })();
    return () => {
      stop = true;
    };
  }, [serial, live, mode]);

  useEffect(() => {
    if (!serial) return;
    api.deviceInfo(serial).then(setInfo).catch(() => undefined);
  }, [serial]);

  useEffect(() => {
    if (!recAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [recAt]);

  /** 화면 요소 좌표 → 기기 좌표. 스트림은 축소된 영상이라 기기 해상도 비율을 곱한다 */
  const toDevice = (clientX: number, clientY: number) => {
    const el = (mode === 'stream' ? canvasRef.current : imgRef.current)!;
    const r = el.getBoundingClientRect();
    const w = el instanceof HTMLCanvasElement ? el.width : el.naturalWidth;
    const h = el instanceof HTMLCanvasElement ? el.height : el.naturalHeight;
    const scale = el instanceof HTMLCanvasElement && info ? Math.max(info.screen.width, info.screen.height) / Math.max(w, h) : 1;
    return {
      x: ((clientX - r.left) / r.width) * w * scale,
      y: ((clientY - r.top) / r.height) * h * scale,
    };
  };

  const log = (s: string) => setHistory((h) => [`${new Date().toLocaleTimeString()} ${s}`, ...h].slice(0, 50));

  const onDown = (e: React.MouseEvent) => {
    drag.current = { ...toDevice(e.clientX, e.clientY), t: Date.now() };
  };
  const onUp = async (e: React.MouseEvent) => {
    if (!serial || !drag.current || busy) return;
    const start = drag.current;
    drag.current = null;
    const end = toDevice(e.clientX, e.clientY);
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const held = Date.now() - start.t;
    const action: GraphAction =
      dist > 30
        ? { type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: Math.min(Math.max(held, 150), 1000) }
        : held > 600
          ? { type: 'longpress', x: start.x, y: start.y }
          : { type: 'tap', x: start.x, y: start.y };
    if (graphMode && pkg) {
      setBusy(true);
      const r = await run(api.graphRecord(serial, pkg, action));
      setBusy(false);
      if (r?.recorded) log(`${action.type} → ${r.to}${r.isNew ? ` ${t('(새 화면)')}` : ''}`);
      else if (r) log(action.type);
    } else if (dist > 30) {
      await run(api.swipe(serial, start.x, start.y, end.x, end.y, Math.min(Math.max(held, 150), 1000)));
      log(`swipe ${Math.round(start.x)},${Math.round(start.y)} → ${Math.round(end.x)},${Math.round(end.y)}`);
    } else if (held > 600) {
      await run(api.longPress(serial, start.x, start.y));
      log(`long press ${Math.round(start.x)},${Math.round(start.y)}`);
    } else {
      await run(api.tap(serial, start.x, start.y));
      log(`tap ${Math.round(start.x)},${Math.round(start.y)}`);
    }
  };

  const key = async (k: string) => {
    if (!serial) return;
    if (graphMode && pkg && k === 'back') {
      setBusy(true);
      const r = await run(api.graphRecord(serial, pkg, { type: 'key', key: 'back' }));
      setBusy(false);
      if (r) log(r.recorded ? `back → ${r.to}` : 'key back');
    } else {
      await run(api.key(serial, k));
      log(`key ${k}`);
    }
  };

  const toggleRec = async () => {
    if (!serial) return;
    if (recAt) {
      setRecAt(null);
      toast(t('녹화 저장 중…'));
      const p = await run(api.recordStop(serial));
      if (p) {
        toast(t('저장됨: {path}', { path: p }));
        api.reveal(p);
      }
    } else {
      const at = await run(api.recordStart(serial));
      if (at) setRecAt(at);
    }
  };

  const shot = async () => {
    if (!serial) return;
    const p = await run(api.saveScreenshot(serial, screen?.activity.split('.').pop()));
    if (p) {
      toast(t('저장됨: {path}', { path: p }));
      api.reveal(p);
    }
  };

  const recSec = recAt ? Math.floor((now - recAt) / 1000) : 0;

  return (
    <div className="mirror-wrap">
      <div className="mirror-stage">
        {mode === 'stream' && serial ? (
          <div className="device-frame">
            <MirrorCanvas
              key={serial}
              ref={(h) => {
                canvasRef.current = h?.canvas ?? null;
              }}
              serial={serial}
              onFps={setFps}
              onError={(msg) => {
                toast(`${msg} — ${t('스냅샷 모드로 전환합니다')}`, true);
                setMode('snapshot');
              }}
              onMouseDown={onDown}
              onMouseUp={onUp}
              onMouseLeave={() => (drag.current = null)}
              className="mirror-canvas"
              style={{ opacity: busy ? 0.6 : 1 }}
            />
          </div>
        ) : img ? (
          <div className="device-frame">
            <img
              ref={imgRef}
              src={img}
              onMouseDown={onDown}
              onMouseUp={onUp}
              onMouseLeave={() => (drag.current = null)}
              style={{ opacity: busy ? 0.6 : 1 }}
              alt="device"
            />
          </div>
        ) : (
          <div className="faint">{t('화면 불러오는 중…')}</div>
        )}
      </div>
      <aside className="side">
        <div>
          <h4>{t('조작')}</h4>
          <div className="keys">
            <button className="btn sm" onClick={() => key('back')}>◀ {t('뒤로')}</button>
            <button className="btn sm" onClick={() => key('home')}>● {t('홈')}</button>
            <button className="btn sm" onClick={() => key('recents')}>■ {t('최근')}</button>
            {mode === 'snapshot' && (
              <button className="btn sm" onClick={() => setLive((v) => !v)}>{live ? `⏸ ${t('일시정지')}` : `▶ ${t('실시간')}`}</button>
            )}
          </div>
          <div className="keys" style={{ marginTop: 6 }}>
            <button className={`btn sm ${mode === 'stream' ? 'primary' : ''}`} onClick={() => setMode('stream')}>{t('고프레임')}</button>
            <button className={`btn sm ${mode === 'snapshot' ? 'primary' : ''}`} onClick={() => setMode('snapshot')}>{t('스냅샷')}</button>
            {mode === 'stream' && <span className="faint" style={{ fontSize: 11, alignSelf: 'center' }}>{fps} fps</span>}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{t('클릭 = 탭 · 드래그 = 스와이프 · 0.6초 이상 = 길게 누르기')}</div>
        </div>
        <div>
          <h4>{t('캡처')}</h4>
          <div className="keys">
            <button className="btn sm" onClick={shot}>📷 {t('스크린샷')}</button>
            <button className={`btn sm ${recAt ? 'on' : ''}`} onClick={toggleRec}>
              {recAt ? `⏹ ${t('녹화 중 {sec}s / 180s', { sec: recSec })}` : `⏺ ${t('녹화')}`}
            </button>
          </div>
        </div>
        <div>
          <h4>{t('텍스트 입력')}</h4>
          <form
            style={{ display: 'flex', gap: 6 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!serial || !text) return;
              await run(api.typeText(serial, text));
              log(`type "${text}"`);
              setText('');
            }}
          >
            <input className="input" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('포커스된 입력창에 입력 (에이전트 실행 시 한글 가능)')} />
            <button className="btn sm">{t('입력')}</button>
          </form>
        </div>
        <div>
          <h4>{t('화면 흐름 기록')}</h4>
          <label className="chk">
            <input type="checkbox" checked={graphMode} disabled={!pkg} onChange={(e) => setGraphMode(e.target.checked)} />
            {t('탭·길게 누르기·스와이프·뒤로를 앱 화면 지도에 기록')}
          </label>
          <div className="faint" style={{ fontSize: 11 }}>{t('에이전트가 켜져 있고 선택한 앱 화면일 때만 기록합니다')}</div>
          {!pkg && <div className="faint" style={{ fontSize: 11 }}>{t('앱을 선택하면 사용할 수 있습니다')}</div>}
        </div>
        <div>
          <h4>{t('현재 화면')}</h4>
          <div className="kv">
            <span>{t('패키지')}</span>
            <span>{screen?.packageName || '-'}</span>
            <span>Activity</span>
            <span>{screen?.activity.split('.').pop() || '-'}</span>
            <span>Fragment</span>
            <span>{screen?.fragments.join(', ') || '-'}</span>
          </div>
        </div>
        {info && (
          <div>
            <h4>{t('기기')}</h4>
            <div className="kv">
              <span>{t('모델')}</span>
              <span>{info.manufacturer} {info.model}</span>
              <span>Android</span>
              <span>{info.androidVersion} (API {info.sdk})</span>
              <span>{t('화면')}</span>
              <span>{info.screen.width}×{info.screen.height} · {info.screen.density}dpi</span>
              <span>ABI</span>
              <span>{info.abi}</span>
            </div>
          </div>
        )}
        <div>
          <h4>{t('동작 기록')}</h4>
          <div className="log-mini">{history.join('\n') || '-'}</div>
        </div>
      </aside>
    </div>
  );
}
