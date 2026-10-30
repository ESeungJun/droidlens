import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogLine } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';

const LEVELS = ['V', 'D', 'I', 'W', 'E'] as const;
const RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };
const MAX = 5000;
/** 로그 스트림 번호. 시작할 때마다 새로 받아 이전 스트림의 늦은 로그를 버린다 */
let lastStreamId = 0;

export function LogTab() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [onlyPkg, setOnlyPkg] = useState(true);
  const [minLevel, setMinLevel] = useState<(typeof LEVELS)[number]>('D');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [crashes, setCrashes] = useState<string[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // 지금 받고 있는 스트림 번호 (없으면 null)
  const streamId = useRef<number | null>(null);
  const target = onlyPkg && pkg ? pkg : undefined;

  useEffect(() => api.onLogcat((p) => p.id === streamId.current && setLines((cur) => [...cur, ...p.lines].slice(-MAX))), []);
  useEffect(
    () =>
      api.onLogcatClosed((p) => {
        if (p.id !== streamId.current) return;
        streamId.current = null;
        setRunning(false);
        toast(t('로그 수집이 끊겼습니다'), true);
      }),
    [toast, t],
  );
  useEffect(
    () => () => {
      if (streamId.current !== null) void api.logcatStop(streamId.current);
    },
    [],
  );

  const start = async () => {
    if (!serial) return;
    const id = ++lastStreamId;
    streamId.current = id;
    setLines([]);
    const r = await run(api.logcatStart(serial, target, id));
    if (streamId.current !== id) return; // 그사이 중지했거나 다시 시작했다
    if (r === undefined) streamId.current = null;
    setRunning(r !== undefined);
  };
  const stop = async () => {
    const id = streamId.current;
    streamId.current = null;
    setRunning(false);
    if (id !== null) await api.logcatStop(id);
  };

  // 받는 중에 기기나 대상 앱이 바뀌면 다른 기기·앱 로그가 섞이지 않게 새 대상으로 다시 시작한다
  useEffect(() => {
    if (streamId.current !== null) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, target]);

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
          <button className="btn on" onClick={stop}>⏹ {t('중지')}</button>
        ) : (
          <button className="btn primary" onClick={start}>▶ {t('실시간 로그')}</button>
        )}
        <label className="chk">
          <input type="checkbox" checked={onlyPkg} disabled={!pkg || running} onChange={(e) => setOnlyPkg(e.target.checked)} />
          {t('선택한 앱만')}{pkg ? '' : ` ${t('(앱 선택 필요)')}`}
        </label>
        <select className="input" value={minLevel} onChange={(e) => setMinLevel(e.target.value as typeof minLevel)}>
          {LEVELS.map((l) => <option key={l} value={l}>{t('{level} 이상', { level: l })}</option>)}
        </select>
        <input className="input" placeholder={t('태그·메시지 필터')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <label className="chk"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{t('자동 스크롤')}</label>
        <button className="btn" onClick={() => setLines([])}>{t('지우기')}</button>
        <button className="btn" onClick={async () => serial && setCrashes((await run(api.crashes(serial, pkg ?? undefined))) ?? [])}>{t('크래시 조회')}</button>
        <span className="muted">{shown.length} / {lines.length}</span>
      </div>
      {crashes ? (
        <div className="scroll">
          <button className="btn sm" onClick={() => setCrashes(null)}>← {t('로그로')}</button>
          {crashes.length === 0 ? <p className="muted">{t('최근 크래시가 없습니다.')}</p> : crashes.slice(-5).reverse().map((c, i) => (
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
          {!running && lines.length === 0 && <div className="empty">{t('실시간 로그를 시작하세요')}</div>}
        </div>
      )}
    </>
  );
}
