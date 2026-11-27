import { isPaymentSnapshot, KNOWN_PAYMENT_PACKAGES } from '../qa/payment.js';
/**
 * TC 실행 경로 TcPath (#131): QA TC 를 돌리는 에이전트가 tap 으로 지난 화면 이동을 앱 지도에 연결로 남기고,
 * TC 가 끝나면 지난 연결에 그 TC 와 판정을 붙인다. MCP 의 tap·scenario_step·scenario_finish 가 쓴다.
 *
 * 탭 직후에 화면을 기다리지 않는다 (회차를 늦추지 않게). 탭할 때 적어 두고, 그 뒤 화면을 볼 때마다(대기 성공·단계 기록·다음 탭 직전)
 * 도착 화면 후보를 마지막으로 본 화면으로 바꾼다. 다음 행동을 적을 때나 TC 가 끝날 때 그 후보로 잇는다 (#147).
 * 탭 직후 아직 전환 중인 화면(같은 Activity 의 눌린 상태 등)을 봤어도, 더 나중에 본 화면이 도착 화면이 된다.
 * 사이에 화면을 바꾸는 다른 조작이 있었으면(조작 번호가 다르면) 도착 화면이 그 탭의 결과인지 몰라 잇지 않는다.
 * 대기·검사처럼 화면을 바꾸지 않는 조작은 조작 번호를 올리지 않는다 (stepKeepsScreen, MCP common.ts).
 */
import type { DeviceAdb } from '../adb.js';
import type { EdgeTc, ScreenNode } from '../graph-model.js';
import { pressAction } from './navigate.js';
import { captureSnapshot, targetAt, type Snapshot } from './snapshot.js';
import type { ScreenGraph } from './store.js';

/** 적어 두는 행동. 좌표는 직전 화면의 요소로 바꿔 기록한다 */
export type TcPathAction = { type: 'tap' | 'longpress'; x: number; y: number } | { type: 'key'; key: string };

interface Seen {
  snap: Snapshot;
  id: string;
}

export class TcPath {
  /** 다음 행동의 출발 화면 */
  private from?: Seen;
  /** 적어 둔 행동과 그 조작 번호 */
  private pending?: { action: TcPathAction; mark: number; from: Seen };
  /** 적어 둔 행동 뒤 마지막으로 본 화면 (도착 화면 후보) */
  private arrival?: Seen;
  /** 이 TC 가 지난 연결 id */
  readonly edges = new Set<string>();

  constructor(readonly graph: ScreenGraph, private readonly dev?: DeviceAdb) {}

  /**
   * 지금 화면을 지도에 올린다. 적어 둔 행동이 있고 그 뒤 화면을 바꾸는 다른 조작이 없었으면(mark 가 같으면) 도착 화면 후보로 둔다.
   * 다른 앱 화면이면 지도에 올리지 않고 undefined (그 앞의 행동도 잇지 않는다)
   */
  async see(s: Snapshot | undefined, mark: number): Promise<ScreenNode | undefined> {
    // 다른 앱 화면, 앞 창이 결제 창인 화면(#155)은 지도에 올리지 않는다
    const pay = s && isPaymentSnapshot(s, (await this.dev?.paymentPackages?.().catch(() => undefined)) ?? KNOWN_PAYMENT_PACKAGES);
    if (!s || s.screen.packageName !== this.graph.packageName || pay) {
      this.forget();
      return undefined;
    }
    const node = await this.graph.addSnapshot(s, this.dev);
    const seen = { snap: s, id: node.id };
    if (this.pending && this.pending.mark === mark) this.arrival = seen;
    else {
      // 적어 둔 행동 뒤에 다른 조작이 있었다: 그때까지 본 도착 화면으로 잇고, 이 화면은 새 출발점
      this.settle();
      this.pending = undefined;
      this.from = seen;
    }
    this.graph.saveSoon();
    return node;
  }

  /** 기기의 지금 화면을 읽어 see 한다 (기기 없이 만든 경로면 아무것도 하지 않는다). 읽기에 실패하면 다음부터 새로 시작한다 */
  async look(mark: number): Promise<ScreenNode | undefined> {
    if (!this.dev) return undefined;
    const s = await captureSnapshot(this.dev, { screenshot: false }).catch(() => undefined);
    return this.see(s, mark);
  }

  /** 방금 한 행동을 적어 둔다. mark 는 그 행동을 기록한 조작 번호. 앞 행동은 그 사이 마지막으로 본 화면으로 잇는다 */
  note(action: TcPathAction, mark: number): void {
    this.settle();
    // 앞 행동 뒤로 화면을 한 번도 못 봤으면 지금 출발 화면을 모른다
    if (this.pending) this.from = undefined;
    this.pending = this.from ? { action, mark, from: this.from } : undefined;
  }

  /** 지금 화면을 모르게 됐을 때 (조작 실패·다른 앱 등): 잇지 않고 다음 see 부터 새로 시작한다 */
  forget(): void {
    this.pending = undefined;
    this.arrival = undefined;
    this.from = undefined;
  }

  /** TC 가 끝나면 마지막 행동을 잇고, 지난 연결에 TC 와 판정을 붙이고 파일에 쓴다 */
  async finish(tc: { plan: string; case: string } | undefined, verdict: EdgeTc['verdict'] | undefined): Promise<void> {
    this.settle();
    this.pending = undefined;
    if (tc && verdict && this.edges.size) this.graph.tagEdges(this.edges, tc, verdict);
    await this.graph.save();
  }

  /** 적어 둔 행동을 도착 화면 후보로 잇고, 그 화면을 다음 출발점으로 둔다. 같은 화면에 머물렀으면 잇지 않는다 */
  private settle(): void {
    const p = this.pending;
    const to = this.arrival;
    if (!p || !to) return;
    this.pending = undefined;
    this.arrival = undefined;
    this.from = to;
    if (p.from.id === to.id) return;
    const e = this.graph.addEdge(p.from.id, to.id, this.toAction(p.action, p.from.snap, p.from.id));
    this.edges.add(e.id);
    this.graph.saveSoon();
  }

  private toAction(a: TcPathAction, before: Snapshot, from: string) {
    if (a.type === 'key') return a;
    const c = targetAt(before, this.graph.packageName, a.x, a.y);
    if (!c) return { type: a.type, x: a.x, y: a.y };
    this.graph.markTried(from, c.key);
    return { ...pressAction(a.type, c), x: a.x, y: a.y };
  }
}
