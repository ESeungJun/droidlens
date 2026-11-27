import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { text, acts, plainText, device, serialArg, recorder, logAction } from '../common.js';

/**
 * 디자인 비교 도구 (#77): Figma 커넥터 응답 원문을 가이드로 저장하고, 지금 기기 화면과 비교해 차이 목록을 낸다.
 * 통과·실패는 여기서 적지 않는다: 디자인 TC 도 scenario_start(tc) → design_compare → scenario_step(assert) → scenario_finish 로 근거와 함께 적는다
 */

/** 커넥터 응답 한 개의 최대 길이. 큰 프레임은 섹션마다 나눠 읽어 code 에 여러 개로 넘긴다 */
const MAX_RESPONSE = 1_500_000;
const MAX_LIST = 40;

const one = (v: string, max: number) => {
  const t = plainText(v).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function itemLine(i: number, it: dl.DesignDiffItem): string {
  const vals =
    it.expected !== undefined && it.actual !== undefined
      ? ` 가이드 ${one(it.expected ?? '-', 60)} · 화면 ${one(it.actual ?? '-', 60)}`
      : '';
  const delta = it.delta !== undefined ? ` (${it.delta}${it.unit ?? ''})` : '';
  return `${i + 1}. [${dl.SEVERITY_LABEL[it.severity]}] ${dl.DIFF_PROP_LABEL[it.prop]}${it.accuracy === 'estimated' ? '(추정)' : ''} "${one(it.element, 60)}"${vals}${delta}${it.note ? ` — ${one(it.note, 120)}` : ''}`;
}

export function register(server: McpServer): void {
  server.registerTool(
    'design_guide_save',
    {
      description:
        '디자인 TC 의 Figma 가이드를 저장한다. TC 의 design.figma 프레임을 Figma 커넥터로 읽고(get_metadata, get_design_context) 응답 원문을 고치지 말고 그대로 넘긴다. ' +
        '값을 옮겨 적거나 요약하지 않는다(core 가 노드 id·클래스를 파싱한다). 큰 프레임은 get_design_context 를 섹션 노드마다 불러 code 에 여러 개로 넣는다. ' +
        'MCP 서버에 FIGMA_TOKEN(Figma 개인 토큰)이 있으면 프레임 이미지를 Figma REST API 로 받아 함께 저장하고, 비교 보고서에 화면 조각과 나란히 놓는다. ' +
        '같은 TC 에 다시 저장하면 덮어쓴다',
      inputSchema: {
        plan: z.string().describe('QA 계획 id'),
        case: z.string().regex(dl.CASE_ID).describe('디자인 TC 번호 (TC-001). design.figma 가 있어야 한다'),
        metadata: z.string().max(MAX_RESPONSE).optional().describe('get_metadata 응답 원문 (프레임 전체. 위치·크기·문구)'),
        code: z.array(z.string().max(MAX_RESPONSE)).max(20).optional().describe('get_design_context 응답 원문들 (글자 크기·색·여백)'),
        example: z
          .array(z.string().max(200).regex(dl.FIGMA_NODE_ID))
          .max(500)
          .optional()
          .describe('가격·날짜·닉네임처럼 시안에 예시로 넣은 글자 노드 id. 문구는 비교하지 않고 자리로만 짝짓는다'),
        scale: z
          .number()
          .positive()
          .max(10)
          .optional()
          .describe('Figma px 하나가 몇 dp 인가. 생략하면 프레임 폭으로 정한다 (320~480 폭이면 1, 1080 폭이면 0.333)'),
      },
      annotations: acts,
    },
    async ({ plan, case: caseId, metadata, code, example, scale }) => {
      if (!metadata && !code?.length) throw new Error('metadata(get_metadata 응답)나 code(get_design_context 응답)를 넘기세요');
      const r = await dl.saveDesignGuide(plan, caseId, { metadata, code, example, scale });
      const g = r.guide;
      const texts = g.elements.filter((e) => e.kind === 'text');
      return text(
        [
          `${caseId} 가이드를 저장했습니다: 프레임 "${one(g.frame.name, 80)}" ${g.frame.width}×${g.frame.height} · 배율 ${g.scale}dp/px`,
          `요소 ${g.elements.length}개 (글자 ${texts.length} · 크기 아는 글자 ${texts.filter((e) => e.font?.size).length} · 색 아는 글자 ${texts.filter((e) => e.color).length} · 예시값 ${texts.filter((e) => e.example).length} · 배경 있는 상자 ${g.elements.filter((e) => e.kind === 'box' && e.background).length})`,
          g.image ? `Figma 이미지: ${g.image.width}×${g.image.height} (@${g.image.scale}x) 저장` : '',
          ...r.notes.map((n) => `- ${one(n, 200)}`),
          `다음: 그 화면까지 이동해 화면이 멈추면 design_compare(plan: "${plan}", case: "${caseId}")`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'design_compare',
    {
      description:
        '지금 기기 화면을 디자인 TC 의 Figma 가이드와 비교한다: 문구, 글자 크기, 글자·배경 색, 가로 여백, 위 요소와의 간격, 빠진 글자·더 있는 글자, ' +
        '배경 있는 상자의 크기, 그리고 화면 화소로 어림한 글자 굵기·줄 높이·모서리(추정, 낮음). ' +
        '허용치(글자 0.5sp, 간격·크기 2dp, 색 ΔE 3)를 넘는 것만 심각도(높음·중간·낮음)와 함께 돌려주고 결과(diff.json·report.html·표시한 화면, 가이드에 Figma 이미지가 있으면 나란히 놓은 조각)를 저장한다. ' +
        'scenario_start(tc) 로 그 TC 를 실행하는 중이면 plan·case·run 을 생략해도 된다. 화면이 다 그려지고 멈춘 뒤 부른다',
      inputSchema: {
        ...serialArg,
        plan: z.string().optional().describe('QA 계획 id. 생략하면 진행 중인 시나리오의 TC'),
        case: z.string().regex(dl.CASE_ID).optional().describe('디자인 TC 번호. 생략하면 진행 중인 시나리오의 TC'),
        run: z
          .string()
          .optional()
          .describe('결과를 붙일 회차 id. 생략하면 진행 중인 시나리오의 회차, 그것도 없으면 TC 의 마지막 결과로만 저장'),
      },
      annotations: acts,
    },
    async ({ serial, plan, case: caseId, run }) => {
      const tc = recorder.active ? recorder.tc : undefined;
      const p = plan ?? tc?.plan;
      const c = caseId ?? tc?.case;
      if (!p || !c) throw new Error('plan·case 를 주세요 (scenario_start(tc) 로 TC 를 실행하는 중이면 생략할 수 있다)');
      const r = run ?? (tc && tc.plan === p && tc.case === c ? tc.run : undefined);
      if (r) await dl.loadQaRun(p, r);
      const dev = await device(serial);
      const { result, files } = await dl.compareDesignOnDevice(dev, p, c, r);
      const n = result.items.length;
      logAction(`design_compare ${c}: 차이 ${n}건 (높음 ${result.counts.high})`, { keepsScreen: true });
      const found = result.matched.exact + result.matched.normalized + result.matched.similar + result.matched.position;
      const lines = [
        `${c} 디자인 비교: 차이 ${n}건 · 높음 ${result.counts.high} · 중간 ${result.counts.medium} · 낮음 ${result.counts.low}`,
        `가이드 글자 ${result.guideTexts}개 중 ${found}개를 화면에서 찾음 · 상자 ${result.boxes ?? 0}개 비교 · 화면 ${result.screen.width}×${result.screen.height}dp · 글자 크기 ${result.rendering ? '렌더링 정보' : '높이로 추정'}`,
        ...result.warnings.map((w) => `⚠ ${w}`),
        result.offscreen.length
          ? `화면 밖이라 비교하지 않음 ${result.offscreen.length}개 (스크롤한 뒤 다시 부르면 비교): ${result.offscreen
              .slice(0, 10)
              .map((t) => `"${one(t, 30)}"`)
              .join(', ')}`
          : '',
        ...result.items.slice(0, MAX_LIST).map((it, i) => itemLine(i, it)),
        n > MAX_LIST ? `… ${n}건 중 ${MAX_LIST}건만 표시 (전체는 diff.json)` : '',
        `리포트: ${files.html}`,
        tc && tc.case === c
          ? '맞는 화면인지는 scenario_step(assert) 로, 디자인 차이는 scenario_step(status, detail) 로 남기세요. 높음이 있으면 fail 입니다 (예시값·의도한 변경인지는 사용자가 정한다)'
          : '',
      ];
      return text(lines.filter(Boolean).join('\n'));
    },
  );
}
