import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
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
export const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** 토큰 절약을 위해 축소한 JPEG를 돌려준다 (실패 시 원본 PNG) */
export async function imageContent(png: Buffer, maxEdge = 900): Promise<{ type: 'image'; data: string; mimeType: string }> {
  try {
    return { type: 'image', data: dl.downscaleToJpeg(png, maxEdge).toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
  }
}

export async function saveShot(png: Buffer, label = 'shot'): Promise<string> {
  const dir = await dl.ensureDir('screenshots');
  const p = join(dir, `${dl.timestamp()}_${dl.safeName(label)}.png`);
  await writeFile(p, png);
  return p;
}

export const serialArg = { serial: z.string().optional().describe('기기 serial. 한 대만 연결되어 있으면 생략') };
export const selectorShape = {
  id: z.string().optional().describe('resource-id 전체 또는 이름 (예: login_button)'),
  text: z.string().optional().describe('정확히 일치하는 텍스트'),
  textContains: z.string().optional(),
  desc: z.string().optional().describe('content-description 정확히 일치'),
  descContains: z.string().optional(),
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
} = { active: false, steps: [], mocks: new Map() };

export function recordStep(step: dl.ScriptStep): void {
  if (recorder.active) recorder.steps.push(step);
}

/** 셀렉터 인자에서 스크립트용 셀렉터만 추린다 (undefined 제거) */
export function cleanSelector(sel: dl.Selector): Record<string, string | number> {
  return Object.fromEntries(Object.entries(sel).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
}
