import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, serialArg, acts } from '../common.js';

export function register(server: McpServer): void {
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
      const screen = await dl.currentScreen(dev, { fragments: true }).catch(() => undefined);
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
}
