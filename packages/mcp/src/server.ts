/**
 * MCP Server setup and tool registration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseAdapter } from '@promptwheel/core';
import { repos } from '@promptwheel/core';
import { SessionManager } from './state.js';
import { registerSessionTools } from './tools/session.js';
import { registerExecuteTools } from './tools/execute.js';
import { registerGitTools } from './tools/git.js';
import { registerIntelligenceTools } from './tools/intelligence.js';
import { registerTrajectoryTools } from './tools/trajectory.js';

export interface ServerOptions {
  db: DatabaseAdapter;
  projectPath: string;
  projectName?: string;
  /** Register trajectory tools (default: true for backward compat, plugins may set false) */
  trajectoryTools?: boolean;
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
    name: 'promptwheel',
    version: '0.6.0',
  });

  // Register tool groups
  registerSessionTools(server, getState);
  registerExecuteTools(server, getState);
  registerGitTools(server, getState);
  registerIntelligenceTools(server, getState);
  if (options.trajectoryTools !== false) {
    registerTrajectoryTools(server, getState);
  }

  return { server, state };
}
