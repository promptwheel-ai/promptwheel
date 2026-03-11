import chalk from 'chalk';
import type { DatabaseAdapter } from '@promptwheel/core/db';
import { createGitService } from './git.js';
import { getAdapter, initSolo, isInitialized } from './solo-config.js';

type JsonErrorShape = 'successFalse' | 'errorOnly';

interface ExitCommandErrorOptions {
  json?: boolean;
  message: string;
  humanMessage?: string;
  exitCode?: number;
  jsonShape?: JsonErrorShape;
  jsonExtra?: Record<string, unknown>;
  humanPrefix?: string;
  humanDetails?: string[];
  humanDetailsToStdout?: boolean;
  render?: boolean;
}

export class CommandRuntimeError extends Error {
  readonly json: boolean;
  readonly exitCode: number;
  readonly jsonShape: JsonErrorShape;
  readonly jsonExtra?: Record<string, unknown>;
  readonly humanMessage?: string;
  readonly humanPrefix?: string;
  readonly humanDetails?: string[];
  readonly humanDetailsToStdout: boolean;
  readonly render: boolean;

  constructor(options: ExitCommandErrorOptions) {
    super(options.message);
    this.name = 'CommandRuntimeError';
    this.json = options.json ?? false;
    this.exitCode = options.exitCode ?? 1;
    this.jsonShape = options.jsonShape ?? 'successFalse';
    this.jsonExtra = options.jsonExtra;
    this.humanMessage = options.humanMessage;
    this.humanPrefix = options.humanPrefix;
    this.humanDetails = options.humanDetails;
    this.humanDetailsToStdout = options.humanDetailsToStdout ?? false;
    this.render = options.render ?? true;
  }
}

export function isCommandRuntimeError(error: unknown): error is CommandRuntimeError {
  return error instanceof CommandRuntimeError;
}

export function renderCommandRuntimeError(error: CommandRuntimeError): void {
  if (!error.render) {
    return;
  }

  if (error.json) {
    const payload = error.jsonShape === 'errorOnly'
      ? { error: error.message, ...(error.jsonExtra ?? {}) }
      : { success: false, error: error.message, ...(error.jsonExtra ?? {}) };
    console.log(JSON.stringify(payload));
    return;
  }

  const prefix = error.humanPrefix ?? '✗';
  const renderedMessage = error.humanMessage ?? error.message;
  const line = prefix ? `${prefix} ${renderedMessage}` : renderedMessage;
  console.error(chalk.red(line));

  const detailWriter = error.humanDetailsToStdout ? console.log : console.error;
  for (const detail of error.humanDetails ?? []) {
    detailWriter(detail);
  }
}

export function exitCommandError(options: ExitCommandErrorOptions): never {
  throw new CommandRuntimeError(options);
}

export function exitCommand(exitCode = 0, message?: string): never {
  throw new CommandRuntimeError({
    message: message ?? `Command exited with code ${exitCode}`,
    exitCode,
    render: false,
  });
}

interface ResolveRepoRootOptions {
  cwd?: string;
  json?: boolean;
  notRepoMessage?: string;
  notRepoHumanMessage?: string;
  notRepoJsonShape?: JsonErrorShape;
  notRepoJsonExtra?: Record<string, unknown>;
  notRepoHumanPrefix?: string;
  notRepoHumanDetails?: string[];
  notRepoHumanDetailsToStdout?: boolean;
}

export async function resolveRepoRootOrExit(options: ResolveRepoRootOptions = {}): Promise<string> {
  const git = createGitService();
  const repoRoot = await git.findRepoRoot(options.cwd ?? process.cwd());

  if (!repoRoot) {
    exitCommandError({
      json: options.json,
      message: options.notRepoMessage ?? 'Not a git repository',
      humanMessage: options.notRepoHumanMessage,
      jsonShape: options.notRepoJsonShape ?? 'successFalse',
      jsonExtra: options.notRepoJsonExtra,
      humanPrefix: options.notRepoHumanPrefix,
      humanDetails: options.notRepoHumanDetails,
      humanDetailsToStdout: options.notRepoHumanDetailsToStdout,
    });
  }

  return repoRoot;
}

interface EnsureInitializedOptions {
  repoRoot: string;
  json?: boolean;
  autoInit?: boolean;
  quiet?: boolean;
  initMessage?: string;
  notInitializedMessage?: string;
  notInitializedHumanMessage?: string;
  notInitializedJsonShape?: JsonErrorShape;
  notInitializedJsonExtra?: Record<string, unknown>;
  notInitializedHumanPrefix?: string;
  notInitializedHumanDetails?: string[];
  notInitializedHumanDetailsToStdout?: boolean;
}

export async function ensureInitializedOrExit(options: EnsureInitializedOptions): Promise<void> {
  if (isInitialized(options.repoRoot)) {
    return;
  }

  if (options.autoInit) {
    if (!options.json && !options.quiet) {
      console.log(chalk.gray(options.initMessage ?? 'Initializing local state...'));
    }
    await initSolo(options.repoRoot);
    return;
  }

  exitCommandError({
    json: options.json,
    message: options.notInitializedMessage ?? 'PromptWheel not initialized',
    humanMessage: options.notInitializedHumanMessage,
    jsonShape: options.notInitializedJsonShape ?? 'successFalse',
    jsonExtra: options.notInitializedJsonExtra,
    humanPrefix: options.notInitializedHumanPrefix,
    humanDetails: options.notInitializedHumanDetails,
    humanDetailsToStdout: options.notInitializedHumanDetailsToStdout,
  });
}

export async function withCommandAdapter<T>(
  repoRoot: string,
  callback: (adapter: DatabaseAdapter) => Promise<T>,
): Promise<T> {
  const adapter = await getAdapter(repoRoot);
  try {
    return await callback(adapter);
  } finally {
    await adapter.close();
  }
}

export async function withOptionalCommandAdapter<T>(
  repoRoot: string,
  callback: (adapter: DatabaseAdapter | null) => Promise<T>,
): Promise<T> {
  let adapter: DatabaseAdapter | null = null;
  try {
    adapter = await getAdapter(repoRoot);
  } catch {
    // adapter stays null — caller handles missing DB gracefully
  }

  try {
    return await callback(adapter);
  } finally {
    if (adapter) {
      await adapter.close();
    }
  }
}
