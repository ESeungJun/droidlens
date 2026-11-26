// QA 기록 정리 (#101·#102): TC 이름 규칙, 끝나지 않은 회차 기록 마무리, 오래된 미완료 기록 판정
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');
const { tcName } = await import('../dist/scenario-view.js');
const { scenarioStale, SCENARIO_STALE_MS } = await import('../dist/scenario-view.js');

test('tcName: TC 번호를 한 번만 붙이고 여러 번 붙은 것은 줄인다', () => {
  assert.equal(tcName('TC-001', 'TC-001'), 'TC-001');
  assert.equal(tcName('TC-001', 'TC-001 TC-001'), 'TC-001');
  assert.equal(tcName('TC-001', 'TC-001 TC-001 로그인'), 'TC-001 로그인');
  assert.equal(tcName('TC-001', '로그인'), 'TC-001 로그인');
  assert.equal(tcName('TC-001', 'TC-0012 다른 것'), 'TC-001 TC-0012 다른 것', '번호가 앞부분만 같은 다른 글은 그대로');
});

function record(id, data) {
  const dir = join(home, 'scenarios', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ id, name: id, startedAt: 1, steps: [], dir: '/elsewhere', ...data }));
  return dir;
}

test('closeOpenTcScenarios: 그 회차(와 TC)의 끝나지 않은 기록만 막힘으로 마무리한다', async () => {
  const open = record('20261126-100000_a', { tc: { plan: 'p1', case: 'TC-001', run: 'r1' } });
  const other = record('20261126-100100_b', { tc: { plan: 'p1', case: 'TC-002', run: 'r1' } });
  const done = record('20261126-100200_c', { tc: { plan: 'p1', case: 'TC-003', run: 'r1' }, finishedAt: 5, verdict: 'pass' });
  const otherRun = record('20261126-100300_d', { tc: { plan: 'p1', case: 'TC-001', run: 'r2' } });
  const closed = await qa.closeOpenTcScenarios('p1', 'r1', '회차를 멈춤', { caseId: 'TC-001' });
  assert.deepEqual(closed.map((x) => x.case), ['TC-001']);
  const d = JSON.parse(readFileSync(join(open, 'scenario.json'), 'utf8'));
  assert.equal(d.verdict, 'blocked');
  assert.equal(d.summary, '회차를 멈춤');
  assert.equal(d.dir, open, '기록 안의 dir 대신 실제 폴더에 쓴다');
  assert.ok(existsSync(join(open, 'report.html')));
  assert.equal(JSON.parse(readFileSync(join(other, 'scenario.json'), 'utf8')).verdict, undefined, 'TC 를 주면 다른 TC 는 그대로');
  assert.equal(JSON.parse(readFileSync(join(done, 'scenario.json'), 'utf8')).verdict, 'pass');
  assert.equal(JSON.parse(readFileSync(join(otherRun, 'scenario.json'), 'utf8')).verdict, undefined, '다른 회차는 그대로');
  const rest = await qa.closeOpenTcScenarios('p1', 'r1', '회차를 멈춤');
  assert.deepEqual(rest.map((x) => x.case), ['TC-002']);
});

test('scenarioStale: 끝나지 않고 마지막 활동이 오래된 기록만', () => {
  const now = 10 * SCENARIO_STALE_MS;
  assert.equal(scenarioStale({ startedAt: now - SCENARIO_STALE_MS - 1, steps: [] }, now), true);
  assert.equal(scenarioStale({ startedAt: 0, steps: [{ at: now - 1000 }] }, now), false, '최근 단계가 있으면 진행 중');
  assert.equal(scenarioStale({ startedAt: 0, finishedAt: 1, steps: [] }, now), false);
});
