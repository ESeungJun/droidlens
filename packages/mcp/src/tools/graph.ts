import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, json, serialArg, selectorShape, pickSelector, readOnly, acts, hasSelector, resolveNode } from '../common.js';

export function register(server: McpServer): void {
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
        const node = await graph.addSnapshot(s, dev);
        await graph.save();
        return text(`기록: ${node.id} (${node.label}) · 화면 ${graph.nodes.size}개`);
      }
      const before = await dl.captureSnapshot(dev);
      let ga: dl.GraphAction;
      if (action.type === 'tap') {
        const sel = pickSelector(action);
        let { x, y } = action;
        let label: string | undefined;
        if (hasSelector(sel)) {
          const n = await resolveNode(dev, sel, before.hierarchy.root);
          ({ x, y } = dl.center(n));
          label = dl.labelOf(n);
        }
        if (x === undefined || y === undefined) throw new Error('tap에는 셀렉터나 x/y가 필요합니다');
        ga = { type: 'tap', x, y, label, selector: sel };
      } else if (action.type === 'key') {
        ga = { type: 'key', key: action.key ?? 'back' };
      } else {
        const { screen } = await dl.getDeviceInfo(dev);
        const [x1, y1, x2, y2] = dl.swipeVector(screen, action.direction ?? 'up');
        ga = { type: 'swipe', x1, y1, x2, y2 };
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
}
