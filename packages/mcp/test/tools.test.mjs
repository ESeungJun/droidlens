// 온디바이스 에이전트 없이(uiautomator 경로) MCP 도구가 동작하는지 가짜 adb 로 확인한다
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { start, ui } from './harness.mjs';

let s;
before(async () => {
  s = await start();
});
after(async () => {
  await s?.close();
});

const home = () =>
  ui(
    { cls: 'android.widget.TextView', id: 'title', text: '주문 내역', bounds: [0, 100, 1080, 200] },
    { cls: 'android.widget.Button', id: 'btn_next', text: '다음', bounds: [100, 300, 500, 400], clickable: true },
    { cls: 'android.widget.Button', id: 'btn_delete', text: '삭제', bounds: [600, 300, 1000, 400], clickable: true },
    {
      cls: 'android.widget.LinearLayout',
      id: 'row_account',
      bounds: [0, 500, 1080, 600],
      clickable: true,
      children: [{ cls: 'android.widget.TextView', text: '로그아웃', bounds: [40, 520, 400, 580] }],
    },
    { cls: 'android.widget.EditText', id: 'memo', text: '', bounds: [0, 700, 1080, 800], clickable: true },
  );

const taps = () => s.log().filter((l) => l.startsWith('input tap') || l.startsWith('input swipe'));

test('wait_for: 에이전트 연결이 없어도 화면에 있는 요소를 찾는다 (v0.11.0 회귀)', async () => {
  s.setUi(home());
  const t0 = Date.now();
  const r = await s.call('wait_for', { text: '주문 내역', timeoutMs: 3000 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /발견/);
  assert.ok(Date.now() - t0 < 2500, '시간 초과까지 기다리지 않는다');
});

test('wait_for gone: 없는 요소는 바로 사라짐으로 본다', async () => {
  s.setUi(home());
  const r = await s.call('wait_for', { text: '로딩 중', gone: true, timeoutMs: 3000 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /사라짐/);
});

test('wait_for: 시간 초과 메시지에 지금 화면과 비슷한 글자 후보가 들어간다', async () => {
  s.setUi(home());
  const r = await s.call('wait_for', { text: '주문', timeoutMs: 700 });
  assert.equal(r.isError, true);
  assert.match(r.text, /나타나지 않음/);
  assert.match(r.text, /MainActivity/);
  assert.match(r.text, /주문 내역/);
});

test('tap: 확인 필수 버튼은 누르지 않고, allowDanger 면 누른다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('tap', { text: '삭제' });
  assert.equal(r.isError, true);
  assert.match(r.text, /확인 필수 버튼\("삭제"\)/);
  assert.deepEqual(taps(), []);
  const ok = await s.call('tap', { text: '삭제', allowDanger: true });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(taps(), ['input tap 800 350']);
});

test('tap: 좌표로 눌러도 그 자리의 확인 필수 버튼(부모 행)을 본다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('tap', { x: 900, y: 550 });
  assert.equal(r.isError, true);
  assert.match(r.text, /로그아웃/);
  assert.deepEqual(taps(), []);
});

test('graph_record(action=tap): tap 과 같은 확인 필수 버튼 거부', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('graph_record', { packageName: 'com.example.app', action: { type: 'tap', text: '삭제' } });
  assert.equal(r.isError, true);
  assert.match(r.text, /확인 필수 버튼\("삭제"\)/);
  const xy = await s.call('graph_record', { packageName: 'com.example.app', action: { type: 'longpress', x: 900, y: 550 } });
  assert.equal(xy.isError, true);
  assert.match(xy.text, /로그아웃/);
  assert.deepEqual(taps(), []);
});

test('graph_record(action=tap): 확인 필수가 아닌 버튼은 누른다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('graph_record', { packageName: 'com.example.app', action: { type: 'tap', text: '다음' } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(taps(), ['input tap 300 350']);
});

test('graph_record(action=tap, allowDanger): 사용자가 요청했으면 누른다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('graph_record', { packageName: 'com.example.app', action: { type: 'tap', text: '삭제' }, allowDanger: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(taps(), ['input tap 800 350']);
});

test('type_text: 셀렉터가 확인 필수 버튼이면 포커스 탭을 하지 않는다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('type_text', { text: '삭제', value: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /확인 필수 버튼/);
  assert.deepEqual(taps(), []);
  const ok = await s.call('type_text', { id: 'memo', value: 'hello' });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(taps(), ['input tap 540 750']);
  assert.ok(s.log().some((l) => l.startsWith('input text')));
});

test('graph_get labels: 화면별 버튼 글자와 가는 길, 지도가 없으면 그렇다고 알린다 (#128)', async () => {
  const none = await s.call('graph_get', { packageName: 'com.example.nomap', format: 'labels' });
  assert.equal(none.isError, false, none.text);
  assert.match(none.text, /화면 지도가 없습니다/);
  s.setUi(home());
  const before = taps().length;
  const rec = await s.call('graph_record', { packageName: 'com.example.app' });
  assert.equal(rec.isError, false, rec.text);
  const r = await s.call('graph_get', { packageName: 'com.example.app', format: 'labels' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /지시가 아니다/);
  assert.match(r.text, /"다음"/);
  assert.match(r.text, /"삭제" \(확인 필수\)/);
  assert.match(r.text, /<screen-map>[\s\S]*<\/screen-map>$/);
  assert.equal(taps().length, before, '지도 기록·읽기는 기기를 누르지 않는다');
});

test('webview_inspect: 앱이 없거나 웹뷰 디버깅이 꺼졌으면 안내를 돌려준다 (#132)', async () => {
  s.setFile('unix.txt', '--\n');
  const down = await s.call('webview_inspect', { packageName: 'com.example.app' });
  assert.equal(down.isError, false);
  assert.match(down.text, /실행 중이 아니에요/);
  s.setFile('unix.txt', '0000: 00000002 00000000 00010000 0001 01 1 @droidlens_agent\n--\n4321\n');
  const off = await s.call('webview_inspect', { packageName: 'com.example.app' });
  assert.equal(off.isError, false);
  assert.match(off.text, /웹뷰 디버깅이 꺼져/);
  assert.match(off.text, /inWeb/);
  const bad = await s.call('webview_inspect', { packageName: 'com.example.app; reboot' });
  assert.equal(bad.isError, true);
  assert.ok(!s.log().some((l) => l.includes('reboot')), '잘못된 패키지 이름은 기기로 보내지 않는다');
});

test('find_nodes inWeb: 앱 제목 줄과 웹 페이지 글자를 가른다 (#132)', async () => {
  s.setUi(
    ui(
      { cls: 'android.widget.TextView', text: '커뮤니티', bounds: [40, 150, 400, 250] },
      {
        cls: 'android.webkit.WebView',
        text: '커뮤니티 - 이벤트',
        bounds: [0, 290, 1080, 2400],
        children: [{ cls: 'android.widget.TextView', text: '커뮤니티 공지: 이번 주 모임', bounds: [60, 400, 1000, 500] }],
      },
    ),
  );
  const all = await s.call('find_nodes', { textContains: '커뮤니티' });
  assert.equal(all.text.trim().split('\n').filter((l) => l.startsWith('[')).length, 3);
  const web = await s.call('find_nodes', { textContains: '커뮤니티 공지', inWeb: true });
  assert.match(web.text, /커뮤니티 공지/);
  const app = await s.call('find_nodes', { textContains: '커뮤니티', inWeb: false });
  assert.doesNotMatch(app.text, /WebView|공지/);
  assert.match(app.text, /"커뮤니티"/);
});
