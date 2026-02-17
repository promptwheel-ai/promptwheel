/**
 * MCP Batch Server for persistent Codex sessions
 *
 * A lightweight stdio MCP server that exposes batch analysis tools.
 * Codex connects to this server and loops: get_next_batch → analyze → submit_results.
 *
 * Usage:
 *   node dist/scout/mcp-batch-server.js --data <path-to-json>
 *
 * The JSON file contains an array of batch prompt strings.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface McpBatchServerOptions {
  /** Pre-built batch prompts */
  batchPrompts: string[];
}

/**
 * MCP server that serves batches to a Codex session.
 *
 * Tools exposed:
 * - get_next_batch: Returns { batchId, prompt } or { done: true }
 * - submit_results: Accepts { batchId, output }
 * - signal_done: Confirms all batches processed
 */
export class McpBatchServer {
  private batches: Array<{ id: number; prompt: string }>;
  private cursor = 0;
  private results = new Map<number, string>();
  private doneResolve?: () => void;
  private server: Server;

  constructor(opts: McpBatchServerOptions) {
    this.batches = opts.batchPrompts.map((p, i) => ({ id: i, prompt: p }));

    this.server = new Server(
      { name: 'promptwheel-batch-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_next_batch',
          description: 'Get the next batch of code to analyze. Returns { batchId, prompt } or { done: true } when all batches are consumed.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'submit_results',
          description: 'Submit analysis results for a batch. Pass the raw JSON output from your analysis.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              batchId: { type: 'number', description: 'The batchId from get_next_batch' },
              output: { type: 'string', description: 'The analysis output (JSON string with proposals)' },
            },
            required: ['batchId', 'output'],
          },
        },
        {
          name: 'signal_done',
          description: 'Signal that all batches have been processed. Call this after the last submit_results.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'get_next_batch': {
          if (this.cursor >= this.batches.length) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ done: true }) }] };
          }
          const batch = this.batches[this.cursor++];
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ batchId: batch.id, prompt: batch.prompt }) }],
          };
        }

        case 'submit_results': {
          const batchId = (args as Record<string, unknown>)?.batchId as number;
          const output = (args as Record<string, unknown>)?.output as string;
          if (batchId === undefined || output === undefined) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'batchId and output are required' }) }], isError: true };
          }
          this.results.set(batchId, output);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, received: this.results.size, total: this.batches.length }) }],
          };
        }

        case 'signal_done': {
          this.doneResolve?.();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
        }

        default:
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
      }
    });
  }

  /**
   * Start the MCP server on stdio.
   * Returns a promise that resolves with collected results when signal_done is called.
   */
  async start(): Promise<Map<number, string>> {
    const donePromise = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    await donePromise;
    await this.server.close();

    return this.results;
  }
}

/**
 * CLI entrypoint: node mcp-batch-server.js --data <path>
 *
 * The data file is a JSON array of prompt strings.
 */
async function main() {
  const dataIdx = process.argv.indexOf('--data');
  if (dataIdx === -1 || !process.argv[dataIdx + 1]) {
    process.stderr.write('Usage: mcp-batch-server --data <path-to-prompts.json>\n');
    process.exit(1);
  }

  const dataPath = process.argv[dataIdx + 1];
  const prompts: string[] = JSON.parse(readFileSync(dataPath, 'utf-8'));

  const server = new McpBatchServer({ batchPrompts: prompts });
  const results = await server.start();

  // Write results to disk so the parent process can read them.
  // Derive the output directory from --results-dir arg or fall back to the
  // same directory as the --data file.
  const resultsDirIdx = process.argv.indexOf('--results-dir');
  const resultsDir = (resultsDirIdx !== -1 && process.argv[resultsDirIdx + 1])
    ? process.argv[resultsDirIdx + 1]
    : dirname(dataPath);
  const resultsObj: Record<string, string> = {};
  for (const [k, v] of results) {
    resultsObj[String(k)] = v;
  }
  writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(resultsObj));
}

// Run as CLI if executed directly
const isMainModule = process.argv[1]?.endsWith('mcp-batch-server.js') ||
  process.argv[1]?.endsWith('mcp-batch-server.ts');
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`MCP batch server error: ${err}\n`);
    process.exit(1);
  });
}
