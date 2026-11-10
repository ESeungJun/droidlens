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

test('tap: 위험 버튼은 누르지 않고, allowDanger 면 누른다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('tap', { text: '삭제' });
  assert.equal(r.isError, true);
  assert.match(r.text, /위험해 보이는 버튼\("삭제"\)/);
  assert.deepEqual(taps(), []);
  const ok = await s.call('tap', { text: '삭제', allowDanger: true });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(taps(), ['input tap 800 350']);
});

test('tap: 좌표로 눌러도 그 자리의 위험 버튼(부모 행)을 본다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('tap', { x: 900, y: 550 });
  assert.equal(r.isError, true);
  assert.match(r.text, /로그아웃/);
  assert.deepEqual(taps(), []);
});

test('graph_record(action=tap): tap 과 같은 위험 버튼 거부', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('graph_record', { packageName: 'com.example.app', action: { type: 'tap', text: '삭제' } });
  assert.equal(r.isError, true);
  assert.match(r.text, /위험해 보이는 버튼\("삭제"\)/);
  const xy = await s.call('graph_record', { packageName: 'com.example.app', action: { type: 'longpress', x: 900, y: 550 } });
  assert.equal(xy.isError, true);
  assert.match(xy.text, /로그아웃/);
  assert.deepEqual(taps(), []);
});

test('graph_record(action=tap): 위험하지 않은 버튼은 누른다', async () => {
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

test('type_text: 셀렉터가 위험 버튼이면 포커스 탭을 하지 않는다', async () => {
  s.setUi(home());
  s.clearLog();
  const r = await s.call('type_text', { text: '삭제', value: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /위험해 보이는 버튼/);
  assert.deepEqual(taps(), []);
  const ok = await s.call('type_text', { id: 'memo', value: 'hello' });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(taps(), ['input tap 540 750']);
  assert.ok(s.log().some((l) => l.startsWith('input text')));
});
