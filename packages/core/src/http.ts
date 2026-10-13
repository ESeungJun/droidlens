/**
 * adb forward로 연결한 기기 내 HTTP 서버(온디바이스 에이전트, 앱 SDK) 공용 클라이언트.
 * 서버는 오류 시 {"error": "..."} JSON을 돌려준다.
 */

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: string;
  timeoutMs?: number;
}

export class LocalHttpClient {
  constructor(readonly port: number, private readonly label: string) {}

  async text(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<string> {
    const q = Object.entries(opts.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
    const qs = q.length ? '?' + new URLSearchParams(q).toString() : '';
    const res = await fetch(`http://127.0.0.1:${this.port}${path}${qs}`, {
      method,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* JSON이 아니면 본문 그대로 */
      }
      throw new Error(`${this.label} ${path}: ${msg || res.status}`);
    }
    return text;
  }

  async json<T>(method: 'GET' | 'POST', path: string, opts?: RequestOptions): Promise<T> {
    const text = await this.text(method, path, opts);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${this.label} ${path}: 응답을 해석하지 못했습니다 (${text.slice(0, 120)})`);
    }
  }
}
