// QA 회차 실행·결과 (#76): qa_run_scripts · scenario_start(tc.run) · qa_case_result · qa_report · CLI qa run
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_ADB, SERVER, start, ui } from './harness.mjs';

let s;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

const requirements = [
  { id: 'R-01', text: '다음 화면으로 넘어간다' },
  { id: 'R-02', text: '계정을 지울 수 있다' },
];
const cases = [
  {
    id: 'TC-001',
    title: '다음 누르기',
    requirements: ['R-01'],
    priority: 'P1',
    kind: 'normal',
    steps: ['다음 누르기'],
    expected: ['다음 버튼이 보임'],
  },
  {
    id: 'TC-002',
    title: '빈 화면',
    requirements: ['R-01'],
    priority: 'P0',
    kind: 'exception',
    steps: ['앱 열기'],
    expected: ['빈 화면 안내'],
  },
  {
    id: 'TC-003',
    title: '계정 삭제',
    requirements: ['R-02'],
    priority: 'P2',
    kind: 'normal',
    steps: ['삭제 누르기'],
    expected: ['삭제 완료'],
    danger: '계정 삭제',
  },
];
const screen = () => ui({ cls: 'android.widget.Button', text: '다음', bounds: [0, 0, 100, 100], clickable: true });

async function newPlan() {
  const r = await s.call('qa_plan_create', { name: '회귀 QA', app: 'com.example.app' });
  const id = r.text.match(/QA 계획을 만들었습니다: (\S+)/)[1];
  const saved = await s.call('qa_plan_save', { plan: id, requirements, cases });
  assert.equal(saved.isError, false, saved.text);
  return id;
}
const runOf = (t) => t.match(/회차 (\d{8}-\d{6}(?:_\d+)?)/)[1];
const runJson = (plan, run) => JSON.parse(readFileSync(join(s.dir, 'home', 'qa', plan, 'runs', run, 'run.json'), 'utf8'));

