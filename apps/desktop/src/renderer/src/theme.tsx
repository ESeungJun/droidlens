import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

/**
 * 화면 테마 (라이트·다크). 고른 값을 main 에 알리면 main 이 nativeTheme.themeSource 를 바꾸고,
 * 그 값이 렌더러의 prefers-color-scheme 으로 들어와 styles.css 의 색이 바뀐다.
 * 그래서 파일 대화상자 같은 OS 화면도 같은 테마가 되고, 다음 실행은 JS 가 돌기 전 첫 화면부터 맞는 색으로 뜬다.
 * 'system' 이면 OS 설정을 따라간다.
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
  /** 지금 화면에 적용된 테마 (CSS 와 같은 값) */
  theme: Theme;
  setting: ThemeSetting;
  setSetting(s: ThemeSetting): void;
}

const ThemeCtx = createContext<ThemeState>({ theme: 'dark', setting: 'system', setSetting: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<ThemeSetting>(readSetting);
  const [dark, setDark] = useState(media.matches);

  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    media.addEventListener('change', on);
    return () => media.removeEventListener('change', on);
  }, []);

  // 시작할 때도 보내서 main 에 저장된 값과 맞춘다 (같으면 main 이 아무것도 하지 않음)
  useEffect(() => {
    api.setTheme(setting).catch(() => undefined);
  }, [setting]);

  const setSetting = useCallback((s: ThemeSetting) => {
    setSettingState(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* 이번 실행 동안만 적용 */
    }
  }, []);

  const theme: Theme = dark ? 'dark' : 'light';
  const value = useMemo(() => ({ theme, setting, setSetting }), [theme, setting, setSetting]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
