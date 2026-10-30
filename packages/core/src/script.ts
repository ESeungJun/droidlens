import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { DeviceAdb, sleep } from './adb.js';
import { ensureAgent } from './agent.js';
import { clearAppData, currentScreen, deviceTime, openDeepLink, recentCrashes, type CurrentScreen } from './app.js';
import { KEYCODES, longPress, pressKey, replaceText, screenshot, swipeDirection, tap, typeText } from './device.js';
import { FlowCollector, launchAndSettle } from './graph.js';
import { center, dumpHierarchy, findNodes, type Selector, type ViewNode } from './hierarchy.js';
import { Scenario, type ScenarioData } from './scenario.js';
import { sdkFor } from './sdk.js';
import { ensureDir, safeName } from './workspace.js';

/**
 * 시나리오 스크립트 (YAML).
 *
 * ```yaml
 * name: 메모 추가
 * app: com.example.app
 * setup: { restart: true }
 * steps:
 *   - tap: { text: 메모 추가 }
 *   - type: { text: 장보기, into: { id: title_input } }
 *   - tap: { id: save }
 *   - assert: { visible: { textContains: 장보기 } }
 *   - assert: { network: { url: /api/notes, method: POST, status: 201 } }
 * ```
 */

// ---------- 스키마 ----------

const selectorShape = {
  id: z.string().optional(),
  text: z.string().optional(),
  textContains: z.string().optional(),
  desc: z.string().optional(),
  descContains: z.string().optional(),
  className: z.string().optional(),
  index: z.number().int().optional(),
};
const hasCondition = (s: Record<string, unknown>) =>
  ['id', 'text', 'textContains', 'desc', 'descContains', 'className'].some((k) => s[k] !== undefined);
const NEED_COND = '셀렉터에 조건(id/text/textContains/desc/descContains/className)이 하나 이상 필요합니다';

const selector = z.object(selectorShape).strict().refine(hasCondition, NEED_COND);
/** 요소 대상 단계: timeout(ms) 동안 기다리고, optional이면 없을 때 건너뜀 */
const targetSel = z
  .object({ ...selectorShape, timeout: z.number().int().optional(), optional: z.boolean().optional() })
  .strict()
  .refine(hasCondition, NEED_COND);
const waitSel = z
  .object({ ...selectorShape, timeout: z.number().int().optional(), optional: z.boolean().optional(), gone: z.boolean().optional() })
  .strict()
  .refine(hasCondition, NEED_COND);

const direction = z.enum(['up', 'down', 'left', 'right']);

