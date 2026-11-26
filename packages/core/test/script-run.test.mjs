// 시나리오 스크립트 실행(runScript · runStep · evaluateAssertion · runSuite)을 가짜 기기로 시험한다.
// script.ts 를 단계 실행기 표·assert 모듈로 나누기 전 동작을 고정하는 특성 테스트다 (#69).
// 결과(판정·통과 수·리포트 단계)와 기기에 보낸 명령·SDK 요청 순서를 fixtures/script-run.golden.json 과 비교한다.
// 동작을 일부러 바꿨으면 UPDATE_GOLDEN=1 로 돌려 기준을 다시 만들고 바뀐 내용을 리뷰한다.
// 에이전트 없는 경로만 다룬다 (흐름 수집 FlowCollector · replaceText · 한글 입력은 에이전트가 있어야 한다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
process.env.DROIDLENS_AGENT = '0';
after(() => rmSync(home, { recursive: true, force: true }));

const { runScript, runSuite, evaluateAssertion, parseScript } = await import('../dist/script.js');
const { fakeDevice } = await import('./fake-device.mjs');

const GOLDEN = join(import.meta.dirname, 'fixtures', 'script-run.golden.json');
const update = process.env.UPDATE_GOLDEN === '1';
const golden = !update && existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
const produced = {};
after(() => {
  if (update) writeFileSync(GOLDEN, JSON.stringify(produced, null, 2) + '\n');
});
function matchGolden(key, raw) {
  // 테스트 홈 폴더 이름은 실행마다 달라 <HOME> 으로 바꿔 비교한다
  const value = JSON.parse(JSON.stringify(raw).replaceAll(home, '<HOME>'));
  produced[key] = value;
  if (update) return;
  assert.ok(golden[key], `기준 없음: ${key} (UPDATE_GOLDEN=1 로 만든다)`);
  assert.deepEqual(value, golden[key]);
}

/** 기기 시계 (date +%s). SDK 네트워크·이벤트 시각은 이 값 기준으로 둔다 */
const DEVICE_SEC = 1_700_000_000;
const NOW = DEVICE_SEC * 1000;

const b = (i) => [0, 100 + i * 100, 1080, 190 + i * 100];
const appDef = (pkg) => ({
  pkg,
  launch: 'home',
  screens: {
    home: {
      activity: `${pkg}.HomeActivity`,
      swipe: { up: 'list' },
      buttons: [
        { id: 'detail', text: 'Detail', bounds: b(0), go: 'detail' },
        { id: 'menu', text: 'Menu', bounds: b(1), long: 'menu' },
        { id: 'title_input', text: '', cls: 'android.widget.EditText', bounds: b(2) },
        { id: 'delete', text: '삭제', bounds: b(3), go: 'detail' },
        { id: 'spinner', text: 'Loading', bounds: b(4) },
      ],
    },
    detail: { activity: `${pkg}.DetailActivity`, buttons: [{ id: 'price', text: '12,000원', bounds: b(0) }] },
    menu: { activity: `${pkg}.MenuActivity`, buttons: [{ id: 'close', text: 'Close', bounds: b(0), go: '@back' }] },
    list: { activity: `${pkg}.ListActivity`, swipe: { up: 'list2' }, buttons: [{ id: 'row1', text: 'Row 1', bounds: b(0) }] },
    list2: { activity: `${pkg}.ListActivity`, root: 'list', buttons: [{ id: 'row9', text: 'Row 9', bounds: b(0) }] },
  },
});

