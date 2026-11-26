import { useEffect, useMemo, useState } from 'react';
import { api, type QaRunIndexItem, type ScenarioData } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';
import { ScriptsPanel } from './ScriptsPanel';
import { RunDetail, RunHead, runKey, type RunGroup } from './QaRunRecord';
import { shortTime } from '../format';
import { requestQaPlan, takeScenario } from '../nav';
import { buildScenarioView, formatDuration, scenarioStale, tcName, STATUS_LABEL, VERDICT_LABEL, type StepRow } from '@droidlens/core/scenario-view';

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

/** 목록 한 줄: 낱개 기록 또는 QA 회차 묶음 (#98) */
type Entry = { kind: 'one'; s: ScenarioData } | { kind: 'run'; g: RunGroup };

/** 회차 번호가 없는 옛 TC 기록: 같은 계획에서 그 기록 직전(2시간 안)에 시작한 회차 */
function runAt(index: QaRunIndexItem[], plan: string, at: number): QaRunIndexItem | undefined {
  let best: QaRunIndexItem | undefined;
  for (const r of index) if (r.plan === plan && r.startedAt <= at && at - r.startedAt < 2 * 3600_000 && (!best || r.startedAt > best.startedAt)) best = r;
  return best;
}

/** 같은 QA 회차의 기록을 회차 하나로 묶는다 (#98·#105). 목록 순서(최신순)에서 회차의 가장 최근 기록 자리에 놓는다 */
function toEntries(list: ScenarioData[], index: QaRunIndexItem[], planNames: Map<string, string>): Entry[] {
  const byScenario = new Map<string, QaRunIndexItem>();
  const byKey = new Map<string, QaRunIndexItem>();
  for (const r of index) {
    byKey.set(runKey(r.plan, r.run), r);
    for (const id of r.scenarios) byScenario.set(id, r);
  }
  const out: Entry[] = [];
  const groups = new Map<string, RunGroup>();
  for (const s of list) {
    // 기록에 적힌 회차(tc.run)가 기준이고, 회차 결과의 리포트 경로는 tc.run 이 없는 옛 기록에만 쓴다 (#105)
    const own = s.tc?.run ? { plan: s.tc.plan, run: s.tc.run } : undefined;
    const info = own ? byKey.get(runKey(own.plan, own.run)) : (byScenario.get(s.id) ?? (s.tc ? runAt(index, s.tc.plan, s.startedAt) : undefined));
    const plan = own?.plan ?? info?.plan;
    const run = own?.run ?? info?.run;
    if (!plan || !run) {
      out.push({ kind: 'one', s });
      continue;
    }
    const key = runKey(plan, run);
    const g = groups.get(key);
    if (g) {
      g.items.push(s);
      continue;
    }
    const ng: RunGroup = { key, plan, run, planName: info?.planName ?? planNames.get(plan) ?? plan, startedAt: info?.startedAt ?? s.startedAt, info, items: [s] };
    groups.set(key, ng);
    out.push({ kind: 'run', g: ng });
  }
  return out;
}

function entryGroup(e: Entry, by: GroupBy, other: string): string {
  if (e.kind === 'one') return groupOf(e.s, by, other);
  if (by === 'name') return e.g.planName;
  if (by === 'app') return e.g.info?.app || e.g.items[0].packageName || other;
  return groupOf(e.g.items[0], by, other);
}

