import { DeviceAdb } from './adb.js';
import { LocalHttpClient } from './http.js';

/**
 * 선택형 앱 SDK(android/sdk) 연동. SDK를 넣은 앱은 localabstract:droidlens_sdk_<패키지>에 HTTP 서버를 연다.
 * 호스트는 /proc/net/unix로 소켓을 찾고 adb forward로 연결한다.
 */

export const SDK_SOCKET_PREFIX = 'droidlens_sdk_';

export interface SdkInfo {
  sdkVersion: string;
  package: string;
  versionName?: string;
  pid: number;
  okhttp: boolean;
  plugins: string[];
}

export interface NetworkEntry {
  id: number;
  startedAt: number;
  method: string;
  url: string;
  state: 'pending' | 'done' | 'failed';
  status: number;
  durationMs: number;
  requestSize: number;
  responseSize: number;
  responseContentType?: string;
  error?: string;
}

export interface NetworkDetail extends NetworkEntry {
  requestHeaders: Record<string, string[]>;
  requestContentType?: string;
  requestBody?: string;
  requestBodyBase64?: string;
  requestTruncated: boolean;
  message?: string;
  protocol?: string;
  responseHeaders: Record<string, string[]>;
  responseBody?: string;
  responseBodyBase64?: string;
  responseTruncated: boolean;
}

export type PrefValue = { type: 'string' | 'int' | 'long' | 'float' | 'boolean' | 'stringSet' | 'unknown'; value: unknown };
export interface PrefsFile {
  name: string;
  entries: Record<string, PrefValue>;
}

export interface DbTable {
  name: string;
  type: 'table' | 'view';
  rowCount?: number;
  columns: { name: string; type: string; pk: boolean; notNull: boolean }[];
}
export interface DbInfo {
  name: string;
  path: string;
  size: number;
  tables: DbTable[];
  error?: string;
}
export interface QueryResult {
  columns?: string[];
  rows?: unknown[][];
  total?: number;
  truncated?: boolean;
  changes?: number;
}

export interface SdkEvent {
  id: number;
  at: number;
  name: string;
  thread: string;
  data?: Record<string, unknown>;
}

/** 기기에서 SDK 서버가 떠 있는 패키지 목록 */
export async function listSdkApps(dev: DeviceAdb): Promise<string[]> {
  const out = await dev.shell(`cat /proc/net/unix | grep ${SDK_SOCKET_PREFIX}`).catch(() => '');
  const pkgs = new Set<string>();
  for (const m of out.matchAll(new RegExp(`@${SDK_SOCKET_PREFIX}([\\w.]+)`, 'g'))) pkgs.add(m[1]);
  return [...pkgs].sort();
}

export class SdkClient {
  private readonly http: LocalHttpClient;

  constructor(readonly serial: string, readonly pkg: string, readonly port: number) {
    this.http = new LocalHttpClient(port, 'SDK');
  }

  private req<T>(method: 'GET' | 'POST', path: string, query?: Record<string, string>, body?: string, timeoutMs = 15_000): Promise<T> {
    return this.http.json<T>(method, path, { query, body, timeoutMs });
  }

  info(): Promise<SdkInfo> {
    return this.req('GET', '/info', undefined, undefined, 3000);
  }

  async network(opts: { since?: number; limit?: number; filter?: string } = {}): Promise<NetworkEntry[]> {
    const q: Record<string, string> = {};
    if (opts.since) q.since = String(opts.since);
    if (opts.limit) q.limit = String(opts.limit);
    if (opts.filter) q.filter = opts.filter;
    return (await this.req<{ entries: NetworkEntry[] }>('GET', '/network', q)).entries;
  }

  networkDetail(id: number): Promise<NetworkDetail> {
    return this.req('GET', '/network/detail', { id: String(id) });
  }

  async clearNetwork(): Promise<void> {
    await this.req('POST', '/network/clear');
  }

  async prefs(): Promise<PrefsFile[]> {
    return (await this.req<{ files: PrefsFile[] }>('GET', '/prefs')).files;
  }

  async setPref(file: string, key: string, type: string, value: string): Promise<void> {
    await this.req('POST', '/prefs/set', { file, key, type }, value);
  }

  async removePref(file: string, key: string): Promise<void> {
    await this.req('POST', '/prefs/remove', { file, key });
  }

  async databases(): Promise<DbInfo[]> {
    return (await this.req<{ databases: DbInfo[] }>('GET', '/db', undefined, undefined, 30_000)).databases;
  }

  query(db: string, sql: string, write = false): Promise<QueryResult> {
    return this.req('POST', '/db/query', { db, ...(write ? { write: '1' } : {}) }, sql, 30_000);
  }

  async events(since = 0): Promise<SdkEvent[]> {
    return (await this.req<{ events: SdkEvent[] }>('GET', '/events', { since: String(since) })).events;
  }
}

/** serial|패키지 → 연결과 확인을 마친 앱 프로세스 pid */
const clients = new Map<string, { client: SdkClient; pid: number }>();

/**
 * forward 로 붙은 상대가 그 앱인지. abstract 소켓 이름은 어느 앱이나 먼저 열 수 있으므로
 * /info 가 알려 준 패키지·pid 가 실제 그 패키지 프로세스인지 확인한다 (다른 앱이 prefs·DB 요청을 가로채지 못하게)
 */
async function verifyApp(dev: DeviceAdb, pkg: string, info: SdkInfo): Promise<void> {
  const out = await dev.shell(`pidof ${pkg}`).catch(() => '');
  if (info.package !== pkg || !out.trim().split(/\s+/).map(Number).includes(info.pid)) {
    throw new Error(`${pkg}의 SDK 소켓을 다른 프로세스가 열고 있어 연결하지 않습니다`);
  }
}

/** SDK 클라이언트 (포트 포워딩 재사용). 앱이 SDK를 쓰지 않거나 실행 중이 아니면 에러 */
export async function sdkFor(dev: DeviceAdb, pkg: string): Promise<SdkClient> {
  if (!/^[\w.]+$/.test(pkg)) throw new Error(`잘못된 패키지 이름: ${pkg}`);
  const key = `${dev.serial}|${pkg}`;
  const cached = clients.get(key);
  // 앱이 다시 시작돼 pid 가 바뀌었으면 새로 확인한다
  const cachedPid = cached && (await cached.client.info().then((i) => i.pid, () => undefined));
  if (cached && cachedPid === cached.pid) return cached.client;
  clients.delete(key);

  const apps = await listSdkApps(dev);
  if (!apps.includes(pkg)) {
    throw new Error(
      `${pkg}에서 DroidLens SDK 서버를 찾지 못했습니다. 앱이 실행 중인지, debug 빌드에 SDK(debugImplementation)가 들어갔는지 확인하세요.`,
    );
  }
  const port = await dev.forward(`localabstract:${SDK_SOCKET_PREFIX}${pkg}`);
  const client = new SdkClient(dev.serial, pkg, port);
  const info = await client.info();
  await verifyApp(dev, pkg, info);
  clients.set(key, { client, pid: info.pid });
  return client;
}