const assertion = z
  .object({
    visible: selector.optional(),
    notVisible: selector.optional(),
    text: z.object({ of: selector, equals: z.string().optional(), contains: z.string().optional() }).optional(),
    activity: z.string().optional().describe('현재 Activity 이름 (끝부분 일치)'),
    package: z.string().optional(),
    network: z
      .object({ url: z.string(), method: z.string().optional(), status: z.number().int().optional(), bodyContains: z.string().optional() })
      .optional(),
    pref: z.object({ file: z.string(), key: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
    db: z.object({ db: z.string(), sql: z.string(), equals: z.union([z.string(), z.number(), z.null()]) }).optional(),
    event: z.string().optional(),
    noCrash: z.boolean().optional(),
    timeout: z.number().int().optional(),
  })
  .strict();

/** sleep 단계의 상한. 잘못 적은 값(예: 600000)은 스크립트를 저장·검증할 때 바로 오류로 알린다 */
const MAX_SLEEP_MS = 60_000;

/** 한 단어 축약: - back / - home / - launch / - screenshot */
const SHORTHAND: Record<string, unknown> = {
  launch: { launch: null },
  restart: { launch: { restart: true } },
  screenshot: { screenshot: null },
  ...Object.fromEntries(Object.keys(KEYCODES).map((k) => [k, { key: k }])),
};

const stepUnion = z.union([
  z.object({ tap: targetSel }).strict(),
  z.object({ longPress: targetSel }).strict(),
  z.object({ tapAt: z.object({ x: z.number(), y: z.number() }) }).strict(),
  z
    .object({
      type: z.object({ text: z.string(), into: selector.optional(), clear: z.boolean().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      swipe: z.union([
        direction,
        z.object({ direction, until: selector.optional(), max: z.number().int().optional() }).strict(),
      ]),
    })
    .strict(),
  z.object({ key: z.enum(Object.keys(KEYCODES) as [keyof typeof KEYCODES]) }).strict(),
  z.object({ wait: waitSel }).strict(),
  z.object({ sleep: z.number().int().min(0).max(MAX_SLEEP_MS, `sleep 은 ${MAX_SLEEP_MS}ms(60초)까지입니다`) }).strict(),
  z.object({ launch: z.object({ restart: z.boolean().optional() }).strict().optional().nullable() }).strict(),
  z.object({ deeplink: z.string() }).strict(),
  z.object({ screenshot: z.string().optional().nullable() }).strict(),
  z.object({ assert: assertion }).strict(),
]);

export const stepSchema = z.preprocess((v) => (typeof v === 'string' && v in SHORTHAND ? SHORTHAND[v] : v), stepUnion);

export const scriptSchema = z
  .object({
    name: z.string(),
    app: z.string().regex(/^[a-zA-Z][\w]*(\.[\w]+)+$/, '패키지 이름 형식이 아닙니다'),
    description: z.string().optional(),
    setup: z
      .object({
        restart: z.boolean().optional(),
        /** 앱 데이터 초기화 (되돌릴 수 없음) */
        clearData: z.boolean().optional(),
        prefs: z
          .array(z.object({ file: z.string(), key: z.string(), type: z.enum(['string', 'int', 'long', 'float', 'boolean', 'stringSet']), value: z.string() }))
          .optional(),
      })
      .strict()
      .optional(),
    /** 실패해도 다음 단계 계속 (기본 false: 첫 실패에서 중단) */
    continueOnFail: z.boolean().optional(),
    /** 단계마다 스크린샷 (기본: 실패·screenshot·assert 단계만) */
    screenshots: z.enum(['all', 'failures']).optional(),
    /** 요소를 기다리는 기본 시간 (ms) */
    timeout: z.number().int().optional(),
    steps: z.array(stepSchema).min(1),
  })
  .strict();

export type Script = z.infer<typeof scriptSchema>;
export type ScriptStep = z.infer<typeof stepSchema>;
export type Assertion = z.infer<typeof assertion>;

export function parseScript(text: string): Script {
  const raw = YAML.parse(text);
  const r = scriptSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`스크립트 형식 오류:\n${msg}`);
  }
  return r.data;
}

export function toYaml(script: Script): string {
  return YAML.stringify(script, { lineWidth: 0 });
}

export async function loadScript(path: string): Promise<Script> {
  return parseScript(await readFile(path, 'utf8'));
}

/** 경로가 폴더면 그 안의 *.yaml/*.yml을 이름순으로, 파일이면 그 파일 하나 */
export async function collectScripts(path: string): Promise<string[]> {
  const st = await stat(path);
  if (!st.isDirectory()) return [path];
  return (await readdir(path))
    .filter((f) => ['.yaml', '.yml'].includes(extname(f)))
    .sort()
    .map((f) => join(path, f));
}

export async function scriptsDir(): Promise<string> {
  return ensureDir('scripts');
}

export async function saveScript(script: Script, name = script.name): Promise<string> {
  const p = join(await scriptsDir(), `${safeName(name)}.yaml`);
  await writeFile(p, toYaml(script));
  return p;
}

// ---------- 단계 설명 ----------

const selText = (s: Selector) =>
  Object.entries(s)
    .filter(([k, v]) => v !== undefined && !['timeout', 'optional', 'gone'].includes(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');

export function describeStep(step: ScriptStep): string {
  const [kind, arg] = Object.entries(step)[0] as [string, unknown];
  switch (kind) {
    case 'tap':
    case 'longPress':
    case 'wait':
      return `${kind} ${selText(arg as Selector)}`;
    case 'type': {
      const t = arg as { text: string; into?: Selector };
      return `type "${t.text}"${t.into ? ` → ${selText(t.into)}` : ''}`;
    }
    case 'swipe':
      return typeof arg === 'string' ? `swipe ${arg}` : `swipe ${(arg as { direction: string }).direction}${(arg as { until?: Selector }).until ? ` until ${selText((arg as { until: Selector }).until)}` : ''}`;
    case 'assert':
      return `assert ${Object.entries(arg as object)
        .filter(([k]) => k !== 'timeout')
        .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ')}`;
    default:
      return `${kind}${arg !== undefined && arg !== null ? ' ' + (typeof arg === 'object' ? JSON.stringify(arg) : arg) : ''}`;
  }
}

// ---------- 실행 ----------

export interface ScriptRunOptions {
  /** 진행 상황 콜백 (데스크톱 UI, CLI 출력) */
  onStep?: (e: { index: number; total: number; title: string; status: 'running' | 'pass' | 'fail' | 'skip'; detail?: string }) => void;
  signal?: AbortSignal;
  /** 리포트에 남길 원본 스크립트 경로 */
  sourcePath?: string;
  /** 지나간 화면과 연결을 앱의 화면 지도에 모은다 (기본 true, 에이전트가 있을 때만) */
  collectFlow?: boolean;
}

export interface RunResult {
  verdict: 'pass' | 'fail' | 'blocked';
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  report: string;
  scenario: ScenarioData;
}

class StepFailure extends Error {}

async function findWithin(dev: DeviceAdb, sel: Selector, timeoutMs: number): Promise<ViewNode | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await dumpHierarchy(dev).catch(() => undefined);
    const [n] = h ? findNodes(h.root, sel) : [];
    if (n) return n;
    if (Date.now() >= deadline) return undefined;
    await sleep(300);
  }
}

/** 단일 assertion 평가. 통과하면 근거 문자열, 실패하면 StepFailure. ctx.since 는 기기 시계 기준 (deviceTime) */
export async function evaluateAssertion(dev: DeviceAdb, app: string, a: Assertion, ctx: { since: number }): Promise<string> {
  const timeout = a.timeout ?? 3000;
  const evidence: string[] = [];
  const retry = async (check: () => Promise<string | undefined>, failMsg: () => Promise<string> | string) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const ok = await check().catch(() => undefined);
      if (ok !== undefined) return evidence.push(ok);
      if (Date.now() >= deadline) throw new StepFailure(await failMsg());
      await sleep(400);
    }
  };

  if (a.visible) {
    await retry(
      async () => {
        const [n] = findNodes((await dumpHierarchy(dev)).root, a.visible!);
        return n ? `보임: ${n.text || n.contentDesc || n.resourceId}` : undefined;
      },
      () => `기대: ${selText(a.visible!)} 보임 / 실제: 없음`,
    );
  }
  if (a.notVisible) {
    await retry(
      async () => (findNodes((await dumpHierarchy(dev)).root, a.notVisible!).length === 0 ? `안 보임: ${selText(a.notVisible!)}` : undefined),
      () => `기대: ${selText(a.notVisible!)} 안 보임 / 실제: 보임`,
    );
  }
  if (a.text) {
    let actual = '(요소 없음)';
    await retry(
      async () => {
        const [n] = findNodes((await dumpHierarchy(dev)).root, a.text!.of);
        if (!n) return undefined;
        actual = n.text;
        if (a.text!.equals !== undefined && n.text !== a.text!.equals) return undefined;
        if (a.text!.contains !== undefined && !n.text.includes(a.text!.contains)) return undefined;
        return `텍스트 "${n.text}"`;
      },
      () => `기대: ${a.text!.equals !== undefined ? `"${a.text!.equals}"` : `"${a.text!.contains}" 포함`} / 실제: "${actual}"`,
    );
  }
  if (a.activity || a.package) {
    let actual = '';
    await retry(
      async () => {
        const s = await currentScreen(dev);
        actual = `${s.packageName} ${s.activity}`;
        if (a.package && s.packageName !== a.package) return undefined;
        if (a.activity && !s.activity.endsWith(a.activity)) return undefined;
        return `화면 ${s.activity}`;
      },
      () => `기대: ${a.package ?? ''} ${a.activity ?? ''} / 실제: ${actual}`,
    );
  }
  if (a.network) {
    const want = a.network;
    let seen = '';
    await retry(
      async () => {
        const c = await sdkFor(dev, app);
        const list = (await c.network({ filter: want.url })).filter((e) => e.startedAt >= ctx.since && e.state !== 'pending');
        seen = list.map((e) => `${e.method} ${e.status || e.state} ${e.url}`).slice(-3).join('; ') || '해당 URL 요청 없음';
        for (const e of list.reverse()) {
          if (want.method && e.method.toUpperCase() !== want.method.toUpperCase()) continue;
          if (want.status !== undefined && e.status !== want.status) continue;
          if (want.bodyContains) {
            const d = await c.networkDetail(e.id);
            if (!d.responseBody?.includes(want.bodyContains)) continue;
          }
          return `요청 #${e.id} ${e.method} ${e.status} ${e.url}`;
        }
        return undefined;
      },
      () => `기대: ${want.method ?? ''} ${want.url} ${want.status ?? ''} / 실제: ${seen}`,
    );
  }
  if (a.pref) {
    let actual: unknown = '(없음)';
    await retry(
      async () => {
        const files = await (await sdkFor(dev, app)).prefs();
        const v = files.find((f) => f.name === a.pref!.file)?.entries[a.pref!.key];
        actual = v?.value;
        return v && String(v.value) === String(a.pref!.equals) ? `${a.pref!.file}.${a.pref!.key} = ${v.value}` : undefined;
      },
      () => `기대: ${a.pref!.file}.${a.pref!.key} = ${a.pref!.equals} / 실제: ${actual}`,
    );
  }
  if (a.db) {
    let actual: unknown = '(없음)';
    await retry(
      async () => {
        const r = await (await sdkFor(dev, app)).query(a.db!.db, a.db!.sql);
        actual = r.rows?.[0]?.[0];
        return String(actual) === String(a.db!.equals) ? `${a.db!.sql} → ${actual}` : undefined;
      },
      () => `기대: ${a.db!.sql} → ${a.db!.equals} / 실제: ${actual}`,
    );
  }
  if (a.event) {
    await retry(
      async () => {
        const ev = (await (await sdkFor(dev, app)).events()).filter((e) => e.at >= ctx.since && e.name === a.event);
        return ev.length ? `이벤트 ${a.event} ${ev.length}회` : undefined;
      },
      () => `기대: 이벤트 ${a.event} / 실제: 기록 없음`,
    );
  }
  if (a.noCrash) {
    const crashes = await recentCrashes(dev, app, { since: ctx.since - 1000 });
    if (crashes.length) throw new StepFailure(`크래시 발생:\n${crashes[crashes.length - 1].split('\n').slice(0, 8).join('\n')}`);
    evidence.push('크래시 없음');
  }
  return evidence.join(' · ');
}

