import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DeviceAdb, sleep } from './adb.js';
import { droidlensHome } from './workspace.js';

/**
 * 온디바이스 에이전트(android/agent) 연동.
 * 기기에서 상주하는 Instrumentation이 UiAutomation 연결을 유지하므로
 * 뷰 계층을 uiautomator dump(1.5~3초) 대신 0.1~0.3초에 받고, 한글 등 유니코드 입력도 가능하다.
 * 설치/실행에 실패하면 호출부는 uiautomator로 대체한다.
 */

export const AGENT_PACKAGE = 'io.github.eseungjun.droidlens.agent';
export const AGENT_VERSION = 2;
const AGENT_PORT = 7912;
const INSTRUMENT = `${AGENT_PACKAGE}/.AgentInstrumentation`;

/**
 * APK 위치: DROIDLENS_AGENT_APK > 실행 스크립트 옆(앱 번들의 Resources/agent, 단독 MCP와 같은 폴더)
 * > ~/.droidlens/agent/droidlens-agent.apk (데스크톱 앱이 시작할 때 복사)
 */
export function agentApkPath(): string | undefined {
  const scriptDir = process.argv[1] ? dirname(process.argv[1]) : undefined;
  const candidates = [
    process.env.DROIDLENS_AGENT_APK,
    scriptDir && join(scriptDir, 'droidlens-agent.apk'),
    scriptDir && join(scriptDir, '..', 'agent', 'droidlens-agent.apk'),
    join(droidlensHome(), 'agent', 'droidlens-agent.apk'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

export function agentDisabled(): boolean {
  return process.env.DROIDLENS_AGENT === '0';
}

export class AgentClient {
  constructor(readonly serial: string, readonly port: number) {}

  private url(path: string, q?: Record<string, string>): string {
    const qs = q ? '?' + new URLSearchParams(q).toString() : '';
    return `http://127.0.0.1:${this.port}${path}${qs}`;
  }

  private async req(method: 'GET' | 'POST', path: string, q?: Record<string, string>, timeoutMs = 10_000): Promise<string> {
    const res = await fetch(this.url(path, q), { method, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* text 그대로 */
      }
      throw new Error(`agent ${path}: ${msg}`);
    }
    return text;
  }

  async ping(): Promise<{ ok: boolean; version: number; pid: number }> {
    return JSON.parse(await this.req('GET', '/ping', undefined, 3000));
  }

  hierarchyXml(allWindows = false): Promise<string> {
    return this.req('GET', '/hierarchy', allWindows ? { allWindows: '1' } : undefined);
  }

  /** 포커스된 입력창의 텍스트를 바꾼다 (append=true면 뒤에 붙임) */
  async setText(text: string, append = false): Promise<void> {
    await this.req('POST', '/text', { text, mode: append ? 'append' : 'replace' });
  }

  /** 활성 윈도우 패키지와 접근성 이벤트로 추적한 현재 Activity (에이전트 시작 후 화면 전환이 없었다면 빈 값) */
  async state(): Promise<{ package: string; activity: string; lastWindowClass: string }> {
    return JSON.parse(await this.req('GET', '/state', undefined, 3000));
  }

  async waitIdle(quietMs = 300, timeoutMs = 3000): Promise<{ idle: boolean; ms: number }> {
    return JSON.parse(await this.req('POST', '/idle', { quietMs: String(quietMs), timeoutMs: String(timeoutMs) }, timeoutMs + 3000));
  }
}

const clients = new Map<string, AgentClient>();
const failed = new Map<string, number>(); // serial → 실패 시각 (잠시 재시도 안 함)
const starting = new Map<string, Promise<AgentClient | undefined>>();

export function agentFor(serial: string): AgentClient | undefined {
  return clients.get(serial);
}

/** 연결된 에이전트를 버린다 (요청 실패 시 다음에 다시 연결) */
export function dropAgent(serial: string): void {
  clients.delete(serial);
}

async function installedVersion(dev: DeviceAdb): Promise<number | undefined> {
  const out = await dev.shell(`dumpsys package ${AGENT_PACKAGE} | grep versionCode`).catch(() => '');
  const m = /versionCode=(\d+)/.exec(out);
  return m ? Number(m[1]) : undefined;
}

async function forward(dev: DeviceAdb): Promise<number> {
  // 이미 걸린 포워딩 재사용
  const list = await dev.adb.text(['forward', '--list']).catch(() => '');
  const existing = list
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([s, , remote]) => s === dev.serial && remote === `tcp:${AGENT_PORT}`);
  if (existing) return Number(existing[1].replace('tcp:', ''));
  return Number((await dev.text(['forward', 'tcp:0', `tcp:${AGENT_PORT}`])).trim());
}

/**
 * 에이전트를 준비한다: 필요하면 설치/업데이트 → 실행(기기에서 setsid로 분리해 호스트 종료 후에도 유지) → 포트 포워딩 → ping.
 * 실패하면 undefined (호출부는 uiautomator 사용).
 */
export async function ensureAgent(dev: DeviceAdb, opts: { force?: boolean } = {}): Promise<AgentClient | undefined> {
  if (agentDisabled()) return undefined;
  const cached = clients.get(dev.serial);
  if (cached) return cached;
  const lastFail = failed.get(dev.serial);
  if (!opts.force && lastFail && Date.now() - lastFail < 60_000) return undefined;
  const inflight = starting.get(dev.serial);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const port = await forward(dev);
      const client = new AgentClient(dev.serial, port);
      // 이미 떠 있으면 바로 사용 (다른 DroidLens 프로세스가 띄웠을 수 있음)
      const alive = await client.ping().catch(() => undefined);
      if (alive && alive.version === AGENT_VERSION) {
        clients.set(dev.serial, client);
        return client;
      }
      const apk = agentApkPath();
      const ver = await installedVersion(dev);
      if (ver !== AGENT_VERSION) {
        if (!apk) throw new Error('에이전트 APK가 없습니다');
        await dev.raw(['install', '-r', '-t', apk], { timeoutMs: 60_000 });
      }
      await dev.shell(`am force-stop ${AGENT_PACKAGE}`).catch(() => undefined);
      await dev.shell(`setsid am instrument -w ${INSTRUMENT} </dev/null >/dev/null 2>&1 &`);
      // 부하가 큰 에뮬레이터에서는 시작에 10초 가까이 걸린다
      for (let i = 0; i < 50; i++) {
        await sleep(500);
        const r = await client.ping().catch(() => undefined);
        if (r?.ok) {
          clients.set(dev.serial, client);
          failed.delete(dev.serial);
          return client;
        }
      }
      throw new Error('에이전트가 응답하지 않습니다');
    } catch {
      failed.set(dev.serial, Date.now());
      return undefined;
    } finally {
      starting.delete(dev.serial);
    }
  })();
  starting.set(dev.serial, p);
  return p;
}

/** 에이전트 종료 (uiautomator dump를 다시 쓰려면 UiAutomation 연결을 놓아줘야 한다) */
export async function stopAgent(dev: DeviceAdb): Promise<void> {
  clients.delete(dev.serial);
  await dev.shell(`am force-stop ${AGENT_PACKAGE}`).catch(() => undefined);
}

export async function agentStatus(dev: DeviceAdb): Promise<{ installed?: number; running: boolean; apk?: string; disabled: boolean }> {
  // 다른 DroidLens 프로세스(데스크톱 앱 ↔ MCP)가 띄운 에이전트도 감지한다
  let c = clients.get(dev.serial);
  if (!c) {
    const port = await forward(dev).catch(() => undefined);
    if (port) c = new AgentClient(dev.serial, port);
  }
  const alive = c ? await c.ping().catch(() => undefined) : undefined;
  const running = !!alive && alive.version === AGENT_VERSION;
  if (running && c) clients.set(dev.serial, c);
  return { installed: await installedVersion(dev), running, apk: agentApkPath(), disabled: agentDisabled() };
}
