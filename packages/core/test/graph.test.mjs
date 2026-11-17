// 화면 지도 (packages/core/src/graph.ts) 중 기기 없이 도는 부분: 후보 요소·화면 id·ScreenGraph 기록·저장·합치기·
// 지도 파일 내보내기/가져오기·경로 계획. 리팩토링 전 동작을 고정하는 특성 테스트다. 빌드 결과(dist)를 시험한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 지도는 DROIDLENS_HOME 아래에 쓴다. 임시 폴더 대신 저장소 안(.gitignore 된 .test-home)에 두고 끝나면 지운다
const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { ScreenGraph, MAP_LIMITS, candidateActions, targetAt, screenId, planRoute } = await import('../dist/graph.js');
const { parseHierarchyXml } = await import('../dist/hierarchy.js');
const { PNG_MAGIC } = await import('../dist/device.js');
const { screenXml } = await import('./fake-device.mjs');

const PKG = 'com.example';
const snap = (name, s, pkg = PKG) => ({
  screen: { packageName: s.pkg ?? pkg, activity: s.activity, fragments: [] },
  hierarchy: parseHierarchyXml(screenXml(name, s, pkg)),
  signature: '',
});

const HOME = {
  activity: 'com.example.HomeActivity',
  buttons: [
    { id: 'tab_home', text: 'Home', bounds: [0, 2200, 360, 2400], selected: true },
    { id: 'tab_feed', text: 'Feed', bounds: [360, 2200, 720, 2400] },
    { id: 'btn_delete', text: '삭제', bounds: [0, 100, 500, 200] },
    { id: 'btn_detail', text: 'Detail', bounds: [0, 300, 1080, 500] },
  ],
};
const FEED = {
  activity: 'com.example.HomeActivity',
  buttons: [
    { id: 'tab_home', text: 'Home', bounds: [0, 2200, 360, 2400] },
    { id: 'tab_feed', text: 'Feed', bounds: [360, 2200, 720, 2400], selected: true },
    { id: 'post', text: 'Post', bounds: [0, 300, 1080, 500] },
  ],
};
const DETAIL = { activity: 'com.example.DetailActivity', buttons: [{ id: 'more', text: 'More', bounds: [0, 300, 1080, 500] }] };
const tap = (label, id, x = 10, y = 10) => ({ type: 'tap', x, y, label, selector: { id: `${PKG}:id/${id}` } });

test('MAP_LIMITS 값', () => {
  assert.deepEqual(MAP_LIMITS, { nodes: 2000, edges: 10_000, screenshotBytes: 5 * 1024 * 1024 });
});

