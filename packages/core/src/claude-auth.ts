/**
 * Claude Code 로그인 상태 (#120). 앱은 Finder 로 뜨면 터미널의 CLAUDE_CONFIG_DIR 를 물려받지 않아
 * 다른 설정 폴더(기본 ~/.claude)의 로그인을 쓴다. 그 로그인이 끊겼으면 실행 전에 알려 주려고 `claude auth status` 를 읽는다.
 * 노드 모듈을 쓰지 않는 순수 함수만 둔다 (화면에서도 불러 쓴다)
 */

export type ClaudeAuthState = 'ok' | 'none' | 'expired' | 'unknown';

export interface ClaudeAuthStatus {
  state: ClaudeAuthState;
  /** 로그인 방식 (claude.ai · console 등). 메일·조직 같은 개인 정보는 담지 않는다 */
  method?: string;
  /** 구독 종류 (pro · max · team 등) */
  plan?: string;
  /** 이 로그인이 쓰는 설정 폴더 */
  configDir?: string;
  /** 로그인 유지 기한 (ms) */
  expiresAt?: number;
}

/** 다시 로그인하는 명령. 설정 폴더를 따로 쓰면 그 폴더로 로그인하게 앞에 붙인다 */
export function claudeLoginCommand(configDir?: string, platform: string = 'darwin'): string {
  if (!configDir) return 'claude auth login';
  if (platform === 'win32') return `set "CLAUDE_CONFIG_DIR=${configDir}" && claude auth login`;
  return `CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, `'\\''`)}' claude auth login`;
}

/** 실행 전·실행 중 로그인 실패를 알리는 문구. 화면은 이 문구를 보면 로그인 명령 복사 버튼을 붙인다 */
export const CLAUDE_AUTH_MESSAGE =
  'Claude Code 로그인이 끊겼습니다. 터미널에서 claude auth login 으로 다시 로그인해 주세요. 앱이 쓰는 로그인은 설정 → Claude Code 연동에서 볼 수 있습니다';

/**
 * `claude auth status`(JSON) 출력을 읽는다. 형식을 모르면 unknown (오래된 claude 는 이 명령이 없다).
 * now 는 시험용
 */
export function parseClaudeAuthStatus(stdout: string, now: number = Date.now()): ClaudeAuthStatus {
  let d: unknown;
  try {
    d = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    return { state: 'unknown' };
  }
  if (!d || typeof d !== 'object' || typeof (d as { loggedIn?: unknown }).loggedIn !== 'boolean') return { state: 'unknown' };
  const o = d as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v && v !== 'none' ? v : undefined);
  const exp = typeof o.loginExpiresAt === 'string' ? Date.parse(o.loginExpiresAt) : NaN;
  const expiresAt = Number.isFinite(exp) ? exp : undefined;
  const state: ClaudeAuthState = !o.loggedIn ? 'none' : expiresAt !== undefined && expiresAt <= now ? 'expired' : 'ok';
  return { state, method: str(o.authMethod), plan: str(o.subscriptionType), configDir: str(o.configDirectory), expiresAt };
}

/** claude 가 낸 글이 로그인 실패인지 (실행 중 토큰이 끊긴 경우) */
export function isClaudeAuthFailure(text: string | undefined): boolean {
  if (!text) return false;
  return /Failed to authenticate|Invalid API key|OAuth token has expired|Please run \/login/i.test(text);
}
