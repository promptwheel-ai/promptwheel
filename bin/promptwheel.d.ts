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
  /** On a guard: a trusted regression is let through when the metric named in `gain` improved in the same change (earned in the source) and this one got worse by a share of its old value no larger than `base + rate * gain`. Part of the guard: a change cannot write or loosen its own. */
  budget?: { gain: string; base?: number; rate?: number };
  /** The noise band for this metric, in its own units: a difference no larger than this is `inconclusive`, never a win and never a failure. For a number that does not hold still (a model-graded score, a timing). It replaces the band measured across repeats, so it holds at one run a side and more repeats do not widen it. Not read on a pass/fail metric or an `exact` one. Part of how the metric is judged: a change is held to the band the contract had before it, and a band it adds counts from the next change on. `calibrate()` measures one. */
  noise?: number;
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
  /** Add one short row for this run to the record (in the repo's git folder, never the working tree). Default `false`: the CLI's `run` adds a row unless `--no-record`, the library only when asked. The record never changes a verdict. */
  record?: boolean;
  /** A short name for the change, kept in the row when `record` is on. */
  label?: string;
  /** A folder outside the repository that keeps the base's measurement between runs (`--base-cache`). A kept number is reused only for the same tree measured the same way (commands, setup, env, linked dirs, repeat count, engine version, platform), and only a clean measurement is kept. A folder inside the repository throws a `ConfigError`: a kept number the change can reach is a goalpost. */
  baseCache?: string;
  /** The change is a pull request (`--pull-request`; the Action passes it there and only there): tests an earlier commit of it added, all gone at its head, fail the check as `tests_taken_out`, which a person's reason (`allow`) lets through. Default `false`: they are a note. */
  pullRequest?: boolean;
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
  /** The noise band the delta was held against: the one the contract declares for the metric, else the measured jitter (max spread across repeats); `null` when unmeasurable. */
  noise: number | null;
  /** Only where the band was declared: the measured jitter (max spread across repeats), reported beside it. */
  spread?: number;
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
  /** The command failed at the base for want of something not installed (a tool, a module, a file inside a package) and ran at the head. So the earlier state did not run: it did not fail. Both commits are measured with what is installed now, and a change that removes a tool the earlier tests need looks like this. The reading alone: no verdict reads it yet. */
  baseUnrun?: { cause: 'missing-dependency'; detail: string };
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
  /** A trusted regression of this guard that a `budget` let through: the metric that paid, the regression as a share of the old value, and the share that gain buys. */
  paid?: { gain: string; share: number; allowed: number };
  /** A trusted regression that went over its `budget`: the same three numbers. The metric fails as a guard does. */
  overBudget?: { gain: string; share: number; allowed: number };
  /** Present (`true`) only when this guarded metric regressed, no reason was declared, and `allowable: true` means a `--allow` / trailer reason would clear it. */
  allowable?: true;
  /** A counting tripwire that fell, in a run between two commits: the files where it fell furthest, at most five. */
  where?: { file: string; before: number; after: number }[];
  /** A count of tests or assertions that held for the repo and fell in these files (a file moved or split is left out). A note for a reader, never part of a verdict. */
  lostIn?: { file: string; before: number; after: number }[];
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
  /** The changed paths the source-only re-run does not take from the change: tests, graders, config, declared evaluator paths, a runner a guard names, and a `package.json` or `pyproject.toml` whose test keys changed. Sorted. Empty means the source-only tree is the head tree, so nothing over this span can read `gamed`. Absent on a report made before 0.8.12. */
  goalposts?: string[];
  /** A declared override cleared the weakening. */
  allowed?: true;
}

