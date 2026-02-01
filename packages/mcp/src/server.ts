/**
 * MCP Server setup and tool registration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseAdapter } from '@blockspool/core';
import { repos } from '@blockspool/core';
import { SessionManager } from './state.js';
import { registerSessionTools } from './tools/session.js';
import { registerScoutTools } from './tools/scout.js';
import { registerExecuteTools } from './tools/execute.js';
import { registerGitTools } from './tools/git.js';

export interface ServerOptions {
  db: DatabaseAdapter;
  projectPath: string;
  projectName?: string;
}

export async function createServer(options: ServerOptions): Promise<{
  server: McpServer;
  state: SessionManager;
}> {
  const { db, projectPath, projectName } = options;

  // Ensure project exists
  const project = await repos.projects.ensureForRepo(db, {
    name: projectName ?? projectPath.split('/').pop() ?? 'unknown',
    rootPath: projectPath,
  });

  const state = new SessionManager(db, project, projectPath);
  const getState = () => state;

  const server = new McpServer({
    name: 'blockspool',
    version: '0.5.12',
  });

  // Register tool groups
  registerSessionTools(server, getState);
  registerScoutTools(server, getState);
  registerExecuteTools(server, getState);
  registerGitTools(server, getState);

  return { server, state };
}
