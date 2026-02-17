/**
 * Tool Registry — pure types, built-in specs, and filtering algorithms.
 *
 * Replaces hardcoded auto-approve arrays with a queryable set of tool specs.
 * No I/O — the ToolRegistry class in @promptwheel/mcp handles custom tool loading.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustLevel = 'safe' | 'default' | 'full';
export type ToolPhase = 'SCOUT' | 'PLAN' | 'EXECUTE' | 'QA' | 'PR';

export interface ToolSpec {
  name: string;
  description: string;
  approve_patterns: string[];
  phase_access: ToolPhase[];
  trust_levels: TrustLevel[];
  category_access: string[] | null;  // null = all categories
  constraint_note?: string;
  custom?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in tool specs (reproducing current hardcoded behavior exactly)
// ---------------------------------------------------------------------------

const ALL_PHASES: ToolPhase[] = ['SCOUT', 'PLAN', 'EXECUTE', 'QA', 'PR'];
const ALL_TRUST: TrustLevel[] = ['safe', 'default', 'full'];
const DEFAULT_PLUS: TrustLevel[] = ['default', 'full'];

export const BUILTIN_TOOL_SPECS: ToolSpec[] = [
  // Read-only tools — all phases, all trust
  {
    name: 'Read',
    description: 'Read file contents',
    approve_patterns: ['Read(*)'],
    phase_access: ALL_PHASES,
    trust_levels: ALL_TRUST,
    category_access: null,
  },
  {
    name: 'Glob',
    description: 'Search for files by pattern',
    approve_patterns: ['Glob(*)'],
    phase_access: ALL_PHASES,
    trust_levels: ALL_TRUST,
    category_access: null,
  },
  {
    name: 'Grep',
    description: 'Search file contents',
    approve_patterns: ['Grep(*)'],
    phase_access: ALL_PHASES,
    trust_levels: ALL_TRUST,
    category_access: null,
  },

  // Scout/Plan bash — read-only commands
  {
    name: 'Bash:scout',
    description: 'Read-only shell commands for scouting',
    approve_patterns: ['Bash(ls *)', 'Bash(find *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(wc *)'],
    phase_access: ['SCOUT', 'PLAN'],
    trust_levels: ALL_TRUST,
    category_access: null,
  },

  // Generic Edit/Write — EXECUTE only, default+ trust
  {
    name: 'Edit',
    description: 'Edit files (generic)',
    approve_patterns: ['Edit(*)'],
    phase_access: ['EXECUTE'],
    trust_levels: DEFAULT_PLUS,
    category_access: null,
  },
  {
    name: 'Write',
    description: 'Write files (generic)',
    approve_patterns: ['Write(*)'],
    phase_access: ['EXECUTE'],
    trust_levels: DEFAULT_PLUS,
    category_access: null,
  },

  // Docs Edit/Write — narrowed patterns, safe+ trust
  {
    name: 'Edit:docs',
    description: 'Edit documentation files only',
    approve_patterns: ['Edit(*.md)', 'Edit(*.mdx)', 'Edit(*.txt)', 'Edit(*.rst)'],
    phase_access: ['EXECUTE'],
    trust_levels: ALL_TRUST,
    category_access: ['docs'],
  },
  {
    name: 'Write:docs',
    description: 'Write documentation files only',
    approve_patterns: ['Write(*.md)', 'Write(*.mdx)', 'Write(*.txt)', 'Write(*.rst)'],
    phase_access: ['EXECUTE'],
    trust_levels: ALL_TRUST,
    category_access: ['docs'],
  },

  // Test Edit/Write — narrowed patterns, safe+ trust
  {
    name: 'Edit:test',
    description: 'Edit test files only',
    approve_patterns: [
      'Edit(*.test.*)', 'Edit(*.spec.*)', 'Edit(*__tests__*)',
      'Edit(test_*)', 'Edit(*_test.go)', 'Edit(*_test.py)', 'Edit(*Test.java)', 'Edit(*Test.kt)',
      'Edit(*_test.exs)', 'Edit(*Tests.swift)', 'Edit(*_spec.rb)',
    ],
    phase_access: ['EXECUTE'],
    trust_levels: ALL_TRUST,
    category_access: ['test'],
  },
  {
    name: 'Write:test',
    description: 'Write test files only',
    approve_patterns: [
      'Write(*.test.*)', 'Write(*.spec.*)', 'Write(*__tests__*)',
      'Write(test_*)', 'Write(*_test.go)', 'Write(*_test.py)', 'Write(*Test.java)', 'Write(*Test.kt)',
      'Write(*_test.exs)', 'Write(*Tests.swift)', 'Write(*_spec.rb)',
    ],
    phase_access: ['EXECUTE'],
    trust_levels: ALL_TRUST,
    category_access: ['test'],
  },

  // Test/build commands — EXECUTE + QA
  {
    name: 'Bash:test',
    description: 'Run tests and type checks',
    approve_patterns: [
      // JS/TS
      'Bash(npm test*)', 'Bash(npx vitest*)', 'Bash(npx jest*)', 'Bash(npx tsc*)',
      'Bash(yarn test*)', 'Bash(pnpm test*)', 'Bash(bun test*)',
      // Python
      'Bash(pytest*)', 'Bash(python -m pytest*)', 'Bash(tox*)', 'Bash(python -m unittest*)',
      // Rust
      'Bash(cargo test*)', 'Bash(cargo check*)', 'Bash(cargo clippy*)',
      // Go
      'Bash(go test*)', 'Bash(go vet*)',
      // Java/Kotlin
      'Bash(mvn test*)', 'Bash(./gradlew test*)', 'Bash(gradle test*)',
      // Ruby
      'Bash(bundle exec rspec*)', 'Bash(bundle exec rake test*)',
      // Elixir
      'Bash(mix test*)',
      // .NET
      'Bash(dotnet test*)',
      // PHP
      'Bash(./vendor/bin/phpunit*)', 'Bash(phpunit*)',
      // Swift
      'Bash(swift test*)',
      // Make
      'Bash(make test*)', 'Bash(make check*)',
    ],
    phase_access: ['EXECUTE', 'QA'],
    trust_levels: ALL_TRUST,
    category_access: null,
  },

  // Git status — EXECUTE + QA
  {
    name: 'Bash:git-status',
    description: 'Git diff and status commands',
    approve_patterns: ['Bash(git diff*)', 'Bash(git status*)'],
    phase_access: ['EXECUTE', 'QA'],
    trust_levels: ALL_TRUST,
    category_access: null,
  },

  // Git operations — PR phase
  {
    name: 'Bash:git-ops',
    description: 'Git operations for PR creation',
    approve_patterns: ['Bash(git *)'],
    phase_access: ['PR'],
    trust_levels: DEFAULT_PLUS,
    category_access: null,
  },

  // GitHub CLI — PR phase
  {
    name: 'Bash:gh',
    description: 'GitHub CLI for PR creation',
    approve_patterns: ['Bash(gh pr *)'],
    phase_access: ['PR'],
    trust_levels: DEFAULT_PLUS,
    category_access: null,
  },

  // Security constraint (no patterns, just a constraint note)
  {
    name: 'constraint:security',
    description: 'Security ticket constraints',
    approve_patterns: [],
    phase_access: ['EXECUTE'],
    trust_levels: ALL_TRUST,
    category_access: ['security'],
    constraint_note: 'This is a **security** ticket. You have full read/edit access but MUST NOT install new dependencies (`npm install`, `pip install`, `cargo add`, `go get`, `bundle add`, `composer require`, etc.). Do NOT run arbitrary shell commands beyond testing and type-checking.',
  },
];

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter tool specs by phase, category, and trust level.
 * Category-specific tools (e.g. Edit:docs) exclude their generic counterpart
 * (Edit) for that category to prevent overly-broad auto-approve.
 */
