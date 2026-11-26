// 난독화 추정 (#111): R8 이 한 패키지에 모은 소문자 3~4글자 이름도 난독화 이름으로 센다
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { obfuscationStats } = await import('../dist/libraries.js');

/** 소문자 n글자 이름을 a, b, …, aa, … 순서로 count 개 만든다(R8 이름 짓기와 같은 순서) */
function r8Names(count, minLen = 1) {
  const out = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let len = minLen; out.length < count; len++) {
    const idx = new Array(len).fill(0);
    while (out.length < count) {
      out.push(idx.map((i) => letters[i]).join(''));
      let k = len - 1;
      while (k >= 0 && ++idx[k] === 26) idx[k--] = 0;
      if (k < 0) break;
    }
  }
  return out;
}

const camel = (n) => Array.from({ length: n }, (_, i) => `com.example.app.feature${i % 7}.Screen${i}ViewModel`);

test('R8 이 한 패키지로 모은 3~4글자 소문자 이름이 대부분이면 난독화로 본다', () => {
  // 실제 캘린더 앱 모양: 1~2글자는 거의 다 쓰고 3~4글자가 대부분
  const repack = r8Names(4000, 3).map((n) => `cal.${n}`);
  const libs = camel(600);
  const s = obfuscationStats([...repack, ...libs]);
  assert.equal(s.likelyObfuscated, true);
  assert.ok(s.shortNameRatio > 0.8, `비율 ${s.shortNameRatio}`);
});

test('CamelCase 이름만 있으면 난독화가 아니다', () => {
  const s = obfuscationStats([...camel(500), 'kotlin.collections.CollectionsKt', 'okhttp3.OkHttpClient', 'okhttp3.OkHttpClient$Builder']);
  assert.equal(s.likelyObfuscated, false);
  assert.equal(s.shortNameRatio, 0);
});

test('경계: 소문자 4글자까지 세고 5글자는 세지 않는다. 대문자 섞인 3글자 이상도 세지 않는다', () => {
  const s4 = obfuscationStats(['p.abcd', 'p.abcd$a', 'p.xyz', 'p.Foo']);
  assert.equal(s4.shortNameRatio, 0.75, '4글자·내부 클래스·3글자는 세고 Foo 는 빼고');
  const s5 = obfuscationStats(['p.abcde', 'p.abcde$a', 'p.Abcd', 'p.ABC']);
  assert.equal(s5.shortNameRatio, 0, '5글자 소문자, 대문자 섞인 이름은 세지 않음');
});

test('1~2글자 이름은 대소문자 상관없이 예전처럼 센다', () => {
  const s = obfuscationStats(['a.b.A', 'a.b.Ab', 'a.b.ab$c', 'a.b.MainActivity']);
  assert.equal(s.shortNameRatio, 0.75);
});

test('빈 목록이면 0, 기준값(0.25·0.1)은 그대로', () => {
  assert.deepEqual(obfuscationStats([]), { shortNameRatio: 0, likelyObfuscated: false, minified: false });
  const at = (k, n) => obfuscationStats([...r8Names(k, 3).map((x) => `p.${x}`), ...camel(n - k)]);
  assert.equal(at(25, 100).likelyObfuscated, false, '정확히 25% 는 아님');
  assert.equal(at(26, 100).likelyObfuscated, true);
  assert.equal(at(10, 100).minified, false);
  assert.equal(at(11, 100).minified, true);
});
