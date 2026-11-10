// 도구 목록·안내문·응답 크기 상한·오류 메시지·파괴적 조작 확인 (가짜 adb)
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, ui, solidPng } from './harness.mjs';

let s;
before(async () => {
  s = await start();
});
after(async () => {
  await s?.close();
});

test('tools/list: 모든 인자에 설명이 있고 서버 안내문이 있다', async () => {
  const { tools } = await s.client.listTools();
  assert.ok(tools.length >= 51);
  const missing = tools.flatMap((t) => Object.entries(t.inputSchema?.properties ?? {}).filter(([, v]) => !v.description).map(([k]) => `${t.name}.${k}`));
  assert.deepEqual(missing, []);
  for (const t of tools) assert.ok((t.description ?? '').length >= 15, `${t.name} 설명이 너무 짧다`);
  const inst = s.client.getInstructions();
  assert.match(inst, /devices.*current_screen.*view_hierarchy.*tap.*wait_for/s);
  assert.match(inst, /sdk_apps/);
});

test('서버 버전이 패키지 버전과 같다', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(s.client.getServerVersion().version, pkg.version);
});

test('도구 이름·기존 인자 이름은 그대로다 (기존 사용자 호환)', async () => {
  const { tools } = await s.client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const n of ['devices', 'device_info', 'screenshot', 'record_start', 'record_stop', 'agent_status', 'current_screen', 'view_hierarchy', 'find_nodes', 'screenshot_compare', 'tap', 'swipe', 'type_text', 'press_key', 'wait_for', 'list_packages', 'app_info', 'launch_app', 'stop_app', 'clear_app_data', 'open_deeplink', 'analyze_libraries', 'logcat', 'crashes', 'perf_startup', 'perf_stats', 'graph_record', 'graph_get', 'explore', 'graph_navigate', 'sdk_apps', 'network_requests', 'network_request_detail', 'prefs_get', 'prefs_set', 'prefs_remove', 'db_list', 'db_query', 'app_events', 'network_mock_set', 'network_mock_list', 'network_mock_remove', 'scenario_start', 'scenario_step', 'scenario_finish', 'script_list', 'script_read', 'script_write', 'script_run', 'suite_run']) {
    assert.ok(names.has(n), n);
  }
  const props = (n) => Object.keys(tools.find((t) => t.name === n).inputSchema.properties);
  for (const k of ['serial', 'id', 'text', 'textContains', 'desc', 'descContains', 'className', 'index', 'x', 'y', 'long', 'allowDanger']) assert.ok(props('tap').includes(k), k);
  for (const k of ['serial', 'packageName', 'db', 'sql', 'write']) assert.ok(props('db_query').includes(k), k);
});

test('DROIDLENS_TOOLS=core: 묶음만 등록해 목록이 준다', async () => {
  const c = await start({ DROIDLENS_TOOLS: 'core' });
  try {
    const { tools } = await c.client.listTools();
    const all = (await s.client.listTools()).tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('tap') && names.includes('view_hierarchy') && names.includes('logcat'));
    assert.ok(!names.some((n) => /^(prefs_|db_|network_|graph_|scenario_|script_|perf_)/.test(n)), names.join(','));
    assert.ok(JSON.stringify(tools).length < JSON.stringify(all).length * 0.6);
  } finally {
    await c.close();
  }
});

test('screenshot: 이미지 좌표를 기기 좌표로 바꾸는 배율을 알려 준다', async () => {
  s.setFile('shot.png', solidPng(1080, 2400));
  const r = await s.call('screenshot', { label: 't' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /saved: .*_t\.png/);
  assert.match(r.text, /원본 1080x2400 · 이미지 405x900 · tap·swipe 좌표\(기기 픽셀\) = 이미지 좌표 × 2\.667/);
  assert.equal(r.content[0].mimeType, 'image/jpeg');
});

test('view_hierarchy: 300줄에서 자르고 줄이는 방법을 알려 준다', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ text: `항목 ${i}`, bounds: [0, i * 10, 1080, i * 10 + 10] }));
  s.setUi(ui(...many));
  const r = await s.call('view_hierarchy', {});
  const lines = r.text.split('\n');
  assert.equal(lines.length, 301);
  assert.match(lines[300], /… 50\d줄 중 300줄만 표시\. interactiveOnly=true 나 maxDepth/);
  const more = await s.call('view_hierarchy', { maxLines: 1000 });
  assert.ok(more.text.split('\n').length > 500);
  assert.ok(!more.text.includes('줄만 표시'));
});

