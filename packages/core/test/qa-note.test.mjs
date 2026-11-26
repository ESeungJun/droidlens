// 앱이 적는 결과 메모를 코드 값으로 남기고 언어별로 보여 준다 (#114). 빌드 결과(dist)를 시험한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');
const note = await import('../dist/qa-note.js');

const MANUAL_KO = '수동 TC 라 자동으로 실행하지 않았습니다. 사람이 확인해야 합니다';

test('코드마다 한국어는 예전 문구 그대로, 영어는 영어로', () => {
  const ko = (n) => note.qaNoteText(n, 'ko');
  const en = (n) => note.qaNoteText(n, 'en');
  assert.equal(ko({ code: 'manualSkipped' }), MANUAL_KO);
  assert.equal(ko({ code: 'needsReview' }), '다시 보기 표시가 있어 실행하지 않았습니다. 사람이 확인해야 합니다');
  assert.equal(ko({ code: 'timedOut', args: { min: 10 } }), '시간 제한(10분)을 넘겨 멈췄습니다');
  assert.equal(ko({ code: 'agentNotStarted', args: { error: 'spawn ENOENT' } }), '에이전트를 띄우지 못했습니다: spawn ENOENT');
  assert.equal(ko({ code: 'agentNoResult' }), '에이전트가 결과를 적지 않고 끝났습니다');
  assert.equal(ko({ code: 'agentNoResult', args: { error: 'exit 1' } }), '에이전트가 결과를 적지 않고 끝났습니다: exit 1');
  assert.equal(
    ko({ code: 'scriptChangedDanger', args: { more: '홈 화면까지 확인' } }),
    '스크립트 파일이 TC 에 이은 뒤 바뀌어 확인 필수 동작은 누르지 않았습니다 · 홈 화면까지 확인',
  );
  assert.equal(ko({ code: 'scriptMissing', args: { script: 'login' } }), '스크립트 파일이 없습니다: login');
  for (const code of note.QA_NOTE_CODES) {
    const args = { min: 5, error: 'E', script: 's', more: 'M' };
    const e = en({ code, args });
    assert.ok(e && !/[가-힣]/.test(e.replace('M', '')), `${code} 영어 문구에 한글이 없음: ${e}`);
    assert.ok(ko({ code, args }), `${code} 한국어 문구`);
  }
  assert.equal(en({ code: 'manualSkipped' }), 'Manual TC, not run automatically. Needs a person to check');
  assert.equal(en({ code: 'timedOut', args: { min: 10 } }), 'Stopped after the time limit (10 min)');
});

test('옛 결과의 한국어 메모를 코드로 되돌리고, 모르는 글은 그대로 둔다', () => {
  const back = note.qaNoteFromDetail;
  assert.deepEqual(back(MANUAL_KO), { code: 'manualSkipped' });
  assert.deepEqual(back('시간 제한(15분)을 넘겨 멈췄습니다'), { code: 'timedOut', args: { min: 15 } });
  assert.deepEqual(back('에이전트를 띄우지 못했습니다: claude: not found'), { code: 'agentNotStarted', args: { error: 'claude: not found' } });
  assert.deepEqual(back('에이전트가 결과를 적지 않고 끝났습니다'), { code: 'agentNoResult' });
  assert.deepEqual(back('스크립트 x 가 이 TC 의 것이 아닙니다'), { code: 'scriptOtherCase', args: { script: 'x' } });
  assert.deepEqual(back('해시 없이 이은 스크립트라 확인 필수 동작은 누르지 않았습니다 (다시 실행해 통과하면 새로 이어집니다) · 로그인 통과'), {
    code: 'scriptNoHashDanger',
    args: { more: '로그인 통과' },
  });
  assert.equal(back('로그인 화면이 안 떠서 막힘'), undefined);
  assert.equal(back(MANUAL_KO + ' 덧붙인 말'), undefined, '앞만 같은 사람 글은 바꾸지 않음');
  assert.equal(back(undefined), undefined);
  // 보여 줄 글
  assert.equal(note.qaResultMemo({ detail: MANUAL_KO }, 'en'), 'Manual TC, not run automatically. Needs a person to check');
  assert.equal(note.qaResultMemo({ detail: MANUAL_KO }, 'ko'), MANUAL_KO);
  assert.equal(note.qaResultMemo({ detail: '사람이 적은 메모' }, 'en'), '사람이 적은 메모');
  assert.equal(note.qaResultMemo({}, 'en'), undefined);
});

