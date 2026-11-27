import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dl from '@droidlens/core';

/** MCP 도구 공통: 기기 선택, 응답 포맷, 셀렉터 스키마, 어노테이션 */

export const adb = new dl.Adb();

export async function device(serial?: string): Promise<dl.DeviceAdb> {
  const s = serial ?? process.env.DROIDLENS_SERIAL;
  if (s) return adb.device(s);
  const online = (await dl.listDevices(adb)).filter((d) => d.state === 'device');
  if (online.length === 0) throw new Error('연결된 기기가 없습니다. USB 디버깅을 켜거나 에뮬레이터를 실행하세요.');
  if (online.length > 1) {
    throw new Error(`기기가 여러 대입니다. serial을 지정하세요: ${online.map((d) => d.serial).join(', ')}`);
  }
  return adb.device(online[0].serial);
}

export const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
/** JSON 응답. 에이전트가 읽는 것이라 들여쓰지 않는다 (들여쓰기는 글자 수만 늘린다) */
export const json = (v: unknown) => text(JSON.stringify(v));

/**
 * 긴 응답을 줄 수로 자른다. 잘랐으면 전체 줄 수와 줄이는 방법(hint)을 끝에 붙인다.
 * 큰 화면 하나가 컨텍스트 수만 자를 먹지 않게 한다
 */
