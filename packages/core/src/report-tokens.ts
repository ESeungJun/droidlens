/**
 * 단독 HTML 리포트의 색 토큰 원본(라이트 :root + 다크 @media). 리포트는 파일 하나로 열려 앱 CSS 를 못 쓰므로
 * 리포트마다 자기 :root 를 넣는다. 리포트 CSS 는 여기 변수만 쓰고 색을 직접 쓰지 않는다(check-tokens 가 막는다).
 * 다크 블록에 없는 변수는 테마와 상관없이 같은 색이다.
 */

/** 시나리오 리포트 (scenario.ts) */
export const SCENARIO_TOKENS = `
:root{--bg:#f6f7f6;--card:#fff;--fg:#151917;--muted:#5f6763;--line:#dfe3e0;--soft:#eef1ef;
--pass:#17803d;--pass-bg:#e6f4ea;--fail:#c62828;--fail-bg:#fdecec;--warn:#a15c00;--warn-bg:#fff3dc;--info:#2b5fb4;--info-bg:#e8effb;--accent:#0f6b5c;
--on-warn:#fff;--scrim:rgba(0,0,0,.8);
--sans:-apple-system,"Apple SD Gothic Neo","Pretendard",system-ui,sans-serif;--mono:ui-monospace,Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1211;--card:#171b19;--fg:#e7ebe9;--muted:#97a19c;--line:#2a312e;--soft:#1e2422;
--pass:#5cc882;--pass-bg:#16301f;--fail:#ff7b72;--fail-bg:#3a1a1a;--warn:#f0b14a;--warn-bg:#35280f;--info:#82aaf0;--info-bg:#172440;--accent:#4fc2ab;color-scheme:dark}}`;

/** QA 결과표 (qa/report.ts) */
export const QA_REPORT_TOKENS = `
:root{--bg:#f7f8fa;--card:#fff;--fg:#1d2330;--mute:#677086;--line:#e2e6ee;--ok:#0f7b46;--okbg:#e3f5ea;--bad:#b42318;--badbg:#fdeceb;--warn:#8a5a00;--warnbg:#fff4d6;--mbg:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1a1e26;--fg:#e6e9ef;--mute:#98a1b3;--line:#2b313c;--ok:#5fd394;--okbg:#173626;--bad:#ff8a80;--badbg:#3a1d1b;--warn:#ffcc66;--warnbg:#3a2f12;--mbg:#262b35;color-scheme:dark}}`;

/** 디자인 비교 리포트 (design/report.ts). 심각도 색(--high·--medium·--low)은 테마와 상관없이 같다 */
export const DESIGN_REPORT_TOKENS = `
:root{--bg:#f7f8fa;--card:#fff;--fg:#1d2330;--mute:#677086;--line:#e2e6ee;--mbg:#eef0f4;
--high:#b42318;--high-bg:#fdeceb;--medium:#8a5a00;--medium-bg:#fff4d6;--low:#1d4ed8;--low-bg:#e6efff}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1a1e26;--fg:#e6e9ef;--mute:#98a1b3;--line:#2b313c;--mbg:#262b35;color-scheme:dark}}`;
