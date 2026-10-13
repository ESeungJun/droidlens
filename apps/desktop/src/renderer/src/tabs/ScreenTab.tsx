import { useEffect, useRef, useState } from 'react';
import { api, type CurrentScreen, type DeviceInfo } from '../api';
import { useApp } from '../App';

export function ScreenTab() {
  const { serial, pkg, toast, run } = useApp();
  const [img, setImg] = useState<string>('');
  const [live, setLive] = useState(true);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [screen, setScreen] = useState<CurrentScreen | null>(null);
  const [recAt, setRecAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [graphMode, setGraphMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; t: number } | null>(null);

  // 미러링 루프: 이전 프레임이 끝나야 다음 요청
  useEffect(() => {
    if (!serial || !live) return;
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
  }, [serial, live]);

  useEffect(() => {
    if (!serial) return;
    api.deviceInfo(serial).then(setInfo).catch(() => undefined);
    const tick = () => api.currentScreen(serial).then(setScreen).catch(() => undefined);
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [serial]);

  useEffect(() => {
    if (!recAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [recAt]);

  const toDevice = (clientX: number, clientY: number) => {
    const el = imgRef.current!;
    const r = el.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * el.naturalWidth,
      y: ((clientY - r.top) / r.height) * el.naturalHeight,
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
    if (dist > 30) {
      await run(api.swipe(serial, start.x, start.y, end.x, end.y, Math.min(Math.max(held, 150), 1000)));
      log(`swipe ${Math.round(start.x)},${Math.round(start.y)} → ${Math.round(end.x)},${Math.round(end.y)}`);
    } else if (held > 600) {
      await run(api.longPress(serial, start.x, start.y));
      log(`long press ${Math.round(start.x)},${Math.round(start.y)}`);
    } else if (graphMode && pkg) {
      setBusy(true);
      const r = await run(api.graphRecordTap(serial, pkg, start.x, start.y));
      setBusy(false);
      if (r) log(`tap → ${r.to}${r.isNew ? ' (새 화면)' : ''}`);
    } else {
      await run(api.tap(serial, start.x, start.y));
      log(`tap ${Math.round(start.x)},${Math.round(start.y)}`);
    }
  };

  const key = async (k: string) => {
    if (!serial) return;
    if (graphMode && pkg && k === 'back') {
      setBusy(true);
      const r = await run(api.graphRecordKey(serial, pkg, 'back'));
      setBusy(false);
      if (r) log(`back → ${r.to}`);
    } else {
      await run(api.key(serial, k));
      log(`key ${k}`);
    }
  };

  const toggleRec = async () => {
    if (!serial) return;
    if (recAt) {
      setRecAt(null);
      toast('녹화 저장 중…');
      const p = await run(api.recordStop(serial));
      if (p) {
        toast(`저장됨: ${p}`);
        api.reveal(p);
      }
    } else {
      const t = await run(api.recordStart(serial));
      if (t) setRecAt(t);
    }
  };

  const shot = async () => {
    if (!serial) return;
    const p = await run(api.saveScreenshot(serial, screen?.activity.split('.').pop()));
    if (p) {
      toast(`저장됨: ${p}`);
      api.reveal(p);
    }
  };

  const recSec = recAt ? Math.floor((now - recAt) / 1000) : 0;

  return (
    <div className="mirror-wrap">
      <div className="mirror-stage">
        {img ? (
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
          <div className="faint">화면 불러오는 중…</div>
        )}
      </div>
      <aside className="side">
        <div>
          <h4>조작</h4>
          <div className="keys">
            <button className="btn sm" onClick={() => key('back')}>◀ 뒤로</button>
            <button className="btn sm" onClick={() => key('home')}>● 홈</button>
            <button className="btn sm" onClick={() => key('recents')}>■ 최근</button>
            <button className="btn sm" onClick={() => setLive((v) => !v)}>{live ? '⏸ 일시정지' : '▶ 실시간'}</button>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>클릭 = 탭 · 드래그 = 스와이프 · 0.6초 이상 = 길게 누르기</div>
        </div>
        <div>
          <h4>캡처</h4>
          <div className="keys">
            <button className="btn sm" onClick={shot}>📷 스크린샷</button>
            <button className={`btn sm ${recAt ? 'on' : ''}`} onClick={toggleRec}>
              {recAt ? `⏹ 녹화 중 ${recSec}s / 180s` : '⏺ 녹화'}
            </button>
          </div>
        </div>
        <div>
          <h4>텍스트 입력</h4>
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
            <input className="input" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="포커스된 입력창에 입력 (에이전트 실행 시 한글 가능)" />
            <button className="btn sm">입력</button>
          </form>
        </div>
        <div>
          <h4>화면 흐름 기록</h4>
          <label className="chk">
            <input type="checkbox" checked={graphMode} disabled={!pkg} onChange={(e) => setGraphMode(e.target.checked)} />
            탭/뒤로 동작을 화면 그래프에 기록
          </label>
          {!pkg && <div className="faint" style={{ fontSize: 11 }}>앱을 선택하면 사용할 수 있습니다</div>}
        </div>
        <div>
          <h4>현재 화면</h4>
          <div className="kv">
            <span>패키지</span>
            <span>{screen?.packageName || '-'}</span>
            <span>Activity</span>
            <span>{screen?.activity.split('.').pop() || '-'}</span>
            <span>Fragment</span>
            <span>{screen?.fragments.join(', ') || '-'}</span>
          </div>
        </div>
        {info && (
          <div>
            <h4>기기</h4>
            <div className="kv">
              <span>모델</span>
              <span>{info.manufacturer} {info.model}</span>
              <span>Android</span>
              <span>{info.androidVersion} (API {info.sdk})</span>
              <span>화면</span>
              <span>{info.screen.width}×{info.screen.height} · {info.screen.density}dpi</span>
              <span>ABI</span>
              <span>{info.abi}</span>
            </div>
          </div>
        )}
        <div>
          <h4>동작 기록</h4>
          <div className="log-mini">{history.join('\n') || '-'}</div>
        </div>
      </aside>
    </div>
  );
}
