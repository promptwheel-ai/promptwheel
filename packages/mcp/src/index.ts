#!/usr/bin/env node
/**
 * @promptwheel/mcp — MCP server entry point
 *
 * Runs as a stdio MCP server for Claude Code.
 * Usage: npx @promptwheel/mcp
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { createServer } from './server.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const projectPath = process.env.PROMPTWHEEL_PROJECT_PATH ?? process.cwd();

  // Determine DB path
  const bsDir = path.join(projectPath, '.promptwheel');
  if (!fs.existsSync(bsDir)) {
    fs.mkdirSync(bsDir, { recursive: true });
  }
  const dbPath = path.join(bsDir, 'state.sqlite');

  const db = await createSQLiteAdapter({ url: dbPath });

  const { server } = await createServer({
    db,
    projectPath,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await db.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('PromptWheel MCP server failed to start:', err);
  process.exit(1);
});
