import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, json, serialArg, selectorShape, pickSelector, describeNode, readOnly, acts, imageContent, recordStep, cleanSelector, capLines, hasSelector } from '../common.js';

export function register(server: McpServer): void {
  // ---------- 화면 / 뷰 계층 ----------

  server.registerTool(
    'current_screen',
    {
      description:
        '현재 포그라운드 패키지, Activity, 화면 구조 시그니처, 노드 수. 지금 어느 앱·화면인지 확인할 때 쓴다. Fragment 이름은 fragments=true 일 때만 (기기에 따라 1~7초 더 걸린다)',
      inputSchema: { ...serialArg, fragments: z.boolean().optional().describe('표시 중인 Fragment 이름도 조회 (느림). 기본 false') },
      annotations: readOnly,
    },
    async ({ serial, fragments }) => {
      const dev = await device(serial);
      const h = await dl.dumpHierarchy(dev);
      const screen = await dl.currentScreen(dev, { fragments: !!fragments });
      return json({ ...screen, signature: dl.structureSignature(h.root), nodeCount: h.nodeCount, maxDepth: h.maxDepth });
    },
  );

  server.registerTool(
    'view_hierarchy',
    {
      description:
        '뷰 계층을 압축 텍스트 트리로 반환. 각 줄: [노드id] 클래스 #resId "text" (desc) {플래그} @left,top,right,bottom (기기 픽셀). 화면 이해와 셀렉터 작성에 사용. ' +
        '보통은 interactiveOnly=true 로 충분하다. 길면 maxLines 줄에서 자른다',
      inputSchema: {
        ...serialArg,
        maxDepth: z.number().int().optional().describe('이 깊이까지만 (루트 0)'),
        maxLines: z.number().int().min(1).max(3000).optional().describe('최대 줄 수 (기본 300)'),
        interactiveOnly: z.boolean().optional().describe('클릭/스크롤/체크 가능하거나 텍스트가 있는 노드만'),
        stats: z.boolean().optional().describe('깊이별 노드 수 등 통계 포함'),
      },
      annotations: readOnly,
    },
    async ({ serial, maxDepth, maxLines, interactiveOnly, stats }) => {
      const h = await dl.dumpHierarchy(await device(serial));
      let out = capLines(
        dl.toCompactText(h.root, { maxDepth, interactiveOnly }),
        maxLines ?? 300,
        `${interactiveOnly ? '' : 'interactiveOnly=true 나 '}maxDepth 로 줄이거나, find_nodes 로 필요한 요소만 찾거나, maxLines 를 늘리세요`,
      );
      if (stats) out += `\n\n--- stats ---\n${JSON.stringify(dl.hierarchyStats(h))}`;
      return text(out);
    },
  );

  server.registerTool(
    'find_nodes',
    {
      description:
        '셀렉터에 맞는 뷰 노드 검색. tap·type_text 전에 후보가 몇 개인지, 어떤 요소인지 확인할 때 쓴다. 못 찾으면 화면의 비슷한 글자를 알려 준다',
      inputSchema: { ...serialArg, ...selectorShape, limit: z.number().int().min(1).max(200).optional().describe('보여 줄 최대 개수 (기본 20)') },
      annotations: readOnly,
    },
    async (a) => {
      const sel = pickSelector(a);
      if (!hasSelector(sel)) throw new Error('셀렉터(id·text·textContains·desc·descContains·className 중 하나)가 필요합니다. 화면 전체는 view_hierarchy 로 봅니다');
      const h = await dl.dumpHierarchy(await device(a.serial));
      const found = dl.findNodes(h.root, sel);
      if (!found.length) {
        const near = dl.similarLabels(h.root, sel);
        return text(`매칭되는 노드가 없습니다.${near.length ? ` 비슷한 후보(화면의 글자): ${near.map((l) => JSON.stringify(l)).join(', ')}` : ''}`);
      }
      const max = a.limit ?? 20;
      const more = found.length > max ? `\n… ${found.length}개 중 ${max}개만 표시. 셀렉터를 좁히거나 limit 을 늘리세요` : '';
      return text(found.slice(0, max).map(describeNode).join('\n') + more);
    },
  );

  server.registerTool(
    'a11y_audit',
    {
      description:
        '지금 화면의 접근성 점검: 터치 영역이 48dp 보다 작은 버튼, 글자·설명이 없는 버튼(스크린리더가 읽을 것이 없음), 같은 설명이 여러 버튼에 붙은 경우, 크기 0·화면 밖 요소. ' +
        '뷰 계층만 보므로 SDK 없이 아무 앱에나 쓴다 (색 대비는 보지 않는다)',
      inputSchema: { ...serialArg, limit: z.number().int().min(1).max(200).optional().describe('종류별로 보여 줄 최대 개수 (기본 15)') },
      annotations: readOnly,
    },
    async ({ serial, limit }) => {
      const dev = await device(serial);
      const [h, info, screen] = await Promise.all([dl.dumpHierarchy(dev), dl.getDeviceInfo(dev).catch(() => undefined), dl.screenSize(dev).catch(() => undefined)]);
      const density = info?.screen.density || 0;
      const issues = dl.auditA11y(h.root, { density: density || 420, screen });
      if (!issues.length) return text(`접근성 문제를 찾지 못했습니다 (누를 수 있는 요소 기준, 색 대비 제외)${density ? '' : '\n화면 밀도를 읽지 못해 420dpi 로 가정했습니다'}`);
      const titles: Record<dl.A11yIssueKind, string> = {
        'small-target': '터치 영역이 작음',
        'no-label': '라벨 없음',
        'duplicate-label': '같은 설명 반복',
        offscreen: '크기 0 또는 화면 밖',
      };
      const max = limit ?? 15;
      const out = [`접근성 문제 ${issues.length}건${density ? '' : ' (화면 밀도를 읽지 못해 420dpi 로 가정)'}`];
      for (const kind of Object.keys(titles) as dl.A11yIssueKind[]) {
        const list = issues.filter((i) => i.kind === kind);
        if (!list.length) continue;
        out.push(`## ${titles[kind]} ${list.length}건`, ...list.slice(0, max).map((i) => `- ${i.detail} — ${describeNode(i.node)}`));
        if (list.length > max) out.push(`  … 외 ${list.length - max}건 (limit 을 늘리세요)`);
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'screenshot_compare',
    {
      description:
        '지금 화면을 기준 이미지와 픽셀 비교 (시각적 회귀). 기준이 없으면 지금 화면을 기준으로 저장한다. 기준은 앱·이름·해상도별로 ~/.droidlens/baselines 에 남는다. ' +
        '상태바와 ignore 셀렉터에 맞는 요소(시계·광고·애니메이션)는 비교하지 않는다. 결과에 달라진 곳을 빨갛게 칠한 이미지를 붙인다. ' +
        '화면이 의도대로 바뀐 것이면 update=true 로 기준을 바꾼다',
      inputSchema: {
        ...serialArg,
        packageName: z.string().describe('기준 이미지를 묶을 앱'),
        name: z.string().describe('기준 이미지 이름 (예: 홈, 상품 상세)'),
        maxDiffPercent: z.number().min(0).max(100).optional().describe(`허용할 다른 픽셀 비율 (기본 ${dl.DEFAULT_MAX_DIFF_PERCENT})`),
        ignore: z.array(z.object(selectorShape)).optional().describe('비교에서 뺄 요소 셀렉터'),
        tolerance: z.number().int().min(0).max(255).optional().describe(`색 채널 차이가 이 값 이하면 같은 픽셀로 본다 (기본 ${dl.DEFAULT_TOLERANCE})`),
        update: z.boolean().optional().describe('비교하지 않고 지금 화면을 새 기준으로 저장'),
      },
      annotations: acts,
    },
    async ({ serial, packageName, name, maxDiffPercent, ignore, tolerance, update }) => {
      const sels = ignore?.map(pickSelector);
      const r = await dl.matchScreenshot(await device(serial), packageName, name, { ignore: sels, tolerance, update });
      // 기준을 처음 만든 경우도 녹화해, 저장된 스크립트를 다시 돌리면 그 기준과 비교한다
      if (!update) {
        recordStep({
          matchScreenshot: {
            name,
            ...(maxDiffPercent !== undefined ? { maxDiffPercent } : {}),
            ...(sels?.length ? { ignore: sels.map(cleanSelector) } : {}),
            ...(tolerance !== undefined ? { tolerance } : {}),
          },
        }, `화면 비교 "${name}"`);
      }
      if (r.saved) return text(`${update ? '기준 이미지를 바꿨습니다' : '기준 이미지가 없어 지금 화면을 기준으로 저장했습니다'}: ${r.baseline}`);
      const d = r.diff!;
      const max = maxDiffPercent ?? dl.DEFAULT_MAX_DIFF_PERCENT;
      const pass = d.diffPercent <= max;
      const shot = d.diffPixels ? await imageContent(d.diffPng) : undefined;
      return {
        content: [
          {
            type: 'text' as const,
            text: `${pass ? '통과' : '실패'}: 다른 픽셀 ${d.diffPercent}% (허용 ${max}%)${d.diffBounds ? `, 달라진 영역 [${d.diffBounds.join(',')}]` : ''}\n기준: ${r.baseline}${shot ? `\n달라진 영역은 기기 픽셀. 붙인 이미지: ${shot.note}` : ''}`,
          },
          ...(shot ? [shot.image] : []),
        ],
      };
    },
  );
}
