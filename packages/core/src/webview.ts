import { DeviceAdb, isPackageProcess } from './adb.js';
import { MASK, looksSecret, redactUrl } from './redact.js';

/**
 * 웹뷰 디버깅(Chrome DevTools Protocol)으로 앱 안 웹 페이지의 콘솔 오류·요청·본문을 본다 (#132).
 *
 * 웹뷰 디버깅이 켜진 앱 프로세스는 기기 안 유닉스 소켓 localabstract:webview_devtools_remote_<pid> 를 연다
 * (android:debuggable 앱은 웹뷰를 만들면 자동으로 켜지고, 아니면 앱이 WebView.setWebContentsDebuggingEnabled(true) 를 불러야 한다).
 * 호스트는 adb forward 로 127.0.0.1 포트에 잇고, 그 포트로만 HTTP(/json/list)·WebSocket 을 연다.
 *
 * 읽기만 한다: 페이지 이동·새로 고침·스크립트 주입은 하지 않고, 고정된 읽기 식 하나만 평가한다.
 * 페이지 글·콘솔 글·URL 은 밖에서 온 값이라 줄을 펴고 자르고, URL 쿼리 값·토큰 같은 글은 가린다. 요청 헤더·쿠키는 넘기지 않는다.
 */

export const WEBVIEW_SOCKET_PREFIX = 'webview_devtools_remote_';

export interface WebViewPage {
  id: string;
  title: string;
  url: string;
  /** 지금 화면에 보이는 웹뷰인지 (웹뷰가 알려 줄 때만) */
  visible?: boolean;
}

export interface WebViewConsoleEntry {
  /** error · warning · log · info · debug · exception(잡히지 않은 예외) 등 */
  level: string;
  text: string;
  /** Log 도메인 항목의 출처 (network · javascript 등) */
  source?: string;
  /** 글을 낸 스크립트 (쿼리 값은 가림) */
  url?: string;
  line?: number;
}

export interface WebViewRequest {
  url: string;
  method?: string;
  /** 리소스 종류 (navigation · fetch · xmlhttprequest · img · script 등) */
  type?: string;
  /** HTTP 상태. 0 이면 응답을 받지 못함 */
  status?: number;
  error?: string;
  durationMs?: number;
  /** 듣는 동안(listenMs) 새로 생긴 요청이면 true */
  live?: boolean;
}

export interface WebViewInspection {
  pid: number;
  pages: WebViewPage[];
  page: WebViewPage;
  console: WebViewConsoleEntry[];
  requests: WebViewRequest[];
  /** includeText 일 때만: 페이지 본문 글자(화면 밖 포함, 잘림) */
  text?: string;
  /** 한도를 넘어 버린 개수 */
  dropped: { console: number; requests: number };
  /**
   * 소켓 주인 확인: /json/version 의 Android-Package 가 이 패키지와 같으면 true.
   * 웹뷰가 그 항목을 알려 주지 않아 확인하지 못했으면 false (소켓 이름 속 pid 가 이 앱 프로세스인 것까지만 확인함)
   */
  ownerVerified: boolean;
}

export interface InspectWebViewOptions {
  /** 페이지 id · URL · 제목 일부. 없으면 보이는 페이지 → 첫 페이지 */
  page?: string;
  /** 이 시간(ms) 동안 새 요청·콘솔을 더 듣는다 (최대 15000). 0 이면 지금까지 쌓인 것만 */
  listenMs?: number;
  includeText?: boolean;
  /** 본문 글자 최대 길이 (기본 3000, 최대 20000) */
  maxText?: number;
}

export type WebViewInspectCode = 'not-running' | 'debug-off' | 'no-page' | 'connect' | 'not-owner';

export class WebViewInspectError extends Error {
  constructor(
    readonly code: WebViewInspectCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebViewInspectError';
  }
}

