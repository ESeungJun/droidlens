import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as dl from '@droidlens/core';

/**
 * 앱 안의 에이전트 대화창. Claude Code를 헤드리스(`claude -p --output-format stream-json`)로 실행해
 * 사용자의 기존 Claude Code 로그인(구독)을 그대로 쓰고, DroidLens MCP 서버와 전용 에이전트를 붙인다.
 * 대화는 --resume <session_id>로 이어간다.
 */

const run = promisify(execFile);

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
      // 도구 목록은 지정하지 않는다: 실제 허용 범위는 --strict-mcp-config + --allowedTools(DroidLens 도구만)로 제한된다
    };
  }
  return out;
}

export type ChatEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'toolResult'; id: string; text: string; isError: boolean }
  | { kind: 'done'; sessionId?: string; costUsd?: number; durationMs?: number; error?: string }
  | { kind: 'stderr'; text: string };

export interface ChatRequest {
  message: string;
  agent: string;
  sessionId?: string;
  serial?: string;
  packageName?: string;
}

let current: ChildProcess | null = null;
// 실행 세대. claude 를 찾고 에이전트를 불러오는 동안(프로세스가 아직 없을 때) 누른 중지도 반영하려고 쓴다
let generation = 0;

export function stopChat(): void {
  generation++;
  current?.kill('SIGINT');
  current = null;
}

export async function sendChat(
  req: ChatRequest,
  ctx: { execPath: string; mcpScript: string; agentsDir: string },
  emit: (e: ChatEvent) => void,
): Promise<void> {
  stopChat();
  const mine = ++generation;
  const claude = await resolveClaude();
  const agents = await loadAgents(ctx.agentsDir);
  if (!agents[req.agent]) throw new Error(`에이전트를 찾지 못했습니다: ${req.agent}`);
  // 준비하는 사이 중지됐으면 프로세스를 띄우지 않는다
  if (mine !== generation) {
    emit({ kind: 'done', sessionId: req.sessionId });
    return;
  }

  const mcpConfig = {
    mcpServers: {
      droidlens: {
        command: ctx.execPath,
        args: [ctx.mcpScript],
        env: { ELECTRON_RUN_AS_NODE: '1', ...(req.serial ? { DROIDLENS_SERIAL: req.serial } : {}) },
      },
    },
  };
  const context = [
    '이 대화는 DroidLens 데스크톱 앱의 에이전트 대화창에서 진행된다. 사용자는 같은 화면에서 기기 미러링을 보고 있다.',
    req.serial ? `연결된 기기 serial: ${req.serial}` : '연결된 기기 없음',
    req.packageName ? `사용자가 선택한 앱: ${req.packageName}` : '',
    '답변은 한국어로, 짧고 구체적으로.',
  ]
    .filter(Boolean)
    .join('\n');

  // 복잡한 인자(JSON·여러 줄 프롬프트)는 파일과 표준 입력으로 넘긴다. Windows 에서 claude.cmd 는 셸로 실행해야 하는데
  // cmd.exe 가 JSON 의 따옴표·공백을 망가뜨리므로, 셸에는 공백 없는 단순 토큰과 따옴표로 감싼 파일 경로만 남긴다.
  const cwd = await dl.ensureDir('chat');
  const runDir = await mkdtemp(join(cwd, 'run-'));
  const mcpFile = join(runDir, 'mcp.json');
  const agentsFile = join(runDir, 'agents.json');
  const promptFile = join(runDir, 'system.txt');
  await Promise.all([
    writeFile(mcpFile, JSON.stringify(mcpConfig)),
    writeFile(agentsFile, JSON.stringify(agents)),
    writeFile(promptFile, context),
  ]);
  const win = process.platform === 'win32';
  const path = (p: string) => (win ? winQuote(p) : p);

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // 사용자 전역 설정의 훅·플러그인(메모리 플러그인 등)이 앱 대화에 끼어들지 않게 프로젝트 설정만 쓴다 (로그인은 그대로)
    '--setting-sources',
    'project',
    '--mcp-config',
    path(mcpFile),
    '--strict-mcp-config',
    '--agents',
    path(agentsFile),
    '--agent',
    req.agent,
    // 비대화형이라 권한 확인 창을 띄울 수 없으므로 DroidLens 도구만 미리 허용한다
    '--allowedTools',
    'mcp__droidlens__*',
    '--append-system-prompt-file',
    path(promptFile),
  ];
  if (req.sessionId) args.push('--resume', req.sessionId);

  const child = spawn(win ? winQuote(claude.bin) : claude.bin, args, {
    cwd,
    env: { ...process.env, PATH: claude.path },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: win,
  });
  // 사용자 메시지는 표준 입력으로 (-p 는 인자가 없으면 stdin 을 프롬프트로 읽는다)
  child.stdin!.end(req.message);
  child.on('close', () => rm(runDir, { recursive: true, force: true }).catch(() => undefined));
  current = child;

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
          if (c.type === 'text' && c.text) emit({ kind: 'text', text: c.text });
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
          error: ev.is_error ? String(ev.result ?? ev.subtype) : undefined,
        });
      }
    }
  });
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('close', (code) => {
    if (current === child) current = null;
    if (!doneSent) emit({ kind: 'done', sessionId, error: code ? stderr.trim().slice(-600) || `종료 코드 ${code}` : undefined });
  });
}
