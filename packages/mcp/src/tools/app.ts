import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';
import { device, text, json, serialArg, appArg, readOnly, acts, recordStep, logAction, recorder, confirmDestructive, capList, within, isProjectDir } from '../common.js';

export function register(server: McpServer): void {
  // ---------- 앱 ----------

  server.registerTool(
    'list_packages',
    {
      description: '설치된 앱 패키지 이름 목록. 다른 도구의 packageName 을 알아낼 때 쓴다',
      inputSchema: {
        ...serialArg,
        thirdPartyOnly: z.boolean().optional().describe('사용자가 설치한 앱만 (기본 true). false 면 시스템 앱 포함'),
        filter: z.string().optional().describe('패키지 이름에 들어 있는 문자열'),
      },
      annotations: readOnly,
    },
    async ({ serial, thirdPartyOnly, filter }) => {
      const pkgs = await dl.listPackages(await device(serial), { thirdPartyOnly: thirdPartyOnly ?? true });
      return text(pkgs.map((p) => p.packageName).filter((p) => !filter || p.includes(filter)).join('\n'));
    },
  );

  server.registerTool(
    'app_info',
    {
      description: '앱 버전, minSdk/targetSdk, debuggable, 권한, Activity 목록, 실행 PID. Activity·권한은 30개까지만 (full=true 면 전부)',
      inputSchema: { ...serialArg, ...appArg, full: z.boolean().optional().describe('Activity·권한 목록을 자르지 않는다') },
      annotations: readOnly,
    },
    async ({ serial, packageName, full }) => {
      const info = await dl.appInfo(await device(serial), packageName);
      if (full) return json(info);
      const cut = (list: string[]) => {
        const c = capList(list, 30);
        return c.more ? [...c.items, `… 외 ${c.more}개 (full=true 로 전부)`] : c.items;
      };
      return json({
        ...info,
        activities: cut(info.activities),
        requestedPermissions: cut(info.requestedPermissions),
        grantedPermissions: cut(info.grantedPermissions),
      });
    },
  );

  server.registerTool(
    'launch_app',
    {
      description: '앱 실행하고 화면이 멈출 때까지 기다린 뒤 도착한 Activity 를 반환. restart=true면 강제 종료 후 첫 화면부터',
      inputSchema: {
        ...serialArg,
        ...appArg,
        activity: z.string().optional().describe('런처 화면 대신 띄울 Activity (exported 여야 한다). 예: .ui.DetailActivity'),
        restart: z.boolean().optional().describe('강제 종료 후 실행'),
      },
      annotations: acts,
    },
    async ({ serial, packageName, activity, restart }) => {
      const dev = await device(serial);
      let s: dl.Snapshot;
      if (activity) {
        if (restart) await dl.stopApp(dev, packageName);
        await dl.launchApp(dev, packageName, activity);
        s = await dl.waitForSettle(dev, { timeoutMs: 8000 });
      } else {
        s = await dl.launchAndSettle(dev, packageName, { restart });
      }
      recordStep({ launch: restart ? { restart: true } : null }, `앱 ${restart ? '재시작' : '실행'} ${packageName}${activity ? ` (${activity})` : ''} → ${s.screen.activity.split('.').pop()}`);
      return text(`launched ${packageName} → ${s.screen.activity}`);
    },
  );

  server.registerTool(
    'stop_app',
    { description: '앱 강제 종료 (am force-stop). 데이터는 그대로 남는다', inputSchema: { ...serialArg, ...appArg }, annotations: acts },
    async ({ serial, packageName }) => {
      await dl.stopApp(await device(serial), packageName);
      logAction(`앱 강제 종료 ${packageName}`);
      return text(`stopped ${packageName}`);
    },
  );

  server.registerTool(
    'clear_app_data',
    {
      description: '앱 데이터 전체 삭제 (로그인/설정 등 모두 사라짐, 되돌릴 수 없음). 사용자가 명시적으로 요청했을 때만 사용',
      inputSchema: { ...serialArg, ...appArg },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ serial, packageName }) => {
      const dev = await device(serial);
      await confirmDestructive(server, `${packageName} 의 앱 데이터 전체 삭제 (로그인·설정이 모두 사라집니다)`, { serial: dev.serial, app: packageName, tool: 'clear_app_data' });
      await dl.clearAppData(dev, packageName);
      logAction(`앱 데이터 전체 삭제 ${packageName}`);
      return text(`cleared ${packageName}`);
    },
  );

  server.registerTool(
    'install_apk',
    {
      description:
        'APK 를 기기에 설치 (adb install -r, 같은 서명이면 앱 데이터를 둔 채 덮어쓴다). 코드를 고쳐 빌드한 뒤 다시 검증할 때 쓴다: 빌드 → install_apk → script_run. ' +
        'MCP 서버를 띄운 프로젝트 폴더 안의 .apk 만 설치한다. 서명이 달라 덮어쓸 수 없으면 기존 앱을 지우지 않고 실패한다',
      inputSchema: {
        ...serialArg,
        path: z.string().describe('APK 경로. 프로젝트 폴더 기준 상대 경로 또는 그 안의 절대 경로 (예: app/build/outputs/apk/debug/app-debug.apk)'),
        grantPermissions: z.boolean().optional().describe('런타임 권한을 설치할 때 모두 허용 (-g)'),
      },
      annotations: acts,
    },
    async ({ serial, path, grantPermissions }) => {
      const dev = await device(serial);
      const apk = await guardApk(path);
      await dl.installApk(dev, apk, { grantPermissions });
      logAction(`APK 설치 ${apk}`);
      return text(`installed: ${apk}`);
    },
  );

  server.registerTool(
    'open_deeplink',
    {
      description: '딥링크/URL을 VIEW 인텐트로 열기. 앱의 특정 화면으로 바로 들어갈 때 쓴다',
      inputSchema: {
        ...serialArg,
        uri: z.string().describe('열 URI (예: myapp://product/123, https://example.com/item/1)'),
        packageName: z.string().optional().describe('이 앱으로만 연다. 없으면 기기가 처리할 앱을 고른다'),
      },
      annotations: acts,
    },
    async ({ serial, uri, packageName }) => {
      const dev = await device(serial);
      // http(s) 와 시험 대상 앱의 커스텀 스킴 딥링크만 확인 없이 연다 (tel:·intent: 나 다른 앱 지정은 packageName 을 줘도 확인)
      if (dl.deepLinkNeedsConfirm(uri, packageName, recorder.app ?? process.env.DROIDLENS_APP)) {
        await confirmDestructive(server, `URI 열기 ${dl.redactUrl(uri)}`, { serial: dev.serial, app: packageName, tool: 'open_deeplink' });
      }
      const out = await dl.openDeepLink(dev, uri, packageName);
      recordStep({ deeplink: uri }, `딥링크 열기 ${dl.redactUrl(uri)}`);
      return text(out);
    },
  );

  server.registerTool(
    'analyze_libraries',
    {
      description: '설치된 앱의 APK를 내려받아 사용 라이브러리/프레임워크/네이티브 lib/난독화 여부를 분석',
      inputSchema: { ...serialArg, ...appArg, includeUnknown: z.boolean().optional().describe('알려진 라이브러리 시그니처에 없는 패키지도 나열') },
      annotations: readOnly,
    },
    async ({ serial, packageName, includeUnknown }) => {
      const dev = await device(serial);
      const dir = await dl.ensureDir('apks', dl.safeName(packageName));
      const apks = await dl.pullApk(dev, packageName, dir);
      const r = await dl.analyzeApk(apks, packageName);
      const byCat = new Map<string, string[]>();
      for (const l of r.libraries) byCat.set(l.category, [...(byCat.get(l.category) ?? []), `${l.name}${l.note ? ` ⚠ ${l.note}` : ''} — ${l.evidence[0]}`]);
      const lines = [
        `APK ${r.apkFiles.length}개, dex ${r.dexCount}개, 클래스 ${r.classCount}개 (앱 코드 추정 ${r.appClassCount})`,
        `Kotlin: ${r.kotlin ? '예' : '아니오'} · 난독화 추정: ${r.obfuscation.likelyObfuscated ? '예' : '아니오'} (짧은 이름 비율 ${r.obfuscation.shortNameRatio})`,
        `ABI: ${r.abis.join(', ') || '없음'} · 네이티브 lib ${new Set(r.nativeLibs.map((n) => n.name)).size}개`,
        '',
        ...[...byCat.entries()].flatMap(([c, ls]) => [`## ${c}`, ...ls.map((l) => `- ${l}`)]),
      ];
      if (includeUnknown) lines.push('', '## 시그니처에 없는 패키지', ...r.unknownPackages.map((u) => `- ${u.pkg} (${u.classes})`));
      lines.push('', `APK 저장 위치: ${dir}`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'logcat',
    {
      description: '최근 logcat. packageName을 주면 해당 앱 프로세스 로그만. 한 번에 최대 1000줄',
      inputSchema: {
        ...serialArg,
        packageName: z.string().optional().describe('이 앱 프로세스의 로그만'),
        lines: z.number().int().optional().describe('가져올 줄 수 (기본 200, 최대 1000)'),
        minLevel: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional().describe('이 수준 이상만 (W = 경고 이상)'),
        grep: z.string().optional().describe('이 문자열이 든 줄만'),
      },
      annotations: readOnly,
    },
    async ({ serial, packageName, lines, minLevel, grep }) => {
      const logs = await dl.readLogcat(await device(serial), { pkg: packageName, lines: Math.min(Math.max(lines ?? 200, 1), 1000), minLevel, grep });
      return text(logs.map((l) => `${l.time} ${l.level} ${l.tag}: ${l.message}`).join('\n') || '(로그 없음)');
    },
  );

  server.registerTool(
    'crashes',
    {
      description: '최근 크래시(FATAL EXCEPTION) 스택트레이스 최대 3건. 조작 뒤 앱이 죽었는지 확인할 때 쓴다',
      inputSchema: { ...serialArg, packageName: z.string().optional().describe('이 앱의 크래시만') },
      annotations: readOnly,
    },
    async ({ serial, packageName }) => {
      const c = await dl.recentCrashes(await device(serial), packageName);
      return text(c.length ? c.slice(-3).join('\n---\n') : '최근 크래시 없음');
    },
  );
}

/**
 * install_apk 경로 → 실제 경로. 도구 인자는 화면·문서에 심어진 지시로 채워질 수 있으므로
 * MCP 서버를 띄운 프로젝트 폴더(cwd) 안의 .apk 파일만 허용한다 (스크립트 실행과 같은 규칙)
 */
async function guardApk(input: string): Promise<string> {
  const cwd = await realpath(process.cwd());
  const home = await realpath(homedir()).catch(() => homedir());
  if (!isProjectDir(cwd, home)) throw new Error(`MCP 서버를 프로젝트 폴더에서 띄웠을 때만 설치할 수 있습니다 (지금: ${cwd})`);
  const p = resolve(cwd, input);
  if (extname(p).toLowerCase() !== '.apk') throw new Error(`.apk 파일이어야 합니다: ${input}`);
  if (!existsSync(p)) throw new Error(`파일이 없습니다: ${input}`);
  const real = await realpath(p);
  if (!within(cwd, real) || extname(real).toLowerCase() !== '.apk') throw new Error(`프로젝트 폴더(${cwd}) 밖의 파일은 설치할 수 없습니다: ${input}`);
  if (!(await stat(real)).isFile()) throw new Error(`파일이 아닙니다: ${input}`);
  return real;
}
