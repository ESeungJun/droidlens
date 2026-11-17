// 화면 지도 중 기기를 조작하는 부분(안정 대기·앱 실행·전이 기록·경로 재생·화면 이동·자동 탐색·흐름 수집)을
// 가짜 기기(fake-device.mjs)로 시험한다. 리팩토링 전 동작을 고정하는 특성 테스트이고, 자동 탐색은 결과와
// 기기에 보낸 명령 순서를 fixtures/graph-device.golden.json 과 비교한다.
// 동작을 일부러 바꿨으면 UPDATE_GOLDEN=1 로 돌려 기준을 다시 만들고 바뀐 내용을 리뷰한다.
// 에이전트 없는 경로(uiautomator·screencap)만 다룬다: 에이전트 경로는 기기가 있어야 한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
process.env.DROIDLENS_AGENT = '0';
after(() => rmSync(home, { recursive: true, force: true }));

const core = await import('../dist/graph.js');
const { ScreenGraph, FlowCollector, waitForSettle, launchAndSettle, dismissSystemDialog, captureSnapshot, recordTransition, startTransition, followPath, navigateTo, explore, screenId, performAction } = core;
const { structureSignature } = await import('../dist/hierarchy.js');
const { fakeDevice } = await import('./fake-device.mjs');

const GOLDEN = join(import.meta.dirname, 'fixtures', 'graph-device.golden.json');
const update = process.env.UPDATE_GOLDEN === '1';
const golden = !update && existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
const produced = {};
after(() => {
  if (update) writeFileSync(GOLDEN, JSON.stringify(produced, null, 2) + '\n');
});
function matchGolden(key, raw) {
  // 기준 파일과 같은 모양으로 비교한다 (undefined 값은 JSON 에 남지 않는다)
  const value = JSON.parse(JSON.stringify(raw));
  produced[key] = value;
  if (update) return;
  assert.ok(golden[key], `기준 없음: ${key} (UPDATE_GOLDEN=1 로 만든다)`);
  assert.deepEqual(value, golden[key]);
}

const b = (i) => [0, 100 + i * 100, 1080, 190 + i * 100];
const app = (pkg) => ({
  pkg,
  launch: 'home',
  screens: {
    home: {
      activity: `${pkg}.HomeActivity`,
      buttons: [
        { id: 'detail', text: 'Detail', bounds: b(0), go: 'detail' },
        { id: 'settings', text: 'Settings', bounds: b(1), go: 'settings' },
        { id: 'delete', text: '삭제', bounds: b(2), go: 'detail' },
        { id: 'up', desc: '뒤로', cls: 'android.widget.ImageButton', bounds: [900, 0, 1000, 90], go: '@back' },
        { id: 'share', text: 'Share', bounds: b(3), go: 'other' },
        { id: 'freeze', text: 'Freeze', bounds: b(4), go: 'anr' },
        { id: 'modal', text: 'Modal', bounds: b(5), go: 'modal' },
        { id: 'off', text: 'Off', enabled: false, bounds: b(6), go: 'detail' },
        { id: 'pager', text: 'Pager', bounds: b(7), go: 'page1' },
      ],
    },
    detail: { activity: `${pkg}.DetailActivity`, buttons: [{ id: 'more', text: 'More', bounds: b(0), go: 'deep' }] },
    deep: { activity: `${pkg}.DeepActivity`, buttons: [{ id: 'deeper', text: 'Deeper', bounds: b(0), go: 'deeper' }] },
    deeper: { activity: `${pkg}.DeeperActivity`, buttons: [{ id: 'deepest', text: 'Deepest', bounds: b(0), go: 'deepest' }] },
    deepest: { activity: `${pkg}.DeepestActivity`, buttons: [] },
    settings: { activity: `${pkg}.SettingsActivity`, buttons: [{ id: 'toggle', text: 'Toggle', bounds: b(0) }] },
    other: { pkg: 'com.other', activity: 'com.other.ShareActivity', buttons: [{ id: 'x', text: 'X', bounds: b(0) }] },
    anr: {
      pkg: 'android',
      activity: 'com.android.server.am.AppNotRespondingDialog',
      buttons: [
        { id: 'android:id/aerr_wait', text: 'Wait', bounds: b(0), go: '@back' },
        { id: 'android:id/aerr_close', text: 'Close', bounds: b(1), go: '@back' },
      ],
    },
    modal: { activity: `${pkg}.ModalActivity`, backConsumes: 2, buttons: [{ id: 'ok', text: 'Ok', bounds: b(0) }] },
    page1: {
      activity: `${pkg}.PagerActivity`,
      swipe: { left: 'page2' },
      buttons: [
        { id: 'buy', text: 'Buy', bounds: b(0), go: 'detail' },
        { id: 'next', text: 'Next', bounds: b(1), go: 'page2' },
      ],
    },
    page2: { activity: `${pkg}.Pager2Activity`, swipe: { right: '@back' }, buttons: [{ id: 'p2', text: 'P2', bounds: b(0) }] },
  },
});
const center = (i) => ({ x: 540, y: 145 + i * 100 });

