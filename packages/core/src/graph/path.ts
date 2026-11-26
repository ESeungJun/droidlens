/**
 * TC 실행 경로 TcPath (#131): QA TC 를 돌리는 에이전트가 tap 으로 지난 화면 이동을 앱 지도에 연결로 남기고,
 * TC 가 끝나면 지난 연결에 그 TC 와 판정을 붙인다. MCP 의 tap·scenario_step·scenario_finish 가 쓴다.
 *
 * 탭 직후에 화면을 기다리지 않는다 (회차를 늦추지 않게). 탭할 때 적어 두고, 다음에 화면을 볼 때(다음 탭·단계 기록)
 * 그 화면을 도착 화면으로 잇는다. 그 사이 다른 조작이 있었으면(조작 번호가 다르면) 도착 화면이 그 탭의 결과인지 몰라 잇지 않는다.
 */
import type { DeviceAdb } from '../adb.js';
import type { EdgeTc, ScreenNode } from '../graph-model.js';
import { pressAction } from './navigate.js';
import { captureSnapshot, screenId, targetAt, type Snapshot } from './snapshot.js';
import type { ScreenGraph } from './store.js';

/** 적어 두는 행동. 좌표는 직전 화면의 요소로 바꿔 기록한다 */
export type TcPathAction = { type: 'tap' | 'longpress'; x: number; y: number } | { type: 'key'; key: string };

export class TcPath {
  private last?: Snapshot;
  private pending?: { action: TcPathAction; mark: number };
  /** 이 TC 가 지난 연결 id */
  readonly edges = new Set<string>();

  constructor(readonly graph: ScreenGraph, private readonly dev?: DeviceAdb) {}

  /**
   * 지금 화면을 지도에 올린다. 적어 둔 행동이 있고 그 뒤 다른 조작이 없었으면(mark 가 같으면) 직전 화면에서 이 화면으로 잇는다.
   * 다른 앱 화면이면 지도에 올리지 않고 undefined
   */
  async see(s: Snapshot | undefined, mark: number): Promise<ScreenNode | undefined> {
    const noted = this.pending;
    this.pending = undefined;
    if (!s || s.screen.packageName !== this.graph.packageName) {
      this.last = undefined;
      return undefined;
    }
    const node = await this.graph.addSnapshot(s, this.dev);
    const prev = this.last && screenId(this.last);
    if (noted && noted.mark === mark && this.last && prev && prev !== node.id) {
      const e = this.graph.addEdge(prev, node.id, this.toAction(noted.action, this.last, prev));
      this.edges.add(e.id);
    }
    this.last = s;
    this.graph.saveSoon();
    return node;
  }

  /** 기기의 지금 화면을 읽어 see 한다 (기기 없이 만든 경로면 아무것도 하지 않는다). 읽기에 실패하면 다음부터 새로 시작한다 */
  async look(mark: number): Promise<ScreenNode | undefined> {
    if (!this.dev) return undefined;
    const s = await captureSnapshot(this.dev, { screenshot: false }).catch(() => undefined);
    if (!s) this.forget();
    return this.see(s, mark);
  }

  /** 방금 한 행동을 적어 둔다. mark 는 그 행동을 기록한 조작 번호 */
  note(action: TcPathAction, mark: number): void {
    this.pending = { action, mark };
  }

  /** 지금 화면을 모르게 됐을 때 (조작 실패 등): 다음 see 부터 새로 시작한다 */
  forget(): void {
    this.pending = undefined;
    this.last = undefined;
  }

  /** TC 가 끝나면 지난 연결에 TC 와 판정을 붙이고 파일에 쓴다 */
  async finish(tc: { plan: string; case: string } | undefined, verdict: EdgeTc['verdict'] | undefined): Promise<void> {
    this.pending = undefined;
    if (tc && verdict && this.edges.size) this.graph.tagEdges(this.edges, tc, verdict);
    await this.graph.save();
  }

  private toAction(a: TcPathAction, before: Snapshot, from: string) {
    if (a.type === 'key') return a;
    const c = targetAt(before, this.graph.packageName, a.x, a.y);
    if (!c) return { type: a.type, x: a.x, y: a.y };
    this.graph.markTried(from, c.key);
    return { ...pressAction(a.type, c), x: a.x, y: a.y };
  }
}
