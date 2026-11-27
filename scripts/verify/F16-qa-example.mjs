#!/usr/bin/env node
// F16 문서로 QA · SC-06: examples/qa 의 예시 기획서·TC 표로 README 의 QA 절차를 끝까지 따라 한다.
//   문서 넣기 → TC 뽑기 → 검토(덮인 요구사항) → 실행(`droidlens-mcp qa run`) → 결과표·엑셀·단계별 HTML
//
// 시작 상태
//   - 저장소 루트에서 `pnpm build` 를 마친 상태 (packages/core/dist, packages/mcp/dist)
//   - 기기 하나 연결, 샘플 앱 debug 빌드 설치: `cd android && ./gradlew :sample:installDebug`
//   - 기기에 8099 포트 역방향 연결이 없을 것(`adb reverse --list` 가 비어 있음). TC-007 이 서버에 닿지 않는 경우를 본다
//   - 단독 MCP 로 돌리므로 에이전트 APK 가 옆에 없으면 DROIDLENS_AGENT_APK 로 알려 준다
//     (예: `pnpm build:agent` 뒤 android/agent/build/outputs/apk/release/agent-release.apk). 없으면 uiautomator 로 돈다
//   - 사용자의 ~/.droidlens 는 건드리지 않는다. DroidLens 홈은 <캡처 폴더>/F16-home 이나 .work/verify/F16-<시각>
//
// LLM 이 맡는 두 곳은 같은 결과를 내는 정해진 코드로 대신한다
//   - droidlens-qa-planner 의 "요구사항 잇기": 기획서의 `- 1.1 …` 줄을 요구사항으로, TC 표의 Spec 칸으로 TC 에 잇는다
//     (TC 표는 넣는 순간 앱이 원문 그대로 가져온다, #129)
//   - droidlens-verifier 가 통과 뒤 녹화하는 회귀 스크립트: TC 마다 아래 STEPS 를 저장하고 TC 에 잇는다
//
// 사용: node scripts/verify/F16-qa-example.mjs [캡처 폴더] [--serial <기기>] [--no-device]
//   --no-device: 기기 없이 문서 넣기 → TC 뽑기 → 검토까지만 본다(CI 가 예시 파일이 깨지지 않았는지 볼 때)
// 결과: 성공 0, 실패 1(실패한 단계와 기대·실제를 한 줄로)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const noDevice = args.includes('--no-device');
const serialAt = args.indexOf('--serial');
const serial = serialAt >= 0 ? args[serialAt + 1] : undefined;
const capture = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--serial');

const fail = (step, expected, actual) => {
  console.error(`실패: ${step} — 기대: ${expected} / 실제: ${actual}`);
  process.exit(1);
};

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const home = capture ? join(resolve(capture), 'F16-home') : join(root, '.work', 'verify', `F16-${stamp}`);
await mkdir(home, { recursive: true });
process.env.DROIDLENS_HOME = home; // core 는 부를 때마다 이 값을 읽는다

const coreEntry = join(root, 'packages/core/dist/index.js');
const cli = join(root, 'packages/mcp/dist/droidlens-mcp.mjs');
let dl;
try {
  dl = await import(pathToFileURL(coreEntry).href);
} catch {
  fail('준비', 'packages/core/dist 가 있음 (pnpm build)', '없음');
}

const SPEC = join(root, 'examples/qa/sample-app-spec.md');
const TABLE = join(root, 'examples/qa/sample-app-tc.csv');
const APP = 'io.github.eseungjun.droidlens.sample';

// 1. 계획 만들고 문서 넣기 (QA 탭 "문서 넣기", MCP qa_plan_create·qa_source_add 와 같은 함수)
const created = await dl.createQaPlan({ name: 'DroidLens Sample (example)', app: APP });
const md = await dl.addQaSource(created.id, SPEC);
const csv = await dl.addQaSource(created.id, TABLE);
if (md.source.kind !== 'md' || csv.source.kind !== 'csv') fail('문서 넣기', 'md, csv', `${md.source.kind}, ${csv.source.kind}`);
const warnings = [...md.warnings, ...csv.warnings];
if (warnings.length) fail('문서 넣기', '경고 없음', warnings.join(' / '));

// 2. 읽기 (qa_source_read 가 에이전트에 주는 글). CSV 는 마크다운 표로 바뀐다
const specText = await dl.readQaSourceText(created.id, md.source.id);
const tableText = await dl.readQaSourceText(created.id, csv.source.id);
if (!tableText.startsWith('| No | Title |')) fail('문서 읽기', 'CSV 가 마크다운 표로 읽힘', tableText.slice(0, 40));

// 3. TC 뽑기: TC 표는 넣을 때 이미 원문 그대로 들어왔다(TC 문서 갈래). 기획서 줄마다 요구사항 하나를 만들고 Spec 칸으로 잇는다
if (csv.tcImport?.cases !== 7) fail('TC 표 가져오기', 'TC 7개', String(csv.tcImport?.cases));
const requirements = [...specText.matchAll(/^- (\d+\.\d+) (.+)$/gm)].map((m, i) => ({
  id: `R-${String(i + 1).padStart(2, '0')}`,
  text: m[2],
  source: { source: md.source.id, locator: m[1] },
}));
const bySection = new Map(requirements.map((r) => [r.source.locator, r.id]));
const [head, ...rows] = dl.parseCsv(await readFile(TABLE, 'utf8'));
const col = (name) => {
  const i = head.indexOf(name);
  if (i < 0) fail('TC 표 읽기', `${name} 칸`, head.join(','));
  return i;
};
const cases = rows.map((r, i) => {
  const req = bySection.get(r[col('Spec')]);
  if (!req) fail('TC 뽑기', `${i + 2}행의 Spec 이 기획서 절 번호`, r[col('Spec')]);
  // TC 문서 TC 는 원문을 고칠 수 없어 번호와 요구사항만 적는다
  return { id: `TC-${String(i + 1).padStart(3, '0')}`, requirements: [req] };
});
let plan = await dl.saveAgentQaPlan(created.id, { requirements, cases });
const notVerbatim = plan.cases.filter((c, i) => c.track !== 'tc' || c.title !== rows[i][col('Title')]);
if (notVerbatim.length) fail('TC 표 가져오기', '제목이 원문 그대로인 TC 문서 TC', notVerbatim.map((c) => c.id).join(', '));

