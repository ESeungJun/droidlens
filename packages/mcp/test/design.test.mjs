// 디자인 비교 도구 (#77): design_guide_save · design_compare · 회차 결과표에 붙는 디자인 차이 (가짜 adb, 합성 시안)
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { start, ui, solidPng } from './harness.mjs';

let s;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

const FIGMA = 'https://www.figma.com/design/AbCdEf123/Sample?node-id=1-2';
const METADATA = `<frame id="1:2" name="설정 화면" x="0" y="0" width="360" height="640">
  <text id="1:3" name="설정" x="20" y="56" width="40" height="28" />
  <text id="1:5" name="알림 받기" x="20" y="120" width="80" height="21" />
</frame>`;
const CODE = `<div className="bg-white" data-node-id="1:2"><p className="text-[20px] text-[#191919]" data-node-id="1:3">설정</p><p className="text-[15px] text-[#191919]" data-node-id="1:5">알림 받기</p></div>`;

async function newPlan() {
  const r = await s.call('qa_plan_create', { name: '디자인 QA', app: 'com.example.app' });
  const id = r.text.match(/QA 계획을 만들었습니다: (\S+)/)[1];
  const saved = await s.call('qa_plan_save', {
    plan: id,
    requirements: [{ id: 'R-01', text: '설정 화면은 시안대로' }],
    cases: [
      {
        id: 'TC-001',
        title: '설정 화면 디자인',
        requirements: ['R-01'],
        priority: 'P1',
        kind: 'design',
        steps: ['설정 열기'],
        expected: ['시안과 같다'],
        design: { figma: FIGMA },
      },
      { id: 'TC-002', title: '일반', requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'] },
    ],
  });
  assert.equal(saved.isError, false, saved.text);
  return id;
}

// 가짜 기기: 1080×2400, density 420 → 411×914dp. '설정'만 있고 '알림 받기'는 없다
const screen = () =>
  ui(
    { text: '설정', bounds: [53, 147, 158, 220] },
    { text: '새 기능', bounds: [660, 280, 820, 330] },
    { text: '맨 아래', bounds: [53, 2300, 300, 2350] },
  );

test('design_guide_save: 디자인 TC 에만, 커넥터 응답으로 가이드를 저장한다', async () => {
  const plan = await newPlan();
  const bad = await s.call('design_guide_save', { plan, case: 'TC-002', metadata: METADATA });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Figma 링크/);
  assert.equal((await s.call('design_guide_save', { plan, case: 'TC-001' })).isError, true, '응답이 없으면 오류');
  const r = await s.call('design_guide_save', { plan, case: 'TC-001', metadata: METADATA, code: [CODE] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /프레임 "설정 화면" 360×640 · 배율 1dp\/px/);
  assert.match(r.text, /글자 2 · 크기 아는 글자 2 · 색 아는 글자 2/);
  assert.match(r.text, /FIGMA_TOKEN 을 설정하면/, '토큰이 없으면 이미지는 받지 않고 알린다 (#89)');
});

test('design_compare: 차이 목록·리포트, 진행 중인 TC 시나리오면 plan·case·run 을 생략하고 회차 결과표에 붙는다', async () => {
  const plan = await newPlan();
  await s.call('design_guide_save', { plan, case: 'TC-001', metadata: METADATA, code: [CODE] });
  s.setUi(screen());
  s.setFile('shot.png', solidPng(1080, 2400));

  const noGuide = await s.call('design_compare', {});
  assert.equal(noGuide.isError, true);
  assert.match(noGuide.text, /plan·case/);

  const last = await s.call('design_compare', { plan, case: 'TC-001' });
  assert.equal(last.isError, false, last.text);
  assert.match(last.text, /TC-001 디자인 비교: 차이 \d+건/);
  assert.match(last.text, /\[높음\] 화면에 없음 "알림 받기"/);
  assert.match(last.text, /\[중간\] 가이드에 없음 "새 기능"/);
  assert.ok(!last.text.includes('맨 아래'), '가이드 범위 밖의 글자는 세지 않는다');
  assert.match(last.text, /글자 크기 높이로 추정/);
  assert.match(last.text, /상자 \d+개 비교/);
  const report = last.text.match(/리포트: (.+report\.html)/)[1];
  assert.ok(report.includes('/design/TC-001/last/'), report);
  assert.ok(existsSync(report));

  const run = (await s.call('qa_run_scripts', { plan })).text.match(/회차 (\d{8}-\d{6}(?:_\d+)?)/)[1];
  const st = await s.call('scenario_start', { name: '디자인', packageName: 'com.example.app', tc: { plan, case: 'TC-001', run } });
  assert.equal(st.isError, false, st.text);
  const inRun = await s.call('design_compare', {});
  assert.equal(inRun.isError, false, inRun.text);
  assert.match(inRun.text, new RegExp(`리포트: .+/runs/${run}/design/TC-001/report\\.html`));
  assert.match(inRun.text, /scenario_step\(assert\)/);
  await s.call('scenario_finish', { verdict: 'fail', summary: '시안과 다름' });
  const rep = await s.call('qa_report', { plan, run });
  const html = readFileSync(rep.text.match(/결과표: (.+)/)[1], 'utf8');
  assert.match(html, /디자인 차이 \d+건 \(높음 \d+\)/);
  assert.match(html, /디자인 비교<\/a>/);
});
