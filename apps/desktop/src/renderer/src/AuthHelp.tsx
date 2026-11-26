import { useState } from 'react';
import { CLAUDE_AUTH_MESSAGE } from '@droidlens/core/claude-auth';
import { api } from './api';
import { useApp } from './App';
import { useT } from './i18n';

/**
 * 로그인이 끊긴 안내(#120) 밑에 붙이는 로그인 명령 복사 버튼. 다른 글이면 아무것도 그리지 않는다.
 * 명령은 앱이 쓰는 설정 폴더에 맞춰 메인에서 받는다
 */
export function AuthHelp({ text, onRetry }: { text?: string; onRetry?: () => void }) {
  const { run, toast } = useApp();
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (text !== CLAUDE_AUTH_MESSAGE) return null;
  const copy = async () => {
    setBusy(true);
    const i = await run(api.integration());
    setBusy(false);
    if (i) await api.copy(i.loginCommand).then(() => toast(t('명령을 복사했습니다')));
  };
  return (
    <div style={{ marginTop: 6 }}>
      <button className="btn sm" disabled={busy} onClick={copy}>
        {t('로그인 명령 복사')}
      </button>
      {onRetry && (
        <button className="btn sm" style={{ marginLeft: 6 }} onClick={onRetry}>
          {t('다시 확인')}
        </button>
      )}
    </div>
  );
}
