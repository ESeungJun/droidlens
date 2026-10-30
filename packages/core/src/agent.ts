import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DeviceAdb, isPackageProcess, sleep } from './adb.js';
import { LocalHttpClient } from './http.js';
import { droidlensHome } from './workspace.js';

/**
 * 온디바이스 에이전트(android/agent) 연동.
 * 기기에서 상주하는 Instrumentation이 UiAutomation 연결을 유지하므로
 * 뷰 계층을 uiautomator dump(1.5~3초) 대신 0.1~0.3초에 받고, 한글 등 유니코드 입력도 가능하다.
 * 설치/실행에 실패하면 호출부는 uiautomator로 대체한다.
 */

export const AGENT_PACKAGE = 'io.github.eseungjun.droidlens.agent';
export const AGENT_VERSION = 4;
/** 에이전트는 TCP가 아닌 abstract 유닉스 소켓으로 열고 adb(shell) 연결만 받는다 */
const AGENT_REMOTE = 'localabstract:droidlens_agent';
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
  private readonly http: LocalHttpClient;
  /** 에이전트 패키지 프로세스로 확인한 pid 와 마지막으로 확인한 시각 */
  pid = 0;
  checkedAt = 0;

  constructor(readonly serial: string, readonly port: number) {
    this.http = new LocalHttpClient(port, 'agent');
  }

  private async req(method: 'GET' | 'POST', path: string, query?: Record<string, string>, timeoutMs = 10_000): Promise<string> {
    try {
      return await this.http.text(method, path, { query, timeoutMs });
    } catch (e) {
      // 연결 자체가 안 되면 에이전트 프로세스가 죽은 것이라 캐시에서 버린다 (다음 ensureAgent 가 다시 띄운다)
      if (isConnectionError(e) && clients.get(this.serial) === this) clients.delete(this.serial);
      throw e;
    }
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

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET']);

/**
 * 요청이 서버에 닿지 못한 실패 (fetch 가 TypeError 'fetch failed' 로 던진다).
 * 시간 초과(TimeoutError)·HTTP 오류와 달리 기기에서 실행되지 않았으므로 다시 보내도 된다.
 * 응답 처리 코드의 TypeError(버그)까지 연결 실패로 보지 않게 메시지·원인 코드로 가린다
 */
export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false;
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return e.message === 'fetch failed' || (typeof code === 'string' && CONNECTION_CODES.has(code));
}

