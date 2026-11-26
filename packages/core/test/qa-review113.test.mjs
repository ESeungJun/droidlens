// #113 (#107 리뷰 지적) · #115 (TC 스크립트에 그 실행 값 저장): 시나리오 기록을 다시 읽는 경로의 검사와 회귀 스크립트 경고
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
const outside = mkdtempSync(join(import.meta.dirname, '.test-outside-'));
process.env.DROIDLENS_HOME = home;
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const qa = await import('../dist/qa/index.js');
const { Scenario, renderReport } = await import('../dist/scenario.js');
const { tcName, scenarioStale } = await import('../dist/scenario-view.js');
const { volatileChecks, volatileWarning } = await import('../dist/script.js');

const sdir = (id) => join(home, 'scenarios', id);
function record(id, data) {
  mkdirSync(sdir(id), { recursive: true });
  writeFileSync(join(sdir(id), 'scenario.json'), JSON.stringify({ id, name: id, startedAt: 1, steps: [], dir: '/elsewhere', ...data }));
}

test('링크 걸린 시나리오 폴더는 따라가지 않고, 바깥 파일을 덮어쓰지 않는다', async () => {
  mkdirSync(join(home, 'scenarios'), { recursive: true });
  writeFileSync(join(outside, 'scenario.json'), JSON.stringify({ id: 'x', name: 'x', startedAt: 1, steps: [], tc: { plan: 'p1', case: 'TC-001', run: 'r1' } }));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'ORIGINAL');
  symlinkSync(victim, join(outside, 'report.html'));
  symlinkSync(outside, sdir('20991231-000000_evil'));
  const closed = await qa.closeOpenTcScenarios('p1', 'r1', '멈춤');
  assert.deepEqual(closed, []);
  assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL');
  rmSync(sdir('20991231-000000_evil'));
});

test('폴더 안 report.html 이 링크여도 링크가 가리키는 파일에 쓰지 않는다', async () => {
  record('20991230-000000_link', { tc: { plan: 'p2', case: 'TC-001', run: 'r1' } });
  const victim = join(outside, 'victim2.txt');
  writeFileSync(victim, 'ORIGINAL');
  symlinkSync(victim, join(sdir('20991230-000000_link'), 'report.html'));
  const closed = await qa.closeOpenTcScenarios('p2', 'r1', '멈춤');
  assert.equal(closed.length, 1);
  assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', '링크 대상은 그대로');
  assert.match(readFileSync(join(sdir('20991230-000000_link'), 'report.html'), 'utf8'), /^<!doctype html>/);
});

test('형식이 틀린 기록은 마무리하지 않고, 리포트의 숫자 칸에 글이 들어가지 않는다', async () => {
  const bad = '1"><script>alert(1)</script><i x="';
  record('20991229-000000_bad', { tc: { plan: 'p3', case: 'TC-001', run: 'r1' }, steps: [{ index: bad, at: 1, title: 't', status: 'pass' }] });
  assert.deepEqual(await qa.closeOpenTcScenarios('p3', 'r1', '멈춤'), []);
  const html = renderReport({ id: 'y', name: 'y', startedAt: 1, finishedAt: 2, dir: '/d', steps: [{ index: bad, at: bad, title: 't', status: 'fail' }] });
  assert.doesNotMatch(html, /<script>alert/);
});

test('since: 이 실행이 띄운 기록만 닫는다', async () => {
  record('20991228-000000_old', { startedAt: 1000, tc: { plan: 'p4', case: 'TC-001', run: 'r1' } });
  record('20991228-000001_new', { startedAt: 5000, tc: { plan: 'p4', case: 'TC-002', run: 'r1' } });
  const closed = await qa.closeOpenTcScenarios('p4', 'r1', '멈춤', { since: 2000 });
  assert.deepEqual(closed.map((x) => x.case), ['TC-002']);
});

