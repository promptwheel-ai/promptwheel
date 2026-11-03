#!/usr/bin/env node
// PromptWheel: a deterministic, zero-LLM check for your coding loop. It proves every change
// earned its win by re-running the result from the agent's source edits alone, so a green
// that came from editing the test reads GAMED.
//
// For any change (base ref -> head ref), measure each configured metric in an
// isolated git worktree BEFORE and AFTER, enforce regression guards, and refuse
// to trust a delta that sits inside the measurement noise band. Emits a
// structured {verdict, metric, delta, confidence}. The thing base agents don't do:
// verify a real number moved, not just "the diff applied / tests passed".
//
// Zero deps, zero build. Node 18+.
//   promptwheel run [--base R] [--head R] [--repeat N] [--json]

import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, appendFileSync, realpathSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const median = (xs) => {
  const a = xs.filter((x) => x != null).slice().sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const spread = (xs) => { const a = xs.filter((x) => x != null); return a.length ? Math.max(...a) - Math.min(...a) : 0; };

// usage / config errors exit 64 (EX_USAGE), so they can never be confused with a verdict
// (0 pass, 1 fail, 2 gamed, 3 inconclusive): in CI a config typo must not read as GAMED.
const EX_USAGE = 64;
function die(msg) { console.error(msg); process.exit(EX_USAGE); }
// a config or precondition error: thrown, so the library path (check()) surfaces it to the caller
// instead of exiting the host process; the CLI catches it in main() and exits EX_USAGE.
function bad(msg) { const e = new Error(msg); e.name = 'ConfigError'; e.exitCode = EX_USAGE; throw e; }

function readConfigFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { bad(`invalid config ${p}: ${e.message}`); }
}

const relOf = (repo, p) => { try { return relative(repo, p) || p; } catch { return p; } };

// resolve a config + its `extends` chain into a flat, provenance-tagged metric list.
// `extends` is a path (or array of paths) to base configs, relative to the config file:
// a repo INHERITS their guardrails, and a local metric of the same name overrides the inherited one.
function resolveConfig(p, repo, label, seen) {
  const abs = realpathSync(p);
  if (seen.has(abs)) bad(`config inheritance cycle at ${relOf(repo, p)}`);
  seen.add(abs);
  try {
    const cfg = readConfigFile(p);
    const byName = new Map();
    const mandatesByName = new Map();   // hard rules accumulate down the extends chain (a parent's holds)
    const scalars = {};
    for (const ref of [].concat(cfg.extends || [])) {
      const bp = isAbsolute(ref) ? ref : join(dirname(p), ref);
      if (!existsSync(bp)) bad(`extends target not found: ${ref} (from ${relOf(repo, p)})`);
      const base = resolveConfig(bp, repo, relOf(repo, bp), seen);
      for (const m of base.metrics) byName.set(m.name, m);
      for (const md of (base.mandates || [])) if (md && md.name) mandatesByName.set(md.name, md);
      for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'record', 'gamingThreshold', 'evaluatorPaths']) if (base[k] !== undefined) scalars[k] = base[k];
    }
    for (const m of (cfg.metrics || [])) {
      byName.set(m.name, { ...m, __src: label, __override: byName.has(m.name) });
    }
    for (const md of (cfg.mandates || [])) if (md && md.name) mandatesByName.set(md.name, { ...md, __src: label });
    for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'record', 'gamingThreshold', 'evaluatorPaths']) if (cfg[k] !== undefined) scalars[k] = cfg[k];
    return { ...scalars, metrics: [...byName.values()], mandates: [...mandatesByName.values()] };
  } finally {
    seen.delete(abs); // only ACTIVE ancestors are a cycle, a diamond (a base reached two ways) is fine
  }
}

function loadConfig(repo) {
  const p = join(repo, 'promptwheel.config.json');
  if (!existsSync(p)) bad('no promptwheel.config.json, run: promptwheel init   (writes one for your stack)');
  const cfg = resolveConfig(p, repo, 'local', new Set());
  if (!Array.isArray(cfg.metrics) || cfg.metrics.length === 0) bad('config.metrics must be a non-empty array');
  return cfg;
}

// does the repo have a committed gate config?
const hasConfigFile = (repo) => existsSync(join(repo, 'promptwheel.config.json'));

// the zero-config default: the gate `init` would write, built in memory from stack detection.
// It gates the detected test command (gaming detection on) with the stack's env/linkDirs so the
// measurement actually runs in a throwaway worktree. Lets `run` and `check()` work with no config
// file; `init` is for customizing. A repo with no test command gets a sentinel that reads inert ->
// INCONCLUSIVE (never a fake green), with a message pointing at the fix.
function autoConfig(repo) {
  return { ...detectEnv(repo), metrics: [{ name: 'tests_pass', cmd: detectTestCmd(repo), extract: 'exit', direction: 'pass', guard: true }] };
}

function resolveBase(repo, base) {
  if (base) return base;
  const head = git(['rev-parse', 'HEAD'], repo);
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    let mb = '';
    try { mb = git(['merge-base', 'HEAD', b], repo); } catch { continue; }
    // on the trunk itself the merge-base IS HEAD; comparing a commit to itself would be a
    // trivial PASS that verified nothing, so fall through to the last commit instead.
    if (mb && mb !== head) return mb;
  }
  return git(['rev-parse', 'HEAD~1'], repo);
}

function runMetric(cwd, m, env) {
  let stdout = '', code = 0;
  // Never leak the harness's own node:test context into the measured gate: a metric like
  // `node --test` would see NODE_TEST_CONTEXT, act as a child reporter, and report a bogus
  // exit code (so the gate can't be trusted when PromptWheel itself runs under a test runner).
  const childEnv = { ...(env || process.env) }; delete childEnv.NODE_TEST_CONTEXT;
  try {
    stdout = execSync(m.cmd, { cwd, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: (m.timeoutSec ?? 300) * 1000 });
  } catch (e) { code = e.status ?? 1; stdout = `${e.stdout || ''}${e.stderr || ''}`; }
  return extract(stdout, code, m.extract, m.allowNonzero);
}

// extract modes: 'number' (last number, default) | 'lines' | 'exit' | {regex}
// A FAILED command is unmeasurable (null -> the metric goes inert, guards
// fail loudly), error text often contains numbers ("Node.js v22") and
// silently measuring those produced identical junk on both refs = a false
// green. 'exit' mode consumes nonzero by design; anything else needs the
// per-metric opt-in `allowNonzero: true`.
function extract(stdout, code, mode, allowNonzero) {
  mode = mode || 'number';
  if (mode === 'exit') return code === 0 ? 1 : 0;
  if (code !== 0 && !allowNonzero) return null;
  if (mode === 'lines') return stdout.split('\n').filter((l) => l.trim()).length;
  if (mode && typeof mode === 'object' && mode.regex) {
    const mm = new RegExp(mode.regex).exec(stdout);
    return mm ? Number(mm[1] ?? mm[0]) : null;
  }
  const nums = stdout.match(/-?\d+(?:\.\d+)?/g);
  return nums ? Number(nums[nums.length - 1]) : null;
}

// bridge a measurement worktree to the deps that live OUTSIDE git (node_modules, .venv, target,
// …) and the env a test command needs. Returns the env for runMetric. Generalizes the old
// node_modules-only symlink: `linkDirs` says what to link (default ['node_modules']; back-compat
// with linkNodeModules:false → link nothing); `env` sets vars ({wt} → the worktree path, so a
// Python run can put the measured ref FIRST on PYTHONPATH). Ecosystem knowledge lives in config,
// not here, the engine stays ecosystem-agnostic.
function bridgeEnv(repo, wt, cfg) {
  const linkDirs = Array.isArray(cfg.linkDirs) ? cfg.linkDirs : (cfg.linkNodeModules === false ? [] : ['node_modules']);
  for (const d of linkDirs) {
    if (existsSync(join(repo, d)) && !existsSync(join(wt, d))) {
      try { symlinkSync(join(repo, d), join(wt, d)); } catch { /* best effort */ }
    }
  }
  if (!cfg.env) return process.env;
  return { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v).replaceAll('{wt}', () => wt)])) }; // fn replacement: a literal wt avoids $-pattern interpretation
}
// an optional per-ref build/install (e.g. `npm run build`, `pip install -e .`). Best-effort: a
// failed setup just leaves the metric inert → INCONCLUSIVE (never a false green). Run by the
// caller AFTER any source patch, so it builds the tree actually being measured.
function runSetup(wt, cfg, env) {
  if (!cfg.setup) return;
  try { execSync(cfg.setup, { cwd: wt, env, stdio: 'ignore', timeout: 300_000 }); } catch { /* inert → inconclusive */ }
}

// measure every metric `repeat` times at a ref, in a throwaway worktree (never touches your tree)
function measureAt(repo, ref, cfg, repeat) {
  const wt = mkdtempSync(join(tmpdir(), 'promptwheel-'));
  git(['worktree', 'add', '--quiet', '--detach', wt, ref], repo);
  try {
    const env = bridgeEnv(repo, wt, cfg);
    runSetup(wt, cfg, env);
    const out = {};
    for (const m of cfg.metrics) {
      const samples = [];
      for (let i = 0; i < repeat; i++) samples.push(runMetric(wt, m, env));
      out[m.name] = samples;
    }
    return out;
  } finally {
    try { git(['worktree', 'remove', '--force', wt], repo); } catch { rmSync(wt, { recursive: true, force: true }); }
  }
}

// the credibility core: a delta is only trusted if it clears the observed noise band
function evaluate(m, beforeS, afterS, repeat) {
  const before = median(beforeS), after = median(afterS);
  if (before == null || after == null) return { before, after, delta: null, status: 'unmeasurable', ok: !m.guard, confidence: 'none', noise: null };
  const dir = m.direction || 'up';
  const delta = +(after - before).toFixed(6);
  const noise = Math.max(spread(beforeS), spread(afterS)); // observed jitter across repeats
  const deterministic = m.extract === 'exit' || m.extract === 'lines';
  const sampledNoise = repeat > 1;
  const withinNoise = sampledNoise && Math.abs(delta) <= noise;

  let confidence;
  if (deterministic) confidence = 'high';
  else if (!sampledNoise) confidence = 'unverified';       // single read, noise unknown; run --repeat to trust
  else if (noise === 0) confidence = 'high';
  else if (withinNoise) confidence = 'low';                // delta is inside the jitter, not real
  else confidence = 'medium';

  let improved = false, regressed = false;
  if (dir === 'up') { improved = delta > 0; regressed = delta < 0; }
  else if (dir === 'down') { improved = delta < 0; regressed = delta > 0; }
  else if (dir === 'pass') { improved = after === 1 && before !== 1; regressed = after < before; }

  let status;
  if (withinNoise && delta !== 0) { status = 'inconclusive'; improved = regressed = false; } // within measured noise → don't call it
  else status = regressed ? 'regressed' : improved ? 'improved' : 'unchanged';

  // guards fail only on a TRUSTED regression (within-noise regressions are not failures)
  const ok = m.guard ? !regressed : true;
  // a guarded pass-metric that never passes is protecting NOTHING (broken test cmd,
  // missing script, failed install), surface it instead of folding into a green verdict.
  const inert = !!m.guard && dir === 'pass' && before === 0 && after === 0;
  return { before, after, delta, status, ok, confidence, noise, ...(inert ? { inert: true } : {}) };
}