const MAX_CONSOLE = 50;
const MAX_REQUESTS = 100;
const CONSOLE_TEXT_MAX = 300;
const URL_MAX = 300;
const TITLE_MAX = 120;
const LISTEN_MAX = 15_000;
/** /json/list 응답 한도 (페이지 목록이 이보다 클 일은 없다) */
const LIST_BYTES_MAX = 1024 * 1024;
const PAGE_ID = /^[A-Za-z0-9-]{1,64}$/;
/** 한 번에 모으는 CDP 이벤트 상한 */
const MAX_EVENTS = 2000;
/** CDP 메시지 하나의 상한 (글자 수). 넘으면 해석하지 않고 버린다 */
const MAX_FRAME = 1024 * 1024;
/** 읽기 식 응답을 기다리는 한도 */
const EVAL_WAIT_MS = 3000;
/** 읽기 식이 돌려주는 URL 한 개의 길이 (data: URL 처럼 긴 것은 페이지 안에서 자른다) */
const EVAL_URL_MAX = 600;
/** 읽기 식 결과의 상한: 본문 + 요청 수 × (URL + 나머지 칸), JSON 이스케이프로 늘어날 몫까지 두 배 */
const evalMax = (maxText: number | undefined) => 2 * ((maxText ?? 0) + MAX_REQUESTS * (EVAL_URL_MAX + 200)) + 2000;

/** /proc/net/unix 에서 웹뷰 디버깅 소켓을 연 pid (나온 순서, 중복 없이) */
export function parseWebViewSockets(procNetUnix: string): number[] {
  const out: number[] = [];
  for (const m of procNetUnix.matchAll(new RegExp(`@${WEBVIEW_SOCKET_PREFIX}(\\d+)\\b`, 'g'))) {
    const pid = Number(m[1]);
    if (pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

/** 밖에서 온 글: 제어 문자·줄바꿈을 한 칸으로 펴고 자른다 */
function clip(raw: unknown, max: number): string {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 토큰처럼 보이는 낱말: JWT, 또는 글자·숫자가 섞인 긴 덩어리. 숫자 없는 긴 이름(undefinedFunctionName)은 두어 오류 글을 읽을 수 있게 */
const tokenLike = (w: string) => looksSecret(w) && (/^eyJ/.test(w) || (/\d/.test(w) && /[A-Za-z]/.test(w)));

/** 콘솔 글 속 URL 의 쿼리 값과 토큰 같은 낱말을 가린다 */
function maskText(s: string): string {
  return s
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>]+/gi, (u) => redactUrl(u))
    .replace(/[\w\-.~+/=]{24,}/g, (w) => (w.includes(MASK) || !tokenLike(w) ? w : MASK));
}

const cleanUrl = (u: unknown) => clip(redactUrl(String(u ?? '')), URL_MAX);
const consoleText = (raw: unknown) => clip(maskText(clip(raw, CONSOLE_TEXT_MAX * 4)), CONSOLE_TEXT_MAX);

const HELP_DEBUG_OFF = (pkg: string) =>
  `${pkg} 의 웹뷰 디버깅이 꺼져 있어 웹 페이지의 콘솔·요청을 볼 수 없어요. ` +
  'debug 빌드(android:debuggable)는 웹뷰를 만들면 자동으로 켜지니, 아직 웹뷰 화면을 열지 않았으면 먼저 여세요. ' +
  'debuggable 이 아닌 빌드는 앱이 WebView.setWebContentsDebuggingEnabled(true) 를 부르거나, DroidLens SDK 를 쓰면 DroidLens.enableWebViewDebugging() 을 불러야 해요. ' +
  '화면에 보이는 웹 글자는 디버깅 없이도 view_hierarchy·find_nodes 로 읽고, 셀렉터에 inWeb: true 를 주면 앱 제목 줄을 빼고 웹 페이지 글자만 찾아요.';

/** 이 앱 프로세스가 연 웹뷰 디버깅 소켓의 pid. 없으면 안내 오류 */
async function findSocketPid(dev: DeviceAdb, pkg: string): Promise<number> {
  const out = await dev.shell(`cat /proc/net/unix | grep ${WEBVIEW_SOCKET_PREFIX}; echo --; pidof ${pkg}`).catch(() => '--');
  const [unix, pids = ''] = out.split(/^--$/m);
  // 소켓 이름은 어느 앱이나 지을 수 있어, 이름 속 pid 가 정말 이 패키지 uid 로 도는 프로세스인지 본다
  for (const pid of parseWebViewSockets(unix)) if (await isPackageProcess(dev, pkg, pid)) return pid;
  if (!pids.trim()) throw new WebViewInspectError('not-running', `${pkg} 가 실행 중이 아니에요. 앱을 띄우고 웹뷰 화면을 연 뒤 다시 불러 주세요.`);
  throw new WebViewInspectError('debug-off', HELP_DEBUG_OFF(pkg));
}

/** 127.0.0.1 의 JSON 하나를 상한까지만 읽는다 (Content-Length 를 먼저 보고, 흘려 받다가 넘으면 바로 끊는다) */
async function getJson(port: number, path: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${path} 응답 ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > LIST_BYTES_MAX) throw new Error(`${path} 응답이 너무 커요`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${path} 응답이 비었어요`);
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIST_BYTES_MAX) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${path} 응답이 너무 커요`);
      }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/**
 * 소켓 주인 확인 (abstract 소켓 이름은 아무 앱이나 먼저 열 수 있다). 웹뷰는 /json/version 에 자기 앱 패키지를 알려 준다.
 * 다른 패키지면 거부하고, 알려 주지 않으면 false
 */
async function checkOwner(port: number, pkg: string): Promise<boolean> {
  const v = (await getJson(port, '/json/version')) as Record<string, unknown> | null;
  const owner = v && typeof v === 'object' ? v['Android-Package'] : undefined;
  if (typeof owner !== 'string' || !owner) return false;
  if (owner !== pkg) throw new WebViewInspectError('not-owner', `웹뷰 디버깅 소켓을 연 앱이 ${clip(owner, 100)} 라서 ${pkg} 의 것으로 보지 않고 연결을 끊었어요.`);
  return true;
}

/** 페이지 목록 (page 종류만). 호스트는 항상 127.0.0.1 */
async function listPages(port: number): Promise<WebViewPage[]> {
  const raw = await getJson(port, '/json/list');
  if (!Array.isArray(raw)) throw new Error('페이지 목록 형식이 달라요');
  const pages: WebViewPage[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || p.type !== 'page' || typeof p.id !== 'string' || !PAGE_ID.test(p.id)) continue;
    let visible: boolean | undefined;
    try {
      const d = JSON.parse(String(p.description ?? '')) as { visible?: unknown };
      if (typeof d.visible === 'boolean') visible = d.visible;
    } catch {
      /* 설명이 JSON 이 아니면 보임 여부를 모른다 */
    }
    pages.push({ id: p.id, title: clip(p.title, TITLE_MAX), url: cleanUrl(p.url), ...(visible !== undefined ? { visible } : {}) });
  }
  return pages;
}

