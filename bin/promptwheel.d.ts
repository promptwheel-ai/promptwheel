// Type declarations for bin/promptwheel.mjs. Hand-written: there is no build step and no
// TypeScript dependency in this package. Every runtime export of the engine is declared here
// (test/promptwheel.test.mjs checks the list stays complete). The report shape is the
// Verified-Outcome Contract's Section 2 verdict object; see INTEGRATE.md for the integration
// surface and CONTRACT.md for the protocol.

// ---------------------------------------------------------------------------
// Section 2 vocabularies
// ---------------------------------------------------------------------------

/** The verdict of a check. */
export type Verdict = 'pass' | 'fail' | 'gamed' | 'inconclusive';

/** The status of one metric. A delta inside the measured noise band is `inconclusive`, never a regression. */
export type MetricStatus = 'improved' | 'regressed' | 'unchanged' | 'inconclusive' | 'unmeasurable';

/** The direction that counts as better. `pass` is a 0/1 gate (1 = the command exited 0). */
export type Direction = 'up' | 'down' | 'pass';

/** How much a delta can be trusted. `none` only on an unmeasurable metric; `unverified` is a single read with no noise sample. */
export type Confidence = 'none' | 'unverified' | 'low' | 'medium' | 'high';

/**
 * How a metric's value is read from its command: the last number in stdout (`number`, the
 * default), the count of non-empty lines (`lines`), the exit code as 1/0 (`exit`), or the
 * first capture group of a regex. A command that exits nonzero reads `null` (unmeasurable)
 * unless the metric sets `allowNonzero`; `exit` mode consumes the exit code by design.
 */
export type ExtractMode = 'number' | 'lines' | 'exit' | { regex: string };

// ---------------------------------------------------------------------------
// Config (promptwheel.config.json, or the `config` option of check())
// ---------------------------------------------------------------------------

export interface MetricConfig {
  name: string;
  /** Shell command run in a throwaway worktree at each ref. */
  cmd: string;
  /** Default `'number'`. */
  extract?: ExtractMode;
  /** Default `'up'`. */
  direction?: Direction;
  /** `true`: the value is a fingerprint, so any change at all regresses, whichever way the number moves. */
  exact?: boolean;
  /** A guarded metric fails the gate on a trusted regression; an unguarded one is tracked only. */
  guard?: boolean;
  /** Read a value even when `cmd` exits nonzero (never needed for `extract: 'exit'`). */
  allowNonzero?: boolean;
  /** Per-command timeout, default 300. */
  timeoutSec?: number;
  /** `false` skips the source-only re-proof for this metric (tripwires whose gain legitimately lives in test files). Set on a metric that had the re-proof on, it applies from the next change, not the one that sets it. */
  gamingCheck?: boolean;
  /** Per-metric override of `Config.gamingThreshold`. */
  gamingThreshold?: number;
  /**
   * `true` lets a declared reason (`--allow`, a `Promptwheel-Allow:` trailer, `check({ allow })`) clear
   * THIS metric's guarded regression for that run, recorded in `report.allowed` and on the metric as
   * `allowed: true`. The supply-chain preset's counters use it: a new dependency is sometimes the job,
   * so it passes with the reason on the record instead of the guard being loosened. Without a reason
   * the guard fails as usual.
   */
  allowable?: boolean;
}

/** A named hard rule: any change touching one of `paths` fails the gate, whatever the metrics read. */
export interface Mandate {
  name: string;
  /** Globs: a bare name matches that basename at any depth, a pattern with `/` is anchored at the repo root, `**` crosses directories. */
  paths: string[];
  reason?: string;
}

export interface Config {
  /** Path (or paths) to a shared base config whose metrics and mandates this repo inherits; resolved relative to the config file. */
  extends?: string | string[];
  metrics: MetricConfig[];
  mandates?: Mandate[];
  /** Measurement repeats per metric, for the noise band. Default 1. */
  repeat?: number;
  /** Back-compat for `linkDirs`: `false` links nothing. */
  linkNodeModules?: boolean;
  /** Directories outside git to symlink into each worktree (default `['node_modules']`). */
  linkDirs?: string[];
  /** Extra environment for the metric commands; `{wt}` expands to the worktree path. */
  env?: Record<string, string>;
  /** A per-ref build or install, run in the worktree before measuring (a failed setup leaves the metric inert, never a false green). */
  setup?: string;
  /** Fraction of a gain that must survive the source-only re-run; below it the win is `gamed`. Default 0.5. A change that lowers it is still judged by the value before it. */
  gamingThreshold?: number;
  /** Extra files that define the gate (a threshold, a budget); a change to one alongside a win is gamed by declaration. Same glob rules as `Mandate.paths`. */
  evaluatorPaths?: string[];
}

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

