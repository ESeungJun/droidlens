import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, json, serialArg, readOnly, acts } from '../common.js';

export function register(server: McpServer): void {
  // ---------- 앱 ----------

  server.registerTool(
    'list_packages',
    {
      description: '설치된 앱 패키지 목록',
      inputSchema: { ...serialArg, thirdPartyOnly: z.boolean().optional().describe('기본 true'), filter: z.string().optional() },
      annotations: readOnly,
    },
    async ({ serial, thirdPartyOnly, filter }) => {
      const pkgs = await dl.listPackages(await device(serial), { thirdPartyOnly: thirdPartyOnly ?? true });
      return text(pkgs.map((p) => p.packageName).filter((p) => !filter || p.includes(filter)).join('\n'));
    },
  );

  server.registerTool(
    'app_info',
    { description: '앱 버전, SDK, 권한, Activity 목록, 실행 PID 등', inputSchema: { ...serialArg, packageName: z.string() }, annotations: readOnly },
    async ({ serial, packageName }) => json(await dl.appInfo(await device(serial), packageName)),
  );

  server.registerTool(
    'launch_app',
    {
      description: '앱 실행. restart=true면 강제 종료 후 실행',
      inputSchema: { ...serialArg, packageName: z.string(), activity: z.string().optional(), restart: z.boolean().optional() },
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
      return text(`launched ${packageName} → ${s.screen.activity}`);
    },
  );

  server.registerTool(
    'stop_app',
    { description: '앱 강제 종료', inputSchema: { ...serialArg, packageName: z.string() }, annotations: acts },
    async ({ serial, packageName }) => {
      await dl.stopApp(await device(serial), packageName);
      return text(`stopped ${packageName}`);
    },
  );

  server.registerTool(
    'clear_app_data',
    {
      description: '앱 데이터 전체 삭제 (로그인/설정 등 모두 사라짐, 되돌릴 수 없음). 사용자가 명시적으로 요청했을 때만 사용',
      inputSchema: { ...serialArg, packageName: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ serial, packageName }) => {
      await dl.clearAppData(await device(serial), packageName);
      return text(`cleared ${packageName}`);
    },
  );

  server.registerTool(
    'open_deeplink',
    { description: '딥링크/URL을 VIEW 인텐트로 열기', inputSchema: { ...serialArg, uri: z.string(), packageName: z.string().optional() }, annotations: acts },
    async ({ serial, uri, packageName }) => text(await dl.openDeepLink(await device(serial), uri, packageName)),
  );

  server.registerTool(
    'analyze_libraries',
    {
      description: '설치된 앱의 APK를 내려받아 사용 라이브러리/프레임워크/네이티브 lib/난독화 여부를 분석',
      inputSchema: { ...serialArg, packageName: z.string(), includeUnknown: z.boolean().optional() },
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
      description: '최근 logcat. packageName을 주면 해당 앱 프로세스 로그만',
      inputSchema: {
        ...serialArg,
        packageName: z.string().optional(),
        lines: z.number().int().optional().describe('기본 200'),
        minLevel: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional(),
        grep: z.string().optional(),
      },
      annotations: readOnly,
    },
    async ({ serial, packageName, lines, minLevel, grep }) => {
      const logs = await dl.readLogcat(await device(serial), { pkg: packageName, lines: lines ?? 200, minLevel, grep });
      return text(logs.map((l) => `${l.time} ${l.level} ${l.tag}: ${l.message}`).join('\n') || '(로그 없음)');
    },
  );

  server.registerTool(
    'crashes',
    { description: '최근 크래시(FATAL EXCEPTION) 스택트레이스', inputSchema: { ...serialArg, packageName: z.string().optional() }, annotations: readOnly },
    async ({ serial, packageName }) => {
      const c = await dl.recentCrashes(await device(serial), packageName);
      return text(c.length ? c.slice(-3).join('\n---\n') : '최근 크래시 없음');
    },
  );
}
