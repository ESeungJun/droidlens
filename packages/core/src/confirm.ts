import { randomUUID, timingSafeEqual } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';

/**
 * 되돌릴 수 없는 조작의 사용자 확인을 다른 프로세스에 맡기는 통로.
 * 데스크톱 대화창은 Claude Code 를 헤드리스로 띄워 MCP elicitation 을 쓸 수 없다. 그래서 데스크톱(메인 프로세스)이
 * 로컬 소켓(유닉스 소켓·Windows 는 이름 있는 파이프)을 열고, MCP 서버가 그 소켓으로 "이걸 해도 되나"를 묻는다.
 * 한 연결 = 한 호출의 확인 한 번. 승인은 그 호출에만 유효하다 (기억해 두는 허용 목록이 없다).
 * 소켓 경로와 토큰은 데스크톱이 MCP 서버의 환경 변수로만 넘긴다
 */

export interface ConfirmRequest {
  /** 브로커가 붙이는 요청 번호 */
  id: string;
  /** 무엇을 하려는지 (사람이 읽는 한 줄) */
  what: string;
  serial?: string;
  app?: string;
  tool?: string;
}

export type ConfirmOutcome = 'approved' | 'denied' | 'timeout' | 'unavailable';
/** 확인 요청이 답 없이 끝난 이유 */
export type ConfirmClosed = 'timeout' | 'cancelled';

const MAX_LINE = 8 * 1024;
const MAX_PENDING = 8;
/** 기본 응답 시간. 넘으면 거부 */
export const CONFIRM_TIMEOUT_MS = 60_000;

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const str = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

export class ConfirmBroker {
  private server?: Server;
  private readonly pending = new Map<string, { socket: Socket; timer: NodeJS.Timeout }>();

  constructor(
    private readonly opts: {
      token: string;
      timeoutMs?: number;
      /** 확인 요청이 왔다. answer(id, …) 로 답한다 */
      onRequest(req: ConfirmRequest): void;
      /** 답하기 전에 끝났다 (시간 초과, 요청한 쪽이 끊김). 화면의 확인창을 닫는 데 쓴다 */
      onClosed?(id: string, reason: ConfirmClosed): void;
    },
  ) {}

  listen(path: string): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
  }

  private accept(socket: Socket): void {
    let buf = '';
    let asked = false;
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    // 연결만 하고 요청을 보내지 않는 상대는 끊는다
    const idle = setTimeout(() => socket.destroy(), 5000);
    socket.on('data', (chunk: string) => {
      if (asked) return;
      buf += chunk;
      if (buf.length > MAX_LINE) return void socket.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      asked = true;
      clearTimeout(idle);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      } catch {
        return void socket.destroy();
      }
      const what = str(msg?.what, 500);
      if (typeof msg?.token !== 'string' || !sameToken(msg.token, this.opts.token) || !what) return void socket.destroy();
      if (this.pending.size >= MAX_PENDING) return void this.reply(socket, false, 'busy');
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.reply(socket, false, 'timeout');
        this.opts.onClosed?.(id, 'timeout');
      }, this.opts.timeoutMs ?? CONFIRM_TIMEOUT_MS);
      this.pending.set(id, { socket, timer });
      // 답하기 전에 요청한 쪽이 사라지면(대화 중지 등) 확인창도 닫는다
      socket.on('close', () => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        this.opts.onClosed?.(id, 'cancelled');
      });
      this.opts.onRequest({ id, what, serial: str(msg.serial, 100), app: str(msg.app, 200), tool: str(msg.tool, 100) });
    });
    socket.on('close', () => clearTimeout(idle));
  }

  private reply(socket: Socket, approve: boolean, reason?: string): void {
    socket.end(JSON.stringify({ approve, ...(reason ? { reason } : {}) }) + '\n');
  }

  /**
   * 사용자의 답을 전한다. 이미 답했거나 시간이 지났거나 없는 번호면 false (두 번째 답은 버린다:
   * 거부한 뒤 늦게 온 승인이 통하지 않게)
   */
  answer(id: string, approve: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.reply(p.socket, approve === true);
    return true;
  }

  /** 남은 요청을 모두 거부하고 닫는다 */
  close(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.reply(p.socket, false, 'closed');
      this.opts.onClosed?.(id, 'cancelled');
    }
    this.server?.close();
    this.server = undefined;
  }
}

/**
 * 브로커에 확인을 요청하고 답을 기다린다. 명시적인 승인({"approve":true})만 approved 다.
 * 연결하지 못하면 unavailable, 답이 없거나 끊기면 timeout·denied — 어느 쪽이든 실행하지 않는다
 */
export function requestConfirm(
  path: string,
  token: string,
  req: Omit<ConfirmRequest, 'id'>,
  timeoutMs = CONFIRM_TIMEOUT_MS + 5000,
): Promise<ConfirmOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let connected = false;
    let buf = '';
    const finish = (o: ConfirmOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(o);
    };
    const socket = connect(path);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ token, ...req }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) return finish('denied');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const r = JSON.parse(buf.slice(0, nl)) as { approve?: unknown; reason?: unknown };
        finish(r.approve === true ? 'approved' : r.reason === 'timeout' ? 'timeout' : 'denied');
      } catch {
        finish('denied');
      }
    });
    socket.on('error', () => finish(connected ? 'denied' : 'unavailable'));
    socket.on('close', () => finish(connected ? 'denied' : 'unavailable'));
  });
}
