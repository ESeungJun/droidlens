import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as dl from '@droidlens/core';
import { readConfig } from './context';

/**
 * Claude Code 헤드리스 실행(`claude -p --output-format stream-json`). 대화창(chat.ts)과 QA 탭(qa.ts)이 같이 쓴다.
 * 사용자의 기존 Claude Code 로그인(구독)을 그대로 쓰고, DroidLens MCP 서버와 번들된 에이전트를 붙인다.
 */

const run = promisify(execFile);

/** 헤드리스 실행에 주지 않는 Claude Code 내장 도구: 이 컴퓨터의 파일·셸·웹. DroidLens 도구만 쓰면 된다 */
export const BLOCKED_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'];

export interface ClaudeEnv {
  bin: string;
  path: string;
  version: string;
}

let resolved: Promise<ClaudeEnv> | null = null;

/** cmd.exe 에 넘길 인자: 공백·따옴표가 있으면 큰따옴표로 감싼다 */
function winQuote(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** GUI 앱은 셸 PATH를 물려받지 않으므로 로그인 셸에서 claude 위치와 PATH를 한 번 알아낸다 */
export function resolveClaude(): Promise<ClaudeEnv> {
  resolved ??= (async () => {
    if (process.platform === 'win32') {
      const { stdout } = await run('where', ['claude'], { timeout: 10_000 });
      const bin = stdout.split(/\r?\n/)[0].trim();
      const { stdout: v } = await run(winQuote(bin), ['--version'], { timeout: 15_000, shell: true });
      return { bin, path: process.env.PATH ?? '', version: v.trim() };
    }
    const sh = process.env.SHELL || '/bin/zsh';
    // 출력 앞뒤에 표식을 붙여 셸 시작 메시지와 섞이지 않게 한다
    const { stdout } = await run(sh, ['-ilc', 'printf "@@%s@@%s@@" "$(command -v claude)" "$PATH"'], { timeout: 15_000 });
    const m = /@@(.*?)@@(.*?)@@/s.exec(stdout);
    if (!m || !m[1]) throw new Error('claude CLI를 찾지 못했습니다. Claude Code를 설치하고 로그인하세요 (https://claude.com/claude-code)');
    const { stdout: v } = await run(m[1], ['--version'], { timeout: 15_000, env: { ...process.env, PATH: m[2] } });
    return { bin: m[1], path: m[2], version: v.trim() };
  })();
  resolved.catch(() => (resolved = null));
  return resolved;
}

/** 설정에서 고른 Claude Code 설정 폴더 (#120). 없으면 앱이 물려받은 CLAUDE_CONFIG_DIR, 그것도 없으면 기본(~/.claude) */
export async function claudeConfigDir(): Promise<string | undefined> {
  const { claudeConfigDir: v } = await readConfig().catch(() => ({}) as Record<string, unknown>);
  return (typeof v === 'string' && v) || process.env.CLAUDE_CONFIG_DIR || undefined;
}

/** claude 를 실행할 환경: 로그인 셸 PATH + 고른 설정 폴더 */
export async function claudeProcessEnv(c: ClaudeEnv): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: c.path };
  const dir = await claudeConfigDir();
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/** `claude auth status` 로 지금 설정 폴더의 로그인 상태를 읽는다. 명령이 없거나 실패하면 unknown */
export async function claudeAuthStatus(): Promise<dl.ClaudeAuthStatus> {
  const c = await resolveClaude();
  const env = await claudeProcessEnv(c);
  try {
    const { stdout } =
      process.platform === 'win32'
        ? await run(winQuote(c.bin), ['auth', 'status', '--json'], { timeout: 15_000, env, shell: true })
        : await run(c.bin, ['auth', 'status', '--json'], { timeout: 15_000, env });
    return dl.parseClaudeAuthStatus(stdout);
  } catch (e) {
    // 로그인이 안 됐으면 종료 코드 1 로 끝나면서 JSON 을 낼 수 있다
    const out = (e as { stdout?: string }).stdout;
    return out ? dl.parseClaudeAuthStatus(out) : { state: 'unknown' };
  }
}

