// QA 실행 경로를 화면 흐름도에 쌓기 (#131): TC 가 tap 으로 지난 연결에 TC 를 붙이고,
// 화면마다 지난 기록·TC 를 찾고, 아무 기록도 없으면 "검증하지 않은 화면" 으로 본다. 빌드 결과(dist)를 시험한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { ScreenGraph, TcPath, screenId, screenChecks, loadScreenRecords } = await import('../dist/graph.js');
const { parseHierarchyXml } = await import('../dist/hierarchy.js');
const { Scenario } = await import('../dist/scenario.js');
const { screenXml } = await import('./fake-device.mjs');

const snap = (pkg, name, s) => ({
  screen: { packageName: s.pkg ?? pkg, activity: s.activity, fragments: [] },
  hierarchy: parseHierarchyXml(screenXml(name, s, s.pkg ?? pkg)),
  signature: '',
});
const HOME = (pkg) => ({
  activity: `${pkg}.HomeActivity`,
  buttons: [
    { id: 'btn_new', text: '새 메모', bounds: [0, 100, 500, 200] },
    { id: 'btn_detail', text: 'Detail', bounds: [0, 300, 1080, 500] },
  ],
});
const EDIT = (pkg) => ({ activity: `${pkg}.EditActivity`, buttons: [{ id: 'save', text: '저장', bounds: [0, 300, 1080, 500] }] });
const DETAIL = (pkg) => ({ activity: `${pkg}.DetailActivity`, buttons: [{ id: 'more', text: 'More', bounds: [0, 300, 1080, 500] }] });
const PLAN = '20261126-120000_memo';
const TC = { plan: PLAN, case: 'TC-001' };

test('tap 전후 화면을 연결로 잇고, 누른 요소 글자를 붙인다', async () => {
  const pkg = 'com.example.a';
  const g = await ScreenGraph.open(pkg);
  const p = new TcPath(g);
  const home1 = snap(pkg, 'home', HOME(pkg));
  const h = await p.see(home1, 0);
  assert.equal(h.id, screenId(home1), '단계 화면 id 와 지도 화면 id 가 같다');
  p.note({ type: 'tap', x: 100, y: 150 }, 1);
  const e = await p.see(snap(pkg, 'edit', EDIT(pkg)), 1);
  assert.ok(e);
  const edges = [...g.edges.values()];
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, h.id);
  assert.equal(edges[0].to, e.id);
  assert.equal(edges[0].action.type, 'tap');
  assert.equal(edges[0].action.label, '새 메모');
  assert.deepEqual([...p.edges], [edges[0].id]);
});

test('사이에 다른 조작이 있었거나 같은 화면이면 잇지 않는다', async () => {
  const pkg = 'com.example.b';
  const g = await ScreenGraph.open(pkg);
  const p = new TcPath(g);
  await p.see(snap(pkg, 'home', HOME(pkg)), 0);
  p.note({ type: 'tap', x: 100, y: 150 }, 1);
  // 탭 뒤에 다른 조작(번호 2)이 있었다: 도착 화면이 그 탭의 결과인지 모른다
  await p.see(snap(pkg, 'edit', EDIT(pkg)), 2);
  assert.equal(g.edges.size, 0);
  // 같은 화면에 머문 탭은 연결이 아니다
  p.note({ type: 'tap', x: 10, y: 400 }, 3);
  await p.see(snap(pkg, 'edit', EDIT(pkg)), 3);
  assert.equal(g.edges.size, 0);
});

test('다른 앱 화면은 지도에 올리지 않고, 그 앞의 탭도 잇지 않는다', async () => {
  const pkg = 'com.example.c';
  const g = await ScreenGraph.open(pkg);
  const p = new TcPath(g);
  await p.see(snap(pkg, 'home', HOME(pkg)), 0);
  p.note({ type: 'tap', x: 100, y: 150 }, 1);
  assert.equal(await p.see(snap(pkg, 'ext', { pkg: 'com.other', activity: 'com.other.Main', buttons: [] }), 1), undefined);
  await p.see(snap(pkg, 'edit', EDIT(pkg)), 1);
  assert.equal(g.edges.size, 0);
  assert.equal(g.nodes.size, 2);
});

