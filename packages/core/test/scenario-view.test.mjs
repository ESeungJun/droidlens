// 리포트 표시 모델 (packages/core/src/scenario-view.ts): 정정 사슬·사유·근거 보존. 빌드 결과(dist)를 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenarioView } from '../dist/scenario-view.js';

const base = { id: 't', name: '시험', startedAt: 0, finishedAt: 1000, dir: '/tmp/x', packageName: 'com.example' };
const step = (index, status, extra = {}) => ({ index, at: index * 10, title: `단계 ${index}`, status, ...extra });
const codes = (row) => row.reasons.map((r) => r.code).sort();

test('정정의 정정은 맨 처음 단계 한 행으로 모이고 마지막 판정을 따른다', () => {
  const v = buildScenarioView({
    ...base,
    steps: [step(1, 'fail'), step(2, 'pass', { corrects: 1 }), step(3, 'fail', { corrects: 2 })],
  });
  assert.equal(v.rows.length, 1);
  const [row] = v.rows;
  assert.equal(row.index, 1);
  assert.equal(row.status, 'fail');
  assert.equal(row.corrected.times, 2);
  assert.equal(row.corrected.byIndex, 3);
  assert.equal(v.counts.corrected, 1);
});

test('뒤 단계를 가리키는 정정은 정정으로 보지 않는다', () => {
  const v = buildScenarioView({ ...base, steps: [step(1, 'pass'), step(2, 'pass', { corrects: 5 })] });
  assert.equal(v.rows.length, 2);
  assert.equal(v.rows[0].corrected, undefined);
});

test('자동 검사 실패를 통과로 바꾼 경우에만 overridden 사유가 붙는다', () => {
  const byAssert = buildScenarioView({
    ...base,
    steps: [step(1, 'fail', { check: { by: 'assert', expect: '"5" 보임' } }), step(2, 'pass', { corrects: 1 })],
  });
  assert.ok(codes(byAssert.rows[0]).includes('overridden'));

  const byAgent = buildScenarioView({
    ...base,
    steps: [step(1, 'fail', { check: { by: 'agent' } }), step(2, 'pass', { corrects: 1 })],
  });
  assert.ok(!codes(byAgent.rows[0]).includes('overridden'));
  assert.ok(codes(byAgent.rows[0]).includes('corrected'));
});

test('다른 앱 화면 스샷은 확인할 것에 올라가고 행이 bad 로 칠해진다', () => {
  const noShot = buildScenarioView({ ...base, steps: [step(1, 'pass', { foreign: 'com.android.vending' })] });
  assert.equal(noShot.attention.length, 0, '스샷이 없으면 다른 앱 화면 사유를 붙이지 않는다');

  const v = buildScenarioView({
    ...base,
    steps: [step(1, 'pass', { foreign: 'com.android.vending', screenshot: 'step-1.png' })],
  });
  assert.ok(codes(v.rows[0]).includes('foreign'));
  assert.equal(v.rows[0].tone, 'bad');
  assert.equal(v.attention.length, 1);
});

test('확인할 것은 실패를 먼저, 그다음 번호 순으로', () => {
  // 다른 앱 화면 사유는 판정 근거 스샷이 있을 때만 붙는다
  const v = buildScenarioView({
    ...base,
    steps: [
      step(1, 'pass', { foreign: 'com.android.vending', screenshot: 'step-1.png' }),
      step(2, 'pass'),
      step(3, 'fail'),
    ],
  });
  assert.deepEqual(v.attention.map((a) => a.index), [3, 1]);
});

test('에이전트가 쓴 detail 은 근거로 보존된다', () => {
  const v = buildScenarioView({
    ...base,
    steps: [step(1, 'pass', { detail: '로그인 버튼이 보이고 눌림 상태가 아님', check: { by: 'agent' } })],
  });
  assert.match(v.rows[0].evidence ?? '', /로그인 버튼이 보이고/);
});
