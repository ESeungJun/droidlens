import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type QaCase, type QaPlanSummary, type QaPlanDeleteInfo, type QaPlanView, type QaRunView, type QaSourceAdded } from '../api';
import { AuthHelp } from '../AuthHelp';
import { useApp } from '../App';
import { useI18n, useT } from '../i18n';
import { qaResultMemo } from '@droidlens/core/qa-note';
import { answerQaConfirm, useQaState, type QaLogLine, type QaState } from '../qaStore';
import { linkName, shortTime } from '../format';
import { requestScenario, takeQaPlan } from '../nav';

/**
 * QA 탭 (#78): 문서 넣기 → TC 검토 → 실행·결과. 계획·회차 파일은 core 가 갖고, 이 화면은 보여 주고 사람이 정할 것(선택·허용·고치기)만 한다.
 * 진행 상태는 qaStore (탭을 옮겨도 남는다).
 */

type Step = 'docs' | 'review' | 'run';
const PLAN_KEY = 'droidlens.qa.plan';

const KIND_LABEL: Record<QaCase['kind'], string> = { normal: '정상', exception: '예외', boundary: '경계', design: '디자인' };
/** 검증 갈래 (#129): 문서 종류마다 검증하는 방식. 화면에는 TC 문서 → 기획 흐름 → 디자인 가이드 순으로 놓는다 */
type Track = 'flow' | 'design' | 'tc';
const TRACKS: Track[] = ['tc', 'flow', 'design'];
const TRACK_LABEL: Record<Track, string> = { flow: '기획 흐름', design: '디자인 가이드', tc: 'TC 문서' };
const TRACK_HINT: Record<Track, string> = {
  tc: '넣은 TC 표의 원문 그대로',
  flow: '기획서의 사용자 흐름',
  design: 'Figma 프레임과 화면 차이',
};
/** track 이 없는 옛 TC 는 디자인 TC 면 디자인 가이드, 아니면 기획 흐름 (core caseTrack 과 같다) */
const trackOf = (c: Pick<QaCase, 'track' | 'kind'>): Track => c.track ?? (c.kind === 'design' ? 'design' : 'flow');
const AUTO_LABEL: Record<QaCase['automatable'], string> = { yes: '자동', partial: '일부 자동', manual: '수동' };
const STATUS_LABEL = { pass: '통과', fail: '실패', blocked: '막힘', skip: '건너뜀', 'not-run': '안 돌림' } as const;
const STATUS_TONE = { pass: 'pass', fail: 'fail', blocked: 'warn', skip: 'mute', 'not-run': 'mute' } as const;
const MODE_LABEL = { script: '스크립트', agent: '에이전트', manual: '직접 기록' } as const;
const REVIEW_LABEL: Record<NonNullable<QaCase['review']>[number], string> = {
  'danger-removed': '다시 보기: 확인 필수 표시가 빠졌어요. 실행할지 정해 주세요',
  'danger-changed': '다시 보기: 확인 필수 TC 내용이 바뀌었어요. 다시 허용해 주세요',
};
const SOURCE_KIND_LABEL: Record<string, string> = {
  md: 'MD',
  txt: 'TXT',
  pdf: 'PDF',
  csv: 'CSV',
  xlsx: '엑셀',
  confluence: 'Confluence',
  figma: 'Figma',
};

/** 문서 id(S1…)는 화면에서 "문서 1" 로 쓴다. */
const sourceLabel = (t: ReturnType<typeof useT>, id: string) => (/^S\d+$/.test(id) ? t('문서 {n}', { n: id.slice(1) }) : id);
const sourceTitle = (plan: QaPlanView['plan'], id: string) => {
  const s = plan.sources.find((x) => x.id === id);
  return s ? (s.title ?? (s.kind === 'confluence' || s.kind === 'figma' ? linkName(s.ref) : s.ref)) : undefined;
};

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

// 개발용: DROIDLENS_OPEN="tab=qa&plan=<계획 id>&step=review" 로 시작 계획·단계 지정
const initial = new URLSearchParams(location.hash.slice(1));
const initialStep = (['docs', 'review', 'run'] as const).find((s) => s === initial.get('step'));

function readPlanId(): string | null {
  const asked = takeQaPlan();
  if (asked) return asked;
  if (initial.get('plan')) return initial.get('plan');
  try {
    return localStorage.getItem(PLAN_KEY);
  } catch {
    return null;
  }
}