export interface CheckOptions {
  /** Repo path. Default: discovered from `process.cwd()`. */
  repo?: string;
  /** Base ref. Default: the merge-base with `origin/main` (then `origin/master`, `main`, `master`); on the trunk itself, `HEAD~1`. */
  base?: string;
  /** Head ref. Default `HEAD`. */
  head?: string;
  /** Gate uncommitted changes (tracked and untracked) instead of `base..head`. Default `false`. */
  working?: boolean;
  /**
   * A resolved config supplied in process, used as given (an `extends` chain is resolved only
   * when the config is loaded from `promptwheel.config.json`). Omit to load the file, or to
   * auto-detect the test command when there is none.
   */
  config?: Config;
  /** Allow the zero-config auto-detect fallback when there is no config file and no `config` option. Default `true`; `false` throws instead. */
  auto?: boolean;
  /** Measurement repeats for the noise band. Default `config.repeat ?? 1`. */
  repeat?: number;
  /** Run the Section 3 source-only re-proof. Default `true`. */
  detectGaming?: boolean;
  /** A declared override reason (the same as `--allow` or a `Promptwheel-Allow:` commit trailer): a would-be `gamed`, or an `unprovable` win (its source-only re-run could not be applied), reads `pass`, recorded in `report.allowed`. */
  allow?: string;
}

// ---------------------------------------------------------------------------
// The report (Section 2 verdict object)
// ---------------------------------------------------------------------------

/** What `evaluate()` returns for one metric: the before/after medians and the trust call on their delta. */
export interface Evaluation {
  before: number | null;
  after: number | null;
  /** `null` when either side is unmeasurable. */
  delta: number | null;
  status: MetricStatus;
  /** `false` only for a guarded metric with a trusted regression. */
  ok: boolean;
  confidence: Confidence;
  /** The measured jitter band (max spread across repeats); `null` when unmeasurable. */
  noise: number | null;
  /** A guarded pass/fail metric stuck at 0 at both refs: it protects nothing. */
  inert?: true;
}

export interface MetricResult extends Evaluation {
  name: string;
  direction: Direction;
  guard: boolean;
  /** With `inert`: where the command ran and failed (`both` refs, or only `base` or `head`). Absent when it ran at neither: exit 126 or 127, a timeout, or the placeholder command `init` writes. */
  ran?: 'both' | 'base' | 'head';
  /** With `inert`: a hint read from the command's output. `missing-dependency` when it names a module, package or command the clean copy does not have, else `failing`. Never part of a verdict. */
  cause?: 'missing-dependency' | 'failing' | 'too-much-output';
  /** With `cause: 'missing-dependency'`: the line that names what is missing, at most 200 characters. */
  detail?: string;
  /** `true` when the win did not survive the source-only re-run; `null` when the source-only patch could not be applied (then `unprovable` is set and the verdict is `inconclusive`, never `pass`). Absent without gaming detection or when the metric did not improve. */
  gamed?: boolean | null;
  /** `true`: the source-only patch could not be applied, so this win could not be re-proven and the verdict is `inconclusive`. `false` only after a declared override cleared it (then `allowed` is `true`). */
  unprovable?: boolean;
  /** The metric's value with only the source edits applied. */
  sourceOnly?: number | null;
  /** The fraction of the gain that survived source-only (0..1). */
  retained?: number | null;
  gamingReason?: string;
  /** Set when a declared override cleared a `gamed` or an `unprovable` on this metric. */
  /** `true`: a guard this change adds, unmeasurable at base because its scanner did not exist there. It starts counting from head. */
  adopted?: true;
  allowed?: true;
  /** Present (`true`) only when this guarded metric regressed, no reason was declared, and `allowable: true` means a `--allow` / trailer reason would clear it. */
  allowable?: true;
}

