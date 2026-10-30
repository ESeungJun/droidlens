import { useEffect, useMemo, useState } from 'react';
import { api, type ScenarioData } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';
import { ScriptsPanel } from './ScriptsPanel';

function StepShot({ dir, file }: { dir: string; file: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    api.scenarioImage(dir, file).then(setSrc).catch(() => undefined);
  }, [dir, file]);
  return src ? <img src={src} alt="" /> : null;
}

/** 스크린샷 비교에 실패한 단계: 화면이 의도대로 바뀐 것이면 지금 화면을 새 기준으로 받아들인다 */
function AcceptBaseline({ dir, baseline }: { dir: string; baseline: NonNullable<ScenarioData['steps'][number]['baseline']> }) {
  const { run, toast } = useApp();
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
      <span className="faint" style={{ fontSize: 11.5 }}>{t('빨간 곳이 기준 이미지와 달라진 부분입니다')}</span>
      <div className="spacer" />
      <button className="btn sm" onClick={() => api.openPath(`${dir}/${baseline.actual}`)}>{t('지금 화면 보기')}</button>
      <button
        className="btn sm primary"
        disabled={done}
        title={t('화면이 의도대로 바뀐 것이면 다음 실행부터 이 화면과 비교합니다')}
        onClick={async () => {
          if ((await run(api.baselineAccept(dir, baseline.actual, baseline.app, baseline.name))) !== undefined) {
            setDone(true);
            toast(t('"{name}" 기준 이미지를 바꿨습니다', { name: baseline.name }));
          }
        }}
      >
        {done ? t('기준으로 저장됨') : t('지금 화면을 기준으로')}
      </button>
    </div>
  );
}

type GroupBy = 'none' | 'app' | 'date' | 'name';
const GROUP_KEY = 'droidlens.scenarios.groupBy';

function readGroupBy(): GroupBy {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    if (v === 'none' || v === 'app' || v === 'date' || v === 'name') return v;
  } catch {
    /* 기본값 */
  }
  return 'app';
}

/** 리포트를 묶을 이름. 목록이 최신순이라 그룹도 최근 것이 먼저 온다 */
function groupOf(s: ScenarioData, by: GroupBy, other: string): string {
  if (by === 'app') return s.packageName || other;
  if (by === 'date') return new Date(s.startedAt).toLocaleDateString();
  if (by === 'name') return s.name;
  return '';
}