/** 요청이 시간 안에 끝나지 않음 (fetch 의 AbortSignal.timeout 이 TimeoutError 로 던진다) */
export function isTimeoutError(e: unknown): boolean {
  const name = (e as { name?: unknown } | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

const clients = new Map<string, AgentClient>();
const failed = new Map<string, number>(); // serial → 실패 시각 (잠시 재시도 안 함)
const lastError = new Map<string, string>(); // serial → 마지막 실패 원인 (UI에 표시)

/** APK 설치. 기기에 더 높은 버전이 있으면(다른 DroidLens 버전이 설치) 지우고 다시 설치한다 */
async function installAgent(dev: DeviceAdb, apk: string): Promise<void> {
  try {
    await dev.raw(['install', '-r', '-t', apk], { timeoutMs: 60_000 });
  } catch (e) {
    const msg = (e as Error).message;
    if (!/DOWNGRADE|UPDATE_INCOMPATIBLE|signatures do not match/i.test(msg)) throw e;
    await dev.raw(['uninstall', AGENT_PACKAGE], { timeoutMs: 30_000 }).catch(() => undefined);
    await dev.raw(['install', '-t', apk], { timeoutMs: 60_000 });
  }
}
const starting = new Map<string, Promise<AgentClient | undefined>>();

export function agentFor(serial: string): AgentClient | undefined {
  return clients.get(serial);
}

/** 캐시된 에이전트를 재확인해 돌려준다 (새로 띄우지 않는다). 없거나 다른 프로세스로 바뀌었으면 undefined */
export async function checkedAgent(serial: string): Promise<AgentClient | undefined> {
  const c = clients.get(serial);
  return c && (await stillAgent(c)) ? c : undefined;
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

const forward = (dev: DeviceAdb) => dev.forward(AGENT_REMOTE);

/**
 * forward 로 붙은 상대가 진짜 에이전트인지. abstract 소켓 이름은 어느 앱이나 먼저 열 수 있으므로
 * ping 이 알려 준 pid 가 에이전트 패키지 uid 로 도는 프로세스인지 확인한다 (다른 앱이 덤프·입력 텍스트를 가로채지 못하게)
 */
async function verifyAgent(dev: DeviceAdb, client: AgentClient, pid: number): Promise<boolean> {
  if (!(await isPackageProcess(dev, AGENT_PACKAGE, pid))) return false;
  // 확인한 pid 를 남겨 두고 캐시를 쓸 때 ping 의 pid 와 비교한다
  client.pid = pid;
  client.checkedAt = Date.now();
  return true;
}

/** 확인한 지 이만큼 지난 캐시는 쓰기 전에 다시 본다 (에이전트가 죽은 자리를 다른 앱이 차지했을 수 있다) */
const RECHECK_MS = 5000;

/**
 * 캐시된 연결이 아직 확인한 에이전트인지. 요청마다 왕복을 늘리지 않게 RECHECK_MS 마다만 ping 의 pid 를 비교한다.
 * 에이전트는 연결을 순서대로 처리하므로 긴 요청(/idle·/hierarchy) 뒤에 줄 선 ping 은 시간 초과될 수 있다.
 * 시간 초과는 캐시를 그대로 두고 확인 시각만 두어 다음에 다시 본다 (버리면 ensureAgent 가 에이전트를 재시작한다).
 * 연결 오류는 req 가 이미 캐시에서 뺐다
 */
async function stillAgent(c: AgentClient): Promise<boolean> {
  if (Date.now() - c.checkedAt < RECHECK_MS) return true;
  let pid: number;
  try {
    pid = (await c.ping()).pid;
  } catch (e) {
    if (isTimeoutError(e)) return clients.get(c.serial) === c;
    pid = -1;
  }
  if (pid === c.pid) {
    c.checkedAt = Date.now();
    return true;
  }
  // pid 가 바뀌었거나 에이전트답지 않은 응답이면(다른 DroidLens 프로세스가 다시 띄웠거나 소켓 주인이 바뀜) 처음부터 다시 확인한다
  if (clients.get(c.serial) === c) clients.delete(c.serial);
  return false;
}
const IMPOSTOR = '에이전트 소켓을 에이전트가 아닌 프로세스가 열고 있어 연결하지 않습니다';

/**
 * 에이전트를 준비한다: 필요하면 설치/업데이트 → 실행(기기에서 setsid로 분리해 호스트 종료 후에도 유지) → 포트 포워딩 → ping.
 * 실패하면 undefined (호출부는 uiautomator 사용).
 */
export async function ensureAgent(dev: DeviceAdb, opts: { force?: boolean } = {}): Promise<AgentClient | undefined> {
  if (agentDisabled()) return undefined;
  const cached = clients.get(dev.serial);
  if (cached && (await stillAgent(cached))) return cached;
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
        if (!(await verifyAgent(dev, client, alive.pid))) throw new Error(IMPOSTOR);
        clients.set(dev.serial, client);
        return client;
      }
      const apk = agentApkPath();
      const ver = await installedVersion(dev);
      if (ver !== AGENT_VERSION) {
        if (!apk) throw new Error('에이전트 APK를 찾지 못했습니다 (앱을 다시 설치하거나 DROIDLENS_AGENT_APK 지정)');
        await installAgent(dev, apk);
      }
      await dev.shell(`am force-stop ${AGENT_PACKAGE}`).catch(() => undefined);
      await dev.shell(`setsid am instrument -w ${INSTRUMENT} </dev/null >/dev/null 2>&1 &`);
      // 부하가 큰 에뮬레이터에서는 시작에 10초 가까이 걸린다
      for (let i = 0; i < 50; i++) {
        await sleep(500);
        const r = await client.ping().catch(() => undefined);
        if (r?.ok && r.version === AGENT_VERSION) {
          if (!(await verifyAgent(dev, client, r.pid))) throw new Error(IMPOSTOR);
          clients.set(dev.serial, client);
          failed.delete(dev.serial);
          lastError.delete(dev.serial);
          return client;
        }
      }
      throw new Error('에이전트가 25초 안에 응답하지 않았습니다. 기기가 매우 느리거나 다른 UiAutomation 도구(Appium 등)가 실행 중일 수 있습니다');
    } catch (e) {
      failed.set(dev.serial, Date.now());
      lastError.set(dev.serial, (e as Error).message);
      return undefined;
    } finally {
      starting.delete(dev.serial);
    }
  })();
  starting.set(dev.serial, p);
  return p;
}

/**
 * 에이전트 종료 (uiautomator dump를 다시 쓰려면 UiAutomation 연결을 놓아줘야 한다).
 * failure 를 주면 실패로 기록해 잠시(60초) 다시 띄우지 않는다 (호출마다 최대 25초씩 재시작하지 않게)
 */
export async function stopAgent(dev: DeviceAdb, failure?: string): Promise<void> {
  clients.delete(dev.serial);
  if (failure) {
    failed.set(dev.serial, Date.now());
    lastError.set(dev.serial, failure);
  }
  await dev.shell(`am force-stop ${AGENT_PACKAGE}`).catch(() => undefined);
}

/**
 * 에이전트로 요청한다. 캐시된 연결이 끊겼으면(에이전트가 죽음) 다시 준비해 한 번만 더 보낸다.
 * 에이전트를 쓸 수 없으면 undefined (호출부가 대체 경로를 쓴다)
 */
export async function withAgent<T>(dev: DeviceAdb, fn: (a: AgentClient) => Promise<T>): Promise<{ value: T } | undefined> {
  for (let attempt = 0; ; attempt++) {
    const agent = await ensureAgent(dev);
    if (!agent) return undefined;
    try {
      return { value: await fn(agent) };
    } catch (e) {
      if (attempt > 0 || !isConnectionError(e)) throw e;
    }
  }
}

export async function agentStatus(
  dev: DeviceAdb,
): Promise<{ installed?: number; expected: number; running: boolean; apk?: string; disabled: boolean; error?: string }> {
  // 다른 DroidLens 프로세스(데스크톱 앱 ↔ MCP)가 띄운 에이전트도 감지한다
  let c = clients.get(dev.serial);
  if (!c) {
    const port = await forward(dev).catch(() => undefined);
    if (port) c = new AgentClient(dev.serial, port);
  }
  const alive = c ? await c.ping().catch(() => undefined) : undefined;
  const running = !!alive && !!c && alive.version === AGENT_VERSION && (await verifyAgent(dev, c, alive.pid));
  if (running && c) clients.set(dev.serial, c);
  return {
    installed: await installedVersion(dev),
    expected: AGENT_VERSION,
    running,
    apk: agentApkPath(),
    disabled: agentDisabled(),
    error: running ? undefined : lastError.get(dev.serial),
  };
}