test('find_nodes: 20개까지만, 없으면 비슷한 글자, 셀렉터 없으면 오류', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ text: `항목 ${i}`, bounds: [0, i * 10, 1080, i * 10 + 10] }));
  s.setUi(ui(...many, { text: '장바구니 담기', bounds: [0, 900, 1080, 950] }));
  const r = await s.call('find_nodes', { textContains: '항목' });
  assert.equal(r.text.split('\n').length, 21);
  assert.match(r.text, /… 50개 중 20개만 표시/);
  assert.equal((await s.call('find_nodes', { textContains: '항목', limit: 50 })).text.split('\n').length, 50);
  assert.match((await s.call('find_nodes', { text: '장바구니' })).text, /매칭되는 노드가 없습니다\. 비슷한 후보\(화면의 글자\): "장바구니 담기"/);
  assert.equal((await s.call('find_nodes', {})).isError, true);
});

test('JSON 응답은 들여쓰지 않는다', async () => {
  const r = await s.call('devices');
  assert.ok(!r.text.includes('\n'), r.text);
  assert.equal(JSON.parse(r.text)[0].serial, 'fake');
});

test('current_screen: 기본은 Fragment 를 조회하지 않는다', async () => {
  s.setUi(ui({ text: 'a', bounds: [0, 0, 10, 10] }));
  s.clearLog();
  const r = await s.call('current_screen');
  assert.equal(JSON.parse(r.text).activity, 'com.example.app.MainActivity');
  assert.ok(!s.log().some((l) => l.startsWith('dumpsys activity top')));
  await s.call('current_screen', { fragments: true });
  assert.ok(s.log().some((l) => l.startsWith('dumpsys activity top')));
});

test('adb 실패: 연결 끊김·미승인은 할 일을 알려 주고 명령을 되풀이하지 않는다', async () => {
  s.setUi(ui({ text: 'a', bounds: [0, 0, 10, 10] }));
  s.setFile('mode.txt', 'offline');
  const off = await s.call('tap', { x: 1, y: 2 });
  assert.equal(off.isError, true);
  assert.match(off.text, /기기 fake 연결이 끊겼습니다/);
  assert.ok(!off.text.includes('Command failed'));
  s.setFile('mode.txt', 'unauthorized');
  assert.match((await s.call('view_hierarchy')).text, /USB 디버깅 허용/);
  s.setFile('mode.txt', '');
  assert.equal((await s.call('view_hierarchy')).isError, false);
});

test('scenario_finish: 저장한 YAML 전문을 응답에 다시 붙이지 않는다', async () => {
  s.setUi(ui({ cls: 'android.widget.Button', text: '다음', bounds: [0, 0, 100, 100], clickable: true }));
  const st = await s.call('scenario_start', { name: '시험 흐름', packageName: 'com.example.app' });
  assert.equal(st.isError, false, st.text);
  await s.call('tap', { text: '다음' });
  await s.call('wait_for', { text: '다음', timeoutMs: 1000 });
  const step = await s.call('scenario_step', { title: '다음 버튼이 보임', status: 'pass', screenshot: false });
  assert.equal(step.isError, false, step.text);
  const fin = await s.call('scenario_finish', { verdict: 'pass', summary: 'ok' });
  assert.equal(fin.isError, false, fin.text);
  assert.match(fin.text, /스크립트 저장: .*\(2단계\)/);
  assert.ok(!fin.text.includes('steps:'), fin.text);
  const read = await s.call('script_read', { script: '시험 흐름' });
  assert.match(read.text, /tap:\s*\n?\s*text: 다음/);
  assert.match(read.text, /wait:/);
});

