import { useEffect, useState } from 'react';
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

function ReportsView() {
  const { run } = useApp();
  const t = useT();
  const [list, setList] = useState<ScenarioData[]>([]);
  const [sel, setSel] = useState<ScenarioData | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    const l = (await run(api.scenarios())) ?? [];
    setList(l);
    setLoaded(true);
    setSel((s) => (s ? l.find((x) => x.id === s.id) ?? null : l[0] ?? null));
  };
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000); // 에이전트가 진행 중인 시나리오를 실시간 반영
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scen" style={{ height: 'calc(100% - 45px)' }}>
      <div className="scen-list">
        <div className="toolbar"><b>{t('시나리오 검증 기록')}</b><span className="faint">({list.length})</span></div>
        {!loaded && <div className="empty" style={{ height: 'auto', padding: 24 }}>{t('불러오는 중…')}</div>}
        {loaded && list.length === 0 && (
          <div className="empty" style={{ height: 'auto', padding: 24 }}>
            {t('아직 기록이 없습니다.')}
            <br />
            {t('Claude Code에서 droidlens-verifier 에이전트에게 시나리오 검증을 맡겨 보세요.')}
          </div>
        )}
        {list.map((s) => (
          <div key={s.id} className={`scen-item ${sel?.id === s.id ? 'sel' : ''}`} onClick={() => setSel(s)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
              <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</b>
              <span className={`v-${s.verdict ?? 'blocked'}`}>{s.verdict ? s.verdict.toUpperCase() : t('진행 중')}</span>
            </div>
            <div className="faint" style={{ fontSize: 11 }}>
              {new Date(s.startedAt).toLocaleString()} · {t('{n}단계 · 실패 {fail}', { n: s.steps.length, fail: s.steps.filter((x) => x.status === 'fail').length })}
            </div>
          </div>
        ))}
      </div>
      {sel ? (
        <div className="steps">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{sel.name}</h2>
            <span className={`v-${sel.verdict ?? 'blocked'}`} style={{ fontWeight: 700 }}>{sel.verdict?.toUpperCase() ?? t('진행 중')}</span>
            <div className="spacer" />
            {sel.finishedAt && <button className="btn sm" onClick={() => api.openPath(`${sel.dir}/report.html`)}>{t('HTML 리포트 열기')}</button>}
            <button className="btn sm" onClick={() => api.reveal(`${sel.dir}/scenario.json`)}>{t('폴더')}</button>
          </div>
          <div className="muted" style={{ marginBottom: 10 }}>
            {[sel.packageName, sel.device].filter(Boolean).join(' · ')}
          </div>
          {sel.goal && <p><b>{t('목표')}</b> {sel.goal}</p>}
          {sel.summary && <p><b>{t('결론')}</b> {sel.summary}</p>}
          {sel.steps.map((st) => (
            <div className="step" key={st.index}>
              <div>
                <div>
                  <span className={`badge b-${st.status}`}>{st.status.toUpperCase()}</span>
                  <b>{st.index}. {st.title}</b>
                </div>
                {st.screen && <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>{st.screen}</div>}
                {st.detail && <pre>{st.detail}</pre>}
              </div>
              <div>{st.screenshot && <StepShot dir={sel.dir} file={st.screenshot} />}</div>
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