export function filterToolSpecs(
  specs: ToolSpec[],
  phase: ToolPhase,
  category: string | null,
  trustLevel: TrustLevel = 'default',
): ToolSpec[] {
  const trustOrder: Record<TrustLevel, number> = { safe: 0, default: 1, full: 2 };
  const requestedLevel = trustOrder[trustLevel];

  // First pass: find which generic tools have category-specific overrides
  const categoryOverrides = new Set<string>();
  for (const spec of specs) {
    if (spec.category_access !== null && category && spec.category_access.includes(category)) {
      // e.g., Edit:docs → overrides 'Edit'
      const baseName = spec.name.split(':')[0];
      categoryOverrides.add(baseName);
    }
  }

  return specs.filter(spec => {
    // Phase check
    if (!spec.phase_access.includes(phase)) return false;

    // Trust level check
    const minLevel = trustOrder[spec.trust_levels[0]];
    if (requestedLevel < minLevel) return false;

    // Category check
    if (spec.category_access !== null) {
      if (!category || !spec.category_access.includes(category)) return false;
    } else {
      // Generic tool — exclude if a category-specific override exists
      const baseName = spec.name.split(':')[0];
      if (categoryOverrides.has(baseName) && !spec.name.includes(':')) {
        // Only exclude Edit/Write, not Read/Glob/Grep/Bash
        if (baseName === 'Edit' || baseName === 'Write') return false;
      }
    }

    return true;
  });
}

/**
 * Collect all auto-approve patterns from a set of filtered specs.
 */
export function collectApprovePatterns(specs: ToolSpec[]): string[] {
  const patterns: string[] = [];
  for (const spec of specs) {
    for (const p of spec.approve_patterns) {
      if (!patterns.includes(p)) {
        patterns.push(p);
      }
    }
  }
  return patterns;
}

/**
 * Collect constraint notes from filtered specs.
 * Returns undefined if no constraint notes exist.
 */
export function collectConstraintNotes(specs: ToolSpec[]): string | undefined {
  const notes = specs
    .filter(s => s.constraint_note)
    .map(s => s.constraint_note!);
  return notes.length > 0 ? notes.join('\n\n') : undefined;
}
