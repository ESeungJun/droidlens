#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as app from './tools/app.js';
import * as device from './tools/device.js';
import * as graph from './tools/graph.js';
import * as input from './tools/input.js';
import * as scenario from './tools/scenario.js';
import * as screen from './tools/screen.js';
import * as sdk from './tools/sdk.js';

export const VERSION = '0.3.0';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'droidlens', version: VERSION });
  for (const m of [device, screen, input, app, graph, sdk, scenario]) m.register(server);
  return server;
}

await createServer().connect(new StdioServerTransport());
