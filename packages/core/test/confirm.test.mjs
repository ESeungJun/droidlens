// 되돌릴 수 없는 조작의 사용자 확인 통로 (데스크톱 대화창 ↔ MCP 서버)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ConfirmBroker, requestConfirm } from '../dist/confirm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dl-confirm-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\dl-confirm-test-${randomBytes(6).toString('hex')}` : join(dir, 'c.sock');
  const requests = [];
  const closed = [];
  const broker = new ConfirmBroker({ token: 'secret-token', onRequest: (r) => requests.push(r), onClosed: (id, reason) => closed.push([id, reason]), ...opts });
  await broker.listen(path);
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await sleep(10);
    assert.ok(fn(), '기다린 조건이 되지 않았다');
  };
  return { path, broker, requests, closed, until, done: () => { broker.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const REQ = { what: 'com.example.app 의 앱 데이터 전체 삭제', serial: 'R5X', app: 'com.example.app', tool: 'clear_app_data' };

test('승인: 요청 내용이 그대로 전달되고 approved', async () => {
  const s = await setup();
  try {
    const p = requestConfirm(s.path, 'secret-token', REQ);
    await s.until(() => s.requests.length === 1);
    const { id, ...rest } = s.requests[0];
    assert.deepEqual(rest, REQ);
    assert.equal(s.broker.answer(id, true), true);
    assert.equal(await p, 'approved');
    assert.deepEqual(s.closed, []);
  } finally {
    s.done();
  }
});

test('거부: denied', async () => {
  const s = await setup();
  try {
    const p = requestConfirm(s.path, 'secret-token', REQ);
    await s.until(() => s.requests.length === 1);
    s.broker.answer(s.requests[0].id, false);
    assert.equal(await p, 'denied');
  } finally {
    s.done();
  }
});

test('시간 초과: 답이 없으면 거부하고 확인창을 닫으라고 알린다', async () => {
  const s = await setup({ timeoutMs: 80 });
  try {
    assert.equal(await requestConfirm(s.path, 'secret-token', REQ), 'timeout');
    assert.deepEqual(s.closed.map((c) => c[1]), ['timeout']);
    // 시간이 지난 뒤 누른 승인은 통하지 않는다
    assert.equal(s.broker.answer(s.requests[0].id, true), false);
  } finally {
    s.done();
  }
});

test('중복 응답: 첫 답만 쓰고 뒤의 답은 버린다 (거부 뒤 승인이 통하지 않는다)', async () => {
  const s = await setup();
  try {
    const p = requestConfirm(s.path, 'secret-token', REQ);
    await s.until(() => s.requests.length === 1);
    const { id } = s.requests[0];
    assert.equal(s.broker.answer(id, false), true);
    assert.equal(s.broker.answer(id, true), false);
    assert.equal(await p, 'denied');
  } finally {
    s.done();
  }
});

test('승인은 그 호출 한 번에만: 다음 요청은 다시 묻고 번호가 다르다', async () => {
  const s = await setup();
  try {
    const a = requestConfirm(s.path, 'secret-token', REQ);
    await s.until(() => s.requests.length === 1);
    s.broker.answer(s.requests[0].id, true);
    assert.equal(await a, 'approved');
    const b = requestConfirm(s.path, 'secret-token', REQ);
    await s.until(() => s.requests.length === 2);
    assert.notEqual(s.requests[1].id, s.requests[0].id);
    // 앞 요청의 번호로는 답할 수 없다
    assert.equal(s.broker.answer(s.requests[0].id, true), false);
    s.broker.answer(s.requests[1].id, false);
    assert.equal(await b, 'denied');
  } finally {
    s.done();
  }
});

test('true 가 아닌 값은 승인이 아니다', async () => {
  const s = await setup();
  try {
    const p = requestConfirm(s.path, 'secret-token', REQ);
    await s.until(() => s.requests.length === 1);
    s.broker.answer(s.requests[0].id, 'yes');
    assert.equal(await p, 'denied');
  } finally {
    s.done();
  }
});

test('토큰이 틀리거나 내용이 없으면 요청으로 받지 않는다', async () => {
  const s = await setup();
  try {
    assert.equal(await requestConfirm(s.path, 'wrong', REQ), 'denied');
    assert.equal(await requestConfirm(s.path, 'secret-token', { what: '' }), 'denied');
    assert.equal(s.requests.length, 0);
  } finally {
    s.done();
  }
});

test('브로커가 없으면 unavailable, 요청한 쪽이 끊기면 확인창을 닫는다', async () => {
  const s = await setup();
  try {
    assert.equal(await requestConfirm(s.path + '.none', 'secret-token', REQ), 'unavailable');
    const sock = connect(s.path);
    await new Promise((r) => sock.on('connect', r));
    sock.write(JSON.stringify({ token: 'secret-token', what: 'x' }) + '\n');
    await s.until(() => s.requests.length === 1);
    sock.destroy();
    await s.until(() => s.closed.length === 1);
    assert.deepEqual(s.closed[0], [s.requests[0].id, 'cancelled']);
    assert.equal(s.broker.answer(s.requests[0].id, true), false);
  } finally {
    s.done();
  }
});

test('close: 남은 요청은 거부된다', async () => {
  const s = await setup();
  const p = requestConfirm(s.path, 'secret-token', REQ);
  await s.until(() => s.requests.length === 1);
  s.done();
  assert.equal(await p, 'denied');
});
