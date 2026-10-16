import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * 화면 테마 (라이트·다크). 색은 styles.css 의 변수로만 정하고, 여기서는 <html data-theme> 만 바꾼다.
 * 'system' 이면 OS 설정을 따라가고 OS 설정이 바뀌면 바로 반영한다.
 */
export type Theme = 'light' | 'dark';
export type ThemeSetting = Theme | 'system';

const KEY = 'droidlens.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 저장소를 못 쓰면 시스템 테마 */
  }
  return 'system';
}

interface ThemeState {
  theme: Theme;
  setting: ThemeSetting;
  setSetting(s: ThemeSetting): void;
}

const ThemeCtx = createContext<ThemeState>({ theme: 'dark', setting: 'system', setSetting: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<ThemeSetting>(readSetting);
  const [systemDark, setSystemDark] = useState(media.matches);
  const theme: Theme = setting === 'system' ? (systemDark ? 'dark' : 'light') : setting;

  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', on);
    return () => media.removeEventListener('change', on);
  }, []);

  const setSetting = useCallback((s: ThemeSetting) => {
    setSettingState(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* 이번 실행 동안만 적용 */
    }
  }, []);

  // 그리기 전에 바꿔서 시작할 때 다른 테마가 잠깐 보이지 않게
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const value = useMemo(() => ({ theme, setting, setSetting }), [theme, setting, setSetting]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
