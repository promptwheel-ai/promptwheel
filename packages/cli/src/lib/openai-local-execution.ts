/**
 * OpenAI-compatible local execution backend with agentic tool-use loop
 *
 * Uses raw fetch against any OpenAI-compatible API (Ollama, vLLM, SGLang, LM Studio).
 * Provides read_file, write_file, run_command tools for the LLM to use.
 * No sandbox — worktree isolation + QA gating provides safety.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { ClaudeResult, ExecutionBackend } from './execution-backends/index.js';

const TOOL_OUTPUT_CAP = 10_000;
const COMMAND_TIMEOUT_MS = 60_000;

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Path is relative to the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed. Path is relative to the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project root directory. Returns stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
];

function resolveSafePath(worktreePath: string, relativePath: string): string {
  const resolved = path.resolve(worktreePath, relativePath);
  const normalizedRoot = path.resolve(worktreePath) + path.sep;
  const normalizedResolved = path.resolve(resolved);
  if (!normalizedResolved.startsWith(normalizedRoot) && normalizedResolved !== path.resolve(worktreePath)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  // Resolve symlinks to prevent escaping worktree via symlink targets
  try {
    const realPath = fs.realpathSync(normalizedResolved);
    const realRoot = fs.realpathSync(worktreePath) + path.sep;
    if (!realPath.startsWith(realRoot) && realPath !== fs.realpathSync(worktreePath)) {
      throw new Error(`Symlink traversal blocked: ${relativePath} resolves outside worktree`);
    }
    return realPath;
  } catch (err) {
    // File may not exist yet (write_file creates it) — allow if logical path is safe
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return normalizedResolved;
    }
    throw err;
  }
}

function executeTool(
  name: string,
  args: Record<string, string>,
  worktreePath: string,
): string {
  switch (name) {
    case 'read_file': {
      const filePath = resolveSafePath(worktreePath, args.path);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.length > TOOL_OUTPUT_CAP
          ? content.slice(0, TOOL_OUTPUT_CAP) + '\n... (truncated)'
          : content;
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case 'write_file': {
      const filePath = resolveSafePath(worktreePath, args.path);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content, 'utf-8');
        return `File written: ${args.path}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case 'run_command': {
      try {
        const output = execSync(args.command, {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output.length > TOOL_OUTPUT_CAP
          ? output.slice(0, TOOL_OUTPUT_CAP) + '\n... (truncated)'
          : output || '(no output)';
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        const combined = [execErr.stdout, execErr.stderr].filter(Boolean).join('\n') || execErr.message || String(err);
        return combined.length > TOOL_OUTPUT_CAP
          ? combined.slice(0, TOOL_OUTPUT_CAP) + '\n... (truncated)'
          : combined;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
}

export class OpenAILocalExecutionBackend implements ExecutionBackend {
  readonly name = 'openai-local';
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private maxIterations: number;

  constructor(opts: { baseUrl: string; model: string; apiKey?: string; maxIterations?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.maxIterations = opts.maxIterations ?? 20;
  }

  async run(opts: {
    worktreePath: string;
    prompt: string;
    timeoutMs: number;
    verbose: boolean;
    onProgress: (msg: string) => void;
  }): Promise<ClaudeResult> {
    const { worktreePath, prompt, timeoutMs, verbose, onProgress } = opts;
    const startTime = Date.now();

    const controller = new AbortController();
    // Only set timeout if timeoutMs > 0 (0 = no timeout)
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      onProgress('Sending to local model...');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a coding assistant. You have tools to read files, write files, and run commands in the project directory. Use them to complete the task. When done, respond with a summary of what you did.',
        },
        { role: 'user', content: prompt },
      ];

      let allAssistantText = '';

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        if (controller.signal.aborted) {
          throw new Error('AbortError');
        }

        onProgress(`Iteration ${iteration + 1}/${this.maxIterations}...`);

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages,
            tools: TOOLS,
            temperature: 0,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            success: false,
            error: `HTTP ${response.status}: ${body.slice(0, 500)}`,
            stdout: allAssistantText,
            stderr: body,
            exitCode: 1,
            timedOut: false,
            durationMs: Date.now() - startTime,
          };
        }

        const data = (await response.json()) as ChatCompletionResponse;
        const choice = data.choices?.[0];
        const assistantMessage = choice?.message;

        if (!assistantMessage) {
          return {
            success: false,
            error: 'No response from model',
            stdout: allAssistantText,
            stderr: '',
            exitCode: 1,
            timedOut: false,
            durationMs: Date.now() - startTime,
          };
        }

        // Collect any text content
        if (assistantMessage.content) {
          allAssistantText += (allAssistantText ? '\n' : '') + assistantMessage.content;
        }

        // Add assistant message to conversation
        messages.push({
          role: 'assistant',
          content: assistantMessage.content ?? null,
          tool_calls: assistantMessage.tool_calls,
        });

        // If no tool calls, we're done
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          onProgress('Response received');
          return {
            success: true,
            stdout: allAssistantText,
            stderr: '',
            exitCode: 0,
            timedOut: false,
            durationMs: Date.now() - startTime,
          };
        }

        // Execute tool calls sequentially
        for (const toolCall of assistantMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let args: Record<string, string>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          if (verbose) {
            onProgress(`Tool: ${fnName}(${JSON.stringify(args).slice(0, 100)})`);
          }

          const result = executeTool(fnName, args, worktreePath);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }
      }

      // Exhausted iterations
      onProgress('Max iterations reached');
      return {
        success: allAssistantText.length > 0,
        stdout: allAssistantText,
        stderr: `Max iterations (${this.maxIterations}) reached`,
        exitCode: allAssistantText.length > 0 ? 0 : 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('abort') || message.includes('AbortError');

      return {
        success: false,
        error: isTimeout ? `Timed out after ${timeoutMs}ms` : message,
        stdout: '',
        stderr: message,
        exitCode: null,
        timedOut: isTimeout,
        durationMs,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