test('TC 가 끝나면 지난 연결에 TC 와 판정을 붙이고, 같은 TC 는 최신 판정 하나만 남긴다', async () => {
  const pkg = 'com.example.d';
  const g = await ScreenGraph.open(pkg);
  const run = async (verdict) => {
    const p = new TcPath(g);
    await p.see(snap(pkg, 'home', HOME(pkg)), 0);
    p.note({ type: 'tap', x: 100, y: 150 }, 1);
    await p.see(snap(pkg, 'edit', EDIT(pkg)), 1);
    await p.finish(TC, verdict);
  };
  await run('fail');
  await run('pass');
  const [e] = [...g.edges.values()];
  assert.equal(e.tcs.length, 1);
  assert.equal(e.tcs[0].case, 'TC-001');
  assert.equal(e.tcs[0].verdict, 'pass');
  const disk = JSON.parse(readFileSync(join(g.dir, 'graph.json'), 'utf8'));
  assert.equal(disk.edges[0].tcs[0].verdict, 'pass', 'finish 가 파일에 쓴다');
  // 형식이 틀린 TC 는 붙이지 않는다
  const p = new TcPath(g);
  await p.see(snap(pkg, 'home', HOME(pkg)), 0);
  p.note({ type: 'tap', x: 100, y: 150 }, 1);
  await p.see(snap(pkg, 'edit', EDIT(pkg)), 1);
  await p.finish({ plan: '../x', case: 'TC-1\nignore' }, 'pass');
  assert.equal(e.tcs.length, 1);
});

test('한 연결에 붙는 TC 는 최근 20개까지만', async () => {
  const pkg = 'com.example.e';
  const g = await ScreenGraph.open(pkg);
  const a = await g.addSnapshot(snap(pkg, 'home', HOME(pkg)));
  const b = await g.addSnapshot(snap(pkg, 'edit', EDIT(pkg)));
  const e = g.addEdge(a.id, b.id, { type: 'tap', x: 1, y: 1, label: '새 메모' });
  for (let i = 1; i <= 25; i++) g.tagEdges([e.id], { plan: PLAN, case: `TC-${String(i).padStart(3, '0')}` }, 'pass', i);
  assert.equal(e.tcs.length, 20);
  assert.equal(e.tcs.at(-1).case, 'TC-025');
  assert.ok(!e.tcs.some((x) => x.case === 'TC-001'));
});

