// MCP 서버를 가짜 adb 로 띄워 도구를 실제 프로토콜로 부르는 시험 도우미
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
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
export async function start(env = {}, opts = {}) {
  if (process.platform !== 'win32') chmodSync(FAKE_ADB, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'droidlens-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
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

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/** 단색 PNG (가짜 기기의 스크린샷용) */
export function solidPng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