// 4. 검토: 요구사항마다 TC 가 있고, 확인 필수 동작이 없으니 모두 골라져 있어야 한다
const cov = dl.qaCoverage(plan);
if (cov.uncovered.length) fail('검토', '덮이지 않은 요구사항 없음', cov.uncovered.join(', '));
const picked = plan.cases.filter((c) => c.selected).length;
console.log(`계획 ${plan.id}: 요구사항 ${plan.requirements.length}개 · TC ${plan.cases.length}개 · 고름 ${picked}개`);
if (plan.requirements.length !== 7 || plan.cases.length !== 7 || picked !== 7) fail('검토', '요구사항 7 · TC 7 · 고름 7', `${plan.requirements.length} · ${plan.cases.length} · ${picked}`);

// 5. TC 마다 회귀 스크립트를 저장하고 잇는다 (verifier 가 통과한 뒤 scenario_finish 가 하는 일)
const BUTTONS = ['GET 요청', 'POST 요청', '폼 POST', '404 요청', '로컬 서버 요청', '스트림 업로드', '스트리밍 응답', 'DB에 메모 추가', 'PREFS 저장', '커스텀 이벤트'];
const restart = { launch: { restart: true } };
const STEPS = {
  'TC-001': [restart, { assert: { visible: { textContains: 'running: true' } } }],
  'TC-002': [restart, ...BUTTONS.map((t) => ({ assert: { visible: { text: t } } }))],
  'TC-003': [restart, { tap: { text: 'DB에 메모 추가' } }, { assert: { visible: { textContains: 'note #' } } }],
  // 데이터를 지우고 시작해 두 번 누르면 2번이 되는지 본다
  'TC-004': [{ tap: { text: 'DB에 메모 추가' } }, { tap: { text: 'DB에 메모 추가' } }, { assert: { text: { of: { textContains: 'note #' }, equals: 'note #2' } } }],
  'TC-005': [restart, { tap: { text: 'PREFS 저장' } }, { assert: { visible: { text: 'prefs 저장됨' } } }, { assert: { pref: { file: 'settings', key: 'nickname', equals: '냥이' } } }],
  'TC-006': [restart, { tap: { text: '커스텀 이벤트' } }, { assert: { visible: { text: '이벤트 기록됨' } } }, { assert: { event: 'button_clicked' } }],
  'TC-007': [restart, { tap: { text: '로컬 서버 요청' } }, { wait: { textContains: '실패:', timeout: 10000 } }, { assert: { noCrash: true } }],
};
const scripts = join(home, 'scripts');
await mkdir(scripts, { recursive: true });
for (const c of plan.cases) {
  if (!STEPS[c.id]) fail('스크립트 잇기', `${c.id} 의 단계`, '없음');
  const name = `${plan.id}-${c.id}`;
  const text = dl.toYaml(
    dl.parseScript(
      dl.toYaml({
        name: `${c.id} ${c.title}`,
        app: APP,
        ...(c.id === 'TC-004' ? { setup: { clearData: true } } : {}),
        tc: { plan: plan.id, case: c.id },
        steps: STEPS[c.id],
      }),
    ),
  );
  await writeFile(join(scripts, `${name}.yaml`), text);
  plan = await dl.linkQaCaseScript(plan.id, c.id, name, { hash: createHash('sha256').update(text).digest('hex'), fingerprint: dl.dangerFingerprint(c) });
}
console.log(`스크립트 ${plan.cases.filter((c) => c.script).length}개 이음`);
if (noDevice) {
  console.log(`기기 없이 확인 끝 (DroidLens 홈: ${home})`);
  process.exit(0);
}

// 6. 실행: README 의 회귀 CLI
let out = '';
let code = 0;
try {
  out = execFileSync(process.execPath, [cli, 'qa', 'run', plan.id, ...(serial ? ['--serial', serial] : [])], { encoding: 'utf8', env: process.env });
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  code = e.status ?? 1;
}
const total = out.match(/통과 (\d+) · 실패 (\d+) · 막힘 (\d+) · 안 돌림 (\d+)/);
if (!total) fail('실행', 'qa run 이 회차 요약을 출력', out.trim().split('\n').slice(-3).join(' / '));
console.log(total[0]);
if (code !== 0 || total[1] !== '7') fail('실행', '통과 7 · 종료 코드 0', `${total[0]} · 종료 코드 ${code}`);

// 7. 결과표와 회차 내보내기(검증 기록의 엑셀·단계별 HTML)
const run = await dl.latestQaRun(plan.id);
const dir = dl.qaRunDir(plan.id, run.id);
for (const kind of ['xlsx', 'html']) await dl.writeQaRunExport(plan.id, run.id, kind);
const csvOut = await readFile(join(dir, 'results.csv'), 'utf8');
const passed = csvOut.split('\n').filter((l) => l.includes('"통과"')).length;
if (passed !== 7) fail('결과표', 'results.csv 에 통과 7줄', `${passed}줄`);
console.log(`결과표: ${join(dir, 'report.html')}`);
console.log(`내보내기: ${join(dir, 'results.xlsx')}, ${join(dir, 'steps.html')}`);