// ---------------------------------------------------------------------------
// gaming detection (antihack): re-prove a "win" using ONLY the agent's source edits.
// If the improvement evaporates once test/config/grader/golden changes are reverted,
// the agent moved the goalposts (edited the test, mocked the grader, suppressed the
// lint rule, deleted the feature) instead of earning it. Pure arithmetic, fully
// explainable, the thing the loop-owner structurally won't ship about its own agent.
// ---------------------------------------------------------------------------
const NON_SOURCE = [
  /(^|\/)(tests?|__tests?__|spec|e2e|fixtures|snapshots|__snapshots__|__mocks__)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)tests?\.[cm]?[jt]sx?$/i,                 // a file literally named test.js / tests.ts
  /(^|\/)test_[^/]*\.py$/i, /_test\.py$/i, /(^|\/)conftest\.py$/i,
  // cross-language test-filename conventions, strong-signal tokens only (a dedicated
  // _test / _spec / Test(s) suffix, or a file literally named test.<lang>), so production
  // code like latest.c, Contest.java or speedtest.go is NOT swept into the evaluator slice.
  // (Test DIRECTORIES are covered above for every language; this adds the by-filename
  // conventions compiled langs use at repo root, a red-team finding: a weakened test.c /
  // FooTest.java / handler_test.go was classified as source, so the cheat survived.)
  /(^|\/)tests?\.(c|cc|cpp|cxx|go|rs|rb)$/i,
  /(^|\/)test_[^/]*\.(c|cc|cpp|cxx|h|hpp|go|rs)$/i,
  /_test\.(c|cc|cpp|cxx|h|hpp|go|rs|rb)$/i,
  /_spec\.rb$/i,
  /[a-z0-9](Test|Tests)\.(java|kt|kts|scala)$/,
  /\.snap$/i, /(^|\/)golden[^/]*$/i, /\.golden$/i,
  /(^|\/)(eval|grader|score)[^/]*\.[cm]?[jt]s$/i,
  // config files only, require a .config/.conf/.setup segment so PRODUCTION source that
  // happens to be named after a tool (e.g. src/installers/eslint.ts) is NOT swept out of
  // the source slice (a false sweep here can flag an honest win as GAMED).
  /(^|\/)(jest|vitest|playwright|cypress|karma|babel|eslint|pytest)[^/]*\.(config|conf|setup)\.[^/]+$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)\.(eslintrc|babelrc|prettierrc)[^/]*$/i,
  /(^|\/)(pytest\.ini|setup\.cfg|\.flake8|tox\.ini|eslint\.config\.[cm]?js)$/i,
  // promptwheel's OWN evaluator surface: the config that defines the gate
  // and any pack copied into the repo by `init --preset`. Editing these is
  // moving the goalposts, never a production improvement, an agent that
  // "improved" security_findings by deleting pattern rules must show 0%
  // retained in the source-only re-run, not 100%.
  /(^|\/)promptwheel\.config\.json$/i,
  /(^|\/)\.promptwheel\//i,
];
const isNonSource = (p) => NON_SOURCE.some((re) => re.test(p));

// user-declared evaluator surface: extra paths that DEFINE the gate (a generic threshold
// file, a budget, a CI limit) and so must be reverted in the source-only re-run exactly
// like a test/grader. Opt-in per repo via `evaluatorPaths`, NOT guessed, because a bare
// name is a classifier risk; the user names the files only they know are the goalposts.
// Glob semantics: a bare name matches that basename at any depth; a pattern with "/" is a
// path glob anchored at repo root; "*" stops at "/", "**" crosses it, "?" is one char; a
// leading "/" anchors to the root explicitly.
function globToRe(glob) {
  let g = glob; const anchored = g.startsWith('/'); if (anchored) g = g.slice(1);
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')            // escape regex, keep * ? for globbing
    .replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  const pre = (anchored || glob.includes('/')) ? '^' : '(^|/)';
  return new RegExp(`${pre}${body}$`);
}
function evaluatorMatcher(cfg) {
  const pats = (cfg && Array.isArray(cfg.evaluatorPaths) ? cfg.evaluatorPaths : []).filter((s) => typeof s === 'string' && s.trim());
  if (!pats.length) return () => false;
  const res = pats.map(globToRe);
  return (p) => res.some((re) => re.test(p));
}

// mandates: named hard rules that compile to a deterministic gate. A protected-path mandate
// forbids ANY change to its paths (same glob semantics as evaluatorPaths). A hit fails the gate
// regardless of metrics and rides at the top of the report; mandates inherit through `extends`,
// so a parent scope's rule holds for every repo beneath it.
// The mandates in force are the UNION of the head config's and the base ref's (`baseMandates`,
// resolved by gateDefAtRef): deleting a mandate in the same change that violates it does not
// clear it. A mandate removed at head but violated in the diff is reported with `removed: true`; one
// whose paths were edited at head (same name, different paths) is tested in BOTH versions and reported
// with `edited: true`, so narrowing a rule in the change that breaks it does not clear it either.
// The honest way to retire one is a separate change that only edits the config.
function checkMandates(repo, base, head, cfg, baseMandates) {
  const headList = Array.isArray(cfg.mandates) ? cfg.mandates : [];
  const headNames = new Set(headList.map((m) => m && m.name).filter(Boolean));
  const key = (m) => JSON.stringify([String(m.name), [...(Array.isArray(m.paths) ? m.paths : [])].filter((x) => typeof x === 'string').sort()]);
  const headKeys = new Set(headList.filter((m) => m && m.name).map(key));
  const kept = (Array.isArray(baseMandates) ? baseMandates : []).filter((m) => m && m.name && !headKeys.has(key(m)))
    .map((m) => (headNames.has(m.name) ? { ...m, __edited: true } : { ...m, __removed: true }));
  const mandates = [...headList, ...kept];
  if (!mandates.length) return [];
  let changed = [];
  try { changed = git(['diff', '--name-only', base, head], repo).split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const m of mandates) {
    const pats = (Array.isArray(m.paths) ? m.paths : []).filter((s) => typeof s === 'string' && s.trim());
    if (!pats.length) continue;
    const res = pats.map(globToRe);
    const hit = changed.filter((f) => res.some((re) => re.test(f)));
    if (hit.length) out.push({ name: String(m.name || 'mandate'), reason: m.reason ? String(m.reason).slice(0, 300) : '', files: hit.slice(0, 20), ...(m.__removed ? { removed: true } : {}), ...(m.__edited ? { edited: true } : {}) });
  }
  // one entry per name: the head version and the edited base version of a rule merge (files unioned)
  const merged = [];
  for (const v of out) {
    const prev = merged.find((x) => x.name === v.name);
    if (!prev) { merged.push(v); continue; }
    prev.files = [...new Set([...prev.files, ...v.files])].slice(0, 20);
    if (v.edited) prev.edited = true;
    if (!prev.reason && v.reason) prev.reason = v.reason;
  }
  return merged;
}

// split the agent's changed files into production-source vs test/config/grader/golden.
// `isEval` is the repo's opt-in evaluator-path matcher, treated as non-source alongside
// the built-in classifier, so a cheat that only edits a declared gate file is caught.
function changedSourcePaths(repo, base, head, isEval = () => false) {
  const all = git(['diff', '--name-only', base, head], repo).split('\n').filter(Boolean);
  const nonSrc = (p) => isNonSource(p) || isEval(p);
  return { source: all.filter((p) => !nonSrc(p)), nonSource: all.filter(nonSrc) };
}

// measure `metric` in a worktree at `base` with ONLY the source slice of base→head applied.
function measureSourceOnly(repo, base, head, metric, cfg, repeat) {
  const { source } = changedSourcePaths(repo, base, head, evaluatorMatcher(cfg));
  if (!source.length) return { samples: [], hadSourceChange: false }; // a "win" with zero source edits = goalposts moved
  const wt = mkdtempSync(join(tmpdir(), 'promptwheel-src-'));
  git(['worktree', 'add', '--quiet', '--detach', wt, base], repo);
  try {
    const env = bridgeEnv(repo, wt, cfg);
    const patch = git(['diff', base, head, '--', ...source], repo);
    if (patch.trim()) {
      // stdio stderr 'ignore': git apply --3way prints "Applied patch ... cleanly" to stderr; that
      // is noise on an otherwise-quiet run (and corrupts --json for callers that fold in stderr).
      const tryApply = (extra) => { execFileSync('git', ['apply', '--whitespace=nowarn', ...extra], { cwd: wt, input: patch + '\n', encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] }); };
      try { tryApply(['--3way']); }
      catch { try { tryApply([]); } catch { return { samples: [], hadSourceChange: true, applyFailed: true }; } }
    }
    runSetup(wt, cfg, env); // build the patched tree, so a build-gated metric measures the source edit
    const samples = [];
    for (let i = 0; i < repeat; i++) samples.push(runMetric(wt, metric, env));
    return { samples, hadSourceChange: true };
  } finally {
    try { git(['worktree', 'remove', '--force', wt], repo); } catch { rmSync(wt, { recursive: true, force: true }); }
  }
}

// directional improvement of `val` over `before` (positive = better)
function gain(m, before, val) {
  if (before == null || val == null) return null;
  const dir = m.direction || 'up';
  if (dir === 'down') return before - val;
  if (dir === 'pass') return val === 1 ? (before !== 1 ? 1 : 0) : -1;
  return val - before;
}