test('candidateActions: 누를 수 있는 요소만, key 로 중복 제거, 컨테이너는 자식 글자로 라벨', () => {
  const n = (a, kids = '') =>
    `<node class="${a.cls ?? 'android.widget.Button'}" resource-id="${a.id ?? ''}" text="${a.text ?? ''}" content-desc="${a.desc ?? ''}" package="${a.pkg ?? PKG}" bounds="${a.b ?? '[0,0][100,100]'}" clickable="${a.click ?? true}" long-clickable="${!!a.long}" scrollable="false" focusable="false" focused="false" enabled="${a.enabled ?? true}" checkable="false" checked="false" selected="false" password="false">${kids}</node>`;
  const xml = `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">${n(
    { cls: 'android.widget.FrameLayout', click: false, b: '[0,0][1080,2400]' },
    n({ id: 'a:id/ok', text: 'OK', b: '[0,0][200,100]' }) +
      n({ id: 'a:id/ok', text: 'OK', b: '[0,200][200,300]' }) + // 같은 key → 하나만
      n({ id: 'a:id/off', text: 'Off', enabled: false }) +
      n({ id: 'a:id/plain', text: 'Plain', click: false }) +
      n({ id: 'a:id/tiny', text: 'Tiny', b: '[0,0][5,100]' }) +
      n({ id: 'a:id/input', cls: 'android.widget.EditText', text: 'type' }) +
      n({ id: 'b:id/ext', text: 'Ext', pkg: 'com.other' }) +
      n({ id: 'a:id/card', cls: 'android.widget.LinearLayout', b: '[0,400][1080,600]' }, n({ text: '상품 카드', click: false, b: '[10,410][500,450]' })) +
      n({ cls: 'android.widget.LinearLayout', b: '[0,700][1080,900]' }, n({ text: '이름 없는 카드', click: false, b: '[10,710][500,750]' })) +
      n({ id: 'a:id/icon', cls: 'android.widget.ImageButton', desc: '설정', b: '[900,0][1000,100]' }),
  )}</hierarchy>`;
  const s = { screen: { packageName: PKG, activity: 'X', fragments: [] }, hierarchy: parseHierarchyXml(xml), signature: '' };
  assert.deepEqual(
    candidateActions(s, PKG).map((c) => [c.key, c.label]),
    [
      ['a:id/ok|OK', 'OK'],
      ['a:id/card|card', 'card'], // id 가 있으면 id 이름이 라벨
      ['|이름 없는 카드', '이름 없는 카드'], // 이름 없는 컨테이너는 자식 글자
      ['a:id/icon|설정', '설정'],
    ],
  );
  // 패키지를 안 주면 다른 앱 요소도 넣는다
  assert.ok(candidateActions(s).some((c) => c.key === 'b:id/ext|Ext'));
  // 겹치면 가장 작은 요소
  assert.equal(targetAt(s, PKG, 950, 50)?.label, '설정');
  assert.equal(targetAt(s, PKG, 100, 50)?.label, 'OK');
  assert.equal(targetAt(s, PKG, 1070, 2390), undefined);
});

test('screenId: Activity 짧은 이름 @ 화면 시그니처 12자, Activity 를 모르면 unknown', () => {
  assert.match(screenId(snap('home', HOME)), /^HomeActivity@[0-9a-f]{12}$/);
  assert.match(screenId(snap('home', { ...HOME, activity: '' })), /^unknown@[0-9a-f]{12}$/);
  // 하단 탭의 선택 상태가 다르면 다른 화면
  assert.notEqual(screenId(snap('home', HOME)), screenId(snap('home', FEED)));
});

test('ScreenGraph: 화면 등록·방문 수·요소 위치·선택 탭·연결·눌러 본 기록·mermaid', async () => {
  const g = new ScreenGraph(PKG, join(home, 'mem'));
  const h = await g.addSnapshot(snap('home', HOME));
  assert.equal(h.visits, 1);
  assert.equal(h.label, 'HomeActivity');
  assert.equal(h.screenshot, undefined);
  assert.deepEqual(h.actions, ['Home', 'Feed', '삭제', 'Detail']);
  assert.deepEqual(
    h.targets.map((t) => [t.key, t.danger]),
    [
      [`${PKG}:id/tab_home|Home`, undefined],
      [`${PKG}:id/tab_feed|Feed`, undefined],
      [`${PKG}:id/btn_delete|삭제`, true],
      [`${PKG}:id/btn_detail|Detail`, undefined],
    ],
  );
  assert.deepEqual(h.selectedKeys, [`${PKG}:id/tab_home|Home`]);
  assert.equal((await g.addSnapshot(snap('home', HOME))).visits, 2);
  // 다른 앱 화면은 라벨 앞에 표시
  const ext = await g.addSnapshot(snap('ext', { pkg: 'com.other', activity: 'com.other.Main', buttons: [] }));
  assert.equal(ext.label, '↗ com.other · Main');
  const d = await g.addSnapshot(snap('detail', DETAIL));
  const e1 = g.addEdge(h.id, d.id, tap('Detail', 'btn_detail'));
  const e2 = g.addEdge(h.id, d.id, tap('Detail', 'btn_detail'));
  assert.equal(e1, e2);
  assert.equal(e1.count, 2);
  assert.equal(e1.id, `${h.id}->${d.id}:tap "Detail"`);
  g.addEdge(d.id, d.id, { type: 'key', key: 'back' });
  g.markTried(h.id, 'k1');
  g.markTried(h.id, 'k1');
  g.markTried('none', 'k1');
  assert.deepEqual(g.nodes.get(h.id).tried, ['k1']);
  const json = g.toJSON();
  assert.equal(json.packageName, PKG);
  assert.equal(json.resetAt, undefined);
  assert.deepEqual(json.nodes.map((n) => n.id), [h.id, ext.id, d.id]);
  assert.equal(json.edges.length, 2);
  // 자기 자신으로 가는 연결은 그리지 않는다
  assert.equal(g.toMermaid(), ['flowchart LR', '  S0["HomeActivity"]', '  S1["↗ com.other · Main"]', '  S2["DetailActivity"]', '  S0 -->|"tap \'Detail\'"| S2'].join('\n'));
});