function ReportsView() {
  const { run, toast, openTab } = useApp();
  const t = useT();
  const [list, setList] = useState<ScenarioData[]>([]);
  const [sel, setSelState] = useState<ScenarioData | null>(null);
  // 고른 QA 회차 (runKey). 회차를 고르면 오른쪽에 회차 요약을 보인다 (#98)
  const [selRun, setSelRun] = useState<string | null>(null);
  const [index, setIndex] = useState<QaRunIndexItem[]>([]);
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const setSel: typeof setSelState = (v) => {
    setSelRun(null);
    setSelState(v);
  };
  const [loaded, setLoaded] = useState(false);
  const [groupBy, setGroupByState] = useState<GroupBy>(readGroupBy);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // 여러 개 지우기: 선택 모드에서 체크한 리포트 id
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ids: string[]; text: string } | null>(null);
  // QA 결과표의 '기록 보기'로 왔으면 그 기록을 먼저 연다
  const [want] = useState(takeScenario);
  const [planNames, setPlanNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    api
      .qaPlans()
      .then((p) => setPlanNames(new Map(p.map((x) => [x.id, x.name]))))
      .catch(() => undefined);
  }, []);

  const load = async () => {
    const [l, idx] = await Promise.all([run(api.scenarios()).then((x) => x ?? []), api.qaRunIndex().catch(() => [] as QaRunIndexItem[])]);
    setIndex(idx);
    setList(l);
    setLoaded(true);
    setSelState((s) => (s ? l.find((x) => x.id === s.id) ?? null : (want && l.find((x) => x.id === want)) || l[0] || null));
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

  const entries = useMemo(() => toEntries(list, index, planNames), [list, index, planNames]);
  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      const g = entryGroup(e, groupBy, t('앱 정보 없음'));
      m.set(g, [...(m.get(g) ?? []), e]);
    }
    return [...m.entries()];
  }, [entries, groupBy, t]);
  const selGroup = useMemo(() => {
    for (const e of entries) if (e.kind === 'run' && e.g.key === selRun) return e.g;
    return null;
  }, [entries, selRun]);
  const idsOf = (e: Entry) => (e.kind === 'one' ? [e.s.id] : e.g.items.map((x) => x.id));
  // QA 결과표에서 '기록 보기' 로 온 기록이 회차 안에 있으면 그 회차를 한 번 펼쳐 둔다 (사용자가 접은 회차는 다시 펴지 않게)
  const [wantOpened, setWantOpened] = useState(false);
  useEffect(() => {
    if (!want || wantOpened) return;
    const e = entries.find((x) => x.kind === 'run' && x.g.items.some((s) => s.id === want));
    if (!e || e.kind !== 'run') return;
    setWantOpened(true);
    setOpenRuns((c) => (c.has(e.g.key) ? c : new Set([...c, e.g.key])));
  }, [want, wantOpened, entries]);

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
    if (sel && ids.includes(sel.id)) setSelState(null);
    await load();
  };

  const listLine = (s: ScenarioData) => {
    const v = buildScenarioView(s);
    const base = t('{n}단계 · 실패 {fail}', { n: v.rows.length, fail: v.counts.fail });
    return v.attention.length ? `${base} · ${t('확인할 것 {n}', { n: v.attention.length })}` : base;
  };

  const item = (s: ScenarioData, nested = false) => (
    <div key={s.id} className={`scen-item ${nested ? 'nested' : ''} ${!selRun && sel?.id === s.id ? 'sel' : ''}`} onClick={() => (picking ? setPicked((c) => toggle(c, [s.id], !c.has(s.id))) : setSel(s))}>
      {picking && <input type="checkbox" checked={picked.has(s.id)} readOnly style={{ marginTop: 3 }} />}
      <div className="scen-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.tc ? tcName(s.tc.case, s.name) : s.name}</b>
          <span className={`v-${s.verdict ?? 'blocked'}`}>{s.verdict ? s.verdict.toUpperCase() : scenarioStale(s) ? t('끝나지 않음') : t('진행 중')}</span>
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          {shortTime(s.startedAt)} · {listLine(s)}
        </div>
        {s.tc && (
          <button
            className="scen-qa"
            title={t('이 기록을 만든 QA 계획 열기')}
            onClick={(e) => {
              e.stopPropagation();
              requestQaPlan(s.tc!.plan);
              openTab('qa');
            }}
          >
            QA · {planNames.get(s.tc.plan) ?? s.tc.plan} · {s.tc.case}
          </button>
        )}
      </div>
    </div>
  );

  const runItem = (g: RunGroup) => {
    const open = openRuns.has(g.key);
    const ids = g.items.map((x) => x.id);
    const all = ids.every((id) => picked.has(id));
    return (
      <div key={g.key}>
        <div
          className={`scen-item scen-run ${selRun === g.key ? 'sel' : ''}`}
          onClick={() => (picking ? setPicked((c) => toggle(c, ids, !all)) : setSelRun(g.key))}
        >
          {picking ? (
            <input type="checkbox" checked={all} readOnly style={{ marginTop: 3 }} />
          ) : (
            <button
              className="scen-fold"
              title={open ? t('TC 기록 접기') : t('TC 기록 펼치기')}
              onClick={(e) => {
                e.stopPropagation();
                setOpenRuns((c) => toggle(c, [g.key], !open));
              }}
            >
              {open ? '▾' : '▸'}
            </button>
          )}
          <RunHead g={g} />
        </div>
        {open && g.items.map((s) => item(s, true))}
      </div>
    );
  };
  const entry = (e: Entry) => (e.kind === 'one' ? item(e.s) : runItem(e.g));

  return (
    <div className="scen" style={{ height: 'calc(100% - 45px)' }}>
      <div className="scen-list">
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
          <b>{t('검증 기록')}</b>
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
          ? entries.map(entry)
          : groups.map(([g, items]) => {
              const open = !folded.has(g);
              const ids = items.flatMap(idsOf);
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
                  {open && items.map(entry)}
                </div>
              );
            })}
      </div>
      {selGroup ? (
        <RunDetail key={selGroup.key} g={selGroup} onOpenRecord={(s) => setSel(s)} />
      ) : sel ? (
        <div className="steps">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{sel.tc ? tcName(sel.tc.case, sel.name) : sel.name}</h2>
            <span className={`v-${sel.verdict ?? 'blocked'}`} style={{ fontWeight: 700 }}>{sel.verdict?.toUpperCase() ?? (scenarioStale(sel) ? t('끝나지 않음') : t('진행 중'))}</span>
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
          <ScenarioDetail data={sel} />
        </div>
      ) : (
        <div className="empty">{t('시나리오를 선택하세요')}</div>
      )}
    </div>
  );
}

