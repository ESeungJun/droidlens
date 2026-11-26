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
  assert.equal(p.cases[2].selected, false, '확인 필수 TC 는 기본으로 고르지 않는다');
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

test('에이전트 계획: 실제로 누르기 허용은 지우고 사람 결정은 이어받는다', () => {
  const prev = qa.validatePlan(basePlan());
  prev.cases[2].allowDanger = true;
  prev.cases[2].selected = true;
  prev.cases[1].selected = false;
  prev.cases[0].script = 'login-tc001';

  const draft = basePlan();
  draft.cases[0].allowDanger = true; // 에이전트가 넣은 값
  draft.cases[0].danger = undefined;
  const next = qa.acceptAgentPlan(draft, prev);
  assert.equal(next.cases[0].allowDanger, false, '에이전트는 실제로 누르기 허용을 켤 수 없다');
  assert.equal(next.cases[0].script, 'login-tc001');
  assert.equal(next.cases[1].selected, false);
  assert.equal(next.cases[2].allowDanger, true, '사람이 허용한 TC 는 그대로');
  assert.equal(next.cases[2].selected, true);

  // 확인 필수 설명이 바뀌거나 새로 확인 필수가 붙으면 다시 사람 몫
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
  // R-01 은 정상만(TC-001·TC-003), R-02 는 예외만, R-03 은 TC 가 없어 uncovered 쪽에만
  assert.deepEqual(cov.missingKinds, [
    { id: 'R-01', missing: ['exception'] },
    { id: 'R-02', missing: ['normal'] },
  ]);
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

  // 셀 주소로 거대한 열 번호를 주어도 큰 배열을 만들지 않는다
  const huge = zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>ID</t></is></c><c r="ZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c><c r="IW1" t="inlineStr"><is><t>y</t></is></c></row></sheetData></worksheet>',
    ),
  });
  const w = [];
  assert.equal(qa.xlsxToMarkdown(huge, w), '## 시트: S\n\n| ID |\n| --- |');
  assert.match(w.join(), /앞 256열만/);
  const wide = [];
  assert.equal(qa.tableToMarkdown([Array.from({ length: 300 }, (_, i) => `c${i}`)], wide).split('\n')[0].split(' | ').length, 256);
  assert.match(wide.join(), /앞 256열만/);
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

  // 에이전트가 다시 뽑아도 사람이 허용한 확인 필수 TC 는 그대로
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

// ---------- 리뷰 1회차에서 고친 것 ----------

test('에이전트 계획: 실행 내용이 바뀌면 허용·선택을 다시 사람에게, 스크립트는 받지 않는다', () => {
  const prev = qa.validatePlan(basePlan());
  prev.cases[2].allowDanger = true;
  prev.cases[2].selected = true;
  prev.cases[0].script = 'real';
  const draft = basePlan();
  draft.cases[2].steps = ['설정 → 탈퇴', '100만원 결제']; // 확인 필수 설명은 그대로, 단계만 바꿈
  draft.cases[2].data = 'card=real';
  draft.cases[0].script = 'attacker-script';
  draft.cases[1].danger = '   '; // 공백뿐인 확인 필수 설명은 없는 것으로
  const next = qa.acceptAgentPlan(draft, prev);
  assert.equal(next.cases[2].allowDanger, false);
  assert.equal(next.cases[2].selected, false);
  assert.equal(next.cases[0].script, 'real', '에이전트가 낸 script 는 무시');
  assert.equal(next.cases[1].danger, undefined);
  assert.equal(next.cases[1].selected, true);
  // 내용이 같으면 허용을 이어받는다
  assert.equal(qa.acceptAgentPlan(basePlan(), prev).cases[2].allowDanger, true);
});

test('형식: 스크립트 이름·Figma 링크·https·시나리오 tc', async () => {
  const p = basePlan();
  p.cases[0].script = '../../etc/x';
  assert.throws(() => qa.validatePlan(p), /스크립트 이름/);
  const d = basePlan();
  d.cases.push({ id: 'TC-004', title: '디자인', priority: 'P2', kind: 'design', steps: ['열기'], expected: ['같음'], design: { figma: 'javascript:alert(1)' } });
  assert.throws(() => qa.validatePlan(d), /Figma 디자인 링크/);
  d.cases[3].design.figma = 'http://www.figma.com/design/abc/x';
  assert.throws(() => qa.validatePlan(d), /Figma 디자인 링크/);
  assert.throws(() => qa.classifyQaSource('http://acme.atlassian.net/wiki/x'), /https 링크만/);
  await assert.rejects(Scenario.start('bad', { tc: { plan: '../x', case: 'TC-001' } }), /TC 연결 형식/);
});