test('ScreenGraph.path / replayPath: 위험 라벨 연결은 다시 따라가지 않는다', async () => {
  const g = new ScreenGraph(PKG, join(home, 'mem2'));
  const h = (await g.addSnapshot(snap('home', HOME))).id;
  const d = (await g.addSnapshot(snap('detail', DETAIL))).id;
  g.addEdge(h, d, tap('삭제', 'btn_delete'));
  assert.equal(g.path(h, d).length, 1);
  assert.equal(g.replayPath(h, d), undefined);
  g.addEdge(h, d, tap('Detail', 'btn_detail'));
  assert.equal(g.replayPath(h, d)[0].action.label, 'Detail');
  assert.equal(g.path(d, h), undefined);
});

test('planRoute: 기록된 경로, 같은 요소로 건너가기, 선택된 탭으로 건너가기', async () => {
  const g = new ScreenGraph(PKG, join(home, 'mem3'));
  const sHome = snap('home', HOME);
  const sFeed = snap('feed', FEED);
  const sDetail = snap('detail', DETAIL);
  const h = (await g.addSnapshot(sHome)).id;
  await g.addSnapshot(sFeed);
  const d = (await g.addSnapshot(sDetail)).id;
  assert.deepEqual(planRoute(g, sHome, h), []);
  // 기록 없음
  assert.equal(planRoute(g, sHome, d), undefined);
  g.addEdge(h, d, tap('Detail', 'btn_detail', 1, 2));
  const direct = planRoute(g, sHome, d);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].to, d);
  assert.equal(direct[0].action.x, 1); // 기록된 연결 그대로
  // Feed 화면에서 Detail 로: Feed 에는 Detail 버튼이 없지만 Home 탭이 있고 Home 은 그 탭이 선택된 화면으로 기록돼 있다
  const viaTab = planRoute(g, sFeed, d);
  assert.deepEqual(
    viaTab.map((s) => [s.action.type, s.action.label, s.to]),
    [
      ['tap', 'Home', h],
      ['tap', 'Detail', d],
    ],
  );
  // 건너가는 단계는 지금 화면의 요소 중심 좌표와 셀렉터로 만든다
  assert.deepEqual(viaTab[0].action, { type: 'tap', x: 180, y: 2300, label: 'Home', selector: { id: `${PKG}:id/tab_home` } });
  // 다른 화면에서 같은 요소(key)를 눌러 간 연결이 있으면 그 도착 화면으로 건너간다
  const g2 = new ScreenGraph(PKG, join(home, 'mem4'));
  const h2 = (await g2.addSnapshot(sHome)).id;
  const f2 = (await g2.addSnapshot(sFeed)).id;
  const d2 = (await g2.addSnapshot(sDetail)).id;
  g2.nodes.get(h2).selectedKeys = [];
  g2.addEdge(d2, f2, tap('Feed', 'tab_feed'));
  g2.addEdge(f2, d2, tap('Post', 'post'));
  assert.deepEqual(
    planRoute(g2, sHome, d2).map((s) => [s.action.label, s.to]),
    [
      ['Feed', f2],
      ['Post', d2],
    ],
  );
  // 위험 라벨 요소로는 건너가지 않는다
  const g3 = new ScreenGraph(PKG, join(home, 'mem5'));
  await g3.addSnapshot(sHome);
  const f3 = (await g3.addSnapshot(sFeed)).id;
  const d3 = (await g3.addSnapshot(sDetail)).id;
  g3.addEdge(f3, d3, tap('삭제', 'btn_delete'));
  assert.equal(planRoute(g3, sHome, d3), undefined);
});

