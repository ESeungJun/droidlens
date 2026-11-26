import { basename } from 'node:path';
import { DeviceAdb } from '../adb.js';
import { ensureAgent } from '../agent.js';
import { clearAppData, currentScreen, deviceTime, type CurrentScreen } from '../app.js';
import { screenshot } from '../device.js';
import { FlowCollector, launchAndSettle } from '../graph.js';
import { resetFrameStats } from '../perf.js';
import { Scenario } from '../scenario.js';
import { tcName, type ScenarioAction, type ScenarioData, type ScenarioStep } from '../scenario-view.js';
import { sdkFor } from '../sdk.js';
import { waitScreenSettled, type StepOutput } from './common.js';
import { describeSetup, describeStep, stepReport } from './describe.js';
import { collectScripts, loadScript, type Script } from './schema.js';
import { runStep, type StepContext } from './steps.js';

/** 스크립트 실행 흐름: 준비(앱 실행·Prefs·목) → 단계 반복 → 정리(목 지우기) → 리포트. 단계 하나의 실행은 steps.ts */

export interface ScriptRunOptions {
  /** 진행 상황 콜백 (데스크톱 UI, CLI 출력) */
  onStep?: (e: { index: number; total: number; title: string; status: 'running' | 'pass' | 'fail' | 'skip'; detail?: string }) => void;
  signal?: AbortSignal;
  /** 리포트에 남길 원본 스크립트 경로 */
  sourcePath?: string;
  /** 지나간 화면과 연결을 앱의 화면 지도에 모은다 (기본 true, 에이전트가 있을 때만) */
  collectFlow?: boolean;
  /**
   * 누르기 직전에 그 좌표에서 실제로 반응할 요소를 찾아 확인 필수 라벨(삭제·결제·로그아웃·전송 등)이면 그 단계를 실패시킨다.
   * MCP 처럼 에이전트가 스크립트를 쓰고 돌리는 경로에서 켠다. 사람이 데스크톱·CLI 에서 돌릴 때는 끈다 (기본 false)
   */
  guardDanger?: boolean;
  /** QA 회차에서 돌리면 그 회차 id. 기록의 tc.run 에 적어 검증 기록이 회차로 묶인다 (#105) */
  qaRun?: string;
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

/** 지금 앞 화면이 대상 앱이 아니면 그 패키지 이름 (런처로 나간 경우 포함). 같거나 모르면 undefined */
export function foreignPackage(screen: CurrentScreen | undefined, app: string | undefined): string | undefined {
  if (!screen?.packageName || !app || screen.packageName === app) return undefined;
  return screen.packageName;
}

type RecordStatus = 'pass' | 'fail' | 'info' | 'skip';
type RecordExtra = { actions?: ScenarioAction[]; check?: ScenarioStep['check'] };

/** 스크립트 한 번 실행의 상태 (통과·실패 수, 리포트, 이 실행이 켠 목 규칙) */
class ScriptRun {
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private stopped = false;
  /** 단계가 직접 만든 이미지 (스크린샷 비교의 차이 이미지). 있으면 새로 찍지 않고 이것을 남긴다 */
  private readonly out: StepOutput = {};
  /** 이 실행이 켠 목 규칙. 끝나면(실패·중단 포함) 지워 다음 실행이나 수동 사용에 남지 않게 한다 */
  private readonly addedMocks: string[] = [];

  private constructor(
    private readonly dev: DeviceAdb,
    private readonly script: Script,
    private readonly opts: ScriptRunOptions,
    private readonly t0: number,
    private readonly scenario: Scenario,
    private readonly flow: FlowCollector | undefined,
    /** 네트워크·이벤트·크래시 assertion 이 볼 시작 시각 (기기 시계) */
    private readonly since: number,
  ) {}

  static async start(dev: DeviceAdb, script: Script, opts: ScriptRunOptions): Promise<ScriptRun> {
    const t0 = Date.now();
    const scenario = await Scenario.start(script.tc ? tcName(script.tc.case, script.name) : script.name, {
      goal: script.description ?? (opts.sourcePath ? `스크립트 ${basename(opts.sourcePath)}` : undefined),
      packageName: script.app,
      device: dev.serial,
      ...(script.tc ? { tc: { ...script.tc, ...(opts.qaRun ? { run: opts.qaRun } : {}) } } : {}),
    });
    await ensureAgent(dev);
    const flow = opts.collectFlow === false ? undefined : await FlowCollector.open(dev, script.app).catch(() => undefined);
    // 네트워크·이벤트·크래시 assertion은 실행 시작 이후 것만 본다. 기기가 남긴 시각이라 기준도 기기 시계로 잡는다
    // (읽지 못하면 호스트 시계). 초 단위라 여유를 둔다
    const since = (await deviceTime(dev).catch(() => Date.now())) - 2000;
    return new ScriptRun(dev, script, opts, t0, scenario, flow, since);
  }

