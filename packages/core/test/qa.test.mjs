// QA 계획(요구사항·TC) 형식 검사, 저장, 문서 읽기(md·txt·csv·xlsx·pdf·링크)를 시험한다 (#74).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');
const { parseScript } = await import('../dist/script.js');
const { Scenario } = await import('../dist/scenario.js');

const files = join(home, 'in');
mkdirSync(files, { recursive: true });
const put = (name, data) => {
  const p = join(files, name);
  writeFileSync(p, data);
  return p;
};

const basePlan = () => ({
  version: 1,
  id: '20261119-120000_로그인',
  name: '로그인 QA',
  app: 'com.example.app',
  createdAt: 1,
  updatedAt: 1,
  sources: [{ id: 'S1', kind: 'md', ref: '/x/spec.md', addedAt: 1 }],
  requirements: [
    { id: 'R-01', text: '이메일·비밀번호로 로그인한다', source: { source: 'S1', locator: '2.1' } },
    { id: 'R-02', text: '틀린 비밀번호면 오류 문구를 보인다' },
  ],
  cases: [
    { id: 'TC-001', title: '정상 로그인', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['로그인 화면에서 계정 입력', '로그인 누르기'], expected: ['홈 화면'] },
    { id: 'TC-002', title: '틀린 비밀번호', requirements: ['R-02'], priority: 'P1', kind: 'exception', steps: ['틀린 비밀번호 입력'], expected: ['오류 문구'] },
    { id: 'TC-003', title: '회원 탈퇴', requirements: ['R-01'], priority: 'P2', kind: 'normal', steps: ['설정 → 탈퇴'], expected: ['탈퇴 완료'], danger: '계정 삭제' },
  ],
});

// ---------- 형식 ----------

test('계획 형식: 기본값과 선택 규칙', () => {
  const p = qa.validatePlan(basePlan());
  assert.equal(p.cases[0].selected, true);
  assert.equal(p.cases[2].selected, false, '위험 행동이 있는 TC 는 기본으로 고르지 않는다');
  assert.equal(p.cases[0].allowDanger, false);
  assert.equal(p.cases[0].automatable, 'yes');
  assert.deepEqual(p.cases[0].preconditions, []);
});

test('계획 형식: 고칠 곳을 줄마다 알려 준다', () => {
  const bad = basePlan();
  bad.cases.push({ ...bad.cases[0] }); // 번호 겹침
  bad.cases[1].requirements = ['R-09']; // 없는 요구사항
  bad.requirements[0].source.source = 'S7'; // 없는 문서
  bad.cases[0].steps = [];
  assert.throws(
    () => qa.validatePlan(bad),
    (e) =>
      /번호가 겹칩니다: TC-001/.test(e.message) &&
      /없는 요구사항입니다: R-09/.test(e.message) &&
      /없는 문서입니다: S7/.test(e.message) &&
      /cases\.0\.steps: 단계가 하나 이상/.test(e.message),
  );
});

test('계획 형식: 번호·디자인 TC·계획 id', () => {
  const p = basePlan();
  p.cases[0].id = 'TC-1';
  assert.throws(() => qa.validatePlan(p), /TC-001 형식/);
  const d = basePlan();
  d.cases.push({ id: 'TC-004', title: '홈 디자인', priority: 'P2', kind: 'design', steps: ['홈 열기'], expected: ['가이드와 같음'] });
  assert.throws(() => qa.validatePlan(d), /Figma 프레임/);
  d.cases[3].design = { figma: 'https://www.figma.com/design/abc/x?node-id=1-2' };
  assert.equal(qa.validatePlan(d).cases[3].requirements.length, 0, '디자인 TC 는 요구사항 없이도 된다');
  for (const id of ['../x', '.hidden', 'a/b', '']) {
    assert.throws(() => qa.validatePlan({ ...basePlan(), id }), /계획 id|String must/, id);
  }
  const noReq = basePlan();
  noReq.cases[0].requirements = [];
  assert.throws(() => qa.validatePlan(noReq), /덮는 요구사항/);
});

test('에이전트 계획: 위험 허용은 지우고 사람 결정은 이어받는다', () => {
  const prev = qa.validatePlan(basePlan());
  prev.cases[2].allowDanger = true;
  prev.cases[2].selected = true;
  prev.cases[1].selected = false;
  prev.cases[0].script = 'login-tc001';

  const draft = basePlan();
  draft.cases[0].allowDanger = true; // 에이전트가 넣은 값
  draft.cases[0].danger = undefined;
  const next = qa.acceptAgentPlan(draft, prev);
  assert.equal(next.cases[0].allowDanger, false, '에이전트는 위험 허용을 켤 수 없다');
  assert.equal(next.cases[0].script, 'login-tc001');
  assert.equal(next.cases[1].selected, false);
  assert.equal(next.cases[2].allowDanger, true, '사람이 허용한 TC 는 그대로');
  assert.equal(next.cases[2].selected, true);

  // 위험 설명이 바뀌거나 새로 위험이 붙으면 다시 사람 몫
  const changed = basePlan();
  changed.cases[2].danger = '계정 삭제 + 결제 취소';
  changed.cases[0].danger = '알림 전송';
  const c2 = qa.acceptAgentPlan(changed, prev);
  assert.equal(c2.cases[2].allowDanger, false);
  assert.equal(c2.cases[0].selected, false);

  const fresh = qa.acceptAgentPlan(draft);
  assert.equal(fresh.cases[2].selected, false);
  assert.equal(fresh.cases.every((c) => c.allowDanger === false), true);
});

