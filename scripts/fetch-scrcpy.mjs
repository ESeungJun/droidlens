// scrcpy 서버(Apache-2.0)를 내려받아 SHA256을 검증한다. 데스크톱 앱 패키징과 개발 실행에 쓰인다.
// 사용: node scripts/fetch-scrcpy.mjs  →  vendor/scrcpy/scrcpy-server (+ VERSION, LICENSE 안내)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRCPY_VERSION = '5.0.1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'vendor', 'scrcpy');
const out = join(outDir, 'scrcpy-server');
const base = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}`;

if (existsSync(out) && readFileSync(join(outDir, 'VERSION'), 'utf8').trim() === SCRCPY_VERSION) {
  console.log(`scrcpy-server v${SCRCPY_VERSION} 이미 있음`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
const sums = await (await fetch(`${base}/SHA256SUMS.txt`)).text();
const expected = sums.split('\n').find((l) => l.includes(`scrcpy-server-v${SCRCPY_VERSION}`))?.split(/\s+/)[0];
if (!expected) throw new Error('SHA256SUMS.txt에서 서버 해시를 찾지 못했습니다');
const buf = Buffer.from(await (await fetch(`${base}/scrcpy-server-v${SCRCPY_VERSION}`)).arrayBuffer());
const actual = createHash('sha256').update(buf).digest('hex');
if (actual !== expected) throw new Error(`SHA256 불일치: ${actual} != ${expected}`);
writeFileSync(out, buf);
writeFileSync(join(outDir, 'VERSION'), SCRCPY_VERSION + '\n');
writeFileSync(
  join(outDir, 'NOTICE.txt'),
  `scrcpy-server v${SCRCPY_VERSION} — https://github.com/Genymobile/scrcpy\nCopyright (C) 2018 Genymobile, (C) 2018-2026 Romain Vimont\nLicensed under the Apache License, Version 2.0\n`,
);
console.log(`scrcpy-server v${SCRCPY_VERSION} 저장 (${buf.length}B, sha256 ${actual.slice(0, 12)}…)`);
