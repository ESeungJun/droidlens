// TC 표 가져오기 되돌리기 (#154): 가져오기 직전 계획을 한 단계 보관하고 되돌린다
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
  ['TC_001', '결제하기', '장바구니 1개', '1. 결제를 누른다', '결제 창이 뜬다', '상'],
  ['TC_002', '숏컷 이동', '홈', '1. 숏컷을 누른다', '화면이 열린다', '중'],
];
const V2 = [['TC_001', '결제하기', '장바구니 1개', '1. 결제를 누른다\n2. 카드를 고른다', '결제 창이 뜬다', '상'], V1[1], ['TC_003', '새 항목', '', '1. 누른다', '열린다', '하']];
const csv = (rows) => [HEAD, ...rows].map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
const planFile = (id) => join(home, 'qa', id, 'plan.json');

async function setup() {
  const plan = await qa.createQaPlan({ name: '되돌리기' });
  await qa.addQaSource(plan.id, put(`v1-${plan.id}.csv`, csv(V1)));
  let p = await qa.loadQaPlan(plan.id);
  const pay = p.cases[0].id;
  // 사람 결정: 결제 TC 에 확인 필수 표시를 두고 허용, 숏컷 TC 는 빼 둔다
  await qa.updateQaCase(plan.id, pay, { danger: '실결제' });
  p = await qa.loadQaPlan(plan.id);
  await qa.setQaCaseAllowDanger(plan.id, pay, true, qa.dangerFingerprint(p.cases[0]));
  await qa.updateQaCase(plan.id, p.cases[1].id, { selected: false });
  const a = await qa.addQaSource(plan.id, put(`v2-${plan.id}.csv`, csv(V2)), { deferTcImport: true });
  const t = a.tcTables[0];
  return { id: plan.id, pay, source: a.source.id, pick: { sheet: t.sheet, headerRow: t.headerRow, map: t.guess } };
}

test('보관본이 없으면 되돌릴 것이 없다', async () => {
  const plan = await qa.createQaPlan({ name: '빈 계획' });
  assert.equal(await qa.qaTcImportBackup(plan.id), undefined);
  await assert.rejects(qa.undoQaTcImport(plan.id), /되돌릴 가져오기가 없/);
});

test('가져오기 → 되돌리기 → 계획이 가져오기 전과 같고, 보관본은 사라진다', async () => {
  const { id, source, pick } = await setup();
  const before = await qa.loadQaPlan(id);
  await qa.importQaTcTable(id, source, pick);
  const b = await qa.qaTcImportBackup(id);
  assert.ok(b, '보관본이 있다');
  assert.equal(b.cases, before.cases.length);
  assert.equal(typeof b.at, 'number');
  assert.notDeepEqual((await qa.loadQaPlan(id)).cases, before.cases);
  const restored = await qa.undoQaTcImport(id);
  assert.deepEqual({ ...restored, updatedAt: 0 }, { ...before, updatedAt: 0 });
  assert.deepEqual({ ...JSON.parse(readFileSync(planFile(id), 'utf8')), updatedAt: 0 }, JSON.parse(JSON.stringify({ ...before, updatedAt: 0 })));
  assert.equal(await qa.qaTcImportBackup(id), undefined, '한 번 되돌리면 보관본은 없다');
});

test('되돌리면 사람 결정(선택·허용)이 원래 값으로 돌아온다', async () => {
  const { id, pay, source, pick } = await setup();
  await qa.importQaTcTable(id, source, pick);
  const mid = await qa.loadQaPlan(id);
  assert.equal(mid.cases.find((c) => c.id === pay).allowDanger, false, '내용이 바뀌어 허용이 풀림');
  const back = await qa.undoQaTcImport(id);
  const c = back.cases.find((x) => x.id === pay);
  assert.equal(c.allowDanger, true);
  assert.equal(c.selected, true);
  assert.equal(back.cases[1].selected, false);
  assert.equal(back.cases.length, 2);
});

test('가져오기를 다시 하면 보관본은 그 직전 계획 하나만 남는다', async () => {
  const { id, source, pick } = await setup();
  await qa.importQaTcTable(id, source, pick);
  const after1 = await qa.loadQaPlan(id);
  const v3 = await qa.addQaSource(id, put(`v3-${id}.csv`, csv([...V2, ['TC_004', '넷', '', '1. a', 'b', '하']])), { deferTcImport: true });
  const t = v3.tcTables[0];
  await qa.importQaTcTable(id, v3.source.id, { sheet: t.sheet, headerRow: t.headerRow, map: t.guess });
  const back = await qa.undoQaTcImport(id);
  assert.deepEqual(back.cases, after1.cases.map((c) => back.cases.find((x) => x.id === c.id)), '두 번째 가져오기 직전으로');
  assert.equal(back.cases.length, after1.cases.length);
});
