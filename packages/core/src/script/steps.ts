import { DeviceAdb, sleep } from '../adb.js';
import { openDeepLink } from '../app.js';
import { longPress, pressKey, replaceText, swipeDirection, tap, typeText } from '../device.js';
import { launchAndSettle, type FlowCollector } from '../graph.js';
import { center, dumpHierarchy, findNodes, riskyTapLabel, riskyTapMessage, type ViewNode } from '../hierarchy.js';
import { measureStartup, resetFrameStats } from '../perf.js';
import { DEFAULT_MAX_DIFF_PERCENT, matchScreenshot } from '../visual.js';
import { evaluateAssertion } from './assert.js';
import { findWithin, settle, StepFailure, type StepOutput } from './common.js';
import { selText } from './describe.js';
import { MAX_SLEEP_MS, type ScriptStep } from './schema.js';

/**
 * 단계 실행기. 단계 종류(tap·swipe·assert 등)마다 실행기 하나를 두고, runStep 은 단계에 맞는 것을 골라 부르기만 한다.
 * 새 단계를 더하려면 schema.ts 의 stepUnion 에 형식을, 여기 RUNNERS 에 실행기를 더한다 (설명이 기본 문구와 다르면 describe.ts 도).
 */

/** 실행기가 받는 실행 상태 */
export interface StepContext {
  dev: DeviceAdb;
  app: string;
  /** 요소를 기다리는 기본 시간 (스크립트 timeout, 기본 5초) */
  defaultTimeout: number;
  /** 실행 시작 시각 (기기 시계). assert 의 네트워크·이벤트·크래시 기준 */
  since: number;
  flow?: FlowCollector;
  signal?: AbortSignal;
  /** 단계가 만든 이미지를 기록 쪽에 넘기는 칸 */
  out: StepOutput;
  /** 누르기 직전에 위험 버튼이면 실패시킨다 (ScriptRunOptions.guardDanger) */
  guardDanger: boolean;
}

/** 단계 종류 이름 (tap · longPress · … · assert) */
type StepKind = ScriptStep extends infer S ? (S extends unknown ? keyof S : never) : never;
/** 그 종류 단계의 값. launch·startup·screenshot 처럼 값을 비워 둘 수 있는 단계는 undefined·null 도 온다 */
type StepArg<K extends StepKind> = ScriptStep extends infer S ? (S extends unknown ? (K extends keyof S ? S[K] : never) : never) : never;
/** 통과하면 리포트 근거(빈 문자열 가능), optional 요소가 없어 건너뛰면 'skip'. 실패하면 StepFailure */
type Runner<K extends StepKind> = (arg: StepArg<K>, c: StepContext) => Promise<string>;

/**
 * 누를 좌표에서 실제로 반응할 요소(와 셀렉터로 찾은 요소)의 라벨을 보고 위험하면 단계를 실패시킨다.
 * MCP tap 도구와 같은 검사다. 검사가 '어떤 경로로 눌렀나'가 아니라 '무엇이 눌리나'를 따라가게 한다
 */
async function refuseRiskyTap(dev: DeviceAdb, x: number, y: number, node?: ViewNode): Promise<void> {
  const risky = riskyTapLabel((await dumpHierarchy(dev)).root, x, y, node);
  if (risky) throw new StepFailure(riskyTapMessage(risky, '실행'));
}

/** tap · longPress: 요소를 기다렸다가 가운데를 누른다 (둘은 값 형식이 같다) */
const press =
  (kind: 'tap' | 'longPress') =>
  async (t: StepArg<'tap'> & StepArg<'longPress'>, { dev, defaultTimeout, flow, guardDanger }: StepContext): Promise<string> => {
    const n = await findWithin(dev, t, t.timeout ?? defaultTimeout);
    if (!n) {
      if (t.optional) return 'skip';
      throw new StepFailure(`요소를 찾지 못했습니다 (${t.timeout ?? defaultTimeout}ms): ${selText(t)}`);
    }
    const { x, y } = center(n);
    if (guardDanger) await refuseRiskyTap(dev, x, y, n);
    flow?.note({ type: kind === 'tap' ? 'tap' : 'longpress', x, y });
    if (kind === 'tap') await tap(dev, x, y);
    else await longPress(dev, x, y);
    await settle(dev);
    return `${n.className.split('.').pop()} "${n.text || n.contentDesc}" @${Math.round(x)},${Math.round(y)}`;
  };

const tapAt: Runner<'tapAt'> = async (p, { dev, flow, guardDanger }) => {
  if (guardDanger) await refuseRiskyTap(dev, p.x, p.y);
  flow?.note({ type: 'tap', ...p });
  await tap(dev, p.x, p.y);
  await settle(dev);
  return '';
};

const type: Runner<'type'> = async (t, { dev, defaultTimeout, flow }) => {
  if (t.into) {
    const n = await findWithin(dev, t.into, defaultTimeout);
    if (!n) throw new StepFailure(`입력창을 찾지 못했습니다: ${selText(t.into)}`);
    const { x, y } = center(n);
    flow?.note({ type: 'tap', x, y });
    await tap(dev, x, y);
    await sleep(300);
  }
  if (t.clear) await replaceText(dev, t.text);
  else await typeText(dev, t.text);
  return `${t.text.length}자 입력`;
};

