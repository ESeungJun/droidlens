import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, serialArg, readOnly, acts, recordStep } from '../common.js';

const mb = (kb: number | undefined) => (kb === undefined ? '-' : `${dl.kbToMb(kb)}MB`);

export function formatPerf(s: dl.PerfStats): string {
  const lines = [`PID ${s.pid}`, `CPU: ${s.cpuPercent === undefined ? '측정 실패' : `${s.cpuPercent}% (기기 전체 CPU 대비)`}`];
  const m = s.memory;
  if (m) {
    lines.push(
      `메모리 PSS: ${mb(m.totalPssKb)}${m.totalRssKb ? ` · RSS ${mb(m.totalRssKb)}` : ''}`,
      `  Java ${mb(m.javaHeapKb)} · Native ${mb(m.nativeHeapKb)} · Graphics ${mb(m.graphicsKb)} · Code ${mb(m.codeKb)} · 기타 ${mb(m.privateOtherKb)} · System ${mb(m.systemKb)}`,
    );
  } else lines.push('메모리: 읽지 못함');
  const f = s.frames;
  if (f) {
    lines.push(`프레임: ${f.totalFrames}개 중 버벅임 ${f.jankyFrames}개 (${f.jankPercent}%)`);
    if (f.p50Ms !== undefined) lines.push(`  프레임 시간 p50 ${f.p50Ms}ms · p90 ${f.p90Ms}ms · p99 ${f.p99Ms}ms`);
  } else lines.push('프레임: 읽지 못함');
  return lines.join('\n');
}

export function register(server: McpServer): void {
  server.registerTool(
    'perf_startup',
    {
      description:
        '앱 시작 시간 측정 (런처 아이콘을 누른 것과 같은 실행, am start -W). cold=true(기본)면 매번 강제 종료 후 실행, false면 홈으로 나갔다가 다시 열기. 앱이 재시작된다',
      inputSchema: {
        ...serialArg,
        packageName: z.string(),
        cold: z.boolean().optional(),
        runs: z.number().int().min(1).max(dl.MAX_STARTUP_RUNS).optional().describe('반복 횟수 (기본 3, 중앙값을 낸다)'),
      },
      annotations: acts,
    },
    async ({ serial, packageName, cold, runs }) => {
      const r = await dl.measureStartup(await device(serial), packageName, { cold, runs });
      recordStep({ startup: { ...(cold === false ? { cold } : {}), ...(runs ? { runs } : {}) } });
      return text(
        [
          `${r.cold ? '콜드' : '다시 열기'} 시작 ${r.runs.length}회: 중앙값 ${r.medianMs}ms (최소 ${r.minMs} · 최대 ${r.maxMs})`,
          ...r.runs.map((x, i) => `  ${i + 1}. ${x.ms}ms ${x.launchState ?? ''} ${x.activity ?? ''}`),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'perf_stats',
    {
      description:
        '실행 중인 앱의 CPU 사용률(1초 간격), 메모리(PSS, 영역별), 프레임 통계(버벅인 프레임 비율, 프레임 시간 백분위). 프레임은 앱 시작 또는 resetFrames 이후 누적. 특정 조작 구간만 보려면 resetFrames=true 로 초기화하고 조작한 뒤 다시 부른다',
      inputSchema: { ...serialArg, packageName: z.string(), resetFrames: z.boolean().optional().describe('읽은 뒤 프레임 통계를 0으로 초기화') },
      annotations: readOnly,
    },
    async ({ serial, packageName, resetFrames }) => {
      const dev = await device(serial);
      const s = await dl.perfStats(dev, packageName);
      if (!s) return text(`${packageName} 이(가) 실행 중이 아닙니다`);
      if (resetFrames) await dl.resetFrameStats(dev, packageName);
      return text(formatPerf(s) + (resetFrames ? '\n(프레임 통계를 초기화했습니다)' : ''));
    },
  );
}
