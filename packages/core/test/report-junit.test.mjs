// 스위트 결과 → JUnit XML · Markdown 요약
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suiteToJUnit, suiteToMarkdown } from '../dist/report-junit.js';

const step = (index, status, title, extra = {}) => ({ index, at: 1000 + index * 1500, title, status, ...extra });
const SUITE = {
  passed: 1,
  failed: 2,
  durationMs: 12_340,
  results: [
    {
      path: '/s/login.yaml',
      name: '로그인',
      result: { verdict: 'pass', passed: 2, failed: 0, skipped: 0, durationMs: 4000, report: '/r/1/report.html', scenario: { id: '1', name: '로그인', startedAt: 1000, dir: '/r/1', steps: [step(1, 'pass', '앱 실행'), step(2, 'info', '메모'), step(3, 'pass', '홈 <진입> & "확인"')] } },
    },
    {
      path: '/s/cart.yaml',
      name: '장바구니',
      result: {
        verdict: 'fail', passed: 1, failed: 1, skipped: 1, durationMs: 8000, report: '/r/2/report.html',
        scenario: { id: '2', name: '장바구니', startedAt: 1000, dir: '/r/2', steps: [step(1, 'pass', '담기'), step(2, 'fail', '합계 | 확인', { detail: '기대: 2\n실제: 1\u0007', screenshot: 'steps/2.png', screen: 'CartActivity' }), step(3, 'skip', '결제')] },
      },
    },
    { path: '/s/broken.yaml', name: 'broken.yaml', error: 'steps: Required\n at line 3' },
  ],
};

test('suiteToJUnit: 스크립트는 testsuite, 단계는 testcase, 특수 문자는 이스케이프', () => {
  const xml = suiteToJUnit(SUITE);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="droidlens" tests="3" failures="2" time="12.340">/);
  assert.match(xml, /<testsuite name="로그인" tests="2" failures="0" errors="0" skipped="0" time="4.000">/);
  assert.ok(xml.includes('name="3. 홈 &lt;진입&gt; &amp; &quot;확인&quot;"'));
  assert.match(xml, /<testsuite name="장바구니" tests="3" failures="1" errors="0" skipped="1"/);
  assert.ok(xml.includes('<failure message="기대: 2">기대: 2\n실제: 1\n화면: CartActivity\n스크린샷: /r/2/steps/2.png</failure>'));
  assert.ok(xml.includes('<skipped/>'));
  assert.match(xml, /<testsuite name="broken.yaml" tests="1" failures="0" errors="1"[^>]*>\s*<testcase[^>]*>\s*<error message="steps: Required">/);
  assert.ok(!xml.includes('\u0007'), '제어 문자는 뺀다');
});

test('suiteToJUnit: 단계 실패 없이 판정만 실패(준비 단계)면 오류 한 건', () => {
  const xml = suiteToJUnit({ passed: 0, failed: 1, durationMs: 1, results: [{ path: 'a', name: 'A', result: { verdict: 'blocked', passed: 0, failed: 0, skipped: 0, durationMs: 1, report: 'r', scenario: { id: 'x', name: 'A', startedAt: 0, dir: '/d', summary: '준비 단계 실패: 앱 없음', steps: [] } } }] });
  assert.match(xml, /tests="1" failures="0" errors="1"/);
  assert.ok(xml.includes('<error message="준비 단계 실패: 앱 없음">'));
});

test('suiteToMarkdown: 표와 실패 단계·스크린샷 경로', () => {
  const md = suiteToMarkdown(SUITE);
  assert.match(md, /^## DroidLens 회귀 테스트: 1\/3 통과 \(12\.3초\)/);
  assert.ok(md.includes('| 통과 | 로그인 | 2/2 | 4.0초 |'));
  assert.ok(md.includes('| 실패 | 장바구니 | 1/3 | 8.0초 |'));
  assert.ok(md.includes('  - 2단계 합계 \\| 확인: 기대: 2 실제: 1'));
  assert.ok(md.includes('(스크린샷 `/r/2/steps/2.png`)'));
  assert.ok(md.includes('- **broken.yaml**: steps: Required at line 3'));
});
