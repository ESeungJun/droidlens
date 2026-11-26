// 문서 종류별 검증 갈래 (#129): TC 표는 모델 없이 원문 그대로 가져오고, 에이전트가 만든 TC 는 추가 제안으로 따로 둔다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');

const files = join(home, 'in');
mkdirSync(files, { recursive: true });
const put = (name, data) => {
  const p = join(files, name);
  writeFileSync(p, data);
  return p;
};

/** 원문 칸들 (줄바꿈·앞뒤 공백·따옴표·특수 문자 포함) */
const ROWS = [
  ['TC_001', '홈 화면 숏컷 노출', '앱 13.10.0 설치\n로그인 상태', '1. 앱을 연다\n2. 홈 탭을 누른다', '고정형 숏컷 영역이 보인다\n"찜" 버튼이 첫 칸에 있다', '상', '비고 <b>굵게</b>'],
  ['TC_002', '숏컷 누르면 이동', '홈 화면', '1. "커뮤니티" 를 누른다', '커뮤니티 웹 화면이 열린다', 'High', ''],
  ['TC_003', '기대 결과 없는 행', '', '1. 아무것도 안 한다', '', 'P2', ''],
];
const HEAD = ['TC ID', '테스트 항목', '사전 조건', '테스트 절차', '기대 결과', '우선순위', '비고'];

