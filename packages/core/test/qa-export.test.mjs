// QA 회차 묶어 보기·내보내기 (#98): 회차 ↔ 시나리오 잇기, .xlsx 두 시트, 단계별 HTML
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { PNG } from 'pngjs';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');

async function setup() {
  const plan = await qa.createQaPlan({ name: '내보내기', app: 'com.example.app' });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '로그인' }],
    cases: [
      { id: 'TC-001', title: '정상 로그인', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'], selected: true, data: 'pw=hunter2' },
      { id: 'TC-002', title: '수식 <b>글</b>', requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'], selected: true },
      { id: 'TC-003', title: '남의 기록', requirements: ['R-01'], priority: 'P2', kind: 'normal', steps: ['a'], expected: ['b'], selected: true },
    ],
  });
  const run = await qa.createQaRun(plan.id);
  // TC-001: 시나리오 폴더 안의 기록
  const sid = '20261126-120000_TC-001';
  const sdir = join(home, 'scenarios', sid);
  mkdirSync(sdir, { recursive: true });
  const png = new PNG({ width: 20, height: 40 });
  png.data.fill(200);
  writeFileSync(join(sdir, 'step-001.png'), PNG.sync.write(png));
  writeFileSync(
    join(sdir, 'scenario.json'),
    JSON.stringify({
      id: sid,
      name: 'TC-001',
      goal: '정상 로그인',
      tc: { plan: plan.id, case: 'TC-001', run: run.id },
      startedAt: 1,
      finishedAt: 2,
      verdict: 'pass',
      dir: '/somewhere/else',
      steps: [
        { index: 1, at: 1, title: '로그인 확인', status: 'pass', screenshot: 'step-001.png', check: { by: 'assert', expect: '홈', actual: '홈' }, actions: [{ at: 1, text: '탭 "로그인"' }, { at: 1, text: '입력 "hunter2"' }] },
        { index: 2, at: 2, title: '<script>x</script>', status: 'fail', screenshot: '../../secret.png' },
      ],
    }),
  );
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-001', status: 'pass', mode: 'agent', report: join(sdir, 'report.html') });
  // TC-003: 시나리오 폴더 안이지만 다른 TC 의 기록을 가리키면 붙이지 않는다
  const oid = '20261126-120500_other';
  mkdirSync(join(home, 'scenarios', oid), { recursive: true });
  writeFileSync(
    join(home, 'scenarios', oid, 'scenario.json'),
    JSON.stringify({ id: oid, name: '남의 기록', tc: { plan: plan.id, case: 'TC-001', run: run.id }, startedAt: 1, steps: [{ index: 1, at: 1, title: '남의 단계', status: 'pass' }] }),
  );
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-003', status: 'pass', mode: 'agent', report: join(home, 'scenarios', oid, 'report.html') });
  // TC-002: 시나리오 폴더 밖을 가리키는 기록은 읽지 않는다
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-002', status: 'fail', mode: 'agent', report: join(home, 'elsewhere', 'report.html'), detail: '=HYPERLINK("x")' });
  return { plan, run, sid, oid };
}

test('회차 목록은 회차 결과가 가리키는 시나리오 폴더만 잇는다', async () => {
  const { plan, run, sid, oid } = await setup();
  const idx = await qa.qaRunIndex();
  const item = idx.find((x) => x.run === run.id && x.plan === plan.id);
  assert.ok(item);
  assert.equal(item.planName, '내보내기');
  assert.deepEqual(item.scenarios, [sid, oid], '시나리오 폴더 밖 경로는 빼고');
  assert.equal(item.counts.pass, 2);
  assert.equal(item.counts.fail, 1);
  const b = await qa.loadQaRunBundle(plan.id, run.id);
  assert.equal(b.scenarios.get('TC-001').dir, join(home, 'scenarios', sid), '기록 안의 dir 대신 실제 폴더');
  assert.equal(b.scenarios.has('TC-002'), false);
  assert.equal(b.scenarios.has('TC-003'), false, '다른 TC 의 기록은 붙이지 않음');
});