/** 서버와 같은 가짜 기기·같은 폴더로 CLI 를 돌린다 */
function cli(...args) {
  const r = spawnSync(process.execPath, [SERVER, 'qa', ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      ADB_PATH: FAKE_ADB,
      FAKE_ADB_DIR: s.dir,
      DROIDLENS_HOME: join(s.dir, 'home'),
      DROIDLENS_AGENT: '0',
      DROIDLENS_SERIAL: 'fake',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('첫 회차: 스크립트 없는 TC 는 우선순위 순으로 넘기고, 에이전트가 돌린 결과가 회차에 적히며 스크립트가 이어진다', async () => {
  const id = await newPlan();
  s.setUi(screen());
  const first = await s.call('qa_run_scripts', { plan: id });
  assert.equal(first.isError, false, first.text);
  const run = runOf(first.text);
  assert.match(first.text, /스크립트로 0개 실행/);
  // 고른 TC 만(확인 필수 TC-003 은 기본으로 고르지 않음), P0 이 먼저
  const pend = first.text.slice(first.text.indexOf('스크립트가 없는 TC'));
  assert.ok(pend.indexOf('TC-002') < pend.indexOf('TC-001'), pend);
  assert.ok(!pend.includes('TC-003'), pend);

  // 없는 회차로는 시작하지 않는다 (기기를 건드리기 전에)
  const bad = await s.call('scenario_start', { name: 'x', tc: { plan: id, case: 'TC-001', run: '20000101-000000' } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /회차가 없습니다/);

  assert.equal((await s.call('scenario_start', { name: '다음', tc: { plan: id, case: 'TC-001', run } })).isError, false);
  assert.equal((await s.call('tap', { text: '다음' })).isError, false);
  await s.call('scenario_step', { title: '다음 버튼이 보임', assert: { visible: { text: '다음' } }, screenshot: false });
  const fin = await s.call('scenario_finish', { verdict: 'pass', summary: '다음으로 넘어감' });
  assert.match(fin.text, /TC-001 에 스크립트를 이었습니다/);
  assert.match(fin.text, new RegExp(`회차 ${run} 에 TC-001 결과\\(pass\\)를 적었습니다`));
  const r1 = runJson(id, run).results.find((x) => x.case === 'TC-001');
  assert.equal(r1.status, 'pass');
  assert.equal(r1.mode, 'agent');
  assert.equal(r1.script, 'TC-001_다음');
  assert.ok(r1.report?.endsWith('.html'));
  const plan = JSON.parse((await s.call('qa_plan_get', { plan: id, full: true })).text);
  assert.match(plan.cases[0].scriptHash, /^[0-9a-f]{64}$/);

  // 실행한 통과·실패는 건너뜀·막힘으로 덮지 못한다. 안 돌린 TC 는 이유와 함께 적는다
  const hide = await s.call('qa_case_result', { plan: id, run, case: 'TC-001', status: 'skip', reason: '시간 없음' });
  assert.equal(hide.isError, true);
  assert.match(hide.text, /이미 실행해 통과/);
  // 검사(assert) 없이 pass 로 끝내면 통과로 적지 않고 막힘으로 적는다. 스크립트도 잇지 않는다
  await s.call('scenario_start', { name: '빈 화면', tc: { plan: id, case: 'TC-002', run } });
  const empty = await s.call('scenario_finish', { verdict: 'pass', summary: '빈 화면 안내가 보임' });
  assert.match(empty.text, /TC-002 는 통과로 보지 않았습니다/);
  assert.ok(!/TC-002 에 스크립트를 이었습니다/.test(empty.text));
  assert.equal(runJson(id, run).results.find((x) => x.case === 'TC-002').status, 'blocked');
  // 실행해서 나온 막힘도 건너뜀으로 덮지 못한다
  const wash = await s.call('qa_case_result', { plan: id, run, case: 'TC-002', status: 'skip', reason: '나중에' });
  assert.equal(wash.isError, true);
  assert.match(wash.text, /이미 실행해 막힘/);
  // 고르지 않은 TC 에는 결과를 적지 않는다
  assert.match((await s.call('qa_case_result', { plan: id, run, case: 'TC-003', status: 'skip', reason: 'x' })).text, /고르지 않은 TC/);

  const rep = await s.call('qa_report', { plan: id, run });
  assert.equal(rep.isError, false, rep.text);
  assert.match(rep.text, /통과 1 · 실패 0 · 막힘 1 · 건너뜀 0 · 안 돌림 0/);
  assert.match(rep.text, /요구사항 2개: 통과 0 · 실패 1 · 안 돌림 1/);
  const dir = join(s.dir, 'home', 'qa', id, 'runs', run);
  const html = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.match(html, /통과 근거 없음/);
  assert.match(html, /prefers-color-scheme:dark/);
  const csv = readFileSync(join(dir, 'results.csv'), 'utf8');
  assert.ok(csv.startsWith('﻿"TC"'));
  const junit = readFileSync(join(dir, 'junit.xml'), 'utf8');
  assert.match(junit, /tests="2" failures="0" errors="1"/);
});

test('두 번째 회차: 이은 스크립트로 돌고, 스크립트가 바뀌거나 다른 TC 것이면 막는다. CLI 는 실패면 1', async () => {
  const id = await newPlan();
  s.setUi(screen());
  const run = runOf((await s.call('qa_run_scripts', { plan: id })).text);
  await s.call('scenario_start', { name: '다음', tc: { plan: id, case: 'TC-001', run } });
  await s.call('tap', { text: '다음' });
  await s.call('scenario_step', { title: '다음 버튼이 보임', assert: { visible: { text: '다음' } }, screenshot: false });
  assert.match((await s.call('scenario_finish', { verdict: 'pass', summary: 'ok' })).text, /스크립트를 이었습니다/);

  const second = await s.call('qa_run_scripts', { plan: id });
  assert.equal(second.isError, false, second.text);
  assert.notEqual(runOf(second.text), run);
  assert.match(second.text, /스크립트로 1개 실행\n {2}TC-001 통과/);

  // 스크립트가 있는 TC 를 script_run(allowDanger) 로 돌려 사람 허용을 건너뛰지 못한다
  const script = JSON.parse((await s.call('qa_plan_get', { plan: id, full: true })).text).cases[0].script;
  const sr = await s.call('script_run', { script, allowDanger: true });
  assert.equal(sr.isError, true);
  assert.match(sr.text, /qa_run_scripts/);

  // CLI: 통과면 0, JUnit 을 원하는 곳에 쓴다
  const out = join(s.dir, 'ci', 'junit.xml');
  const ok = cli('run', id, '--junit', out);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /✓ TC-001 통과/);
  assert.ok(existsSync(out));
  // --strict: 스크립트가 없어 안 돌린 TC(TC-002)가 있으면 1
  assert.equal(cli('run', id, '--strict').code, 1);

  // 화면이 바뀌어 스크립트가 실패하면 CLI 는 1
  s.setUi(ui({ cls: 'android.widget.TextView', text: '빈 화면', bounds: [0, 0, 100, 100] }));
  const fail = cli('run', id);
  assert.equal(fail.code, 1, fail.out);
  assert.match(fail.out, /✗ TC-001 (실패|막힘)/);
  s.setUi(screen());

  // 이은 스크립트의 tc 칸을 다른 TC 로 바꾸면 그 TC 는 막힘
  const file = join(s.dir, 'home', 'scripts', `${script}.yaml`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('case: TC-001', 'case: TC-002'));
  const moved = await s.call('qa_run_scripts', { plan: id });
  assert.match(moved.text, /TC-001 막힘 — 스크립트 .* 가 이 TC 의 것이 아닙니다/);
});

test('core: 회차 집계·결과표 이스케이프·CSV 수식 막기', async () => {
  const dl = await import('@droidlens/core');
  assert.equal(dl.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(dl.csvCell('-1'), `"'-1"`);
  assert.equal(dl.csvCell('보통 글'), '"보통 글"');
  const plan = dl.validatePlan({
    version: 1,
    id: 'p1',
    name: '<b>계획</b>',
    createdAt: 1,
    updatedAt: 1,
    sources: [],
    requirements: [{ id: 'R-01', text: '<script>x</script>' }],
    cases: [
      {
        id: 'TC-001',
        title: '<img src=x onerror=alert(1)>',
        requirements: ['R-01'],
        priority: 'P0',
        kind: 'normal',
        steps: ['a'],
        expected: ['b'],
        selected: true,
      },
      {
        id: 'TC-002',
        title: 'b',
        requirements: ['R-01'],
        priority: 'P1',
        kind: 'normal',
        steps: ['a'],
        expected: ['b'],
        selected: true,
        data: 'pw=secret',
      },
    ],
  });
  const run = {
    version: 1,
    id: '20260101-000000',
    plan: 'p1',
    startedAt: 1,
    results: [{ case: 'TC-001', status: 'fail', mode: 'script', detail: '"\u0001</failure>', at: 2, report: 'javascript:alert(1)' }],
  };
  const sum = dl.qaRunSummary(plan, run);
  assert.deepEqual(sum.counts, { pass: 0, fail: 1, blocked: 0, skip: 0, 'not-run': 1 });
  assert.equal(sum.requirements[0].status, 'fail');
  const html = dl.qaReportHtml(plan, run);
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>x') && !html.includes('<b>계획'));
  assert.ok(!html.includes('javascript:'), '실행기가 만든 리포트가 아니면 잇지 않는다');
  assert.ok(!dl.qaReportCsv(plan, run).includes('secret'), 'CSV 에 입력값을 넣지 않는다');
  const junit = dl.qaReportJunit(plan, run);
  assert.ok(!junit.includes('\u0001') && !junit.includes('"</failure>'));
  assert.match(junit, /<skipped message="안 돌림"\/>/);
  // 고른 순서: P0 → P1
  assert.deepEqual(
    dl.orderQaCases(plan).map((c) => c.id),
    ['TC-001', 'TC-002'],
  );
});

test('확인 필수 TC: 허용·같은 스크립트면 누르고, 파일이 바뀌면 누르지 않으며, TC 내용이 바뀌면 연결이 풀린다', async () => {
  const { setQaCaseAllowDanger, dangerFingerprint, loadQaPlan } = await import('@droidlens/core');
  process.env.DROIDLENS_HOME = join(s.dir, 'home'); // 사람이 화면에서 허용한 것처럼 계획 파일을 고친다
  try {
    const id = await newPlan();
    const allow = async () => {
      const c = (await loadQaPlan(id)).cases.find((x) => x.id === 'TC-003');
      await setQaCaseAllowDanger(id, 'TC-003', true, dangerFingerprint(c));
    };
    await allow();
    s.setUi(ui({ cls: 'android.widget.Button', text: '계정 삭제', bounds: [0, 200, 600, 300], clickable: true }));
    const run = runOf((await s.call('qa_run_scripts', { plan: id })).text);
    // 에이전트처럼 시나리오 이름을 TC 번호만으로 지어도 스크립트 이름에 번호가 한 번만 붙는다 (#92)
    await s.call('scenario_start', { name: 'TC-003', tc: { plan: id, case: 'TC-003', run } });
    assert.equal((await s.call('tap', { text: '계정 삭제', allowDanger: true })).isError, false);
    await s.call('scenario_step', { title: '버튼', assert: { visible: { text: '계정 삭제' } }, screenshot: false });
    assert.match((await s.call('scenario_finish', { verdict: 'pass', summary: 'ok' })).text, /TC-003 에 스크립트를 이었습니다/);

    // 같은 스크립트: 사람이 허용했으니 누른다
    s.clearLog();
    const same = await s.call('qa_run_scripts', { plan: id });
    assert.match(same.text, /TC-003 통과/, same.text);
    assert.ok(
      s.log().some((l) => l.includes('input tap')),
      '허용된 스크립트는 누른다',
    );

    // 파일을 고치면 확인 필수 버튼은 누르지 않는다
    const script = (await loadQaPlan(id)).cases.find((x) => x.id === 'TC-003').script;
    assert.equal(script, 'TC-003');
    const file = join(s.dir, 'home', 'scripts', `${script}.yaml`);
    writeFileSync(file, readFileSync(file, 'utf8') + '# 바뀜\n');
    s.clearLog();
    const changed = await s.call('qa_run_scripts', { plan: id });
    assert.match(changed.text, /TC-003 실패 — 스크립트 파일이 TC 에 이은 뒤 바뀌어/, changed.text);
    assert.ok(!s.log().some((l) => l.includes('input tap 300 250')), '바뀐 스크립트로는 누르지 않는다');

    // TC 내용이 바뀌면 옛 흐름의 스크립트 연결이 풀리고, 다시 허용해도 옛 스크립트로 누르지 않는다
    await s.call('qa_case_update', { plan: id, case: 'TC-003', patch: { steps: ['장바구니 비우기 누르기'] } });
    const after = (await loadQaPlan(id)).cases.find((x) => x.id === 'TC-003');
    assert.equal(after.script, undefined);
    assert.equal(after.scriptHash, undefined);
    await allow();
    const rerun = await s.call('qa_run_scripts', { plan: id });
    assert.match(rerun.text, /스크립트로 0개 실행/, rerun.text);

    // 확인 필수 표시를 빼면 다시 보기 표시가 붙는다. 고른 채여도 돌리지 않고 막힘으로 적는다
    await s.call('qa_case_update', { plan: id, case: 'TC-003', patch: { danger: '' } });
    const review = await s.call('qa_run_scripts', { plan: id });
    assert.match(review.text, /다시 보기 표시가 있어 막힘으로 적은 TC: TC-003/, review.text);
    assert.ok(!review.text.slice(review.text.indexOf('스크립트가 없는 TC')).includes('TC-003'));
    assert.equal(runJson(id, runOf(review.text)).results.find((x) => x.case === 'TC-003').status, 'blocked');
  } finally {
    delete process.env.DROIDLENS_HOME;
  }
});
