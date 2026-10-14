import { useCallback, useEffect, useState } from 'react';
import { api, type ScriptEntry, type ScriptProgress, type ScriptRunResult } from '../api';
import { useApp } from '../App';
import { useT } from '../i18n';

const TEMPLATE = (pkg: string) => `name: 새 시나리오
app: ${pkg}
setup:
  restart: true
steps:
  - wait: { text: "홈" }
  - tap: { text: "검색" }
  - type: { text: "운동화", into: { className: EditText } }
  - key: enter
  - assert: { visible: { textContains: "운동화" } }
  # SDK가 있으면 앱 내부도 확인
  # - assert: { network: { url: /api/search, status: 200 } }
  - assert: { noCrash: true }
`;

type StepLine = { index: number; title: string; status: 'running' | 'pass' | 'fail' | 'skip'; detail?: string };

/** 시나리오 스크립트(YAML) 목록·편집·실행 */
export function ScriptsPanel({ onFinished }: { onFinished(): void }) {
  const { serial, pkg, run, toast } = useApp();
  const t = useT();
  const [list, setList] = useState<ScriptEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [yaml, setYaml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepLine[]>([]);
  const [results, setResults] = useState<ScriptRunResult[] | null>(null);

  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    setList((await run(api.scriptsList())) ?? []);
    setLoaded(true);
  }, [run]);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () =>
      api.onScriptProgress((p: ScriptProgress) => {
        if (p.kind === 'script') {
          setRunning(`${p.file} (${p.index + 1}/${p.total})`);
          setSteps([]);
          return;
        }
        setSteps((cur) => {
          const next = cur.filter((s) => s.index !== p.index);
          next.push({ index: p.index, title: p.title, status: p.status, detail: p.detail });
          return next.sort((a, b) => a.index - b.index);
        });
      }),
    [],
  );

  const open = async (file: string) => {
    if (dirty && !window.confirm(t('저장하지 않은 변경을 버릴까요?'))) return;
    setSel(file);
    setYaml((await run(api.scriptRead(file))) ?? '');
    setDirty(false);
  };

  const save = async () => {
    const file = await run(api.scriptWrite(sel ?? '', yaml));
    if (file) {
      toast(t('저장: {file}', { file }));
      setSel(file);
      setDirty(false);
      load();
    }
  };

  const exec = async (files: string[]) => {
    if (!serial || !files.length) return;
    if (dirty) await save();
    setResults(null);
    setSteps([]);
    setRunning(files[0]);
    const r = await run(api.scriptRun(serial, files));
    setRunning(null);
    if (r) {
      setResults(r);
      const ok = r.filter((x) => x.verdict === 'pass').length;
      toast(t('{ok}/{total} 통과', { ok, total: r.length }), ok !== r.length);
    }
    onFinished();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', height: '100%', minHeight: 0 }}>
      <div className="scen-list">
        <div className="toolbar">
          <button className="btn sm primary" disabled={!serial || !list.length || !!running} onClick={() => exec(list.filter((x) => !x.error).map((x) => x.file))}>
            ▶ {t('전체 회귀 실행')}
          </button>
          <button
            className="btn sm"
            onClick={() => {
              setSel(null);
              setYaml(TEMPLATE(pkg ?? 'com.example.app'));
              setDirty(true);
            }}
          >
            ＋ {t('새 스크립트')}
          </button>
        </div>
        {!loaded && <div className="empty" style={{ height: 'auto', padding: 20, fontSize: 12 }}>{t('불러오는 중…')}</div>}
        {loaded && list.length === 0 && (
          <div className="empty" style={{ height: 'auto', padding: 20, fontSize: 12 }}>
            {t('저장된 스크립트가 없습니다.')}
            <br />
            {t('에이전트가 시나리오를 통과하면 자동으로 저장되고, 직접 작성할 수도 있습니다.')}
          </div>
        )}
        {list.map((s) => (
          <div key={s.file} className={`scen-item ${sel === s.file ? 'sel' : ''}`} onClick={() => open(s.file)}>
            <b>{s.name}</b>
            <div className="faint" style={{ fontSize: 11 }}>
              {s.error ? <span className="error">{t('형식 오류')}</span> : `${s.app} · ${t('{n}단계', { n: s.steps ?? 0 })}`}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', minHeight: 0 }}>
        <div className="toolbar">
          <b>{sel ?? (yaml ? t('새 스크립트') : t('스크립트를 선택하세요'))}</b>
          {dirty && <span className="pill">{t('수정됨')}</span>}
          <div className="spacer" />
          {yaml && (
            <>
              <button className="btn sm" onClick={save} disabled={!dirty}>{t('저장 (검증)')}</button>
              {running ? (
                <button className="btn sm danger" onClick={() => api.scriptStop()}>■ {t('중지')}</button>
              ) : (
                <button className="btn sm primary" disabled={!serial || !sel} onClick={() => sel && exec([sel])}>▶ {t('실행')}</button>
              )}
              {sel && !running && (
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    if (!window.confirm(t('{file}을(를) 삭제할까요?', { file: sel }))) return;
                    await run(api.scriptDelete(sel));
                    setSel(null);
                    setYaml('');
                    load();
                  }}
                >
                  {t('삭제')}
                </button>
              )}
            </>
          )}
        </div>
        <textarea
          className="input mono"
          style={{ margin: 10, resize: 'none', fontSize: 12.5, lineHeight: 1.55 }}
          spellCheck={false}
          value={yaml}
          placeholder={t('왼쪽에서 스크립트를 고르거나 새 스크립트를 만드세요')}
          onChange={(e) => {
            setYaml(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
        {(running || steps.length > 0 || results) && (
          <div style={{ borderTop: '1px solid var(--line)', maxHeight: '40%', overflow: 'auto', padding: '8px 12px' }} className="mono">
            {running && <div className="muted" style={{ marginBottom: 4 }}>{t('실행 중: {name}', { name: running })}</div>}
            {steps.map((s) => (
              <div key={s.index} style={{ fontSize: 12 }}>
                <span className={s.status === 'pass' ? 'v-pass' : s.status === 'fail' ? 'v-fail' : 'faint'}>
                  {s.status === 'running' ? '…' : s.status === 'pass' ? '✓' : s.status === 'fail' ? '✗' : '–'}
                </span>{' '}
                {s.index + 1}. {s.title}
                {s.status === 'fail' && s.detail && <pre style={{ margin: '2px 0 4px 18px', color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{s.detail}</pre>}
              </div>
            ))}
            {results?.map((r) => (
              <div key={r.file} style={{ fontSize: 12, marginTop: 4 }}>
                <span className={`v-${r.verdict}`}>{r.verdict.toUpperCase()}</span> {r.file}
                {r.error ? ` — ${r.error.split('\n')[0]}` : ` — ${t('{passed} 통과 · {failed} 실패 · {sec}초', { passed: r.passed ?? 0, failed: r.failed ?? 0, sec: ((r.durationMs ?? 0) / 1000).toFixed(1) })}`}
                {r.report && (
                  <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => api.openPath(r.report!)}>
                    {t('리포트')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
