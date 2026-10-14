import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './locales/en';

/**
 * 화면 문구 번역. 한국어 원문을 그대로 키로 쓰고, 영어는 locales/en 사전에서 찾는다.
 * 사전에 없는 문구는 원문(한국어)으로 보여서 번역이 빠져도 화면이 깨지지 않는다.
 * 값 끼워 넣기: t('에이전트 {n}개 설치', { n: 2 })
 */
export type Lang = 'ko' | 'en';
export type LangSetting = Lang | 'system';

const KEY = 'droidlens.lang';

const systemLang = (): Lang => (navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en');

function readSetting(): LangSetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'ko' || v === 'en' || v === 'system') return v;
  } catch {
    /* 저장소를 못 쓰면 시스템 언어 */
  }
  return 'system';
}

export type Vars = Record<string, string | number>;

export function translate(lang: Lang, text: string, vars?: Vars): string {
  const s = lang === 'en' ? en[text] ?? text : text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

interface I18n {
  lang: Lang;
  setting: LangSetting;
  setSetting(s: LangSetting): void;
  t(text: string, vars?: Vars): string;
}

const I18nCtx = createContext<I18n>({ lang: 'ko', setting: 'system', setSetting: () => undefined, t: (s) => s });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<LangSetting>(readSetting);
  const lang: Lang = setting === 'system' ? systemLang() : setting;

  const setSetting = useCallback((s: LangSetting) => {
    setSettingState(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* 이번 실행 동안만 적용 */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback((text: string, vars?: Vars) => translate(lang, text, vars), [lang]);
  const value = useMemo(() => ({ lang, setting, setSetting, t }), [lang, setting, setSetting, t]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
export const useT = () => useContext(I18nCtx).t;