/** 화면 이름마다 색이 다른 PNG (스크린샷 비교용). 위쪽 상태 표시줄 영역은 비교에서 빠지므로 세로로 길게 만든다 */
function pngFor(name) {
  const p = new PNG({ width: 20, height: 200 });
  const h = [...name].reduce((s, c) => (s * 31 + c.charCodeAt(0)) & 0xffffff, 7);
  for (let i = 0; i < 20 * 200; i++) {
    p.data[i * 4] = h & 0xff;
    p.data[i * 4 + 1] = (h >> 8) & 0xff;
    p.data[i * 4 + 2] = (h >> 16) & 0xff;
    p.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(p);
}

/** 반복 대기 루프(시간 한도까지 덤프를 되풀이)는 횟수가 기계마다 다르다. 바로 이어 되풀이되는 묶음(1~4개)을 하나로 줄인다 */
function collapse(list) {
  const out = [...list];
  for (let changed = true; changed; ) {
    changed = false;
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i + 2 * n <= out.length; i++) {
        const a = out.slice(i, i + n).join('\u0000');
        if (a === out.slice(i + n, i + 2 * n).join('\u0000')) {
          out.splice(i + n, n);
          changed = true;
          i--;
        }
      }
    }
  }
  return out;
}

/**
 * 가짜 기기 + (선택) 가짜 SDK 서버.
 * sdk: { network, details, prefs, db, events } 를 주면 그 응답을 내는 HTTP 서버를 띄우고 forward 를 그 포트로 돌린다
 */