/** 그래프 JSON 에서 시각 값을 빼서 비교할 수 있게 한다 */
const stable = (g) => ({
  ...g,
  createdAt: undefined,
  updatedAt: undefined,
  resetAt: undefined,
  nodes: g.nodes.map((n) => ({ ...n, firstSeen: undefined, lastSeen: undefined })),
});

test('waitForSettle(에이전트 없음): 스크린샷이 같아질 때까지 기다리고 스크린샷·계층·Activity 를 담는다', async () => {
  const f = fakeDevice(app('com.ex.settle'));
  f.open('home');
  const s = await waitForSettle(f.dev);
  assert.equal(s.screen.packageName, 'com.ex.settle');
  assert.equal(s.screen.activity, 'com.ex.settle.HomeActivity');
  assert.equal(s.signature, structureSignature(s.hierarchy.root));
  assert.equal(s.png.toString('latin1').slice(8), 'screen:home');
  assert.deepEqual(f.commands(), ['screencap -p', 'screencap -p', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', f.commands()[3]]);
  assert.match(f.commands()[3], /^uiautomator dump --compressed \/data\/local\/tmp\/droidlens_ui_X\.xml/);
  // 취소되면 바로 던진다
  const ac = new AbortController();
  ac.abort(new Error('취소'));
  await assert.rejects(waitForSettle(f.dev, { signal: ac.signal }), /취소/);
});

test('captureSnapshot: screenshot:false 면 PNG 를 받지 않는다', async () => {
  const f = fakeDevice(app('com.ex.cap'));
  f.open('home', 'detail');
  const s = await captureSnapshot(f.dev, { screenshot: false });
  assert.equal(s.png, undefined);
  assert.equal(s.screen.activity, 'com.ex.cap.DetailActivity');
  assert.ok(!f.commands().some((c) => c.startsWith('screencap')));
  assert.ok((await captureSnapshot(f.dev)).png);
});

test('launchAndSettle: 다시 시작하면 force-stop 뒤 실행하고 첫 화면을 돌려준다', async () => {
  const f = fakeDevice(app('com.ex.launch'));
  f.open('detail');
  const s = await launchAndSettle(f.dev, 'com.ex.launch', { restart: true });
  assert.equal(s.screen.activity, 'com.ex.launch.HomeActivity');
  assert.equal(f.commands()[0], 'am force-stop com.ex.launch');
  assert.ok(f.commands().some((c) => c.startsWith("am start -W -f 0x10008000 -n 'com.ex.launch/com.ex.launch.HomeActivity'")));
  await assert.rejects(launchAndSettle(f.dev, 'bad pkg'), /잘못된 패키지 이름/);
});

test('dismissSystemDialog: ANR 은 대기, 크래시는 닫기, 아니면 아무것도 안 한다', async () => {
  const f = fakeDevice(app('com.ex.dialog'));
  f.open('home', 'anr');
  assert.equal(await dismissSystemDialog(f.dev, await captureSnapshot(f.dev, { screenshot: false })), 'anr');
  assert.equal(f.screen, 'home');
  assert.ok(f.commands().includes('input tap 540 145'));
  assert.equal(await dismissSystemDialog(f.dev, await captureSnapshot(f.dev, { screenshot: false })), undefined);
  const crash = app('com.ex.dialog2');
  crash.screens.anr.buttons = crash.screens.anr.buttons.slice(1);
  const f2 = fakeDevice(crash);
  f2.open('home', 'anr');
  assert.equal(await dismissSystemDialog(f2.dev, await captureSnapshot(f2.dev, { screenshot: false })), 'crash');
});

test('performAction: 키 이름 검사, launch 는 패키지 필요, deeplink·manual 은 아무것도 안 한다', async () => {
  const f = fakeDevice(app('com.ex.perf'));
  f.open('home');
  await performAction(f.dev, { type: 'key', key: 'back' });
  await assert.rejects(performAction(f.dev, { type: 'key', key: 'nope' }), /알 수 없는 키: nope/);
  await assert.rejects(performAction(f.dev, { type: 'launch' }), /launch에는 패키지가 필요합니다/);
  await performAction(f.dev, { type: 'deeplink', uri: 'x://y' });
  await performAction(f.dev, { type: 'manual' });
  await performAction(f.dev, { type: 'longpress', x: 1, y: 2 });
  await performAction(f.dev, { type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.deepEqual(f.commands(), ['input keyevent 4', 'input swipe 1 2 1 2 800', 'input swipe 1 2 3 4 300']);
});

test('recordTransition: 누른 좌표를 그 자리 요소(라벨·셀렉터)로 바꿔 연결을 남기고 눌러 봤다고 표시한다', async () => {
  const pkg = 'com.ex.rec';
  const f = fakeDevice(app(pkg));
  f.open('home');
  const g = await ScreenGraph.open(pkg);
  const r = await recordTransition(f.dev, g, { type: 'tap', ...center(0) });
  assert.equal(f.screen, 'detail');
  assert.equal(r.from.label, 'HomeActivity');
  assert.equal(r.to.label, 'DetailActivity');
  assert.deepEqual(r.edge.action, { type: 'tap', x: 540, y: 145, label: 'Detail', selector: { id: `${pkg}:id/detail` } });
  assert.deepEqual(g.nodes.get(r.from.id).tried, [`${pkg}:id/detail|Detail`]);
  assert.ok(existsSync(join(g.dir, 'graph.json')));
  // 새 화면일 때만 스크린샷을 찍어 둔다
  assert.ok(r.to.screenshot && existsSync(join(g.dir, r.to.screenshot)));
  // 기다리는 사이 취소되면 연결을 남기지 않는다
  const t = await startTransition(f.dev, g, { type: 'tap', ...center(0) });
  const ac = new AbortController();
  ac.abort(new Error('다른 조작'));
  await assert.rejects(t.finish(ac.signal), /다른 조작/);
  assert.equal(g.edges.size, 1);
});

test('followPath: 같은 요소를 다시 찾아 누르고, 다른 화면·위험 버튼·다시 실행할 수 없는 연결이면 멈춘다', async () => {
  const pkg = 'com.ex.follow';
  const f = fakeDevice(app(pkg));
  f.open('home');
  const sHome = await captureSnapshot(f.dev, { screenshot: false });
  f.open('home', 'detail');
  const detailId = screenId(await captureSnapshot(f.dev, { screenshot: false }));
  f.open('home', 'detail', 'deep');
  const deepId = screenId(await captureSnapshot(f.dev, { screenshot: false }));
  f.open('home');
  f.log.length = 0;
  // 기록된 좌표(1,1)는 쓰지 않고 지금 화면에서 찾은 요소의 중심을 누른다
  const steps = [
    { action: { type: 'tap', x: 1, y: 1, label: 'Detail', selector: { id: `${pkg}:id/detail` } }, to: detailId },
    { action: { type: 'tap', x: 1, y: 1, label: 'More', selector: { id: `${pkg}:id/more` } }, to: deepId },
  ];
  const end = await followPath(f.dev, pkg, sHome, steps);
  assert.equal(screenId(end), deepId);
  assert.deepEqual(
    f.commands().filter((c) => c.startsWith('input')),
    ['input tap 540 145', 'input tap 540 145'],
  );
  f.open('home');
  await assert.rejects(followPath(f.dev, pkg, sHome, [{ action: steps[0].action, to: deepId }]), /예상과 다른 화면\(com\.ex\.follow DetailActivity\)/);
  f.open('home');
  await assert.rejects(followPath(f.dev, pkg, sHome, [{ action: { type: 'tap', x: 0, y: 0, label: 'Nope' }, to: detailId }]), /"Nope"을\(를\) 찾을 수 없습니다/);
  await assert.rejects(followPath(f.dev, pkg, sHome, [{ action: { type: 'tap', x: 0, y: 0, label: '삭제' }, to: detailId }]), /다시 실행하지 않는 동작/);
  await assert.rejects(followPath(f.dev, pkg, sHome, [{ action: { type: 'deeplink', uri: 'a://b' }, to: detailId }]), /다시 실행하지 않는 동작이라 멈춥니다: deeplink/);
});

test('navigateTo: 이미 그 화면이면 그대로, 아니면 앱을 다시 실행해 기록된 경로를 따라간다', async () => {
  const pkg = 'com.ex.nav';
  const f = fakeDevice(app(pkg));
  const g = await ScreenGraph.open(pkg);
  f.open('home');
  const a = await recordTransition(f.dev, g, { type: 'tap', ...center(0) });
  const b2 = await recordTransition(f.dev, g, { type: 'tap', ...center(0) });
  await assert.rejects(navigateTo(f.dev, g, 'Nope@aaaaaaaaaaaa'), /지도에 없는 화면입니다/);
  const here = await navigateTo(f.dev, g, b2.to.id);
  assert.deepEqual([here.moved, here.path], [false, []]);
  f.open('settings');
  f.log.length = 0;
  const logs = [];
  const r = await navigateTo(f.dev, g, b2.to.id, (m) => logs.push(m));
  assert.equal(r.moved, true);
  assert.equal(screenId(r.snap), b2.to.id);
  assert.equal(g.launchScreen, a.from.id);
  assert.deepEqual(logs, ['기록된 경로로 이동: tap "Detail" → tap "More"']);
  matchGolden('navigateTo.commands', f.commands());
  // 경로가 없으면 이유를 알려 준다
  f.open('home', 'settings');
  const s = await captureSnapshot(f.dev, { screenshot: false });
  const settings = await g.addSnapshot(s);
  f.open('home', 'detail');
  await assert.rejects(navigateTo(f.dev, g, settings.id), /앱 첫 화면에서 이 화면까지 기록된 경로가 없습니다/);
  g.addEdge(a.from.id, settings.id, { type: 'tap', x: 1, y: 1, label: '삭제' });
  f.open('home', 'detail');
  await assert.rejects(navigateTo(f.dev, g, settings.id), /위험 버튼·딥링크·앱 밖 이동을 거치는 경로만 기록돼 있어/);
});

test('explore: 첫 화면부터 깊이 우선으로 누르고 돌아오며 지도를 만든다 (결과·명령 순서 고정)', async () => {
  const pkg = 'com.ex.explore';
  const f = fakeDevice(app(pkg));
  f.open('deep');
  const progress = [];
  const r = await explore(f.dev, { packageName: pkg, onProgress: (e) => progress.push([e.step, e.message, e.screen ?? null]) });
  matchGolden('explore.result', { ...r, graph: stable(r.graph) });
  matchGolden('explore.progress', progress);
  matchGolden('explore.commands', f.commands());
  // 사람이 읽는 확인 몇 가지 (기준 파일이 틀려도 잡히게)
  assert.equal(r.limited, false);
  assert.deepEqual(
    r.skipped.map((s) => [s.label, s.reason]),
    [
      ['삭제', '위험 라벨'],
      ['Buy', '위험 라벨'],
    ],
  );
  assert.ok(r.errors.some((e) => e.includes('ANR (응답 없음)')));
  assert.ok(r.graph.nodes.some((n) => n.label === 'DeepestActivity'));
  assert.ok(!r.graph.edges.some((e) => e.from.startsWith('DeepestActivity')), '최대 깊이 화면은 더 들어가지 않는다');
});

test('explore: 지금 화면부터(relaunch:false) 지정한 인터랙션만, 위험 라벨은 허용하지 않으면 건너뛴다', async () => {
  const pkg = 'com.ex.only';
  const f = fakeDevice(app(pkg));
  f.open('home', 'page1');
  const progress = [];
  const r = await explore(f.dev, {
    packageName: pkg,
    relaunch: false,
    maxDepth: 2,
    only: [
      { kind: 'swipe', direction: 'left' },
      { kind: 'tap', key: `${pkg}:id/buy|Buy` },
      { kind: 'tap', key: `${pkg}:id/gone|Gone` },
    ],
    onProgress: (e) => progress.push([e.step, e.message, e.screen ?? null]),
  });
  matchGolden('exploreOnly.result', { ...r, graph: stable(r.graph) });
  matchGolden('exploreOnly.progress', progress);
  matchGolden('exploreOnly.commands', f.commands());
  assert.deepEqual(
    r.skipped.map((s) => [s.label, s.reason]),
    [
      ['Buy', '위험 라벨 (허용하지 않음)'],
      ['Gone', '현재 화면에서 찾을 수 없음'],
    ],
  );
  // 다른 앱 화면에서는 시작하지 않는다
  f.open('home', 'other');
  await assert.rejects(explore(f.dev, { packageName: pkg, relaunch: false }), /지금 화면이 com\.ex\.only 앱이 아닙니다/);
});

test('explore: maxSteps 에 닿으면 멈추고 limited 를 알린다', async () => {
  const pkg = 'com.ex.limit';
  const f = fakeDevice(app(pkg));
  const r = await explore(f.dev, { packageName: pkg, maxSteps: 2 });
  assert.equal(r.steps, 2);
  assert.equal(r.limited, true);
});

test('FlowCollector: 알려 준 행동으로 직전 화면과 지금 화면을 잇고, 앱 밖·실패면 끊는다', async () => {
  const pkg = 'com.ex.flow';
  const f = fakeDevice(app(pkg));
  // 에이전트가 없으면 모으지 않는다
  assert.equal(await FlowCollector.open(f.dev, pkg), undefined);
  const g = await ScreenGraph.open(pkg);
  const c = new FlowCollector(f.dev, g); // 테스트에서만 생성자를 바로 부른다 (open 은 에이전트가 있어야 만든다)
  f.open('home');
  assert.equal((await c.observe()).screen.activity, `${pkg}.HomeActivity`);
  c.note({ type: 'tap', ...center(0) });
  f.open('home', 'detail');
  await c.observe();
  c.note({ type: 'swipe', direction: 'left' });
  f.open('home', 'detail', 'deep');
  await c.observe();
  c.note({ type: 'key', key: 'back' });
  f.open('home', 'other');
  assert.equal((await c.observe()).screen.packageName, 'com.other');
  c.note({ type: 'tap', ...center(0) });
  f.open('home');
  await c.observe(); // 앱 밖에서 돌아온 건 잇지 않는다
  c.forget();
  c.note({ type: 'tap', x: 5, y: 5 });
  f.open('home', 'settings');
  await c.observe(); // forget 뒤 첫 관찰은 잇지 않는다
  c.note({ type: 'tap', x: 5, y: 5 }); // 요소가 없는 자리
  f.open('home', 'settings', 'deep');
  await c.observe();
  await c.flush();
  const edges = [...g.edges.values()].map((e) => [e.from.split('@')[0], e.to.split('@')[0], e.action]);
  assert.deepEqual(edges, [
    ['HomeActivity', 'DetailActivity', { type: 'tap', x: 540, y: 145, label: 'Detail', selector: { id: `${pkg}:id/detail` } }],
    ['DetailActivity', 'DeepActivity', { type: 'swipe', x1: 918, y1: 1200, x2: 162, y2: 1200, direction: 'left' }],
    ['SettingsActivity', 'DeepActivity', { type: 'tap', x: 5, y: 5 }],
  ]);
  assert.ok(existsSync(join(g.dir, 'graph.json')));
});
