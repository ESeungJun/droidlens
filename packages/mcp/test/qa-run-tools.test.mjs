// 회차 실행 에이전트의 허용 도구 (#140): 모든 MCP 도구가 '회차 허용'과 '회차 금지' 중 정확히 한쪽에 있어야 한다.
// 새 도구를 더하면 이 시험이 실패해서, 회차 에이전트에게 줄지 말지를 정하게 한다
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as dl from '@droidlens/core';
import { start } from './harness.mjs';

let s;
before(async () => {
  s = await start();
});
after(async () => {
  await s?.close();
});

test('모든 MCP 도구가 회차 허용·금지 중 정확히 한쪽에 있다', async () => {
  const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
  const allow = new Set(dl.QA_RUN_TOOLS);
  const deny = new Set(dl.QA_RUN_DENIED_TOOLS);
  const both = names.filter((n) => allow.has(n) && deny.has(n));
  const none = names.filter((n) => !allow.has(n) && !deny.has(n));
  assert.deepEqual(both, [], '두 쪽에 다 있는 도구');
  assert.deepEqual(none, [], '어느 쪽에도 없는 도구 (회차 에이전트에 줄지 정해서 한쪽에 넣기)');
  const stale = [...allow, ...deny].filter((n) => !names.includes(n));
  assert.deepEqual(stale, [], '목록에만 있고 서버에 없는 도구');
});

test('계획을 바꾸거나 허용을 켜는 도구는 회차 에이전트에 주지 않는다', () => {
  for (const n of ['qa_plan_save', 'qa_case_update', 'qa_source_add', 'qa_plan_create', 'qa_case_allow', 'design_guide_save', 'qa_run_scripts'])
    assert.ok(dl.QA_RUN_DENIED_TOOLS.includes(n), n);
  for (const n of ['scenario_start', 'scenario_step', 'scenario_finish', 'tap', 'qa_case_result', 'design_compare', 'graph_get'])
    assert.ok(dl.QA_RUN_TOOLS.includes(n), n);
  assert.ok(dl.qaRunAllowedTools().every((t) => /^mcp__droidlens__[a-z0-9_]+$/.test(t)));
  assert.equal(dl.qaRunAllowedTools().length, dl.QA_RUN_TOOLS.length);
});

test('회차 에이전트는 TC 통과 뒤 스크립트를 다시 돌리거나 고치지 않는다 (#148)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const n of ['script_run', 'script_write']) assert.ok(dl.QA_RUN_DENIED_TOOLS.includes(n), n);
  // 에이전트 안내에도 다시 돌리기 단계가 없다
  const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'agents', 'droidlens-verifier.md'), 'utf8');
  const tcMode = doc.slice(doc.indexOf('## QA 계획의 TC 실행'));
  assert.ok(!/저장한 스크립트를 한 번 다시 돌린다/.test(tcMode), 'TC 모드에 다시 돌리기 단계가 남아 있다');
});
