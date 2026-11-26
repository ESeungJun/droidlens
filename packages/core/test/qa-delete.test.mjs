// QA 계획 지우기 (#133): 계획 폴더만, 기록·스크립트는 고를 때만, 돌고 있으면 거부, 폴더 밖은 지우지 않음
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');

function record(planId, runId, name, { finished = true, startedAt = Date.now() } = {}) {
  const dir = join(home, 'scenarios', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify({ id: name, name, tc: { plan: planId, case: 'TC-001', run: runId }, startedAt, ...(finished ? { finishedAt: startedAt + 1, verdict: 'pass' } : {}), steps: [] }),
  );
  return dir;
}

function script(planId, name) {
  mkdirSync(join(home, 'scripts'), { recursive: true });
  const p = join(home, 'scripts', `${name}.yaml`);
  writeFileSync(p, `name: ${name}\napp: com.example.app\ntc:\n  plan: ${planId}\n  case: TC-001\nsteps:\n  - assert:\n      visible:\n        text: 홈\n`);
  return p;
}

async function setup(name) {
  const plan = await qa.createQaPlan({ name, app: 'com.example.app' });
  const run = await qa.createQaRun(plan.id);
  return { plan, run };
}

test('기본은 계획 폴더만 지우고 TC 기록·스크립트는 남긴다', async () => {
  const { plan, run } = await setup('남김');
  const rec = record(plan.id, run.id, '20261126-100000_keep');
  const sc = script(plan.id, 'TC-001_keep');
  const info = await qa.qaPlanDeleteInfo(plan.id);
  assert.deepEqual([info.name, info.runs, info.records, info.scripts, info.running], ['남김', 1, 1, 1, false]);
  const r = await qa.deleteQaPlan(plan.id);
  assert.deepEqual([r.records, r.scripts], [0, 0]);
  assert.equal(existsSync(qa.qaPlanDir(plan.id)), false);
  assert.ok(existsSync(rec), '기록은 남음');
  assert.ok(existsSync(sc), '스크립트는 남음');
  assert.equal((await qa.listQaPlans()).some((p) => p.id === plan.id), false);
});

test('withRecords 면 이 계획의 기록·스크립트만 같이 지운다', async () => {
  const { plan, run } = await setup('같이');
  const other = await setup('다른 계획');
  const rec = record(plan.id, run.id, '20261126-110000_mine');
  const sc = script(plan.id, 'TC-001_mine');
  const otherRec = record(other.plan.id, other.run.id, '20261126-110001_other');
  const otherSc = script(other.plan.id, 'TC-001_other');
  const r = await qa.deleteQaPlan(plan.id, { withRecords: true });
  assert.deepEqual([r.records, r.scripts], [1, 1]);
  assert.equal(existsSync(rec), false);
  assert.equal(existsSync(sc), false);
  assert.ok(existsSync(otherRec), '다른 계획의 기록은 그대로');
  assert.ok(existsSync(otherSc), '다른 계획의 스크립트는 그대로');
});

test('끝나지 않은 TC 기록이 있으면(회차가 돌고 있으면) 지우지 않는다', async () => {
  const { plan, run } = await setup('도는 중');
  record(plan.id, run.id, '20261126-120000_open', { finished: false });
  assert.equal((await qa.qaPlanDeleteInfo(plan.id)).running, true);
  await assert.rejects(qa.deleteQaPlan(plan.id), /돌고 있어/);
  assert.ok(existsSync(qa.qaPlanDir(plan.id)));
});

test('오래돼 멈춘 기록은 돌고 있는 것으로 보지 않는다', async () => {
  const { plan, run } = await setup('멈춘 기록');
  record(plan.id, run.id, '20261126-130000_stale', { finished: false, startedAt: Date.now() - 24 * 3600_000 });
  await qa.deleteQaPlan(plan.id);
  assert.equal(existsSync(qa.qaPlanDir(plan.id)), false);
});

test('id 형식이 틀리거나 계획 폴더가 링크면 지우지 않는다', async () => {
  await assert.rejects(qa.deleteQaPlan('../scenarios'), /형식/);
  await assert.rejects(qa.deleteQaPlan('없는계획'), /없습니다/);
  const outside = mkdtempSync(join(home, 'outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'x');
  symlinkSync(outside, join(home, 'qa', 'linked'));
  await assert.rejects(qa.deleteQaPlan('linked'), /폴더가 아닙니다/);
  assert.ok(existsSync(join(outside, 'keep.txt')), '링크가 가리키는 폴더는 그대로');
});

test('기록 폴더가 시나리오 폴더 밖을 가리키는 링크면 같이 지우지 않는다', async () => {
  const { plan, run } = await setup('링크 기록');
  const outside = mkdtempSync(join(home, 'outside-rec-'));
  writeFileSync(
    join(outside, 'scenario.json'),
    JSON.stringify({ id: 'x', name: 'x', tc: { plan: plan.id, case: 'TC-001', run: run.id }, startedAt: 1, finishedAt: 2, steps: [] }),
  );
  mkdirSync(join(home, 'scenarios'), { recursive: true });
  symlinkSync(outside, join(home, 'scenarios', '20261126-140000_link'));
  await qa.deleteQaPlan(plan.id, { withRecords: true });
  assert.ok(existsSync(join(outside, 'scenario.json')), '밖 폴더는 그대로');
});
