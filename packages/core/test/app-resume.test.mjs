// 앞 TC 뒤 이어 가기 (#159): 태스크를 비우지(CLEAR_TASK) 않고 앱을 앞으로 가져와 시작 화면으로 돌아간다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
process.env.DROIDLENS_AGENT = '0';
after(() => rmSync(home, { recursive: true, force: true }));

const g = await import('../dist/graph.js');
const qa = await import('../dist/qa/index.js');
const { fakeDevice } = await import('./fake-device.mjs');

const PKG = 'com.example.resume';
const appDef = {
  pkg: PKG,
  launch: 'home',
  screens: {
    home: { activity: `${PKG}.HomeActivity`, buttons: [{ id: 'detail', text: 'Detail', bounds: [0, 100, 1080, 190], go: 'detail' }] },
    detail: {
      activity: `${PKG}.DetailActivity`,
      buttons: [
        { id: 'price', text: '12,000원', bounds: [0, 100, 1080, 190] },
        { id: 'more', text: 'More', bounds: [0, 300, 1080, 390], go: 'deep' },
      ],
    },
    deep: { activity: `${PKG}.DeepActivity`, buttons: [{ id: 'stuck', text: 'Stuck', bounds: [0, 100, 1080, 190] }], backConsumes: 20 },
  },
};
const CLEAR_TASK = '0x10008000';
const clears = (f) => f.commands().filter((c) => c.startsWith('am start') && c.includes(CLEAR_TASK)).length;
const forceStops = (f) => f.commands().filter((c) => c.startsWith(`am force-stop ${PKG}`)).length;

async function startOf(f) {
  return g.resumeStartOf(await g.launchAndSettle(f.dev, PKG), PKG);
}

test('returnToStart: 시작 화면이 알려져 있으면 뒤로 가기로 돌아가고 태스크를 비우지 않는다', async () => {
  const f = fakeDevice(appDef, 'resume-1');
  const start = await startOf(f);
  f.open('home', 'detail');
  const before = clears(f);
  const r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, true);
  assert.equal(f.screen, 'home');
  assert.equal(r.backs, 1);
  assert.equal(clears(f), before, 'CLEAR_TASK 로 다시 띄우지 않음');
  assert.equal(forceStops(f), 0);
});

test('launchApp 은 런처 인텐트로 띄워, 뒤에 앞으로 가져와도 첫 화면을 하나 더 만들지 않는다 (#159 실기기 회귀)', async () => {
  const f = fakeDevice(appDef, 'resume-1b');
  await g.launchAndSettle(f.dev, PKG);
  assert.ok(f.commands().some((c) => c.includes(CLEAR_TASK) && c.includes('-a android.intent.action.MAIN -c android.intent.category.LAUNCHER')));
  const start = g.resumeStartOf(await g.waitForSettle(f.dev), PKG);
  await f.dev.shell('input tap 540 145');
  assert.equal(f.screen, 'detail');
  const r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, true);
  assert.equal(f.depth, 1, '태스크에 첫 화면 하나만 남음 (새로 만든 화면이 쌓이지 않음)');
});

test('returnToStart: 이미 시작 화면이면 아무것도 누르지 않는다', async () => {
  const f = fakeDevice(appDef, 'resume-2');
  const start = await startOf(f);
  const before = clears(f);
  const r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, true);
  assert.equal(r.backs, 0);
  assert.equal(clears(f), before);
});

test('returnToStart: 다른 앱이 앞에 있으면 앱을 앞으로 가져와 이어 간다', async () => {
  const f = fakeDevice(
    { ...appDef, screens: { ...appDef.screens, browser: { pkg: 'com.other.browser', activity: 'com.other.browser.Main', buttons: [] } } },
    'resume-3',
  );
  const start = await startOf(f);
  f.open('home', 'detail', 'browser');
  const before = clears(f);
  const r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, true);
  assert.equal(f.screen, 'home');
  assert.equal(clears(f), before);
});

test('returnToStart: 앱 태스크 안의 다른 앱 화면(Custom Tab 등)이 남으면 뒤로 가기를 보내지 않고 첫 화면부터 띄운다', async () => {
  const f = fakeDevice(
    { ...appDef, screens: { ...appDef.screens, pay: { pkg: 'com.other.pay', activity: 'com.other.pay.Sheet', buttons: [], inTask: true } } },
    'resume-3b',
  );
  const start = await startOf(f);
  f.open('home', 'detail', 'pay');
  f.log.length = 0;
  const r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, false);
  assert.equal(f.commands().filter((c) => c === 'input keyevent 4').length, 0, '다른 앱에 뒤로 가기를 보내지 않음');
  assert.equal(f.screen, 'home');
});