const swipe: Runner<'swipe'> = async (arg, { dev, flow }) => {
  const s = typeof arg === 'string' ? { direction: arg } : arg;
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
};

const key: Runner<'key'> = async (k, { dev, flow }) => {
  flow?.note({ type: 'key', key: k });
  await pressKey(dev, k);
  await settle(dev);
  return '';
};

const wait: Runner<'wait'> = async (w, { dev, defaultTimeout }) => {
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
};

const sleepStep: Runner<'sleep'> = async (wanted, { signal }) => {
  // 스키마가 상한을 막지만 검증을 거치지 않은 단계로 오래 멈추지 않게 한 번 더 자르고, 중단하면 바로 깬다
  const ms = Math.min(Math.max(wanted, 0), MAX_SLEEP_MS);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
  return ms < wanted ? `${MAX_SLEEP_MS / 1000}초로 줄여 기다림` : '';
};

const launch: Runner<'launch'> = async (o, { dev, app }) => {
  const s = await launchAndSettle(dev, app, { restart: o?.restart });
  return s.screen.activity;
};

const deeplink: Runner<'deeplink'> = async (uri, { dev, app, flow }) => {
  flow?.note({ type: 'deeplink', uri });
  await openDeepLink(dev, uri, app);
  await settle(dev);
  return '';
};

/** 스크린샷은 기록 쪽이 찍는다. 여기서는 이름만 근거로 돌려준다 */
const screenshotStep: Runner<'screenshot'> = async (name) => name ?? '';

const matchScreenshotStep: Runner<'matchScreenshot'> = async (arg, { dev, app, out }) => {
  const o = typeof arg === 'string' ? { name: arg } : arg;
  const r = await matchScreenshot(dev, app, o.name, { ignore: o.ignore, tolerance: o.tolerance });
  if (r.saved) {
    out.png = r.actual;
    return `기준 이미지가 없어 지금 화면을 기준으로 저장했습니다 (${r.baseline})`;
  }
  const d = r.diff!;
  const max = o.maxDiffPercent ?? DEFAULT_MAX_DIFF_PERCENT;
  const detail = `다른 픽셀 ${d.diffPercent}% (${d.diffPixels}/${d.comparedPixels}, 허용 ${max}%)${d.diffBounds ? ` · 영역 [${d.diffBounds.join(',')}]` : ''}`;
  out.png = d.diffPng;
  if (d.diffPercent > max) {
    // 바뀐 화면이 맞으면 리포트에서 지금 화면을 새 기준으로 받아들일 수 있게 남긴다
    out.baseline = { app, name: o.name, actualPng: r.actual };
    throw new StepFailure(`기준 이미지와 다릅니다: ${detail}`);
  }
  return detail;
};

const startup: Runner<'startup'> = async (arg, { dev, app, flow, signal }) => {
  const o = arg ?? {};
  // 측정하며 앱을 여러 번 다시 시작하므로 흐름 수집은 다음 관찰부터 새로 잇는다
  flow?.forget();
  const r = await measureStartup(dev, app, { cold: o.cold, runs: o.runs, signal });
  const detail = `${r.cold ? '콜드' : '다시 열기'} 시작 중앙값 ${r.medianMs}ms (${r.runs.map((x) => x.ms).join(', ')})`;
  if (o.maxMs !== undefined && r.medianMs > o.maxMs) throw new StepFailure(`기대: ${o.maxMs}ms 이하 / 실제: ${detail}`);
  // 다시 열기 측정은 프로세스가 그대로라 측정 중 그린 프레임이 이후 버벅임 assert 에 섞이지 않게 한다
  await resetFrameStats(dev, app).catch(() => undefined);
  return detail;
};

const assertStep: Runner<'assert'> = (a, { dev, app, since }) => evaluateAssertion(dev, app, a, { since });

/**
 * 단계 종류 → 실행기. 적힌 순서가 고르는 순서다 (검증을 거치지 않은 단계 객체에 키가 여럿이어도 예전처럼 앞의 것을 고른다).
 * 바꾸지 않는다
 */
const RUNNERS: { [K in StepKind]: Runner<K> } = {
  tap: press('tap'),
  longPress: press('longPress'),
  tapAt,
  type,
  swipe,
  key,
  wait,
  sleep: sleepStep,
  launch,
  deeplink,
  screenshot: screenshotStep,
  matchScreenshot: matchScreenshotStep,
  startup,
  assert: assertStep,
};
const ORDER = Object.keys(RUNNERS) as StepKind[];

/** 단계 하나를 실행한다. 통과하면 근거, optional 요소가 없으면 'skip' */
export async function runStep(step: ScriptStep, c: StepContext): Promise<string> {
  const kind = ORDER.find((k) => k in step);
  if (!kind) throw new StepFailure('알 수 없는 단계');
  const run = RUNNERS[kind] as Runner<StepKind>;
  return run((step as Record<StepKind, never>)[kind], c);
}
