// QA 회차 속도 (#130): 앞 TC 에 이어 갈지(재시작 판단), 앱 버전 사전 조건 미리 검사, 스크립트 TC 의 재시작 줄이기
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
process.env.DROIDLENS_AGENT = '0';
after(() => rmSync(home, { recursive: true, force: true }));

const qa = await import('../dist/qa/index.js');
const note = await import('../dist/qa-note.js');
const { runScript, parseScript } = await import('../dist/script.js');
const { fakeDevice } = await import('./fake-device.mjs');

test('앱 버전 사전 조건을 읽는다: 미만·이상·이하·초과, 영어 꼴', () => {
  const p = qa.parseVersionCondition;
  assert.deepEqual(p('앱 버전 13.9.0 미만'), { op: 'lt', version: '13.9.0', text: '앱 버전 13.9.0 미만' });
  assert.equal(p('앱 13.10.0 이상').op, 'gte');
  assert.equal(p('앱 13.10.0 이상').version, '13.10.0');
  assert.equal(p('앱 버전 2.1 이하').op, 'lte', '"버전" 이 있으면 두 자리 버전도 받는다');
  assert.equal(p('v3.0.0 초과').op, 'gt');
  assert.equal(p('app version >= 1.2.3').op, 'gte');
  assert.equal(p('App version 1.2.3 or later').op, 'gte');
  assert.equal(p('app version below 2.0.0').op, 'lt');
  assert.equal(p('버전 1.4.0 이상에서 로그인된 상태').op, 'gte', '조사가 붙어도 읽는다');
  assert.equal(p('안드로이드 앱 13.9.0 이상').op, 'gte', '안드로이드 "앱" 은 앱 버전');
  assert.equal(p('Android 앱 버전 13.9.0 이상').op, 'gte');
  assert.equal(p('13.9.0 버전 이상').op, 'gte');
  assert.equal(p('앱 13.9.0 버전 미만').op, 'lt');
  assert.equal(p('앱 버전 13.9.0부터').op, 'gte');
  assert.equal(p('v13.9.0 이후').op, 'gte');
});

test('애매하거나 앱 버전이 아닌 조건은 읽지 않는다 (검사를 건너뛴다)', () => {
  const p = qa.parseVersionCondition;
  assert.equal(p('Android 13 이상'), null, 'OS 버전');
  assert.equal(p('Android 12.1 이상 기기'), null, 'OS 버전 (점 하나)');
  assert.equal(p('API 33 이상'), null);
  assert.equal(p('13.9.0 이상 14.0.0 미만'), null, '버전이 둘');
  assert.equal(p('로그인되어 있음'), null);
  assert.equal(p('앱 버전 13.9.0'), null, '비교 말이 없음');
  assert.equal(p('2.1 이상'), null, '"버전" 없이 두 자리는 앱 버전인지 모름');
  assert.equal(p(''), null);
  // 리뷰에서 찾은 오탐: 다른 앱·서비스 버전, 버전이 아닌 숫자, 부정문 (#130)
  assert.equal(p('Chrome 120.0.6099 이상 설치'), null, '다른 앱 버전');
  assert.equal(p('Google Play 서비스 23.1.0 이상'), null);
  assert.equal(p('카카오톡 10.2.0 이상 설치'), null);
  assert.equal(p('잔액 1.000.000 이상'), null);
  assert.equal(p('13.9.0 이상'), null, '"버전"·"앱" 이 없으면 무엇의 버전인지 모름');
  assert.equal(p('앱 버전 13.9.0 이하가 아닌 기기'), null, '부정문');
  assert.equal(p('앱 버전 13.9.0 미만이 아님'), null);
  assert.equal(p('app version not below 2.0.0'), null);
});

test('버전 비교는 자리마다 숫자로, 뒤 꼬리(-debug)는 뺀다', () => {
  const c = qa.compareVersions;
  assert.ok(c('13.10.0', '13.9.0') > 0);
  assert.ok(c('13.9.0', '13.10.0') < 0);
  assert.equal(c('1.2', '1.2.0'), 0);
  assert.equal(c('1.2.3-debug', '1.2.3'), 0);
  assert.equal(c('v1.2.3', '1.2.3'), 0);
});

