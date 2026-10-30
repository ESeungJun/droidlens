import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type LogLine } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';

const LEVELS = ['V', 'D', 'I', 'W', 'E'] as const;
const RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };
const MAX = 5000;
/** 한 줄 높이(px). styles.css 의 .ll.fixed 와 같아야 한다. 높이가 고정이라 보이는 줄만 그릴 수 있다 */
const ROW_H = 18;
/** 화면 위아래로 미리 그려 둘 줄 수 (빠르게 스크롤해도 빈 곳이 덜 보이게) */
const OVERSCAN = 30;
/** 받은 순서 번호를 붙인 로그 줄. 목록 앞이 잘려 나가도 같은 줄은 같은 key 를 쓰게 한다 */
type Row = LogLine & { seq: number };
/** 로그 스트림 번호. 시작할 때마다 새로 받아 이전 스트림의 늦은 로그를 버린다 */
let lastStreamId = 0;

export function LogTab() {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [lines, setLines] = useState<Row[]>([]);
  const seq = useRef(0);
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

  useEffect(
    () =>
      api.onLogcat((p) => {
        if (p.id !== streamId.current) return;
        const add = p.lines.map((l) => ({ ...l, seq: ++seq.current }));
        setLines((cur) => {
          const next = cur.concat(add);
          return next.length > MAX ? next.slice(next.length - MAX) : next;
        });
      }),
    [],
  );
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

  // 보이는 범위만 그린다. 스크롤 위치와 창 높이로 그릴 줄을 정한다
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [crashes]);
  // 자동 스크롤: 전체 높이를 계산해 두었으므로 scrollHeight 를 읽지 않고 맨 아래로 보낸다 (넘치는 값은 브라우저가 끝으로 맞춘다)
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = shown.length * ROW_H;
  }, [shown, follow]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

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
        <div className="logs" ref={box} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: shown.length * ROW_H, position: 'relative' }}>
            <div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
              {shown.slice(first, last).map((l) => (
                <div key={l.seq} className={`ll fixed lv-${l.level}`}>
                  <span className="tm">{l.time.slice(6)}</span>
                  <span>{l.level}</span>
                  <span className="tg" title={l.tag}>{l.tag}</span>
                  <span title={l.message}>{l.message}</span>
                </div>
              ))}
            </div>
          </div>
          {!running && lines.length === 0 && <div className="empty">{t('실시간 로그를 시작하세요')}</div>}
        </div>
      )}
    </>
  );
}
