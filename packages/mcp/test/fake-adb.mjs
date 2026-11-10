#!/usr/bin/env node
// 시험용 가짜 adb. ADB_PATH 로 지정해 MCP 서버가 실제 기기 없이 돌게 한다.
// FAKE_ADB_DIR 폴더의 ui.xml 을 뷰 계층으로 돌려주고, 기기로 간 shell·install 명령을 log.txt 에 한 줄씩 남긴다.
// mode.txt 가 있으면 그 내용대로 실패한다 (offline | unauthorized | hang).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_ADB_DIR;
let args = process.argv.slice(2);
const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
const log = (line) => appendFileSync(join(dir, 'log.txt'), line + '\n');
const mode = read('mode.txt').trim();

// 1x1 PNG 대신 shot.png 가 있으면 그것을 쓴다
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

if (args[0] === 'devices') {
  process.stdout.write(`List of devices attached\nfake           device product:p model:Fake transport_id:1\n`);
  process.exit(0);
}
if (args[0] === 'version') {
  process.stdout.write('Android Debug Bridge version 1.0.41\n');
  process.exit(0);
}
if (args[0] === '-s') args = args.slice(2);

if (mode === 'offline') {
  process.stderr.write('adb: device offline\n');
  process.exit(1);
}
if (mode === 'unauthorized') {
  process.stderr.write('adb: device unauthorized.\nThis adb server\'s $ADB_VENDOR_KEYS is not set\n');
  process.exit(1);
}
if (mode === 'hang') {
  setTimeout(() => process.exit(0), 60_000);
} else if (args[0] === 'forward') {
  if (args[1] === '--list') process.exit(0);
  process.stderr.write('adb: error: cannot bind\n');
  process.exit(1);
} else if (args[0] === 'install') {
  log(`install ${args.slice(1).join(' ')}`);
  process.stdout.write(read('install.txt') || 'Performing Streamed Install\nSuccess\n');
} else if (args[0] === 'exec-out') {
  const cmd = args[1] ?? '';
  if (cmd.includes('uiautomator dump')) {
    log('dump');
    process.stdout.write(`UI hierchary dumped to: /data/local/tmp/x.xml\n__DROIDLENS_XML__\n${read('ui.xml')}`);
  } else if (cmd.startsWith('screencap')) {
    process.stdout.write(existsSync(join(dir, 'shot.png')) ? readFileSync(join(dir, 'shot.png')) : PNG_1X1);
  }
} else if (args[0] === 'shell') {
  const cmd = args[1] ?? '';
  log(cmd);
  if (cmd.startsWith('dumpsys window displays')) process.stdout.write('  mDisplayId=0\n    cur=1080x2400\n');
  else if (cmd.startsWith('dumpsys window')) process.stdout.write('  mCurrentFocus=Window{a1 u0 com.example.app/com.example.app.MainActivity}\n');
  else if (cmd.startsWith('logcat') || cmd.includes('logcat')) process.stdout.write(read('logcat.txt'));
  else if (cmd.startsWith('getprop')) process.stdout.write('Fake\nPhone\n14\n34\narm64-v8a\nPhysical size: 1080x2400\nPhysical density: 420\n');
}
