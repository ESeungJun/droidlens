// 계획 에이전트 안내 (#156): Figma 페이지 링크 처리 순서가 문서·앱 프롬프트에 있고, 적힌 도구가 서버에 실제로 있다
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { start } from './harness.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const guide = readFileSync(join(root, 'agents', 'droidlens-qa-planner.md'), 'utf8');
const qaMain = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'qa.ts'), 'utf8');

let s;
before(async () => {
  s = await start();
});
after(async () => {
  await s?.close();
});

test('계획 에이전트 문서의 droidlens 도구는 모두 서버에 있고 figma_outline 을 포함한다', async () => {
  const names = new Set((await s.client.listTools()).tools.map((t) => t.name));
  const line = guide.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  const listed = [...line.matchAll(/mcp__droidlens__([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(listed.includes('figma_outline'));
  assert.deepEqual(listed.filter((n) => !names.has(n)), [], '문서에만 있고 서버에 없는 도구');
});

test('문서에 페이지 링크 처리 순서가 있다: 저장 파일 → figma_outline → 섹션별 → 섹션 묻기 → 못 읽으면 안내', () => {
  const at = guide.indexOf('Figma 페이지·큰 섹션 링크');
  assert.ok(at > 0, '페이지 링크 절');
  const part = guide.slice(at, at + 3000);
  assert.match(part, /Read 로 열지 않는다/);
  assert.match(part, /figma_outline\(file\)/);
  assert.match(part, /figma_outline\(file, section=/, '섹션별로 나눠 보기');
  assert.match(part, /어느 섹션부터 할지 먼저 묻는다/, '대화 중이면 섹션을 묻기');
  assert.match(part, /노드 id 를 만들지 않는다/, '못 읽으면 짐작하지 않기');
  assert.match(part, /node-id=.*PDF/s, '할 일: 프레임 링크·PDF');
});

test('앱의 TC 뽑기 프롬프트도 figma_outline 을 허용하고 쓰라고 안내한다', () => {
  const tools = qaMain.match(/const DROIDLENS_PLANNER_TOOLS = \[([^\]]*)\]/)?.[1] ?? '';
  assert.match(tools, /'figma_outline'/);
  assert.match(qaMain, /파일로 저장됐다는 결과가 오면[^']*figma_outline/);
});
