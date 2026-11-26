// Claude Code 로그인 상태 읽기 (#120)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeAuthStatus, isClaudeAuthFailure, claudeLoginCommand, CLAUDE_AUTH_MESSAGE } from '../dist/claude-auth.js';

const NOW = Date.parse('2026-11-26T09:00:00Z');

test('로그인 안 된 설정 폴더는 none', () => {
  const a = parseClaudeAuthStatus(
    JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: '/Users/u/.claude', loginExpiresAt: null }),
    NOW,
  );
  assert.equal(a.state, 'none');
  assert.equal(a.method, undefined, "'none' 은 방식으로 보이지 않음");
  assert.equal(a.configDir, '/Users/u/.claude');
});

test('로그인됨은 방식·구독·기한만 담고 메일·조직은 버린다', () => {
  const a = parseClaudeAuthStatus(
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'team', email: 'a@b.c', orgName: 'X', loginExpiresAt: '2026-12-08T02:51:52.807Z' }),
    NOW,
  );
  assert.equal(a.state, 'ok');
  assert.equal(a.method, 'claude.ai');
  assert.equal(a.plan, 'team');
  assert.equal(a.expiresAt, Date.parse('2026-12-08T02:51:52.807Z'));
  assert.doesNotMatch(JSON.stringify(a), /a@b\.c|"X"/);
});

test('유지 기한이 지났으면 expired', () => {
  const a = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, loginExpiresAt: '2026-11-01T00:00:00Z' }), NOW);
  assert.equal(a.state, 'expired');
});

test('형식을 모르면 unknown (앞에 다른 글이 붙어도 JSON 부분은 읽음)', () => {
  assert.equal(parseClaudeAuthStatus('error: unknown command auth').state, 'unknown');
  assert.equal(parseClaudeAuthStatus('{"foo":1}').state, 'unknown');
  assert.equal(parseClaudeAuthStatus('경고 줄\n{"loggedIn":false}').state, 'none');
});

test('실행 중 로그인 실패 글을 알아본다', () => {
  assert.ok(isClaudeAuthFailure('Failed to authenticate: this login reached its time limit and cannot be renewed.'));
  assert.ok(isClaudeAuthFailure('Invalid API key · Please run /login'));
  assert.ok(!isClaudeAuthFailure('기기를 찾지 못했습니다'));
  assert.ok(!isClaudeAuthFailure(undefined));
  assert.ok(!isClaudeAuthFailure(CLAUDE_AUTH_MESSAGE), '안내 문구를 다시 바꾸지 않음');
});

test('로그인 명령은 설정 폴더를 따로 쓰면 그 폴더로 로그인하게 붙인다', () => {
  assert.equal(claudeLoginCommand(), 'claude auth login');
  assert.equal(claudeLoginCommand("/Users/u/it's/home"), `CLAUDE_CONFIG_DIR='/Users/u/it'\\''s/home' claude auth login`);
  assert.equal(claudeLoginCommand('C:\\cfg', 'win32'), 'set "CLAUDE_CONFIG_DIR=C:\\cfg" && claude auth login');
});
