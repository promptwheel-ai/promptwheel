/**
 * Direct Client — programmatic adapter for the PromptWheel canonical loop.
 *
 * Proves the MCP tools work without Claude Code or stdio transport.
 * Any LLM (or test harness) can drive the loop:
 *
 *   const client = await DirectClient.create({ projectPath });
 *   const session = client.startSession({ scope: 'src/**' });
 *   while (true) {
 *     const resp = await client.advance();
 *     if (resp.next_action === 'STOP') break;
 *     // ... call LLM with resp.prompt ...
 *     await client.ingestEvent(type, payload);
 *   }
 *   client.endSession();
 *   await client.close();
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project } from '@promptwheel/core';
import { RunManager } from './run-manager.js';
import { advance } from './advance.js';
import { processEvent } from './event-processor.js';
import type {
  AdvanceResponse,
  EventType,
  RunState,
  SessionConfig,
} from './types.js';

export interface DirectClientOptions {
  projectPath: string;
  projectName?: string;
  /** Provide an existing DB adapter (for testing). If omitted, creates SQLite at .promptwheel/state.sqlite */
  db?: DatabaseAdapter;
}

export class DirectClient {
  private run: RunManager;
  private db: DatabaseAdapter;
  private project: Project;
  private ownsDb: boolean;

  private constructor(
    run: RunManager,
    db: DatabaseAdapter,
    project: Project,
    ownsDb: boolean,
  ) {
    this.run = run;
    this.db = db;
    this.project = project;
    this.ownsDb = ownsDb;
  }

  /**
   * Create a DirectClient. Initializes SQLite and ensures the project exists.
   */
  static async create(options: DirectClientOptions): Promise<DirectClient> {
    const { projectPath, projectName } = options;
    let db = options.db;
    let ownsDb = false;

    if (!db) {
      const bsDir = path.join(projectPath, '.promptwheel');
      if (!fs.existsSync(bsDir)) {
        fs.mkdirSync(bsDir, { recursive: true });
      }
      db = await createSQLiteAdapter({ url: path.join(bsDir, 'state.sqlite') });
      ownsDb = true;
    }

    const project = await repos.projects.ensureForRepo(db, {
      name: projectName ?? path.basename(projectPath),
      rootPath: projectPath,
    });

    const run = new RunManager(projectPath);
    return new DirectClient(run, db, project, ownsDb);
  }

  /** Start a new session. Returns the initial RunState. */
  startSession(config: SessionConfig = {}): RunState {
    return this.run.create(this.project.id, config);
  }

  /** Get the next action. This is the core loop driver. */
  async advance(): Promise<AdvanceResponse> {
    return advance({ run: this.run, db: this.db, project: this.project });
  }

  /** Report an event back. Triggers state transitions. */
  async ingestEvent(
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<{ processed: boolean; message: string }> {
    // Log the raw event (matches what promptwheel_ingest_event tool does)
    this.run.appendEvent(type, payload);
    const result = await processEvent(this.run, this.db, type, payload);
    return { processed: result.processed, message: result.message };
  }

  /** Get current run state. */
  getState(): RunState {
    return this.run.require();
  }

  /** End the session. */
  endSession(): RunState {
    return this.run.end();
  }

  /** Clean up resources. */
  async close(): Promise<void> {
    if (this.ownsDb) {
      await this.db.close();
    }
  }

  /** Expose internals for testing */
  get _run(): RunManager { return this.run; }
  get _db(): DatabaseAdapter { return this.db; }
  get _project(): Project { return this.project; }
}
