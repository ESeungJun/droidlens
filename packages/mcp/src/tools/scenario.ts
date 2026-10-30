import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, serialArg, acts, readOnly, recorder } from '../common.js';

const isYaml = (p: string) => ['.yaml', '.yml'].includes(extname(p).toLowerCase());

/** p 가 root 안(같은 곳 포함)인지 */
const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * cwd 가 프로젝트 폴더로 보이는지: git 저장소 루트이거나 홈 아래 두 단계 이상(~/Desktop/app).
 * 홈·루트와 얕은 폴더(~/Desktop, /Users, /tmp)는 다른 파일이 너무 많이 들어 있어 허용 범위로 쓰지 않는다
 */
function isProjectDir(cwd: string, home: string): boolean {
  if (within(cwd, home)) return false; // 홈 자체이거나 홈을 품은 폴더(/Users, /)
  const underHome = within(home, cwd) ? relative(home, cwd).split(sep).length : 0;
  return underHome >= 2 || existsSync(join(cwd, '.git'));
}

/** 허용하는 폴더: scripts 폴더 + 실행이면 MCP 서버를 띄운 프로젝트 폴더(cwd) */
async function allowedRoots(run: boolean): Promise<string[]> {
  const dir = await realpath(await dl.scriptsDir());
  if (!run) return [dir];
  const cwd = await realpath(process.cwd()).catch(() => undefined);
  const home = await realpath(homedir()).catch(() => homedir());
  return cwd && isProjectDir(cwd, home) ? [dir, cwd] : [dir];
}

/**
 * 도구 인자 경로 → 허용된 폴더 안의 실제 경로 (심볼릭 링크를 따라간 것). 도구 인자는 화면·문서에 심어진 지시(프롬프트 인젝션)로
 * 채워질 수 있으므로 scripts 폴더 밖 파일은 읽거나 쓰지 않는다. 상대 경로는 scripts 폴더 기준이고,
 * 실행(script_run·suite_run)이면 cwd 안의 스크립트도 허용하며 cwd 기준으로 있는 파일을 먼저 쓴다 (CLI 처럼 프로젝트 상대 경로를 넘기는 경우)
 */
async function guardPath(input: string, run: boolean): Promise<string> {
  const roots = await allowedRoots(run);
  const p = run && existsSync(resolve(input)) ? resolve(input) : resolve(roots[0], input);
  // 아직 없는 파일(새로 쓰는 스크립트)은 부모 폴더만 따라간다. 다만 깨진 심볼릭 링크도 "없는 파일"로 보이는데
  // 그대로 쓰면 링크가 가리키는 폴더 밖에 쓰게 되므로 거부한다
  if (!existsSync(p) && (await lstat(p).then((st) => st.isSymbolicLink(), () => false))) {
    throw new Error(`대상이 없는 심볼릭 링크라 쓸 수 없습니다: ${input}`);
  }
  const real = existsSync(p) ? await realpath(p) : join(await realpath(dirname(p)).catch(() => dirname(p)), basename(p));
  if (!roots.some((r) => within(r, real))) throw new Error(`스크립트 폴더(${roots.join(', ')}) 밖의 경로는 쓸 수 없습니다: ${input}`);
  return real;
}

/** 스크립트 이름 또는 경로 → 파일 경로 (이름이면 ~/.droidlens/scripts/<이름>.yaml) */
async function scriptPath(nameOrPath: string, run = false): Promise<string> {
  const asPath = /[/\\]/.test(nameOrPath) || isYaml(nameOrPath);
  const p = await guardPath(asPath ? nameOrPath : join(await dl.scriptsDir(), `${dl.safeName(nameOrPath)}.yaml`), run);
  if (!isYaml(p)) throw new Error(`스크립트는 .yaml/.yml 파일이어야 합니다: ${nameOrPath}`);
  return p;
}