/** 스크립트를 기기에서 실행하고 시나리오 리포트를 만든다 */
export async function runScript(dev: DeviceAdb, script: Script, opts: ScriptRunOptions = {}): Promise<RunResult> {
  const t0 = Date.now();
  const app = script.app;
  const defaultTimeout = script.timeout ?? 5000;
  const scenario = await Scenario.start(script.name, {
    goal: script.description ?? (opts.sourcePath ? `스크립트 ${basename(opts.sourcePath)}` : undefined),
    packageName: app,
    device: dev.serial,
  });
  await ensureAgent(dev);
  const flow = opts.collectFlow === false ? undefined : await FlowCollector.open(dev, app).catch(() => undefined);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const total = script.steps.length;
  const shotAll = script.screenshots === 'all';
  // 네트워크·이벤트·크래시 assertion은 실행 시작 이후 것만 본다. 기기가 남긴 시각이라 기준도 기기 시계로 잡는다
  // (읽지 못하면 호스트 시계). 초 단위라 여유를 둔다
  const ctx = { since: (await deviceTime(dev).catch(() => Date.now())) - 2000 };

  /** seen: 흐름 수집이 방금 확인한 화면 (있으면 다시 조회하지 않는다) */
  const record = async (title: string, status: 'pass' | 'fail' | 'info' | 'skip', detail?: string, withShot = false, seen?: CurrentScreen) => {
    const png = withShot ? await screenshot(dev).catch(() => undefined) : undefined;
    const scr = seen ?? (await currentScreen(dev).catch(() => undefined));
    await scenario.step(title, status, { detail, png, screen: scr ? `${scr.packageName} ${scr.activity}` : undefined });
  };

  // setup
  try {
    if (script.setup?.clearData) await clearAppData(dev, app);
    if (script.setup?.prefs?.length) {
      // Prefs는 앱 프로세스가 떠 있어야 SDK로 쓸 수 있다
      await launchAndSettle(dev, app);
      const c = await sdkFor(dev, app);
      for (const p of script.setup.prefs) await c.setPref(p.file, p.key, p.type, p.value);
    }
    if (script.setup?.restart !== false) await launchAndSettle(dev, app, { restart: true });
    const seen = await flow?.observe();
    await record('준비: 앱 실행', 'info', script.setup ? JSON.stringify(script.setup) : undefined, shotAll, seen?.screen);
  } catch (e) {
    await record('준비 실패', 'fail', (e as Error).message, true);
    await flow?.flush().catch(() => undefined);
    const report = await scenario.finish('blocked', `준비 단계 실패: ${(e as Error).message}`);
    return { verdict: 'blocked', passed, failed: 1, skipped, durationMs: Date.now() - t0, report, scenario: scenario.data };
  }

  for (let i = 0; i < total; i++) {
    const step = script.steps[i];
    const title = describeStep(step);
    if (opts.signal?.aborted) {
      skipped += total - i;
      await record('중단됨', 'skip', `${total - i}단계 남음`);
      break;
    }
    opts.onStep?.({ index: i, total, title, status: 'running' });
    try {
      const detail = await runStep(dev, app, step, defaultTimeout, ctx, flow, opts.signal);
      const seen = (await flow?.observe())?.screen;
      if (detail === 'skip') {
        skipped++;
        await record(title, 'skip', '선택(optional) 요소가 없어 건너뜀', shotAll, seen);
        opts.onStep?.({ index: i, total, title, status: 'skip' });
        continue;
      }
      passed++;
      const isCheck = 'assert' in step || 'screenshot' in step;
      await record(title, 'pass', detail, shotAll || isCheck, seen);
      opts.onStep?.({ index: i, total, title, status: 'pass', detail });
    } catch (e) {
      // 조작 도중 실패하면 화면 상태를 알 수 없으므로 다음 관찰부터 지도에 새로 이어 붙인다
      flow?.forget();
      failed++;
      const msg = (e as Error).message;
      await record(title, 'fail', msg, true);
      opts.onStep?.({ index: i, total, title, status: 'fail', detail: msg });
      if (!script.continueOnFail) {
        skipped += total - i - 1;
        break;
      }
    }
  }

  await flow?.flush().catch(() => undefined);
  const verdict = failed ? 'fail' : 'pass';
  const summary = `${passed} 통과 · ${failed} 실패 · ${skipped} 건너뜀 (${((Date.now() - t0) / 1000).toFixed(1)}초)`;
  const report = await scenario.finish(verdict, summary);
  return { verdict, passed, failed, skipped, durationMs: Date.now() - t0, report, scenario: scenario.data };
}

