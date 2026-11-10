// 호스트의 AGENT_VERSION 과 에이전트 APK 의 버전이 어긋나면 호출마다 에이전트를 다시 설치하려 든다. 세 곳이 같은지 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_VERSION } from '../dist/agent.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../../android/agent/${rel}`, import.meta.url)), 'utf8');

test('AGENT_VERSION = build.gradle versionCode = AgentInstrumentation.VERSION', () => {
  const gradle = Number(/versionCode\s+(\d+)/.exec(read('build.gradle'))?.[1]);
  const java = Number(/int VERSION = (\d+);/.exec(read('src/main/java/io/github/eseungjun/droidlens/agent/AgentInstrumentation.java'))?.[1]);
  assert.equal(gradle, AGENT_VERSION);
  assert.equal(java, AGENT_VERSION);
});