export function QaTab() {
  const { run, toast, pkg, pkgs, serial, selectApp } = useApp();
  const t = useT();
  const qa = useQaState();
  const [plans, setPlans] = useState<QaPlanSummary[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [sel, setSelState] = useState<string | null>(readPlanId);
  const [view, setView] = useState<QaPlanView | null>(null);
  const [step, setStep] = useState<Step>('docs');
  const [creating, setCreating] = useState(false);

  const setSel = (id: string | null) => {
    setSelState(id);
    try {
      if (id) localStorage.setItem(PLAN_KEY, id);
      else localStorage.removeItem(PLAN_KEY);
    } catch {
      /* 이번 실행 동안만 */
    }
  };

  useEffect(() => {
    let alive = true;
    api
      .qaPlans()
      .then((p) => alive && setPlans(p))
      .catch(() => undefined)
      .finally(() => alive && setPlansLoaded(true));
    return () => {
      alive = false;
    };
  }, [qa.tick]);

  const reload = useCallback(
    async (id: string | null = sel) => {
      if (!id) return setView(null);
      try {
        setView(await api.qaPlanGet(id));
      } catch (e) {
        setView(null);
        toast((e as Error).message, true);
        setSel(null);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [sel, toast],
  );
  useEffect(() => {
    void reload();
  }, [reload, qa.tick]);

  // 계획을 처음 열면 할 일이 남은 단계로 간다
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!view || opened.current === view.plan.id) return;
    const first = opened.current === null;
    opened.current = view.plan.id;
    setStep((first && initialStep) || (view.runs.length ? 'run' : view.plan.cases.length ? 'review' : 'docs'));
  }, [view]);

  /** 앱을 정해 계획을 만들고, pick 이면 바로 파일을 고른다. 이름을 비우면 처음 넣은 문서 제목으로 짓는다 */
  const create = async (name: string, app: string, pick: boolean) => {
    const p = await run(api.qaPlanCreate(name || t('{app} QA', { app: app.split('.').pop() ?? app }), app));
    if (!p) return;
    setCreating(false);
    setStep('docs');
    setSel(p.id);
    if (pick) {
      const added = (await run(api.qaSourcePick(p.id))) ?? [];
      const first = added.find((a) => !a.error);
      if (!name && first) await run(api.qaPlanRename(p.id, t('{doc} QA', { doc: first.title.replace(/\.[^.]+$/, '') }), app));
      await reload(p.id);
    }
    setPlans((await run(api.qaPlans())) ?? []);
  };

  // 계획 지우기 확인 (#133). 기록·스크립트는 기본으로 남긴다
  const [deleting, setDeleting] = useState<QaPlanDeleteInfo | null>(null);
  const [withRecords, setWithRecords] = useState(false);
  const askDelete = async (id: string) => {
    const info = await run(api.qaPlanDeleteInfo(id));
    if (!info) return;
    setWithRecords(false);
    setDeleting(info);
  };
  // 다른 계획을 고르면 확인 창을 닫는다
  useEffect(() => setDeleting(null), [sel]);
  const doDelete = async () => {
    const d = deleting;
    if (!d) return;
    setDeleting(null); // 먼저 닫아 두 번 누르지 않게
    const r = await run(api.qaPlanDelete(d.id, withRecords));
    if (!r) return;
    toast(t('"{name}" 계획을 지웠습니다', { name: d.name }));
    if (sel === r.id) setSel(null);
    setPlans((await run(api.qaPlans())) ?? []);
  };

  const busy = qa.job !== null;
  const plan = view?.plan;
  const byApp = useMemo(() => {
    const m = new Map<string, QaPlanSummary[]>();
    for (const p of plans) m.set(p.app ?? '', [...(m.get(p.app ?? '') ?? []), p]);
    return [...m.entries()];
  }, [plans]);
  const installed = !serial || pkgs.length === 0 || !plan?.app || pkgs.some((p) => p.packageName === plan.app);

  const steps = plan
    ? ([
        { id: 'docs', label: t('문서 넣기'), meta: t('{n}개', { n: plan.sources.length }), done: plan.sources.length > 0 },
        {
          id: 'review',
          label: t('TC 검토'),
          meta: plan.cases.length ? t('{k}/{n} 고름', { k: plan.cases.filter((c) => c.selected).length, n: plan.cases.length }) : '',
          done: plan.cases.some((c) => c.selected),
        },
        {
          id: 'run',
          label: t('실행·결과'),
          meta: view!.runs.length ? t('회차 {n}', { n: view!.runs.length }) : '',
          done: view!.runs.length > 0,
        },
      ] as const)
    : [];
  const showNew = creating || (plansLoaded && plans.length === 0);

  return (
    <div className="qa">
      <aside className="qa-plans">
        <div className="toolbar">
          <b>{t('QA 계획')}</b>
          <span className="faint">({plans.length})</span>
          <div className="spacer" />
          <button className={`btn sm ${showNew ? '' : 'primary'}`} disabled={showNew} onClick={() => setCreating(true)}>
            {t('+ 새 계획')}
          </button>
        </div>
        {byApp.map(([app, items]) => (
          <div key={app}>
            <div className="scen-group qa-group" title={app}>
              <span className="mono qa-ellipsis">{app || t('앱 미정')}</span>
              <span className="n">{items.length}</span>
            </div>
            {items.map((p) => (
              <Fragment key={p.id}>
              <div
                className={`scen-item ${sel === p.id && !showNew ? 'sel' : ''}`}
                onClick={() => {
                  setCreating(false);
                  setSel(p.id);
                }}
              >
                <div className="scen-body">
                  <b className="qa-ellipsis">{p.name}</b>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {t('문서 {s}개 · TC {c}개 (고름 {k})', { s: p.sources, c: p.cases, k: p.selected })}
                    {qa.job?.plan === p.id && <span className="qa-live"> · {qa.job.kind === 'extract' ? t('뽑는 중') : t('실행 중')}</span>}
                  </div>
                  {sel === p.id && !showNew && !deleting && (
                    <button
                      className="btn sm danger"
                      style={{ marginTop: 6 }}
                      disabled={qa.job?.plan === p.id}
                      title={qa.job?.plan === p.id ? t('작업이 돌고 있어 지울 수 없습니다') : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        void askDelete(p.id);
                      }}
                    >
                      {t('계획 지우기')}
                    </button>
                  )}
                </div>
              </div>
              {deleting?.id === p.id && (
                <div className="qa-ask" style={{ margin: '0 10px 10px' }}>
                  <b>{t('"{name}" 계획을 지울까요?', { name: deleting.name })}</b>
                  <div className="faint" style={{ marginTop: 4 }}>
                    {t('문서와 회차 {n}개의 결과가 함께 지워집니다. 되돌릴 수 없습니다.', { n: deleting.runs })}
                  </div>
                  {deleting.records + deleting.scripts > 0 && (
                    <label style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <input type="checkbox" checked={withRecords} onChange={(e) => setWithRecords(e.target.checked)} />
                      <span>{t('TC 기록 {r}개와 스크립트 {s}개도 지우기', { r: deleting.records, s: deleting.scripts })}</span>
                    </label>
                  )}
                  {deleting.running && <div className="v-blocked" style={{ marginTop: 6 }}>{t('이 계획의 회차가 돌고 있어 지울 수 없습니다')}</div>}
                  <div className="qa-row" style={{ marginTop: 8 }}>
                    <button className="btn sm danger" disabled={deleting.running} onClick={() => void doDelete()}>
                      {t('삭제')}
                    </button>
                    <button className="btn sm" onClick={() => setDeleting(null)}>
                      {t('취소')}
                    </button>
                  </div>
                </div>
              )}
              </Fragment>
            ))}
          </div>
        ))}
      </aside>
      {showNew ? (
        <NewPlan onCreate={create} onCancel={plans.length ? () => setCreating(false) : undefined} />
      ) : !plan ? (
        <div className="empty">{sel ? t('불러오는 중…') : t('왼쪽에서 계획을 고르세요')}</div>
      ) : (
        <section className="qa-main">
          <header className="qa-head">
            <div className="qa-head-app">
              <span className="faint">{t('대상 앱')}</span>
              <b className="mono qa-ellipsis" title={plan.app}>
                {plan.app ?? t('정하지 않음')}
              </b>
              {plan.app && !installed ? (
                <span className="v-blocked">{t('이 기기에 설치되어 있지 않습니다')}</span>
              ) : plan.app && pkg !== plan.app ? (
                <button
                  className="btn sm"
                  onClick={() => selectApp(plan.app!)}
                  title={t('위쪽 막대와 왼쪽 목록의 앱을 이 앱으로 맞춥니다')}
                >
                  {t('이 앱으로 바꾸기')}
                </button>
              ) : null}
              {!plan.app && pkg && (
                <button className="btn sm" onClick={async () => (await run(api.qaPlanRename(plan.id, plan.name, pkg))) && reload()}>
                  {t('{app} 으로 정하기', { app: pkg })}
                </button>
              )}
            </div>
            <div className="qa-head-name">{plan.name}</div>
          </header>
          <nav className="qa-stepper">
            {steps.map((s, i) => (
              <button key={s.id} className={`qa-stp ${step === s.id ? 'on' : ''} ${s.done ? 'done' : ''}`} onClick={() => setStep(s.id)}>
                <span className="qa-stp-n">{s.done && step !== s.id ? '✓' : i + 1}</span>
                <span className="qa-stp-l">{s.label}</span>
                {s.meta && <span className="qa-stp-m">{s.meta}</span>}
              </button>
            ))}
          </nav>
          {busy && qa.job!.plan !== plan.id && (
            <div className="qa-banner">{t('다른 계획에서 작업이 돌고 있습니다. 끝나거나 멈춘 뒤에 이 계획을 실행할 수 있습니다.')}</div>
          )}
          <div className="qa-body">
            {step === 'docs' && <DocsStep key={plan.id} view={view!} reload={reload} onNext={() => setStep('review')} />}
            {step === 'review' && <ReviewStep key={plan.id} view={view!} setView={setView} onNext={() => setStep('run')} />}
            {step === 'run' && <RunStep key={plan.id} view={view!} />}
          </div>
        </section>
      )}
    </div>
  );
}