function pickPage(pages: WebViewPage[], want: string | undefined): WebViewPage | undefined {
  if (want) {
    const w = want.toLowerCase();
    return pages.find((p) => p.id === want) ?? pages.find((p) => p.url.toLowerCase().includes(w) || p.title.toLowerCase().includes(w));
  }
  return pages.find((p) => p.visible) ?? pages[0];
}

/** 페이지에서 평가하는 고정 읽기 식: 지금까지 받은 리소스(성능 기록)와 본문 글자 */
function readExpression(maxText: number | undefined): string {
  const text = maxText ? `(document.body ? document.body.innerText : '').slice(0, ${maxText})` : 'undefined';
  return (
    '(() => { const e = performance.getEntriesByType("navigation").concat(performance.getEntriesByType("resource")).slice(-' +
    MAX_REQUESTS +
    '); return JSON.stringify({ requests: e.map((x) => ({ url: String(x.name).slice(0, ' + EVAL_URL_MAX + '), type: x.initiatorType || x.entryType, status: x.responseStatus, ms: x.duration })), text: ' +
    text +
    ' }); })()'
  );
}

type CdpMessage = { id?: number; method?: string; params?: Record<string, any>; result?: Record<string, any>; error?: { message?: string } };

/** CDP WebSocket 하나로 명령을 보내고 이벤트를 모은다 */
async function withCdp<T>(url: string, timeoutMs: number, run: (send: (method: string, params?: object) => Promise<CdpMessage>, events: CdpMessage[]) => Promise<T>): Promise<T> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error('이 Node 에는 WebSocket 이 없어요 (Node 22 이상이 필요해요)');
  const ws = new WS(url);
  const events: CdpMessage[] = [];
  const waiting = new Map<number, (m: CdpMessage) => void>();
  let seq = 0;
  let failed: (e: Error) => void = () => {};
  const broken = new Promise<never>((_, reject) => (failed = reject));
  broken.catch(() => {});
  ws.onmessage = (ev) => {
    // 너무 큰 메시지는 해석하지 않고 버린다 (응답이었다면 그 명령은 시간 초과나 빈 결과로 끝난다)
    if (typeof ev.data !== 'string' || ev.data.length > MAX_FRAME) return;
    let m: CdpMessage;
    try {
      m = JSON.parse(ev.data) as CdpMessage;
    } catch {
      return;
    }
    // 명령 응답은 늘 받고, 이벤트만 상한까지 모은다 (콘솔이 넘치는 페이지에서도 응답을 기다리다 멈추지 않게)
    if (m.id !== undefined) waiting.get(m.id)?.(m);
    else if (m.method && events.length < MAX_EVENTS) events.push(m);
  };
  ws.onerror = () => failed(new Error('웹뷰 디버깅 연결이 끊겼어요'));
  ws.onclose = () => failed(new Error('웹뷰 디버깅 연결이 닫혔어요'));
  const timer = setTimeout(() => failed(new Error('웹뷰 디버깅 응답이 늦어요')), timeoutMs);
  try {
    await Promise.race([new Promise<void>((r) => (ws.onopen = () => r())), broken]);
    const send = (method: string, params: object = {}) => {
      const id = ++seq;
      const reply = new Promise<CdpMessage>((r) => waiting.set(id, r));
      ws.send(JSON.stringify({ id, method, params }));
      return Promise.race([reply, broken]);
    };
    return await run(send, events);
  } finally {
    clearTimeout(timer);
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
}

