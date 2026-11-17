// 스크린샷 직전 대기 waitScreenSettled (packages/core/src/script.ts): 에이전트가 없으면 기기에 아무것도 묻지 않고 0.7초 쉰다.
// script.ts 의 settle 과 몸통을 합치는 리팩토링 전 동작을 고정한다. 빌드 결과(dist)를 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DROIDLENS_AGENT = '0';
const { waitScreenSettled } = await import('../dist/script.js');
const { fakeDevice } = await import('./fake-device.mjs');

test('waitScreenSettled: 에이전트가 없으면 기기 명령 없이 700ms 쉰다', async () => {
  const f = fakeDevice({ pkg: 'com.ex.settle', launch: 'home', screens: { home: { activity: 'com.ex.settle.Home', buttons: [] } } });
  const t0 = Date.now();
  assert.equal(await waitScreenSettled(f.dev), undefined);
  const ms = Date.now() - t0;
  assert.ok(ms >= 690 && ms < 1200, `${ms}ms`);
  assert.deepEqual(f.log, []);
});
