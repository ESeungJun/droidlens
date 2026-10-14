import { useEffect, useState, type ReactNode } from 'react';
import { api, type SdkInfo } from '../api';
import { NeedPkg, useApp } from '../App';
import { useT } from '../i18n';

const SNIPPET = `// settings.gradle
dependencyResolutionManagement {
    repositories { maven { url = uri("https://jitpack.io") } }
}

// app/build.gradle.kts
debugImplementation("com.github.ESeungJun.droidlens:sdk:v0.5.0")
releaseImplementation("com.github.ESeungJun.droidlens:sdk-noop:v0.5.0")

// 네트워크 인스펙터 (OkHttp)
OkHttpClient.Builder()
    .addInterceptor(DroidLensInterceptor())
    .build()`;

/** 선택한 앱에서 SDK가 실행 중일 때만 children을 그리고, 아니면 설치 안내를 보여준다 */
export function SdkGate({ children }: { children: (info: SdkInfo) => ReactNode }) {
  const { serial, pkg, toast } = useApp();
  const t = useT();
  const snippet = SNIPPET.replace('네트워크 인스펙터 (OkHttp)', t('네트워크 인스펙터 (OkHttp)'));
  const [info, setInfo] = useState<SdkInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setInfo(null);
    setErr(null);
    if (!serial || !pkg) return;
    api
      .sdk<SdkInfo>(serial, pkg, 'info')
      .then(setInfo)
      .catch((e) => setErr((e as Error).message));
  }, [serial, pkg, tick]);

  if (!pkg) return <NeedPkg />;
  if (info) return <>{children(info)}</>;
  return (
    <div className="scroll">
      <div className="card" style={{ maxWidth: 720 }}>
        <h5>{t('DroidLens SDK 필요')}</h5>
        <p className="muted" style={{ marginTop: 0 }}>
          {err ? t(err) : t('SDK 연결 확인 중…')}
        </p>
        <p style={{ fontSize: 12 }}>
          {t('네트워크·SharedPreferences·DB·커스텀 이벤트는 앱 내부 정보라 debug 빌드에 SDK를 넣어야 볼 수 있습니다. release 빌드에는 아무 동작도 하지 않는 sdk-noop이 들어가고, INTERNET 권한도 필요 없습니다.')}
        </p>
        <pre className="mono card" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{snippet}</pre>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn" onClick={() => api.copy(snippet).then(() => toast('복사했습니다'))}>{t('코드 복사')}</button>
          <button className="btn primary" onClick={() => setTick((n) => n + 1)}>{t('다시 연결')}</button>
        </div>
      </div>
    </div>
  );
}