test('save: graph.json·graph.mmd 를 쓰고, 다른 프로세스가 고친 파일은 다시 열 때 합친다', async () => {
  const pkg = 'com.example.save';
  const g = await ScreenGraph.open(pkg);
  assert.equal(g.dir, join(home, 'graphs', pkg));
  const h = await g.addSnapshot(snap('home', HOME, pkg));
  await g.save();
  const file = join(g.dir, 'graph.json');
  assert.ok(existsSync(join(g.dir, 'graph.mmd')));
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.nodes.map((n) => n.id), [h.id]);
  // 다른 프로세스가 화면 하나와 방문 수를 더해 저장했다
  onDisk.nodes[0].visits = 9;
  onDisk.nodes.push({ ...onDisk.nodes[0], id: 'OtherActivity@aaaaaaaaaaaa', visits: 1 });
  onDisk.edges.push({ id: 'e', from: h.id, to: 'OtherActivity@aaaaaaaaaaaa', action: { type: 'key', key: 'back' }, count: 3 });
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, JSON.stringify(onDisk));
  const again = await ScreenGraph.open(pkg);
  assert.equal(again, g); // 한 프로세스에서는 같은 인스턴스
  assert.equal(g.nodes.size, 2);
  assert.equal(g.nodes.get(h.id).visits, 9);
  assert.equal(g.edges.get('e').count, 3);
  // 다른 프로세스가 나중에 초기화했으면 메모리 내용을 버린다
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, JSON.stringify({ packageName: pkg, resetAt: Date.now() + 1000, createdAt: 0, updatedAt: 0, nodes: [], edges: [] }));
  await ScreenGraph.open(pkg);
  assert.equal(g.nodes.size, 0);
  assert.equal(g.edges.size, 0);
});

test('reset: 폴더를 지우고 빈 graph.json 에 초기화 시각을 남긴다', async () => {
  const pkg = 'com.example.reset';
  const g = await ScreenGraph.open(pkg);
  await g.addSnapshot(snap('home', HOME, pkg));
  await g.save();
  await ScreenGraph.reset(pkg);
  assert.equal(g.nodes.size, 0);
  const data = JSON.parse(readFileSync(join(home, 'graphs', pkg, 'graph.json'), 'utf8'));
  assert.equal(data.nodes.length, 0);
  assert.ok(data.resetAt > 0);
  const fresh = await ScreenGraph.open(pkg);
  assert.notEqual(fresh, g);
  assert.equal(fresh.nodes.size, 0);
  await assert.rejects(ScreenGraph.reset('bad pkg!'), /잘못된 패키지 이름/);
});

test('saveSoon·flushAll: 미뤄 둔 저장을 프로세스 끝나기 전에 마저 쓴다', async () => {
  const pkg = 'com.example.soon';
  const g = await ScreenGraph.open(pkg);
  await g.addSnapshot(snap('home', HOME, pkg));
  g.saveSoon(60_000);
  assert.equal(existsSync(join(g.dir, 'graph.json')), false);
  await ScreenGraph.flushAll();
  assert.equal(JSON.parse(readFileSync(join(g.dir, 'graph.json'), 'utf8')).nodes.length, 1);
});