test('clear_app_data: 기본은 실행, DROIDLENS_CONFIRM=1 이고 확인을 받을 수 없으면 실행하지 않는다', async () => {
  s.clearLog();
  assert.equal((await s.call('clear_app_data', { packageName: 'com.example.app' })).isError, false);
  assert.ok(s.log().includes('pm clear com.example.app'));
  const c = await start({ DROIDLENS_CONFIRM: '1', DROIDLENS_APP: 'com.example.app' });
  try {
    const r = await c.call('clear_app_data', { packageName: 'com.example.app' });
    assert.equal(r.isError, true);
    assert.match(r.text, /사용자 확인이 필요한 조작이라 실행하지 않았습니다/);
    const d = await c.call('open_deeplink', { uri: 'tel:01012345678' });
    assert.equal(d.isError, true);
    assert.deepEqual(c.log().filter((l) => l.startsWith('pm clear') || l.startsWith('am start')), []);
    // http(s) 링크와 앱을 지정한 딥링크는 그대로 열린다
    assert.equal((await c.call('open_deeplink', { uri: 'https://example.com/a' })).isError, false);
    assert.equal((await c.call('open_deeplink', { uri: 'myapp://item/1', packageName: 'com.example.app' })).isError, false);
    // packageName 을 주는 것만으로는 확인을 건너뛰지 못한다: 위험 스킴, 대상이 아닌 앱
    c.clearLog();
    for (const a of [
      { uri: 'tel:01012345678', packageName: 'com.example.app' },
      { uri: 'intent://x#Intent;component=a/.B;end', packageName: 'com.example.app' },
      { uri: 'otherapp://pay', packageName: 'com.other.app' },
      { uri: 'myapp://item/1' },
    ]) {
      const r = await c.call('open_deeplink', a);
      assert.equal(r.isError, true, JSON.stringify(a));
      assert.match(r.text, /사용자 확인이 필요한 조작/);
    }
    assert.deepEqual(c.log().filter((l) => l.startsWith('am start')), []);
  } finally {
    await c.close();
  }
});

