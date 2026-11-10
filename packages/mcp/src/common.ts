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
});
export const describeNode = (n: dl.ViewNode) =>
  `[${n.id}] ${n.className.split('.').pop()} ${n.resourceId ? '#' + n.resourceId.split(':id/')[1] : ''} "${n.text}" (${n.contentDesc}) @${n.bounds.join(',')}${n.clickable ? ' click' : ''}`;

export const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export const acts = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const hasSelector = (s: dl.Selector) => Object.values(s).some((v) => v !== undefined);

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
 * 사람이 호출마다 승인하지 않는 환경). 클라이언트가 MCP elicitation 을 지원하면 사용자에게 묻고, 아니면 실행하지 않는다.
 * 에이전트는 앱 화면의 글자를 읽으므로 화면에 심긴 지시로 이런 도구를 부를 수 있다 — 지침 문장이 아니라 여기서 막는다
 */
export async function confirmDestructive(server: McpServer, what: string): Promise<void> {
  if (process.env.DROIDLENS_CONFIRM !== '1') return;
  if (server.server.getClientCapabilities()?.elicitation) {
    const r = await server.server
      .elicitInput({
        message: `DroidLens: ${what}. 되돌릴 수 없습니다. 실행할까요?`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: '실행' } }, required: ['confirm'] },
      })
      .catch(() => undefined);
    if (r?.action === 'accept' && r.content?.confirm === true) return;
    throw new Error(`사용자가 승인하지 않아 실행하지 않았습니다: ${what}`);
  }
  throw new Error(
    `사용자 확인이 필요한 조작이라 실행하지 않았습니다: ${what}. 이 대화에서는 확인을 받을 수 없으니, 사용자에게 DroidLens 앱 화면이나 터미널의 Claude Code 에서 직접 하도록 안내하세요`,
  );
}

/**
 * 좌표 (x, y)를 누르기 전 위험 버튼 검사. 기기를 누르는 MCP 도구(tap·graph_record·type_text)가 모두 이 한 곳을 거친다.
 * node: 셀렉터로 찾은 요소, tree: 이미 받은 뷰 계층(없으면 새로 덤프). 위험하면 던진다
 */
export async function refuseRisky(dev: dl.DeviceAdb, x: number, y: number, node?: dl.ViewNode, tree?: dl.ViewNode): Promise<void> {
  const risky = dl.riskyTapLabel(tree ?? (await dl.dumpHierarchy(dev)).root, x, y, node);
  if (risky) throw new Error(dl.riskyTapMessage(risky, '호출'));
}

export const allowDangerArg = {
  allowDanger: z
    .boolean()
    .optional()
    .describe('위험 버튼(삭제·결제·로그아웃·전송)도 누른다. 사용자가 직접 요청했을 때만 true'),
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
} = { active: false, steps: [], mocks: new Map(), actions: [] };

/** 시나리오 진행 중이면 조작 로그를 남긴다 (스크립트로 녹화되지 않는 조작도 포함: 좌표 스와이프·앱 종료·목·Prefs 변경 등) */
export function logAction(text: string): void {
  if (recorder.active) recorder.actions.push({ at: Date.now(), text });
}

/** 스크립트 단계로 녹화하고 조작 로그도 남긴다. label 이 없으면 단계 설명을 쓴다 */
export function recordStep(step: dl.ScriptStep, label?: string): void {
  if (!recorder.active) return;
  recorder.steps.push(step);
  logAction(label ?? dl.describeStep(step));
}

/** 요소를 사람이 읽는 짧은 말로: "상점정보/후기" (#tab_store) */
export function nodeLabel(n: dl.ViewNode): string {
  const id = n.resourceId ? `#${n.resourceId.split(':id/').pop()}` : '';
  const name = n.text ? `"${n.text}"` : n.contentDesc ? `[${n.contentDesc}]` : '';
  if (name && id) return `${name} (${id})`;
  return name || id || `${n.className.split('.').pop()} @${n.bounds.join(',')}`;
}

/** 셀렉터 인자에서 스크립트용 셀렉터만 추린다 (undefined 제거) */
export function cleanSelector(sel: dl.Selector): Record<string, string | number> {
  return Object.fromEntries(Object.entries(sel).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
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