const STATUS_TONE = { pass: 'pass', fail: 'fail', info: 'info', skip: 'mute' } as const;
/** 화면 문구 (core 라벨과 같은 뜻이지만 다른 화면 문구와 번역 키가 겹치지 않게 따로 둔다) */
const HOW_TEXT: Record<StepRow['how'], string> = { assert: '자동 검사', agent: '직접 판정', record: '진행 기록', action: '조작 실행' };
/** 스샷 파일은 시나리오 폴더 바로 아래 step-NNN.png 만 연다 (scenario.json 이 바뀌어도 다른 파일을 열지 않게) */
const SHOT_FILE = /^step-\d+(?:-actual)?\.png$/;

function Shot({ dir, file, tag }: { dir: string; file: string; tag?: string }) {
  const t = useT();
  if (!SHOT_FILE.test(file)) return null;
  return (
    <button className="rv-shot" title={t('크게 보기')} onClick={() => api.openPath(`${dir}/${file}`)}>
      <StepShot dir={dir} file={file} />
      {tag && <span className="tag">{tag}</span>}
    </button>
  );
}

/** 시나리오 한 건의 결론 → 확인할 것 → 단계 (HTML 리포트와 같은 정리 규칙) */
function ScenarioDetail({ data }: { data: ScenarioData }) {
  const t = useT();
  const v = useMemo(() => buildScenarioView(data), [data]);
  const [onlyAttn, setOnlyAttn] = useState(false);
  useEffect(() => setOnlyAttn(false), [data.id]);
  const jump = (index: number) => {
    setOnlyAttn(false);
    requestAnimationFrame(() => document.getElementById(`rv-s${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const time = (at: number) => new Date(at).toLocaleTimeString();
  return (
    <div className="rv">
      <div className="muted">{[data.device, data.packageName, formatDuration(v.durationMs)].filter(Boolean).join(' · ')}</div>
      <section className="rv-verdict">
        <div className="rv-top">
          <span className={`rv-big ${v.verdict === 'pass' ? 'pass' : v.verdict === 'fail' ? 'fail' : 'warn'}`}>{t(VERDICT_LABEL[v.verdict])}</span>
          {v.counts.corrected > 0 && <span className="rv-chip warn">{t('사람이 정정한 판정 {n}건 포함', { n: v.counts.corrected })}</span>}
        </div>
        {data.goal && <p className="rv-goal"><b>{t('목표')}</b> {data.goal}</p>}
        {data.summary && <p>{data.summary}</p>}
        {v.tally.length > 0 && (
          <div className="rv-tally">
            {v.tally.map((x) => (
              <span key={x.key} className={`rv-chip ${x.tone}`}>{t(x.label)} <b>{x.count}</b></span>
            ))}
          </div>
        )}
      </section>
      {v.attention.length > 0 ? (
        <section className="rv-attn">
          <b>{t('사람이 확인할 것 {n}건', { n: v.attention.length })}</b>
          <ol>
            {v.attention.map((a) => {
              const why = a.reasons.map((x) => x.why).filter(Boolean).join(' ');
              return (
                <li key={a.index}>
                  <button className="rv-link" onClick={() => jump(a.index)}>{t('{n}번째 단계', { n: a.no })} {a.title}</button> —{' '}
                  {a.reasons.map((x) => t(x.label)).join(' · ')}
                  {why && <span className="rv-why">{why}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        v.rows.length > 0 && data.finishedAt && <div className="rv-ok">{t('다시 볼 단계가 없습니다. 모든 단계가 기록대로 통과했습니다.')}</div>
      )}
      <div className="rv-filters">
        <b>{t('단계 {n}개', { n: v.rows.length })}</b>
        <div className="spacer" />
        {v.attention.length > 0 && (
          <>
            <button className={`btn sm ${!onlyAttn ? 'primary' : ''}`} onClick={() => setOnlyAttn(false)}>{t('전체')}</button>
            <button className={`btn sm ${onlyAttn ? 'primary' : ''}`} onClick={() => setOnlyAttn(true)}>{t('확인할 것만')}</button>
          </>
        )}
      </div>
      {v.rows
        .filter((r) => !onlyAttn || r.reasons.length > 0)
        .map((r) => {
          const hasShot = !!(r.screenshot || r.corrected?.screenshot);
          const quiet = r.how === 'action' || r.how === 'record';
          return (
            <article key={r.index} id={`rv-s${r.index}`} className={`rv-step ${r.tone} ${!hasShot && quiet ? 'wide' : ''}`}>
              <div className="rv-body">
                <div className="rv-head">
                  <span className="rv-no">{r.no}</span>
                  {r.corrected ? (
                    <span className="rv-chip warn">{t('정정 → {s}', { s: t(STATUS_LABEL[r.status]) })}</span>
                  ) : (
                    <span className={`rv-chip ${STATUS_TONE[r.status]}`}>{t(STATUS_LABEL[r.status])}</span>
                  )}
                  {r.foreign && <span className="rv-chip fail">{t('다른 앱 화면')}</span>}
                  <span className="rv-how">
                    {r.corrected ? t('{how} 후 정정', { how: t(HOW_TEXT[r.how]) }) : t(HOW_TEXT[r.how])} · {time(r.at)}
                  </span>
                </div>
                <dl className="rv-kv">
                  {r.actions.length > 0 && (
                    <>
                      <dt>{t('조작 내역')}</dt>
                      <dd>
                        <ol>
                          {r.actions.map((a, i) => (
                            <li key={i}>{a.at && <span className="rv-t">{time(a.at)}</span>}{a.text}</li>
                          ))}
                        </ol>
                      </dd>
                    </>
                  )}
                  {r.check && (
                    <>
                      <dt>{t('확인')}</dt>
                      <dd>{r.check}</dd>
                    </>
                  )}
                </dl>
                {r.expect !== undefined && (
                  <div className="rv-ea">
                    <div><b>{t('기대')}</b>{r.expect}</div>
                    <div className={r.actualBad ? 'bad' : ''}><b>{r.corrected ? t('자동 검사 결과') : t('실제')}</b>{r.actual ?? '-'}</div>
                  </div>
                )}
                {r.foreign && (
                  <div className="rv-note"><b>{t('주의')}</b> {t('스샷 순간 앞 화면이 대상 앱이 아니라 {pkg} 입니다. 이 창이 판정에 영향을 줬을 수 있습니다.', { pkg: r.foreign })}</div>
                )}
                {r.corrected?.note && <div className="rv-note"><b>{t('정정')}</b> {r.corrected.note}</div>}
                {r.corrected && (
                  <div className="rv-history">
                    {t('처음 판정')} <s>{t(STATUS_LABEL[r.corrected.from])}</s> · {t('정정 기록은 원래 {n}단계', { n: r.corrected.byIndex })}
                  </div>
                )}
                {r.evidence && <div className="rv-evid">{r.evidence}</div>}
                {r.baseline && <AcceptBaseline dir={data.dir} baseline={r.baseline} />}
              </div>
              {hasShot ? (
                <div className="rv-shots">
                  {r.screenshot && <Shot dir={data.dir} file={r.screenshot} tag={r.corrected?.screenshot ? t('처음') : r.foreign ? t('다른 앱') : undefined} />}
                  {r.corrected?.screenshot && <Shot dir={data.dir} file={r.corrected.screenshot} tag={t('정정 근거')} />}
                </div>
              ) : quiet ? null : (
                <div className="rv-noshot">{t('스샷 없음')}</div>
              )}
            </article>
          );
        })}
      {data.actions && data.actions.length > 0 && (
        <details className="rv-log">
          <summary>{t('전체 조작 로그 {n}건', { n: data.actions.length })}</summary>
          <ol>
            {data.actions.map((a, i) => (
              <li key={i}><span className="rv-t">{time(a.at)}</span>{a.text}</li>
            ))}
          </ol>
        </details>
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