export interface MandateViolation {
  name: string;
  reason: string;
  /** The protected paths this change touched (at most 20). */
  files: string[];
  /** The mandate was deleted in this same change; it stays in force for the change that removes it. */
  removed?: true;
  /** The mandate's paths were edited in this same change; the version before the change stays in force for the change that edits it. */
  edited?: true;
}

export interface GateWeakening {
  name: string;
  /**
   * `guard-edited`: the guard is still on but measured another way (a new `cmd`, `extract`, `direction`, `exact` or `report`).
   * `measurement-edited`: the config's `setup`, `env` or linked dirs changed, and measured with the ones before the change the guard fails at head while the new ones read it fine.
   */
  change: 'guard-removed' | 'guard-disabled' | 'guard-edited' | 'measurement-edited';
  /** What the guard would have read at head under its base definition (and the base `setup`, `env` and linked dirs); `failed` when it still fails there. */
  status: MetricStatus | 'failed';
}

export interface EvaluatorChange {
  path: string;
  /** Truncated SHA-256 of the file at each ref; `null` where the file is absent. */
  base: string | null;
  head: string | null;
}

/** The gate-integrity record, present when gaming detection ran. */
export interface GateRecord {
  /** Truncated SHA-256 of the gate definition (metrics, guards, evaluatorPaths, gamingThreshold, mandates, setup, env, linked dirs) at each ref; `base` is `null` when there was no config at base. */
  fingerprint: { base: string | null; head: string };
  /** The gate definition differs between base and head. */
  changed?: true;
  /** Guards the change dropped, edited or measures another way that would have failed at head; non-empty forces `gamed` unless allowed. A change that adds the first config is compared with the zero-config gate (the detected test command). */
  weakened?: GateWeakening[];
  /** Declared `evaluatorPaths` files whose content changed in this diff. */
  evaluatorChanged?: EvaluatorChange[];
  /** A declared override cleared the weakening. */
  allowed?: true;
}

export interface AllowedRecord {
  reason: string;
  /** The metric names (and `'gate'`) the override cleared. */
  cleared: string[];
}

/** Tamper-evident receipt: re-run `(base, head, config)` and `verdictHash` must match. Additive; never changes the verdict. */
export interface Provenance {
  tool: 'promptwheel';
  toolVersion: string | null;
  baseSha: string | null;
  headSha: string | null;
  configHash: string;
  verdictHash: string;
}

export interface Report {
  /** Short SHA (or the ref as given when it cannot be resolved). */
  base: string;
  head: string;
  mode: 'refs' | 'working';
  repeat: number;
  verdict: Verdict;
  metrics: MetricResult[];
  /** Present only when a mandate was violated (the verdict is then `fail`). */
  mandates?: MandateViolation[];
  gate?: GateRecord;
  allowed?: AllowedRecord;
  /** Present only when the `setup` command failed: at which ref, with what exit code, and its last output line. */
  setup?: { base?: SetupFailure; head?: SetupFailure };
  provenance: Provenance;
}

export interface SetupFailure {
  /** The setup command's exit code, or `null` when it was killed (a timeout). */
  exit: number | null;
  lastLine: string;
}

// ---------------------------------------------------------------------------
// Public library API (stable across 0.x minors)
// ---------------------------------------------------------------------------

/** The Contract revision this build implements; bumps only when the verdict schema or the exit codes change. */
/** The output lines read as a missing dependency in the clean copy (module not found, a shell's "command not found"). */
export declare const MISSING_DEP: RegExp;
export declare const CONTRACT_VERSION: '1';
export declare const VERDICTS: readonly ['pass', 'fail', 'gamed', 'inconclusive'];
export declare const METRIC_STATUSES: readonly ['improved', 'regressed', 'unchanged', 'inconclusive', 'unmeasurable'];
export declare const DIRECTIONS: readonly ['up', 'down', 'pass'];

/** Section 1: `pass` 0, `fail` 1, `gamed` 2, `inconclusive` 3 (any other string maps to 1). The CLI exits with this. */
export declare function verdictExitCode(verdict: Verdict | string): 0 | 1 | 2 | 3;

/**
 * The Section 1 verdict from measured metrics, pure. A mandate hit (`mandated`) or a guarded
 * regression is `fail`; a `gamed:true` metric or an unallowed weakened gate is `gamed`;
 * `inconclusive` when an inert guard measured nothing and no metric improved, or when an improved
 * metric is `unprovable` (its source-only re-run could not be applied); else `pass`.
 */
