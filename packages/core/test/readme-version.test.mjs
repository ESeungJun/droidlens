// README 의 SDK 의존성 버전이 낡으면 문서대로 넣었을 때 README 가 설명하는 기능(네트워크 목 등)이 없다.
// 릴리스에서 버전을 올릴 때 README 도 같이 올리게 한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (rel) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

test('README 의 SDK 버전이 패키지 버전과 같다', () => {
  const version = JSON.parse(root('package.json')).version;
  for (const f of ['README.ko.md', 'README.md']) {
    const found = [...root(f).matchAll(/droidlens:sdk(?:-noop)?:v([\d.]+)/g)].map((m) => m[1]);
    assert.equal(found.length, 2, f);
    for (const v of found) assert.equal(v, version, `${f} 의 SDK 버전`);
  }
});