test('returnToStart: 시작 화면을 모르거나 프로세스가 없거나 돌아가지 못하면 예전처럼 첫 화면부터 띄운다', async () => {
  const f = fakeDevice(appDef, 'resume-4');
  f.open('home', 'detail');
  let r = await g.returnToStart(f.dev, PKG, undefined);
  assert.equal(r.resumed, false, '시작 화면 모름');
  assert.equal(f.screen, 'home');

  const start = await startOf(f);
  await f.dev.shell(`am force-stop ${PKG}`);
  const c0 = clears(f);
  r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, false, '프로세스 없음');
  assert.equal(clears(f), c0 + 1);

  // 뒤로 가기를 먹는 화면: 정해진 횟수 안에 못 돌아오면 CLEAR_TASK
  f.open('home', 'detail', 'deep');
  const c1 = clears(f);
  r = await g.returnToStart(f.dev, PKG, start, { maxBack: 3 });
  assert.equal(r.resumed, false);
  assert.equal(r.backs, 3);
  assert.equal(clears(f), c1 + 1);
  assert.equal(f.screen, 'home');
});

test('returnToStart: 뒤로 가기로 앱 밖에 나오면 Activity 이름만 같아서는 이어 가지 않는다 (다른 탭·스플래시를 시작 화면으로 오인하지 않게)', async () => {
  const f = fakeDevice(appDef, 'resume-5');
  // 시작 화면 id 는 home 이지만 지금 루트 화면의 구조가 달라 id 가 맞지 않는 경우 (같은 Activity 의 다른 탭 등)
  const start = { ...(await startOf(f)), id: 'HomeActivity@different' };
  const c0 = clears(f);
  const r = await g.returnToStart(f.dev, PKG, start);
  assert.equal(r.resumed, false);
  assert.equal(r.backs, 1, '루트에서 한 번 누르고 앱 밖에 나오면 더 누르지 않음');
  assert.equal(clears(f), c0 + 1);
  assert.equal(f.screen, 'home');
});

test('resumeStartOf: 앱 밖 화면은 시작 화면으로 남기지 않는다', async () => {
  const f = fakeDevice(appDef, 'resume-7');
  const s = await g.launchAndSettle(f.dev, PKG);
  assert.equal(g.resumeStartOf(s, 'com.other.app'), undefined);
  assert.equal(g.resumeStartOf(s, PKG).activity, `${PKG}.HomeActivity`);
});

test('keepsAppState: 통과와 판정만 못 한 막힘만 이어 간다', () => {
  assert.equal(qa.keepsAppState({ status: 'pass' }), true);
  assert.equal(qa.keepsAppState({ status: 'blocked', blockedBy: 'judgment' }), true);
  assert.equal(qa.keepsAppState({ status: 'blocked', blockedBy: 'app' }), false);
  assert.equal(qa.keepsAppState({ status: 'blocked' }), false);
  assert.equal(qa.keepsAppState({ status: 'fail' }), false);
  assert.equal(qa.keepsAppState({ status: 'skip' }), false);
});

test('passEvidenceOnlyMissing: assert 만 빠졌을 때만 참, 실패로 남은 단계가 있으면 거짓', () => {
  const st = (index, status, by) => ({ index, at: 1, title: 't', status, ...(by ? { check: { by } } : {}) });
  assert.equal(qa.passEvidenceOnlyMissing({ steps: [st(1, 'pass', 'agent')] }), true);
  assert.equal(qa.passEvidenceOnlyMissing({ steps: [st(1, 'pass', 'agent'), st(2, 'fail')] }), false);
  assert.equal(qa.passEvidenceOnlyMissing({ steps: [st(1, 'pass', 'assert')] }), false, '근거가 있으면 막힘 아님');
});

