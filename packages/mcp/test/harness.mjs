// MCP 서버를 가짜 adb 로 띄워 도구를 실제 프로토콜로 부르는 시험 도우미
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_ADB = join(here, 'fake-adb.mjs');
export const SERVER = join(here, '..', 'dist', 'index.js');

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** 시험용 노드 → uiautomator dump XML. n: { cls, id, text, desc, bounds:[l,t,r,b], clickable, focused, password, children } */
export function ui(...nodes) {
  const one = (n) =>
    `<node class="${attr(n.cls ?? 'android.widget.TextView')}" resource-id="${attr(n.id ? `com.example.app:id/${n.id}` : '')}" text="${attr(n.text ?? '')}" content-desc="${attr(n.desc ?? '')}" package="com.example.app" bounds="[${n.bounds[0]},${n.bounds[1]}][${n.bounds[2]},${n.bounds[3]}]" clickable="${!!n.clickable}" long-clickable="false" scrollable="${!!n.scrollable}" focusable="true" focused="${!!n.focused}" enabled="true" checkable="false" checked="false" selected="false" password="${!!n.password}">${(n.children ?? []).map(one).join('')}</node>`;
  return `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0"><node class="android.widget.FrameLayout" resource-id="" text="" content-desc="" package="com.example.app" bounds="[0,0][1080,2400]" clickable="false" long-clickable="false" scrollable="false" focusable="false" focused="false" enabled="true" checkable="false" checked="false" selected="false" password="false">${nodes.map(one).join('')}</node></hierarchy>`;
}

/**
 * 가짜 기기 하나와 MCP 서버를 띄운다. 온디바이스 에이전트는 끈다(DROIDLENS_AGENT=0) — uiautomator 경로만 탄다.
 * env 로 서버 환경 변수를 더한다
 */
export async function start(env = {}) {
  if (process.platform !== 'win32') chmodSync(FAKE_ADB, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'droidlens-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      PATH: process.env.PATH ?? '',
      ADB_PATH: FAKE_ADB,
      FAKE_ADB_DIR: dir,
      DROIDLENS_HOME: join(dir, 'home'),
      DROIDLENS_AGENT: '0',
      DROIDLENS_SERIAL: 'fake',
      ...env,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return {
    dir,
    client,
    setUi: (xml) => writeFileSync(join(dir, 'ui.xml'), xml),
    setFile: (name, body) => writeFileSync(join(dir, name), body),
    /** 기기로 간 명령 (한 줄에 하나) */
    log: () => (existsSync(join(dir, 'log.txt')) ? readFileSync(join(dir, 'log.txt'), 'utf8').split('\n').filter(Boolean) : []),
    clearLog: () => rmSync(join(dir, 'log.txt'), { force: true }),
    /** 도구 호출 → { text, isError, content } */
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      return { text: (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError, content: r.content ?? [] };
    },
    async close() {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