test('마무리된 기록을 끝나지 않은 메모리 값으로 덮어쓰지 않는다', async () => {
  const s = await Scenario.start('늦은 서버');
  const file = join(s.data.dir, 'scenario.json');
  // 앱이 디스크에서 기록을 막힘으로 마무리한다
  const closer = new Scenario(JSON.parse(readFileSync(file, 'utf8')));
  await closer.finish('blocked', '회차를 멈춤');
  // 늦게 꺼지는 MCP 서버가 처리 중이던 단계를 적는다
  await s.step('늦은 단계', 'pass');
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.verdict, 'blocked');
  assert.ok(disk.finishedAt);
});

test('축소본 캐시는 버전 붙은 이름, 링크·JPEG 아닌 파일은 싣지 않는다', async () => {
  const plan = await qa.createQaPlan({ name: '캐시', app: 'com.example.app' });
  await qa.saveQaPlan({ ...plan, requirements: [{ id: 'R-01', text: '캐시' }], cases: [{ id: 'TC-001', title: 'a', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'], selected: true }] });
  const run = await qa.createQaRun(plan.id);
  const id = '20261126-130000_TC-001';
  mkdirSync(sdir(id), { recursive: true });
  const png = new PNG({ width: 20, height: 40 });
  png.data.fill(120);
  writeFileSync(join(sdir(id), 'step-001.png'), PNG.sync.write(png));
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'TOP-SECRET-KEY');
  symlinkSync(secret, join(sdir(id), 'step-002.jpg'));
  writeFileSync(join(sdir(id), 'step-003.jpg'), 'not a jpeg');
  writeFileSync(
    join(sdir(id), 'scenario.json'),
    JSON.stringify({
      id, name: 'TC-001', tc: { plan: plan.id, case: 'TC-001', run: run.id }, startedAt: 1, finishedAt: 2, verdict: 'pass', dir: sdir(id),
      steps: [1, 2, 3].map((i) => ({ index: i, at: 1, title: `s${i}`, status: 'pass', screenshot: i === 1 ? 'step-001.png' : `step-00${i}.jpg` })),
    }),
  );
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-001', status: 'pass', mode: 'agent', report: join(sdir(id), 'report.html') });
  // 링크로 바꿔치기한 캐시도 싣지 않는다
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(sdir(id), 'step-001.png'), past, past);
  symlinkSync(secret, join(sdir(id), 'step-001.480q70.jpg'));
  const html = readFileSync((await qa.writeQaRunExport(plan.id, run.id, 'html')).path, 'utf8');
  assert.doesNotMatch(html, new RegExp(Buffer.from('TOP-SECRET-KEY').toString('base64').slice(0, 12)));
  assert.equal((html.match(/data:image\/jpeg/g) ?? []).length, 1, 'PNG 에서 다시 줄인 것 하나만');
});

test('tcName 빈 번호는 그대로, scenarioStale 은 단계가 아주 많아도 된다', () => {
  assert.equal(tcName('', ''), '');
  assert.equal(tcName('', '  '), '  ');
  const steps = Array.from({ length: 200_000 }, (_, i) => ({ at: i }));
  assert.equal(scenarioStale({ startedAt: 0, steps }, 200_000 + 60_000), false);
});

test('volatileChecks: 숫자가 든 정확 일치 대기·검사를 찾고 textContains 를 제안한다 (#115)', () => {
  const found = volatileChecks([
    { tap: { text: 'DB에 메모 추가' } },
    { wait: { text: 'note #9', timeout: 5000 } },
    { wait: { text: 'note #9', gone: true } },
    { assert: { visible: { text: '42' } } },
    { assert: { text: { of: { id: 'count' }, equals: '총 3개' } } },
    { assert: { visible: { textContains: 'note #' } } },
    { assert: { visible: { text: '저장됨' } } },
  ]);
  assert.deepEqual(
    found.map((f) => [f.step, f.where, f.suggest]),
    [
      [2, 'wait.text', 'note #'],
      [4, 'assert.visible.text', undefined],
      [5, 'assert.text.equals', '총'],
    ],
  );
  const w = volatileWarning(found).join('\n');
  assert.match(w, /2단계 wait\.text = "note #9" → textContains: "note #"/);
  assert.deepEqual(volatileWarning([]), []);
});
