#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as dl from '@droidlens/core';
import { device } from './common.js';
import * as app from './tools/app.js';
import * as deviceTools from './tools/device.js';
import * as graph from './tools/graph.js';
import * as input from './tools/input.js';
import * as scenario from './tools/scenario.js';
import * as screen from './tools/screen.js';
import * as sdk from './tools/sdk.js';

export const VERSION = '0.8.3';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'droidlens', version: VERSION });
  for (const m of [deviceTools, screen, input, app, graph, sdk, scenario]) m.register(server);
  return server;
}

/**
 * CLI: 스크립트·스위트 실행 (CI용). 실패가 하나라도 있으면 종료 코드 1.
 *   droidlens-mcp run <파일|폴더> [--serial <serial>]
 */
async function cli(args: string[]): Promise<number> {
  const serialIdx = args.indexOf('--serial');
  const serial = serialIdx >= 0 ? args[serialIdx + 1] : undefined;
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--serial') ?? (await dl.scriptsDir());
  const dev = await device(serial);
  const icon = { pass: '✓', fail: '✗', skip: '–', running: '…' } as const;
  const r = await dl.runSuite(dev, target, {
    onScript: (p, i, total) => console.log(`\n[${i + 1}/${total}] ${p}`),
    onStep: (e) => {
      if (e.status === 'running') return;
      console.log(`  ${icon[e.status]} ${e.title}${e.status === 'fail' && e.detail ? `\n      ${e.detail.replace(/\n/g, '\n      ')}` : ''}`);
    },
  });
  console.log('');
  for (const x of r.results) {
    console.log(x.error ? `✗ ${x.name}: ${x.error}` : `${x.result!.verdict === 'pass' ? '✓' : '✗'} ${x.name}  ${x.result!.report}`);
  }
  console.log(`\n${r.passed}/${r.results.length} 통과 (${(r.durationMs / 1000).toFixed(1)}초)`);
  return r.failed ? 1 : 0;
}

if (process.argv[2] === 'run') {
  cli(process.argv.slice(3)).then(
    (code) => process.exit(code),
    (e) => {
      console.error((e as Error).message);
      process.exit(2);
    },
  );
} else {
  await createServer().connect(new StdioServerTransport());
}