function ReportsView() {
  const { run, toast } = useApp();
  const t = useT();
  const [list, setList] = useState<ScenarioData[]>([]);
  const [sel, setSel] = useState<ScenarioData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [groupBy, setGroupByState] = useState<GroupBy>(readGroupBy);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // 여러 개 지우기: 선택 모드에서 체크한 리포트 id
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ids: string[]; text: string } | null>(null);

  const load = async () => {
    const l = (await run(api.scenarios())) ?? [];
    setList(l);
    setLoaded(true);
    setSel((s) => (s ? l.find((x) => x.id === s.id) ?? null : l[0] ?? null));
    setPicked((cur) => new Set([...cur].filter((id) => l.some((x) => x.id === id))));
  };
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000); // 에이전트가 진행 중인 시나리오를 실시간 반영
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setGroupBy = (v: GroupBy) => {
    setGroupByState(v);
    setFolded(new Set());
    try {
      localStorage.setItem(GROUP_KEY, v);
    } catch {
      /* 이번 실행 동안만 유지 */
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, ScenarioData[]>();
    for (const s of list) {
      const g = groupOf(s, groupBy, t('앱 정보 없음'));
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return [...m.entries()];
  }, [list, groupBy, t]);

  const toggle = (set: Set<string>, ids: string[], on: boolean) => {
    const next = new Set(set);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  };

  const remove = async (ids: string[]) => {
    setConfirm(null);
    if ((await run(api.scenarioDelete(ids))) === undefined) return;
    toast(t('리포트 {n}개를 지웠습니다', { n: ids.length }));
    setPicked(new Set());
    setPicking(false);
    if (sel && ids.includes(sel.id)) setSel(null);
    await load();
  };

  const item = (s: ScenarioData) => (
    <div key={s.id} className={`scen-item ${sel?.id === s.id ? 'sel' : ''}`} onClick={() => (picking ? setPicked((c) => toggle(c, [s.id], !c.has(s.id))) : setSel(s))}>
      {picking && <input type="checkbox" checked={picked.has(s.id)} readOnly style={{ marginTop: 3 }} />}
      <div className="scen-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</b>
          <span className={`v-${s.verdict ?? 'blocked'}`}>{s.verdict ? s.verdict.toUpperCase() : t('진행 중')}</span>
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          {new Date(s.startedAt).toLocaleString()} · {t('{n}단계 · 실패 {fail}', { n: s.steps.length, fail: s.steps.filter((x) => x.status === 'fail').length })}
        </div>
      </div>
    </div>
  );

  return (
    <div className="scen" style={{ height: 'calc(100% - 45px)' }}>
      <div className="scen-list">
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
          <b>{t('시나리오 검증 기록')}</b>
          <span className="faint">({list.length})</span>
          <div className="spacer" />
          <select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} title={t('묶기')}>
            <option value="none">{t('묶지 않음')}</option>
            <option value="app">{t('앱별')}</option>
            <option value="date">{t('날짜별')}</option>
            <option value="name">{t('이름별')}</option>
          </select>
          <button className={`btn sm ${picking ? 'primary' : ''}`} disabled={!list.length} onClick={() => { setPicking(!picking); setPicked(new Set()); }}>
            {picking ? t('선택 끝') : t('선택')}
          </button>
        </div>
        {picking && (
          <div className="toolbar" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map((x) => x.id)))}>
              {picked.size === list.length ? t('모두 해제') : t('모두 선택')}
            </button>
            <button
              className="btn sm danger"
              disabled={!picked.size}
              onClick={() => setConfirm({ ids: [...picked], text: t('선택한 리포트 {n}개를 지울까요?', { n: picked.size }) })}
            >
              {t('선택 삭제 ({n})', { n: picked.size })}
            </button>
          </div>
        )}
        {confirm && (
          <div className="toolbar" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="muted" style={{ flex: 1 }}>{confirm.text}</span>
            <button className="btn sm danger" onClick={() => remove(confirm.ids)}>{t('삭제')}</button>
            <button className="btn sm" onClick={() => setConfirm(null)}>{t('취소')}</button>
          </div>
        )}
        {!loaded && <div className="empty" style={{ height: 'auto', padding: 24 }}>{t('불러오는 중…')}</div>}
        {loaded && list.length === 0 && (
          <div className="empty" style={{ height: 'auto', padding: 24 }}>
            {t('아직 기록이 없습니다.')}
            <br />
            {t('Claude Code에서 droidlens-verifier 에이전트에게 시나리오 검증을 맡겨 보세요.')}
          </div>
        )}
        {groupBy === 'none'
          ? list.map(item)
          : groups.map(([g, items]) => {
              const open = !folded.has(g);
              const ids = items.map((x) => x.id);
              const all = ids.every((id) => picked.has(id));
              return (
                <div key={g}>
                  <div className="scen-group" onClick={() => setFolded((c) => toggle(c, [g], open))}>
                    <span>{open ? '▾' : '▸'}</span>
                    {picking && (
                      <input
                        type="checkbox"
                        checked={all}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => setPicked((c) => toggle(c, ids, !all))}
                      />
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g}</span>
                    <span className="n">{items.length}</span>
                  </div>
                  {open && items.map(item)}
                </div>
              );
            })}
      </div>
      {sel ? (
        <div className="steps">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{sel.name}</h2>
            <span className={`v-${sel.verdict ?? 'blocked'}`} style={{ fontWeight: 700 }}>{sel.verdict?.toUpperCase() ?? t('진행 중')}</span>
            <div className="spacer" />
            {sel.finishedAt && <button className="btn sm" onClick={() => api.openPath(`${sel.dir}/report.html`)}>{t('HTML 리포트 열기')}</button>}
            <button className="btn sm" onClick={() => api.reveal(`${sel.dir}/scenario.json`)}>{t('폴더')}</button>
            <button className="btn sm danger" onClick={() => setConfirm({ ids: [sel.id], text: t('"{name}" 리포트를 지울까요?', { name: sel.name }) })}>
              {t('삭제')}
            </button>
          </div>
          <div className="muted" style={{ marginBottom: 10 }}>
            {[sel.packageName, sel.device].filter(Boolean).join(' · ')}
          </div>
          {sel.goal && <p><b>{t('목표')}</b> {sel.goal}</p>}
          {sel.summary && <p><b>{t('결론')}</b> {sel.summary}</p>}
          {sel.steps.map((st) => (
            <div className="step" key={st.index}>
              <div>
                <span className={`badge b-${st.status}`}>{st.status.toUpperCase()}</span>
                <b>{st.index}. {st.title}</b>
              </div>
              {st.screen && <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>{st.screen}</div>}
              {st.detail && <pre>{st.detail}</pre>}
              {st.screenshot && (
                <div className="shot">
                  <StepShot dir={sel.dir} file={st.screenshot} />
                </div>
              )}
              {st.baseline && <AcceptBaseline dir={sel.dir} baseline={st.baseline} />}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">{t('시나리오를 선택하세요')}</div>
      )}
    </div>
  );
}

export function ScenariosTab() {
  const t = useT();
  const [view, setView] = useState<'reports' | 'scripts'>(location.hash.includes('view=scripts') ? 'scripts' : 'reports');
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <div className="toolbar">
        <button className={`btn ${view === 'reports' ? 'primary' : ''}`} onClick={() => setView('reports')}>{t('검증 리포트')}</button>
        <button className={`btn ${view === 'scripts' ? 'primary' : ''}`} onClick={() => setView('scripts')}>{t('스크립트 (회귀 테스트)')}</button>
      </div>
      {view === 'reports' ? (
        <ReportsView key={reloadKey} />
      ) : (
        <div style={{ height: 'calc(100% - 45px)' }}>
          <ScriptsPanel onFinished={() => setReloadKey((k) => k + 1)} />
        </div>
      )}
    </>
  );
}
