// 스크린샷 직전 대기 waitScreenSettled (packages/core/src/script.ts): 에이전트가 없으면 기기에 아무것도 묻지 않고 0.7초 쉰다.
// script.ts 의 settle 과 몸통을 합치는 리팩토링 전 동작을 고정한다. 빌드 결과(dist)를 시험한다.
// 에이전트를 켠 경우도 본다: 스크린샷 직전 대기는 에이전트를 새로 설치·실행하지 않는다 (settle 의 install:false 갈래).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

process.env.DROIDLENS_AGENT = '0';
// 에이전트 APK 를 찾는 곳(DROIDLENS_HOME/agent)을 저장소 안 빈 폴더로 둔다: 실제 ~/.droidlens 의 APK 를 쓰지 않게
const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
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

test('waitScreenSettled: 에이전트를 켜 둬도 새로 설치·실행하지 않는다 (떠 있는 에이전트만 쓴다)', async () => {
  // 에이전트를 켠 상태. 설치 경로(ensureAgent)로 가면 forward 를 열고 설치 버전을 묻는 shell 명령을 보낸다
  const saved = { agent: process.env.DROIDLENS_AGENT, apk: process.env.DROIDLENS_AGENT_APK };
  delete process.env.DROIDLENS_AGENT;
  process.env.DROIDLENS_AGENT_APK = join(import.meta.dirname, '없는-에이전트.apk');
  try {
    const f = fakeDevice({ pkg: 'com.ex.settle2', launch: 'home', screens: { home: { activity: 'com.ex.settle2.Home', buttons: [] } } }, 'fake-settle-agent');
    let forwards = 0;
    f.dev.forward = async () => (forwards++, 0);
    const t0 = Date.now();
    assert.equal(await waitScreenSettled(f.dev), undefined);
    assert.ok(Date.now() - t0 >= 690);
    assert.equal(forwards, 0, '에이전트 연결(forward)을 열지 않는다');
    assert.deepEqual(f.log, [], '설치 확인·실행 shell 명령을 보내지 않는다');
  } finally {
    if (saved.agent === undefined) delete process.env.DROIDLENS_AGENT;
    else process.env.DROIDLENS_AGENT = saved.agent;
    if (saved.apk === undefined) delete process.env.DROIDLENS_AGENT_APK;
    else process.env.DROIDLENS_AGENT_APK = saved.apk;
  }
});