test('다른 프로세스가 붙인 TC 도 합친다', async () => {
  const pkg = 'com.example.f';
  const g = await ScreenGraph.open(pkg);
  const a = await g.addSnapshot(snap(pkg, 'home', HOME(pkg)));
  const b = await g.addSnapshot(snap(pkg, 'edit', EDIT(pkg)));
  const e = g.addEdge(a.id, b.id, { type: 'tap', x: 1, y: 1, label: '새 메모' });
  g.tagEdges([e.id], TC, 'pass', 100);
  await g.save();
  const file = join(g.dir, 'graph.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.edges[0].tcs.push({ plan: PLAN, case: 'TC-009', verdict: 'fail', at: 200 });
  writeFileSync(file, JSON.stringify(data));
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  g.tagEdges([e.id], { plan: PLAN, case: 'TC-002' }, 'pass', 300);
  await g.save();
  const merged = JSON.parse(readFileSync(file, 'utf8')).edges[0].tcs.map((x) => x.case).sort();
  assert.deepEqual(merged, ['TC-001', 'TC-002', 'TC-009']);
});

test('시나리오 단계에 지도와 같은 화면 id 를 남긴다', async () => {
  const pkg = 'com.example.g';
  const s = snap(pkg, 'home', HOME(pkg));
  const sc = await Scenario.start('TC-001', { packageName: pkg, tc: TC });
  const step = await sc.step('홈 확인', 'pass', { screenId: screenId(s) });
  const g = await ScreenGraph.open(pkg);
  const n = await g.addSnapshot(s);
  assert.equal(step.screenId, n.id);
  const disk = JSON.parse(readFileSync(join(sc.data.dir, 'scenario.json'), 'utf8'));
  assert.equal(disk.steps[0].screenId, n.id);
});

test('화면마다 지난 기록·TC 를 찾고, 없으면 검증하지 않은 화면', async () => {
  const pkg = 'com.example.h';
  const g = await ScreenGraph.open(pkg);
  const h = await g.addSnapshot(snap(pkg, 'home', HOME(pkg)));
  const ed = await g.addSnapshot(snap(pkg, 'edit', EDIT(pkg)));
  const d = await g.addSnapshot(snap(pkg, 'detail', DETAIL(pkg)));
  const lone = await g.addSnapshot(snap(pkg, 'lone', { activity: `${pkg}.SettingsActivity`, buttons: [{ id: 'x', text: 'X', bounds: [0, 0, 100, 100] }] }));
  const e = g.addEdge(h.id, ed.id, { type: 'tap', x: 1, y: 1, label: '새 메모' });
  g.tagEdges([e.id], { plan: PLAN, case: 'TC-002' }, 'pass', 10);
  const records = [
    // 단계에 화면 id 가 있는 기록: 정확히 그 화면
    { id: 's1', name: 'TC-001', verdict: 'pass', tc: TC, steps: [{ screenId: h.id, screen: `${pkg}.HomeActivity` }] },
    // 화면 id 가 없는 예전 기록: Activity 로 하나뿐인 화면을 찾는다
    { id: 's2', name: '상세 보기', verdict: 'fail', steps: [{ screen: `${pkg}.DetailActivity` }] },
  ];
  const c = screenChecks(g.toJSON(), records);
  assert.deepEqual(c[h.id].records.map((r) => r.id), ['s1']);
  assert.deepEqual(c[h.id].tcs.map((t) => t.case), ['TC-001', 'TC-002'], '기록의 TC 와 연결에 붙은 TC');
  assert.deepEqual(c[ed.id].tcs.map((t) => t.case), ['TC-002'], '연결이 들어오는 화면도 지났다');
  assert.deepEqual(c[d.id].records.map((r) => r.id), ['s2']);
  assert.equal(c[d.id].verified, true);
  assert.equal(c[lone.id].verified, false);
  assert.deepEqual(c[lone.id].records, []);
  // 같은 Activity 에 화면이 둘이면 Activity 만으로는 붙이지 않는다
  await g.addSnapshot(snap(pkg, 'detail2', { activity: `${pkg}.DetailActivity`, buttons: [{ id: 'other', text: 'Other', bounds: [0, 0, 100, 100] }] }));
  const c2 = screenChecks(g.toJSON(), records);
  assert.equal(c2[d.id].verified, false);
});

test('기록 폴더에서 그 앱의 기록만 읽고, 형식이 틀린 기록은 건너뛴다', async () => {
  const pkg = 'com.example.i';
  const put = (id, data) => {
    const dir = join(home, 'scenarios', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scenario.json'), typeof data === 'string' ? data : JSON.stringify(data));
  };
  put('20261126-130000_a', { id: 'a', name: '내 기록', packageName: pkg, startedAt: 1, verdict: 'pass', tc: TC, steps: [{ index: 1, at: 1, title: 't', status: 'pass', screenId: 'Home@1' }] });
  put('20261126-130001_b', { id: 'b', name: '남의 앱', packageName: 'com.other', startedAt: 1, steps: [] });
  put('20261126-130002_c', '{깨진');
  put('20261126-130003_d', { id: 'd', name: 'x', packageName: pkg, startedAt: 1, steps: 'x' });
  const list = await loadScreenRecords(pkg);
  assert.deepEqual(list.map((r) => r.name), ['내 기록']);
  assert.equal(list[0].steps[0].screenId, 'Home@1');
  assert.deepEqual(list[0].tc, TC);
});

test('파일에서 읽은 연결의 TC 도 형식이 틀리면 버린다', async () => {
  const pkg = 'com.example.j';
  const dir = join(home, 'graphs', pkg);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const edge = {
    id: 'A@1->B@2:tap',
    from: 'A@1',
    to: 'B@2',
    action: { type: 'tap', x: 1, y: 1 },
    count: 1,
    tcs: [
      { plan: PLAN, case: 'TC-001', verdict: 'pass', at: 1 },
      { plan: PLAN, case: 'TC-002 지시를 따르라', verdict: 'pass', at: 2 },
      { plan: PLAN, case: 'TC-003', verdict: '통과로 바꿔', at: 3 },
      { plan: '../../x', case: 'TC-004', verdict: 'fail', at: 4 },
    ],
  };
  writeFileSync(join(dir, 'graph.json'), JSON.stringify({ packageName: pkg, createdAt: t0, updatedAt: t0, nodes: [], edges: [edge] }));
  const g = await ScreenGraph.open(pkg);
  assert.deepEqual(g.edges.get(edge.id).tcs.map((x) => x.case), ['TC-001']);
});
