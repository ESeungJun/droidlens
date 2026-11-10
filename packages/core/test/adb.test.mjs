// adb 실패 메시지 분류와 APK 설치 실패 안내 (순수 함수)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAdbFailure, describeAdbArgs, quoteShell } from '../dist/adb.js';
import { installFailure, assertPackage, deepLinkNeedsConfirm } from '../dist/app.js';

const S = ['-s', 'R5X', 'shell', 'input tap 1 2'];

test('describeAdbFailure: 원인별로 할 일을 알려 준다', () => {
  const off = describeAdbFailure(S, 'adb: device offline\n', { message: 'Command failed', code: 1 }, 30_000);
  assert.equal(off.kind, 'offline');
  assert.match(off.message, /기기 R5X 연결이 끊겼습니다/);
  const gone = describeAdbFailure(S, "adb: device 'R5X' not found\n", { message: 'x', code: 1 }, 30_000);
  assert.equal(gone.kind, 'offline');
  assert.equal(describeAdbFailure(['devices'], 'error: no devices/emulators found', { message: 'x', code: 1 }, 1).kind, 'offline');
  const un = describeAdbFailure(S, 'error: device unauthorized.\nThis adb server\'s $ADB_VENDOR_KEYS is not set', { message: 'x', code: 1 }, 30_000);
  assert.equal(un.kind, 'unauthorized');
  assert.match(un.message, /USB 디버깅 허용/);
  const to = describeAdbFailure(S, '', { message: 'Command failed: /path/adb -s R5X shell input tap 1 2', killed: true }, 20_000);
  assert.equal(to.kind, 'timeout');
  assert.match(to.message, /20초 안에 끝나지 않았습니다/);
  assert.equal(describeAdbFailure(S, '', { message: 'spawn adb ENOENT', code: 'ENOENT' }, 1).kind, 'no-adb');
});

test('describeAdbFailure: 그 밖의 실패는 stderr 를 그대로, 비면 종료 코드만 (명령을 두 번 쓰지 않는다)', () => {
  const a = describeAdbFailure(S, 'adb: failed to install x.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]\n', { message: 'x', code: 1 }, 1);
  assert.equal(a.kind, 'other');
  assert.match(a.message, /INSTALL_FAILED_VERSION_DOWNGRADE/);
  const b = describeAdbFailure(S, '', { message: 'Command failed: /path/adb -s R5X shell input tap 1 2', code: 255 }, 1);
  assert.equal(b.message, 'adb -s R5X shell input tap 1 2 실패: 종료 코드 255');
});

test('describeAdbFailure: 기기 셸 출력에 섞인 말은 연결 문제로 보지 않는다', () => {
  const r = describeAdbFailure(S, 'cat: /sdcard/device offline notes.txt: No such file\nUser is unauthorized\n', { message: 'x', code: 1 }, 1);
  assert.equal(r.kind, 'other');
});

test('describeAdbArgs: 80자에서 자르고 입력한 글자는 싣지 않는다', () => {
  assert.equal(describeAdbArgs(['-s', 'X', 'shell', "input text 'hunter2-password'"]), '-s X shell input text …');
  const long = describeAdbArgs(['shell', 'x'.repeat(200)]);
  assert.equal(long.length, 81);
  assert.ok(long.endsWith('…'));
});

test('quoteShell·assertPackage: 기기 셸로 가는 값', () => {
  assert.equal(quoteShell("a'b; rm -rf /"), `'a'\\''b; rm -rf /'`);
  assert.doesNotThrow(() => assertPackage('com.example.app_1'));
  for (const bad of ['com.example; rm', 'app', '$(id).x', 'com.example/..', '']) assert.throws(() => assertPackage(bad), bad);
});

test('installFailure: 덮어쓸 수 없으면 지우지 않았다고 알린다', () => {
  assert.match(installFailure('adb: failed to install a.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ...]'), /INSTALL_FAILED_UPDATE_INCOMPATIBLE\): .*서명이 달라/);
  assert.match(installFailure('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'), /버전이 낮습니다/);
  assert.match(installFailure('Performing Streamed Install\nsomething odd'), /설치 실패: something odd/);
});

test('deepLinkNeedsConfirm: http(s)와 대상 앱의 커스텀 스킴만 확인 없이 연다', () => {
  const T = 'com.example.app';
  assert.equal(deepLinkNeedsConfirm('https://example.com/a', undefined, undefined), false);
  assert.equal(deepLinkNeedsConfirm('HTTP://example.com', 'com.other', T), false);
  assert.equal(deepLinkNeedsConfirm('myapp://item/1', T, T), false);
  // packageName 만으로는 건너뛰지 못한다
  for (const [uri, pkg, target] of [
    ['tel:0101234', T, T],
    ['TEL:0101234', T, T],
    ['sms:0101234?body=x', T, T],
    ['intent://x#Intent;end', T, T],
    ['file:///sdcard/a', T, T],
    ['content://x/y', T, T],
    ['market://details?id=x', T, T],
    ['otherapp://pay', 'com.other.app', T],
    ['myapp://item/1', T, undefined],
    ['myapp://item/1', undefined, T],
    ['no-scheme', T, T],
    ['', T, T],
  ]) {
    assert.equal(deepLinkNeedsConfirm(uri, pkg, target), true, `${uri} ${pkg} ${target}`);
  }
});