function makeXlsx(rows, { title = true } = {}) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (v, r, c) => `<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const all = [...(title ? [['고정형 숏컷 QA 시나리오']] : []), HEAD, ...rows];
  const xml = all.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => (v === '' ? '' : cell(v, i + 1, c))).join('')}</row>`).join('');
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="TC 시트" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`,
    ),
  });
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const makeCsv = (rows) => [HEAD, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
const lines = (s) => s.split('\n').filter((x) => x.trim() !== '');

test('머리글 별칭으로 열을 찾는다 (한국어·영어), 낯선 머리글은 ok=false', () => {
  const ko = qa.detectTcColumns(HEAD);
  assert.equal(ko.ok, true);
  assert.deepEqual(ko.map, { id: 0, title: 1, preconditions: 2, steps: 3, expected: 4, priority: 5, notes: 6 });
  const en = qa.detectTcColumns(['No', 'Title', 'Spec', 'Priority', 'Type', 'Preconditions', 'Steps', 'Expected']);
  assert.equal(en.ok, true);
  assert.equal(en.map.steps, 6);
  assert.equal(en.map.expected, 7);
  assert.equal(en.map.priority, 3);
  assert.equal(qa.detectTcColumns(['이름', '나이', '주소']).ok, false);
});

test('xlsx TC 표를 넣으면 모델 없이 원문 그대로 TC 갈래로 들어간다', async () => {
  const plan = await qa.createQaPlan({ name: '표 가져오기' });
  const t0 = performance.now();
  const r = await qa.addQaSource(plan.id, put('tc.xlsx', makeXlsx(ROWS)));
  const ms = performance.now() - t0;
  assert.equal(r.tcImport?.cases, 3);
  assert.ok(ms < 2000, `가져오기 ${ms}ms`);
  const p = await qa.loadQaPlan(plan.id);
  assert.equal(p.cases.length, 3);
  for (const [i, row] of ROWS.entries()) {
    const c = p.cases[i];
    assert.equal(c.track, 'tc');
    assert.equal(qa.caseTrack(c), 'tc');
    assert.equal(c.title, row[1], '제목 원문 그대로');
    assert.deepEqual(c.preconditions, lines(row[2]), '사전 조건 줄마다 원문 그대로');
    assert.deepEqual(c.steps, lines(row[3]), '단계 원문 그대로');
    if (row[4]) assert.deepEqual(c.expected, lines(row[4]), '기대 결과 원문 그대로');
    assert.match(c.notes ?? '', new RegExp(`원본 번호: ${row[0]}`));
    assert.equal(c.source?.source, r.source.id);
    assert.match(c.source?.locator ?? '', /TC 시트 \d+행/);
    assert.deepEqual(c.requirements, [], 'TC 문서 갈래는 요구사항 없이도 된다');
  }
  assert.equal(p.cases[0].priority, 'P0', '상 → P0');
  assert.equal(p.cases[1].priority, 'P0', 'High → P0');
  assert.match(p.cases[0].notes ?? '', /비고 <b>굵게<\/b>/, '비고도 원문');
  // 기대 결과가 빈 행: 들어오되 다시 보기로 표시
  assert.equal(p.cases[2].expected.length, 1);
  assert.ok(r.tcImport.warnings.some((w) => /기대 결과/.test(w)));
});

test('csv TC 표도 같은 결과, 같은 파일을 다시 넣으면 두 번 들어가지 않는다', async () => {
  const plan = await qa.createQaPlan({ name: 'csv 가져오기' });
  const f = put('tc.csv', makeCsv(ROWS));
  const r = await qa.addQaSource(plan.id, f);
  assert.equal(r.tcImport?.cases, 3);
  const again = await qa.addQaSource(plan.id, f);
  assert.equal(again.duplicate, true);
  const p = await qa.loadQaPlan(plan.id);
  assert.equal(p.cases.length, 3);
  assert.deepEqual(p.cases[0].steps, ['1. 앱을 연다', '2. 홈 탭을 누른다']);
});

test('머리글을 못 알아본 표는 열 고르기 후보를 돌려주고, 고른 열로 가져온다', async () => {
  const plan = await qa.createQaPlan({ name: '열 고르기' });
  const rows = [['번호', '무엇', '어떻게', '결과'], ['A-1', '첫 화면', '앱 실행', '홈이 보인다']];
  const r = await qa.addQaSource(plan.id, put('odd.csv', rows.map((x) => x.join(',')).join('\n')));
  assert.equal(r.tcImport, undefined);
  assert.equal(r.tcTables?.[0].headers.join('|'), '번호|무엇|어떻게|결과');
  const done = await qa.importQaTcTable(plan.id, r.source.id, { sheet: r.tcTables[0].sheet, headerRow: r.tcTables[0].headerRow, map: { id: 0, title: 1, steps: 2, expected: 3 } });
  assert.equal(done.cases, 1);
  const p = await qa.loadQaPlan(plan.id);
  assert.equal(p.cases[0].title, '첫 화면');
  assert.deepEqual(p.cases[0].steps, ['앱 실행']);
});

test('에이전트 저장은 TC 문서 갈래를 바꾸지 못하고, 새 TC 는 추가 제안(안 고름)이 된다', async () => {
  const plan = await qa.createQaPlan({ name: '추가 제안' });
  await qa.addQaSource(plan.id, put('tc2.xlsx', makeXlsx(ROWS.slice(0, 2))));
  const prev = await qa.loadQaPlan(plan.id);
  const tampered = prev.cases.map((c) => ({ ...c, title: '바꿈', steps: ['바꿈'], requirements: ['R-01'] }));
  const next = await qa.saveAgentQaPlan(plan.id, {
    requirements: [{ id: 'R-01', text: '숏컷' }, { id: 'R-02', text: '배너' }],
    cases: [
      ...tampered.slice(0, 1), // 둘째 TC 는 빠뜨림 (지워지면 안 됨)
      { id: 'TC-010', title: '배너 노출', requirements: ['R-02'], priority: 'P1', kind: 'normal', steps: ['홈'], expected: ['배너'] },
      { id: 'TC-011', title: '배너 예외', requirements: ['R-02'], priority: 'P2', kind: 'exception', steps: ['홈'], expected: ['없음'], track: 'tc' },
      { id: 'TC-012', title: '홈 화면 디자인', priority: 'P1', kind: 'design', steps: ['홈'], expected: ['Figma 와 같다'], design: { figma: 'https://www.figma.com/design/abc/x?node-id=1-2' } },
    ],
  });
  const design = next.cases.find((c) => c.id === 'TC-012');
  assert.equal(design.suggested, undefined, '디자인 가이드 갈래는 Figma 문서의 검증이라 제안이 아니다');
  assert.equal(design.selected, true);
  const tc = next.cases.filter((c) => qa.caseTrack(c) === 'tc');
  assert.equal(tc.length, 2, 'TC 문서 갈래는 그대로 둘 다 남는다');
  assert.equal(tc[0].title, prev.cases[0].title, '원문은 바뀌지 않는다');
  assert.deepEqual(tc[0].steps, prev.cases[0].steps);
  assert.deepEqual(tc[0].requirements, ['R-01'], '요구사항 잇기는 받는다');
  const added = next.cases.filter((c) => c.id === 'TC-010' || c.id === 'TC-011');
  assert.equal(added.length, 2);
  for (const c of added) {
    assert.equal(c.suggested, true);
    assert.equal(c.selected, false);
    assert.notEqual(qa.caseTrack(c), 'tc', '에이전트는 TC 문서 갈래를 만들 수 없다');
  }
  // 사람이 골라 넣으면 제안 표시가 빠지고 고른다
  const kept = await qa.updateQaCase(plan.id, 'TC-010', { suggested: false, selected: true });
  const k = kept.cases.find((c) => c.id === 'TC-010');
  assert.equal(k.suggested, undefined);
  assert.equal(k.selected, true);
  // 다시 저장해도 사람이 넣은 TC 는 제안으로 돌아가지 않는다
  const again = await qa.saveAgentQaPlan(plan.id, { requirements: next.requirements, cases: kept.cases.filter((c) => qa.caseTrack(c) !== 'tc') });
  assert.equal(again.cases.find((c) => c.id === 'TC-010').suggested, undefined);
});

test('갈래: track 없는 옛 계획은 지금처럼 읽히고, 디자인 TC 는 디자인 갈래', () => {
  const p = qa.validatePlan({
    version: 1,
    id: 'old',
    name: '옛 계획',
    createdAt: 1,
    updatedAt: 1,
    requirements: [{ id: 'R-01', text: 'a' }],
    cases: [
      { id: 'TC-001', title: 'a', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'] },
      { id: 'TC-002', title: 'd', requirements: [], priority: 'P1', kind: 'design', steps: ['a'], expected: ['b'], design: { figma: 'https://www.figma.com/design/abc/x?node-id=1-2' } },
    ],
  });
  assert.equal(qa.caseTrack(p.cases[0]), 'flow');
  assert.equal(qa.caseTrack(p.cases[1]), 'design');
  assert.equal(p.cases[0].track, undefined, '저장 값은 그대로 (옛 파일과 같음)');
  // 흐름 TC 는 여전히 요구사항이 필요하다
  assert.throws(() => qa.validatePlan({ ...p, cases: [{ ...p.cases[0], requirements: [] }] }), /요구사항/);
});

test('추적표: TC 문서 갈래가 덮은 요구사항은 정상·예외가 빠졌다고 하지 않고, 갈래를 보여 준다', () => {
  const p = qa.validatePlan({
    version: 1,
    id: 'cov',
    name: '덮임',
    createdAt: 1,
    updatedAt: 1,
    requirements: [{ id: 'R-01', text: 'a' }, { id: 'R-02', text: 'b' }],
    cases: [
      { id: 'TC-001', title: 'a', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'], track: 'tc' },
      { id: 'TC-002', title: 'b', requirements: ['R-02'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'] },
    ],
  });
  const cov = qa.qaCoverage(p);
  assert.deepEqual(cov.rows[0].tracks, ['tc']);
  assert.deepEqual(cov.missingKinds.map((m) => m.id), ['R-02'], 'R-01 은 TC 문서가 덮었으니 빠졌다고 하지 않음');
  assert.deepEqual(cov.coveredByTc, ['R-01']);
});

test('결과표·내보내기에 갈래별 개수가 나온다', async () => {
  const plan = await qa.createQaPlan({ name: '갈래 집계', app: 'com.example.app' });
  await qa.addQaSource(plan.id, put('tc3.xlsx', makeXlsx(ROWS.slice(0, 2))));
  const run = await qa.createQaRun(plan.id);
  await qa.recordQaResult(plan.id, run.id, { case: 'TC-001', status: 'pass', mode: 'agent' });
  const p = await qa.loadQaPlan(plan.id);
  const r = await qa.loadQaRun(plan.id, run.id);
  const s = qa.qaRunSummary(p, r);
  assert.deepEqual(s.byTrack.tc, { total: 2, pass: 1, fail: 0, blocked: 0, skip: 0, 'not-run': 1 });
  const html = readFileSync((await qa.writeQaReport(p, r)).html, 'utf8');
  assert.match(html, /갈래별/);
  assert.match(html, /TC 문서/);
  const { path: x } = await qa.writeQaRunExport(plan.id, run.id, 'xlsx');
  const z = unzipSync(new Uint8Array(readFileSync(x)));
  assert.match(strFromU8(z['xl/workbook.xml']), /name="갈래별"/);
  assert.match(strFromU8(z['xl/worksheets/sheet3.xml']), /TC 문서/);
  const steps = readFileSync((await qa.writeQaRunExport(plan.id, run.id, 'html', 'en')).path, 'utf8');
  assert.match(steps, /TC document <b>1\/2<\/b>/);
});

test('에이전트는 TC 문서 TC 에 요구사항·확인 필수 표시만 붙이고, 원문 칸은 고치지 못한다', async () => {
  const plan = await qa.createQaPlan({ name: '잇기만' });
  await qa.addQaSource(plan.id, put('tc4.xlsx', makeXlsx(ROWS.slice(0, 1))));
  // 요구사항만 적은 짧은 항목도 받는다 (원문을 옮겨 적지 않아도 된다)
  const saved = await qa.saveAgentQaPlan(plan.id, {
    requirements: [{ id: 'R-01', text: '숏컷' }],
    cases: [{ id: 'TC-001', requirements: ['R-01'], danger: '찜 버튼을 실제로 누름' }],
  });
  const c = saved.cases[0];
  assert.deepEqual(c.requirements, ['R-01']);
  assert.equal(c.danger, '찜 버튼을 실제로 누름');
  assert.equal(c.selected, false, '확인 필수가 붙으면 사람이 다시 고른다');
  assert.equal(c.title, ROWS[0][1]);
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-001', { title: '바꿈' }), /원문/);
  const ok = await qa.updateQaCaseByAgent(plan.id, 'TC-001', { requirements: [] });
  assert.deepEqual(ok.cases[0].requirements, []);
  assert.equal(ok.cases[0].danger, '찜 버튼을 실제로 누름', '확인 필수 표시는 빼지 못한다');
});

test('열 고르기: 같은 문서를 두 번 가져오지 않고, 표 밖 열 번호는 막는다', async () => {
  const plan = await qa.createQaPlan({ name: '두 번' });
  const rows = [['번호', '무엇', '어떻게', '결과'], ['A-1', '첫 화면', '앱 실행', '홈이 보인다']];
  const r = await qa.addQaSource(plan.id, put('odd2.csv', rows.map((x) => x.join(',')).join('\n')));
  const pick = { sheet: r.tcTables[0].sheet, headerRow: 0, map: { title: 1, steps: 9 } };
  await assert.rejects(qa.importQaTcTable(plan.id, r.source.id, pick), /표 밖/);
  await qa.importQaTcTable(plan.id, r.source.id, { ...pick, map: { title: 1, steps: 2 } });
  await assert.rejects(qa.importQaTcTable(plan.id, r.source.id, { ...pick, map: { title: 1, steps: 2 } }), /이미/);
});

test('표 위 제목 줄을 건너뛰고 머리줄을 찾으며, 원본 행 번호를 근거로 남긴다', () => {
  const t = { sheet: '시트1', rows: [['QA 시나리오'], ['작성: 팀'], HEAD, ROWS[0]], rowNums: [1, 2, 4, 6] };
  const f = qa.findTcTable(t);
  assert.equal(f.headerRow, 2);
  const r = qa.importTcRows(t, f.headerRow, f.detect.map, { sourceId: 'S1', existingIds: ['TC-009'] });
  assert.equal(r.cases[0].id, 'TC-010');
  assert.equal(r.cases[0].source.locator, '시트1 6행');
  assert.equal(qa.mapPriority('Minor'), 'P2');
  assert.equal(qa.mapPriority('중'), 'P1');
  assert.equal(qa.mapPriority('뭔가'), undefined);
});