  private get app(): string {
    return this.script.app;
  }

  /** 리포트에 단계를 남긴다. seen: 흐름 수집이 방금 확인한 화면 (있으면 다시 조회하지 않는다) */
  private async record(title: string, status: RecordStatus, detail?: string, withShot = false, seen?: CurrentScreen, extra: RecordExtra = {}): Promise<void> {
    const { dev, out } = this;
    // 통과한 검사는 요소가 나타난 직후라 화면이 아직 움직이는 중일 수 있다. 멈춘 뒤 찍는다 (실패는 실패한 그 순간을 남긴다)
    if (!out.png && withShot && status === 'pass') await waitScreenSettled(dev);
    const fresh = !out.png && withShot;
    const png = out.png ?? (fresh ? await screenshot(dev).catch(() => undefined) : undefined);
    // 새로 찍었으면 그 순간의 화면을 다시 읽는다 (seen 은 기다리기 전에 본 화면이라 다른 창이 그 뒤에 떴을 수 있다)
    const scr = (fresh ? undefined : seen) ?? (await currentScreen(dev).catch(() => undefined));
    await this.scenario.step(title, status, {
      detail,
      png,
      screen: scr ? `${scr.packageName} ${scr.activity}` : undefined,
      foreign: png ? foreignPackage(scr, this.app) : undefined,
      ...extra,
      baseline: out.baseline,
    });
    out.png = undefined;
    out.baseline = undefined;
  }

  /** 이 실행이 켠 목 규칙을 지운다. 지우지 못한 수를 돌려준다 (앱에 남아 이후 실행·수동 사용에 영향을 주므로 결과 요약에 적는다) */
  private async removeMocks(): Promise<number> {
    const { dev, app, addedMocks } = this;
    if (!addedMocks.length) return 0;
    const attempt = async () => {
      const c = await sdkFor(dev, app);
      for (const id of [...addedMocks]) {
        await c.removeMock(id);
        addedMocks.splice(addedMocks.indexOf(id), 1);
      }
    };
    // 단계에서 앱이 죽었거나 닫혔으면 SDK 에 닿지 못하니 앱을 띄워 한 번 더 시도한다
    await attempt().catch(async () => {
      await launchAndSettle(dev, app).catch(() => undefined);
      await attempt().catch(() => undefined);
    });
    if (addedMocks.length) {
      await this.record('정리: 목 규칙 지우기', 'info', `목 규칙 ${addedMocks.length}개(${addedMocks.join(', ')})를 지우지 못했습니다. 앱 안에 남아 있으니 network_mock_remove 나 데스크톱 네트워크 탭에서 지우세요`);
    }
    return addedMocks.length;
  }

  private result(verdict: RunResult['verdict'], report: string, failed = this.failed): RunResult {
    return { verdict, passed: this.passed, failed, skipped: this.skipped, durationMs: Date.now() - this.t0, report, scenario: this.scenario.data };
  }

  /** 준비 단계. 실패하면 blocked 결과를 돌려준다 (단계는 돌리지 않는다) */
  async prepare(): Promise<RunResult | undefined> {
    const { dev, app, script } = this;
    try {
      if (script.setup?.clearData) await clearAppData(dev, app);
      if (script.setup?.prefs?.length || script.setup?.mocks?.length) {
        // Prefs·목은 앱 프로세스가 떠 있어야 SDK로 쓸 수 있다. 목은 앱 안에 저장돼 아래 재시작 뒤에도 적용된다
        await launchAndSettle(dev, app);
        const c = await sdkFor(dev, app);
        for (const p of script.setup.prefs ?? []) await c.setPref(p.file, p.key, p.type, p.value);
        for (const m of script.setup.mocks ?? []) {
          const saved = await c.setMock(m);
          if (saved.id) this.addedMocks.push(saved.id);
        }
      }
      if (script.setup?.restart !== false) await launchAndSettle(dev, app, { restart: true });
      // 버벅인 프레임 비율 assert 가 준비 단계를 빼고 스크립트 단계만 보게 한다
      await resetFrameStats(dev, app).catch(() => undefined);
      const seen = await this.flow?.observe();
      await this.record('준비: 앱 실행', 'info', describeSetup(script.setup), script.screenshots === 'all', seen?.screen);
      return undefined;
    } catch (e) {
      await this.record('준비 실패', 'fail', (e as Error).message, true);
      const left = await this.removeMocks();
      await this.flow?.flush().catch(() => undefined);
      const report = await this.scenario.finish('blocked', `준비 단계 실패: ${(e as Error).message}${leftover(left)}`);
      return this.result('blocked', report, 1);
    }
  }