test('install_apk: 프로젝트 폴더 안의 .apk 만 설치한다', async () => {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'droidlens-proj-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'droidlens-out-')));
  mkdirSync(join(proj, '.git'));
  mkdirSync(join(proj, 'build'));
  writeFileSync(join(proj, 'build', 'app-debug.apk'), 'x');
  writeFileSync(join(proj, 'notes.txt'), 'x');
  writeFileSync(join(outside, 'evil.apk'), 'x');
  const c = await start({}, { cwd: proj });
  try {
    const ok = await c.call('install_apk', { path: 'build/app-debug.apk', grantPermissions: true });
    assert.equal(ok.isError, false, ok.text);
    assert.deepEqual(c.log(), [`install -r -t -g ${join(proj, 'build', 'app-debug.apk')}`]);
    for (const p of [join(outside, 'evil.apk'), '../x.apk', 'notes.txt', 'build/none.apk']) {
      assert.equal((await c.call('install_apk', { path: p })).isError, true, p);
    }
    assert.equal(c.log().length, 1);
    c.setFile('install.txt', 'Performing Streamed Install\nadb: failed to install: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: x]\n');
    const bad = await c.call('install_apk', { path: 'build/app-debug.apk' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /서명이 달라 덮어쓸 수 없습니다/);
    assert.ok(!c.log().some((l) => l.includes('uninstall')));
  } finally {
    await c.close();
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------- 데스크톱 대화창의 승인·거부 버튼 (확인 소켓) ----------

async function withBroker(opts, fn) {
  const { ConfirmBroker } = await import('@droidlens/core');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dl-ask-')));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\dl-ask-${Date.now()}` : join(dir, 'c.sock');
  const asks = [];
  const closed = [];
  const broker = new ConfirmBroker({ token: 'tok-1', onRequest: (r) => asks.push(r), onClosed: (id, reason) => closed.push(reason), ...opts });
  await broker.listen(path);
  const c = await start({ DROIDLENS_CONFIRM: '1', DROIDLENS_CONFIRM_SOCKET: path, DROIDLENS_CONFIRM_TOKEN: opts.clientToken ?? 'tok-1', DROIDLENS_APP: 'com.example.app' });
  const waitAsk = async (n) => {
    for (let i = 0; i < 300 && asks.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(asks.length, n, '확인 요청이 오지 않았다');
    return asks[n - 1];
  };
  try {
    await fn({ c, broker, asks, closed, waitAsk });
  } finally {
    await c.close();
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const cleared = (c) => c.log().filter((l) => l.startsWith('pm clear'));

test('확인 버튼 승인: 무엇을 어느 기기·앱에 하는지 보여 주고, 승인하면 그 호출만 실행된다', async () => {
  await withBroker({}, async ({ c, broker, waitAsk }) => {
    const p = c.call('clear_app_data', { packageName: 'com.example.app' });
    const ask = await waitAsk(1);
    assert.match(ask.what, /com\.example\.app 의 앱 데이터 전체 삭제/);
    assert.equal(ask.serial, 'fake');
    assert.equal(ask.app, 'com.example.app');
    assert.equal(ask.tool, 'clear_app_data');
    assert.deepEqual(cleared(c), [], '답하기 전에는 실행하지 않는다');
    broker.answer(ask.id, true);
    assert.equal((await p).isError, false);
    assert.deepEqual(cleared(c), ['pm clear com.example.app']);
    // 승인은 한 번뿐: 같은 호출을 다시 하면 다시 묻고, 거부하면 실행되지 않는다
    const again = c.call('clear_app_data', { packageName: 'com.example.app' });
    const ask2 = await waitAsk(2);
    assert.notEqual(ask2.id, ask.id);
    assert.equal(broker.answer(ask.id, true), false, '앞 요청의 승인을 다시 쓸 수 없다');
    assert.deepEqual(cleared(c).length, 1);
    broker.answer(ask2.id, false);
    const r = await again;
    assert.equal(r.isError, true);
    assert.match(r.text, /사용자가 거부해 실행하지 않았습니다/);
    assert.deepEqual(cleared(c).length, 1);
  });
});

test('확인 버튼 거부 뒤 늦은 승인: 실행되지 않는다', async () => {
  await withBroker({}, async ({ c, broker, waitAsk }) => {
    const p = c.call('open_deeplink', { uri: 'tel:01012345678' });
    const ask = await waitAsk(1);
    assert.match(ask.what, /URI 열기 tel:/);
    assert.equal(broker.answer(ask.id, false), true);
    assert.equal(broker.answer(ask.id, true), false);
    assert.equal((await p).isError, true);
    assert.deepEqual(c.log().filter((l) => l.startsWith('am start')), []);
  });
});

test('확인 버튼 시간 초과: 누르지 않으면 거부로 끝난다', async () => {
  await withBroker({ timeoutMs: 150 }, async ({ c, closed }) => {
    const r = await c.call('clear_app_data', { packageName: 'com.example.app' });
    assert.equal(r.isError, true);
    assert.match(r.text, /시간 안에 확인하지 않아 실행하지 않았습니다/);
    assert.deepEqual(closed, ['timeout']);
    assert.deepEqual(cleared(c), []);
  });
});

test('확인 소켓의 토큰이 틀리면 묻지도 실행하지도 않는다', async () => {
  await withBroker({ clientToken: 'wrong' }, async ({ c, asks }) => {
    const r = await c.call('clear_app_data', { packageName: 'com.example.app' });
    assert.equal(r.isError, true);
    assert.equal(asks.length, 0);
    assert.deepEqual(cleared(c), []);
  });
});