async function rig(serial, pkg, opts = {}) {
  const f = fakeDevice(appDef(pkg), serial);
  const sdkLog = [];
  let server;
  if (opts.sdk) {
    const s = opts.sdk;
    let mockSeq = 0;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const q = Object.fromEntries(u.searchParams);
        if (u.pathname !== '/info') sdkLog.push(`${req.method} ${u.pathname}${u.searchParams.size ? '?' + u.searchParams : ''}${body ? ' ' + body : ''}`);
        const send = (v, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        };
        switch (u.pathname) {
          case '/info':
            return send({ package: pkg, pid: 4321 });
          case '/network':
            return send({ entries: (s.network ?? []).filter((e) => !q.filter || e.url.includes(q.filter)) });
          case '/network/detail':
            return send({ ...(s.network ?? []).find((e) => String(e.id) === q.id), responseBody: s.details?.[q.id] ?? '' });
          case '/prefs':
            return send({ files: s.prefs ?? [] });
          case '/prefs/set':
            return send({});
          case '/db/query':
            return send(s.db?.[body] ?? { rows: [] });
          case '/events':
            return send({ events: s.events ?? [] });
          case '/mocks/set':
            return send({ ...JSON.parse(body), id: `m${++mockSeq}` });
          case '/mocks/remove':
            if (s.removeFails) return send({ error: '못 지움' }, 500);
            return send({ removed: true });
          default:
            return send({ error: 'unknown' }, 404);
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    f.dev.forward = async () => server.address().port;
  }
  // 여기서 가로채 답한 명령도 가짜 기기처럼 명령·시각을 남긴다
  const note = (c) => (f.log.push(c), f.stamps.push([c, Date.now()]));
  const baseShell = f.dev.shell;
  f.dev.shell = async (cmd, o) => {
    if (cmd === 'date +%s') return note(cmd), `${DEVICE_SEC}\n`;
    if (cmd.startsWith('cat /proc/net/unix')) return note('cat /proc/net/unix'), opts.sdk ? `0: 00000002 0 1 @droidlens_sdk_${pkg}\n` : '';
    if (cmd.startsWith('stat -c %u /proc/')) return note('stat (sdk 확인)'), `10123\n--\npackage:${pkg} uid:10123\n`;
    if (cmd.startsWith('pm clear')) return note(cmd), 'Success';
    if (cmd.startsWith('pidof ')) return note(cmd), '4321';
    if (cmd.startsWith('am start -W -f')) {
      note('am start -W (시작 시간)');
      await baseShell('am start -n x');
      return `Status: ok\nLaunchState: COLD\nActivity: ${pkg}/.HomeActivity\nTotalTime: ${opts.startupMs ?? 800}\nWaitTime: 820\n`;
    }
    if (cmd.startsWith('set -- ')) {
      note('perfSample');
      if (opts.notRunning) return '';
      return [
        'pids 4321',
        '4321 (app) S 1 2 3 4 5 6 7 8 9 10 100 50',
        '__DROIDLENS_PERF__',
        'cpu  1000 0 1000 8000',
        '__DROIDLENS_PERF__',
        '  TOTAL PSS:   204800   TOTAL RSS: 300000',
        '__DROIDLENS_PERF__',
        '** Graphics info for pid 4321 [app] **',
        'Total frames rendered: 200',
        'Janky frames: 30 (15.00%)',
        '__DROIDLENS_PERF__',
      ].join('\n');
    }
    return baseShell(cmd, o);
  };
  const baseText = f.dev.text;
  f.dev.text = async (args, o) => {
    if (args[0] === 'logcat') {
      note('logcat -b crash');
      return opts.crash ? `${DEVICE_SEC + 5}.123  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main\n${DEVICE_SEC + 5}.124  4321  4321 E AndroidRuntime: Process: ${pkg}, PID: 4321\njava.lang.IllegalStateException: 터짐\n\tat ${pkg}.Home.onClick(Home.kt:10)\n` : '';
    }
    return baseText(args, o);
  };
  const baseExec = f.dev.execOut;
  f.dev.execOut = async (cmd, o) => {
    if (cmd.startsWith('screencap')) {
      note(cmd);
      return pngFor(opts.sameShots ? 'same' : f.screen);
    }
    return baseExec(cmd, o);
  };
  return { f, sdkLog, close: () => server && new Promise((r) => server.close(r)) };
}

/** 리포트 단계에서 시각·파일 경로를 빼고 비교할 모양으로 */
function shape(result, f, sdkLog, events) {
  const sc = result.scenario;
  return {
    verdict: result.verdict,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    summary: sc.summary?.replace(/\(\d+\.\d초\)/, '(N초)'),
    steps: sc.steps.map((s) => ({
      index: s.index,
      title: s.title,
      status: s.status,
      detail: s.detail,
      screen: s.screen,
      foreign: s.foreign,
      shot: !!s.screenshot,
      check: s.check,
      actions: s.actions?.map((a) => a.text),
      baseline: s.baseline && { app: s.baseline.app, name: s.baseline.name },
    })),
    commands: collapse(f.commands()),
    sdk: collapse(sdkLog),
    events,
  };
}

async function run(key, yaml, opts = {}) {
  const pkg = `com.ex.s${key.replace(/\W/g, '').toLowerCase()}`;
  const r = await rig(`fake-${key}`, pkg, opts);
  try {
    const script = parseScript(yaml.replaceAll('$PKG', pkg));
    const events = [];
    const ac = new AbortController();
    const result = await runScript(r.f.dev, script, {
      ...opts.run,
      signal: ac.signal,
      onStep: (e) => {
        events.push(`${e.index}/${e.total} ${e.status} ${e.title}${e.detail ? ` — ${e.detail.split('\n')[0]}` : ''}`);
        if (opts.abortAfter !== undefined && e.index === opts.abortAfter && e.status !== 'running') ac.abort();
      },
    });
    const value = shape(result, r.f, r.sdkLog, events);
    matchGolden(key, value);
    return { result, value, r };
  } finally {
    await r.close();
  }
}

test('runScript: 조작 단계 전부 통과 (tap·longPress·tapAt·type·swipe·key·sleep·launch·deeplink·screenshot·startup)', async () => {
  const { result } = await run(
    'actions',
    `name: 조작 전부
app: $PKG
description: 모든 조작 단계
steps:
  - wait: { id: detail }
  - tap: { text: Detail }
  - back
  - longPress: { id: menu }
  - tap: { id: close }
  - tapAt: { x: 10, y: 120 }
  - back
  - type: { text: "hello world", into: { id: title_input } }
  - swipe: up
  - swipe: { direction: up, until: { text: Row 9 }, max: 3 }
  - key: home
  - sleep: 5
  - launch
  - restart
  - deeplink: "myapp://item/1?token=secret"
  - screenshot: 홈
  - screenshot
  - startup: { runs: 1, maxMs: 1000 }
  - assert: { visible: { id: detail }, text: { of: { id: detail }, equals: Detail }, activity: HomeActivity, package: $PKG, notVisible: { text: 없는 글자 }, timeout: 300 }
  - assert: { noCrash: true }
`,
  );
  assert.equal(result.verdict, 'pass');
});

test('runScript: 첫 실패에서 멈추고 남은 단계는 건너뜀으로 센다', async () => {
  const { result } = await run(
    'stop',
    `name: 첫 실패 중단
app: $PKG
timeout: 300
steps:
  - tap: { text: Detail }
  - tap: { text: 없는 버튼 }
  - back
  - assert: { visible: { id: detail } }
`,
  );
  assert.equal(result.verdict, 'fail');
  assert.equal(result.skipped, 2);
});

test('runScript: continueOnFail 로 실패·건너뜀 갈래를 모두 지난다', async () => {
  const { result } = await run(
    'branches',
    `name: 실패 갈래
app: $PKG
continueOnFail: true
screenshots: all
timeout: 300
setup: { restart: false }
steps:
  - tap: { text: 없는 버튼, optional: true }
  - longPress: { text: 없는 버튼, timeout: 200 }
  - wait: { text: 없음, optional: true }
  - wait: { text: 없음 }
  - wait: { text: 없음, gone: true }
  - wait: { id: spinner, gone: true, timeout: 300 }
  - type: { text: abc, into: { id: 없는입력 } }
  - type: { text: "한글" }
  - swipe: { direction: up, until: { text: 끝 }, max: 2 }
  - back
  - assert: { visible: { text: 없음 }, timeout: 300 }
  - assert: { notVisible: { id: detail }, timeout: 300 }
  - assert: { text: { of: { id: detail }, equals: 다름 }, timeout: 300 }
  - assert: { text: { of: { id: detail }, contains: Det }, timeout: 300 }
  - assert: { text: { of: { id: 없음 }, contains: x }, timeout: 300 }
  - assert: { activity: OtherActivity, timeout: 300 }
  - assert: { package: com.other, timeout: 300 }
  - startup: { runs: 1, maxMs: 500 }
  - startup: { cold: false, runs: 1 }
  - assert: { perf: { maxMemoryMb: 100 } }
  - assert: { perf: { maxMemoryMb: 300, maxJankPercent: 10 } }
  - assert: { perf: { maxMemoryMb: 300, maxJankPercent: 20 } }
  - assert: { network: { url: /api }, timeout: 300 }
`,
  );
  assert.equal(result.verdict, 'fail');
});

test('runScript: 성능 assert — 앱이 떠 있지 않으면 실패', async () => {
  await run(
    'perfdown',
    `name: 성능 앱 없음
app: $PKG
steps:
  - assert: { perf: { maxJankPercent: 50 } }
`,
    { notRunning: true },
  );
});

test('runScript: 준비(clearData·prefs·mocks)와 SDK assert(network·pref·db·event) 통과·실패, 끝나면 목을 지운다', async () => {
  const sdk = {
    network: [
      { id: 1, method: 'GET', url: 'https://api.ex.com/api/old', status: 200, state: 'done', startedAt: NOW - 60_000 },
      { id: 2, method: 'POST', url: 'https://api.ex.com/api/orders', status: 201, state: 'done', startedAt: NOW + 1000 },
      { id: 3, method: 'GET', url: 'https://api.ex.com/api/orders', status: 200, state: 'done', startedAt: NOW + 2000 },
      { id: 4, method: 'GET', url: 'https://api.ex.com/api/slow', status: 0, state: 'pending', startedAt: NOW + 3000 },
    ],
    details: { 2: '{"orderId":"A-1"}', 3: '{"list":[]}' },
    prefs: [{ name: 'settings', entries: { nickname: { type: 'string', value: '냥이' }, auth_token: { type: 'string', value: 'abc.def.ghi' } } }],
    db: { 'SELECT COUNT(*) FROM notes': { columns: ['c'], rows: [[3]] } },
    events: [
      { id: 1, at: NOW - 60_000, name: 'old_event', thread: 'main' },
      { id: 2, at: NOW + 500, name: 'button_clicked', thread: 'main' },
    ],
  };
  const { result } = await run(
    'sdk',
    `name: SDK 검사
app: $PKG
continueOnFail: true
setup:
  clearData: true
  prefs: [{ file: settings, key: nickname, type: string, value: 냥이 }]
  mocks:
    - { url: /api/orders, method: POST, status: 500, body: '{"error":1}' }
    - { url: /api/slow, delayMs: 3000 }
steps:
  - assert: { network: { url: /api/orders, method: POST, status: 201, bodyContains: orderId } }
  - assert: { network: { url: /api/orders, method: GET } }
  - assert: { network: { url: /api/orders, method: POST } }
  - assert: { network: { url: /api/orders, status: 404 }, timeout: 300 }
  - assert: { network: { url: /api/old }, timeout: 300 }
  - assert: { network: { url: /api/orders, bodyContains: 없는본문 }, timeout: 300 }
  - assert: { pref: { file: settings, key: nickname, equals: 냥이 } }
  - assert: { pref: { file: settings, key: auth_token, equals: wrong }, timeout: 300 }
  - assert: { pref: { file: none, key: x, equals: 1 }, timeout: 300 }
  - assert: { db: { db: app.db, sql: "SELECT COUNT(*) FROM notes", equals: 3 } }
  - assert: { db: { db: app.db, sql: "SELECT 1", equals: 1 }, timeout: 300 }
  - assert: { event: button_clicked }
  - assert: { event: old_event, timeout: 300 }
  - assert: { visible: { id: detail }, event: button_clicked, pref: { file: settings, key: nickname, equals: 냥이 } }
`,
    { sdk },
  );
  assert.equal(result.verdict, 'fail');
});

test('runScript: 목을 지우지 못하면 정리 단계와 요약에 남긴다', async () => {
  await run(
    'mockleft',
    `name: 목 남음
app: $PKG
setup:
  mocks: [{ url: /api/x, fail: true }]
steps:
  - assert: { visible: { id: detail } }
`,
    { sdk: { removeFails: true } },
  );
});

test('runScript: 준비 단계가 실패하면 blocked (SDK 없는 앱에 prefs)', async () => {
  const { result } = await run(
    'blocked',
    `name: 준비 실패
app: $PKG
setup:
  prefs: [{ file: settings, key: a, type: string, value: b }]
steps:
  - tap: { text: Detail }
`,
  );
  assert.equal(result.verdict, 'blocked');
});

test('runScript: 중단 신호가 오면 남은 단계를 건너뛰고 통과로 치지 않는다', async () => {
  const { result } = await run(
    'abort',
    `name: 중단
app: $PKG
steps:
  - tap: { text: Detail }
  - back
  - tap: { text: Detail }
`,
    { abortAfter: 0 },
  );
  assert.equal(result.skipped, 2);
  assert.equal(result.verdict, 'blocked');
});

test('runScript: guardDanger 면 확인 필수 버튼(셀렉터·좌표 모두)을 누르지 않는다', async () => {
  await run(
    'danger',
    `name: 확인 필수 버튼
app: $PKG
continueOnFail: true
steps:
  - tap: { text: 삭제 }
  - tapAt: { x: 10, y: 420 }
  - tap: { text: Detail }
`,
    { run: { guardDanger: true } },
  );
});

test('runScript: 크래시가 있으면 noCrash 가 실패한다', async () => {
  await run(
    'crash',
    `name: 크래시
app: $PKG
steps:
  - assert: { noCrash: true }
`,
    { crash: true },
  );
});

test('runScript: matchScreenshot — 처음엔 기준 저장, 같으면 통과, 다르면 실패하고 받아들일 기준을 남긴다', async () => {
  await run(
    'visual',
    `name: 화면 비교
app: $PKG
continueOnFail: true
steps:
  - matchScreenshot: 홈
  - matchScreenshot: { name: 홈, maxDiffPercent: 1, ignore: [{ id: spinner }], tolerance: 2 }
  - tap: { text: Detail }
  - matchScreenshot: 홈
`,
  );
});

test('runScript: 시간으로만 보이는 대기 — 입력창 누른 뒤 0.3초, 통과 검사 스크린샷 전 화면 안정 대기(0.7초)', async () => {
  const pkg = 'com.ex.timing';
  const r = await rig('fake-timing', pkg);
  const script = parseScript(`name: 대기\napp: ${pkg}\nsteps:\n  - type: { text: abc, into: { id: title_input } }\n  - assert: { visible: { id: detail } }\n`);
  await runScript(r.f.dev, script);
  const st = r.f.stamps;
  const at = (pred, from = 0) => st.findIndex((x, i) => i >= from && pred(x[0]));
  const typed = at((c) => c.startsWith('input text'));
  assert.ok(typed > 0 && st[typed - 1][0].startsWith('input tap'), '입력 직전은 입력창 누르기');
  assert.ok(st[typed][1] - st[typed - 1][1] >= 290, `입력창 누른 뒤 ${st[typed][1] - st[typed - 1][1]}ms 만에 입력`);
  const shot = at((c) => c.startsWith('screencap'), typed);
  assert.ok(shot > 0, '검사 단계 스크린샷');
  assert.ok(st[shot][1] - st[shot - 1][1] >= 690, `검사 통과 뒤 ${st[shot][1] - st[shot - 1][1]}ms 만에 스크린샷`);
});

test('evaluateAssertion: 실패는 timeout 동안 되풀이한 뒤에 낸다', async () => {
  const pkg = 'com.ex.retry';
  const r = await rig('fake-retry', pkg);
  r.f.open('home');
  const t0 = Date.now();
  await assert.rejects(evaluateAssertion(r.f.dev, pkg, { visible: { text: '없음' }, timeout: 900 }, { since: NOW }));
  assert.ok(Date.now() - t0 >= 880, `${Date.now() - t0}ms 만에 실패`);
});

test('evaluateAssertion: 여러 조건의 근거를 이어 붙이고, 실패하면 기대/실제 문구로 던진다', async () => {
  const pkg = 'com.ex.evaluate';
  const r = await rig('fake-evaluate', pkg);
  r.f.open('home');
  const ctx = { since: NOW - 2000 };
  const ok = await evaluateAssertion(r.f.dev, pkg, { visible: { id: 'detail' }, activity: 'HomeActivity', noCrash: true, timeout: 300 }, ctx);
  const err = await evaluateAssertion(r.f.dev, pkg, { visible: { id: 'detail' }, notVisible: { id: 'detail' }, timeout: 300 }, ctx).then(
    () => '던지지 않음',
    (e) => `${e.constructor.name}: ${e.message}`,
  );
  const empty = await evaluateAssertion(r.f.dev, pkg, {}, ctx);
  matchGolden('evaluate', { ok, err, empty, commands: collapse(r.f.commands()) });
});

test('runSuite: 폴더의 스크립트를 이름순으로 돌리고 형식 오류는 error 로 남긴다', async () => {
  const pkg = 'com.ex.suite';
  const r = await rig('fake-suite', pkg);
  const dir = join(home, 'suite');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'b.yaml'), `name: 둘째\napp: ${pkg}\nsteps:\n  - tap: { text: 없음, timeout: 200 }\n`);
  writeFileSync(join(dir, 'a.yml'), `name: 첫째\napp: ${pkg}\nsteps:\n  - tap: { text: Detail }\n`);
  writeFileSync(join(dir, 'c.yaml'), `name: 셋째\napp: ${pkg}\nsteps: []\n`);
  writeFileSync(join(dir, 'note.txt'), 'x');
  const seen = [];
  const s = await runSuite(r.f.dev, dir, { onScript: (p, i, n) => seen.push(`${i}/${n} ${p.split('/').pop()}`) });
  matchGolden('suite', {
    seen,
    passed: s.passed,
    failed: s.failed,
    results: s.results.map((x) => ({ file: x.path.split('/').pop(), name: x.name, verdict: x.result?.verdict, error: x.error })),
  });
});