async function setup() {
  const plan = await qa.createQaPlan({ name: '메모 언어', app: 'com.example.app' });
  const tc = (id) => ({ id, title: `제목 ${id}`, requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'], selected: true });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '로그인' }],
    cases: [{ ...tc('TC-001'), data: 'pw=hunter2' }, tc('TC-002'), tc('TC-003'), tc('TC-004')],
  });
  const run = await qa.createQaRun(plan.id);
  // TC-001: 새로 적는 앱 메모 (코드 값). 인자 속 입력값은 가린다
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-001', status: 'blocked', mode: 'manual', note: { code: 'agentNotStarted', args: { error: 'bad hunter2' } } });
  // TC-002: 사람·에이전트가 적은 메모
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-002', status: 'skip', mode: 'manual', detail: '로그인 계정이 없어 건너뜀' });
  // TC-003: 코드 값이 없던 옛 결과 (한국어 메모만)
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-003', status: 'skip', mode: 'manual', detail: MANUAL_KO });
  // TC-004: 앱 메모 + 시나리오 요약
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-004', status: 'blocked', mode: 'manual', note: { code: 'timedOut', args: { min: 10 } } });
  return { plan, run };
}

test('앱 메모는 코드 값과 한국어 메모를 같이 남긴다 (옛 버전·도구 호환)', async () => {
  const { plan, run } = await setup();
  const r = await qa.loadQaRun(plan.id, run.id);
  const one = r.results.find((x) => x.case === 'TC-001');
  assert.deepEqual(one.note, { code: 'agentNotStarted', args: { error: 'bad ***' } }, '인자 속 입력값을 가림');
  assert.equal(one.detail, '에이전트를 띄우지 못했습니다: bad ***');
  assert.equal(r.results.find((x) => x.case === 'TC-004').detail, '시간 제한(10분)을 넘겨 멈췄습니다');
  assert.equal(r.results.find((x) => x.case === 'TC-002').note, undefined);
  // 모르는 코드는 받지 않는다
  await assert.rejects(qa.recordQaResult(plan.id, run.id, { case: 'TC-002', status: 'skip', mode: 'manual', note: { code: 'nope' } }));
});

test('영어로 내보내면 앱 메모는 영어, 사람·에이전트 메모는 그대로, 옛 결과도 영어', async () => {
  const { plan, run } = await setup();
  const { path: x } = await qa.writeQaRunExport(plan.id, run.id, 'xlsx', 'en');
  const s1 = strFromU8(unzipSync(new Uint8Array(readFileSync(x)))['xl/worksheets/sheet1.xml']);
  const { path: h } = await qa.writeQaRunExport(plan.id, run.id, 'html', 'en');
  const html = readFileSync(h, 'utf8');
  for (const [name, out] of [['xlsx', s1], ['html', html]]) {
    assert.match(out, /Could not start the agent: bad \*\*\*/, `${name}: 새 앱 메모`);
    assert.match(out, /Stopped after the time limit \(10 min\)/, `${name}: 시간 제한`);
    assert.match(out, /Manual TC, not run automatically/, `${name}: 옛 결과`);
    assert.match(out, /로그인 계정이 없어 건너뜀/, `${name}: 사람 메모는 그대로`);
    assert.doesNotMatch(out, /수동 TC 라|에이전트를 띄우지|시간 제한\(/, `${name}: 앱 메모 한국어가 남지 않음`);
    assert.doesNotMatch(out, /hunter2/, `${name}: 입력값`);
  }
  // 한국어 내보내기는 예전 그대로
  const { path: k } = await qa.writeQaRunExport(plan.id, run.id, 'html', 'ko');
  const ko = readFileSync(k, 'utf8');
  assert.match(ko, /수동 TC 라 자동으로 실행하지 않았습니다/);
  assert.match(ko, /에이전트를 띄우지 못했습니다: bad \*\*\*/);
});

test('스크립트를 못 읽은 막힘도 코드 값으로 남는다', async () => {
  const plan = await qa.createQaPlan({ name: '스크립트 막힘', app: 'com.example.app' });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '로그인' }],
    cases: [{ id: 'TC-001', title: 'a', requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'], selected: true, script: 'missing-one' }],
  });
  const res = await qa.readCaseScript(plan.id, (await qa.loadQaPlan(plan.id)).cases[0]);
  assert.deepEqual(res.note, { code: 'scriptMissing', args: { script: 'missing-one' } });
  assert.equal(res.error, '스크립트 파일이 없습니다: missing-one');
  const out = await qa.runQaScripts({}, plan.id);
  assert.deepEqual(out.ran[0].note, { code: 'scriptMissing', args: { script: 'missing-one' } });
  assert.equal(out.ran[0].detail, '스크립트 파일이 없습니다: missing-one');
});

// 회차 파일을 직접 고친 옛 결과도 읽힌다 (note 칸 없는 파일)
test('note 칸이 없는 옛 회차 파일도 그대로 읽는다', async () => {
  const { plan, run } = await setup();
  const f = join(home, 'qa', plan.id, 'runs', run.id, 'run.json');
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  for (const r of raw.results) delete r.note;
  writeFileSync(f, JSON.stringify(raw));
  const r = await qa.loadQaRun(plan.id, run.id);
  assert.equal(note.qaResultMemo(r.results.find((x) => x.case === 'TC-004'), 'en'), 'Stopped after the time limit (10 min)');
});