export declare function deriveVerdict(metrics: ReadonlyArray<Partial<MetricResult>>, gateInfo?: { weakened?: unknown[]; allowed?: boolean } | null, mandated?: boolean): Verdict;

/**
 * Runs the gate in process and returns the Section 2 verdict object (identical to `run --json`).
 * Measures only in throwaway git worktrees, never the caller's working tree. Never prints and
 * never calls `process.exit`: every precondition failure (not a git repository, `auto: false`
 * with no config, a `config` without a non-empty `metrics` array, a malformed or cyclic config,
 * a missing `extends` target, no commits yet, a base or head ref that is not in this clone, no
 * commit to compare against) throws an Error whose `name` is `'ConfigError'` and whose `exitCode`
 * is 64, the code the CLI exits with for the same condition. A `repo` that names a subdirectory
 * is resolved to the repository root, where the config lives. A run writes nothing to the repo.
 */
export declare function check(options?: CheckOptions): Report;

/**
 * Structurally validate any verdict object against Section 2 (shapes, the fixed vocabularies,
 * and the honest-verdict rules). Zero dependency, so a third-party implementation can self-check
 * the artifact it emits. `errors` is empty exactly when `ok` is `true`.
 */
export declare function conformsToContract(report: unknown): { ok: boolean; errors: string[] };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests and for consumers that want the arithmetic)
// ---------------------------------------------------------------------------

/** Read a metric value from a command's stdout and exit code. */
export declare function extract(stdout: string, code: number, mode?: ExtractMode, allowNonzero?: boolean): number | null;

/** Median of the non-null samples; `null` when there are none. */
export declare function median(samples: ReadonlyArray<number | null | undefined>): number | null;

/** `max - min` of the non-null samples; `0` when there are none. */
export declare function spread(samples: ReadonlyArray<number | null | undefined>): number;

/** The credibility core: compare before/after samples and trust the delta only if it clears the observed noise band. */
export declare function evaluate(
  metric: Pick<MetricConfig, 'direction' | 'guard' | 'extract'>,
  beforeSamples: ReadonlyArray<number | null>,
  afterSamples: ReadonlyArray<number | null>,
  repeat: number,
): Evaluation;

/** Render a report as the PR-comment markdown the GitHub Action posts. */
export declare function renderMarkdown(report: Report): string;

/** The built-in classifier: is this repo-relative path test / config / grader / golden (not production source)? */
export declare function isNonSource(path: string): boolean;

/** Compile a config's `evaluatorPaths` globs into a matcher over repo-relative paths (always `false` when none are declared). */
export declare function evaluatorMatcher(config?: { evaluatorPaths?: string[] } | null): (path: string) => boolean;

/** Directional improvement of `value` over `before` (positive = better); `null` when either is missing. */
export declare function gain(metric: { direction?: Direction }, before: number | null, value: number | null): number | null;

/** The samples measured with only the source slice of the change applied. */
export interface SourceOnlyResult {
  samples: ReadonlyArray<number | null>;
  /** `false` when the change touched zero production-source files. */
  hadSourceChange: boolean;
  /** The source-only patch did not apply cleanly, so the judgement is inconclusive. */
  applyFailed?: boolean;
}

export interface GamingJudgement {
  /** `null` when the source-only patch did not apply (then `unprovable` is `true`). */
  gamed: boolean | null;
  /** The win could not be re-proven; gate() makes the verdict `inconclusive`. */
  unprovable?: true;
  sourceOnly: number | null;
  retained: number | null;
  reason: string;
}

/** Did a metric's full-diff win survive on the source edits alone? `gamed` when less than `threshold` (default 0.5) of the gain is retained. */
export declare function judgeGaming(
  metric: { direction?: Direction; before: number | null; after: number | null },
  sourceOnly: SourceOnlyResult,
  threshold?: number,
): GamingJudgement;

/** Truncated SHA-256 of the verdict content (everything but `provenance`), the reproducible half of the receipt. */
export declare function verdictFingerprint(report: Pick<Report, 'verdict'> & Partial<Pick<Report, 'metrics' | 'gate'>>): string;

/** The newest `sawbuck-allow: <reason>` comment from someone with write access, or ''. */
export declare function allowFromComments(comments: unknown[]): string;
