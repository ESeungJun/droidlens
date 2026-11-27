// TC 표 가져오기 미리보기 (#153): 새로 생기는·바뀌는·그대로인 TC 수와 처음 몇 줄을 반영 전에 보여 준다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');
const files = join(home, 'in');
mkdirSync(files, { recursive: true });
const put = (name, data) => (writeFileSync(join(files, name), data), join(files, name));
const HEAD = ['TC ID', '테스트 항목', '사전 조건', '테스트 절차', '기대 결과', '우선순위'];
const V1 = [
  ['TC_001', '홈 화면 숏컷 노출', '로그인 상태', '1. 앱을 연다', '숏컷 영역이 보인다', '상'],
  ['TC_002', '숏컷 누르면 이동', '홈 화면', '1. 커뮤니티를 누른다', '커뮤니티 화면이 열린다', '중'],
  ['TC_003', '숏컷 순서', '', '1. 홈을 본다', '찜이 첫 칸이다', '하'],
];
const V2 = [V1[0], ['TC_002', '숏컷 누르면 이동', '홈 화면', '1. 커뮤니티를 누른다', '커뮤니티 웹 화면이 새 창으로 열린다', '중'], V1[2], ['TC_004', '숏컷 길게 누르기', '', '1. 숏컷을 길게 누른다', '편집 메뉴가 뜬다', '중']];
const csv = (rows) => [HEAD, ...rows].map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
const planFile = (id) => join(home, 'qa', id, 'plan.json');

async function setup() {
  const plan = await qa.createQaPlan({ name: '미리보기' });
  await qa.addQaSource(plan.id, put(`v1-${plan.id}.csv`, csv(V1)));
  // 사람이 TC_002 를 골라 둔다
  const p = await qa.loadQaPlan(plan.id);
  const tc2 = p.cases.find((c) => c.notes?.includes('원본 번호: TC_002'));
  await qa.updateQaCase(plan.id, tc2.id, { selected: true });
  // 새 판 문서는 미리보기를 위해 바로 가져오지 않고 넣는다
  const a = await qa.addQaSource(plan.id, put(`v2-${plan.id}.csv`, csv(V2)), { deferTcImport: true });
  return { id: plan.id, a, tc2: tc2.id };
}

test('미리 보기로 넣은 문서는 바로 가져오지 않고, 알아본 열을 채운 표 후보를 돌려준다', async () => {
  const { id, a } = await setup();
  assert.equal(a.tcImport, undefined);
  assert.equal(a.tcTables?.length, 1);
  assert.equal(a.tcTables[0].recognized, true);
  assert.equal(a.tcTables[0].guess.title, 1);
  assert.equal((await qa.loadQaPlan(id)).cases.length, 3, '아직 반영 안 됨');
});

test('미리보기는 새·바뀜·그대로 수와 처음 몇 줄을 돌려주고 계획 파일은 건드리지 않는다', async () => {
  const { id, a } = await setup();
  const before = readFileSync(planFile(id), 'utf8');
  const t = a.tcTables[0];
  const p = await qa.previewQaTcTable(id, a.source.id, { sheet: t.sheet, headerRow: t.headerRow, map: t.guess });
  assert.deepEqual({ total: p.total, added: p.added, changed: p.changed, same: p.same }, { total: 4, added: 1, changed: 1, same: 2 });
  assert.deepEqual(p.rows.map((r) => [r.title, r.status]), [
    ['홈 화면 숏컷 노출', 'same'],
    ['숏컷 누르면 이동', 'changed'],
    ['숏컷 순서', 'same'],
    ['숏컷 길게 누르기', 'new'],
  ]);
  assert.equal(p.rows[1].target, (await qa.loadQaPlan(id)).cases.find((c) => c.notes?.includes('원본 번호: TC_002')).id, '바뀌는 TC 번호');
  assert.equal(readFileSync(planFile(id), 'utf8'), before, '계획 파일 그대로');
});

test('확인하고 가져오면 새 TC 는 더하고, 바뀐 TC 는 그 자리에서 고치고(선택 유지), 같은 TC 는 다시 넣지 않는다', async () => {
  const { id, a, tc2 } = await setup();
  const t = a.tcTables[0];
  const r = await qa.importQaTcTable(id, a.source.id, { sheet: t.sheet, headerRow: t.headerRow, map: t.guess });
  assert.deepEqual({ cases: r.cases, added: r.added, changed: r.changed, same: r.same }, { cases: 2, added: 1, changed: 1, same: 2 });
  const p = await qa.loadQaPlan(id);
  assert.equal(p.cases.length, 4);
  const c2 = p.cases.find((c) => c.id === tc2);
  assert.deepEqual(c2.expected, ['커뮤니티 웹 화면이 새 창으로 열린다']);
  assert.equal(c2.selected, true, '사람이 고른 것은 그대로');
  assert.ok(p.cases.some((c) => c.title === '숏컷 길게 누르기'));
});

test('미리보기 열 번호가 표 밖이면 거부한다', async () => {
  const { id, a } = await setup();
  const t = a.tcTables[0];
  await assert.rejects(qa.previewQaTcTable(id, a.source.id, { sheet: t.sheet, headerRow: t.headerRow, map: { title: 99 } }), /표 밖/);
});
