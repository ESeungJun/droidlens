// figma_outline (#156): Claude Code 가 저장한 큰 Figma get_metadata 응답에서 프레임 목록만, 그 밖의 파일은 거부
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './harness.mjs';

const config = mkdtempSync(join(tmpdir(), 'droidlens-claude-'));
const results = join(config, 'projects', '-Users-me--droidlens-qa', 'sess-1', 'tool-results');
mkdirSync(results, { recursive: true });
const file = join(results, 'mcp-claude_ai_Figma-get_metadata-1795755153297-abc123.txt');
const xml =
  '<canvas id="1:1" name="샘플 페이지"><section id="2:1" name="온보딩">' +
  '<frame id="10:1" name="첫 화면" x="0" y="0" width="360" height="800"><text id="10:2" name="안쪽 글자" x="0" y="0" width="1" height="1" /></frame>' +
  '<frame id="11:1" name="둘째 화면" x="400" y="0" width="360" height="800" /></section></canvas>';
writeFileSync(file, JSON.stringify([{ type: 'text', text: xml }]));
const outside = join(config, 'settings.json');
writeFileSync(outside, '{"secret":"x"}');

let s;
before(async () => {
  s = await start({ CLAUDE_CONFIG_DIR: config });
});
after(async () => {
  await s?.close();
  rmSync(config, { recursive: true, force: true });
});

test('저장된 Figma 응답 파일에서 섹션별 프레임 목록만 돌려준다', async () => {
  const r = await s.call('figma_outline', { file });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /섹션 2:1 "온보딩" \(2개\)/);
  assert.match(r.text, /10:1 frame 360x800 "첫 화면"/);
  assert.doesNotMatch(r.text, /안쪽 글자/);
});

test('Claude 설정 폴더 tool-results 의 Figma 응답이 아니면 읽지 않는다', async () => {
  const r = await s.call('figma_outline', { file: outside });
  assert.equal(r.isError, true);
  assert.match(r.text, /읽지 않/);
  assert.doesNotMatch(r.text, /secret/);
});
