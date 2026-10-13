#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';

const adb = new dl.Adb();
const server = new McpServer({ name: 'droidlens', version: '0.1.0' });

// ---------- 공통 ----------

async function device(serial?: string): Promise<dl.DeviceAdb> {
  const s = serial ?? process.env.DROIDLENS_SERIAL;
  if (s) return adb.device(s);
  const online = (await dl.listDevices(adb)).filter((d) => d.state === 'device');
  if (online.length === 0) throw new Error('연결된 기기가 없습니다. USB 디버깅을 켜거나 에뮬레이터를 실행하세요.');
  if (online.length > 1) {
    throw new Error(`기기가 여러 대입니다. serial을 지정하세요: ${online.map((d) => d.serial).join(', ')}`);
  }
  return adb.device(online[0].serial);
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** 토큰 절약을 위해 축소한 JPEG를 돌려준다 (실패 시 원본 PNG) */
async function imageContent(png: Buffer, maxEdge = 900): Promise<{ type: 'image'; data: string; mimeType: string }> {
  try {
    return { type: 'image', data: dl.downscaleToJpeg(png, maxEdge).toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
  }
}

async function saveShot(png: Buffer, label = 'shot'): Promise<string> {
  const dir = await dl.ensureDir('screenshots');
  const p = join(dir, `${dl.timestamp()}_${dl.safeName(label)}.png`);
  await writeFile(p, png);
  return p;
}

const serialArg = { serial: z.string().optional().describe('기기 serial. 한 대만 연결되어 있으면 생략') };
const selectorShape = {
  id: z.string().optional().describe('resource-id 전체 또는 이름 (예: login_button)'),
  text: z.string().optional().describe('정확히 일치하는 텍스트'),
  textContains: z.string().optional(),
  desc: z.string().optional().describe('content-description 정확히 일치'),
  descContains: z.string().optional(),
  className: z.string().optional().describe('예: Button, android.widget.EditText'),
  index: z.number().int().optional().describe('여러 개 매칭 시 n번째 (0부터)'),
};
type SelectorArgs = { [K in keyof typeof selectorShape]?: z.infer<(typeof selectorShape)[K]> };
const pickSelector = (a: SelectorArgs): dl.Selector => ({
  id: a.id,
  text: a.text,
  textContains: a.textContains,
  desc: a.desc,
  descContains: a.descContains,
  className: a.className,
  index: a.index,
});
const describeNode = (n: dl.ViewNode) =>
  `[${n.id}] ${n.className.split('.').pop()} ${n.resourceId ? '#' + n.resourceId.split(':id/')[1] : ''} "${n.text}" (${n.contentDesc}) @${n.bounds.join(',')}${n.clickable ? ' click' : ''}`;

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const acts = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// ---------- 기기 ----------

server.registerTool(
  'devices',
  { description: '연결된 Android 기기/에뮬레이터 목록', annotations: readOnly },
  async () => json(await dl.listDevices(adb)),
);

server.registerTool(
  'device_info',
  { description: '기기 모델, Android 버전, 화면 크기/밀도', inputSchema: serialArg, annotations: readOnly },
  async ({ serial }) => json(await dl.getDeviceInfo(await device(serial))),
);

server.registerTool(
  'screenshot',
  {
    description: '현재 화면 스크린샷. 이미지와 저장 경로를 반환',
    inputSchema: { ...serialArg, label: z.string().optional().describe('파일 이름에 붙일 라벨') },
    annotations: readOnly,
  },
  async ({ serial, label }) => {
    const png = await dl.screenshot(await device(serial));
    const path = await saveShot(png, label);
    return { content: [await imageContent(png), { type: 'text', text: `saved: ${path}` }] };
  },
);

const recordings = new Map<string, dl.Recording>();

server.registerTool(
  'record_start',
  {
    description: '화면 녹화 시작 (최대 180초). record_stop으로 종료하면 mp4 경로를 반환',
    inputSchema: { ...serialArg, maxSeconds: z.number().int().min(1).max(180).optional() },
    annotations: acts,
  },
  async ({ serial, maxSeconds }) => {
    const dev = await device(serial);
    if (recordings.has(dev.serial)) return text('이미 녹화 중입니다.');
    recordings.set(dev.serial, dl.startRecording(dev, { maxSeconds }));
    return text(`녹화 시작 (${dev.serial})`);
  },
);

server.registerTool(
  'record_stop',
  { description: '화면 녹화 종료 후 mp4를 로컬에 저장', inputSchema: { ...serialArg, label: z.string().optional() }, annotations: acts },
  async ({ serial, label }) => {
    const dev = await device(serial);
    const rec = recordings.get(dev.serial);
    if (!rec) return text('진행 중인 녹화가 없습니다.');
    recordings.delete(dev.serial);
    const dir = await dl.ensureDir('recordings');
    const path = await rec.stop(join(dir, `${dl.timestamp()}_${dl.safeName(label ?? 'record')}.mp4`));
    return text(`saved: ${path} (${((Date.now() - rec.startedAt) / 1000).toFixed(1)}s)`);
  },
);

// ---------- 화면 / 뷰 계층 ----------

server.registerTool(
  'current_screen',
  {
    description: '현재 포그라운드 패키지, Activity, 표시 중인 Fragment, 화면 구조 시그니처',
    inputSchema: serialArg,
    annotations: readOnly,
  },
  async ({ serial }) => {
    const dev = await device(serial);
    const [screen, h] = await Promise.all([dl.currentScreen(dev), dl.dumpHierarchy(dev)]);
    return json({ ...screen, signature: dl.structureSignature(h.root), nodeCount: h.nodeCount, maxDepth: h.maxDepth });
  },
);

server.registerTool(
  'view_hierarchy',
  {
    description:
      '뷰 계층을 압축 텍스트 트리로 반환. 각 줄: [노드id] 클래스 #resId "text" (desc) {플래그} @left,top,right,bottom. 화면 이해와 셀렉터 작성에 사용',
    inputSchema: {
      ...serialArg,
      maxDepth: z.number().int().optional(),
      interactiveOnly: z.boolean().optional().describe('클릭/스크롤/체크 가능하거나 텍스트가 있는 노드만'),
      stats: z.boolean().optional().describe('깊이별 노드 수 등 통계 포함'),
    },
    annotations: readOnly,
  },
  async ({ serial, maxDepth, interactiveOnly, stats }) => {
    const h = await dl.dumpHierarchy(await device(serial));
    let out = dl.toCompactText(h.root, { maxDepth, interactiveOnly });
    if (stats) out += `\n\n--- stats ---\n${JSON.stringify(dl.hierarchyStats(h), null, 2)}`;
    return text(out);
  },
);

server.registerTool(
  'find_nodes',
  { description: '셀렉터로 뷰 노드 검색', inputSchema: { ...serialArg, ...selectorShape }, annotations: readOnly },
  async (a) => {
    const h = await dl.dumpHierarchy(await device(a.serial));
    const found = dl.findNodes(h.root, pickSelector(a));
    return text(found.length ? found.map(describeNode).join('\n') : '매칭되는 노드가 없습니다.');
  },
);

// ---------- 조작 ----------

server.registerTool(
  'tap',
  {
    description: '셀렉터로 찾은 요소의 중앙을 탭하거나, x/y 좌표를 탭. 셀렉터 사용을 권장',
    inputSchema: {
      ...serialArg,
      ...selectorShape,
      x: z.number().optional(),
      y: z.number().optional(),
      long: z.boolean().optional().describe('길게 누르기'),
    },
    annotations: acts,
  },
  async (a) => {
    const dev = await device(a.serial);
    let x = a.x;
    let y = a.y;
    let what = `${x},${y}`;
    const sel = pickSelector(a);
    if (Object.values(sel).some((v) => v !== undefined)) {
      const h = await dl.dumpHierarchy(dev);
      const found = dl.findNodes(h.root, sel);
      if (!found.length) throw new Error(`요소를 찾지 못했습니다: ${JSON.stringify(sel)}`);
      if (found.length > 1 && sel.index === undefined) {
        throw new Error(`요소가 ${found.length}개 매칭됩니다. index를 지정하세요:\n${found.slice(0, 10).map(describeNode).join('\n')}`);
      }
      ({ x, y } = dl.center(found[0]));
      what = describeNode(found[0]);
    }
    if (x === undefined || y === undefined) throw new Error('셀렉터나 x/y 중 하나가 필요합니다');
    if (a.long) await dl.longPress(dev, x, y);
    else await dl.tap(dev, x, y);
    return text(`${a.long ? 'long-pressed' : 'tapped'}: ${what}`);
  },
);

server.registerTool(
  'swipe',
  {
    description: '스와이프. direction(up/down/left/right)으로 화면 스크롤 또는 좌표 직접 지정',
    inputSchema: {
      ...serialArg,
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('손가락 이동 방향. up = 내용이 아래로 스크롤'),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      durationMs: z.number().int().optional(),
    },
    annotations: acts,
  },
  async (a) => {
    const dev = await device(a.serial);
    if (a.direction) {
      const { screen } = await dl.getDeviceInfo(dev);
      const cx = screen.width / 2;
      const cy = screen.height / 2;
      const dx = screen.width * 0.35;
      const dy = screen.height * 0.3;
      const v = { up: [cx, cy + dy, cx, cy - dy], down: [cx, cy - dy, cx, cy + dy], left: [cx + dx, cy, cx - dx, cy], right: [cx - dx, cy, cx + dx, cy] }[a.direction];
      await dl.swipe(dev, v[0], v[1], v[2], v[3], a.durationMs);
      return text(`swiped ${a.direction}`);
    }
    if ([a.x1, a.y1, a.x2, a.y2].some((v) => v === undefined)) throw new Error('direction 또는 x1,y1,x2,y2가 필요합니다');
    await dl.swipe(dev, a.x1!, a.y1!, a.x2!, a.y2!, a.durationMs);
    return text('swiped');
  },
);

server.registerTool(
  'type_text',
  {
    description: '현재 포커스된 입력창에 텍스트 입력 (ASCII만). selector를 주면 먼저 탭해 포커스',
    inputSchema: { ...serialArg, ...selectorShape, value: z.string(), clear: z.boolean().optional().describe('입력 전 기존 텍스트 삭제') },
    annotations: acts,
  },
  async (a) => {
    const dev = await device(a.serial);
    const sel = pickSelector(a);
    if (Object.values(sel).some((v) => v !== undefined)) {
      const h = await dl.dumpHierarchy(dev);
      const [n] = dl.findNodes(h.root, sel);
      if (!n) throw new Error(`입력창을 찾지 못했습니다: ${JSON.stringify(sel)}`);
      const { x, y } = dl.center(n);
      await dl.tap(dev, x, y);
      await dl.sleep(300);
    }
    if (a.clear) {
      await dl.pressKey(dev, 123); // MOVE_END
      await dev.shell(`input keyevent ${Array(60).fill(67).join(' ')}`);
    }
    await dl.typeText(dev, a.value);
    return text(`typed ${a.value.length} chars`);
  },
);

server.registerTool(
  'press_key',
  {
    description: '하드웨어/시스템 키 입력',
    inputSchema: { ...serialArg, key: z.enum(Object.keys(dl.KEYCODES) as [keyof typeof dl.KEYCODES]) },
    annotations: acts,
  },
  async ({ serial, key }) => {
    await dl.pressKey(await device(serial), key);
    return text(`pressed ${key}`);
  },
);

server.registerTool(
  'wait_for',
  {
    description: '셀렉터에 맞는 요소가 나타날(또는 gone=true면 사라질) 때까지 대기',
    inputSchema: { ...serialArg, ...selectorShape, timeoutMs: z.number().int().optional(), gone: z.boolean().optional() },
    annotations: readOnly,
  },
  async (a) => {
    const dev = await device(a.serial);
    const sel = pickSelector(a);
    const deadline = Date.now() + (a.timeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      const h = await dl.dumpHierarchy(dev).catch(() => undefined);
      if (h) {
        const found = dl.findNodes(h.root, sel);
        if (a.gone ? found.length === 0 : found.length > 0) {
          return text(a.gone ? '사라짐 확인' : `발견: ${describeNode(found[0])}`);
        }
      }
      await dl.sleep(500);
    }
    throw new Error(`${a.timeoutMs ?? 10_000}ms 안에 ${a.gone ? '사라지지 않음' : '나타나지 않음'}: ${JSON.stringify(sel)}`);
  },
);

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

// ---------- 화면 그래프 ----------

server.registerTool(
  'graph_record',
  {
    description:
      '현재 화면을 앱의 화면 그래프에 기록. action을 주면 행동 전후 화면과 전이(edge)를 함께 기록한다. 시나리오를 진행하면서 화면 경로 지도를 만들 때 사용',
    inputSchema: {
      ...serialArg,
      packageName: z.string(),
      action: z
        .object({
          type: z.enum(['tap', 'key', 'swipe']),
          ...selectorShape,
          x: z.number().optional(),
          y: z.number().optional(),
          key: z.string().optional(),
          direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        })
        .optional(),
    },
    annotations: acts,
  },
  async ({ serial, packageName, action }) => {
    const dev = await device(serial);
    const graph = await dl.ScreenGraph.open(packageName);
    if (!action) {
      const s = await dl.captureSnapshot(dev);
      const node = await graph.addSnapshot(s);
      await graph.save();
      return text(`기록: ${node.id} (${node.label}) · 화면 ${graph.nodes.size}개`);
    }
    const before = await dl.captureSnapshot(dev);
    let ga: dl.GraphAction;
    if (action.type === 'tap') {
      const sel = pickSelector(action);
      let { x, y } = action;
      let label: string | undefined;
      if (Object.values(sel).some((v) => v !== undefined)) {
        const [n] = dl.findNodes(before.hierarchy.root, sel);
        if (!n) throw new Error(`요소를 찾지 못했습니다: ${JSON.stringify(sel)}`);
        ({ x, y } = dl.center(n));
        label = dl.labelOf(n);
      }
      if (x === undefined || y === undefined) throw new Error('tap에는 셀렉터나 x/y가 필요합니다');
      ga = { type: 'tap', x, y, label, selector: sel };
    } else if (action.type === 'key') {
      ga = { type: 'key', key: action.key ?? 'back' };
    } else {
      const { screen } = await dl.getDeviceInfo(dev);
      const cx = screen.width / 2;
      const cy = screen.height / 2;
      const d = action.direction ?? 'up';
      const dy = screen.height * 0.3;
      const dx = screen.width * 0.35;
      const v = { up: [cx, cy + dy, cx, cy - dy], down: [cx, cy - dy, cx, cy + dy], left: [cx + dx, cy, cx - dx, cy], right: [cx - dx, cy, cx + dx, cy] }[d];
      ga = { type: 'swipe', x1: v[0], y1: v[1], x2: v[2], y2: v[3] };
    }
    const r = await dl.recordTransition(dev, graph, ga, before);
    return text(`${r.from.label} --[${dl.actionLabel(ga)}]--> ${r.to.label}${r.to.visits === 1 ? ' (새 화면)' : ''}\n화면 ${graph.nodes.size}개 · 전이 ${graph.edges.size}개`);
  },
);

server.registerTool(
  'graph_get',
  {
    description: '앱 화면 그래프 조회 (format: summary | mermaid | json). from/to를 주면 두 화면 사이 최단 경로',
    inputSchema: {
      packageName: z.string(),
      format: z.enum(['summary', 'mermaid', 'json']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    annotations: readOnly,
  },
  async ({ packageName, format, from, to }) => {
    const g = await dl.ScreenGraph.open(packageName);
    if (from && to) {
      const p = g.path(from, to);
      return text(p ? p.map((e) => `${e.from} --[${dl.actionLabel(e.action)}]--> ${e.to}`).join('\n') : '경로 없음');
    }
    if (format === 'mermaid') return text(g.toMermaid());
    if (format === 'json') return json(g.toJSON());
    const lines = [...g.nodes.values()].map((n) => {
      const outs = [...g.edges.values()].filter((e) => e.from === n.id && e.to !== n.id);
      return `- ${n.id}  ${n.label}  (방문 ${n.visits}, 노드 ${n.nodeCount}, 깊이 ${n.maxDepth})${outs.length ? '\n' + outs.map((e) => `    → ${dl.actionLabel(e.action)} ⇒ ${e.to}`).join('\n') : ''}`;
    });
    return text(`화면 ${g.nodes.size}개 · 전이 ${g.edges.size}개 · 저장 위치 ${g.dir}\n${lines.join('\n')}`);
  },
);

server.registerTool(
  'explore',
  {
    description:
      '앱을 자동 탐색(DFS)해 화면 그래프를 만든다. 결제·삭제·로그아웃·전송 등 위험 라벨은 누르지 않는다. 시간이 오래 걸릴 수 있음 (스텝당 2~4초)',
    inputSchema: {
      ...serialArg,
      packageName: z.string(),
      maxSteps: z.number().int().min(1).max(300).optional().describe('기본 40'),
      maxDepth: z.number().int().min(1).max(10).optional().describe('기본 4'),
      avoid: z.string().optional().describe('추가로 피할 라벨 정규식'),
      relaunch: z.boolean().optional(),
    },
    annotations: acts,
  },
  async ({ serial, packageName, maxSteps, maxDepth, avoid, relaunch }) => {
    const dev = await device(serial);
    const log: string[] = [];
    const r = await dl.explore(dev, {
      packageName,
      maxSteps,
      maxDepth,
      relaunch,
      avoid: avoid ? new RegExp(avoid, 'i') : undefined,
      onProgress: (e) => log.push(`#${e.step} ${e.message}`),
    });
    return text(
      [
        `화면 ${r.graph.nodes.length}개, 전이 ${r.graph.edges.length}개, ${r.steps}스텝`,
        ...log.slice(-40),
        r.skipped.length ? `\n건너뜀(위험): ${r.skipped.map((s) => s.label).join(', ')}` : '',
        r.errors.length ? `\n오류:\n${r.errors.join('\n')}` : '',
      ].join('\n'),
    );
  },
);

// ---------- 시나리오 검증 ----------

let scenario: dl.Scenario | undefined;

server.registerTool(
  'scenario_start',
  {
    description: '시나리오 검증 기록 시작. 이후 scenario_step으로 단계별 결과를 남기고 scenario_finish로 리포트 생성',
    inputSchema: { ...serialArg, name: z.string(), goal: z.string().optional(), packageName: z.string().optional() },
    annotations: acts,
  },
  async ({ serial, name, goal, packageName }) => {
    const dev = await device(serial);
    const info = await dl.getDeviceInfo(dev).catch(() => undefined);
    scenario = await dl.Scenario.start(name, {
      goal,
      packageName,
      device: info ? `${info.manufacturer} ${info.model} (Android ${info.androidVersion})` : dev.serial,
    });
    return text(`시나리오 시작: ${scenario.data.id}\n폴더: ${scenario.data.dir}`);
  },
);

server.registerTool(
  'scenario_step',
  {
    description: '시나리오 단계 기록. status: pass(기대 충족) / fail(기대 불일치) / info(진행 기록) / skip. screenshot=true면 현재 화면 첨부',
    inputSchema: {
      ...serialArg,
      title: z.string().describe('무엇을 했고 무엇을 확인했는지'),
      status: z.enum(['pass', 'fail', 'info', 'skip']),
      detail: z.string().optional().describe('기대값 vs 실제값, 근거'),
      screenshot: z.boolean().optional().describe('기본 true'),
    },
    annotations: acts,
  },
  async ({ serial, title, status, detail, screenshot }) => {
    if (!scenario) throw new Error('먼저 scenario_start를 호출하세요');
    const dev = await device(serial);
    const png = screenshot === false ? undefined : await dl.screenshot(dev);
    const screen = await dl.currentScreen(dev).catch(() => undefined);
    const s = await scenario.step(title, status, {
      detail,
      png,
      screen: screen ? `${screen.activity}${screen.fragments.length ? ' / ' + screen.fragments.join(', ') : ''}` : undefined,
    });
    return text(`step ${s.index} ${status}: ${title}`);
  },
);

server.registerTool(
  'scenario_finish',
  {
    description: '시나리오 종료 및 HTML 리포트 생성. verdict: pass | fail | blocked(진행 불가)',
    inputSchema: { verdict: z.enum(['pass', 'fail', 'blocked']), summary: z.string() },
    annotations: acts,
  },
  async ({ verdict, summary }) => {
    if (!scenario) throw new Error('진행 중인 시나리오가 없습니다');
    const html = await scenario.finish(verdict, summary);
    const d = scenario.data;
    scenario = undefined;
    const fails = d.steps.filter((s) => s.status === 'fail').length;
    return text(`리포트: ${html}\n${d.steps.length}단계 · 실패 ${fails} · 판정 ${verdict}`);
  },
);

await server.connect(new StdioServerTransport());
