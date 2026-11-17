/**
 * 화면 지도 파일(내보내기·가져오기용 한 파일짜리 지도)의 형식과 한도.
 * 남이 만든 파일일 수 있어서 가져올 때 이 스키마로 검증하고 문자열을 정리한다 (store.ts 의 importBundle 이 쓴다).
 * 형식을 바꾸면 예전에 내보낸 파일을 못 읽게 되므로 MAP_FORMAT·version 과 함께 신중히 바꾼다.
 */
import { z } from 'zod';
import { KEYCODES } from '../device.js';
import type { GraphData } from '../graph-model.js';

/** 가져온 지도 파일 한도 (렌더러가 매번 배치를 다시 계산하므로 크게 두지 않는다) */
export const MAP_LIMITS = { nodes: 2000, edges: 10_000, screenshotBytes: 5 * 1024 * 1024 };

export const MAP_FORMAT = 'droidlens-map';

/** 가져온 문자열 정리: 제어문자를 없애고 길이를 자른다 (화면·MCP 출력에 그대로 실리므로) */
export const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max);
const text = (max: number) => z.string().transform((s) => clean(s, max));
const num = z.number().finite();
const count = z.number().int().min(0).max(1e9);
/** screenId 형식: Activity 짧은 이름 @ 시그니처 12자 */
const screenIdSchema = z.string().regex(/^[\w$.-]{1,120}@[0-9a-f]{12}$/);
const selectorSchema = z.object({ id: text(200).optional(), text: text(200).optional() }).strip();
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: num, y: num, label: text(120).optional(), selector: selectorSchema.optional() }).strip(),
  z.object({ type: z.literal('longpress'), x: num, y: num, label: text(120).optional(), selector: selectorSchema.optional() }).strip(),
  z
    .object({
      type: z.literal('swipe'),
      x1: num,
      y1: num,
      x2: num,
      y2: num,
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      durationMs: z.number().int().min(50).max(5000).optional(),
    })
    .strip(),
  z.object({ type: z.literal('key'), key: z.enum(Object.keys(KEYCODES) as [keyof typeof KEYCODES]) }).strip(),
  z.object({ type: z.literal('launch') }).strip(),
  z.object({ type: z.literal('deeplink'), uri: text(500) }).strip(),
  z.object({ type: z.literal('manual'), note: text(120).optional() }).strip(),
]);
export const nodeSchema = z
  .object({
    id: screenIdSchema,
    packageName: text(200),
    activity: text(300),
    fragments: z.array(text(120)).max(20),
    signature: z.string().regex(/^[0-9a-f]{12}$/),
    label: text(200),
    screenshot: z.string().max(300).optional(),
    firstSeen: num,
    visits: count,
    nodeCount: count,
    maxDepth: count,
  })
  .strip();
export const edgeSchema = z.object({ from: screenIdSchema, to: screenIdSchema, action: actionSchema, count: count }).strip();
export const bundleSchema = z.object({
  format: z.literal(MAP_FORMAT),
  graph: z.object({
    packageName: z.string(),
    launchScreen: screenIdSchema.optional(),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
  }),
  screenshots: z.record(z.string()),
});

export interface MapBundle {
  format: typeof MAP_FORMAT;
  version: 1;
  exportedAt: number;
  graph: GraphData;
  /** 스크린샷 파일 이름 → PNG base64 */
  screenshots: Record<string, string>;
}