test('설치된 버전과 맞지 않는 조건을 찾는다. 설치 버전을 모르면 건너뛴다', () => {
  const k = qa.unmetVersionCondition;
  assert.deepEqual(k(['로그인된 상태', '앱 버전 13.9.0 미만'], '13.10.0'), { op: 'lt', version: '13.9.0', text: '앱 버전 13.9.0 미만' });
  assert.equal(k(['앱 버전 13.9.0 미만'], '13.8.5'), null);
  assert.equal(k(['앱 버전 13.10.0 이상'], '13.10.0'), null, '같으면 이상 충족');
  assert.equal(k(['앱 버전 13.10.0 이상'], '13.9.9').op, 'gte');
  assert.equal(k(['앱 버전 13.9.0 미만'], undefined), null);
  assert.equal(k(['앱 버전 13.9.0 미만'], 'abc'), null, '숫자 아닌 설치 버전');
  assert.equal(k([], '1.0.0'), null);
});

test('버전 조건이 안 맞는 TC 의 메모는 코드 값, 한국어·영어 글', () => {
  const n = { code: 'versionUnmet', args: { cond: '앱 버전 13.9.0 미만', installed: '13.10.0' } };
  assert.ok(note.QA_NOTE_CODES.includes('versionUnmet'));
  assert.equal(note.qaNoteText(n, 'ko'), '설치된 앱 버전(13.10.0)이 사전 조건(앱 버전 13.9.0 미만)과 맞지 않아 실행하지 않았습니다');
  assert.equal(note.qaNoteText(n, 'en'), 'Not run: the installed app version (13.10.0) does not meet the precondition (앱 버전 13.9.0 미만)');
});

test('데이터를 바꾸는 도구 호출을 가린다', () => {
  const d = qa.changesAppData;
  assert.equal(d('mcp__droidlens__clear_app_data', {}), true);
  assert.equal(d('mcp__droidlens__prefs_set', { key: 'a' }), true);
  assert.equal(d('prefs_remove', {}), true, 'mcp 접두어 없어도');
  assert.equal(d('mcp__droidlens__network_mock_set', {}), true);
  assert.equal(d('mcp__droidlens__db_query', { sql: 'select 1' }), false);
  assert.equal(d('mcp__droidlens__db_query', { sql: 'delete from t', write: true }), true);
  assert.equal(d('mcp__droidlens__tap', { text: '저장' }), false);
  assert.equal(d('mcp__droidlens__tap', { text: '삭제', allowDanger: true }), true, '확인 필수 동작을 실제로 누름');
  assert.equal(d('mcp__droidlens__launch_app', { restart: true }), false);
  assert.equal(d('mcp__droidlens__screenshot', undefined), false);
  assert.equal(d('mcp__other__prefs_set', {}), false, '다른 서버 도구');
  for (const t of ['install_apk', 'script_run', 'suite_run', 'explore']) assert.equal(d(`mcp__droidlens__${t}`, {}), true, `${t}: 앱·데이터를 바꿀 수 있음`);
});

test('재시작 판단: 앞 TC 가 통과했고 조건이 같고 데이터를 안 바꿨을 때만 이어 간다', () => {
  const r = qa.needsRestart;
  const pass = { status: 'pass', preconditions: ['로그인된 상태'], changedData: false };
  const cur = { preconditions: ['로그인된 상태'], changesData: false };
  assert.equal(r(undefined, cur), true, '첫 TC');
  assert.equal(r(pass, cur), false);
  assert.equal(r(pass, { ...cur, preconditions: [' 로그인된 상태 '] }), false, '앞뒤 공백은 같은 조건');
  assert.equal(r({ ...pass, status: 'fail' }, cur), true, '앞 TC 실패');
  assert.equal(r({ ...pass, status: 'blocked' }, cur), true, '앞 TC 막힘');
  assert.equal(r({ ...pass, changedData: true }, cur), true, '앞 TC 가 데이터를 바꿈');
  assert.equal(r(pass, { ...cur, preconditions: ['로그아웃 상태'] }), true, '사전 조건이 다름');
  assert.equal(r(pass, { ...cur, changesData: true }), true, '이 TC 준비가 데이터를 바꿈');
});

test('스크립트 준비가 데이터를 바꾸는지', () => {
  const s = (setup) => parseScript(`name: x\napp: com.example.app\n${setup}\nsteps:\n  - back\n`);
  assert.equal(qa.scriptSetupChangesData(s('').setup), false);
  assert.equal(qa.scriptSetupChangesData(s('setup:\n  restart: true').setup), false);
  assert.equal(qa.scriptSetupChangesData(s('setup:\n  clearData: true').setup), true);
  assert.equal(
    qa.scriptSetupChangesData(s('setup:\n  prefs:\n    - { file: a, key: b, type: string, value: c }').setup),
    true,
  );
});

