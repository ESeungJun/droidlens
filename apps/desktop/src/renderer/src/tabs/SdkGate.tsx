import { useEffect, useState, type ReactNode } from 'react';
import { api, type SdkInfo } from '../api';
import { NeedPkg, useApp } from '../App';

const SNIPPET = `// settings.gradle
dependencyResolutionManagement {
    repositories { maven { url = uri("https://jitpack.io") } }
}

// app/build.gradle.kts
debugImplementation("com.github.ESeungJun.droidlens:sdk:v0.4.0")
releaseImplementation("com.github.ESeungJun.droidlens:sdk-noop:v0.4.0")

// 네트워크 인스펙터 (OkHttp)
OkHttpClient.Builder()
    .addInterceptor(DroidLensInterceptor())
    .build()`;

/** 선택한 앱에서 SDK가 실행 중일 때만 children을 그리고, 아니면 설치 안내를 보여준다 */
export function SdkGate({ children }: { children: (info: SdkInfo) => ReactNode }) {
  const { serial, pkg, toast } = useApp();
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
        <h5>DroidLens SDK 필요</h5>
        <p className="muted" style={{ marginTop: 0 }}>
          {err ? err : 'SDK 연결 확인 중…'}
        </p>
        <p style={{ fontSize: 12 }}>
          네트워크·SharedPreferences·DB·커스텀 이벤트는 앱 내부 정보라 debug 빌드에 SDK를 넣어야 볼 수 있습니다. release 빌드에는
          아무 동작도 하지 않는 <span className="mono">sdk-noop</span>이 들어가고, INTERNET 권한도 필요 없습니다.
        </p>
        <pre className="mono card" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{SNIPPET}</pre>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn" onClick={() => api.copy(SNIPPET).then(() => toast('복사했습니다'))}>코드 복사</button>
          <button className="btn primary" onClick={() => setTick((t) => t + 1)}>다시 연결</button>
        </div>
      </div>
    </div>
  );
}