/** 실행 전 검사: 로그인이 끊겼으면 안내 문구로 막는다 (상태를 모르면 막지 않는다) */
export async function assertClaudeLoggedIn(): Promise<void> {
  const a = await claudeAuthStatus();
  if (a.state === 'none' || a.state === 'expired') throw new Error(dl.CLAUDE_AUTH_MESSAGE);
}

/** 번들된 에이전트 정의(md frontmatter)를 --agents JSON으로 변환 */
async function loadAgents(dir: string): Promise<Record<string, { description: string; prompt: string }>> {
  const out: Record<string, { description: string; prompt: string }> = {};
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.md'))) {
    const text = await readFile(join(dir, f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) continue;
    const meta = Object.fromEntries(
      m[1].split('\n').map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
    if (!meta.name) continue;
    out[meta.name] = {
      description: meta.description ?? '',
      prompt: m[2].trim(),
      // 도구 목록은 지정하지 않는다: 실제 허용 범위는 --allowedTools 로 제한된다
    };
  }
  return out;
}

export type ClaudeEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'toolResult'; id: string; text: string; isError: boolean }
  | { kind: 'done'; sessionId?: string; costUsd?: number; durationMs?: number; error?: string }
  | { kind: 'stderr'; text: string }
  /** 에이전트가 되돌릴 수 없는 조작을 하려 한다. 사용자가 승인·거부를 눌러야 한다 */
  | { kind: 'confirm'; id: string; what: string; serial?: string; app?: string; tool?: string; timeoutMs: number }
  /** 확인 요청이 답 없이 끝났다 (시간 초과로 거부됐거나 실행이 멈춤) */
  | { kind: 'confirmClosed'; id: string; reason: dl.ConfirmClosed };

export interface ClaudeRequest {
  agent: string;
  message: string;
  sessionId?: string;
  /** --append-system-prompt 로 붙일 맥락 */
  context: string;
  /** 미리 허용할 도구. 비대화형이라 여기 없는 도구는 실행되지 않는다 */
  allowedTools: string[];
  /**
   * true(기본)면 DroidLens MCP 서버만 붙인다. false 면 사용자의 Claude Code 커넥터(Confluence·Figma)도 붙지만
   * 실행은 allowedTools 에 넣은 것만 된다
   */
  strictMcp?: boolean;
  /** DroidLens MCP 서버에 더 줄 환경 변수 (DROIDLENS_SERIAL 등) */
  mcpEnv?: Record<string, string>;
  /** 작업 폴더 이름 (~/.droidlens/<이름>) */
  workDir: string;
}

export interface ClaudeContext {
  execPath: string;
  mcpScript: string;
  agentsDir: string;
}

export interface ClaudeHandle {
  /** 실행을 끝낸다. 기다리던 확인은 모두 거부로 끝난다 */
  stop(): void;
  /** 확인 요청에 답한다. 이 실행의 요청이 아니거나 이미 답했으면 false */
  answer(id: string, approve: boolean): boolean;
  /** 프로세스가 끝나면 풀린다 */
  exited: Promise<void>;
}

/** 실행 중 로그인이 끊겨 나온 영어 원문은 한국어 안내로 바꾼다 */
const authHint = (text: string) => (dl.isClaudeAuthFailure(text) ? dl.CLAUDE_AUTH_MESSAGE : text);

/**
 * Windows 에서는 claude.cmd 를 셸(cmd.exe)로 띄우므로 kill() 은 cmd.exe 만 죽이고 실제 claude 는 남는다.
 * 그래서 프로세스 트리째 끝낸다. 그 밖에서는 SIGINT 로 정상 종료를 요청한다
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => undefined);
  else child.kill('SIGINT');
}

/**
 * 헤드리스 실행 하나를 띄운다. 준비하는 사이 cancelled() 가 참이 되면 띄우지 않고 done 을 보낸 뒤 null.
 * 끝나면 done 이벤트가 꼭 한 번 온다
 */
