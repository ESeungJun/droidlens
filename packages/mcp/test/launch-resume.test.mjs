// launch_app(resume) (#159): 앞 TC 에 이어 갈 때 CLEAR_TASK 로 다시 띄우지 않고 시작 화면으로 돌아간다
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { start, ui } from './harness.mjs';

let s;
before(async () => {
  s = await start();
  s.setUi(ui({ id: 'home', text: '홈', clickable: true, bounds: [0, 100, 1080, 200] }));
  s.setFile('launcher.txt', 'priority=0\ncom.example.app/com.example.app.MainActivity\n');
});
after(() => s?.close());

const CLEAR_TASK = '0x10008000';
const starts = () => s.log().filter((c) => c.startsWith('am start'));

test('launch_app resume: 시작 화면을 모르면 예전처럼 첫 화면부터 띄운다', async () => {
  s.clearLog();
  const r = await s.call('launch_app', { packageName: 'com.example.app', resume: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /relaunched/);
  assert.ok(starts().some((c) => c.includes(CLEAR_TASK)));
});

test('launch_app resume: 앞서 띄운 시작 화면에 있으면 CLEAR_TASK·강제 종료 없이 앞으로 가져오기만 한다', async () => {
  await s.call('launch_app', { packageName: 'com.example.app', restart: true });
  s.setFile('pidof.txt', '4321\n');
  s.clearLog();
  const r = await s.call('launch_app', { packageName: 'com.example.app', resume: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /resumed com\.example\.app/);
  assert.equal(starts().filter((c) => c.includes(CLEAR_TASK)).length, 0, 'CLEAR_TASK 없음');
  assert.ok(starts().some((c) => c.includes('0x10200000')), '런처와 같은 인텐트로 앞으로 가져옴');
  assert.equal(s.log().filter((c) => c.startsWith('am force-stop')).length, 0);
});

test('launch_app resume: 프로세스가 없으면 첫 화면부터 띄운다', async () => {
  s.setFile('pidof.txt', '');
  s.clearLog();
  const r = await s.call('launch_app', { packageName: 'com.example.app', resume: true });
  assert.match(r.text, /relaunched/);
  assert.ok(starts().some((c) => c.includes(CLEAR_TASK)));
});