test('exportBundle → importBundle: 스크린샷까지 옮기고, 여러 번 가져와도 수치가 불어나지 않는다', async () => {
  const pkg = 'com.example.bundle';
  const g = await ScreenGraph.open(pkg);
  const png = Buffer.concat([PNG_MAGIC, Buffer.from('home-shot')]);
  const h = await g.addSnapshot({ ...snap('home', HOME, pkg), png });
  assert.equal(h.screenshot, `${h.id.replace(/[^\w.-]/g, '_')}.png`);
  const d = await g.addSnapshot(snap('detail', DETAIL, pkg));
  g.addEdge(h.id, d.id, tap('Detail', 'btn_detail'));
  g.addEdge(h.id, d.id, tap('Detail', 'btn_detail'));
  g.markTried(h.id, 'x');
  g.launchScreen = h.id;
  await g.save();
  const bundle = await g.exportBundle();
  assert.equal(bundle.format, 'droidlens-map');
  assert.equal(bundle.version, 1);
  assert.deepEqual(Object.keys(bundle.screenshots), [h.screenshot]);
  assert.equal(Buffer.from(bundle.screenshots[h.screenshot], 'base64').toString('latin1').slice(8), 'home-shot');

  await ScreenGraph.reset(pkg);
  const g2 = await ScreenGraph.open(pkg);
  // JSON 으로 주고받는 것처럼 한 번 직렬화한다
  const wire = JSON.parse(JSON.stringify(bundle));
  wire.graph.nodes.push({ id: 'not a screen id' }); // 형식이 틀린 화면은 버린다
  wire.graph.edges.push({ from: h.id, to: 'Nowhere@bbbbbbbbbbbb', action: { type: 'key', key: 'back' }, count: 1 }); // 없는 화면으로 가는 연결
  wire.graph.nodes[1].label = 'Detail\u0000 X';
  const r = await g2.importBundle(wire);
  assert.deepEqual(r, { nodes: 2, edges: 1, dropped: 2 });
  assert.equal(g2.launchScreen, h.id);
  const hn = g2.nodes.get(h.id);
  // 요소 목록·눌러 본 기록은 받지 않는다
  assert.deepEqual(hn.actions, []);
  assert.equal(hn.targets, undefined);
  assert.equal(hn.tried, undefined);
  assert.match(hn.screenshot, /^HomeActivity_[0-9a-f]{12}-[0-9a-f]{8}\.png$/);
  assert.ok(readdirSync(g2.dir).includes(hn.screenshot));
  assert.equal(g2.nodes.get(d.id).label, 'Detail  X');
  assert.equal(g2.edges.get(`${h.id}->${d.id}:tap "Detail"`).count, 2);
  const r2 = await g2.importBundle(wire);
  assert.deepEqual(r2, { nodes: 0, edges: 0, dropped: 2 });
  assert.equal(g2.edges.get(`${h.id}->${d.id}:tap "Detail"`).count, 2);
  assert.ok(existsSync(join(g2.dir, 'graph.json')));
});

test('importBundle: 형식·앱·한도가 맞지 않으면 거절한다', async () => {
  const pkg = 'com.example.reject';
  const g = await ScreenGraph.open(pkg);
  const ok = { format: 'droidlens-map', graph: { packageName: pkg, nodes: [], edges: [] }, screenshots: {} };
  await assert.rejects(g.importBundle({ ...ok, format: 'other' }), /DroidLens 화면 지도 파일이 아닙니다/);
  await assert.rejects(g.importBundle(null), /DroidLens 화면 지도 파일이 아닙니다/);
  await assert.rejects(g.importBundle({ ...ok, graph: { ...ok.graph, packageName: 'com.evil\u0007' } }), /다른 앱의 지도입니다 \(com\.evil \)/);
  await assert.rejects(
    g.importBundle({ ...ok, graph: { ...ok.graph, nodes: Array.from({ length: MAP_LIMITS.nodes + 1 }, () => ({})) } }),
    /화면 2000개, 연결 10000개를 넘는 지도는 가져올 수 없습니다/,
  );
  // PNG 가 아닌 스크린샷은 버리고 화면만 받는다
  const node = { id: 'HomeActivity@cccccccccccc', packageName: pkg, activity: 'a', fragments: [], signature: 'cccccccccccc', label: 'H', screenshot: 's.png', firstSeen: 1, visits: 1, nodeCount: 1, maxDepth: 1 };
  const r = await g.importBundle({ ...ok, graph: { ...ok.graph, nodes: [node] }, screenshots: { 's.png': Buffer.from('not png').toString('base64') } });
  assert.deepEqual(r, { nodes: 1, edges: 0, dropped: 0 });
  assert.equal(g.nodes.get(node.id).screenshot, undefined);
});