test('.xlsx 는 요약·단계 두 시트, 입력값은 넣지 않고 글은 이스케이프한다', async () => {
  const { plan, run } = await setup();
  const { path: p, bytes } = await qa.writeQaRunExport(plan.id, run.id, 'xlsx');
  assert.equal(bytes, readFileSync(p).length);
  assert.match(p, /results\.xlsx$/);
  const z = unzipSync(new Uint8Array(readFileSync(p)));
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'])
    assert.ok(z[f], `${f} 이 있어야 함`);
  const wb = strFromU8(z['xl/workbook.xml']);
  assert.match(wb, /name="요약"/);
  assert.match(wb, /name="단계"/);
  const s1 = strFromU8(z['xl/worksheets/sheet1.xml']);
  assert.match(s1, /정상 로그인/);
  assert.match(s1, /수식 &lt;b&gt;글&lt;\/b&gt;/);
  assert.match(s1, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;x&quot;\)/, '수식처럼 보여도 글 칸(inlineStr)');
  assert.doesNotMatch(s1, /<f>/, '수식 칸 없음');
  assert.doesNotMatch(s1 + strFromU8(z['xl/worksheets/sheet2.xml']), /hunter2/, 'TC 입력값은 넣지 않음');
  const s2 = strFromU8(z['xl/worksheets/sheet2.xml']);
  assert.match(s2, /탭 &quot;로그인&quot;/);
  assert.match(s2, /&lt;script&gt;/);
});

test('단계별 HTML 은 캡처를 data URI 로 넣고, 폴더 밖 캡처·스크립트 글은 넣지 않는다', async () => {
  const { plan, run } = await setup();
  const { path: p } = await qa.writeQaRunExport(plan.id, run.id, 'html');
  const html = readFileSync(p, 'utf8');
  assert.match(html, /data:image\/jpeg;base64,/);
  assert.equal((html.match(/data:image/g) ?? []).length, 1, '../ 캡처는 읽지 않음');
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /id="TC-002"/);
  assert.doesNotMatch(html, /hunter2/, '단계 글 속 TC 입력값도 가림');
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;[^"]*script-src 'sha256-/);
  assert.doesNotMatch(html, /남의 단계/, '다른 TC 의 기록은 붙이지 않음');
});

test('maskScenario 는 글 칸마다 입력값을 가리고, 형식이 틀리면 버린다', () => {
  const d = { id: 'x', name: 'a hunter2', startedAt: 1, dir: '/d', summary: 'pw hunter2', steps: [{ index: 1, at: 1, title: 'hunter2 입력', status: 'pass', detail: 'hunter2', check: { by: 'agent', actual: 'hunter2' } }] };
  const m = qa.maskScenario(d, 'pw=hunter2');
  assert.doesNotMatch(JSON.stringify(m), /hunter2/);
  assert.equal(qa.maskScenario({ ...d, steps: [{ index: 1, title: 1, status: 'pass' }] }, undefined), undefined);
  assert.equal(qa.maskScenario({ ...d, steps: 'x' }, undefined), undefined);
});

test('영어로 내보내면 고정 문구가 영어, 사용자 글은 그대로 (#106)', async () => {
  const { plan, run } = await setup();
  const { path: x } = await qa.writeQaRunExport(plan.id, run.id, 'xlsx', 'en');
  const z = unzipSync(new Uint8Array(readFileSync(x)));
  const wb = strFromU8(z['xl/workbook.xml']);
  assert.match(wb, /name="Summary"/);
  assert.match(wb, /name="Steps"/);
  const s1 = strFromU8(z['xl/worksheets/sheet1.xml']);
  assert.match(s1, />Priority</);
  assert.match(s1, />Pass</);
  assert.match(s1, /정상 로그인/, 'TC 제목은 그대로');
  const { path: h } = await qa.writeQaRunExport(plan.id, run.id, 'html', 'en');
  const html = readFileSync(h, 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<th>Title<\/th>/);
  assert.doesNotMatch(html, /기록 판정|단계 기록이 없습니다/);
});

test('캡처 축소본을 남겨 다음 내보내기에 다시 쓰고, 원본이 바뀌면 다시 만든다 (#104)', async () => {
  const { plan, run, sid } = await setup();
  const dir = join(home, 'scenarios', sid);
  await qa.writeQaRunExport(plan.id, run.id, 'html');
  const cache = join(dir, 'step-001.480q70.jpg');
  assert.ok(existsSync(cache), '축소본을 남김');
  writeFileSync(cache, Buffer.from('ffd8ffe0', 'hex'));
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'step-001.png'), past, past);
  const html = readFileSync((await qa.writeQaRunExport(plan.id, run.id, 'html')).path, 'utf8');
  assert.match(html, /data:image\/jpeg;base64,\/9j\/4A==/, '원본보다 새 축소본은 그대로 씀');
  const png = new PNG({ width: 20, height: 40 });
  png.data.fill(50);
  writeFileSync(join(dir, 'step-001.png'), PNG.sync.write(png));
  utimesSync(cache, past, past);
  const html2 = readFileSync((await qa.writeQaRunExport(plan.id, run.id, 'html')).path, 'utf8');
  assert.doesNotMatch(html2, /\/9j\/4A==/, '원본이 바뀌면 다시 만듦');
});