/** suite_run 경로 (폴더 또는 스크립트 파일). 생략하면 scripts 폴더 */
async function suitePath(path: string | undefined): Promise<string> {
  const p = path ? await guardPath(path, true) : await realpath(await dl.scriptsDir());
  if (!existsSync(p)) throw new Error(`경로를 찾을 수 없습니다: ${path}`);
  if (!(await stat(p)).isDirectory()) return scriptPath(p, true);
  // 폴더 안의 스크립트도 바깥을 가리키는 심볼릭 링크일 수 있어 하나씩 실제 경로를 확인한다
  const roots = await allowedRoots(true);
  for (const f of await dl.collectScripts(p)) {
    const real = await realpath(f);
    if (!roots.some((r) => within(r, real))) throw new Error(`스크립트 폴더 밖을 가리키는 파일이 있어 실행하지 않습니다: ${f}`);
  }
  return p;
}

const assertionSchema = z
  .record(z.unknown())
  .describe(
    '검사 조건 (스크립트 assert와 같은 형식). 예: {"visible":{"text":"완료"}}, {"activity":"MainActivity"}, ' +
      '{"network":{"url":"/api/orders","method":"POST","status":201}}, {"pref":{"file":"settings","key":"onboarded","equals":true}}, ' +
      '{"db":{"db":"app.db","sql":"SELECT COUNT(*) FROM cart","equals":1}}, {"event":"purchase"}, {"noCrash":true}, ' +
      '{"perf":{"maxMemoryMb":300,"maxJankPercent":10}}',
  );

