import { DeviceAdb, sleep } from '../adb.js';
import { checkedAgent, ensureAgent } from '../agent.js';
import { dumpHierarchy, findNodes, type Selector, type ViewNode } from '../hierarchy.js';

/** 단계 실행기·검사기·실행 흐름이 함께 쓰는 것: 단계 실패, 단계가 남기는 이미지, 요소 기다리기, 조작 뒤 대기 */

/** 단계가 기대대로 되지 않았다 (리포트에 fail 로 남는다). 그 밖의 예외도 fail 로 남지만 이것은 '판정'이다 */
export class StepFailure extends Error {}

/** 단계가 직접 만든 이미지 (스크린샷 비교의 차이 이미지). 있으면 기록할 때 새로 찍지 않고 이것을 남긴다 */
export interface StepOutput {
  png?: Buffer;
  baseline?: { app: string; name: string; actualPng: Buffer };
}

/** 셀렉터에 맞는 첫 요소를 timeoutMs 동안 0.3초마다 찾는다. 없으면 undefined */
export async function findWithin(dev: DeviceAdb, sel: Selector, timeoutMs: number): Promise<ViewNode | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await dumpHierarchy(dev).catch(() => undefined);
    const [n] = h ? findNodes(h.root, sel) : [];
    if (n) return n;
    if (Date.now() >= deadline) return undefined;
    await sleep(300);
  }
}

/**
 * 조작 직후 화면이 반응할 시간 (에이전트가 있으면 접근성 idle 대기, 없으면 0.7초).
 * install: false 면 에이전트를 새로 설치·실행하지 않고 이미 떠 있는 것만 쓴다 (waitScreenSettled)
 */
export async function settle(dev: DeviceAdb, opts: { install?: boolean } = {}): Promise<void> {
  const agent = opts.install === false ? await checkedAgent(dev).catch(() => undefined) : await ensureAgent(dev);
  if (agent) await agent.waitIdle(250, 2500).catch(() => sleep(400));
  else await sleep(700);
}

/**
 * 스크린샷 직전에 화면이 멈출 때까지 기다린다. settle 과 달리 에이전트를 새로 설치·실행하지 않는다
 * (설치하면 Play 프로텍트 창이 떠서 그 창이 스크린샷에 찍힌다)
 */
export async function waitScreenSettled(dev: DeviceAdb): Promise<void> {
  return settle(dev, { install: false });
}