async function runStep(
  dev: DeviceAdb,
  app: string,
  step: ScriptStep,
  defaultTimeout: number,
  ctx: { since: number },
  flow?: FlowCollector,
  signal?: AbortSignal,
): Promise<string> {
  if ('tap' in step || 'longPress' in step) {
    const t = 'tap' in step ? step.tap : step.longPress;
    const n = await findWithin(dev, t, t.timeout ?? defaultTimeout);
    if (!n) {
      if (t.optional) return 'skip';
      throw new StepFailure(`요소를 찾지 못했습니다 (${t.timeout ?? defaultTimeout}ms): ${selText(t)}`);
    }
    const { x, y } = center(n);
    flow?.note({ type: 'tap' in step ? 'tap' : 'longpress', x, y });
    if ('tap' in step) await tap(dev, x, y);
    else await longPress(dev, x, y);
    await settle(dev);
    return `${n.className.split('.').pop()} "${n.text || n.contentDesc}" @${Math.round(x)},${Math.round(y)}`;
  }
  if ('tapAt' in step) {
    flow?.note({ type: 'tap', ...step.tapAt });
    await tap(dev, step.tapAt.x, step.tapAt.y);
    await settle(dev);
    return '';
  }
  if ('type' in step) {
    if (step.type.into) {
      const n = await findWithin(dev, step.type.into, defaultTimeout);
      if (!n) throw new StepFailure(`입력창을 찾지 못했습니다: ${selText(step.type.into)}`);
      const { x, y } = center(n);
      flow?.note({ type: 'tap', x, y });
      await tap(dev, x, y);
      await sleep(300);
    }
    if (step.type.clear) await replaceText(dev, step.type.text);
    else await typeText(dev, step.type.text);
    return `${step.type.text.length}자 입력`;
  }
  if ('swipe' in step) {
    const s = typeof step.swipe === 'string' ? { direction: step.swipe } : step.swipe;
    if ('until' in s && s.until) {
      const max = s.max ?? 8;
      for (let i = 0; i <= max; i++) {
        const h = await dumpHierarchy(dev);
        if (findNodes(h.root, s.until).length) return `${i}번 스크롤 후 발견`;
        if (i < max) {
          await swipeDirection(dev, s.direction);
          await sleep(500);
        }
      }
      throw new StepFailure(`${max}번 스크롤해도 찾지 못했습니다: ${selText(s.until)}`);
    }
    flow?.note({ type: 'swipe', direction: s.direction });
    await swipeDirection(dev, s.direction);
    await settle(dev);
    return '';
  }
  if ('key' in step) {
    flow?.note({ type: 'key', key: step.key });
    await pressKey(dev, step.key);
    await settle(dev);
    return '';
  }
  if ('wait' in step) {
    const w = step.wait;
    const timeout = w.timeout ?? defaultTimeout;
    if (w.gone) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (!findNodes((await dumpHierarchy(dev)).root, w).length) return '사라짐';
        await sleep(300);
      }
      throw new StepFailure(`${timeout}ms 안에 사라지지 않았습니다: ${selText(w)}`);
    }
    const n = await findWithin(dev, w, timeout);
    if (!n) {
      if (w.optional) return 'skip';
      throw new StepFailure(`${timeout}ms 안에 나타나지 않았습니다: ${selText(w)}`);
    }
    return `발견: ${n.text || n.contentDesc || n.resourceId}`;
  }
  if ('sleep' in step) {
    // 스키마가 상한을 막지만 검증을 거치지 않은 단계로 오래 멈추지 않게 한 번 더 자르고, 중단하면 바로 깬다
    const ms = Math.min(Math.max(step.sleep, 0), MAX_SLEEP_MS);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
    return ms < step.sleep ? `${MAX_SLEEP_MS / 1000}초로 줄여 기다림` : '';
  }
  if ('launch' in step) {
    const s = await launchAndSettle(dev, app, { restart: step.launch?.restart });
    return s.screen.activity;
  }
  if ('deeplink' in step) {
    flow?.note({ type: 'deeplink', uri: step.deeplink });
    await openDeepLink(dev, step.deeplink, app);
    await settle(dev);
    return '';
  }
  if ('screenshot' in step) return step.screenshot ?? '';
  if ('assert' in step) return evaluateAssertion(dev, app, step.assert, ctx);
  throw new StepFailure('알 수 없는 단계');
}

