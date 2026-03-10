/**
 * Solo inspect command composition: scout, status, history, formulas, export, artifacts, approve
 */

import { Command } from 'commander';
import { registerInspectScoutCommand } from './inspect-scout.js';
import { registerInspectStatusCommand } from './inspect-status.js';
import { registerInspectHistoryCommand } from './inspect-history.js';
import { registerInspectExportCommand } from './inspect-export.js';
import { registerInspectArtifactsCommand } from './inspect-artifacts.js';
import { registerInspectApproveCommand } from './inspect-approve.js';
import { registerInspectBaselineCommand } from './inspect-baseline.js';
import { registerInspectRulesCommand } from './inspect-rules.js';
import { registerInspectIngestCommand } from './inspect-ingest.js';

export function registerInspectCommands(solo: Command): void {
  registerInspectScoutCommand(solo);
  registerInspectStatusCommand(solo);
  registerInspectHistoryCommand(solo);
  registerInspectExportCommand(solo);
  registerInspectArtifactsCommand(solo);
  registerInspectApproveCommand(solo);
  registerInspectBaselineCommand(solo);
  registerInspectRulesCommand(solo);
  registerInspectIngestCommand(solo);
}