export interface AllowedRecord {
  reason: string;
  /** The names the reason let through: metric names, `'gate'`, and `'mandate:<name>'`. Empty when the reason could reach more than one thing and named none of them. */
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
  /** Present only when the base's numbers were kept from an earlier run (`baseCache`) and not measured in this one: when they were measured (ISO time). */
  baseMeasured?: string;
  metrics: MetricResult[];
  /** Present only when a mandate was violated (the verdict is then `fail`). */
  mandates?: MandateViolation[];
  gate?: GateRecord;
  allowed?: AllowedRecord;
  /** What a declared reason can let through in this run, by name (metric names, `'gate'`, `'mandate:<name>'`). One thing needs no name; with more than one, a reason lets through only the ones it names as whole words. */
  allowable?: string[];
  /** `true` when the contract at the base holds `"allowFromAuthor": true`: on a pull request the comment of the account that opened it counts. */
  openerCounts?: true;
  /** In a run between two commits with more than one commit between them: an earlier commit of the change (`at`, short) added `added` tests, by name, and the change as it stands adds none. `names` holds at most ten of them, `more` how many are left out. A note for a reader, never part of a verdict, except with `pullRequest`: then it is also the guard `tests_taken_out` among the metrics. */
  testsTakenOut?: { added: number; names: string[]; more: number; at: string };
  /** On a pull request: tests the base had, rewritten in a later commit than one that changed the source, with the base's tests failing on the new source (`testsRewrittenAfter`). */
  testsRewritten?: { tests: string[]; more: number; at: string; after: string };
  /** two or more test names gone over the changed files, or a file that stays lost every test (0.8.20): a note, never part of the verdict */
  testsGone?: { gone: number; names: string[]; more: number; emptied: string[] };
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
/** Applies each guard's `budget` to the measured results, in place: sets `paid` (and `ok`) or `overBudget`. Run after the gaming pass. */
export declare function applyBudgets<T extends Partial<MetricResult>>(metrics: T[], defs: ReadonlyArray<Partial<MetricConfig>>): T[];
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

/** One counting tripwire over a change: after minus before, and each touched file's count at both ends. */
export interface CountChange {
  /** After minus before. Equals the change in the whole-tree count. */
  delta: number;
  /** Only the files the change touched that hold a match at either end: `[before, after]`. */
  files: Record<string, [number, number]>;
}

/**
 * The change in each counting tripwire between two commits, read from the files the change touched alone. No
 * commit is checked out and no test is run, so every commit of a pull request can be read in the time one check
 * takes. A metric that is not one of the counting greps `init` writes reads `null`. The whole result is `null`
 * when the change could not be read (an object that is not in this clone). Takes `repo`, `base`, `head` and
 * `config` as `check` does.
 */
export declare function changeCounts(options?: Pick<CheckOptions, 'repo' | 'base' | 'head' | 'config'>): Record<string, CountChange | null> | null;

/** What `calibrate()` found for one metric. */
export interface CalibratedMetric {
  name: string;
  /** How many of the runs gave a number. */
  runs: number;
  median: number | null;
  /** The widest gap between the readings. */
  spread: number;
  /** The band to write on the metric as `noise`; `null` when a run gave no number. */
  noise: number | null;
}

export interface Calibration {
  /** The commit the metrics were run at (short sha). */
  ref: string;
  /** Readings asked for per metric. */
  runs: number;
  /** The runs a side the band is for. */
  repeat: number;
  metrics: CalibratedMetric[];
}

export interface CalibrateOptions extends Pick<CheckOptions, 'repo' | 'config' | 'repeat'> {
  /** The commit to measure at. Default `HEAD`. */
  ref?: string;
  /** Readings per metric. Default 20, at least 4. */
  runs?: number;
  /** Measure only the metric with this name. */
  metric?: string;
}

/**
 * Measures the noise band each metric needs: runs it `runs` times at one commit, in a throwaway worktree, and gives
 * the band for `repeat` runs a side. A pass/fail metric and an `exact` one take no band and are left out. Writes
 * nothing: a band goes into the contract by hand, as `noise` on the metric. Throws a `ConfigError` (exit code 64)
 * as `check` does, and when `metric` names no metric that takes a band.
 */
export declare function calibrate(options?: CalibrateOptions): Calibration;

/**
 * The noise band a metric with these readings needs, or `null` with fewer than two readings. Draws pairs of groups of
 * `repeat` readings and returns the gap between their medians that 95 of 100 pairs stay inside. The draw has a fixed
 * seed, so the same readings give the same band.
 */
export declare function noiseBand(samples: ReadonlyArray<number | null | undefined>, repeat?: number, pairs?: number): number | null;

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

/** The credibility core: compare before/after samples and trust the delta only if it clears the noise band (the metric's declared `noise`, else the jitter observed across repeats). */
export declare function evaluate(
  metric: Pick<MetricConfig, 'direction' | 'guard' | 'extract'>,
  beforeSamples: ReadonlyArray<number | null>,
  afterSamples: ReadonlyArray<number | null>,
  repeat: number,
): Evaluation;

/**
 * Render a report as the markdown the GitHub Action posts: what a reader has to do in view, the table of numbers
 * folded away (`fold: false` leaves it open, as the job summary has it). `commentOnly` with `wouldFail` gives the
 * comment-only wording; `note` is added as it is.
 */
export declare function renderMarkdown(report: Report, options?: { fold?: boolean; commentOnly?: boolean; wouldFail?: boolean; note?: string }): string;

/** What `commentPlan` decided: nothing, a new comment, or an edit of the check's own earlier comment (`id`). */
export interface CommentPlan {
  action: 'none' | 'create' | 'update';
  /** With `update`: the id of the comment to edit. */
  id?: number;
  /** The comment, with its hidden first line; `''` for `none`. */
  body: string;
  /** The whole report, unfolded, for the job summary. Present on every run. */
  summary: string;
  /** The job would fail on this run (an inconclusive verdict counts only where `inconclusive` is not `pass`). */
  wouldFail: boolean;
  /** The comment as plain text for the log of the step that fails (`commentLog`); `''` when the job would not fail. */
  log?: string;
}

/** The comment as plain text, for a job log: no markup, only the measures that moved, the way through as the comment gives it. An agent that works on a failed check reads its log, not a bot's comment. */
export declare function commentLog(md: string): string;

/**
 * What a pull-request check does with its comment. One comment, known by a hidden first line built from `key` and
 * by its author (the Actions bot), edited in place. It speaks when the job would fail, when a reason was used, when
 * a file lost tests or assertions while the total held, when the check's own definition changed, or when the run
 * printed no report. A plain pass says nothing; an earlier comment is then edited to one short line. `comment`:
 * `'true'` (the default), `'always'` (the whole report every time) or `'false'`. Pure: nothing is posted here.
 */
export declare function commentPlan(input?: {
  report?: Report | null;
  /** The run's exit code. */
  exit?: number | string;
  /** What the run printed on stderr, for a run with no report. */
  error?: string;
  /** The pull request's comments, as GitHub's API returns them. */
  comments?: unknown[];
  key?: string;
  /** A line to add when the job would fail (the approval that was not counted). */
  note?: string;
  comment?: 'true' | 'always' | 'false';
  inconclusive?: 'fail' | 'pass';
  commentOnly?: boolean;
}): CommentPlan;

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

/** A note when the environment sets a variable that can change which tests run (PYTEST_ADDOPTS, PYTEST_PLUGINS, a
 *  preload in NODE_OPTIONS) and the contract's own `env` (`declared`) does not set it; null when none is set. */
export declare function environmentNote(env?: Record<string, string | undefined>, declared?: Record<string, unknown> | null): { metric: 'environment'; noted: true; what: string; items: string[] } | null;

/** The newest `sawbuck-allow: <reason>` comment from someone with write access, or ''. With `author` (the account that
 *  opened the pull request) its own comment does not count, unless `allowFromAuthor` is true (the base contract's key). */
export declare function allowFromComments(comments: unknown[], opts?: { author?: string; allowFromAuthor?: boolean }): string;
/** The same, with the login whose comment was left out because it opened the pull request (`skipped`, '' if none). */
export declare function allowDecision(comments: unknown[], opts?: { author?: string; allowFromAuthor?: boolean }): { reason: string; skipped: string };

/** One test of a file, read by name (0.8.17). `asserts` is -1 for a row of a Go table-driven test. */
export interface NamedTest { name: string; line: number; asserts: number; skipped: boolean }
/** Each test in a file's text, by its name. No parser: one small reader for each language the counting tripwires read. A file of another kind holds none. */
export declare function testsIn(path: string, text: string): NamedTest[];
/** The tests an earlier step of a change added and its last step no longer adds. `steps` are the change's commits in order, each with the commit it is held against. `null` when there is nothing to say or a step cannot be read. */
export declare function testsTakenOut(repo: string, steps: { base: string; head: string }[]): { added: number; names: string[]; more: number; at: string } | null;
/** The tests the base had that a later commit rewrote, after an earlier commit changed the source and left them as they were. `split(a, b)` is the engine's own source split; `isTest` which paths are tests. */
export declare function testsRewrittenAfter(repo: string, steps: { base: string; head: string }[], split: (a: string, b: string) => { source: string[]; nonSource: string[] } | null, isTest?: (path: string) => boolean): { tests: string[]; more: number; at: string; after: string } | null;
export declare function testsGone(repo: string, base: string, head: string): { gone: number; names: string[]; more: number; emptied: string[] } | null;
/** The same reading over one span, `from` to `to`, with no search for where the change left its base. */
export declare function testsGoneIn(repo: string, from: string, to: string): { gone: number; names: string[]; more: number; emptied: string[] } | null;

// ---------------------------------------------------------------------------
// The record's views. The CLI's `insights`, `playbook` and `suggest` are built on these.
// ---------------------------------------------------------------------------

/** One key of the record, folded with decay: a metric, a metric in a folder (`metric @ folder`), or a metric under a label (`metric # label`). */
export interface RecordKey {
  key: string;
  metric: string;
  /** Weighted runs that measured this key. */
  w: number;
  /** Runs that measured this key, unweighted. */
  n: number;
  /** Weighted runs in which it improved, and in which it got worse. */
  imp: number;
  reg: number;
  /** Weighted runs in which it moved either way. A key earns a line in the playbook at 3. */
  moved: number;
  effects: number[];
  cohorts: Record<string, { imp: number; reg: number }>;
  last: string | null;
}

/** Fold rows of the record (oldest first) into decayed counts for each key. A row counts half as much every 20 rows after it. A row that is not a row is skipped. */
export declare function foldOutcomes(runs: ReadonlyArray<Record<string, unknown>>): RecordKey[];

/** How often a key helped when it moved, pulled toward a half while there is little to go on: `(1 + improved) / (2 + improved + regressed)`. */
export declare function betaMean(improved: number, regressed: number): number;

/** A key's lever (how often it helped, times how often it moved) and its UCB score, which adds a bonus that shrinks as the key is tried more. */
export declare function scoreKey(key: Pick<RecordKey, 'imp' | 'reg' | 'moved' | 'w' | 'effects'>, totalWeight: number): { p: number; move: number; lever: number; ucb: number; effect: number };