function argText(a: Record<string, any>): string {
  if (a?.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return String(a?.description ?? a?.type ?? '');
}

/** 모은 CDP 이벤트를 콘솔·요청 목록으로 */
function collect(events: CdpMessage[]): { console: WebViewConsoleEntry[]; live: WebViewRequest[]; netErrors: Map<string, string> } {
  const out: WebViewConsoleEntry[] = [];
  const live = new Map<string, WebViewRequest>();
  const netErrors = new Map<string, string>();
  for (const e of events) {
    const p = e.params ?? {};
    if (e.method === 'Runtime.consoleAPICalled') {
      const frame = p.stackTrace?.callFrames?.[0];
      out.push({
        level: clip(p.type, 20) || 'log',
        text: consoleText((p.args ?? []).map(argText).join(' ')),
        ...(frame?.url ? { url: cleanUrl(frame.url) } : {}),
        ...(Number.isInteger(frame?.lineNumber) ? { line: frame.lineNumber + 1 } : {}),
      });
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails ?? {};
      out.push({
        level: 'exception',
        text: consoleText(String(d.exception?.description ?? d.text ?? '').split('\n')[0]),
        ...(d.url ? { url: cleanUrl(d.url) } : {}),
        ...(Number.isInteger(d.lineNumber) ? { line: d.lineNumber + 1 } : {}),
      });
    } else if (e.method === 'Log.entryAdded') {
      const en = p.entry ?? {};
      out.push({ level: clip(en.level, 20) || 'log', text: consoleText(en.text), source: clip(en.source, 20), ...(en.url ? { url: cleanUrl(en.url) } : {}) });
      if (en.source === 'network' && en.url) netErrors.set(String(en.url), clip(/net::\w+/.exec(String(en.text))?.[0] ?? en.text, 80));
    } else if (e.method === 'Network.requestWillBeSent' && typeof p.requestId === 'string') {
      live.set(p.requestId, { url: cleanUrl(p.request?.url), method: clip(p.request?.method, 10), type: clip(String(p.type ?? '').toLowerCase(), 20), live: true });
    } else if (e.method === 'Network.responseReceived' && live.has(p.requestId)) {
      const r = live.get(p.requestId)!;
      if (Number.isInteger(p.response?.status)) r.status = p.response.status;
    } else if (e.method === 'Network.loadingFailed' && live.has(p.requestId)) {
      live.get(p.requestId)!.error = clip(p.errorText, 80);
    }
  }
  return { console: out, live: [...live.values()], netErrors };
}

/**
 * 앱 웹뷰의 콘솔 오류·요청(·본문)을 읽는다. 디버깅이 꺼졌거나 앱이 없으면 WebViewInspectError(안내 글).
 * 쓴 adb forward 는 끝나면 지운다 (다른 도구가 건 forward 는 다시 쓰지 않는다)
 */
export async function inspectWebView(dev: DeviceAdb, pkg: string, opts: InspectWebViewOptions = {}): Promise<WebViewInspection> {
  if (!/^[\w.]+$/.test(pkg)) throw new Error(`잘못된 패키지 이름: ${pkg}`);
  const listenMs = Math.min(Math.max(0, Math.floor(opts.listenMs ?? 0)), LISTEN_MAX);
  const maxText = opts.includeText ? Math.min(Math.max(1, Math.floor(opts.maxText ?? 3000)), 20_000) : undefined;
  const pid = await findSocketPid(dev, pkg);
  const port = Number((await dev.text(['forward', 'tcp:0', `localabstract:${WEBVIEW_SOCKET_PREFIX}${pid}`])).trim());
  if (!Number.isInteger(port) || port <= 0) throw new WebViewInspectError('connect', '웹뷰 디버깅 소켓에 포트를 잇지 못했어요');
  try {
    let pages: WebViewPage[];
    let ownerVerified: boolean;
    try {
      ownerVerified = await checkOwner(port, pkg);
      pages = await listPages(port);
    } catch (e) {
      if (e instanceof WebViewInspectError) throw e;
      throw new WebViewInspectError('connect', `웹뷰 디버깅 소켓에 붙지 못했어요: ${(e as Error).message}`);
    }
    const page = pickPage(pages, opts.page);
    if (!page) {
      const list = pages.map((p) => `${p.id} (${p.title || p.url})`).join(', ');
      throw new WebViewInspectError('no-page', pages.length ? `맞는 페이지가 없어요. 지금 페이지: ${list}` : '웹뷰에 열린 페이지가 없어요. 웹뷰 화면을 연 뒤 다시 불러 주세요.');
    }
    // webSocketDebuggerUrl 은 따르지 않고 같은 포트·확인한 id 로 주소를 만든다 (127.0.0.1 밖으로 나가지 않게)
    const wsUrl = `ws://127.0.0.1:${port}/devtools/page/${page.id}`;
    const r = await withCdp(wsUrl, 10_000 + listenMs, async (send, events) => {
      // Runtime·Log 를 켜면 붙기 전에 쌓인 콘솔·예외·네트워크 오류를 다시 보내 준다
      await send('Runtime.enable');
      await send('Log.enable');
      if (listenMs) await send('Network.enable');
      // 응답이 프레임 상한을 넘어 버려지면 오지 않으므로 따로 기다림 한도를 둔다 (그때는 콘솔만 쓴다)
      const ev = await Promise.race([
        send('Runtime.evaluate', { expression: readExpression(maxText), returnByValue: true, silent: true }),
        new Promise<CdpMessage>((res) => setTimeout(() => res({}), EVAL_WAIT_MS).unref?.()),
      ]);
      if (listenMs) await new Promise((res) => setTimeout(res, listenMs));
      let read: { requests?: { url?: unknown; type?: unknown; status?: unknown; ms?: unknown }[]; text?: unknown } = {};
      const value = ev.result?.result?.value;
      // 페이지가 읽기 식을 바꿔 큰 값을 돌려줄 수 있어 해석 전에 길이를 본다. 넘거나 형식이 틀리면 콘솔만 쓴다
      if (typeof value === 'string' && value.length <= evalMax(maxText)) {
        try {
          const v = JSON.parse(value) as typeof read;
          if (v && typeof v === 'object')
            read = {
              requests: Array.isArray(v.requests) ? v.requests.slice(-MAX_REQUESTS) : [],
              text: maxText && typeof v.text === 'string' ? v.text.slice(0, maxText) : undefined,
            };
        } catch {
          /* 형식이 틀리면 버린다 */
        }
      }
      return { read, events: [...events] };
    });
    const c = collect(r.events);
    const requests: WebViewRequest[] = (Array.isArray(r.read.requests) ? r.read.requests : []).map((q) => {
      const raw = String(q.url ?? '');
      const err = c.netErrors.get(raw);
      return {
        url: cleanUrl(raw),
        type: clip(q.type, 20),
        ...(Number.isInteger(q.status) ? { status: q.status as number } : {}),
        ...(typeof q.ms === 'number' && Number.isFinite(q.ms) ? { durationMs: Math.round(q.ms) } : {}),
        ...(err ? { error: err } : {}),
      };
    });
    requests.push(...c.live);
    const keepC = c.console.slice(-MAX_CONSOLE);
    const keepR = requests.slice(-MAX_REQUESTS);
    return {
      pid,
      pages,
      page,
      console: keepC,
      requests: keepR,
      ...(typeof r.read.text === 'string' ? { text: maskText(r.read.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')).slice(0, maxText) } : {}),
      dropped: { console: c.console.length - keepC.length, requests: requests.length - keepR.length },
      ownerVerified,
    };
  } finally {
    await dev.text(['forward', '--remove', `tcp:${port}`]).catch(() => undefined);
  }
}
