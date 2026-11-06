// 리포트 문구 비밀값 가리기 규칙 (packages/core/src/redact.ts). 빌드 결과(dist)를 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecretName, redactValue, redactUrl, redactSql, MASK } from '../dist/redact.js';

test('isSecretName: 비밀 칸 이름은 잡고, 단어 안에 섞인 짧은 말은 잡지 않는다', () => {
  for (const n of ['password', 'userPassword', 'auth_code', 'authCode', 'api-key', 'pin', 'session_id', '휴대폰번호', 'cardNumber']) {
    assert.equal(isSecretName(n), true, n);
  }
  for (const n of ['spinner', 'keyword', 'author', 'theme', 'nickname', undefined, '']) {
    assert.equal(isSecretName(n), false, String(n));
  }
});

test('redactValue: 비밀 키·토큰 모양·긴 값만 가린다', () => {
  assert.equal(redactValue('theme', 'dark'), 'dark');
  assert.equal(redactValue('auth_token', 'abc'), `${MASK} (3자)`);
  assert.equal(redactValue('note', 'eyJhbGciOiJIUzI1NiJ9.x.y'), `${MASK} (24자)`);
  assert.equal(redactValue('note', '{"a":1}'), `${MASK} (7자)`);
  assert.equal(redactValue('note', 'x'.repeat(41)), `${MASK} (41자)`);
  assert.equal(redactValue('note', 'hello world'), 'hello world');
});

test('redactUrl: 구조는 남기고 값만 가린다', () => {
  const cases = [
    ['myapp://reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', `myapp://reset/${MASK}`],
    ['https://u:p@ss@host/x', `https://${MASK}@host/x`],
    ['https://a.com/p?q=1&flag#frag', `https://a.com/p?q=${MASK}&${MASK}#${MASK}`],
    ['mailto:a@b.com', `mailto:${MASK}`],
    ['https://a.com/x;jsessionid=AB12?x=1', `https://a.com/x;jsessionid=${MASK}?x=${MASK}`],
    ['myapp://home/detail/42', 'myapp://home/detail/42'],
  ];
  for (const [input, want] of cases) assert.equal(redactUrl(input), want, input);
});

test('redactSql: 리터럴만 ? 로 바꾸고 이름은 남긴다', () => {
  assert.equal(
    redactSql(`UPDATE t1 SET token='x''y' WHERE id=3 AND v IN ("a", 0x1F, 1e5)`),
    'UPDATE t1 SET token=? WHERE id=? AND v IN (?, ?, ?)',
  );
  assert.equal(redactSql(`INSERT INTO kv VALUES (x'DEADBEEF', -2.5)`), 'INSERT INTO kv VALUES (?, ?)');
});