test('추적표와 다음 번호', () => {
  const p = qa.validatePlan({ ...basePlan(), requirements: [...basePlan().requirements, { id: 'R-03', text: '자동 로그인' }] });
  p.cases[1].selected = false;
  const cov = qa.qaCoverage(p);
  assert.deepEqual(cov.rows.map((r) => [r.requirement.id, r.cases, r.selected]), [
    ['R-01', ['TC-001', 'TC-003'], ['TC-001']],
    ['R-02', ['TC-002'], []],
    ['R-03', [], []],
  ]);
  assert.deepEqual(cov.uncovered, ['R-03']);
  assert.deepEqual(cov.unselected, ['R-02']);
  assert.equal(qa.nextId(['TC-001', 'TC-009'], 'TC-'), 'TC-010');
  assert.equal(qa.nextId(['TC-0099'], 'TC-'), 'TC-0100');
  assert.equal(qa.nextId([], 'R-'), 'R-01');
  assert.equal(qa.nextId(['S1', 'S2'], 'S'), 'S3');
});

// ---------- 스크립트·시나리오 연결 ----------

test('스크립트 tc 칸과 시나리오 tc', async () => {
  const y = `name: 로그인\napp: com.example.app\ntc:\n  plan: 20261119-120000_로그인\n  case: TC-001\nsteps:\n  - launch:\n`;
  assert.deepEqual(parseScript(y).tc, { plan: '20261119-120000_로그인', case: 'TC-001' });
  assert.throws(() => parseScript(y.replace('TC-001', 'TC1')), /TC-001 형식/);
  assert.throws(() => parseScript(y.replace('20261119-120000_로그인', '../x')), /QA 계획 id/);
  const s = await Scenario.start('tc 시험', { tc: { plan: 'p1', case: 'TC-002' } });
  assert.deepEqual(s.data.tc, { plan: 'p1', case: 'TC-002' });
});

// ---------- 문서 읽기 ----------

test('링크 구분: Confluence·Figma', () => {
  const f = qa.classifyQaSource('https://www.figma.com/design/0hjAbC/%EC%8B%A4?node-id=7-1942&m=dev');
  assert.deepEqual(f.link.figma, { fileKey: '0hjAbC', nodeId: '7:1942' });
  const b = qa.classifyQaSource('https://www.figma.com/design/main/branch/br1/y');
  assert.equal(b.link.figma.fileKey, 'br1');
  assert.equal(qa.classifyQaSource('https://acme.atlassian.net/wiki/spaces/X/pages/123/T').link.kind, 'confluence');
  assert.throws(() => qa.classifyQaSource('https://example.com/a'), /Confluence·Figma/);
  assert.throws(() => qa.classifyQaSource('/x/a.xls'), /\.xlsx 로 다시 저장/);
  assert.throws(() => qa.classifyQaSource('/x/a.docx'), /PDF 나 md/);
});

