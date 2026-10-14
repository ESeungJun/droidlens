import { useEffect, useState } from 'react';
import { api, type ApkAnalysis } from '../api';
import { NeedPkg, useApp } from '../App';
import { useT } from '../i18n';

const CAT_LABEL: Record<string, string> = {
  framework: '프레임워크', ui: 'UI', network: '네트워크', di: 'DI', async: '비동기', image: '이미지', storage: '저장소',
  serialization: '직렬화', analytics: '분석·마케팅', crash: '크래시·모니터링', ads: '광고', payment: '결제', auth: '인증·로그인',
  media: '미디어·카메라', debug: '디버그', security: '보안', map: '지도', push: '푸시', other: '기타',
};

const cache = new Map<string, ApkAnalysis>();

export function LibsTab() {
  const { serial, pkg, run } = useApp();
  const t = useT();
  const [r, setR] = useState<ApkAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => setR(pkg ? cache.get(pkg) ?? null : null), [pkg]);
  useEffect(() => api.onProgress((p) => p.kind === 'libs' && setMsg(p.message)), []);

  if (!pkg) return <NeedPkg />;

  const analyze = async () => {
    if (!serial) return;
    setBusy(true);
    const res = await run(api.analyzeLibraries(serial, pkg));
    setBusy(false);
    setMsg('');
    if (res) {
      cache.set(pkg, res);
      setR(res);
    }
  };

  const groups = new Map<string, ApkAnalysis['libraries']>();
  r?.libraries.forEach((l) => groups.set(l.category, [...(groups.get(l.category) ?? []), l]));

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={analyze} disabled={busy}>{busy ? t('분석 중…') : r ? `↻ ${t('다시 분석')}` : `▶ ${t('APK 분석')}`}</button>
        <span className="muted">{busy ? t(msg) : t('APK를 내려받아 DEX 클래스와 네이티브 lib로 라이브러리를 탐지합니다')}</span>
        {r && <button className="btn sm" onClick={() => api.reveal(r.apkFiles[0])}>{t('APK 위치 열기')}</button>}
      </div>
      {!r ? (
        <div className="empty">{busy ? (msg ? t(msg) : t('분석 중…')) : t('분석을 시작하세요')}</div>
      ) : (
        <div className="scroll">
          <div className="stats">
            <div className="stat"><b>{r.libraries.length}</b><span>{t('탐지된 라이브러리')}</span></div>
            <div className="stat"><b>{r.classCount.toLocaleString()}</b><span>{t('클래스 (dex {n}개)', { n: r.dexCount })}</span></div>
            <div className="stat"><b>{r.appClassCount.toLocaleString()}</b><span>{t('앱 자체 클래스 추정')}</span></div>
            <div className="stat"><b>{r.kotlin ? 'Kotlin' : 'Java'}</b><span>{t('주 언어 추정')}</span></div>
            <div className="stat"><b>{r.obfuscation.likelyObfuscated ? t('예') : t('아니오')}</b><span>{t('난독화 ({pct}%)', { pct: (r.obfuscation.shortNameRatio * 100).toFixed(1) })}</span></div>
            <div className="stat"><b>{r.abis.join(', ') || '-'}</b><span>{t('네이티브 ABI · lib {n}개', { n: new Set(r.nativeLibs.map((n) => n.name)).size })}</span></div>
          </div>
          <div className="cards">
            {[...groups.entries()].map(([cat, libs]) => (
              <div className="card" key={cat}>
                <h5>{CAT_LABEL[cat] ? t(CAT_LABEL[cat]) : cat}</h5>
                {libs.map((l) => (
                  <div className="lib" key={l.name}>
                    <b>{l.name}</b> {l.note && <span style={{ color: 'var(--warn)' }}>⚠ {l.note}</span>}
                    {l.evidence.map((e) => <div className="ev" key={e}>{e}</div>)}
                  </div>
                ))}
              </div>
            ))}
            {r.unknownPackages.length > 0 && (
              <div className="card">
                <h5>{t('시그니처에 없는 패키지')}</h5>
                {r.unknownPackages.slice(0, 25).map((u) => (
                  <div className="ev mono" key={u.pkg} style={{ fontSize: 11 }}>{u.pkg} <span className="faint">({u.classes})</span></div>
                ))}
              </div>
            )}
            {r.nativeLibs.length > 0 && (
              <div className="card">
                <h5>{t('네이티브 라이브러리 ({abi})', { abi: r.abis[0] })}</h5>
                {r.nativeLibs.filter((n) => n.abi === r.abis[0]).map((n) => (
                  <div className="ev mono" key={n.name} style={{ fontSize: 11 }}>{n.name} <span className="faint">{(n.size / 1024).toFixed(0)}KB</span></div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