export function register(server: McpServer): void {
  let scenario: dl.Scenario | undefined;
  let since = Date.now();

  server.registerTool(
    'scenario_start',
    {
      description:
        '시나리오 검증 기록 시작. 이후 조작(tap/type_text/swipe/press_key/wait_for/launch_app/open_deeplink/perf_startup)이 자동으로 스크립트 단계로 녹화되고, ' +
        'scenario_step의 assert도 함께 녹화된다. scenario_finish에서 통과하면 재실행 가능한 YAML 스크립트로 저장된다.',
      inputSchema: {
        ...serialArg,
        name: z.string(),
        goal: z.string().optional(),
        packageName: z.string().optional().describe('대상 앱. 스크립트로 저장하려면 필요'),
      },
      annotations: acts,
    },
    async ({ serial, name, goal, packageName }) => {
      const dev = await device(serial);
      const info = await dl.getDeviceInfo(dev).catch(() => undefined);
      scenario = await dl.Scenario.start(name, {
        goal,
        packageName,
        device: info ? `${info.manufacturer} ${info.model} (Android ${info.androidVersion})` : dev.serial,
      });
      // 검사가 비교하는 시각(네트워크·이벤트·크래시)은 기기 시계 기준이다
      since = (await dl.deviceTime(dev).catch(() => Date.now())) - 2000;
      recorder.active = true;
      recorder.app = packageName;
      recorder.steps = [];
      recorder.mocks = new Map();
      return text(`시나리오 시작: ${scenario.data.id}\n폴더: ${scenario.data.dir}${packageName ? '\n조작 녹화 중' : ''}`);
    },
  );

  server.registerTool(
    'scenario_step',
    {
      description:
        '시나리오 단계 기록. assert를 주면 DroidLens가 직접 검사해 pass/fail을 판정하고 스크립트에도 녹화한다 (권장). ' +
        'assert 없이 status로 직접 판정할 수도 있다: pass / fail / info(진행 기록) / skip.',
      inputSchema: {
        ...serialArg,
        title: z.string().describe('무엇을 했고 무엇을 확인했는지'),
        status: z.enum(['pass', 'fail', 'info', 'skip']).optional().describe('assert가 없을 때 필수'),
        assert: assertionSchema.optional(),
        detail: z.string().optional().describe('기대값 vs 실제값, 근거'),
        screenshot: z.boolean().optional().describe('기본 true'),
      },
      annotations: acts,
    },
    async ({ serial, title, status, assert, detail, screenshot }) => {
      if (!scenario) throw new Error('먼저 scenario_start를 호출하세요');
      const dev = await device(serial);
      let finalStatus = status;
      let finalDetail = detail;
      if (assert) {
        const app = recorder.app ?? scenario.data.packageName;
        if (!app) throw new Error('assert를 쓰려면 scenario_start에 packageName이 필요합니다');
        const parsed = dl.stepSchema.parse({ assert });
        if (!('assert' in parsed)) throw new Error('assert 형식이 올바르지 않습니다');
        try {
          const evidence = await dl.evaluateAssertion(dev, app, parsed.assert, { since });
          finalStatus = 'pass';
          finalDetail = [detail, evidence].filter(Boolean).join('\n');
          // 통과한 검사만 녹화한다 (실패한 기대를 스크립트에 넣으면 회귀 테스트가 항상 실패한다)
          if (recorder.active) recorder.steps.push(parsed);
        } catch (e) {
          finalStatus = 'fail';
          finalDetail = [detail, (e as Error).message].filter(Boolean).join('\n');
        }
      }
      if (!finalStatus) throw new Error('status 또는 assert가 필요합니다');
      const png = screenshot === false ? undefined : await dl.screenshot(dev);
      const screen = await dl.currentScreen(dev, { fragments: true }).catch(() => undefined);
      const s = await scenario.step(title, finalStatus, {
        detail: finalDetail,
        png,
        screen: screen ? `${screen.activity}${screen.fragments.length ? ' / ' + screen.fragments.join(', ') : ''}` : undefined,
      });
      return text(`step ${s.index} ${finalStatus}: ${title}${assert && finalDetail ? `\n${finalDetail}` : ''}`);
    },
  );

  server.registerTool(
    'scenario_finish',
    {
      description:
        '시나리오 종료 및 HTML 리포트 생성. verdict: pass | fail | blocked. 통과(pass)하고 녹화된 조작이 있으면 ' +
        'YAML 스크립트로 저장해 script_run으로 다시 돌릴 수 있게 한다 (saveScript=false로 끔).',
      inputSchema: {
        verdict: z.enum(['pass', 'fail', 'blocked']),
        summary: z.string(),
        saveScript: z.boolean().optional(),
        scriptName: z.string().optional().describe('저장할 스크립트 이름 (기본: 시나리오 이름)'),
      },
      annotations: acts,
    },
    async ({ verdict, summary, saveScript, scriptName }) => {
      if (!scenario) throw new Error('진행 중인 시나리오가 없습니다');
      const html = await scenario.finish(verdict, summary);
      const d = scenario.data;
      scenario = undefined;
      const lines = [`리포트: ${html}`, `${d.steps.length}단계 · 실패 ${d.steps.filter((s) => s.status === 'fail').length} · 판정 ${verdict}`];

      // 스크립트는 setup에서 앱을 새로 띄우므로, 녹화 맨 앞의 앱 실행 단계는 중복이라 뺀다
      const firstAction = recorder.steps.findIndex((st) => !('launch' in st));
      const steps = firstAction < 0 ? [] : recorder.steps.slice(firstAction);
      const app = recorder.app;
      // 녹화 중 켠 목은 재실행 때도 같은 조건이 되도록 setup 에서 켜고 끝나면 지우게 한다
      const mocks = [...recorder.mocks.values()].map(({ id: _id, enabled: _enabled, hits: _hits, delayMs, fail, ...m }) => ({
        ...m,
        ...(delayMs ? { delayMs } : {}),
        ...(fail ? { fail } : {}),
      }));
      recorder.active = false;
      recorder.steps = [];
      recorder.mocks = new Map();
      if (app && steps.length) {
        // 녹화는 이미 앱이 열린 상태에서 시작되므로, 재실행 시에는 앱을 새로 띄우고 시작한다
        const setup: dl.Script['setup'] = { restart: true, ...(mocks.length ? { mocks } : {}) };
        const script: dl.Script = { name: scriptName ?? d.name, app, setup, steps: steps as dl.Script['steps'] };
        const yaml = dl.toYaml(script);
        await writeFile(join(d.dir, 'script.yaml'), yaml);
        if (verdict === 'pass' && saveScript !== false) {
          const p = await dl.saveScript(script);
          lines.push(`스크립트 저장: ${p} (${steps.length}단계) — script_run("${basename(p, '.yaml')}")으로 재실행`);
        } else {
          lines.push(`녹화된 스크립트: ${join(d.dir, 'script.yaml')} (저장하지 않음)`);
        }
        lines.push('', yaml);
      }
      return text(lines.join('\n'));
    },
  );

  // ---------- 스크립트 ----------

  server.registerTool(
    'script_list',
    { description: '저장된 시나리오 스크립트 목록 (~/.droidlens/scripts)', annotations: readOnly },
    async () => {
      const dir = await dl.scriptsDir();
      const files = await dl.collectScripts(dir);
      if (!files.length) return text(`저장된 스크립트가 없습니다 (${dir})`);
      const rows = await Promise.all(
        files.map(async (f) => {
          try {
            const s = await dl.loadScript(f);
            return `- ${basename(f, '.yaml')}: ${s.name} · ${s.app} · ${s.steps.length}단계`;
          } catch (e) {
            return `- ${basename(f)}: ✗ ${(e as Error).message.split('\n')[0]}`;
          }
        }),
      );
      return text(`${dir}\n${rows.join('\n')}`);
    },
  );

  server.registerTool(
    'script_read',
    { description: '스크립트 YAML 내용', inputSchema: { script: z.string().describe('이름 또는 경로') }, annotations: readOnly },
    async ({ script }) => {
      const p = await scriptPath(script);
      return text(`${p}\n\n${await readFile(p, 'utf8')}`);
    },
  );

  server.registerTool(
    'script_write',
    {
      description:
        '스크립트 YAML 작성·수정 (형식 검증 후 저장). 단계: tap/longPress/tapAt/type/swipe/key/wait/sleep/launch/deeplink/screenshot/assert/startup/matchScreenshot. ' +
        'setup 에는 restart/clearData/prefs/mocks(실행하는 동안만 켤 네트워크 목). ' +
        '기존 스크립트를 고칠 때는 script_read로 읽고 수정한 전체 YAML을 넘긴다.',
      inputSchema: { yaml: z.string(), name: z.string().optional().describe('파일 이름 (기본: 스크립트 name)') },
      annotations: acts,
    },
    async ({ yaml, name }) => {
      const script = dl.parseScript(yaml);
      const p = await scriptPath(name ?? script.name);
      const existed = existsSync(p);
      await writeFile(p, yaml.endsWith('\n') ? yaml : yaml + '\n');
      return text(`${existed ? '수정' : '저장'}: ${p} (${script.steps.length}단계)`);
    },
  );

  server.registerTool(
    'script_run',
    {
      description: '스크립트를 기기에서 실행하고 단계별 판정과 HTML 리포트를 돌려준다. 회귀 테스트·재현에 사용',
      inputSchema: { ...serialArg, script: z.string().describe('이름 또는 경로') },
      annotations: acts,
    },
    async ({ serial, script }, extra) => {
      const dev = await device(serial);
      const p = await scriptPath(script, true);
      const lines: string[] = [];
      const r = await dl.runScript(dev, await dl.loadScript(p), {
        sourcePath: p,
        signal: extra.signal,
        onStep: (e) => {
          if (e.status !== 'running') lines.push(`${e.index + 1}/${e.total} ${e.status.toUpperCase()} ${e.title}${e.detail && e.status === 'fail' ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : ''}`);
        },
      });
      return text([`판정: ${r.verdict.toUpperCase()} (${r.passed} 통과 · ${r.failed} 실패 · ${r.skipped} 건너뜀, ${(r.durationMs / 1000).toFixed(1)}초)`, ...lines, `리포트: ${r.report}`].join('\n'));
    },
  );

  server.registerTool(
    'suite_run',
    {
      description: '폴더 안의 모든 스크립트(*.yaml)를 차례로 실행하는 회귀 테스트. path를 생략하면 ~/.droidlens/scripts. ' +
        '그 폴더나 MCP 서버를 띄운 프로젝트 폴더 안만 실행할 수 있다',
      inputSchema: { ...serialArg, path: z.string().optional() },
      annotations: acts,
    },
    async ({ serial, path }, extra) => {
      const dev = await device(serial);
      const r = await dl.runSuite(dev, await suitePath(path), { signal: extra.signal });
      const rows = r.results.map((x) =>
        x.error
          ? `✗ ${x.name}: ${x.error.split('\n')[0]}`
          : `${x.result!.verdict === 'pass' ? '✓' : '✗'} ${x.name} — ${x.result!.passed}/${x.result!.passed + x.result!.failed + x.result!.skipped} (${(x.result!.durationMs / 1000).toFixed(1)}초) ${x.result!.verdict !== 'pass' ? x.result!.report : ''}`,
      );
      return text([`${r.passed}/${r.results.length} 통과 (${(r.durationMs / 1000).toFixed(0)}초)`, ...rows].join('\n'));
    },
  );
}
