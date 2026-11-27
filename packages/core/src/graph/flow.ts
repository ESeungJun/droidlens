import { isPaymentSnapshot, KNOWN_PAYMENT_PACKAGES } from '../qa/payment.js';
/**
 * 흐름 수집 FlowCollector: 시나리오·스크립트 실행처럼 다른 기능이 기기를 조작하는 동안 지나간 화면과 연결을 앱 지도에 모은다.
 * script.ts 의 runScript 가 쓴다. 에이전트가 없으면 만들지 않는다 (화면 확인이 느려 원래 작업을 늦추므로).
 */
import type { DeviceAdb } from '../adb.js';
import { ensureAgent } from '../agent.js';
import { screenSize, swipeVector, type SwipeDirection } from '../device.js';
import type { GraphAction } from '../graph-model.js';
import { pressAction } from './navigate.js';
import { captureSnapshot, screenId, targetAt, type Snapshot } from './snapshot.js';
import { ScreenGraph } from './store.js';

/** 수집기에 알려 주는 방금 한 행동. 누른 좌표는 직전 화면의 요소로 바꿔 기록한다 */
export type NotedAction =
  | { type: 'tap' | 'longpress'; x: number; y: number }
  | { type: 'swipe'; direction: SwipeDirection }
  | { type: 'key'; key: string }
  | { type: 'deeplink'; uri: string };

/**
 * 다른 기능(시나리오 실행 등)이 기기를 조작하는 동안 지나간 화면과 연결을 앱 지도에 모은다.
 * 조작 전에 note() 로 행동을 알리고 조작 뒤 observe() 를 부르면, 직전에 본 화면에서 그 행동으로 왔다고 연결한다.
 * 조작이 실패하면 forget() 으로 이어 붙이지 않게 한다.
 * 에이전트가 없으면 화면 확인(uiautomator dump)이 1~2초씩 걸려 원래 작업을 늦추므로 모으지 않는다.
 * 실패해도 원래 작업에 영향을 주지 않게 오류는 삼킨다.
 */
export class FlowCollector {
  private last?: Snapshot;
  private pending?: NotedAction;

  private constructor(private readonly dev: DeviceAdb, readonly graph: ScreenGraph) {}

  static async open(dev: DeviceAdb, pkg: string): Promise<FlowCollector | undefined> {
    if (!(await ensureAgent(dev).catch(() => undefined))) return undefined;
    return new FlowCollector(dev, await ScreenGraph.open(pkg));
  }

  note(a: NotedAction): void {
    this.pending = a;
  }

  /** 조작이 실패해 화면 상태를 알 수 없을 때: 다음 관찰부터 새로 시작한다 */
  forget(): void {
    this.pending = undefined;
    this.last = undefined;
  }

  /** 지금 화면을 지도에 모은다. 확인한 스냅샷을 돌려줘 호출부가 같은 조회를 다시 하지 않게 한다 (실패하면 undefined) */
  async observe(): Promise<Snapshot | undefined> {
    const noted = this.pending;
    this.pending = undefined;
    try {
      const s = await captureSnapshot(this.dev, { screenshot: false });
      if (s.screen.packageName !== this.graph.packageName || isPaymentSnapshot(s, (await this.dev.paymentPackages?.().catch(() => undefined)) ?? KNOWN_PAYMENT_PACKAGES)) {
        this.last = undefined;
        return s;
      }
      const node = await this.graph.addSnapshot(s, this.dev);
      const prev = this.last && screenId(this.last);
      if (noted && this.last && prev !== node.id) {
        const action = await this.toAction(noted, this.last, prev!);
        if (action) this.graph.addEdge(prev!, node.id, action);
      }
      this.last = s;
      this.graph.saveSoon();
      return s;
    } catch {
      this.last = undefined;
      return undefined;
    }
  }

  /** 모아 둔 기록을 파일에 마저 쓴다 (수집을 끝낼 때 부른다) */
  flush(): Promise<void> {
    return this.graph.flush();
  }

  private async toAction(a: NotedAction, before: Snapshot, from: string): Promise<GraphAction | undefined> {
    if (a.type === 'tap' || a.type === 'longpress') {
      const c = targetAt(before, this.graph.packageName, a.x, a.y);
      if (!c) return { type: a.type, x: a.x, y: a.y };
      this.graph.markTried(from, c.key);
      return { ...pressAction(a.type, c), x: a.x, y: a.y };
    }
    if (a.type === 'swipe') {
      const [x1, y1, x2, y2] = swipeVector(await screenSize(this.dev), a.direction);
      return { type: 'swipe', x1, y1, x2, y2, direction: a.direction };
    }
    return a;
  }
}