export function capLines(body: string, max: number, hint: string): string {
  const lines = body.split('\n');
  if (lines.length <= max) return body;
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length}줄 중 ${max}줄만 표시. ${hint}`;
}

/** 목록을 n 개까지만. 넘으면 { items, more: '…외 k개' } 식으로 쓸 수 있게 남은 수를 돌려준다 */
export function capList<T>(items: T[], max: number): { items: T[]; total: number; more: number } {
  return { items: items.slice(0, max), total: items.length, more: Math.max(0, items.length - max) };
}

/**
 * 토큰 절약을 위해 축소한 JPEG를 돌려준다 (실패 시 원본 PNG).
 * note: 이미지 좌표를 tap·swipe 좌표(기기 픽셀)로 바꾸는 배율 안내 — 응답 글에 같이 넣는다
 */
export async function imageContent(png: Buffer, maxEdge = 900): Promise<{ image: { type: 'image'; data: string; mimeType: string }; note: string }> {
  try {
    const img = dl.downscaleToJpegInfo(png, maxEdge);
    return { image: { type: 'image', data: img.data.toString('base64'), mimeType: 'image/jpeg' }, note: dl.imageScaleNote(img) };
  } catch {
    return { image: { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, note: '이미지는 줄이지 않은 원본이다 (좌표 = 기기 픽셀)' };
  }
}

export async function saveShot(png: Buffer, label = 'shot'): Promise<string> {
  const dir = await dl.ensureDir('screenshots');
  const p = join(dir, `${dl.timestamp()}_${dl.safeName(label)}.png`);
  await writeFile(p, png);
  return p;
}

/** 대상 앱 패키지 인자 */
export const appArg = { packageName: z.string().describe('앱 패키지 (예: com.example.app)') };
/** tap·swipe 좌표 설명에 붙이는 말 */
export const PIXELS = '기기 픽셀 (view_hierarchy 의 @bounds 좌표계. 스크린샷 이미지 좌표면 screenshot 응답의 배율을 곱한다)';
export const serialArg = { serial: z.string().optional().describe('기기 serial (한 대면 생략)') };
export const selectorShape = {
  id: z.string().optional().describe('resource-id 전체 또는 이름 (예: login_button)'),
  text: z.string().optional().describe('정확히 일치하는 텍스트'),
  textContains: z.string().optional().describe('텍스트에 들어 있는 문자열 (대소문자 무시)'),
  desc: z.string().optional().describe('content-description 정확히 일치'),
  descContains: z.string().optional().describe('content-description 에 들어 있는 문자열 (대소문자 무시)'),
  className: z.string().optional().describe('예: Button, android.widget.EditText'),
  index: z.number().int().optional().describe('여러 개 매칭 시 n번째 (0부터)'),
  inWeb: z
    .boolean()
    .optional()
    .describe('true: WebView 안 웹 페이지 글자만, false: WebView 밖(앱 제목 줄 등)만. 웹뷰 본문을 확인할 때 앱 제목 줄의 같은 글자로 통과하지 않게 true 를 준다'),
};
export type SelectorArgs = { [K in keyof typeof selectorShape]?: z.infer<(typeof selectorShape)[K]> };
export const pickSelector = (a: SelectorArgs): dl.Selector => ({
  id: a.id,
  text: a.text,
  textContains: a.textContains,
  desc: a.desc,
  descContains: a.descContains,
  className: a.className,
  index: a.index,
  inWeb: a.inWeb,
});
export const describeNode = (n: dl.ViewNode) =>
  `[${n.id}] ${n.className.split('.').pop()} ${n.resourceId ? '#' + n.resourceId.split(':id/').pop() : ''} "${n.text}" (${n.contentDesc}) @${n.bounds.join(',')}${n.clickable ? ' click' : ''}`;

export const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export const acts = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** 조건이 하나라도 있는지 (inWeb 는 범위만 좁히고 조건이 아니다) */
export const hasSelector = (s: dl.Selector) => Object.entries(s).some(([k, v]) => v !== undefined && k !== 'inWeb');

/**
 * 셀렉터로 노드 하나를 찾는다. 없거나 여러 개면(인덱스 미지정) 후보를 보여주는 에러.
 * root를 주면 그 스냅샷에서, 없으면 새로 덤프한다.
 */
export async function resolveNode(dev: dl.DeviceAdb, sel: dl.Selector, root?: dl.ViewNode): Promise<dl.ViewNode> {
  const tree = root ?? (await dl.dumpHierarchy(dev)).root;
  const found = dl.findNodes(tree, sel);
  if (!found.length) throw new Error(`요소를 찾지 못했습니다: ${JSON.stringify(sel)}`);
  if (found.length > 1 && sel.index === undefined) {
    throw new Error(`요소가 ${found.length}개 매칭됩니다. index를 지정하세요:\n${found.slice(0, 10).map(describeNode).join('\n')}`);
  }
  return found[0];
}

/**
 * 되돌릴 수 없는 조작 전 확인. DROIDLENS_CONFIRM=1 일 때만 동작한다 (데스크톱 앱의 대화창처럼 도구를 미리 허용해 두고
 * 사람이 호출마다 승인하지 않는 환경). 에이전트는 앱 화면의 글자를 읽으므로 화면에 심긴 지시로 이런 도구를 부를 수 있다 —
 * 지침 문장이 아니라 여기서 막는다. 확인 경로는 순서대로:
 *  1. 클라이언트가 MCP elicitation 을 지원하면 그것으로 묻는다
 *  2. 데스크톱 대화창이 연 확인 소켓(DROIDLENS_CONFIRM_SOCKET)이 있으면 대화창의 승인·거부 버튼으로 묻는다
 *  3. 둘 다 없으면 실행하지 않는다
 * 승인은 이 호출 한 번에만 유효하다. 거부·시간 초과·응답 없음은 모두 실행하지 않는다
 */
export async function confirmDestructive(
  server: McpServer,
  what: string,
  ctx: { serial?: string; app?: string; tool?: string } = {},
): Promise<void> {
  if (process.env.DROIDLENS_CONFIRM !== '1') return;
  await askUser(server, what, { question: `DroidLens: ${what}. 되돌릴 수 없습니다. 실행할까요?`, ctx });
}

/**
 * 사용자에게 직접 묻는다: MCP elicitation → 데스크톱 확인 소켓 → 둘 다 없으면 거부.
 * refuse: 물을 수 없을 때 사용자에게 안내할 다른 길 (기본은 DroidLens 앱이나 터미널에서 직접 하기)
 */
export async function askUser(
  server: McpServer,
  what: string,
  opts: { question?: string; refuse?: string; ctx?: { serial?: string; app?: string; tool?: string } } = {},
): Promise<void> {
  if (server.server.getClientCapabilities()?.elicitation) {
    const r = await server.server
      .elicitInput({
        message: opts.question ?? `DroidLens: ${what}. 실행할까요?`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: '실행' } }, required: ['confirm'] },
      })
      .catch(() => undefined);
    if (r?.action === 'accept' && r.content?.confirm === true) return;
    throw new Error(`사용자가 승인하지 않아 실행하지 않았습니다: ${what}`);
  }
  const socket = process.env.DROIDLENS_CONFIRM_SOCKET;
  const token = process.env.DROIDLENS_CONFIRM_TOKEN;
  if (socket && token) {
    const outcome = await dl.requestConfirm(socket, token, { what, ...opts.ctx });
    if (outcome === 'approved') return;
    if (outcome === 'denied') throw new Error(`사용자가 거부해 실행하지 않았습니다: ${what}. 다시 시도하지 말고 사용자에게 어떻게 할지 물으세요`);
    if (outcome === 'timeout') throw new Error(`사용자가 시간 안에 확인하지 않아 실행하지 않았습니다: ${what}. 필요하면 사용자에게 알리고 다시 요청받으세요`);
  }
  throw new Error(
    `사용자 확인이 필요한 조작이라 실행하지 않았습니다: ${what}. 이 대화에서는 확인을 받을 수 없으니, ${opts.refuse ?? '사용자에게 DroidLens 앱 화면이나 터미널의 Claude Code 에서 직접 하도록 안내하세요'}`,
  );
}

/**
 * 좌표 (x, y)를 누르기 전 확인 필수 버튼 검사. 기기를 누르는 MCP 도구(tap·graph_record·type_text)가 모두 이 한 곳을 거친다.
 * node: 셀렉터로 찾은 요소, tree: 이미 받은 뷰 계층(없으면 새로 덤프). 확인 필수면 던진다
 */
export async function refuseRisky(dev: dl.DeviceAdb, x: number, y: number, node?: dl.ViewNode, tree?: dl.ViewNode): Promise<void> {
  const risky = dl.riskyTapLabel(tree ?? (await dl.dumpHierarchy(dev)).root, x, y, node);
  if (risky) throw new Error(dl.riskyTapMessage(risky, '호출'));
}

/**
 * 도구 인자 allowDanger 를 실제로 쓸지. TC 를 실행하는 시나리오에서는 사람이 그 TC 에 허용했을 때만 쓴다
 * (에이전트가 인자로 켜서 허용 없는 확인 필수 버튼을 누르지 못하게). 허용은 매번 계획 파일에서 다시 읽어,
 * 진행 중에 허용을 거두거나 TC 내용이 바뀌면 바로 막는다.
 * bulk: 여러 버튼을 한꺼번에 누르는 도구(explore·script_run·suite_run). TC 시나리오 안에서는 허용과 상관없이 받지 않는다
 */
export async function dangerAllowed(requested: boolean | undefined, bulk = false, tool?: string): Promise<boolean> {
  if (!requested) return false;
  const tc = recorder.active ? recorder.tc : undefined;
  if (!tc) {
    // 대화창: 여러 버튼을 한꺼번에 누르는 도구는 확인 필수 버튼까지 누를지 한 번 묻는다 (한 버튼은 guardRisky 가 그 버튼을 보고 묻는다)
    if (bulk && process.env.DROIDLENS_CONFIRM === '1') await askConfirm(`${tool ?? '이 도구'} 를 확인 필수 버튼(삭제·결제·전송 등)까지 실제로 누르며 실행`, tool);
    return true;
  }
  const stop = `누르지 말고 이 단계를 막힘(blocked)으로 남기세요`;
  if (bulk) throw new Error(`TC 를 실행하는 시나리오에서는 이 도구에 allowDanger 를 쓸 수 없습니다. 허용된 동작은 tap 으로 한 번만 누르세요`);
  const c = (await dl.loadQaPlan(tc.plan).catch(() => undefined))?.cases.find((x) => x.id === tc.case);
  if (!c?.allowDanger) {
    throw new Error(`${tc.case} 는 실제로 누르기 허용이 없는 TC 라 allowDanger 를 쓸 수 없습니다. ${stop}. 사용자에게 qa_case_allow 로 허용할지 물으세요`);
  }
  if (dl.dangerFingerprint(c) !== tc.fingerprint) throw new Error(`${tc.case} 내용이 시나리오를 시작한 뒤 바뀌어 allowDanger 를 쓸 수 없습니다. ${stop}`);
  return true;
}

/** 대화창 확인에 쓸 서버 (createServer 가 묶는다) */
let confirmServer: McpServer | undefined;
export function bindConfirmServer(server: McpServer): void {
  confirmServer = server;
}

async function askConfirm(what: string, tool?: string): Promise<void> {
  if (!confirmServer) throw new Error(`사용자 확인이 필요한 조작이라 실행하지 않았습니다: ${what}`);
  await askUser(confirmServer, what, { question: `DroidLens: ${what}. 실행할까요?`, ctx: { tool } });
}

/**
 * 좌표 (x, y)를 누르기 전 확인 필수 버튼 검사 (allowDanger 포함). 기기를 누르는 도구가 모두 이 한 곳을 거친다.
 * allowDanger 가 없으면 확인 필수 버튼을 거부하고, 있으면 TC 시나리오에서는 그 TC 의 허용을 확인한다.
 * 대화창(DROIDLENS_CONFIRM=1)에서는 TC 안팎 모두, 누르려는 버튼이 확인 필수일 때 그 버튼을 보여 주고 묻는다
 */
export async function guardRisky(
  requested: boolean | undefined,
  dev: dl.DeviceAdb,
  x: number,
  y: number,
  node: dl.ViewNode | undefined,
  tree: dl.ViewNode | undefined,
  tool: string,
): Promise<void> {
  if (!(await dangerAllowed(requested))) return refuseRisky(dev, x, y, node, tree);
  // 대화창에서는 TC 허용이 있어도 누를 버튼마다 묻는다 (TC 허용이 그 시나리오의 다른 확인 필수 버튼까지 열지 않게)
  if (process.env.DROIDLENS_CONFIRM !== '1') return;
  const risky = dl.riskyTapLabel(tree ?? (await dl.dumpHierarchy(dev)).root, x, y, node);
  if (risky) await askConfirm(`확인 필수 버튼 "${risky.replace(/\s+/g, ' ').slice(0, 100)}" 실제로 누르기`, tool);
}

/**
 * 사람에게 보여 줄 에이전트·문서 글에서 화면을 속일 수 있는 문자를 뺀다:
 * 제어 문자(C0·C1, ESC 포함), 줄 구분자, 글자 방향을 뒤집는 문자(U+202A–202E, U+2066–2069, U+200E·200F·061C)
 */
export function plainText(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]+/g, ' ');
}

export const allowDangerArg = {
  allowDanger: z
    .boolean()
    .optional()
    .describe('확인 필수 버튼(삭제·결제·로그아웃·전송)도 누른다. 사용자가 직접 요청했을 때만 true'),
};

// ---------- 시나리오 녹화 ----------

/**
 * scenario_start ~ scenario_finish 사이에 에이전트가 한 조작을 스크립트 단계로 기록한다.
 * 성공한 경로를 YAML 스크립트로 저장해 회귀 테스트로 재사용하기 위함.
 */
export const recorder: {
  active: boolean;
  app?: string;
  steps: dl.ScriptStep[];
  /** 녹화 중 켠 네트워크 목 (규칙 id → 규칙). 저장하는 스크립트의 setup.mocks 가 된다 */
  mocks: Map<string, dl.MockRule>;
  /** 직전 scenario_step 이후 한 조작 로그. 다음 단계에 붙고 비워진다 */
  actions: dl.ScenarioAction[];
  /** QA TC 를 실행하는 시나리오면 그 TC. allowDanger 는 사람이 그 TC 에 허용했는지 */
  /** TC 를 실행하는 시나리오. run 이 있으면 scenario_finish 가 그 회차에 결과를 적는다 (#76) */
  tc?: { plan: string; case: string; fingerprint: string; run?: string };
  /**
   * 시나리오가 tap 으로 지난 화면 이동을 앱 지도에 남기는 경로 (#131). 온디바이스 에이전트가 있고 앱을 아는 시나리오에서만 만든다
   * (화면 확인이 느리면 조작마다 1~2초씩 늦어지므로)
   */
  path?: dl.TcPath;
  /** 조작 번호. 조작 로그를 남길 때마다 하나씩 는다. 탭과 다음 화면 확인 사이에 다른 조작이 끼었는지 이것으로 안다 */
  seq: number;
} = { active: false, steps: [], mocks: new Map(), actions: [], seq: 0 };

/**
 * 시나리오 진행 중이면 조작 로그를 남긴다 (스크립트로 녹화되지 않는 조작도 포함: 좌표 스와이프·앱 종료·목·Prefs 변경 등).
 * keepsScreen: 대기·검사처럼 화면을 바꾸지 않는 조작. 조작 번호를 올리지 않아 탭과 그 도착 화면 사이를 끊지 않는다 (#147)
 */
export function logAction(text: string, opts: { keepsScreen?: boolean } = {}): void {
  if (!opts.keepsScreen) recorder.seq++;
  if (recorder.active) recorder.actions.push({ at: Date.now(), text });
}

/**
 * TC 경로 (#131): 조작 전에 지금 화면을 지도에 올린다. 직전 탭 뒤 다른 조작이 없었으면 그 탭의 도착 화면으로 잇는다.
 * hierarchy 를 이미 읽었으면 넘겨 같은 조회를 다시 하지 않는다. 지도 기록이 실패해도 원래 조작은 막지 않는다
 */
export async function pathSee(dev?: dl.DeviceAdb, hierarchy?: dl.Hierarchy, screen?: dl.CurrentScreen): Promise<dl.ScreenNode | undefined> {
  const p = recorder.path;
  if (!p) return undefined;
  try {
    if (!hierarchy || !dev) return await p.look(recorder.seq);
    return await p.see({ screen: screen ?? (await dl.currentScreen(dev)), hierarchy, signature: '' }, recorder.seq);
  } catch {
    p.forget();
    return undefined;
  }
}

/** TC 경로 (#131): 방금 한 행동을 적어 둔다. 조작 로그를 남긴 뒤에 부른다 */
export function pathNote(action: dl.TcPathAction): void {
  recorder.path?.note(action, recorder.seq);
}

/** 스크립트 단계로 녹화하고 조작 로그도 남긴다. label 이 없으면 단계 설명을 쓴다 */
export function recordStep(step: dl.ScriptStep, label?: string): void {
  if (!recorder.active) return;
  recorder.steps.push(step);
  logAction(label ?? dl.describeStep(step), { keepsScreen: dl.stepKeepsScreen(step) });
}

/** 요소를 사람이 읽는 짧은 말로: "상점정보/후기" (#tab_store) */
export function nodeLabel(n: dl.ViewNode): string {
  const id = n.resourceId ? `#${n.resourceId.split(':id/').pop()}` : '';
  const name = n.text ? `"${n.text}"` : n.contentDesc ? `[${n.contentDesc}]` : '';
  if (name && id) return `${name} (${id})`;
  return name || id || `${n.className.split('.').pop()} @${n.bounds.join(',')}`;
}

/** 셀렉터 인자에서 스크립트용 셀렉터만 추린다 (undefined 제거) */
export function cleanSelector(sel: dl.Selector): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(sel).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
}

// ---------- 경로 허용 범위 ----------

/** p 가 root 안(같은 곳 포함)인지 */
export const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * cwd 가 프로젝트 폴더로 보이는지: git 저장소 루트이거나 홈 아래 두 단계 이상(~/Desktop/app).
 * 홈·루트와 얕은 폴더(~/Desktop, /Users, /tmp)는 다른 파일이 너무 많이 들어 있어 허용 범위로 쓰지 않는다
 */
export function isProjectDir(cwd: string, home: string): boolean {
  if (within(cwd, home)) return false; // 홈 자체이거나 홈을 품은 폴더(/Users, /)
  const underHome = within(home, cwd) ? relative(home, cwd).split(sep).length : 0;
  return underHome >= 2 || existsSync(join(cwd, '.git'));
}

