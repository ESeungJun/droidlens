import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, hasSelector, resolveNode, text, serialArg, selectorShape, pickSelector, describeNode, readOnly, acts } from '../common.js';

export function register(server: McpServer): void {
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
      if (hasSelector(sel)) {
        const n = await resolveNode(dev, sel);
        ({ x, y } = dl.center(n));
        what = describeNode(n);
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
        await dl.swipeDirection(dev, a.direction, a.durationMs);
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
      description: '현재 포커스된 입력창에 텍스트 입력 (온디바이스 에이전트가 있으면 한글 등 유니코드 지원). selector를 주면 먼저 탭해 포커스',
      inputSchema: { ...serialArg, ...selectorShape, value: z.string(), clear: z.boolean().optional().describe('입력 전 기존 텍스트 삭제') },
      annotations: acts,
    },
    async (a) => {
      const dev = await device(a.serial);
      const sel = pickSelector(a);
      if (hasSelector(sel)) {
        const { x, y } = dl.center(await resolveNode(dev, sel));
        await dl.tap(dev, x, y);
        await dl.sleep(300);
      }
      if (a.clear) {
        const agent = await dl.ensureAgent(dev);
        if (agent) {
          await dl.replaceText(dev, a.value);
          return text(`replaced with ${a.value.length} chars`);
        }
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
}