test('CSV: .tsv 는 탭으로, 닫히지 않은 따옴표 경고, UTF-16·CP949 표시', async () => {
  const f = await qa.readQaSourceFile(put('tc.tsv', 'ID\t제목, 설명, 비고\t단계\nTC-001\ta, b\tc\n'));
  assert.match(f.text, /^\| ID \| 제목, 설명, 비고 \| 단계 \|/);
  const w = [];
  assert.deepEqual(qa.parseCsv('a,"b\nc,d', undefined, w), [['a', 'b\nc,d']]);
  assert.match(w.join(), /닫히지 않은 따옴표/);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('가,나\n1,2', 'utf16le')]);
  const g = await qa.readQaSourceFile(put('u16.csv', u16));
  assert.match(g.text, /\| 가 \| 나 \|/);
  assert.deepEqual(g.warnings, []);
  const k = await qa.readQaSourceFile(put('cp.txt', Buffer.from([0xb0, 0xa1])));
  assert.match(k.warnings.join(), /CP949/);
});

test('엑셀: 서식만 있는 빈 칸, _x000D_, 다른 접두어, 큰 시트는 행 상한에서 잘라 읽기', () => {
  const book = (sheetRows, wbAttr = 'r:id', extra = {}) =>
    zipSync({
      'xl/workbook.xml': strToU8(`<workbook><sheets><sheet name="S" ${wbAttr}="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
      ...extra,
    });
  const row = '<row><c r="A1" t="inlineStr"><is><t>줄1_x000D_\n줄2</t></is></c><c r="H1" s="2"/></row>';
  assert.equal(qa.xlsxToMarkdown(book(row)), '## 시트: S\n\n| 줄1<br>줄2 |\n| --- |');
  assert.equal(qa.xlsxToMarkdown(book(row, 'ns1:id')), '## 시트: S\n\n| 줄1<br>줄2 |\n| --- |');
  const w = [];
  qa.xlsxToMarkdown(book(row, 'x'), w);
  assert.match(w.join(), /시트 위치를 찾지 못해/);

  const many = Array.from({ length: 6000 }, (_, i) => `<row><c t="inlineStr"><is><t>r${i}</t></is></c></row>`).join('');
  const w2 = [];
  const md = qa.xlsxToMarkdown(book(many), w2);
  assert.equal(md.split('\n').length, 2 + 2 + 5000, '시트 제목·빈 줄·머리줄·구분줄 + 5,000행');
  assert.match(w2.join(), /앞 5,000행만/);
  assert.equal(qa.cutRows('<w><sheetData><row>1</row><row>2</row></sheetData></w>', 1, 1e6), '<w><sheetData><row>1</row></sheetData></worksheet>');
  assert.equal(qa.cutRows('<w><row>1</row></w>', 5, 1e6), '<w><row>1</row></w>');
  assert.throws(() => qa.cutRows('x'.repeat(100), 1, 10), /시트 하나가 8MB/);
  // 닫는 </row> 가 적어 자르지 못하는 큰 시트도 상한을 지킨다
  assert.throws(() => qa.cutRows(`<row>1</row>${'<row/>'.repeat(10)}`, 5, 20), /시트 하나가 8MB/);
  // 같은 시트 파일을 가리키는 시트 여러 개는 한 번만 읽는다
  const dupBook = zipSync({
    'xl/workbook.xml': strToU8(`<workbook><sheets>${Array.from({ length: 60 }, (_, i) => `<sheet name="S${i}" r:id="rId1"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${row}</sheetData></worksheet>`),
  });
  const w3 = [];
  assert.equal(qa.xlsxToMarkdown(dupBook, w3).match(/## 시트:/g).length, 1);
  assert.match(w3.join(), /앞 50개만/);

  const bigShared = book(row, 'r:id', { 'xl/sharedStrings.xml': strToU8(`<sst><si><t>${'가'.repeat(8 * 1024 * 1024 + 1)}</t></si></sst>`) });
  assert.throws(() => qa.xlsxToMarkdown(bigShared), /sharedStrings\.xml 8MB 초과/);
});

test('저장: 동시에 문서를 넣어도 번호가 겹치지 않고, TC 형식 오류는 고칠 곳을 알려 준다', async () => {
  const plan = await qa.createQaPlan({ name: '동시' });
  const [a, b] = await Promise.all([qa.addQaSource(plan.id, put('a.md', 'A')), qa.addQaSource(plan.id, put('b.md', 'B'))]);
  assert.deepEqual([a.source.id, b.source.id].sort(), ['S1', 'S2']);
  const saved = await qa.loadQaPlan(plan.id);
  assert.equal(saved.sources.length, 2);
  assert.equal(await qa.readQaSourceText(plan.id, a.source.id), 'A');
  assert.equal(await qa.readQaSourceText(plan.id, b.source.id), 'B');

  await qa.saveAgentQaPlan(plan.id, { requirements: basePlan().requirements.map(({ source, ...r }) => r), cases: basePlan().cases.map(({ source, ...c }) => c) });
  await assert.rejects(qa.updateQaCase(plan.id, 'TC-001', { steps: [] }), /TC 형식 오류:\n {2}steps: 단계가 하나 이상/);
  // 사람 저장은 문서 목록·만든 시각을 지킨다
  const p = await qa.loadQaPlan(plan.id);
  const out = await qa.saveQaPlan({ ...p, sources: [], createdAt: 0 });
  assert.equal(out.sources.length, 2);
  assert.equal(out.createdAt, p.createdAt);
});

test('다시 보기 표시: 확인 필수 표시가 빠지거나 바뀌면 붙고, 사람이 정하면 지워진다', async () => {
  const prev = qa.validatePlan(basePlan()); // TC-003 은 확인 필수 "계정 삭제", 기본 선택 꺼짐
  const removed = basePlan();
  delete removed.cases[2].danger;
  removed.cases[0].review = ['danger-changed']; // 에이전트가 낸 표시는 무시
  const r1 = qa.acceptAgentPlan(removed, prev);
  assert.deepEqual(r1.cases[2].review, ['danger-removed']);
  assert.equal(r1.cases[2].selected, false, '꺼진 채 둔다');
  assert.equal(r1.cases[0].review, undefined);
  assert.deepEqual(qa.qaReviewList(r1), [{ id: 'TC-003', title: '회원 탈퇴', reasons: ['danger-removed'], selected: false }]);
  // 사람이 확인하기 전에 다시 뽑아도 내용이 같으면 표시가 남는다
  assert.deepEqual(qa.acceptAgentPlan(removed, r1).cases[2].review, ['danger-removed']);

  const allowed = qa.validatePlan(basePlan());
  allowed.cases[2].allowDanger = true;
  allowed.cases[2].selected = true;
  const changed = basePlan();
  changed.cases[2].steps = ['설정 → 탈퇴', '확인'];
  const r2 = qa.acceptAgentPlan(changed, allowed);
  assert.deepEqual(r2.cases[2].review, ['danger-changed']);
  assert.equal(r2.cases[2].allowDanger, false);
  assert.equal(r2.cases[2].selected, false);
  // 처음부터 확인 필수인 새 TC 는 기본으로 꺼질 뿐 표시는 없다
  assert.equal(qa.acceptAgentPlan(basePlan()).cases[2].review, undefined);

  // 저장소: 사람이 선택을 정하면 표시가 지워지고, 문구만 고치면 남는다
  const plan = await qa.createQaPlan({ name: '확인 표시' });
  const strip = (p) => ({ requirements: p.requirements.map(({ source, ...x }) => x), cases: p.cases.map(({ source, ...x }) => x) });
  await qa.saveAgentQaPlan(plan.id, strip(basePlan()));
  const s2 = await qa.saveAgentQaPlan(plan.id, strip(removed));
  assert.deepEqual(s2.cases[2].review, ['danger-removed']);
  const t1 = await qa.updateQaCase(plan.id, 'TC-003', { notes: '확인 중' });
  assert.deepEqual(t1.cases[2].review, ['danger-removed']);
  const t2 = await qa.updateQaCase(plan.id, 'TC-003', { selected: true });
  assert.equal(t2.cases[2].review, undefined);
  assert.equal(t2.cases[2].selected, true);
});

test('에이전트 TC 수정: 허용·스크립트는 못 바꾸고, 확인 필수 TC 는 고르지 못하며, 내용이 바뀌면 허용이 풀린다 (#75)', async () => {
  const plan = await qa.createQaPlan({ name: '에이전트 수정' });
  const strip = (p) => ({ requirements: p.requirements.map(({ source, ...x }) => x), cases: p.cases.map(({ source, ...x }) => x) });
  await qa.saveAgentQaPlan(plan.id, strip(basePlan()));
  for (const bad of [{ allowDanger: true }, { script: 'x' }, { review: [] }, { id: 'TC-009' }]) {
    await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-003', bad), /고칠 수 없는 칸/, JSON.stringify(bad));
  }
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-003', { selected: true }), /에이전트가 고를 수 없습니다/);
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-001', { steps: [] }), /TC 형식 오류/);
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-404', { notes: 'x' }), /TC 가 없습니다/);
  const off = await qa.updateQaCaseByAgent(plan.id, 'TC-001', { selected: false, title: '정상 로그인 (이메일)' });
  assert.equal(off.cases[0].selected, false);
  assert.equal(off.cases[0].title, '정상 로그인 (이메일)');

  // 사람이 허용한 뒤 에이전트가 단계를 바꾸면 허용·선택이 풀리고 다시 보기가 붙는다
  const cur = (await qa.loadQaPlan(plan.id)).cases[2];
  await assert.rejects(qa.setQaCaseAllowDanger(plan.id, 'TC-003', true), /보여 준 TC 내용이 필요/);
  await assert.rejects(qa.setQaCaseAllowDanger(plan.id, 'TC-003', true, qa.dangerFingerprint({ ...cur, steps: ['다른 단계'] })), /확인하는 동안 바뀌어/);
  const allowed = await qa.setQaCaseAllowDanger(plan.id, 'TC-003', true, qa.dangerFingerprint(cur));
  assert.equal(allowed.cases[2].allowDanger, true);
  assert.equal(allowed.cases[2].selected, true);
  const same = await qa.updateQaCaseByAgent(plan.id, 'TC-003', { notes: '메모만' });
  assert.equal(same.cases[2].allowDanger, true, '실행 내용이 그대로면 허용이 남는다');
  const changed = await qa.updateQaCaseByAgent(plan.id, 'TC-003', { steps: ['설정 → 탈퇴', '확인 누르기'] });
  assert.equal(changed.cases[2].allowDanger, false);
  assert.equal(changed.cases[2].selected, false);
  assert.deepEqual(changed.cases[2].review, ['danger-changed']);
  // 확인 필수 표시를 새로 달면 선택이 꺼진다
  const marked = await qa.updateQaCaseByAgent(plan.id, 'TC-002', { danger: '메시지 전송' });
  assert.equal(marked.cases[1].selected, false);
  await assert.rejects(qa.setQaCaseAllowDanger(plan.id, 'TC-001', true), /확인 필수 표시가 없어/);

  // 불리언이 아닌 선택값, 확인 필수 표시를 지우면서 고르기, 다시 보기 표시가 남은 TC 고르기는 거절한다
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-001', { selected: 'true' }), /true 나 false/);
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-002', { danger: '', selected: true }), /에이전트가 고를 수 없습니다/);
  const cleared = await qa.updateQaCaseByAgent(plan.id, 'TC-002', { danger: '' });
  assert.deepEqual(cleared.cases[1].review, ['danger-removed']);
  await assert.rejects(qa.updateQaCaseByAgent(plan.id, 'TC-002', { selected: true }), /다시 보기 표시가 있어/);
  assert.equal((await qa.loadQaPlan(plan.id)).cases[0].selected, false, '계획 파일이 깨지지 않았다');

  // 스크립트 잇기 (실행하는 동안 TC 가 바뀌었으면 잇지 않는다)
  const tc1 = (await qa.loadQaPlan(plan.id)).cases[0];
  await assert.rejects(qa.linkQaCaseScript(plan.id, 'TC-001', 'x', { hash: 'a'.repeat(64), fingerprint: qa.dangerFingerprint({ ...tc1, data: '다른 값' }) }), /바뀌어 스크립트를 잇지 않았습니다/);
  const linked = await qa.linkQaCaseScript(plan.id, 'TC-001', 'TC-001_정상-로그인', { hash: 'a'.repeat(64) });
  assert.equal(linked.cases[0].scriptHash, 'a'.repeat(64));
  assert.equal(linked.cases[0].script, 'TC-001_정상-로그인');
  await assert.rejects(qa.linkQaCaseScript(plan.id, 'TC-001', '../x', { hash: 'a'.repeat(64) }), /스크립트 이름/);
});

test('회차(#76): 이은 스크립트는 해시가 같을 때만 그대로로 보고, 다른 TC 것이면 막는다. 회차 id 는 경로로 못 쓴다', async () => {
  const plan = await qa.createQaPlan({ name: '회차', app: 'com.example.app' });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '다음' }],
    cases: [{ id: 'TC-001', title: '다음', requirements: ['R-01'], priority: 'P0', kind: 'normal', steps: ['a'], expected: ['b'], selected: true }],
  });
  const dir = join(home, 'scripts');
  mkdirSync(dir, { recursive: true });
  const body = `name: s\napp: com.example.app\ntc:\n  plan: ${plan.id}\n  case: TC-001\nsteps:\n  - tap: { text: 다음 }\n`;
  writeFileSync(join(dir, 'TC-001_s.yaml'), body);
  const hash = qa.sha256(Buffer.from(body));
  const linked = await qa.linkQaCaseScript(plan.id, 'TC-001', 'TC-001_s', { hash });
  const c = linked.cases[0];
  assert.equal((await qa.readCaseScript(plan.id, c)).changed, false);
  writeFileSync(join(dir, 'TC-001_s.yaml'), body + '  - back\n');
  assert.equal((await qa.readCaseScript(plan.id, c)).changed, true);
  writeFileSync(join(dir, 'TC-001_s.yaml'), body.replace('case: TC-001', 'case: TC-002'));
  assert.match((await qa.readCaseScript(plan.id, c)).error, /이 TC 의 것이 아닙니다/);

  const run = await qa.createQaRun(plan.id);
  const run2 = await qa.createQaRun(plan.id);
  assert.notEqual(run.id, run2.id, '같은 초에 만들어도 겹치지 않는다');
  assert.equal((await qa.latestQaRun(plan.id)).id, run2.id);
  assert.deepEqual(await qa.listQaRunIds(plan.id), [run2.id, run.id], '회차 목록은 최근 것부터');
  assert.throws(() => qa.qaRunDir(plan.id, '../x'), /회차 id 형식/);
  await assert.rejects(qa.loadQaRun(plan.id, '../../x'), /회차 id 형식/);
  await assert.rejects(qa.recordQaResult(plan.id, run.id, { case: 'TC-001', status: 'pass', mode: 'manual' }), /실행한 결과로만/);
  await assert.rejects(qa.recordQaResult(plan.id, run.id, { case: 'TC-009', status: 'skip', mode: 'manual', detail: 'x' }), /TC 가 없습니다/);
});

test('회차(#76): 통과 근거 판정과 입력값 가리기', () => {
  const step = (index, status, extra = {}) => ({ index, at: 0, title: 't', status, ...extra });
  assert.match(qa.missingPassEvidence({ steps: [] }), /통과한 단계가 없습니다/);
  assert.match(qa.missingPassEvidence({ steps: [step(1, 'pass', { check: { by: 'agent' } })] }), /통과한 단계가 없습니다/);
  assert.equal(qa.missingPassEvidence({ steps: [step(1, 'pass', { check: { by: 'assert' } })] }), undefined);
  assert.match(qa.missingPassEvidence({ steps: [step(1, 'pass', { check: { by: 'assert' } }), step(2, 'fail')] }), /실패로 남은/);
  // 실패를 정정하면 실패로 보지 않는다
  assert.equal(
    qa.missingPassEvidence({ steps: [step(1, 'pass', { check: { by: 'assert' } }), step(2, 'fail'), step(3, 'pass', { corrects: 2 })] }),
    undefined,
  );
  assert.equal(qa.maskCaseData('user@example.com / hunter22 로 로그인', 'id: user@example.com, pw: hunter22'), '*** / *** 로 로그인');
  assert.equal(qa.maskCaseData('그대로', undefined), '그대로');
});

