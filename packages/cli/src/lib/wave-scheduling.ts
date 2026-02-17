/**
 * Wave scheduling utilities for conflict-free parallel execution.
 *
 * Pure algorithms (conflict detection, partitioning, escalation) live in
 * @promptwheel/core/waves/shared. This file provides metric instrumentation
 * and re-exports.
 */

import { metric } from './metrics.js';

// Re-export everything from core
export {
  type ConflictSensitivity,
  type ConflictDetectionOptions,
  CONFLICT_PRONE_FILENAMES,
  SHARED_DIRECTORY_PATTERNS,
  PACKAGE_PATTERN,
  DIRECTORY_OVERLAP_NORMAL,
  DIRECTORY_OVERLAP_STRICT,
  parsePath,
  pathsOverlap,
  directoriesOverlap,
  isConflictProneFile,
  isInSharedDirectory,
  getDirectories,
  hasSiblingFiles,
  hasConflictProneOverlap,
  hasSharedParentConflict,
  touchesSamePackage,
  proposalsConflict,
  buildScoutEscalation,
} from '@promptwheel/core/waves/shared';

// Import for local use
import type { ConflictDetectionOptions } from '@promptwheel/core/waves/shared';
import {
  partitionIntoWaves as partitionIntoWavesCore,
} from '@promptwheel/core/waves/shared';

/**
 * Partition proposals into conflict-free waves, with CLI metric instrumentation.
 * Wraps the core pure algorithm and adds metric() call.
 */
export function partitionIntoWaves<T extends { files: string[]; category?: string }>(
  proposals: T[],
  options: ConflictDetectionOptions = {}
): T[][] {
  const waves = partitionIntoWavesCore(proposals, options);

  // Instrument: track wave partitioning
  if (proposals.length > 0) {
    metric('wave', 'partitioned', {
      proposals: proposals.length,
      waves: waves.length,
      parallelizable: waves.length === 1 || (waves.length < proposals.length),
      maxParallel: Math.max(...waves.map(w => w.length)),
    });
  }

  return waves;
}