export async function startClaude(
  req: ClaudeRequest,
  ctx: ClaudeContext,
  emit: (e: ClaudeEvent) => void,
  cancelled: () => boolean,
): Promise<ClaudeHandle | null> {
  // 세션 id 는 claude 인자로 넘긴다. Windows 는 셸(cmd.exe)로 실행하므로 UUID 모양만 허용한다
  if (req.sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.sessionId))
    throw new Error('잘못된 대화 세션 id 입니다');
  const claude = await resolveClaude();
  await assertClaudeLoggedIn();
  const agents = await loadAgents(ctx.agentsDir);
  if (!agents[req.agent]) throw new Error(`에이전트를 찾지 못했습니다: ${req.agent}`);
  if (cancelled()) {
    emit({ kind: 'done', sessionId: req.sessionId });
    return null;
  }

  // 되돌릴 수 없는 조작의 확인 통로: 헤드리스 실행은 MCP elicitation 을 쓸 수 없어 MCP 서버가 이 소켓으로 묻고,
  // 화면이 승인·거부 버튼을 보여 준다. 소켓 경로와 토큰은 이 실행의 MCP 서버 환경 변수로만 넘긴다
  const cwd = await dl.ensureDir(req.workDir);
  const runDir = await mkdtemp(join(cwd, 'run-'));
  const confirmSocket =
    process.platform === 'win32' ? `\\\\.\\pipe\\droidlens-confirm-${randomBytes(12).toString('hex')}` : join(runDir, 'c.sock');
  const confirmToken = randomBytes(24).toString('hex');
  const broker = new dl.ConfirmBroker({
    token: confirmToken,
    onRequest: (r) => emit({ kind: 'confirm', ...r, timeoutMs: dl.CONFIRM_TIMEOUT_MS }),
    onClosed: (id, reason) => emit({ kind: 'confirmClosed', id, reason }),
  });
  // 통로를 열지 못하면 MCP 서버는 확인을 받을 수 없다고 보고 그 조작을 실행하지 않는다 (안전한 쪽)
  const confirmReady = await broker.listen(confirmSocket).then(
    () => true,
    () => false,
  );
  if (cancelled()) {
    broker.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    emit({ kind: 'done', sessionId: req.sessionId });
    return null;
  }

  const mcpConfig = {
    mcpServers: {
      droidlens: {
        command: ctx.execPath,
        args: [ctx.mcpScript],
        // 도구를 미리 허용해 두고 호출마다 사람이 승인하지 않는 실행이라, 되돌릴 수 없는 조작(앱 데이터 삭제·DB 쓰기·앱 밖 URI)은
        // MCP 서버가 사용자 확인을 요구하게 한다. 확인은 위의 소켓으로 화면의 승인·거부 버튼이 받는다
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DROIDLENS_CONFIRM: '1',
          ...(confirmReady ? { DROIDLENS_CONFIRM_SOCKET: confirmSocket, DROIDLENS_CONFIRM_TOKEN: confirmToken } : {}),
          ...req.mcpEnv,
        },
      },
    },
  };

  // 복잡한 인자(JSON·여러 줄 프롬프트)는 파일과 표준 입력으로 넘긴다. Windows 에서 claude.cmd 는 셸로 실행해야 하는데
  // cmd.exe 가 JSON 의 따옴표·공백을 망가뜨리므로, 셸에는 공백 없는 단순 토큰과 따옴표로 감싼 파일 경로만 남긴다.
  const mcpFile = join(runDir, 'mcp.json');
  const agentsFile = join(runDir, 'agents.json');
  const promptFile = join(runDir, 'system.txt');
  await Promise.all([
    writeFile(mcpFile, JSON.stringify(mcpConfig)),
    writeFile(agentsFile, JSON.stringify(agents)),
    writeFile(promptFile, req.context),
  ]);
  const win = process.platform === 'win32';
  const path = (p: string) => (win ? winQuote(p) : p);
  const tokens = (xs: string[]) => {
    // 셸로 넘기는 도구 이름은 공백·따옴표 없는 토큰만 (Windows cmd.exe)
    for (const x of xs) if (!/^[\w*.:-]+$/.test(x)) throw new Error(`도구 이름 형식이 아닙니다: ${x}`);
    return xs.join(',');
  };

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // 사용자 전역 설정의 훅·플러그인(메모리 플러그인 등)이 앱 실행에 끼어들지 않게 프로젝트 설정만 쓴다 (로그인은 그대로)
    '--setting-sources',
    'project',
    '--mcp-config',
    path(mcpFile),
    ...(req.strictMcp === false ? [] : ['--strict-mcp-config']),
    '--agents',
    path(agentsFile),
    '--agent',
    req.agent,
    // 비대화형이라 권한 확인 창을 띄울 수 없으므로 쓸 도구만 미리 허용한다
    '--allowedTools',
    tokens(req.allowedTools),
    // 읽기 전용 내장 도구(Read·Glob·Grep)는 -p 에서도 허용 목록과 상관없이 실행되므로 따로 뺀다.
    // 기기 화면·문서에 섞인 지시문으로 이 컴퓨터의 파일을 읽어 밖으로 흘리지 못하게 한다
    `--disallowedTools=${BLOCKED_BUILTIN_TOOLS.join(',')}`,
    '--append-system-prompt-file',
    path(promptFile),
  ];
  if (req.sessionId) args.push('--resume', req.sessionId);

  const child = spawn(win ? winQuote(claude.bin) : claude.bin, args, {
    cwd,
    env: await claudeProcessEnv(claude),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: win,
  });
  // 사용자 메시지는 표준 입력으로 (-p 는 인자가 없으면 stdin 을 프롬프트로 읽는다)
  child.stdin!.end(req.message);
  let resolveExit!: () => void;
  const exited = new Promise<void>((r) => (resolveExit = r));

  let buf = '';
  let sessionId = req.sessionId;
  let doneSent = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'system' && ev.subtype === 'init') {
        sessionId = ev.session_id;
        emit({ kind: 'session', sessionId: ev.session_id, model: ev.model });
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          // 로그인 실패는 claude 가 답처럼 영어 원문을 내고 result 로도 낸다. 답으로는 보이지 않고 아래 done 에서 안내로 바꾼다
          if (c.type === 'text' && c.text && !(ev.error && dl.isClaudeAuthFailure(c.text))) emit({ kind: 'text', text: c.text });
          else if (c.type === 'tool_use') emit({ kind: 'tool', id: c.id, name: c.name, input: c.input });
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content ?? []) {
          if (c.type !== 'tool_result') continue;
          const text = Array.isArray(c.content)
            ? c.content.map((x: any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')
            : String(c.content ?? '');
          emit({ kind: 'toolResult', id: c.tool_use_id, text, isError: !!c.is_error });
        }
      } else if (ev.type === 'result') {
        doneSent = true;
        emit({
          kind: 'done',
          sessionId: ev.session_id ?? sessionId,
          costUsd: ev.total_cost_usd,
          durationMs: ev.duration_ms,
          error: ev.is_error ? authHint(String(ev.result ?? ev.subtype)) : undefined,
        });
      }
    }
  });
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('close', (code) => {
    broker.close();
    void rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    if (!doneSent) emit({ kind: 'done', sessionId, error: code ? authHint(stderr.trim().slice(-600)) || `종료 코드 ${code}` : undefined });
    resolveExit();
  });
  child.on('error', (e) => {
    broker.close();
    if (!doneSent) emit({ kind: 'done', sessionId, error: e.message });
    doneSent = true;
    resolveExit();
  });

  return {
    stop() {
      killTree(child);
      broker.close();
      // SIGINT 로 끝나지 않으면 강제로 끝낸다 (사람이 지켜보지 않는 QA 회차가 멈춘 채 남지 않게)
      const force = setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 10_000);
      void exited.then(() => clearTimeout(force));
    },
    answer: (id, approve) => typeof id === 'string' && broker.answer(id, approve === true),
    exited,
  };
}