// ── 가짜 기기로: 스크립트 TC 의 재시작 횟수 ──
const PKG = 'com.example.cont';
const appDef = {
  pkg: PKG,
  launch: 'home',
  screens: {
    home: { activity: `${PKG}.HomeActivity`, buttons: [{ id: 'detail', text: 'Detail', bounds: [0, 100, 1080, 190], go: 'detail' }] },
    detail: { activity: `${PKG}.DetailActivity`, buttons: [{ id: 'price', text: '12,000원', bounds: [0, 100, 1080, 190] }] },
  },
};
const forceStops = (f) => f.commands().filter((c) => c.startsWith(`am force-stop ${PKG}`)).length;

test('runScript keepProcess: 강제 종료 없이 첫 화면부터 (준비가 데이터를 바꾸면 그래도 재시작)', async () => {
  const f = fakeDevice(appDef, 'cont-1');
  f.open('home', 'detail');
  const script = parseScript(`name: 이어 가기\napp: ${PKG}\nsteps:\n  - wait: { id: detail }\n`);
  const r = await runScript(f.dev, script, { keepProcess: true });
  assert.equal(r.verdict, 'pass', '첫 화면부터 시작 (detail 에서 시작하지 않음)');
  assert.equal(forceStops(f), 0);
  const r2 = await runScript(f.dev, script);
  assert.equal(r2.verdict, 'pass');
  assert.equal(forceStops(f), 1, '기본은 재시작');
});

async function scriptedPlan(name, cases) {
  const plan = await qa.createQaPlan({ name, app: PKG });
  mkdirSync(join(home, 'scripts'), { recursive: true });
  for (const c of cases) {
    writeFileSync(
      join(home, 'scripts', `${plan.id}-${c.id}.yaml`),
      `name: ${c.id}\napp: ${PKG}\ntimeout: 300\ntc: { plan: ${plan.id}, case: ${c.id} }\nsteps:\n  - ${c.ok === false ? 'wait: { text: 없는 글자 }' : 'wait: { id: detail }'}\n`,
    );
  }
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '홈' }],
    cases: cases.map((c) => ({
      id: c.id,
      title: c.id,
      requirements: ['R-01'],
      priority: 'P1',
      kind: 'normal',
      steps: ['a'],
      expected: ['b'],
      selected: true,
      preconditions: c.pre ?? [],
      script: `${plan.id}-${c.id}`,
    })),
  });
  return plan;
}

test('runQaScripts: 통과 뒤에는 재시작하지 않고, 실패·조건 변경 뒤에는 재시작한다', async () => {
  const plan = await scriptedPlan('이어 가기', [
    { id: 'TC-001' },
    { id: 'TC-002', ok: false },
    { id: 'TC-003' },
    { id: 'TC-004' },
    { id: 'TC-005', pre: ['로그아웃 상태'] },
  ]);
  const f = fakeDevice(appDef, 'cont-2');
  const out = await qa.runQaScripts(f.dev, plan.id);
  assert.deepEqual(
    out.ran.map((x) => [x.case, x.status]),
    [['TC-001', 'pass'], ['TC-002', 'fail'], ['TC-003', 'pass'], ['TC-004', 'pass'], ['TC-005', 'pass']],
  );
  // TC-001 처음 · TC-002 이어 가서 실패해 새로 띄워 한 번 더 확인(#159) · TC-003 실패 뒤 · TC-005 조건 바뀜 = 4번. (예전에는 TC 마다 5번)
  assert.equal(forceStops(f), 4);
  assert.equal(out.restarts, 4);
});

test('runQaScripts: 설치 버전이 사전 조건과 안 맞는 TC 는 돌리지 않고 막힘(코드 값)', async () => {
  const plan = await scriptedPlan('버전 조건', [{ id: 'TC-001', pre: ['앱 버전 13.9.0 미만'] }, { id: 'TC-002' }]);
  const f = fakeDevice(appDef, 'cont-3');
  const shell = f.dev.shell;
  f.dev.shell = async (cmd, o) => (cmd.startsWith(`dumpsys package ${PKG}`) ? '    versionCode=1 minSdk=24\n    versionName=13.10.0\n' : shell(cmd, o));
  const out = await qa.runQaScripts(f.dev, plan.id);
  const r1 = out.ran.find((x) => x.case === 'TC-001');
  assert.equal(r1.status, 'blocked');
  assert.deepEqual(r1.note, { code: 'versionUnmet', args: { cond: '앱 버전 13.9.0 미만', installed: '13.10.0' } });
  assert.equal(out.ran.find((x) => x.case === 'TC-002').status, 'pass');
  assert.equal(forceStops(f), 1, '막힌 TC 는 앱을 띄우지 않음, 그 뒤 TC 는 처음처럼 재시작');
});