/** 조작 직후 화면이 반응할 시간 (에이전트가 있으면 접근성 idle 대기) */
async function settle(dev: DeviceAdb): Promise<void> {
  const agent = await ensureAgent(dev);
  if (agent) await agent.waitIdle(250, 2500).catch(() => sleep(400));
  else await sleep(700);
}

export interface SuiteResult {
  results: { path: string; name: string; result?: RunResult; error?: string }[];
  passed: number;
  failed: number;
  durationMs: number;
}

/** 폴더(또는 파일)의 스크립트를 순서대로 실행 */
export async function runSuite(dev: DeviceAdb, path: string, opts: ScriptRunOptions & { onScript?: (path: string, i: number, total: number) => void } = {}): Promise<SuiteResult> {
  const t0 = Date.now();
  const files = await collectScripts(path);
  const results: SuiteResult['results'] = [];
  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break;
    opts.onScript?.(files[i], i, files.length);
    try {
      const script = await loadScript(files[i]);
      const result = await runScript(dev, script, { ...opts, sourcePath: files[i] });
      results.push({ path: files[i], name: script.name, result });
    } catch (e) {
      results.push({ path: files[i], name: basename(files[i]), error: (e as Error).message });
    }
  }
  return {
    results,
    passed: results.filter((r) => r.result?.verdict === 'pass').length,
    failed: results.filter((r) => r.result?.verdict !== 'pass').length,
    durationMs: Date.now() - t0,
  };
}
