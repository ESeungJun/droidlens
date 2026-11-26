import { clipboard, nativeTheme, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import * as dl from '@droidlens/core';
import { resolveClaude } from '../claude';
import { adb, agentsSrc, dev, getWindow, mcpScript, resetAdb, send, updateConfig, windowBackground, type Handle } from '../context';
import { checkForUpdate, currentVersion, installUpdate, type UpdateInfo } from '../updater';

/** 설정 탭: 앱 버전·업데이트·adb 경로·테마·Claude Code 연동(MCP·에이전트 설치)·온디바이스 에이전트·클립보드·외부 링크 */

const run = promisify(execFile);
const agentsDst = () => join(homedir(), '.claude', 'agents');
const q = (s: string) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

function mcpAddArgs(): string[] {
  return ['mcp', 'add', '--scope', 'user', 'droidlens', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', process.execPath, mcpScript()];
}

/** GUI 앱은 로그인 셸 PATH를 못 받으므로 로그인 셸을 거쳐 claude를 실행한다 */
async function runClaude(args: string[]): Promise<string> {
  // claude 위치·PATH는 resolveClaude()가 로그인 셸에서 한 번만 찾아 캐시한다 (매번 로그인 셸을 띄우면 수 초씩 걸림)
  const c = await resolveClaude();
  const env = { ...process.env, PATH: c.path };
  if (process.platform === 'win32') {
    // claude.cmd 는 셸로 실행해야 하는데, shell 모드에서는 Node 가 인자를 따옴표 없이 이어 붙인다.
    // 'C:\Program Files\DroidLens\DroidLens.exe' 같은 공백 경로가 깨지지 않게 직접 감싼다
    const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const { stdout } = await run(quote(c.bin), args.map(quote), { timeout: 30_000, env, shell: true });
    return stdout;
  }
  const { stdout } = await run(c.bin, args, { timeout: 30_000, env });
  return stdout;
}

/** user 범위 MCP 등록 여부. `claude mcp list`는 등록된 서버를 하나씩 띄워 검사해 느리므로 설정 파일을 직접 읽는다 */
async function droidlensRegistered(): Promise<boolean> {
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    return !!cfg.mcpServers?.droidlens;
  } catch {
    return false;
  }
}

/** 테마. themeSource 가 렌더러의 prefers-color-scheme 이 되어 화면 색과 OS 화면(파일 대화상자·창 배경)이 함께 바뀐다 */
export const isThemeSource = (v: unknown): v is typeof nativeTheme.themeSource => v === 'system' || v === 'light' || v === 'dark';

export function register(handle: Handle): void {
  handle('appVersion', async () => currentVersion());
  handle('platform', async () => ({ platform: process.platform, arch: process.arch }));
  handle('updateCheck', () => checkForUpdate());
  handle('updateInstall', async (info: UpdateInfo) => {
    // 렌더러가 넘긴 정보 대신 다시 확인한 결과로 설치한다 (다운로드 URL을 렌더러에서 받지 않음)
    const fresh = await checkForUpdate();
    if (!fresh.available || fresh.latest !== info.latest) throw new Error('설치할 업데이트가 없습니다');
    // 로그·미러·대화는 설치를 예약한 뒤 app.quit() 의 종료 정리(stopAll)에서 멈춘다. 다운로드가 실패하면 그대로 쓸 수 있다
    await installUpdate(fresh, (p, message) => send('update:progress', { p, message }));
  });
  handle('adbStatus', async () => ({ ...(await adb().version()), candidates: dl.adbCandidates() }));
  handle('setAdbPath', async (p: string) => {
    // 여기 등록한 파일은 앱이 계속 실행하므로 adb 실행 파일 경로만 받는다 (비우면 자동 탐색)
    if (p && !(isAbsolute(p) && /^adb(\.exe)?$/i.test(basename(p)))) throw new Error('adb 실행 파일의 전체 경로를 입력하세요 (파일 이름이 adb 또는 adb.exe)');
    await updateConfig({ adbPath: p || undefined });
    return resetAdb().version();
  });
  handle('setTheme', async (t: unknown) => {
    if (!isThemeSource(t)) throw new Error('잘못된 테마');
    if (nativeTheme.themeSource === t) return;
    nativeTheme.themeSource = t;
    getWindow()?.setBackgroundColor(windowBackground());
    await updateConfig({ theme: t });
  });
  handle('integration', async () => {
    const src = agentsSrc();
    const agents = existsSync(src) ? (await readdir(src)).filter((f) => f.endsWith('.md')) : [];
    let claudeVersion: string | null = null;
    const registered = await droidlensRegistered();
    try {
      claudeVersion = (await resolveClaude()).version;
    } catch {
      /* claude CLI 없음 */
    }
    return {
      mcpScript: mcpScript(),
      mcpScriptExists: existsSync(mcpScript()),
      command: ['claude', ...mcpAddArgs()].map((a) => (/[\s'"]/.test(a) ? q(a) : a)).join(' '),
      claudeVersion,
      registered,
      agents: agents.map((f) => ({ file: f, installed: existsSync(join(agentsDst(), f)) })),
      agentsDir: agentsDst(),
    };
  });
  handle('registerMcp', async () => {
    await runClaude(['mcp', 'remove', '--scope', 'user', 'droidlens']).catch(() => undefined);
    return runClaude(mcpAddArgs());
  });
  handle('installAgents', async () => {
    await mkdir(agentsDst(), { recursive: true });
    const files = (await readdir(agentsSrc())).filter((f) => f.endsWith('.md'));
    for (const f of files) await copyFile(join(agentsSrc(), f), join(agentsDst(), f));
    return files;
  });
  handle('copy', async (t: string) => clipboard.writeText(t));
  handle('openExternal', async (url: string) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  });

  // 온디바이스 에이전트
  handle('agentStatus', (s: string) => dl.agentStatus(dev(s)));
  handle('agentStart', async (s: string) => {
    await dl.ensureAgent(dev(s), { force: true });
    return dl.agentStatus(dev(s));
  });
  handle('agentStop', async (s: string) => {
    await dl.stopAgent(dev(s));
    return dl.agentStatus(dev(s));
  });
}