  /** 단계를 차례로 돌린다. 중단 신호나 (continueOnFail 이 아니면) 첫 실패에서 멈춘다 */
  async runSteps(): Promise<void> {
    const total = this.script.steps.length;
    for (let i = 0; i < total; i++) {
      if (this.opts.signal?.aborted) return this.stop(total - i);
      if (!(await this.runOne(i, total))) return;
    }
  }

  /** 중단 신호로 멈춘다. 끝까지 돌지 않았으니 통과로 치지 않는다 */
  private async stop(left: number): Promise<void> {
    this.stopped = true;
    this.skipped += left;
    await this.record('중단됨', 'skip', `${left}단계 남음`);
  }

  /** 단계 하나를 돌리고 리포트에 남긴다. 다음 단계로 갈지 돌려준다 */
  private async runOne(i: number, total: number): Promise<boolean> {
    const { dev, app, script, opts, flow } = this;
    const step = script.steps[i];
    const title = describeStep(step);
    const shotAll = script.screenshots === 'all';
    opts.onStep?.({ index: i, total, title, status: 'running' });
    const report = stepReport(step, title);
    const ctx: StepContext = {
      dev,
      app,
      defaultTimeout: script.timeout ?? 5000,
      since: this.since,
      flow,
      signal: opts.signal,
      out: this.out,
      guardDanger: opts.guardDanger ?? false,
    };
    try {
      const detail = await runStep(step, ctx);
      const seen = (await flow?.observe())?.screen;
      if (detail === 'skip') {
        this.skipped++;
        await this.record(report.title, 'skip', '선택(optional) 요소가 없어 건너뜀', shotAll, seen, report.extra());
        opts.onStep?.({ index: i, total, title, status: 'skip' });
        return true;
      }
      this.passed++;
      await this.record(report.title, 'pass', detail, shotAll || report.shot, seen, report.extra(detail || undefined));
      opts.onStep?.({ index: i, total, title, status: 'pass', detail });
      return true;
    } catch (e) {
      // 단계 도중 중단 신호로 끊긴 것은 앱의 실패가 아니다
      if (opts.signal?.aborted) {
        opts.onStep?.({ index: i, total, title, status: 'skip' });
        await this.stop(total - i);
        return false;
      }
      // 조작 도중 실패하면 화면 상태를 알 수 없으므로 다음 관찰부터 지도에 새로 이어 붙인다
      flow?.forget();
      this.failed++;
      const msg = (e as Error).message;
      await this.record(report.title, 'fail', msg, true, undefined, report.extra(/실제:\s*(.+)$/m.exec(msg)?.[1] ?? msg.split('\n')[0]));
      opts.onStep?.({ index: i, total, title, status: 'fail', detail: msg });
      if (script.continueOnFail) return true;
      this.skipped += total - i - 1;
      return false;
    }
  }

  /** 목을 지우고 지도를 쓴 뒤 리포트를 닫는다 */
  async finish(): Promise<RunResult> {
    const left = await this.removeMocks();
    await this.flow?.flush().catch(() => undefined);
    const verdict = this.failed ? 'fail' : this.stopped ? 'blocked' : 'pass';
    const summary = `${this.stopped ? '중단됨 · ' : ''}${this.passed} 통과 · ${this.failed} 실패 · ${this.skipped} 건너뜀 (${((Date.now() - this.t0) / 1000).toFixed(1)}초)${leftover(left)}`;
    const report = await this.scenario.finish(verdict, summary);
    return this.result(verdict, report);
  }
}

const leftover = (n: number) => (n ? ` · 목 규칙 ${n}개를 지우지 못했습니다` : '');

/** 스크립트를 기기에서 실행하고 시나리오 리포트를 만든다 */
export async function runScript(dev: DeviceAdb, script: Script, opts: ScriptRunOptions = {}): Promise<RunResult> {
  const run = await ScriptRun.start(dev, script, opts);
  const blocked = await run.prepare();
  if (blocked) return blocked;
  await run.runSteps();
  return run.finish();
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
