import { useCallback, useEffect, useState } from 'react';
import { api, type UpdateInfo } from './api';
import { useT } from './i18n';

/** 업데이트 확인·설치 상태 (시작 시 + 6시간마다 확인) */
export function useUpdater() {
  const t = useT();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ p: number; message: string } | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setInfo(await api.updateCheck());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    const t = setInterval(check, 6 * 3600_000);
    return () => clearInterval(t);
  }, [check]);

  useEffect(() => api.onUpdateProgress(setProgress), []);

  const install = useCallback(async () => {
    if (!info?.available) return;
    if (!info.canInstall) {
      setError(info.reason ?? t('자동 설치를 할 수 없습니다'));
      return;
    }
    const notes = (info.notes ?? '').split('\n').filter(Boolean).slice(0, 8).join('\n');
    if (!window.confirm(`${t('DroidLens {version}로 업데이트할까요?', { version: info.latest })}\n${t('앱이 다시 시작됩니다.')}\n\n${notes}`)) return;
    setProgress({ p: 0, message: t('준비 중…') });
    try {
      await api.updateInstall(info);
    } catch (e) {
      setProgress(null);
      setError((e as Error).message);
    }
  }, [info, t]);

  return { info, checking, error, progress, check, install };
}

/** 상단 바: 새 버전이 있을 때만 보이는 버튼 */
export function UpdateButton({ u }: { u: ReturnType<typeof useUpdater> }) {
  const t = useT();
  if (u.progress) {
    return (
      <span className="pill accent" title={u.progress.message}>
        ⬆ {Math.round(u.progress.p * 100)}% {t(u.progress.message)}
      </span>
    );
  }
  if (!u.info?.available) return null;
  return (
    <button className="btn sm primary" onClick={u.install} title={u.info.canInstall ? t('클릭하면 내려받아 설치하고 다시 시작합니다') : u.info.reason && t(u.info.reason)}>
      ⬆ {t('업데이트 {version}', { version: u.info.latest })}
    </button>
  );
}
