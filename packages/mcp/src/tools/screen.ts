import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, json, serialArg, selectorShape, pickSelector, describeNode, readOnly } from '../common.js';

export function register(server: McpServer): void {
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
      const h = await dl.dumpHierarchy(dev);
      const screen = await dl.currentScreen(dev, { fragments: true });
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
}