// a metric that improved full-diff: does the win survive when only source edits are applied?
// gamed = source edits alone reproduce less than `threshold` of the gain (default 0.5, the
// rest came from editing the goalposts). Tune via `gamingThreshold` (config-level or per-metric).
function judgeGaming(m, srcResult, threshold = 0.5) {
  if (!srcResult.hadSourceChange) return { gamed: true, sourceOnly: null, retained: 0, reason: 'the "win" changed zero production-source files, only test/config/grader/golden' };
  if (srcResult.applyFailed) return { gamed: null, sourceOnly: null, retained: null, reason: 'source-only patch did not apply cleanly, inconclusive' };
  const sourceOnly = median(srcResult.samples);
  const full = gain(m, m.before, m.after);
  if (full == null || full <= 0) return { gamed: false, sourceOnly, retained: 1, reason: 'no real improvement to re-prove' };
  const retained = +(gain(m, m.before, sourceOnly) / full).toFixed(3);
  const gamed = retained < threshold;
  return { gamed, sourceOnly, retained, reason: gamed
    ? `only ${(retained * 100).toFixed(0)}% of the gain survives when test/config/grader changes are reverted (threshold ${(threshold * 100).toFixed(0)}%), most of the "win" came from editing the goalposts`
    : `${(retained * 100).toFixed(0)}% of the gain survives source-only, the source earned it` };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// snapshot the working tree (tracked + untracked) into a dangling commit WITHOUT
// touching the real index or files, so a gate/improve sees a file an agent just added.
// Returns 'HEAD' when nothing changed.
function workingSnapshot(repo) {
  const idxDir = mkdtempSync(join(tmpdir(), 'pw-idx-'));
  const env = {
    ...process.env, GIT_INDEX_FILE: join(idxDir, 'index'),
    GIT_AUTHOR_NAME: 'promptwheel', GIT_AUTHOR_EMAIL: 'promptwheel@local',
    GIT_COMMITTER_NAME: 'promptwheel', GIT_COMMITTER_EMAIL: 'promptwheel@local',
  };
  const g = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
  try {
    try { g(['read-tree', 'HEAD']); } catch { /* no HEAD yet (empty repo) */ }
    g(['add', '-A']);                         // stages tracked + untracked into the TEMP index only
    const tree = g(['write-tree']);
    let headTree = ''; try { headTree = git(['rev-parse', 'HEAD^{tree}'], repo); } catch { /* no HEAD */ }
    if (tree === headTree) return 'HEAD';      // nothing actually changed
    let parent = ''; try { parent = git(['rev-parse', 'HEAD'], repo); } catch { /* no HEAD */ }
    return g(parent
      ? ['commit-tree', tree, '-p', parent, '-m', 'promptwheel working snapshot']
      : ['commit-tree', tree, '-m', 'promptwheel working snapshot']);
  } finally {
    try { rmSync(idxDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// self-heal: a hard-killed run (SIGKILL / power loss) can leave an orphaned worktree, 
// its `finally` never ran. On the next run, drop stale worktree registry entries and any
// abandoned /tmp checkout, so nothing accumulates in your repo or temp dir. Never touches a
// live worktree (a still-registered dir, or a checkout younger than 1h).
function selfHeal(repo) {
  try {
    git(['worktree', 'prune'], repo); // remove registry entries whose dir is already gone (always safe)
    const tracked = new Set(
      git(['worktree', 'list', '--porcelain'], repo)
        .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim()),
    );
    const tmp = tmpdir(), cutoff = Date.now() - 3600_000;
    for (const name of readdirSync(tmp)) {
      if (!name.startsWith('promptwheel-') && !name.startsWith('pw-idx-')) continue; // worktrees + temp-index dirs
      const p = join(tmp, name);
      if (tracked.has(p)) continue;                 // a live/registered worktree, leave it
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
  } catch { /* cleanup must never block the gate */ }
}

// Python editable installs (src-layout `pip install -e .`) can pin imports to the ORIGINAL
// checkout: the worktree's tests then import your current tree at BOTH refs and every delta
// reads 0, the gate is structurally blind on that repo shape. Undetectable from the verdict
// (it looks like "unchanged"), so `init` detects the editable install itself and warns once.
// Verified by a controlled repro (CHANGELOG 0.2.2). Deliberately NOT run by gate(): it spawns
// python3 with a 5 s timeout and prints, and the library path (check) must do neither.
function warnEditableInstall(repo) {
  if (!existsSync(join(repo, 'pyproject.toml')) && !existsSync(join(repo, 'setup.py'))) return;
  try {
    const probe = [
      'import site,glob,os,sys',
      'repo=os.path.realpath(sys.argv[1])',
      'sps=set(site.getsitepackages()+[site.getusersitepackages()])',
      'files=[f for sp in sps for pat in ("__editable__*","*.egg-link","*.pth") for f in glob.glob(os.path.join(sp,pat)) if os.path.isfile(f)]',
      'hit=any(repo in open(f,errors="ignore").read() for f in files)',
      'print("HIT" if hit else "")',
    ].join('\n');
    const out = execFileSync('python3', ['-c', probe, repo], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out === 'HIT') console.error('⚠ editable install of this repo detected (pip install -e): worktree measurements could import your ORIGINAL checkout instead of the measured ref, so deltas would read 0. The written config puts the worktree first on PYTHONPATH to counter this; if deltas still read 0, use a non-editable install in the measuring venv.');
  } catch { /* no python / cannot tell, stay quiet */ }
}

// the shared core: measure a change (base→head) and return the structured report
// ---- gate integrity: catch the agent weakening the gate it is judged by ----
// The config is read from HEAD, so a change can disable a guard (guard:false) or delete a
// guarded metric in the very diff it "passes". We resolve the gate as of BASE too and, if a
// guard was dropped, re-measure it under its BASE definition; the pass only reads GAMED when
// that guard WOULD HAVE FAILED at head (a real regression hidden by moving the goalposts).
const GATE_SCALARS = ['gamingThreshold', 'evaluatorPaths'];

// Resolve the gate definition as of `ref` (metrics + mandates + scalars), following `extends` by
// reading every file from that ref via `git show`, mirroring resolveConfig (a parent's mandates
// hold beneath it; a local mandate of the same name overrides). Returns { metrics:Map, scalars }
// with scalars.mandates, or null when there is no config at `ref` (a gate ADDED in this range is
// not a weakening). Never exits: any missing/unreadable file or parse error yields null (that
// branch simply contributes nothing).
function gateDefAtRef(repo, ref) {
  // quiet: a missing path makes `git show` exit nonzero and print "fatal:" to stderr; swallow it
  const readAt = (p) => { try { return execFileSync('git', ['show', `${ref}:${p}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  const seen = new Set();
  const resolve = (p) => {
    if (seen.has(p)) return null;
    seen.add(p);
    const raw = readAt(p);
    if (raw == null) return null;
    let cfg; try { cfg = JSON.parse(raw); } catch { return null; }
    const byName = new Map(); const mandatesByName = new Map(); const scalars = {};
    for (const ext of [].concat(cfg.extends || [])) {
      if (isAbsolute(ext)) continue;                 // outside the repo, cannot git-show; unchanged anyway
      const base = resolve(join(dirname(p), ext).split('\\').join('/'));
      if (!base) continue;
      for (const m of base.metrics.values()) byName.set(m.name, m);
      for (const md of base.scalars.mandates) mandatesByName.set(md.name, md);
      for (const k of GATE_SCALARS) if (base.scalars[k] !== undefined) scalars[k] = base.scalars[k];
    }
    for (const m of (cfg.metrics || [])) if (m && m.name) byName.set(m.name, m);
    for (const md of (cfg.mandates || [])) if (md && md.name) mandatesByName.set(md.name, md);
    for (const k of GATE_SCALARS) if (cfg[k] !== undefined) scalars[k] = cfg[k];
    scalars.mandates = [...mandatesByName.values()];
    return { metrics: byName, scalars };
  };
  return resolve('promptwheel.config.json');
}

// an order-independent SHA-256 (truncated) fingerprint of a gate definition, for the audit record
function gateFingerprint(metricsList, scalars) {
  const norm = {
    metrics: metricsList.map((m) => ({
      name: m.name, guard: m.guard === true, direction: m.direction || 'up',
      gamingThreshold: m.gamingThreshold ?? null, gamingCheck: m.gamingCheck !== false,
    })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    gamingThreshold: scalars.gamingThreshold ?? null,
    evaluatorPaths: Array.isArray(scalars.evaluatorPaths) ? [...scalars.evaluatorPaths].sort() : [],
    mandates: Array.isArray(scalars.mandates) ? scalars.mandates.map((m) => ({ name: String(m.name || ''), paths: [...(Array.isArray(m.paths) ? m.paths : [])].sort() })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [],
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

// tool version (read once from the sibling package.json) for the provenance receipt
const TOOL_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || null; }
  catch { return null; }
})();

// full sha of a ref, best-effort (never throws into the gate)
function safeRev(repo, ref) { try { return git(['rev-parse', ref], repo); } catch { return null; } }

// SHA-256 (truncated) of a file's content at a ref, or null if the file is absent there
function blobHashAt(repo, ref, path) {
  try { return createHash('sha256').update(execFileSync('git', ['show', `${ref}:${path}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).digest('hex').slice(0, 16); }
  catch { return null; } // absent at this ref (added or removed)
}
// declared evaluatorPaths whose CONTENT changed between base and head. A declared gate file is a
// goalpost the user named; editing it in the same diff that improves a metric is gamed by
// declaration (content-hash auto-fail) - deterministic even when the source-only re-run is inert.
// Fires ONLY on declared files, so the opt-in semantics (an undeclared config stays source) hold.
function changedEvaluatorPaths(repo, base, head, cfg) {
  const isEval = evaluatorMatcher(cfg);
  let changed = [];
  try { changed = git(['diff', '--name-only', base, head], repo).split('\n').filter(Boolean).filter(isEval); }
  catch { return []; }
  return changed.map((p) => ({ path: p, base: blobHashAt(repo, base, p), head: blobHashAt(repo, head, p) }))
    .filter((e) => e.base !== e.head);
}

// reproducible fingerprint of the verdict CONTENT (everything but the provenance block itself), so
// a skeptic who re-runs (base, head, config) gets the same hash - the tamper-evident receipt.
function verdictFingerprint(report) {
  const norm = {
    verdict: report.verdict,
    metrics: (report.metrics || []).map((m) => ({ name: m.name, status: m.status, ok: m.ok === true, guard: m.guard === true, gamed: m.gamed === true }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    gate: (report.gate && report.gate.fingerprint) || null,
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

// guarded metrics that HEAD dropped relative to BASE (removed entirely, or guard turned off)
function gateWeakenings(baseGate, headMetrics) {
  if (!baseGate) return [];
  const head = new Map(headMetrics.map((m) => [m.name, m]));
  const weak = [];
  for (const bm of baseGate.metrics.values()) {
    if (bm.guard !== true) continue;                 // only a guard protects anything
    const hm = head.get(bm.name);
    if (!hm) weak.push({ name: bm.name, change: 'guard-removed', def: bm });
    else if (hm.guard !== true) weak.push({ name: bm.name, change: 'guard-disabled', def: bm });
  }
  return weak;
}

// A declared, auditable override (CONTRACT Section 3). The head commit can acknowledge an
// intentional test/config/grader change (an edit, a delete, or a new file) or an intentional
// gate change, with a trailer:   Promptwheel-Allow: <reason>   (Sawbuck-Allow: is an alias)
// so a change that would read GAMED reads PASS instead, with the acknowledgment RECORDED in
// report.allowed. The check does not judge intent; it forces intent to be explicit. An UNdeclared
// test-only win is still gamed. `--allow "<reason>"` (CLI) / `allow` (check) supplies the same for
// a working-tree or CI run that has no commit message to carry the trailer.
function readAllowTrailer(repo, ref) {
  let msg = '';
  try { msg = execFileSync('git', ['log', '-1', '--format=%B', ref], { cwd: repo, encoding: 'utf8' }); } catch { return null; }
  const m = msg.match(/^[ \t]*(?:Promptwheel-Allow|Sawbuck-Allow)[ \t]*:[ \t]*(\S.*?)[ \t]*$/im);
  return m && m[1].trim() ? { reason: m[1].trim().slice(0, 300) } : null;
}

// The three Section 3 checks, run only with detectGaming, in order: (1) re-prove every actual
// win with the agent's source edits alone; (2) content-hash auto-fail: a declared evaluatorPath
// gate file edited in this diff is a moved goalpost, so a metric that improved alongside it is
// gamed by declaration, deterministic even if the source-only re-run read inert; (3) gate
// integrity: resolve the gate as of BASE, re-measure any guard HEAD dropped under its base
// definition (it only counts as tampering if it WOULD HAVE FAILED at head), and fingerprint the
// gate definition at both refs (metrics, evaluatorPaths, gamingThreshold, mandates) so a quietly
// deleted guard or mandate is tamper-evident: base != head is recorded as gate.changed and
// printed, whatever the verdict. Mutates `metrics` in place (gamed/sourceOnly/retained/
// gamingReason) and returns the report.gate record. An allow trailer can still clear a gamed
// metric afterwards, in gate().
function detectGamingPass(repo, base, head, cfg, metrics, repeat) {
  for (const m of metrics) {
    if (m.status !== 'improved') continue;
    const cm = cfg.metrics.find((c) => c.name === m.name);
    if (cm.gamingCheck === false) continue;   // tripwire / test-side guards aren't re-proven from source (their gain legitimately lives in test files)
    const j = judgeGaming(m, measureSourceOnly(repo, base, head, cm, cfg, repeat), cm.gamingThreshold ?? cfg.gamingThreshold ?? 0.5);
    m.gamed = j.gamed; m.sourceOnly = j.sourceOnly; m.retained = j.retained; m.gamingReason = j.reason;
  }
  const evalChanged = changedEvaluatorPaths(repo, base, head, cfg);
  if (evalChanged.length) {
    for (const m of metrics) {
      if (m.status !== 'improved' || m.gamed === true) continue;
      const cm = cfg.metrics.find((c) => c.name === m.name);
      if (cm && cm.gamingCheck === false) continue; // tripwire/test-side guards legitimately live in gate files
      m.gamed = true;
      m.gamingReason = `a declared evaluatorPath gate file changed in this diff (${evalChanged.map((e) => e.path).join(', ')}); a win alongside a goalpost edit is gamed by declaration`;
    }
  }
  const baseGate = gateDefAtRef(repo, base);
  const weak = gateWeakenings(baseGate, cfg.metrics);
  const weakened = [];
  if (weak.length) {
    const defs = weak.map((w) => w.def);
    const b = measureAt(repo, base, { ...cfg, metrics: defs }, repeat);
    const a = measureAt(repo, head, { ...cfg, metrics: defs }, repeat);
    for (const w of weak) {
      const ev = evaluate(w.def, b[w.name], a[w.name], repeat);
      if (!ev.ok) weakened.push({ name: w.name, change: w.change, status: ev.status });
    }
  }
  const fpBase = baseGate ? gateFingerprint([...baseGate.metrics.values()], baseGate.scalars) : null;
  const fpHead = gateFingerprint(cfg.metrics, cfg);
  const info = {
    fingerprint: { base: fpBase, head: fpHead },
    ...(fpBase && fpBase !== fpHead ? { changed: true } : {}),
    ...(weakened.length ? { weakened } : {}),
    ...(evalChanged.length ? { evaluatorChanged: evalChanged } : {}),
  };
  // hand the base ref's mandates to gate() (not part of the record) so checkMandates can hold a
  // change to a mandate it deleted in the same diff.
  Object.defineProperty(info, 'baseMandates', { value: baseGate ? baseGate.scalars.mandates || [] : null, enumerable: false });
  return info;
}

function gate(repo, opts) {
  selfHeal(repo);
  const cfg = opts.config ?? loadConfig(repo);
  const repeat = Math.max(1, opts.repeat ?? cfg.repeat ?? 1);

  let base, head;
  if (opts.working) {
    // measure uncommitted changes, tracked AND untracked, via a temp-index snapshot;
    // never touches the real index or working tree. (A loop agent's most common action
    // is to ADD a file; `git stash create` omits untracked, which silently reverted them.)
    try { git(['rev-parse', '--verify', 'HEAD'], repo); }
    catch { bad('no commits yet, make an initial commit before gating --working changes'); }
    base = 'HEAD';
    head = workingSnapshot(repo);
  } else {
    base = resolveBase(repo, opts.base);
    head = opts.head || 'HEAD';
  }

  const before = measureAt(repo, base, cfg, repeat);
  const after = measureAt(repo, head, cfg, repeat);
  const metrics = cfg.metrics.map((m) => {
    const ev = evaluate(m, before[m.name], after[m.name], repeat);
    return { name: m.name, direction: m.direction || 'up', guard: !!m.guard, ...ev };
  });
  // Section 3 (gaming detection), on by default: mutates `metrics` and yields the gate record
  const gateInfo = opts.detectGaming ? detectGamingPass(repo, base, head, cfg, metrics, repeat) : null;
  // declared override: a Promptwheel-Allow trailer (or --allow) acknowledges an intentional
  // goalpost/gate change, so a would-be GAMED becomes PASS, recorded in report.allowed for review.
  const allow = opts.allow ? { reason: String(opts.allow).slice(0, 300) } : (opts.working ? null : readAllowTrailer(repo, head));
  let allowed = null;
  if (opts.detectGaming && allow) {
    const gm = metrics.filter((m) => m.gamed === true);
    const gw = !!(gateInfo && gateInfo.weakened);
    if (gm.length || gw) {
      allowed = { reason: allow.reason, cleared: [...gm.map((m) => m.name), ...(gw ? ['gate'] : [])] };
      for (const m of gm) { m.gamed = false; m.allowed = true; }
      if (gw) gateInfo.allowed = true;
    }
  }
  // mandates run first: a protected-path hard rule fails the gate no matter what the metrics say.
  // The base ref's mandates count too (resolved through `extends` by gateDefAtRef), so a change
  // cannot clear a mandate by deleting it in the same diff that violates it.
  const baseMandates = (gateInfo && gateInfo.baseMandates) || (!opts.detectGaming ? ((gateDefAtRef(repo, base) || {}).scalars || {}).mandates : null);
  const mandateViolations = checkMandates(repo, base, head, cfg, baseMandates);
  const mandated = mandateViolations.length > 0;
  const failed = metrics.some((m) => m.guard && !m.ok);
  const gamed = metrics.some((m) => m.gamed === true) || !!(gateInfo && gateInfo.weakened && !gateInfo.allowed);
  // a guard that never runs (inert: a pass/fail metric stuck at 0 across both refs) verifies
  // nothing, don't launder that into a green PASS. The honest verdict is "couldn't measure".
  // BUT scope it to a bare no-op run: an inert guard must NOT bury a genuine, measured win
  // elsewhere (that would make `improve` revert good changes and misread them as a plateau).
  const inconclusive = !failed && !gamed && metrics.some((m) => m.inert) && !metrics.some((m) => m.status === 'improved');
  const verdict = (mandated || failed) ? 'fail' : gamed ? 'gamed' : inconclusive ? 'inconclusive' : 'pass';
  const report = {
    base: short(repo, base), head: short(repo, head), repeat, mode: opts.working ? 'working' : 'refs',
    verdict, metrics,
    ...(mandateViolations.length ? { mandates: mandateViolations } : {}),
    ...(gateInfo ? { gate: gateInfo } : {}),
    ...(allowed ? { allowed } : {}),
  };
  // provenance receipt: makes the verdict tamper-evident + reproducible ("re-run and get the same
  // verdict is checkable"). Additive to the record; never changes the verdict.
  report.provenance = {
    tool: 'promptwheel', toolVersion: TOOL_VERSION,
    baseSha: safeRev(repo, base), headSha: opts.working ? head : safeRev(repo, head),
    configHash: gateFingerprint(cfg.metrics, cfg),
    verdictHash: verdictFingerprint(report),
  };
  if (!opts.noRecord && cfg.record !== false) recordOutcome(repo, report);
  return report;
}

function run(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  let config;
  if (!hasConfigFile(repo) && !args.noAuto) {
    config = autoConfig(repo);
    console.error(`no promptwheel.config.json, auto-gating the detected test command: ${config.metrics[0].cmd}  (promptwheel init to customize; --no-auto to require a config)`);
  }
  const report = gate(repo, { base: args.base, head: args.head, working: args.working, repeat: args.repeat, noRecord: args.noRecord, detectGaming: args.detectGaming, allow: args.allow, config });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (args.markdown) console.log(renderMarkdown(report));
  else printHuman(report);
  process.exit(verdictExitCode(report.verdict));
}

// persisted record: append every gated run to a per-repo outcome record (best-effort, never fails the gate)
function recordOutcome(repo, report) {
  try {
    const dir = join(repo, '.promptwheel');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'outcomes.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...report }) + '\n');
  } catch { /* recording must never break the gate */ }
}

// keep-if-improved: run any agent/script, gate the result, keep the change ONLY if a metric improved
function improve(argv) {
  const args = parseArgs(argv);
  if (!args.attempt) die('improve requires --attempt "<command that changes the repo>"');
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const dirty = git(['status', '--porcelain'], repo).split('\n').filter((l) => l.trim() && !l.includes('.promptwheel'));
  if (dirty.length) die('working tree not clean, commit or stash first (improve needs a clean base to revert to)');

  console.error(`▶ attempt: ${args.attempt}`);
  try { execSync(args.attempt, { cwd: repo, stdio: 'inherit' }); }
  catch (e) { console.error(`  (attempt exited ${e.status ?? 1}, gating whatever it changed)`); }

  const report = gate(repo, { working: true, repeat: args.repeat, noRecord: args.noRecord, detectGaming: args.detectGaming });
  const noChange = report.metrics.every((m) => m.delta === 0 || m.delta == null);
  const improvedNames = report.metrics.filter((m) => m.status === 'improved').map((m) => m.name);

  // result + exit code express loop progress so `while improve; do :; done` converges, with the
  // same codes as `run`: 0 = kept a real win · 1 = guarded regression (reverted) · 2 = gamed
  // (reverted) · 3 = plateau/no-op OR inconclusive (reverted)
  let result, exit, note;
  if (report.verdict === 'fail') { result = 'regression'; exit = 1; revert(repo); note = '✗ guarded regression, reverted'; }
  else if (report.verdict === 'gamed') { result = 'gamed'; exit = 2; revert(repo); note = '🚩 gamed, a metric "improved" by editing tests/config, not source, reverted'; }
  else if (report.verdict === 'inconclusive') { result = 'inconclusive'; exit = 3; revert(repo); note = '≈ inconclusive, a guard measured nothing (inert); reverted'; }
  else if (noChange || improvedNames.length === 0) {
    result = 'plateau'; exit = 3; revert(repo);
    note = noChange ? '= no metric moved, reverted' : '= nothing improved beyond noise, reverted';
  } else {
    git(['add', '-A'], repo);
    execFileSync('git', ['commit', '-qm', `promptwheel: ${args.attempt} [improved ${improvedNames.join(', ')}]`], { cwd: repo });
    result = 'kept'; exit = 0;
    note = `✓ kept, committed ${git(['rev-parse', '--short', 'HEAD'], repo)} (improved ${improvedNames.join(', ')})`;
  }

  // stdout carries the value (JSON report or the human table); the decision line goes to
  // stderr so a loop driver can consume clean stdout.
  if (args.json) console.log(JSON.stringify({ result, ...report }, null, 2));
  else printHuman(report);
  console.error(`  ${note}`);
  process.exit(exit);
}

// discard the attempt's changes; keep the .promptwheel outcome record
function revert(repo) {
  git(['reset', '--hard', 'HEAD'], repo);
  try { git(['clean', '-fd', '-e', '.promptwheel'], repo); } catch { /* best effort */ }
}

// insights: honest aggregation of the per-repo outcome record (.promptwheel/outcomes.jsonl)
// into per-metric counts. No model, no decay, no claims: just which metrics actually respond.
// The reader is tolerant of older records that carry extra fields (cohort, label, subsystems).
function insights(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const f = join(repo, '.promptwheel', 'outcomes.jsonl');
  if (!existsSync(f)) die('no outcome record yet, run the gate a few times first (.promptwheel/outcomes.jsonl)');
  const runs = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const agg = {};
  for (const r of runs) for (const m of (r.metrics || [])) {
    const a = agg[m.name] ??= { runs: 0, improved: 0, regressed: 0, inconclusive: 0, unchanged: 0, net: 0, last: null };
    a.runs++; if (a[m.status] != null) a[m.status]++;
    if (typeof m.delta === 'number') a.net = +(a.net + m.delta).toFixed(6);
    a.last = m.after;
  }
  // "lever score" = how reliably acting on this metric yields a real improvement
  const rows = Object.entries(agg).map(([name, a]) => ({ name, ...a, lever: a.runs ? a.improved / a.runs : 0 }))
    .sort((x, y) => y.lever - x.lever);
  if (args.json) { console.log(JSON.stringify({ runs: runs.length, metrics: rows }, null, 2)); return; }
  console.log(`\nPromptWheel insights, ${runs.length} gated runs recorded\n`);
  console.log(`  ${'metric'.padEnd(18)} ${'runs'.padStart(5)} ${'impr'.padStart(5)} ${'regr'.padStart(5)} ${'inconc'.padStart(6)} ${'net Δ'.padStart(9)}  lever`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(18)} ${String(r.runs).padStart(5)} ${String(r.improved).padStart(5)} ${String(r.regressed).padStart(5)} ${String(r.inconclusive).padStart(6)} ${String(r.net).padStart(9)}  ${(r.lever * 100).toFixed(0)}%`);
  }
  console.log('\n  lever = improved/runs, how reliably this metric actually responds. The');
  console.log('  highest-lever metrics are where an agent loop should spend its attempts.\n');
}

// ---------------------------------------------------------------------------
// init, write a starter config so a newcomer isn't staring at a blank page
// ---------------------------------------------------------------------------
const LINT_CMD = 'npx eslint . -f unix 2>/dev/null | grep -c " error " || true';
const PRESETS = {
  'tests-pass': { desc: 'gate: your test suite still passes (command auto-detected)', metrics: null },
  'lint': { desc: 'track: lint error count does not climb',
    metrics: [{ name: 'lint_errors', cmd: LINT_CMD, extract: 'number', direction: 'down', guard: false }] },
  'bundle-size': { desc: 'track: build output size in kB',
    metrics: [{ name: 'bundle_kb', cmd: 'du -sk dist 2>/dev/null | cut -f1 || echo 0', extract: 'number', direction: 'down', guard: false }] },
  'security': { desc: 'gate: security-invariant violations must not climb (CORS, secrets, cookies, payment; see packs/security)',
    metrics: [{ name: 'security_findings', cmd: 'node packs/security/scan.mjs .', extract: 'number', direction: 'down', guard: true }] },
  'llm-eval': { desc: 'gate: AI-feature eval pass-rate + est $/run (see examples/reliability-sprint)',
    metrics: [
      { name: 'eval_pass_rate', cmd: 'node eval.mjs', extract: 'number', direction: 'up', guard: true },
      { name: 'cost_per_run_usd', cmd: 'node estimate-cost.mjs', extract: 'number', direction: 'down', guard: true },
    ] },
  'antihack': { desc: 'catch reward-hacking: a target + tripwires; pairs with `run --detect-gaming` (source-only re-run)',
    metrics: [
      { name: 'tests_pass', cmd: '__TESTCMD__', extract: 'exit', direction: 'pass', guard: true },
      { name: 'test_count', cmd: 'grep -rIoE "\\b(it|test|describe) ?\\(|def test_" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
      { name: 'skipped_tests', cmd: 'grep -rIoE "\\.(skip|only) ?\\(|xit ?\\(|@pytest\\.mark\\.skip" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
      { name: 'suppressions', cmd: 'grep -rIoE "eslint-disable|@ts-(ignore|nocheck)|# ?type: ?ignore|# ?noqa|# ?nosec|//nolint|#!?\\[allow\\(" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
      { name: 'assertions', cmd: 'grep -rIoE "expect ?\\(|\\bassert|\\bt\\.(is|deepEqual|throws|truthy|falsy|not|ok) ?\\(" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
    ] },
  'no-ai-tells': { desc: 'opt-in: fail the gate if the em-dash count rises (an AI writing tell); some projects use them on purpose, so it is not a default',
    metrics: [
      { name: 'em_dashes', cmd: 'grep -rIoe "—" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
    ] },
};

// security-antihack = the security-invariant findings gate + the SAME antihack tripwires
// (so an agent that suppresses a security rule, # noqa / # nosec / eslint-disable, or
// skips a security test is caught), PLUS a starter `evaluatorPaths` that protects common
// security-gate config files (a ruleset or a budget the agent could otherwise loosen to
// pass). The scanner pack installs into `.promptwheel/` (already evaluator-protected). It
// is the "guard the guards" preset: pairs with --detect-gaming so a win that only moved by
// loosening the security gate, not by fixing the code, is GAMED. Blind spot (by design,
// not this tool's job): a source-resident backdoor that behaves safely only under test;
// that needs held-out/behavioral analysis, not a source-only re-run.
PRESETS['security-antihack'] = {
  desc: 'gate security-invariant findings + antihack tripwires + evaluatorPaths so an agent cannot loosen the security gate to pass it (pairs with --detect-gaming)',
  evaluatorPaths: ['.semgrep.yml', '.semgrep.yaml', '.bandit', 'bandit.yaml', '.ruff.toml', 'ruff.toml', '.snyk', 'security-budget.json'],
  metrics: [{ name: 'security_findings', cmd: 'node packs/security/scan.mjs .', extract: 'number', direction: 'down', guard: true }, ...PRESETS.antihack.metrics.slice(1)],
};

function detectTestCmd(repo) {
  const has = (f) => existsSync(join(repo, f));
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) return has('.venv/bin/pytest') ? '.venv/bin/pytest -q' : 'pytest -q';
  // only trust `npm test` when a test script actually exists, otherwise the metric can
  // never pass and the gate would "protect" nothing (very common in Next.js app repos)
  try {
    if (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts?.test) return 'npm test --silent';
  } catch { /* no or unparsable package.json, fall through */ }
  return 'echo "set your test command in promptwheel.config.json" && false';
}

// deps that live outside git + the env a test needs, defaulted per stack. init writes these into
// config; the measurement bridge (bridgeEnv/runSetup) consumes them, keeps the engine agnostic.
// a per-ref build/install so the MEASURED worktree is actually runnable. Closes the "inert" class
// where the detected test command cannot run without a build first (a 10-repo replay put this at
// ~2/3 of gates). Written by `init` into `setup`; a failed setup stays honest (inert -> inconclusive,
// never a fake green). Kept out of the zero-config default so the fast per-turn path stays fast.
function detectSetup(repo) {
  const has = (f) => existsSync(join(repo, f));
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.build) return 'npm run build --if-present';   // TS/bundler tests that run against a built dir
  } catch { /* no or unparsable package.json */ }
  if (has('pyproject.toml') || has('setup.py')) return 'pip install -e . --quiet 2>/dev/null || true';   // editable install so imports resolve the measured ref
  return undefined;
}

function detectEnv(repo) {
  const has = (f) => existsSync(join(repo, f));
  // Python: link the venv (3rd-party deps) and put the worktree src FIRST on PYTHONPATH, so imports
  // resolve the MEASURED ref instead of an editable install pointing back at your original checkout.
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) return { linkDirs: ['.venv'], env: { PYTHONPATH: '{wt}/src:{wt}' } }; // src/ AND flat layouts; worktree src wins over an editable install
  if (has('Cargo.toml')) return { linkDirs: [] }; // do NOT link target/: `cargo test` WRITES there, linking would clobber the user's real dir and share a build cache across refs (measurement blindness). Build fresh in the worktree.
  return {};
}

// only offer the lint metric where eslint actually exists, otherwise it reads 0 forever
// and a newcomer mistakes a metric that can't move for a clean repo.
function hasEslint(repo) {
  const files = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml'];
  if (files.some((f) => existsSync(join(repo, f)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    return !!(pkg.devDependencies?.eslint || pkg.dependencies?.eslint);
  } catch { return false; }
}

// does git ignore this repo-relative path? `check-ignore -q` exits 0 when it does; 1 when it does
// not; anything else (not a git repo) counts as not ignored, so init never fails on the check.
function gitIgnores(repo, relPath) {
  try { execFileSync('git', ['check-ignore', '-q', relPath], { cwd: repo, stdio: 'ignore' }); return true; }
  catch { return false; }
}

function init(argv) {
  if (argv.includes('--list')) {
    console.log('PromptWheel presets (promptwheel init --preset <name>):\n');
    for (const [k, p] of Object.entries(PRESETS)) console.log(`  ${k.padEnd(13)} ${p.desc}`);
    return;
  }
  const repo = (() => { try { return git(['rev-parse', '--show-toplevel'], process.cwd()); } catch { return process.cwd(); } })();
  const out = join(repo, 'promptwheel.config.json');
  if (existsSync(out) && !argv.includes('--force')) die('promptwheel.config.json already exists, pass --force to overwrite');
  const pi = argv.indexOf('--preset');
  const presetName = pi >= 0 ? argv[pi + 1] : null;
  let metrics, note, evaluatorPaths;
  if (presetName) {
    const p = PRESETS[presetName];
    if (!p) die(`unknown preset "${presetName}", try: promptwheel init --list`);
    evaluatorPaths = p.evaluatorPaths;   // a preset may ship a starter evaluator allowlist (e.g. security-antihack)
    metrics = p.metrics || [{ name: 'tests_pass', cmd: detectTestCmd(repo), extract: 'exit', direction: 'pass', guard: true }];
    metrics = metrics.map((m) => m.cmd === '__TESTCMD__' ? { ...m, cmd: detectTestCmd(repo) } : m); // fill the preset's target
    // pack-backed presets: the referenced scripts live in THIS package, not
    // the user's repo, copy them in so the generated config is
    // self-contained and committable (a bare reference silently 404'd)
    metrics = metrics.map((m) => {
      const pk = /(^|\s)(packs\/[\w-]+)\//.exec(m.cmd);
      if (!pk) return m;
      const src = fileURLToPath(new URL(`../${pk[2]}/`, import.meta.url));
      const dst = join(repo, '.promptwheel', pk[2]);
      mkdirSync(dst, { recursive: true });
      const files = readdirSync(src);
      for (const f of files) copyFileSync(join(src, f), join(dst, f));
      console.log(`  ✓ installed ${pk[2]} → .promptwheel/${pk[2]} (commit it with the config)`);
      // the gate measures in clean worktrees, so a pack that git ignores (common: the outcome
      // record lives in .promptwheel/ too) is absent at both refs and the metric reads
      // unmeasurable, failing the guard with no hint why. Say so now, while it is one edit.
      if (files.length && gitIgnores(repo, `.promptwheel/${pk[2]}/${files[0]}`))
        console.log(`  ⚠ .promptwheel/${pk[2]} is gitignored: the gate measures in clean worktrees, so an ignored pack is absent at both refs and ${m.name} reads unmeasurable (the guard fails). Replace ".promptwheel/" in .gitignore with ".promptwheel/*" and "!.promptwheel/packs/", then commit the pack`);
      return { ...m, cmd: m.cmd.replaceAll(pk[2] + '/', `.promptwheel/${pk[2]}/`) };
    });
    note = presetName;
  } else {
    // default = the headline posture: guarded tests + the antihack tripwires, so the FIRST
    // cheat a newcomer tries (gut the tests while the metric stays flat) fails the gate, 
    // "catch your agent cheating" must be true out of the box, not only under a preset.
    const testCmd = detectTestCmd(repo);
    const lint = hasEslint(repo);
    metrics = PRESETS['antihack'].metrics.map((m) => m.cmd === '__TESTCMD__' ? { ...m, cmd: testCmd } : m);
    if (lint) metrics = [...metrics, { name: 'lint_errors', cmd: LINT_CMD, extract: 'number', direction: 'down', guard: false }];
    note = `tests + antihack tripwires${lint ? ' + lint' : ''} (detected: ${testCmd})`;
  }
  const setup = presetName ? undefined : detectSetup(repo);
  const envCfg = presetName ? {} : { ...detectEnv(repo), ...(setup ? { setup } : {}) };
  if (envCfg.linkDirs) note += ` · linking ${envCfg.linkDirs.join(', ')}`;
  writeFileSync(out, JSON.stringify({ repeat: 1, ...envCfg, ...(evaluatorPaths ? { evaluatorPaths } : {}), metrics }, null, 2) + '\n');
  console.log(`✓ wrote promptwheel.config.json, ${note}`);
  warnEditableInstall(repo);   // one-time advice at setup, never on the per-turn path
  if (!argv.includes('--no-agent-block')) {
    const wrote = writeAgentBlock(repo);
    if (wrote.length) console.log(`✓ wrote the agent guide (when to run the gate) to ${wrote.join(', ')}`);
  }
  console.log('\n  next:  promptwheel run --working   # gate your uncommitted changes');
  console.log('         promptwheel init --list     # other presets (llm-eval, bundle-size, …)');
}

// Write (or refresh) a short agent-orienting block so the coding AGENT runs the gate itself, not just
// the human. Goes into AGENTS.md (the cross-tool convention; created if absent) and into CLAUDE.md /
// .cursorrules when those already exist. Idempotent + safe: only the sentinel-delimited block is
// touched, everything else in the file is left exactly as-is. `--no-agent-block` skips it.
function writeAgentBlock(repo) {
  const START = '<!-- promptwheel:gate -->', END = '<!-- /promptwheel:gate -->';
  const block = `${START}\n## PromptWheel gate\n\nAfter a change that should move a measurable metric (tests, lint, coverage, an eval), run \`npx promptwheel run --working\`. Exit 2 (verdict GAMED) means the win came from editing a test, config, or grader, not the source, so revert and earn it in the source. Exit 1 means a guarded metric regressed, revert that too. Never weaken, skip, or delete a test to go green.\n${END}\n`;
  const targets = ['AGENTS.md', ...['CLAUDE.md', '.cursorrules'].filter((f) => existsSync(join(repo, f)))];
  const done = [];
  for (const f of targets) {
    const p = join(repo, f);
    let text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const s = text.indexOf(START);
    if (s > -1) { const e = text.indexOf(END, s); text = (e > -1 ? text.slice(0, s) + block + text.slice(e + END.length).replace(/^\n+/, '\n') : text.slice(0, s) + block); }
    else { text = (text.trim() ? text.replace(/\n*$/, '\n\n') : '') + block; }
    try { writeFileSync(p, text); done.push(f); } catch { /* best-effort */ }
  }
  return done;
}

// observability: list the EFFECTIVE guardrails (incl. inherited) + each one's flag record
function guards(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const cfg = loadConfig(repo);
  const hist = {};
  const f = join(repo, '.promptwheel', 'outcomes.jsonl');
  if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    for (const m of (r.metrics || [])) {
      const h = hist[m.name] ??= { runs: 0, flagged: 0, last: null };
      h.runs++; if (m.guard && m.ok === false) h.flagged++; h.last = m.status;
    }
  }
  const rows = cfg.metrics.map((m) => ({
    name: m.name, direction: m.direction || 'up', guard: !!m.guard,
    source: m.__src, override: !!m.__override, ...(hist[m.name] || { runs: 0, flagged: 0, last: null }),
  }));
  if (args.json) { console.log(JSON.stringify({ guards: rows }, null, 2)); return; }
  console.log('\nPromptWheel guardrails, effective set for this repo\n');
  for (const r of rows) {
    const prov = r.override ? 'local override' : (r.source === 'local' ? 'local' : `inherited ← ${r.source}`);
    const rec = r.guard ? (r.runs ? `· ${r.flagged} flagged / ${r.runs} runs` : '· no runs yet') : '';
    console.log(`  ${r.guard ? '🛡️  GUARD' : '·   info '}  ${r.name.padEnd(18)} better=${r.direction.padEnd(5)}  [${prov}]  ${rec}`);
  }
  console.log('\n  🛡️ = enforced (a trusted regression fails the gate) · info = tracked only\n');
}

const short = (repo, ref) => { try { return git(['rev-parse', '--short', ref], repo); } catch { return ref; } };

function printHuman(r) {
  const arrowFor = (m) => (m.delta == null ? '?' : m.delta > 0 ? '▲' : m.delta < 0 ? '▼' : '=');
  console.log(`\nPromptWheel  ${r.base} → ${r.head}${r.repeat > 1 ? `  (×${r.repeat})` : ''}\n`);
  if (r.mandates) for (const md of r.mandates) console.log(`  ⛔ MANDATE "${md.name}" violated${md.reason ? ': ' + md.reason : ''}  (touched: ${md.files.join(', ')})${md.removed ? '  [deleted in this same change; a mandate stays in force for the change that removes it]' : md.edited ? '  [edited in this same change; the version before the change stays in force for the change that edits it]' : ''}`);
  for (const m of r.metrics) {
    const tag = m.guard ? (m.ok ? 'guard✓' : 'GUARD✗') : 'info';
    const d = m.delta == null ? 'n/a' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    console.log(`  ${arrowFor(m)} ${m.name.padEnd(18)} ${String(m.before).padStart(8)} → ${String(m.after).padStart(8)}  (${d}, ${m.status}) [${tag}, ${m.confidence}]`);
    if (m.inert) console.log(`      ⚠ "${m.name}" never ran (same value at both refs): its command needs a build/deps first, or is not your real test command. Fix: promptwheel init, or set setup/linkDirs in promptwheel.config.json`);
    if (m.gamed === true) console.log(`      🚩 GAMED, ${m.gamingReason}`);
  }
  if (r.gate && r.gate.weakened) for (const w of r.gate.weakened) console.log(`  🚩 GATE WEAKENED, the guard "${w.name}" was ${w.change === 'guard-removed' ? 'removed' : 'disabled'} in this change and it would have ${w.status} at head (goalpost moved, not earned)`);
  if (r.gate && r.gate.changed) console.log(`  ⚠ gate definition changed in this change (fingerprint ${r.gate.fingerprint.base} -> ${r.gate.fingerprint.head}): a metric, guard, evaluatorPath or mandate was added, removed or edited; review promptwheel.config.json as part of the diff`);
  const failReason = r.mandates ? ', a mandate was violated (a protected path changed)' : ', a guarded metric regressed (beyond noise)';
  console.log(`\n  VERDICT: ${r.verdict.toUpperCase()}${r.verdict === 'fail' ? failReason : r.verdict === 'gamed' ? ', a metric "improved" by editing the goalposts, not the source' : r.verdict === 'inconclusive' ? ', a guard is inert (measured nothing); a pass cannot be certified' : ''}`);
  if (r.verdict === 'fail' && r.mandates) console.log('  a mandate is a hard rule; if the change is truly intended, edit the mandate in promptwheel.config.json (a tracked, tamper-evident change), do not work around it');
  else if (r.verdict === 'fail') console.log('  intentional? loosen that guard locally in promptwheel.config.json (guard:false, or override the inherited metric by name), `promptwheel guards` shows the effective set');
  if (r.allowed) console.log(`  ✓ allowed: ${r.allowed.cleared.join(', ')} acknowledged as an intentional change, recorded (Promptwheel-Allow: ${r.allowed.reason})`);
  console.log('');
}

// PR-comment markdown (rendering lives in the tool so the GitHub Action stays thin)
function renderMarkdown(r) {
  const icon = r.verdict === 'pass' ? '✅' : r.verdict === 'gamed' ? '🚩' : r.verdict === 'inconclusive' ? '🟡' : '❌';
  const sIcon = { improved: '🟢', regressed: '🔴', unchanged: '⚪', inconclusive: '🟡', unmeasurable: '⚫' };
  const rows = r.metrics.map((m) => {
    const d = m.delta == null ? 'n/a' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    const status = m.gamed === true ? `🚩 gamed (${(m.retained * 100).toFixed(0)}% survives source-only)` : `${sIcon[m.status] || ''} ${m.status}${m.inert ? ' ⚠ never passes' : ''}`;
    return `| ${m.guard ? '🛡️ ' : ''}${m.name} | ${m.before} | ${m.after} | ${d} | ${status} | ${m.confidence} |`;
  }).join('\n');
  return [
    `### ${icon} PromptWheel, outcome gate: **${r.verdict.toUpperCase()}**`,
    '',
    `\`${r.base} → ${r.head}\` · ${r.mode} mode${r.repeat > 1 ? ` · ×${r.repeat}` : ''}`,
    '',
    ...(r.mandates ? [r.mandates.map((md) => `> ⛔ **Mandate violated:** \`${md.name}\`${md.reason ? ': ' + md.reason : ''} (touched \`${md.files.join('`, `')}\`)${md.removed ? ' (deleted in this same change; it stays in force for the change that removes it)' : md.edited ? ' (edited in this same change; the version before the change stays in force for the change that edits it)' : ''}`).join('\n'), ''] : []),
    '| metric | before | after | Δ | status | confidence |',
    '|---|--:|--:|--:|---|---|',
    rows,
    '',
    r.verdict === 'gamed' ? '> 🚩 A metric "improved" only because the agent edited tests/config/grader, not the source. The win does not survive a source-only re-run.' : r.verdict === 'fail' ? (r.mandates ? '> ⛔ A mandate was violated: a protected path changed. This is a hard rule, enforced before any metric.' : '> ❌ A 🛡️ guarded metric regressed beyond the noise band.') : r.verdict === 'inconclusive' ? '> 🟡 A 🛡️ guarded check is **inert**, it never runs, so nothing was actually verified. Fix its command before trusting a pass.' : '> ✅ No guarded metric regressed.',
    ...(r.gate && r.gate.weakened ? ['', `> 🚩 **Gate weakened:** ${r.gate.weakened.map((w) => `\`${w.name}\` ${w.change === 'guard-removed' ? 'removed' : 'disabled'} (would have ${w.status} at head)`).join('; ')}. The pass was bought by dropping a guard, not by earning it.`] : []),
    ...(r.gate && r.gate.changed ? ['', `> ⚠ **Gate definition changed** in this diff (fingerprint \`${r.gate.fingerprint.base}\` -> \`${r.gate.fingerprint.head}\`): a metric, guard, evaluatorPath or mandate was added, removed or edited. Review the config change with the code.`] : []),
    '',
    '<sub>🛡️ = guard · _prove every change moved a metric_ · [PromptWheel](https://github.com/promptwheel-ai/promptwheel)</sub>',
  ].join('\n');
}

function parseArgs(argv) {
  const a = { json: false, detectGaming: true };   // reward-hack detection is ON by default; --no-detect-gaming opts out
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--head') a.head = argv[++i];
    else if (argv[i] === '--repeat') a.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--working') a.working = true;
    else if (argv[i] === '--no-record') a.noRecord = true;
    else if (argv[i] === '--no-auto') a.noAuto = true;
    else if (argv[i] === '--allow') a.allow = argv[++i];
    else if (argv[i] === '--detect-gaming') a.detectGaming = true;
    else if (argv[i] === '--no-detect-gaming') a.detectGaming = false;
    else if (argv[i] === '--attempt') a.attempt = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--markdown') a.markdown = true;
  }
  return a;
}

// pure, side-effect-free helpers are exported for unit testing; the CLI below only
// runs when this file is executed directly (not when imported by the test suite).
export { extract, evaluate, median, spread, renderMarkdown, isNonSource, evaluatorMatcher, gain, judgeGaming, verdictFingerprint };

// ─────────────────────────────────────────────────────────────────────────────
// Public library API: the Verified-Outcome Contract, in process.
//   import { check } from 'promptwheel';
// Importing this file never runs the CLI (see the isMain guard at the bottom).
// Stable across 0.x minor versions. The schema check() returns and the exit codes
// verdictExitCode() maps are specified in CONTRACT.md; integration paths (conform,
// shell, import, MCP) are in INTEGRATE.md.
// ─────────────────────────────────────────────────────────────────────────────

// The contract revision this build implements (CONTRACT.md "Versioning"). Bumps only
// when the verdict schema or the exit codes change; a consumer may assert on it.
export const CONTRACT_VERSION = '1';

// Section 2 fixed vocabularies, exported so a consumer validates against the source of
// truth instead of hardcoding the strings.
export const VERDICTS = Object.freeze(['pass', 'fail', 'gamed', 'inconclusive']);
export const METRIC_STATUSES = Object.freeze(['improved', 'regressed', 'unchanged', 'inconclusive', 'unmeasurable']);
export const DIRECTIONS = Object.freeze(['up', 'down', 'pass']);

// Section 1: the one verdict -> process exit code mapping. The CLI uses it too, so a
// consumer that maps verdicts this way exits exactly as `promptwheel run` does.
export function verdictExitCode(verdict) {
  return verdict === 'pass' ? 0 : verdict === 'gamed' ? 2 : verdict === 'inconclusive' ? 3 : 1;
}

// check(options) -> report
// Run the gate in process and RETURN the Section 2 verdict object (identical to what
// `run --json` prints). Measurement happens only in throwaway worktrees, never the
// caller's working tree (constitution #4). This function never prints and never calls
// process.exit; it throws a plain Error on a precondition failure (not a git repo, or a
// missing / invalid config). Reproducible from (base, head, config) alone.
//
//   repo          string   repo path (default: discovered from process.cwd())
//   base          string   base ref (default: merge-base vs origin/main..., else HEAD~1)
//   head          string   head ref (default: HEAD)
//   working       boolean  gate uncommitted changes instead of base..head
//   config        object   a resolved config { metrics:[...], ... }; omit to load
//                          promptwheel.config.json, or auto-detect a default when none exists
//   auto          boolean  allow the zero-config auto-detect fallback (default true; false throws if no config)
//   repeat        number   measurement repeats for the noise band (default: config.repeat ?? 1)
//   detectGaming  boolean  run the Section 3 source-only re-proof (default: true)
//   allow         string   a declared override reason (same as --allow / a Promptwheel-Allow: trailer)
//   record        boolean  append the run to .promptwheel/outcomes.jsonl (default: false)
export function check(options = {}) {
  let repo;
  try {
    repo = options.repo ? realpathSync(options.repo)
                        : git(['rev-parse', '--show-toplevel'], process.cwd());
  } catch { throw new Error(`promptwheel check: not inside a git repository (${options.repo || process.cwd()})`); }

  let config = options.config;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.metrics) || config.metrics.length === 0)
      throw new Error('promptwheel check: options.config.metrics must be a non-empty array');
  } else if (!hasConfigFile(repo)) {
    if (options.auto === false) throw new Error(`promptwheel check: no promptwheel.config.json in ${repo} (pass options.config, or allow auto-detect)`);
    config = autoConfig(repo);   // zero-config: gate the detected test command in process
  }

  return gate(repo, {
    base: options.base,
    head: options.head,
    working: options.working,
    config,
    repeat: options.repeat,
    detectGaming: options.detectGaming ?? true,
    allow: options.allow,
    noRecord: options.record !== true,
  });
}

// conformsToContract(report) -> { ok, errors }
// Structurally validate a verdict object against Section 2 (shapes + fixed vocabularies)
// plus the two honest-verdict rules that hold for any conforming implementation. Zero
// dependency, so a third party can self-check the artifact it emits against the reference
// schema. It checks well-formedness and consistency, not a deep re-derivation of the math.
export function conformsToContract(report) {
  const errors = [];
  const E = (m) => errors.push(m);
  const isInt = (n) => Number.isInteger(n);
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const numOrNull = (n) => n === null || isNum(n);

  if (!report || typeof report !== 'object' || Array.isArray(report)) return { ok: false, errors: ['report must be an object'] };
  if (!VERDICTS.includes(report.verdict)) E(`verdict must be one of ${VERDICTS.join('|')} (got ${JSON.stringify(report.verdict)})`);
  if (typeof report.base !== 'string' || !report.base) E('base must be a non-empty string');
  if (typeof report.head !== 'string' || !report.head) E('head must be a non-empty string');
  if (report.mode !== undefined && report.mode !== 'refs' && report.mode !== 'working') E("mode must be 'refs' or 'working'");
  if (report.repeat !== undefined && !(isInt(report.repeat) && report.repeat >= 1)) E('repeat must be an integer >= 1');
  if (report.cohort !== undefined && typeof report.cohort !== 'string') E('cohort must be a string');
  if (report.subsystems !== undefined && !(Array.isArray(report.subsystems) && report.subsystems.every((s) => typeof s === 'string')))
    E('subsystems must be an array of strings');
  if (!Array.isArray(report.metrics)) { E('metrics must be an array'); return { ok: false, errors }; }

  report.metrics.forEach((m, i) => {
    const at = `metrics[${i}]`;
    if (!m || typeof m !== 'object') { E(`${at} must be an object`); return; }
    if (typeof m.name !== 'string' || !m.name) E(`${at}.name must be a non-empty string`);
    if (!DIRECTIONS.includes(m.direction)) E(`${at}.direction must be one of ${DIRECTIONS.join('|')}`);
    if (typeof m.guard !== 'boolean') E(`${at}.guard must be a boolean`);
    if (!METRIC_STATUSES.includes(m.status)) E(`${at}.status must be one of ${METRIC_STATUSES.join('|')}`);
    if (typeof m.ok !== 'boolean') E(`${at}.ok must be a boolean`);
    if (m.before !== undefined && !numOrNull(m.before)) E(`${at}.before must be a number or null`);
    if (m.after !== undefined && !numOrNull(m.after)) E(`${at}.after must be a number or null`);
    if (m.delta !== undefined && !numOrNull(m.delta)) E(`${at}.delta must be a number or null`);
    if (m.noise !== undefined && !(isNum(m.noise) && m.noise >= 0)) E(`${at}.noise must be a number >= 0 (the measured jitter band; repeat count is the top-level report.repeat)`);
    if (m.confidence !== undefined && typeof m.confidence !== 'string') E(`${at}.confidence must be a string`);
    if (m.gamed !== undefined && typeof m.gamed !== 'boolean') E(`${at}.gamed must be a boolean`);
    if (m.allowed !== undefined && typeof m.allowed !== 'boolean') E(`${at}.allowed must be a boolean`);
    if (m.sourceOnly !== undefined && !numOrNull(m.sourceOnly)) E(`${at}.sourceOnly must be a number or null`);
    if (m.retained !== undefined && !numOrNull(m.retained)) E(`${at}.retained must be a number or null`);
    if (m.gamingReason !== undefined && typeof m.gamingReason !== 'string') E(`${at}.gamingReason must be a string`);
  });

  // the optional gate-integrity record (report.gate): a config fingerprint and, when the
  // agent weakened the gate it is judged by, the list of dropped guards.
  if (report.gate !== undefined) {
    if (!report.gate || typeof report.gate !== 'object' || Array.isArray(report.gate)) E('gate must be an object');
    else {
      if (report.gate.fingerprint !== undefined && (typeof report.gate.fingerprint !== 'object' || report.gate.fingerprint === null)) E('gate.fingerprint must be an object { base, head }');
      if (report.gate.changed !== undefined && typeof report.gate.changed !== 'boolean') E('gate.changed must be a boolean');
      if (report.gate.weakened !== undefined && !Array.isArray(report.gate.weakened)) E('gate.weakened must be an array');
    }
  }

  // the optional declared-override record (report.allowed): a reason and the names it cleared.
  if (report.allowed !== undefined) {
    if (!report.allowed || typeof report.allowed !== 'object' || Array.isArray(report.allowed)) E('allowed must be an object { reason, cleared }');
    else {
      if (typeof report.allowed.reason !== 'string' || !report.allowed.reason) E('allowed.reason must be a non-empty string');
      if (report.allowed.cleared !== undefined && !Array.isArray(report.allowed.cleared)) E('allowed.cleared must be an array');
    }
  }

  // Honest-verdict rules that hold regardless of how a verdict is derived:
  // a clean pass cannot hide a failing guard, a gamed win, or a weakened gate; and a gamed
  // verdict must point at a gamed metric or a weakened gate. (Fail-vs-gamed precedence is
  // left to the implementation.)
  if (VERDICTS.includes(report.verdict)) {
    const gateWeakened = !!(report.gate && Array.isArray(report.gate.weakened) && report.gate.weakened.length && !report.gate.allowed);
    if (report.verdict === 'pass' && report.metrics.some((m) => m.guard === true && m.ok === false))
      E("verdict 'pass' but a guarded metric regressed (guard:true, ok:false)");
    if (report.verdict === 'pass' && report.metrics.some((m) => m.gamed === true))
      E("verdict 'pass' but a metric is gamed:true");
    if (report.verdict === 'pass' && gateWeakened)
      E("verdict 'pass' but report.gate.weakened is non-empty (the gate was weakened)");
    if (report.verdict === 'gamed' && !report.metrics.some((m) => m.gamed === true) && !gateWeakened)
      E("verdict 'gamed' but no metric is gamed:true and report.gate records no weakening");
  }

  return { ok: errors.length === 0, errors };
}

// `promptwheel conformance [file.json | -] [--cmd "<command>"]`
// Self-check a Contract implementation. With a file or stdin, validate that verdict JSON
// against the Section 2 schema. With --cmd, run the command, then validate its --json
// stdout (Section 2) AND that its exit code matches the verdict per Section 1. Exit 0 if
// it conforms, 1 otherwise, listing every problem.
function conformance(argv) {
  let cmd = null, src = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cmd') cmd = argv[++i];
    else if (argv[i] === '-' || !argv[i].startsWith('-')) src = argv[i];
  }

  let text, exitCode = null;
  if (cmd) {
    try { text = execFileSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); exitCode = 0; }
    catch (e) {
      text = (e.stdout || '').toString();
      exitCode = typeof e.status === 'number' ? e.status : null;
      if (!text) { console.error(`conformance: command produced no stdout (exit ${exitCode}): ${e.message}`); process.exit(1); }
    }
  } else {
    const file = src && src !== '-' ? src : 0; // fd 0 = stdin
    try { text = readFileSync(file, 'utf8'); }
    catch (e) { console.error(`conformance: cannot read ${!src || src === '-' ? 'stdin' : src}: ${e.message}`); process.exit(1); }
  }

  let report;
  try { report = JSON.parse(text); }
  catch (e) { console.error(`conformance: not valid JSON: ${e.message}`); process.exit(1); }

  const { errors } = conformsToContract(report);
  const problems = [...errors];
  if (cmd && exitCode !== null && VERDICTS.includes(report.verdict)) {
    const want = verdictExitCode(report.verdict);
    if (exitCode !== want) problems.push(`exit code ${exitCode} does not match verdict '${report.verdict}' (Section 1 requires ${want})`);
  }

  if (problems.length === 0) {
    console.log(`ok, conforms to the Verified-Outcome Contract v${CONTRACT_VERSION} (verdict: ${report.verdict}${cmd ? `, exit ${exitCode}` : ''})`);
    process.exit(0);
  }
  console.error(`does NOT conform to the Contract (${problems.length} problem${problems.length > 1 ? 's' : ''}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

function dispatch() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version' || cmd === '-v') { console.log(TOOL_VERSION ?? 'unknown'); process.exit(0); }
  if (cmd === 'run') run(rest);
  else if (cmd === 'improve') improve(rest);
  else if (cmd === 'insights') insights(rest);
  else if (cmd === 'init') init(rest);
  else if (cmd === 'guards') guards(rest);
  else if (cmd === 'conformance') conformance(rest);
  else {
    const help = !cmd || cmd === '--help' || cmd === '-h' || cmd === 'help';
    if (!help) console.error(`unknown command: ${cmd}`);
    console.log([
      'PromptWheel: a deterministic, zero-LLM check for your coding loop. It proves every change earned its win by re-running the result from the agent\'s source edits alone, so a green that came from editing the test reads GAMED.',
      '',
      '  promptwheel --version | -v                   print the version',
      '  promptwheel --help | -h                      this banner',
      '  promptwheel init [--preset <name> | --list] [--no-agent-block]  write a starter config + an AGENTS.md guide so your agent runs the gate (OPTIONAL: run works zero-config, auto-detecting your test command)',
      '  promptwheel run [--base R] [--head R] [--repeat N] [--json|--markdown]',
      '       catches reward-hacking BY DEFAULT, re-proves each win from SOURCE edits alone (verdict GAMED,',
      '       exit 2, when a metric only moved by editing tests/config/grader). Use --no-detect-gaming for the bare gate.',
      '  promptwheel run --working                    gate uncommitted changes (incl. newly added files)',
      '  promptwheel run --allow "<reason>"           acknowledge an intentional test/config change (or a `Promptwheel-Allow: <reason>` commit trailer; `Sawbuck-Allow:` is an alias): recorded, not flagged GAMED',
      '  promptwheel improve --attempt "<cmd>"        run an agent/script; keep only if a metric improved',
      '                                               exit 0=kept · 1=regression · 2=gamed · 3=plateau/inconclusive (all but 0 reverted) · add --json',
      '  promptwheel insights [--json]                which metrics actually respond (raw counts from .promptwheel/outcomes.jsonl)',
      '  promptwheel guards [--json]                  show the effective guardrails (incl. inherited) + flag record',
      '  promptwheel conformance [file|-] [--cmd C]   check a verdict JSON (or a command) against the Contract (exit 0 = conforms)',
      '',
      'Exit codes: 0 pass · 1 fail (a guarded metric regressed, or a mandate was violated) · 2 gamed · 3 inconclusive · 64 usage or config error (never a verdict).',
      'Integrate (library / conform / shell / MCP): see INTEGRATE.md. Import: `import { check } from \'promptwheel\'`.',
      'Loop it:  while promptwheel improve --attempt "$AGENT"; do :; done   # stops on plateau/regression',
      'Config:   promptwheel.config.json → { extends?, metrics:[{ name, cmd, direction, extract?, guard? }] }   (or: promptwheel init)',
      '          extends: a path (or array) to a shared base config, repos INHERIT its guardrails; local metrics override by name.',
    ].join('\n'));
    process.exit(help ? 0 : EX_USAGE);
  }
}

// run the CLI only when invoked directly (resolves symlinks so the npm bin still works)
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* not main */ }
function main() {
  try { dispatch(); }
  catch (e) { if (e && e.name === 'ConfigError') die(e.message); throw e; }
}
if (isMain) main();