// ── 회차 판단: 막힘 이유에 따라 이어 가기 ──
test('재시작 판단: 판정만 못 한 막힘(judgment) 뒤에는 이어 가고, 앱 문제 막힘·실패 뒤에는 재시작한다', () => {
  const r = qa.needsRestart;
  const cur = { preconditions: [], changesData: false };
  const prev = (status, blockedBy) => ({ status, preconditions: [], changedData: false, ...(blockedBy ? { blockedBy } : {}) });
  assert.equal(r(prev('pass'), cur), false);
  assert.equal(r(prev('blocked', 'judgment'), cur), false, '판정만 못 함');
  assert.equal(r(prev('blocked', 'app'), cur), true, '앱·환경 문제');
  assert.equal(r(prev('blocked'), cur), true, '이유를 모르면 재시작');
  assert.equal(r(prev('fail'), cur), true, '실패');
  assert.equal(r(prev('fail', 'judgment'), cur), true, '실패는 이유와 상관없이 재시작');
  assert.equal(r({ ...prev('blocked', 'judgment'), changedData: true }, cur), true, '데이터를 바꿨으면 재시작');
});

test('회차 결과에 막힘 이유(blockedBy)를 적고 읽는다. 막힘이 아니면 버린다', async () => {
  const plan = await qa.createQaPlan({ name: '막힘 이유', app: PKG });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: 'a' }],
    cases: ['TC-001', 'TC-002'].map((id) => ({ id, title: id, requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'], selected: true })),
  });
  const run = await qa.createQaRun(plan.id);
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-001', status: 'blocked', mode: 'agent', blockedBy: 'judgment', detail: '기대 결과가 모호함' });
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-002', status: 'pass', mode: 'agent', blockedBy: 'judgment' });
  const got = await qa.loadQaRun(plan.id, run.id);
  assert.equal(got.results.find((x) => x.case === 'TC-001').blockedBy, 'judgment');
  assert.equal(got.results.find((x) => x.case === 'TC-002').blockedBy, undefined, '통과에는 막힘 이유를 남기지 않음');
});

// ── 스크립트 회차: 통과 뒤 다음 TC 는 CLEAR_TASK 없이 시작 화면에서 ──
async function scriptedPlan(name, cases) {
  const plan = await qa.createQaPlan({ name, app: PKG });
  mkdirSync(join(home, 'scripts'), { recursive: true });
  for (const c of cases) {
    writeFileSync(
      join(home, 'scripts', `${plan.id}-${c.id}.yaml`),
      `name: ${c.id}\napp: ${PKG}\ntimeout: 300\ntc: { plan: ${plan.id}, case: ${c.id} }\nsteps:\n  - tap: { id: detail }\n  - ${c.ok === false ? 'wait: { text: 없는 글자 }' : 'wait: { id: price }'}\n`,
    );
  }
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '홈' }],
    cases: cases.map((c) => ({
      id: c.id,
      title: c.id,
      requirements: ['R-01'],
      priority: 'P1',
      kind: 'normal',
      steps: ['a'],
      expected: ['b'],
      selected: true,
      preconditions: [],
      script: `${plan.id}-${c.id}`,
    })),
  });
  return plan;
}

test('runQaScripts: 통과한 뒤 다음 TC 는 CLEAR_TASK 없이 시작 화면으로 돌아가 이어 가고, 실패 뒤에는 재시작한다', async () => {
  const plan = await scriptedPlan('이어 가기 159', [{ id: 'TC-001' }, { id: 'TC-002' }, { id: 'TC-003', ok: false }, { id: 'TC-004' }]);
  const f = fakeDevice(appDef, 'resume-6');
  const out = await qa.runQaScripts(f.dev, plan.id);
  assert.deepEqual(
    out.ran.map((x) => [x.case, x.status]),
    [['TC-001', 'pass'], ['TC-002', 'pass'], ['TC-003', 'fail'], ['TC-004', 'pass']],
  );
  // TC-001 처음 · TC-003 이어 가서 실패해 한 번 새로 띄워 다시 돌림 · TC-004 실패 뒤 = 3번.
  // TC-002 는 앞 TC 가 통과해 CLEAR_TASK 없이 시작 화면으로 돌아가 이어 감 (예전에는 TC 마다 CLEAR_TASK)
  assert.equal(clears(f), 3, 'CLEAR_TASK 는 처음·실패 재확인·실패 뒤에만');
  assert.equal(forceStops(f), 3);
  assert.equal(out.restarts, 3);
  assert.equal(f.commands().filter((c) => c === 'input keyevent 4').length, 2, 'TC-002·TC-003 은 뒤로 가기로 시작 화면에 돌아감');
});
