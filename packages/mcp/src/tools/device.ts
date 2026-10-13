import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'node:path';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { adb, device, text, json, imageContent, saveShot, serialArg, readOnly, acts } from '../common.js';

export function register(server: McpServer): void {
  // ---------- 기기 ----------

  server.registerTool(
    'devices',
    { description: '연결된 Android 기기/에뮬레이터 목록', annotations: readOnly },
    async () => json(await dl.listDevices(adb)),
  );

  server.registerTool(
    'device_info',
    { description: '기기 모델, Android 버전, 화면 크기/밀도', inputSchema: serialArg, annotations: readOnly },
    async ({ serial }) => json(await dl.getDeviceInfo(await device(serial))),
  );

  server.registerTool(
    'screenshot',
    {
      description: '현재 화면 스크린샷. 이미지와 저장 경로를 반환',
      inputSchema: { ...serialArg, label: z.string().optional().describe('파일 이름에 붙일 라벨') },
      annotations: readOnly,
    },
    async ({ serial, label }) => {
      const png = await dl.screenshot(await device(serial));
      const path = await saveShot(png, label);
      return { content: [await imageContent(png), { type: 'text', text: `saved: ${path}` }] };
    },
  );

  const recordings = new Map<string, dl.Recording>();

  server.registerTool(
    'record_start',
    {
      description: '화면 녹화 시작 (최대 180초). record_stop으로 종료하면 mp4 경로를 반환',
      inputSchema: { ...serialArg, maxSeconds: z.number().int().min(1).max(180).optional() },
      annotations: acts,
    },
    async ({ serial, maxSeconds }) => {
      const dev = await device(serial);
      if (recordings.has(dev.serial)) return text('이미 녹화 중입니다.');
      recordings.set(dev.serial, dl.startRecording(dev, { maxSeconds }));
      return text(`녹화 시작 (${dev.serial})`);
    },
  );

  server.registerTool(
    'record_stop',
    { description: '화면 녹화 종료 후 mp4를 로컬에 저장', inputSchema: { ...serialArg, label: z.string().optional() }, annotations: acts },
    async ({ serial, label }) => {
      const dev = await device(serial);
      const rec = recordings.get(dev.serial);
      if (!rec) return text('진행 중인 녹화가 없습니다.');
      recordings.delete(dev.serial);
      const dir = await dl.ensureDir('recordings');
      const path = await rec.stop(join(dir, `${dl.timestamp()}_${dl.safeName(label ?? 'record')}.mp4`));
      return text(`saved: ${path} (${((Date.now() - rec.startedAt) / 1000).toFixed(1)}s)`);
    },
  );

  server.registerTool(
    'agent_status',
    {
      description: '온디바이스 에이전트 상태 (설치 버전, 실행 여부). start=true면 설치·실행을 시도한다. 에이전트가 있으면 뷰 계층이 10배 이상 빠르고 한글 입력이 된다',
      inputSchema: { ...serialArg, start: z.boolean().optional() },
      annotations: acts,
    },
    async ({ serial, start }) => {
      const dev = await device(serial);
      if (start) await dl.ensureAgent(dev, { force: true });
      return json(await dl.agentStatus(dev));
    },
  );
}
