// QA 회차 실행 측정값 (#141): 대화 수·TC 당 시간·앱 강제 종료 횟수를 회차에 남기고 요약에 낸다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');

async function setup() {
  const plan = await qa.createQaPlan({ name: '측정', app: 'com.example.app' });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '로그인' }],
    cases: [
      { id: 'TC-001', title: '하나', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'], selected: true },
      { id: 'TC-002', title: '둘', requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'], selected: true },
    ],
  });
  return { plan: await qa.loadQaPlan(plan.id), run: await qa.createQaRun(plan.id) };
}

test('측정값을 더해 회차에 저장하고, 같은 TC 의 시간은 마지막 값으로 둔다', async () => {
  const { plan, run } = await setup();
  await qa.addQaRunMetrics(plan.id, run.id, { conversations: 1, forceStops: 1, caseMs: { 'TC-001': 12_000 } });
  await qa.addQaRunMetrics(plan.id, run.id, { forceStops: 2, caseMs: { 'TC-002': 30_000 } });
  await qa.addQaRunMetrics(plan.id, run.id, { conversations: 1, caseMs: { 'TC-001': 18_000 } });
  const saved = await qa.loadQaRun(plan.id, run.id);
  assert.deepEqual(saved.metrics, { conversations: 2, forceStops: 3, caseMs: { 'TC-001': 18_000, 'TC-002': 30_000 } });
  const raw = JSON.parse(readFileSync(join(qa.qaRunDir(plan.id, run.id), 'run.json'), 'utf8'));
  assert.equal(raw.metrics.conversations, 2, 'run.json 에 저장');
});

test('요약은 TC 당 평균 시간과 합을 낸다. 측정값이 없는 옛 회차는 metrics 가 없다', async () => {
  const { plan, run } = await setup();
  assert.equal(qa.qaRunSummary(plan, await qa.loadQaRun(plan.id, run.id)).metrics, undefined);
  await qa.addQaRunMetrics(plan.id, run.id, { conversations: 1, forceStops: 1, caseMs: { 'TC-001': 10_000, 'TC-002': 20_000 } });
  const m = qa.qaRunSummary(plan, await qa.loadQaRun(plan.id, run.id)).metrics;
  assert.deepEqual(m, { conversations: 1, forceStops: 1, cases: 2, totalCaseMs: 30_000, avgCaseMs: 15_000 });
});

test('옛 run.json(측정값 없음)도 그대로 읽힌다', async () => {
  const { plan, run } = await setup();
  const f = join(qa.qaRunDir(plan.id, run.id), 'run.json');
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  delete raw.metrics;
  writeFileSync(f, JSON.stringify(raw));
  const r = await qa.loadQaRun(plan.id, run.id);
  assert.equal(r.metrics, undefined);
});

test('형식이 틀린 값(음수·소수·모르는 TC 번호 꼴)은 받지 않는다', async () => {
  const { plan, run } = await setup();
  await assert.rejects(qa.addQaRunMetrics(plan.id, run.id, { forceStops: -1 }));
  await assert.rejects(qa.addQaRunMetrics(plan.id, run.id, { caseMs: { 'TC-001': 1.5 } }));
  await assert.rejects(qa.addQaRunMetrics(plan.id, run.id, { caseMs: { '../x': 1 } }));
});
