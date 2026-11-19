import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { KEYCODES } from '../device.js';
import { MAX_STARTUP_RUNS } from '../perf.js';
import { ensureDir, safeName } from '../workspace.js';

/**
 * 시나리오 스크립트 형식(YAML 스키마)과 읽기·쓰기. 형식이 바뀌면 이 파일만 고친다.
 * 단계 실행은 steps.ts, 검사는 assert.ts, 실행 흐름은 run.ts 에 있다.
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
    /** 지금 메모리(PSS)와 스크립트 시작 이후 버벅인 프레임 비율의 상한 */
    perf: z
      .object({ maxMemoryMb: z.number().positive().optional(), maxJankPercent: z.number().min(0).max(100).optional() })
      .strict()
      .refine((p) => p.maxMemoryMb !== undefined || p.maxJankPercent !== undefined, 'maxMemoryMb 나 maxJankPercent 가 필요합니다')
      .optional(),
    noCrash: z.boolean().optional(),
    timeout: z.number().int().optional(),
  })
  .strict();

/** sleep 단계의 상한. 잘못 적은 값(예: 600000)은 스크립트를 저장·검증할 때 바로 오류로 알린다 */
export const MAX_SLEEP_MS = 60_000;

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
  /** 화면을 기준 이미지와 비교. 다른 픽셀 비율이 maxDiffPercent(기본 0.5)를 넘으면 실패 */
  z
    .object({
      matchScreenshot: z.union([
        z.string().min(1),
        z
          .object({
            name: z.string().min(1),
            maxDiffPercent: z.number().min(0).max(100).optional(),
            ignore: z.array(selector).optional(),
            tolerance: z.number().int().min(0).max(255).optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  /** 앱 시작 시간을 재고 중앙값이 maxMs 를 넘으면 실패. 앱이 다시 시작된다 */
  z
    .object({
      startup: z
        .object({ cold: z.boolean().optional(), runs: z.number().int().min(1).max(MAX_STARTUP_RUNS).optional(), maxMs: z.number().int().positive().optional() })
        .strict()
        .optional()
        .nullable(),
    })
    .strict(),
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
        /** 실행하는 동안만 켜 둘 네트워크 목 규칙 (SDK). 끝나면 지운다 */
        mocks: z
          .array(
            z
              .object({
                url: z.string().min(1),
                method: z.string().optional(),
                status: z.number().int().min(200).max(599).optional(),
                // 아래 상한·형식은 SDK(MockStore)와 같다
                body: z.string().max(256 * 1024, '본문은 262144자까지입니다').optional(),
                contentType: z
                  .string()
                  .regex(/^[\w.+-]+\/[\w.+-]+\s*(;[\t\x20-\x7e]*)?$/, '형식이 아닙니다 (예: application/json; charset=utf-8)')
                  .optional(),
                headers: z
                  .record(z.string().regex(/^[\t\x20-\x7e]*$/, 'ASCII 로만 쓸 수 있습니다 (한글·줄바꿈 불가)'))
                  .refine((h) => Object.keys(h).length <= 50, '헤더는 50개까지입니다')
                  .refine((h) => Object.keys(h).every((k) => /^[\x21-\x7e]+$/.test(k)), '헤더 이름은 공백 없는 ASCII 로만 씁니다')
                  .optional(),
                delayMs: z.number().int().min(0).max(60_000).optional(),
                fail: z.boolean().optional(),
              })
              .strict()
              // SDK 가 저장할 때 거절하는 조합을 스크립트를 읽을 때 미리 알린다
              .refine((m) => m.status !== undefined || m.fail || m.delayMs, { message: 'status, fail, delayMs 중 하나는 필요합니다' })
              .refine((m) => !(m.fail && m.status !== undefined), { message: 'fail 과 status 는 함께 쓸 수 없습니다' }),
          )
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
