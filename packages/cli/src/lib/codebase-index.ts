/**
 * Re-exports from @blockspool/core — single source of truth for codebase indexing.
 */
export {
  buildCodebaseIndex,
  refreshCodebaseIndex,
  hasStructuralChanges,
  formatIndexForPrompt,
  getTrackedDirectories,
  SOURCE_EXTENSIONS,
  type CodebaseIndex,
  type ModuleEntry,
  type LargeFileEntry,
  type ClassificationConfidence,
} from '@blockspool/core/codebase-index';
