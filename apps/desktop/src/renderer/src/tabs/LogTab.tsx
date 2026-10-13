import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogLine } from '../api';
import { useApp } from '../App';

const LEVELS = ['V', 'D', 'I', 'W', 'E'] as const;
const RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };
const MAX = 5000;

export function LogTab() {
  const { serial, pkg, run } = useApp();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [onlyPkg, setOnlyPkg] = useState(true);
  const [minLevel, setMinLevel] = useState<(typeof LEVELS)[number]>('D');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [crashes, setCrashes] = useState<string[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => api.onLogcat((ls) => setLines((cur) => [...cur, ...ls].slice(-MAX))), []);
  useEffect(() => () => void api.logcatStop(), []);

  const start = async () => {
    if (!serial) return;
    setLines([]);
    const r = await run(api.logcatStart(serial, onlyPkg && pkg ? pkg : undefined));
    if (r !== undefined) setRunning(true);
  };
  const stop = async () => {
    await api.logcatStop();
    setRunning(false);
  };

  const shown = useMemo(() => {
    const qq = q.toLowerCase();
    return lines.filter((l) => RANK[l.level] >= RANK[minLevel] && (!qq || l.tag.toLowerCase().includes(qq) || l.message.toLowerCase().includes(qq)));
  }, [lines, minLevel, q]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <>
      <div className="toolbar">
        {running ? (
          <button className="btn on" onClick={stop}>⏹ 중지</button>
        ) : (
          <button className="btn primary" onClick={start}>▶ 실시간 로그</button>
        )}
        <label className="chk">
          <input type="checkbox" checked={onlyPkg} disabled={!pkg || running} onChange={(e) => setOnlyPkg(e.target.checked)} />
          선택한 앱만{pkg ? '' : ' (앱 선택 필요)'}
        </label>
        <select className="input" value={minLevel} onChange={(e) => setMinLevel(e.target.value as typeof minLevel)}>
          {LEVELS.map((l) => <option key={l} value={l}>{l} 이상</option>)}
        </select>
        <input className="input" placeholder="태그·메시지 필터" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <label className="chk"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />자동 스크롤</label>
        <button className="btn" onClick={() => setLines([])}>지우기</button>
        <button className="btn" onClick={async () => serial && setCrashes((await run(api.crashes(serial, pkg ?? undefined))) ?? [])}>크래시 조회</button>
        <span className="muted">{shown.length} / {lines.length}</span>
      </div>
      {crashes ? (
        <div className="scroll">
          <button className="btn sm" onClick={() => setCrashes(null)}>← 로그로</button>
          {crashes.length === 0 ? <p className="muted">최근 크래시가 없습니다.</p> : crashes.slice(-5).reverse().map((c, i) => (
            <pre key={i} className="mono card" style={{ whiteSpace: 'pre-wrap', color: 'var(--err)', marginTop: 10 }}>{c}</pre>
          ))}
        </div>
      ) : (
        <div className="logs" ref={box}>
          {shown.map((l, i) => (
            <div key={i} className={`ll lv-${l.level}`}>
              <span className="tm">{l.time.slice(6)}</span>
              <span>{l.level}</span>
              <span className="tg" title={l.tag}>{l.tag}</span>
              <span>{l.message}</span>
            </div>
          ))}
          {!running && lines.length === 0 && <div className="empty">실시간 로그를 시작하세요</div>}
        </div>
      )}
    </>
  );
}