/** 새 계획: 어떤 앱을 QA 할지 정하고 바로 문서를 고른다 */
function NewPlan({ onCreate, onCancel }: { onCreate: (name: string, app: string, pick: boolean) => Promise<void>; onCancel?: () => void }) {
  const { pkg, pkgs, screen } = useApp();
  const t = useT();
  const [app, setApp] = useState(pkg ?? screen?.packageName ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (pick: boolean) => {
    setBusy(true);
    await onCreate(name.trim(), app.trim(), pick).finally(() => setBusy(false));
  };
  return (
    <div className="qa-scroll">
      <form
        className="card qa-create"
        onSubmit={(e) => {
          e.preventDefault();
          if (app.trim()) void go(true);
        }}
      >
        <h4>{t('새 QA 계획')}</h4>
        <label className="qa-field">
          <span>{t('어떤 앱을 QA 하나요?')}</span>
          <input
            className="input mono"
            list="qa-apps"
            autoFocus
            placeholder="com.example.app"
            value={app}
            onChange={(e) => setApp(e.target.value)}
          />
          <datalist id="qa-apps">
            {pkgs.map((p) => (
              <option key={p.packageName} value={p.packageName} />
            ))}
          </datalist>
        </label>
        <label className="qa-field">
          <span>{t('계획 이름')}</span>
          <input className="input" placeholder={t('비우면 첫 문서 제목으로')} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="qa-row">
          <button className="btn primary" disabled={!app.trim() || busy}>
            {t('기획 문서 고르기…')}
          </button>
          <button type="button" className="btn" disabled={!app.trim() || busy} onClick={() => go(false)}>
            {t('링크로 넣기')}
          </button>
          <div className="spacer" />
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              {t('취소')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ---------- 1. 문서 ----------

function DocsStep({ view, reload, onNext }: { view: QaPlanView; reload: () => Promise<void>; onNext: () => void }) {
  const { run, toast } = useApp();
  const t = useT();
  const qa = useQaState();
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const plan = view.plan;
  const mine = qa.job?.plan === plan.id && qa.job.kind === 'extract';
  const busy = qa.job !== null;
  const lastHere = qa.last?.plan === plan.id && qa.last.job === 'extract' ? qa.last : null;

  // 머리글을 못 알아본 표: 사람이 열을 골라 TC 로 가져온다 (#129)
  const [pending, setPending] = useState<{ source: string; title: string; tables: NonNullable<QaSourceAdded['tcTables']> }[]>([]);
  const report = (added: QaSourceAdded[]) => {
    for (const a of added) {
      if (a.error) toast(t('{name}: {error}', { name: a.title, error: a.error }), true);
      else if (a.duplicate) toast(t('이미 들어 있는 문서입니다: {name}', { name: a.title }));
      for (const w of a.warnings ?? []) toast(`⚠ ${a.title}: ${w}`, true);
      if (a.tcImport) toast(t('{name}: TC 표에서 TC {n}개를 원문 그대로 가져왔어요', { name: a.title, n: a.tcImport.cases }));
      for (const w of a.tcImport?.warnings ?? []) toast(`⚠ ${a.title}: ${w}`, true);
    }
    const asks = added.filter((a) => a.id && a.tcTables?.length).map((a) => ({ source: a.id!, title: a.title, tables: a.tcTables! }));
    if (asks.length) setPending((p) => [...p.filter((x) => !asks.some((a) => a.source === x.source)), ...asks]);
    const ok = added.filter((a) => !a.error && !a.duplicate).length;
    if (ok) toast(t('문서 {n}개를 넣었습니다', { n: ok }));
  };
  const tcCount = (sid: string) => plan.cases.filter((c) => c.track === 'tc' && c.source?.source === sid).length;

  return (
    <div className="qa-scroll">
      <div className="card">
        <h5>{t('문서')}</h5>
        {plan.sources.length > 0 && (
          <table className="qa-table qa-src">
            <tbody>
              {plan.sources.map((s) => {
                const isLink = s.kind === 'confluence' || s.kind === 'figma';
                return (
                  <tr key={s.id}>
                    <td className="qa-nowrap">{sourceLabel(t, s.id)}</td>
                    <td className="qa-nowrap">
                      <span className="pill">{t(SOURCE_KIND_LABEL[s.kind] ?? s.kind)}</span>
                    </td>
                    <td className="qa-src-name" title={s.ref}>
                      <span className="qa-ellipsis">{s.title ?? (isLink ? linkName(s.ref) : s.ref)}</span>
                    </td>
                    <td className="qa-nowrap">
                      {tcCount(s.id) > 0 && <span className="rv-chip info">{t('TC {n}개 가져옴', { n: tcCount(s.id) })}</span>}
                    </td>
                    <td className="faint qa-nowrap">{shortTime(s.addedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="qa-add">
          <span className="qa-add-k">{t('파일')}</span>
          <button
            className="btn"
            disabled={mine}
            onClick={async () => {
              const r = await run(api.qaSourcePick(plan.id));
              if (r?.length) {
                report(r);
                await reload();
              }
            }}
          >
            {t('파일 고르기…')}
          </button>
          <span className="faint">md · txt · PDF · CSV · {t('엑셀')}</span>
          <span className="qa-add-k">{t('링크')}</span>
          <form
            className="qa-row qa-add-link"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await run(api.qaSourceLink(plan.id, link));
              if (!r) return;
              report([r]);
              setLink('');
              await reload();
            }}
          >
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={t('Confluence·Figma 주소 붙여넣기 (https://…)')}
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <button className="btn" disabled={!link.trim() || mine}>
              {t('넣기')}
            </button>
          </form>
        </div>
      </div>

      {pending.map((p) => (
        <TcColumnPicker
          key={p.source}
          planId={plan.id}
          source={p.source}
          title={p.title}
          tables={p.tables}
          onDone={async () => {
            setPending((x) => x.filter((y) => y.source !== p.source));
            await reload();
          }}
        />
      ))}

      <div className="card">
        <h5>{t('TC 뽑기')}</h5>
        {plan.sources.some((s) => s.kind === 'confluence' || s.kind === 'figma') && (
          <p className="faint" style={{ marginTop: 0 }}>
            {t('링크는 Claude Code 의 Confluence·Figma 커넥터로 읽습니다. 없으면 PDF 로 넣으세요.')}
          </p>
        )}
        {plan.cases.some((c) => c.track === 'tc') && (
          <p className="faint" style={{ marginTop: 0 }}>
            {t('TC 표는 이미 원문 그대로 들어왔어요. TC 뽑기는 요구사항을 잇고, TC 표가 덮지 못한 것만 추가 제안으로 냅니다.')}
          </p>
        )}
        <textarea
          className="input"
          rows={2}
          style={{ width: '100%', resize: 'vertical' }}
          placeholder={t('추가 요청 (선택) — 예: 로그인 절만, 경계 TC 는 빼고')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        <div className="qa-row" style={{ marginTop: 8 }}>
          {mine ? (
            <button className="btn danger" onClick={() => run(api.qaStop())}>
              {t('■ 멈추기')}
            </button>
          ) : (
            <button
              className={`btn ${plan.cases.length ? '' : 'primary'}`}
              disabled={busy || !plan.sources.length}
              onClick={() => run(api.qaExtract(plan.id, note))}
              title={t('이 컴퓨터의 Claude Code 로 요구사항과 TC 를 뽑습니다. 기기는 건드리지 않습니다')}
            >
              {plan.cases.length ? t('다시 뽑기') : t('TC 뽑기')}
            </button>
          )}
          {mine && <span className="qa-live">{t('뽑는 중… 저장할 때마다 검토 단계에 바로 보입니다')}</span>}
          {!mine && lastHere && !lastHere.error && !lastHere.cancelled && (
            <span className="v-pass">
              {t('다 뽑았습니다: 요구사항 {r}개 · TC {c}개', { r: plan.requirements.length, c: plan.cases.length })}
            </span>
          )}
          {!mine && lastHere?.cancelled && <span className="v-blocked">{t('멈췄습니다. 저장된 데까지는 남아 있습니다')}</span>}
          <div className="spacer" />
          {plan.cases.length > 0 && (
            <button className="btn primary" onClick={onNext}>
              {t('다음: TC 검토 →')}
            </button>
          )}
        </div>
        {(mine || lastHere) && <QaLog lines={qa.log} />}
      </div>
    </div>
  );
}

const TC_PICK_FIELDS = [
  ['title', '제목'],
  ['steps', '단계'],
  ['expected', '기대 결과'],
  ['id', '번호'],
  ['preconditions', '사전 조건'],
  ['priority', '우선순위'],
  ['notes', '비고'],
] as const;

/** 머리글을 못 알아본 표에서 사람이 열을 골라 TC 로 가져온다 (#129) */
function TcColumnPicker({
  planId,
  source,
  title,
  tables,
  onDone,
}: {
  planId: string;
  source: string;
  title: string;
  tables: NonNullable<QaSourceAdded['tcTables']>;
  onDone: () => Promise<void>;
}) {
  const { run, toast } = useApp();
  const t = useT();
  const [at, setAt] = useState(0);
  const table = tables[at];
  const [map, setMap] = useState<Record<string, number | undefined>>({});
  const ready = map.title !== undefined || map.steps !== undefined;
  return (
    <div className="card">
      <h5>{t('TC 표 열 고르기')}</h5>
      <p className="faint" style={{ marginTop: 0 }}>
        {t('{name} 의 머리글을 알아보지 못했어요. TC 표라면 칸마다 맞는 열을 골라 주세요. 고른 열의 글은 바꾸지 않고 그대로 가져옵니다.', { name: title })}
      </p>
      {tables.length > 1 && (
        <label className="chk" style={{ marginBottom: 8 }}>
          {t('시트')}
          <select className="input" value={at} onChange={(e) => (setAt(Number(e.target.value)), setMap({}))}>
            {tables.map((x, i) => (
              <option key={i} value={i}>
                {x.sheet || t('(CSV)')}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="qa-colpick">
        {TC_PICK_FIELDS.map(([f, label]) => (
          <label key={f} className="chk">
            <span className="qa-colpick-k">{t(label)}</span>
            <select
              className="input"
              value={map[f] ?? ''}
              onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value === '' ? undefined : Number(e.target.value) }))}
            >
              <option value="">{t('(없음)')}</option>
              {table.headers.map((h, i) => (
                <option key={i} value={i}>
                  {h.trim() || t('{n}열', { n: i + 1 })}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="qa-row" style={{ marginTop: 10 }}>
        <button
          className="btn primary"
          disabled={!ready}
          onClick={async () => {
            const clean = Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined)) as Record<string, number>;
            const r = await run(api.qaTcImport(planId, source, { sheet: table.sheet, headerRow: table.headerRow, map: clean }));
            if (!r) return;
            toast(t('TC {n}개를 원문 그대로 가져왔어요', { n: r.cases }));
            for (const w of r.warnings) toast(`⚠ ${w}`, true);
            await onDone();
          }}
        >
          {t('이 열로 TC 가져오기')}
        </button>
        <button className="btn" onClick={() => onDone()}>
          {t('TC 표가 아니에요')}
        </button>
        {!ready && <span className="faint">{t('제목이나 단계 열은 꼭 골라 주세요')}</span>}
      </div>
    </div>
  );
}

/** 에이전트·스크립트 진행 기록 (아래로 붙어 따라간다) */
function QaLog({ lines: all, onlyCase }: { lines: QaLogLine[]; onlyCase?: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const shown = onlyCase ? all.filter((l) => l.case === onlyCase) : all;
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  if (!shown.length) return null;
  return (
    <div className="qa-log" ref={box}>
      {shown.map((l) => (
        <div
          key={l.id}
          className={`qa-log-${l.kind} ${l.status ? `v-${l.status === 'pass' ? 'pass' : l.status === 'fail' ? 'fail' : 'blocked'}` : ''}`}
        >
          {l.kind === 'case' ? (
            <b>▸ {l.text}</b>
          ) : l.kind === 'tool' ? (
            <span className="mono">🔧 {l.text}</span>
          ) : l.kind === 'step' ? (
            <span>
              {l.status === 'pass' ? '✓' : l.status === 'fail' ? '✗' : '–'} {l.text}
            </span>
          ) : l.kind === 'error' ? (
            <span className="error">
              {t('오류')}: {t(l.text)}
              <AuthHelp text={l.text} />
            </span>
          ) : (
            <span className="qa-text">{l.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- 2. 검토 ----------

function ReviewStep({ view, setView, onNext }: { view: QaPlanView; setView: (v: QaPlanView) => void; onNext: () => void }) {
  const { run } = useApp();
  const t = useT();
  const qa = useQaState();
  const { plan, coverage, review } = view;
  const [open, setOpen] = useState<string | null>(initial.get('case'));
  const [kind, setKind] = useState<'all' | QaCase['kind']>('all');
  const locked = qa.job?.plan === plan.id;
  const apply = async (p: Promise<unknown>) => {
    if ((await run(p)) === undefined) return;
    setView(await api.qaPlanGet(plan.id));
  };
  const cases = plan.cases.filter((c) => (kind === 'all' || c.kind === kind) && !c.suggested);
  const suggested = plan.cases.filter((c) => (kind === 'all' || c.kind === kind) && c.suggested);
  const selectable = cases.filter((c) => !c.danger).map((c) => c.id);
  const selected = plan.cases.filter((c) => c.selected).length;
  // 갈래별로 묶는다. 갈래가 하나뿐이면 묶음 머리를 그리지 않는다 (예전 계획은 지금처럼 보인다)
  const groups = TRACKS.map((tr) => ({ track: tr, cases: cases.filter((c) => trackOf(c) === tr) })).filter((g) => g.cases.length);
  const grouped = groups.length > 1 || groups.some((g) => g.track === 'tc');
  const accept = (ids: string[]) =>
    apply(
      (async () => {
        let last: unknown;
        for (const id of ids) {
          const c = plan.cases.find((x) => x.id === id);
          last = await api.qaCaseUpdate(plan.id, id, { suggested: false, selected: !c?.danger });
        }
        return last;
      })(),
    );
  const row = (c: QaCase, suggest = false) => (
    <CaseRow
      key={c.id}
      c={c}
      open={open === c.id}
      locked={locked}
      onToggle={() => setOpen(open === c.id ? null : c.id)}
      onSelect={(on) => apply(api.qaCaseUpdate(plan.id, c.id, { selected: on }))}
      onAccept={suggest ? () => accept([c.id]) : undefined}
      onSave={(patch) => apply(api.qaCaseUpdate(plan.id, c.id, patch))}
      onAllow={(allow) => apply(api.qaCaseAllow(plan.id, c.id, allow, allow ? c : undefined))}
    />
  );
  const caseHead = (suggest = false) => (
    <thead>
      <tr>
        <th style={{ width: suggest ? 56 : 28 }} />
        <th style={{ width: 70 }}>{t('번호')}</th>
        <th style={{ width: 54 }}>{t('종류')}</th>
        <th style={{ width: 40 }}>{t('우선')}</th>
        <th>{t('제목')}</th>
        <th style={{ width: 110 }}>{t('요구사항')}</th>
        <th style={{ width: 150 }}>{t('표시')}</th>
      </tr>
    </thead>
  );

  if (!plan.cases.length)
    return (
      <div className="empty">
        {t('아직 TC 가 없습니다.')}
        <br />
        {t('문서 단계에서 TC 를 뽑으세요.')}
      </div>
    );

  return (
    <div className="qa-scroll">
      {locked && <div className="qa-banner">{t('이 계획으로 작업이 돌고 있어 고치기를 잠갔습니다.')}</div>}
      {(review.length > 0 || coverage.uncovered.length > 0 || coverage.unselected.length > 0 || coverage.missingKinds.length > 0 || suggested.length > 0) && (
        <section className="rv-attn">
          <b>{t('확인할 것')}</b>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {review.map((r) => (
              <li key={r.id}>
                <button className="rv-link" onClick={() => setOpen(r.id)}>
                  {r.id} {r.title}
                </button>{' '}
                — {r.reasons.map((x) => t(REVIEW_LABEL[x])).join(' / ')}
              </li>
            ))}
            {suggested.length > 0 && (
              <li>
                <button className="rv-link" onClick={() => document.getElementById('qa-suggest')?.scrollIntoView({ block: 'start' })}>
                  {t('추가 제안 {n}개', { n: suggested.length })}
                </button>{' '}
                — {t('TC 문서에 없는 TC 예요. 넣을 것만 골라 주세요')}
              </li>
            )}
            {coverage.uncovered.length > 0 && <li>{t('TC 가 없는 요구사항: {ids}', { ids: coverage.uncovered.join(', ') })}</li>}
            {coverage.unselected.length > 0 && <li>{t('고른 TC 가 없는 요구사항: {ids}', { ids: coverage.unselected.join(', ') })}</li>}
            {coverage.missingKinds.length > 0 && (
              <li>
                {t('정상·예외 TC 가 빠진 요구사항: {ids}', {
                  ids: coverage.missingKinds.map((m) => `${m.id}(${m.missing.map((k) => t(KIND_LABEL[k])).join('·')})`).join(', '),
                })}
              </li>
            )}
          </ul>
        </section>
      )}

      <details className="card" open={plan.requirements.length <= 30}>
        <summary>
          <b>{t('추적표 — 요구사항 {n}개', { n: plan.requirements.length })}</b>
        </summary>
        <table className="qa-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ width: 60 }}>{t('번호')}</th>
              <th>{t('요구사항')}</th>
              <th style={{ width: 220 }}>{t('덮는 TC (굵게: 고름)')}</th>
            </tr>
          </thead>
          <tbody>
            {coverage.rows.map((r) => (
              <tr key={r.requirement.id} className={r.cases.length === 0 ? 'qa-bad' : r.selected.length === 0 ? 'qa-warn' : ''}>
                <td className="mono">{r.requirement.id}</td>
                <td className="qa-wrap">
                  {r.requirement.text}
                  {r.requirement.source && (
                    <span className="faint" title={sourceTitle(plan, r.requirement.source.source)}>
                      {' '}
                      ({sourceLabel(t, r.requirement.source.source)}
                      {r.requirement.source.locator ? ` · ${r.requirement.source.locator}` : ''})
                    </span>
                  )}
                </td>
                <td className="mono">
                  {r.cases.length === 0
                    ? t('없음')
                    : r.cases.map((id, i) => (
                        <span key={id}>
                          {i > 0 && ', '}
                          <button className={`qa-idlink ${r.selected.includes(id) ? 'on' : ''}`} onClick={() => setOpen(id)}>
                            {id}
                          </button>
                        </span>
                      ))}
                  {grouped && r.tracks?.length > 0 && (
                    <div className="faint qa-sans">{r.tracks.map((x) => t(TRACK_LABEL[x])).join(', ')}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="card">
        <div className="qa-row">
          <b>{t('TC {n}개 · 고름 {k}개', { n: plan.cases.length, k: selected })}</b>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">{t('모든 종류')}</option>
            {(Object.keys(KIND_LABEL) as QaCase['kind'][]).map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
          <div className="spacer" />
          <button
            className="btn sm"
            disabled={locked || !selectable.length}
            onClick={() => apply(api.qaSelect(plan.id, selectable, true))}
            title={t('확인 필수 TC 는 하나씩 고릅니다')}
          >
            {t('모두 고르기')}
          </button>
          <button
            className="btn sm"
            disabled={locked}
            onClick={() =>
              apply(
                api.qaSelect(
                  plan.id,
                  cases.map((c) => c.id),
                  false,
                ),
              )
            }
          >
            {t('모두 빼기')}
          </button>
        </div>
        <table className="qa-table qa-cases" style={{ marginTop: 8 }}>
          {caseHead()}
          {grouped ? (
            groups.map((g) => {
              const on = g.cases.filter((c) => c.selected).length;
              const pick = g.cases.filter((c) => !c.danger).map((c) => c.id);
              return (
                <tbody key={g.track}>
                  <tr className="qa-group">
                    <td colSpan={7}>
                      <div className="qa-row">
                        <b>{t(TRACK_LABEL[g.track])}</b>
                        <span className="faint">
                          {t('{n}개 · 고름 {k}개', { n: g.cases.length, k: on })} ({t(TRACK_HINT[g.track])})
                        </span>
                        <div className="spacer" />
                        <button className="btn sm" disabled={locked || !pick.length} onClick={() => apply(api.qaSelect(plan.id, pick, true))}>
                          {t('이 갈래 고르기')}
                        </button>
                        <button
                          className="btn sm"
                          disabled={locked || !on}
                          onClick={() =>
                            apply(
                              api.qaSelect(
                                plan.id,
                                g.cases.map((c) => c.id),
                                false,
                              ),
                            )
                          }
                        >
                          {t('이 갈래 빼기')}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {g.cases.map((c) => row(c))}
                </tbody>
              );
            })
          ) : (
            <tbody>{cases.map((c) => row(c))}</tbody>
          )}
        </table>
      </div>
      {suggested.length > 0 && (
        <div className="card qa-suggest" id="qa-suggest">
          <div className="qa-row">
            <b>{t('추가 제안 {n}개', { n: suggested.length })}</b>
            <div className="spacer" />
            <button className="btn sm" disabled={locked} onClick={() => accept(suggested.map((c) => c.id))}>
              {t('모두 넣기')}
            </button>
          </div>
          <p className="faint" style={{ margin: '4px 0 0' }}>
            {t('TC 문서가 덮지 못한 요구사항에 에이전트가 더 제안한 TC 예요. 넣기 전까지는 실행하지 않습니다.')}
          </p>
          <table className="qa-table qa-cases" style={{ marginTop: 8 }}>
            {caseHead(true)}
            <tbody>{suggested.map((c) => row(c, true))}</tbody>
          </table>
        </div>
      )}
      <div className="qa-row">
        <div className="spacer" />
        <button className="btn primary" disabled={!selected} onClick={onNext}>
          {t('다음: 실행 →')}
        </button>
      </div>
    </div>
  );
}

function CaseRow({
  c,
  open,
  locked,
  onToggle,
  onSelect,
  onAccept,
  onSave,
  onAllow,
}: {
  c: QaCase;
  open: boolean;
  locked: boolean;
  onToggle: () => void;
  onSelect: (on: boolean) => void;
  /** 추가 제안이면 체크 상자 대신 "넣기" (#129) */
  onAccept?: () => void;
  onSave: (patch: Partial<QaCase>) => void;
  onAllow: (allow: boolean) => void;
}) {
  const t = useT();
  return (
    <>
      <tr className={`qa-case ${open ? 'open' : ''} ${c.review?.length ? 'qa-warn' : ''}`} onClick={onToggle}>
        <td onClick={(e) => e.stopPropagation()}>
          {onAccept ? (
            <button className="btn sm" disabled={locked} onClick={onAccept} title={t('{id} 를 계획에 넣고 고릅니다', { id: c.id })}>
              {t('넣기')}
            </button>
          ) : (
            <input
              type="checkbox"
              checked={!!c.selected}
              disabled={locked}
              onChange={(e) => onSelect(e.target.checked)}
              aria-label={t('{id} 고르기', { id: c.id })}
            />
          )}
        </td>
        <td className="mono">{c.id}</td>
        <td>{t(KIND_LABEL[c.kind])}</td>
        <td className="mono">{c.priority}</td>
        <td className="qa-wrap">{c.title}</td>
        <td className="mono faint qa-wrap">{c.requirements.join(', ')}</td>
        <td>
          <div className="qa-marks">
            {c.danger && (
              <span className={`rv-chip ${c.allowDanger ? 'fail' : 'warn'}`}>{c.allowDanger ? t('확인 필수 · 허용') : t('확인 필수')}</span>
            )}
            {c.review?.length ? <span className="rv-chip warn">{t('다시 보기')}</span> : null}
            {c.script && <span className="rv-chip pass">{t('스크립트')}</span>}
            {c.automatable !== 'yes' && <span className="rv-chip mute">{t(AUTO_LABEL[c.automatable])}</span>}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="qa-detail">
          <td colSpan={7}>
            <CaseEditor key={JSON.stringify(c)} c={c} locked={locked} onSave={onSave} onAllow={onAllow} />
          </td>
        </tr>
      )}
    </>
  );
}

function CaseEditor({
  c,
  locked,
  onSave,
  onAllow,
}: {
  c: QaCase;
  locked: boolean;
  onSave: (patch: Partial<QaCase>) => void;
  onAllow: (allow: boolean) => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(c.title);
  const [priority, setPriority] = useState(c.priority);
  const [pre, setPre] = useState(c.preconditions.join('\n'));
  const [steps, setSteps] = useState(c.steps.join('\n'));
  const [expected, setExpected] = useState(c.expected.join('\n'));
  const [data, setData] = useState(c.data ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [asking, setAsking] = useState(false);
  const patch: Partial<QaCase> = {
    title: title.trim(),
    priority,
    preconditions: lines(pre),
    steps: lines(steps),
    expected: lines(expected),
    data: data.trim() || undefined,
    notes: notes.trim() || undefined,
  };
  const dirty =
    patch.title !== c.title ||
    patch.priority !== c.priority ||
    JSON.stringify([patch.preconditions, patch.steps, patch.expected]) !== JSON.stringify([c.preconditions, c.steps, c.expected]) ||
    (patch.data ?? '') !== (c.data ?? '') ||
    (patch.notes ?? '') !== (c.notes ?? '');
  const list = (xs: string[]) => (
    <ol className="qa-ol">
      {xs.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ol>
  );
  return (
    <div className="qa-editor">
      <div className="qa-grid">
        <label>{t('제목')}</label>
        <input className="input" value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
        <label>{t('우선순위')}</label>
        <select
          className="input"
          style={{ width: 90 }}
          value={priority}
          disabled={locked}
          onChange={(e) => setPriority(e.target.value as QaCase['priority'])}
        >
          {['P0', 'P1', 'P2'].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label>{t('사전 조건')}</label>
        <textarea
          className="input"
          rows={Math.max(1, c.preconditions.length)}
          value={pre}
          disabled={locked}
          onChange={(e) => setPre(e.target.value)}
          placeholder={t('한 줄에 하나')}
        />
        <label>{t('단계')}</label>
        <textarea
          className="input"
          rows={Math.max(2, c.steps.length)}
          value={steps}
          disabled={locked}
          onChange={(e) => setSteps(e.target.value)}
          placeholder={t('한 줄에 하나')}
        />
        <label>{t('기대 결과')}</label>
        <textarea
          className="input"
          rows={Math.max(1, c.expected.length)}
          value={expected}
          disabled={locked}
          onChange={(e) => setExpected(e.target.value)}
          placeholder={t('한 줄에 하나')}
        />
        <label>{t('입력값')}</label>
        <input
          className="input"
          value={data}
          disabled={locked}
          onChange={(e) => setData(e.target.value)}
          placeholder={t('계정·검색어 등 (결과표·CSV 에서는 가려집니다)')}
        />
        <label>{t('메모')}</label>
        <input className="input" value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} />
        {c.source && (
          <>
            <label>{t('근거')}</label>
            <span className="faint">
              {sourceLabel(t, c.source.source)}
              {c.source.locator ? ` · ${c.source.locator}` : ''}
              {c.source.quote ? ` — "${c.source.quote}"` : ''}
            </span>
          </>
        )}
        {c.design && (
          <>
            <label>{t('Figma')}</label>
            <span className="mono qa-wrap">{c.design.figma}</span>
          </>
        )}
        {c.script && (
          <>
            <label>{t('스크립트')}</label>
            <span className="mono">{c.script}</span>
          </>
        )}
      </div>
      <div className="qa-row" style={{ marginTop: 8 }}>
        <button
          className="btn sm primary"
          disabled={locked || !dirty || !patch.title || !patch.steps?.length || !patch.expected?.length}
          onClick={() => onSave(patch)}
        >
          {t('저장')}
        </button>
        {dirty && (
          <span className="faint">{c.danger && c.allowDanger ? t('실행 내용을 고치면 허용이 풀립니다') : t('고친 내용이 있습니다')}</span>
        )}
      </div>
      {c.danger && (
        <div className="qa-danger">
          <div>
            <b>{t('확인 필수 동작')}</b> {c.danger}
          </div>
          {c.allowDanger ? (
            <div className="qa-row">
              <span className="error">{t('실행할 때 이 동작을 실제로 누릅니다.')}</span>
              <button className="btn sm" disabled={locked} onClick={() => onAllow(false)}>
                {t('허용 거두기')}
              </button>
            </div>
          ) : asking ? (
            <div className="qa-ask">
              <b>{t('아래 내용대로 실행하면서 확인 필수 동작을 실제로 누르도록 허용할까요?')}</b>
              {c.preconditions.length > 0 && (
                <div>
                  {t('사전 조건')}
                  {list(c.preconditions)}
                </div>
              )}
              <div>
                {t('단계')}
                {list(c.steps)}
              </div>
              <div>
                {t('기대 결과')}
                {list(c.expected)}
              </div>
              {c.data && (
                <div>
                  {t('입력값')}: {c.data}
                </div>
              )}
              <div className="qa-row">
                <button
                  className="btn sm danger"
                  onClick={() => {
                    setAsking(false);
                    onAllow(true);
                  }}
                >
                  {t('허용')}
                </button>
                <button className="btn sm" onClick={() => setAsking(false)}>
                  {t('취소')}
                </button>
              </div>
            </div>
          ) : (
            <div className="qa-row">
              <span className="faint">{t('허용하지 않으면 그 동작 직전까지 확인하고 막힘으로 끝납니다.')}</span>
              <button
                className="btn sm"
                disabled={locked || dirty}
                onClick={() => setAsking(true)}
                title={dirty ? t('고친 내용을 먼저 저장하세요') : undefined}
              >
                {t('실제로 누르기 허용…')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 3. 실행·결과 ----------

function RunStep({ view }: { view: QaPlanView }) {
  const { run, serial, devices, toast } = useApp();
  const t = useT();
  const qa = useQaState();
  const { plan } = view;
  const [runId, setRunId] = useState<string | null>(view.runs[0] ?? null);
  const [result, setResult] = useState<QaRunView | null>(null);
  const [recheck, setRecheck] = useState(false);
  const [append, setAppend] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [asking, setAsking] = useState(false);
  // 회차를 돌릴 기기. 고르지 않았거나 고른 기기가 빠지면 맨 위 막대의 기기를 쓴다 (#99)
  const online = devices.filter((d) => d.state === 'device');
  const [picked, setPicked] = useState<string | null>(null);
  const target = [picked, serial].find((s) => s && online.some((d) => d.serial === s)) ?? online[0]?.serial ?? null;
  const mine = qa.job?.plan === plan.id && qa.job.kind === 'run';
  const busy = qa.job !== null;

  // 실행이 회차를 열면 그 회차를 보여 준다
  useEffect(() => {
    if (qa.run?.plan === plan.id) setRunId(qa.run.id);
  }, [qa.run, plan.id]);
  useEffect(() => {
    if (!runId && view.runs[0]) setRunId(view.runs[0]);
  }, [view.runs, runId]);
  useEffect(() => {
    if (!runId) return setResult(null);
    let alive = true;
    api
      .qaRunGet(plan.id, runId)
      .then((r) => alive && setResult(r))
      .catch(() => alive && setResult(null));
    return () => {
      alive = false;
    };
  }, [plan.id, runId, qa.tick]);

  const sel = plan.cases.filter((c) => c.selected);
  const needsReview = sel.filter((c) => c.review?.length);
  const ready = sel.filter((c) => !c.review?.length);
  const scripted = ready.filter((c) => c.script);
  const manual = ready.filter((c) => !c.script && c.automatable === 'manual');
  const agent = ready.filter((c) => !c.script && c.automatable !== 'manual');
  const armed = ready.filter((c) => c.danger && c.allowDanger);
  const selTracks = TRACKS.map((tr) => [tr, sel.filter((c) => trackOf(c) === tr).length] as const).filter(([, n]) => n);

  const start = async () => {
    setAsking(false);
    if (!target) return;
    await run(
      api.qaRun(plan.id, { serial: target, run: append && runId ? runId : undefined, recheckFailed: recheck, timeoutMs: minutes * 60_000 }),
    );
  };

  return (
    <div className="qa-scroll">
      <div className="card">
        <h5>{t('회차 실행')}</h5>
        <div className="qa-tally">
          <span className="rv-chip info">
            {t('고름')} <b>{sel.length}</b>
          </span>
          <span className="rv-chip pass">
            {t('스크립트로')} <b>{scripted.length}</b>
          </span>
          <span className="rv-chip info">
            {t('에이전트로')} <b>{agent.length}</b>
          </span>
          {manual.length > 0 && (
            <span className="rv-chip mute">
              {t('수동(건너뜀으로 적음)')} <b>{manual.length}</b>
            </span>
          )}
          {needsReview.length > 0 && (
            <span className="rv-chip warn">
              {t('다시 보기(막힘으로 적음)')} <b>{needsReview.length}</b>
            </span>
          )}
          {armed.length > 0 && (
            <span className="rv-chip fail">
              {t('실제로 누름')} <b>{armed.length}</b>
            </span>
          )}
        </div>
        {(selTracks.length > 1 || selTracks.some(([tr]) => tr === 'tc')) && (
          <div className="faint" style={{ marginTop: 6 }}>
            {t('갈래')}: {selTracks.map(([tr, n]) => `${t(TRACK_LABEL[tr])} ${n}`).join(', ')}
          </div>
        )}
        <div className="qa-row" style={{ marginTop: 10 }}>
          <label className="chk">
            <input type="checkbox" checked={recheck} disabled={busy} onChange={(e) => setRecheck(e.target.checked)} />
            {t('스크립트가 실패한 TC 는 에이전트로 다시 확인')}
          </label>
          <label className="chk">
            {t('TC 시간 제한')}
            <select className="input" value={minutes} disabled={busy} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[5, 10, 20, 30].map((m) => (
                <option key={m} value={m}>
                  {t('{n}분', { n: m })}
                </option>
              ))}
            </select>
          </label>
          {runId && (
            <label className="chk" title={t('새 회차를 만들지 않고 고른 회차에 결과를 덧붙입니다')}>
              <input type="checkbox" checked={append} disabled={busy} onChange={(e) => setAppend(e.target.checked)} />
              {t('회차 {id} 에 이어서 적기', { id: runId })}
            </label>
          )}
        </div>
        <div className="qa-row" style={{ marginTop: 10 }}>
          {online.length > 0 && (
            <label className="chk">
              {t('기기')}
              <select className="input" value={target ?? ''} disabled={busy} onChange={(e) => setPicked(e.target.value)}>
                {online.map((d) => (
                  <option key={d.serial} value={d.serial}>
                    {d.model ? `${d.model} (${d.serial})` : d.serial}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mine ? (
            <button className="btn danger" onClick={() => run(api.qaStop())}>
              {t('■ 멈추기')}
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={busy || !target || !sel.length}
              onClick={() => (armed.length ? setAsking(true) : start())}
              title={t('스크립트가 있는 TC 는 바로, 나머지는 TC 마다 에이전트로 돌립니다. 통과하면 스크립트로 저장됩니다')}
            >
              {t('▶ 실행')}
            </button>
          )}
          {!target && <span className="v-blocked">{t('기기를 연결하세요')}</span>}
          {!sel.length && <span className="v-blocked">{t('검토 단계에서 실행할 TC 를 고르세요')}</span>}
          {mine && qa.current && (
            <span className="qa-live">
              {t('{id} 실행 중 · {mode} · {i}/{n}', {
                id: qa.current.case,
                mode: t(MODE_LABEL[qa.current.mode]),
                i: qa.current.index + 1,
                n: qa.current.total,
              })}
            </span>
          )}
        </div>
        {asking && (
          <div className="qa-ask" style={{ marginTop: 10 }}>
            <b>{t('허용한 확인 필수 TC {n}개는 실행 중에 그 동작을 실제로 누릅니다.', { n: armed.length })}</b>
            <ul className="qa-ol">
              {armed.map((c) => (
                <li key={c.id}>
                  {c.id} {c.title} — {c.danger}
                </li>
              ))}
            </ul>
            <div className="qa-row">
              <button className="btn sm danger" onClick={start}>
                {t('실행')}
              </button>
              <button className="btn sm" onClick={() => setAsking(false)}>
                {t('취소')}
              </button>
            </div>
          </div>
        )}
        {qa.confirms.length > 0 && (
          <div className="qa-confirms">
            {qa.confirms.map((c) => (
              <ConfirmBox key={c.id} c={c} />
            ))}
          </div>
        )}
        {(mine || (qa.last?.plan === plan.id && qa.last.job === 'run')) && <QaLog lines={qa.log} />}
        {!mine && qa.last?.plan === plan.id && qa.last.job === 'run' && qa.last.cancelled && (
          <div className="v-blocked" style={{ marginTop: 6 }}>
            {t('멈췄습니다. 돌리지 못한 TC 는 "안 돌림" 으로 남습니다.')}
          </div>
        )}
      </div>

      <div className="card">
        <div className="qa-row">
          <h5 style={{ margin: 0 }}>{t('결과')}</h5>
          {view.runs.length > 0 && (
            <select className="input" value={runId ?? ''} onChange={(e) => setRunId(e.target.value)}>
              {view.runs.map((id) => (
                <option key={id} value={id}>
                  {t('회차 {id}', { id })}
                </option>
              ))}
            </select>
          )}
          <div className="spacer" />
          {result && (
            <>
              <button
                className="btn sm"
                onClick={async () => {
                  const f = await run(api.qaReport(plan.id, result.run.id));
                  if (!f) return;
                  setResult(await api.qaRunGet(plan.id, result.run.id));
                  await run(api.openPath(f.html));
                }}
              >
                {t('결과표 열기 (HTML)')}
              </button>
              <button
                className="btn sm"
                disabled={!result.files}
                onClick={() => result.files && run(api.reveal(result.files.csv))}
                title={t('CSV(엑셀)·JUnit XML 이 있는 폴더')}
              >
                {t('CSV·JUnit 폴더')}
              </button>
            </>
          )}
        </div>
        {!result ? (
          <div className="empty" style={{ height: 'auto', padding: 24 }}>
            {view.runs.length ? t('불러오는 중…') : t('아직 돌린 회차가 없습니다.')}
          </div>
        ) : (
          <RunResult
            view={view}
            result={result}
            // 보고 있는 회차가 지금 도는 회차일 때만 진행 중인 TC 를 표에 표시한다 (#97)
            running={mine && qa.run?.plan === plan.id && qa.run.id === result.run.id ? qa.current : null}
            onOpen={(p) => run(api.openPath(p)).then((r) => r && toast(r, true))}
          />
        )}
      </div>
    </div>
  );
}

function ConfirmBox({ c }: { c: { id: string; what: string; case?: string; timeoutMs: number; at: number } }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((c.at + c.timeoutMs - now) / 1000));
  return (
    <div className="chat-ask" style={{ margin: '10px 0 0' }}>
      <div className="chat-ask-title">
        {c.case ? `${c.case} · ` : ''}
        {t('되돌릴 수 없는 조작을 하려고 합니다')}
      </div>
      <div className="chat-ask-what">{c.what}</div>
      <div className="chat-ask-actions">
        <button className="btn sm danger" onClick={() => answerQaConfirm(c.id, true)}>
          {t('승인')}
        </button>
        <button className="btn sm" onClick={() => answerQaConfirm(c.id, false)}>
          {t('거부')}
        </button>
        <span className="faint">{t('{n}초 뒤 자동 거부', { n: left })}</span>
      </div>
    </div>
  );
}

function RunResult({
  view,
  result,
  running,
  onOpen,
}: {
  view: QaPlanView;
  result: QaRunView;
  /** 이 회차에서 지금 돌고 있는 TC (없으면 null) */
  running: QaState['current'];
  onOpen: (path: string) => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  const { openTab } = useApp();
  const { summary } = result;
  const c = summary.counts;
  const reqs = summary.requirements;
  const [onlyBad, setOnlyBad] = useState(false);
  const [track, setTrack] = useState<'all' | Track>('all');
  // 갈래별 개수 (#129). 옛 회차 요약(byTrack 없음)은 갈래를 그리지 않는다
  const byTrack = TRACKS.filter((tr) => summary.byTrack?.[tr]).map((tr) => [tr, summary.byTrack![tr]!] as const);
  const multi = byTrack.length > 1 || byTrack.some(([tr]) => tr === 'tc');
  const rows = useMemo(
    () =>
      summary.rows.filter(
        (r) =>
          (track === 'all' || trackOf(r.case) === track) &&
          (!onlyBad || r.status === 'fail' || r.status === 'blocked' || r.case.id === running?.case),
      ),
    [summary.rows, onlyBad, track, running?.case],
  );
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
      <div className="qa-tally">
        {(['pass', 'fail', 'blocked', 'skip', 'not-run'] as const).map((s) => (
          <span key={s} className={`rv-chip ${STATUS_TONE[s]}`}>
            {t(STATUS_LABEL[s])} <b>{c[s]}</b>
          </span>
        ))}
        <span className="faint">
          {t('시작 {time}', { time: shortTime(result.run.startedAt) })} ·{' '}
          {t('요구사항 {n}개 중 통과 {p}', { n: reqs.length, p: reqs.filter((r) => r.status === 'pass').length })}
        </span>
      </div>
      {multi && (
        <div className="qa-tracks">
          {byTrack.map(([tr, b]) => (
            <button
              key={tr}
              className={`qa-track ${track === tr ? 'on' : ''}`}
              onClick={() => setTrack(track === tr ? 'all' : tr)}
              title={t('이 갈래만 보기')}
            >
              <b>{t(TRACK_LABEL[tr])}</b>
              <span>{t('통과 {p}/{n}', { p: b.pass, n: b.total })}</span>
              {b.fail + b.blocked > 0 && <span className="v-fail">{t('실패·막힘 {n}', { n: b.fail + b.blocked })}</span>}
              {b['not-run'] > 0 && <span className="faint">{t('안 돌림 {n}', { n: b['not-run'] })}</span>}
            </button>
          ))}
        </div>
      )}
      {reqs.length > 0 && (
        <details>
          <summary className="muted">{t('요구사항별 결과')}</summary>
          <table className="qa-table" style={{ marginTop: 6 }}>
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ width: 60 }}>
                    {r.id}
                  </td>
                  <td className="qa-wrap">{r.text}</td>
                  <td style={{ width: 80 }}>
                    <span className={`rv-chip ${r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'mute'}`}>
                      {t(STATUS_LABEL[r.status])}
                    </span>
                  </td>
                  <td className="mono faint" style={{ width: 160 }}>
                    {r.cases.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="qa-row">
        <b>{t('TC 별 결과')}</b>
        {multi && (
          <select className="input" value={track} onChange={(e) => setTrack(e.target.value as typeof track)}>
            <option value="all">{t('모든 갈래')}</option>
            {byTrack.map(([tr]) => (
              <option key={tr} value={tr}>
                {t(TRACK_LABEL[tr])}
              </option>
            ))}
          </select>
        )}
        <div className="spacer" />
        <label className="chk">
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />
          {t('실패·막힘만')}
        </label>
      </div>
      <table className="qa-table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>{t('번호')}</th>
            {multi && <th style={{ width: 96 }}>{t('갈래')}</th>}
            <th style={{ width: '24%' }}>{t('제목')}</th>
            <th style={{ width: 70 }}>{t('결과')}</th>
            <th style={{ width: 80 }}>{t('방식')}</th>
            <th>{t('메모')}</th>
            <th style={{ width: 120 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = result.design[r.case.id];
            const live = running?.case === r.case.id ? running : null;
            return (
              <tr key={r.case.id} className={live ? 'qa-now' : undefined}>
                <td className="mono">{r.case.id}</td>
                {multi && <td className="faint">{t(TRACK_LABEL[trackOf(r.case)])}</td>}
                <td className="qa-wrap">{r.case.title}</td>
                <td>
                  {live ? (
                    <span className="rv-chip info">{t('진행 중')}</span>
                  ) : (
                    <span className={`rv-chip ${STATUS_TONE[r.status]}`}>{t(STATUS_LABEL[r.status])}</span>
                  )}
                </td>
                <td className="faint">
                  {live ? t(MODE_LABEL[live.mode]) : r.result ? t(MODE_LABEL[r.result.mode]) : ''}
                  {r.result?.history?.length ? (
                    <div title={r.result.history.map((h) => `${t(STATUS_LABEL[h.status])}(${t(MODE_LABEL[h.mode])})`).join(' → ')}>
                      {t('재실행 {n}', { n: r.result.history.length })}
                    </div>
                  ) : null}
                </td>
                <td className="qa-wrap faint">
                  {qaResultMemo(r.result, lang)}
                  {d && (
                    <div>{t('디자인 차이 {n}건 (높음 {h})', { n: d.counts.high + d.counts.medium + d.counts.low, h: d.counts.high })}</div>
                  )}
                </td>
                <td>
                  <div className="qa-marks">
                    {r.result?.report && (
                      <button
                        className="btn sm"
                        title={t('검증 기록 탭에서 이 TC 의 단계별 기록을 엽니다')}
                        onClick={() => {
                          requestScenario(r.result!.report!.split(/[\\/]/).slice(-2)[0]);
                          openTab('scen');
                        }}
                      >
                        {t('기록 보기')}
                      </button>
                    )}
                    {d && (
                      <button className="btn sm" onClick={() => onOpen(d.report)}>
                        {t('디자인')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {view.plan.cases.some((x) => x.selected) && rows.length === 0 && <div className="faint">{t('보여 줄 TC 가 없습니다')}</div>}
    </div>
  );
}