test('CSV: 따옴표·줄바꿈·구분자·CP949', async () => {
  const rows = qa.parseCsv('﻿ID,제목,단계\r\nTC-001,"쉼표, 있음","1. 열기\n2. 누르기"\r\nTC-002,"따옴표 ""안""",x|y\r\n\r\n');
  assert.deepEqual(rows, [
    ['ID', '제목', '단계'],
    ['TC-001', '쉼표, 있음', '1. 열기\n2. 누르기'],
    ['TC-002', '따옴표 "안"', 'x|y'],
  ]);
  assert.deepEqual(qa.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  const md = qa.tableToMarkdown(rows);
  assert.match(md, /^\| ID \| 제목 \| 단계 \|\n\| --- \| --- \| --- \|/);
  assert.match(md, /1\. 열기<br>2\. 누르기/);
  assert.match(md, /x\\\|y/);

  // CP949 로 저장한 엑셀 CSV: "가,나"
  const p = put('cp949.csv', Buffer.from([0xb0, 0xa1, 0x2c, 0xb3, 0xaa, 0x0a, 0x31, 0x2c, 0x32]));
  const f = await qa.readQaSourceFile(p);
  assert.match(f.text, /\| 가 \| 나 \|/);
});

function makeXlsx() {
  const sheet = (rows) =>
    strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="TC" sheetId="1" r:id="rId1"/><sheet name="빈 시트" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0"?><sst><si><t>ID</t></si><si><t>제목</t></si><si><r><t>굵은 </t></r><r><t xml:space="preserve">조각</t></r></si><si><t>001</t></si></sst>`,
    ),
    'xl/worksheets/sheet1.xml': sheet(
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>비고</t></is></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>3.5</v></c><c r="D2" t="b"><v>1</v></c></row>`,
    ),
    'xl/worksheets/sheet2.xml': sheet(''),
  });
}

test('엑셀: 공유 문자열·서식 조각·빈 칸·여러 시트', async () => {
  const md = qa.xlsxToMarkdown(makeXlsx());
  assert.equal(md, '## 시트: TC\n\n| ID | 제목 |  | 비고 |\n| --- | --- | --- | --- |\n| 001 | 굵은 조각 | 3.5 | TRUE |');
  assert.throws(() => qa.xlsxToMarkdown(new Uint8Array([1, 2, 3])), /엑셀 파일을 열 수 없습니다/);
  const f = await qa.readQaSourceFile(put('tc.xlsx', makeXlsx()));
  assert.equal(f.kind, 'xlsx');
  assert.match(f.text, /굵은 조각/);
});

/** 글자층이 있는 한 쪽짜리 PDF (Helvetica, ASCII) */
function makePdf(lines) {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF: 쪽마다 글자 뽑기, 글자층 없으면 경고', async () => {
  const f = await qa.readQaSourceFile(put('spec.pdf', makePdf(['Login with email', 'Wrong password shows error'])));
  assert.equal(f.kind, 'pdf');
  assert.match(f.text, /^## p\.1\n\n/);
  assert.match(f.text, /Login with email/);
  assert.match(f.text, /Wrong password shows error/);
  const blank = await qa.readQaSourceFile(put('scan.pdf', makePdf([])));
  assert.match(blank.warnings.join(), /글자층이 없습니다/);
  await assert.rejects(qa.readQaSourceFile(put('broken.pdf', 'not a pdf')), /PDF 를 읽을 수 없습니다/);
});

// ---------- 저장 ----------

test('저장: 만들기·문서 넣기·중복·목록·고치기', async () => {
  const plan = await qa.createQaPlan({ name: '로그인 QA', app: 'com.example.app' });
  assert.match(plan.id, /^\d{8}-\d{6}_로그인_QA$/);
  const again = await qa.createQaPlan({ name: '로그인 QA' });
  assert.notEqual(again.id, plan.id, '같은 초에 만들어도 id 가 겹치지 않는다');

  const md = put('spec.md', '# 로그인\n\n- 이메일로 로그인한다\n');
  const a = await qa.addQaSource(plan.id, md);
  assert.equal(a.source.id, 'S1');
  assert.equal(a.duplicate, false);
  assert.ok(existsSync(join(home, 'qa', plan.id, 'sources', 'S1.md')));
  assert.equal(readFileSync(join(home, 'qa', plan.id, 'sources', 'S1.md'), 'utf8'), '# 로그인\n\n- 이메일로 로그인한다');
  const dup = await qa.addQaSource(plan.id, put('copy.md', '# 로그인\n\n- 이메일로 로그인한다\n'));
  assert.equal(dup.duplicate, true, '내용이 같으면 다시 넣지 않는다');
  const link = await qa.addQaSource(plan.id, 'https://www.figma.com/design/abc/x?node-id=1-2');
  assert.equal(link.source.id, 'S2');
  assert.equal(link.source.kind, 'figma');
  assert.equal((await qa.addQaSource(plan.id, 'https://www.figma.com/design/abc/x?node-id=1-2')).duplicate, true);
  assert.equal(await qa.readQaSourceText(plan.id, 'S2'), undefined, '링크는 커넥터로 읽는다');
  assert.match(await qa.readQaSourceText(plan.id, 'S1'), /이메일로 로그인/);

  const draft = basePlan();
  const saved = await qa.saveAgentQaPlan(plan.id, { requirements: draft.requirements, cases: draft.cases });
  assert.equal(saved.sources.length, 2, '문서 목록은 저장된 것을 지킨다');
  assert.equal(saved.cases.length, 3);

  const edited = await qa.updateQaCase(plan.id, 'TC-003', { allowDanger: true, selected: true });
  assert.equal(edited.cases[2].allowDanger, true);
  await assert.rejects(qa.updateQaCase(plan.id, 'TC-404', { selected: true }), /TC 가 없습니다/);
  await assert.rejects(qa.updateQaCase(plan.id, 'TC-001', { requirements: ['R-77'] }), /없는 요구사항/);

  // 에이전트가 다시 뽑아도 사람이 허용한 위험 TC 는 그대로
  const re = await qa.saveAgentQaPlan(plan.id, { requirements: draft.requirements, cases: draft.cases });
  assert.equal(re.cases[2].allowDanger, true);

  const list = await qa.listQaPlans();
  assert.equal(list.length, 2);
  const mine = list.find((x) => x.id === plan.id);
  assert.deepEqual({ sources: mine.sources, requirements: mine.requirements, cases: mine.cases, selected: mine.selected }, {
    sources: 2,
    requirements: 2,
    cases: 3,
    selected: 3,
  });

  await assert.rejects(qa.loadQaPlan('../etc'), /id 형식/);
  await assert.rejects(qa.loadQaPlan('nothing'), /QA 계획이 없습니다/);
  await assert.rejects(qa.addQaSource(plan.id, join(files, 'none.md')), /파일이 없습니다/);
});
