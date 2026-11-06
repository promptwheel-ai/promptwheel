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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, realpathSync, readdirSync, lstatSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, isAbsolute, relative, sep } from 'node:path';
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

// every temp dir the engine creates (worktrees, source-only worktrees, temp indexes) carries a short
// hash of the owning repo in its name, so self-heal in one repo never deletes a checkout another
// repo is still measuring in (a long gate elsewhere must not lose its worktree mid-run)
function tmpOwnerTag(repo) { let r = repo; try { r = realpathSync(repo); } catch { /* keep as given */ } return createHash('sha1').update(String(r)).digest('hex').slice(0, 8); }
const tmpPrefix = (repo, kind) => `${kind}-${tmpOwnerTag(repo)}-`;
// exactly the names mkdtemp makes from tmpPrefix: the kind, the 8-hex owner tag, then mkdtemp's 6 random
// characters. Self-heal removes nothing else, so a folder that only starts with "promptwheel-" is never ours.
const ENGINE_TMP = /^(promptwheel-src|promptwheel|pw-idx)-([0-9a-f]{8})-[A-Za-z0-9]{6}$/;

// usage / config errors exit 64 (EX_USAGE), so they can never be confused with a verdict
// (0 pass, 1 fail, 2 gamed, 3 inconclusive): in CI a config typo must not read as GAMED.
const EX_USAGE = 64;
function die(msg) { console.error(msg); process.exit(EX_USAGE); }
// a config or precondition error: thrown, so the library path (check()) surfaces it to the caller
// instead of exiting the host process; the CLI catches it in main() and exits EX_USAGE.
function bad(msg) { const e = new Error(msg); e.name = 'ConfigError'; e.exitCode = EX_USAGE; throw e; }

// the repository root, or a ConfigError: a non-repo cwd must exit 64, never 1 (the FAIL verdict code)
function repoRoot(cwd) {
  // stderr ignored: git's own "fatal: not a git repository" must not print above the ConfigError line
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { bad(`promptwheel: not inside a git repository (${cwd})`); }
}
// a ref the gate is about to check out must be in this clone; the usual miss is a shallow CI
// checkout (actions/checkout defaults to fetch-depth 1) whose PR base was never fetched
function ensureCommit(repo, ref, what) {
  try { execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: repo, stdio: 'ignore' }); }
  catch { bad(`promptwheel: ${what} ref "${ref}" is not in this clone (a shallow checkout? fetch it, e.g. actions/checkout with fetch-depth: 0)`); }
}

function readConfigFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { bad(`invalid config ${p}: ${e.message}`); }
}

const relOf = (repo, p) => { try { return relative(repo, p) || p; } catch { return p; } };

// resolve a config + its `extends` chain into a flat, provenance-tagged metric list.
// `extends` is a path (or array of paths) to base configs, relative to the config file:
// a repo INHERITS their guardrails, and a local metric of the same name overrides the inherited one.
function resolveConfig(p, repo, seen) {
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
      const base = resolveConfig(bp, repo, seen);
      for (const m of base.metrics) byName.set(m.name, m);
      for (const md of (base.mandates || [])) if (md && md.name) mandatesByName.set(md.name, md);
      for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'gamingThreshold', 'evaluatorPaths', 'allowTrailer']) if (base[k] !== undefined) scalars[k] = base[k];
    }
    for (const m of (cfg.metrics || [])) {
      byName.set(m.name, m);
    }
    for (const md of (cfg.mandates || [])) if (md && md.name) mandatesByName.set(md.name, md);
    for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'gamingThreshold', 'evaluatorPaths', 'allowTrailer']) if (cfg[k] !== undefined) scalars[k] = cfg[k];
    return { ...scalars, metrics: [...byName.values()], mandates: [...mandatesByName.values()] };
  } finally {
    seen.delete(abs); // only ACTIVE ancestors are a cycle, a diamond (a base reached two ways) is fine
  }
}

function loadConfig(repo) {
  const p = join(repo, 'promptwheel.config.json');
  if (!existsSync(p)) bad('no promptwheel.config.json, run: promptwheel init   (writes one for your stack)');
  const cfg = resolveConfig(p, repo, new Set());
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
function autoConfig(repo, at = stackAt(repo)) {
  return { ...detectEnv(repo, at), metrics: [{ name: 'tests_pass', cmd: detectTestCmd(repo, at), extract: 'exit', direction: 'pass', guard: true }] };
}
// where stack detection looks: the working tree, or the tracked files as of `ref` (the repo as it was before a change)
function stackAt(repo, ref) {
  if (!ref) return { has: (f) => existsSync(join(repo, f)), read: (f) => readFileSync(join(repo, f), 'utf8') };
  const read = (f) => execFileSync('git', ['show', `${ref}:${f}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { has: (f) => { try { read(f); return true; } catch { return false; } }, read };
}

function resolveBase(repo, base) {
  if (base) return base;
  let head = '';
  try { head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], repo); }
  catch { bad('promptwheel: no commits yet, make an initial commit before gating'); }
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    let mb = '';
    // stderr ignored: a ref that is not there (no origin/main in this clone) is expected, not an error to print
    try { mb = execFileSync('git', ['merge-base', 'HEAD', b], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { continue; }
    // on the trunk itself the merge-base IS HEAD; comparing a commit to itself would be a
    // trivial PASS that verified nothing, so fall through to the last commit instead.
    if (mb && mb !== head) return mb;
  }
  try { return git(['rev-parse', '--verify', '--quiet', 'HEAD~1'], repo); }
  catch { bad('promptwheel: no commit to compare against (one commit, or a shallow clone): pass --base, or --working'); }
}

// exit statuses of a sample list, kept beside it: 127 (the shell found no such command), 126 (it could not
// execute it) or no status (killed: a timeout) mean the metric never ran, which needs a different fix from a
// test that ran and failed
const exitCodes = new WeakMap();
const neverRan = (samples) => { const c = exitCodes.get(samples) || []; return c.length > 0 && c.every((x) => x == null || x === 126 || x === 127); };
// Why a metric's command failed, read from its output: a dependency the clean copy does not have reads differently
// from tests that simply fail. A hint for the person, never part of a verdict.
const MISSING_DEP = /Cannot find (?:module|package) ['"][^'"\n]+['"]|ERR_MODULE_NOT_FOUND[^\n]*|ModuleNotFoundError: [^\n]+|No module named [^\n]+|error TS2307: [^\n]+|[^\n:]*: (?:command )?not found[^\n]*|can't find crate[^\n]*|cannot find package [^\n]+/i;
function whyFailed(text) {
  const m = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').match(MISSING_DEP);
  return m ? { cause: 'missing-dependency', detail: m[0].trim().slice(0, 200) } : { cause: 'failing' };
}
const failNotes = new WeakMap();   // samples -> why the last failing run failed
function runMetric(cwd, m, env, codes, notes) {
  let stdout = '', code = 0, status = 0;
  // Never leak the harness's own node:test context into the measured gate: a metric like
  // `node --test` would see NODE_TEST_CONTEXT, act as a child reporter, and report a bogus
  // exit code (so the gate can't be trusted when PromptWheel itself runs under a test runner).
  const childEnv = { ...(env || process.env) }; delete childEnv.NODE_TEST_CONTEXT;
  try {
    // maxBuffer: the default is 1 MB, and a suite that prints more than that was killed and read as failing. A real
    // repo found it (tap prints every assertion when its output is a pipe): the check said "your tests fail" about
    // a suite that passes.
    stdout = execSync(m.cmd, { cwd, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: (m.timeoutSec ?? 300) * 1000, maxBuffer: 1024 * 1024 * 1024 });
  } catch (e) { status = e.status ?? null; code = e.status ?? 1; stdout = `${e.stdout || ''}${e.stderr || ''}`; if (notes) notes.push(e.code === 'ENOBUFS' ? { cause: 'too-much-output', detail: 'the command printed more than 1 GB, so it was stopped before it finished' } : whyFailed(`${e.stderr || ''}\n${e.stdout || ''}`)); }
  if (codes) codes.push(status);
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
const linkDirsOf = (cfg) => (Array.isArray(cfg.linkDirs) ? cfg.linkDirs : (cfg.linkNodeModules === false ? [] : ['node_modules']));
// Every folder that has a tracked package.json and a node_modules of its own: the workspaces of a monorepo, whichever
// tool laid them out. Asked of git, so nothing walks the tree.
function workspaceModuleDirs(repo) {
  let files = '';
  try { files = execFileSync('git', ['ls-files', '-z', '--', '*/package.json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return []; }
  const out = [];
  for (const f of files.split('\0')) {
    if (!f || f.split('/').includes('node_modules')) continue;
    const d = join(dirname(f), 'node_modules');
    if (existsSync(join(repo, d))) out.push(d);
    if (out.length >= 500) break;
  }
  return out;
}
// A node_modules folder in a workspaces repo holds links back into the repo: npm and yarn link each workspace package
// from the root, pnpm from the workspace that depends on it. One symlink to the real folder would make a test in the
// worktree import a sibling package from the working tree, at both refs, so a regression there would never show. Such
// a folder is rebuilt in the worktree instead: each entry linked on its own, and an entry that points back into the
// repo pointed at the same path in the worktree. A folder with no such entry, in a repo pnpm did not lay out, keeps
// the single link it always had.
function linkModules(repo, wt, d) {
  const src = join(repo, d), dst = join(wt, d);
  const entries = [];
  try {
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (e.name.startsWith('@') && e.isDirectory()) { for (const s of readdirSync(join(src, e.name), { withFileTypes: true })) entries.push([join(e.name, s.name), s]); }
      else entries.push([e.name, e]);
    }
  } catch { return; }
  const back = (name, e) => {
    if (!e.isSymbolicLink()) return null;
    try { const r = relative(repo, realpathSync(join(src, name))); return r && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('node_modules') ? r : null; } catch { return null; }
  };
  const links = entries.map(([name, e]) => [name, back(name, e), e]);
  // pnpm refuses a node_modules, or its own state folder inside it, that is a symlink: its scripts stop at once
  const pnpm = entries.some(([name]) => name === '.pnpm' || name === '.modules.yaml');
  try {
    if (!pnpm && !links.some(([, rel]) => rel)) { symlinkSync(src, dst); return; }
    mkdirSync(dst, { recursive: true });
    for (const [name, rel, e] of links) {
      // a tool's own state or cache folder (pnpm's task-run state, .cache, .vite) is written to, so each worktree gets
      // its own, made by the tool. The store (.pnpm) and the executables (.bin) are read, so they are linked.
      if (name.startsWith('.') && name !== '.bin' && name !== '.pnpm' && e.isDirectory()) continue;
      if (name.includes(sep)) mkdirSync(dirname(join(dst, name)), { recursive: true });
      symlinkSync(rel ? join(wt, rel) : join(src, name), join(dst, name));
    }
  } catch { /* best effort */ }
}
function bridgeEnv(repo, wt, cfg) {
  let root = repo; try { root = realpathSync(repo); } catch { /* keep the path as given */ }
  // with nothing declared, a Node repo links its root node_modules and each workspace's own
  const dirs = (Array.isArray(cfg.linkDirs) || cfg.linkNodeModules === false) ? linkDirsOf(cfg) : ['node_modules', ...workspaceModuleDirs(root)];
  for (const d of dirs) {
    if (!existsSync(join(root, d)) || existsSync(join(wt, d)) || !existsSync(dirname(join(wt, d)))) continue;
    if (basename(d) === 'node_modules') linkModules(root, wt, d);
    else { try { symlinkSync(join(root, d), join(wt, d)); } catch { /* best effort */ } }
  }
  if (!cfg.env) return process.env;
  return { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v).replaceAll('{wt}', () => wt)])) }; // fn replacement: a literal wt avoids $-pattern interpretation
}
// an optional per-ref build/install (e.g. `npm run build`, `pip install -e .`). Best-effort: a
// failed setup just leaves the metric inert → INCONCLUSIVE (never a false green). Run by the
// caller AFTER any source patch, so it builds the tree actually being measured.
// Returns nothing when setup worked, or { exit, lastLine } when it did not, so the report can say so.
function runSetup(wt, cfg, env) {
  if (!cfg.setup) return undefined;
  try { execSync(cfg.setup, { cwd: wt, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, maxBuffer: 1024 * 1024 * 1024 }); return undefined; }
  catch (e) {
    const lines = `${e.stdout || ''}\n${e.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { exit: e.status ?? null, lastLine: (lines[lines.length - 1] || '').slice(0, 200) };   // the metric goes inert → inconclusive
  }
}
const setupFails = new WeakMap();   // a measureAt result -> how its setup failed

// measure every metric `repeat` times at a ref, in a throwaway worktree (never touches your tree)
function measureAt(repo, ref, cfg, repeat) {
  const wt = mkdtempSync(join(tmpdir(), tmpPrefix(repo, 'promptwheel')));
  git(['worktree', 'add', '--quiet', '--detach', wt, ref], repo);
  try {
    const env = bridgeEnv(repo, wt, cfg);
    const setupFailed = runSetup(wt, cfg, env);
    const out = {};
    if (setupFailed) setupFails.set(out, setupFailed);
    for (const m of cfg.metrics) {
      const samples = [], codes = [], notes = [];
      for (let i = 0; i < repeat; i++) samples.push(runMetric(wt, m, env, codes, notes));
      exitCodes.set(samples, codes);
      if (notes.length) failNotes.set(samples, notes[notes.length - 1]);
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
  if (m.exact === true) { improved = false; regressed = delta !== 0; }   // a fingerprint: any change at all needs a reason

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
  // a grader/eval/score FILE by name in a scripting language (eval.py, grader-x.js, grade.sh, scoring.ts), never a
  // prefix: evaluate.ts, evaluation.py, scoreboard.js stay source. Compiled names stay source too (eval.c, eval.go
  // are interpreters; Score.java is a type), and so do .tsx/.vue files (a Score component, a /score page).
  /(^|\/)(eval|evals|grade|grader|graders|score|scorer|scoring)([._-][^/]*)?\.([cm]?[jt]s|py|sh|bash|zsh|rb|pl|php|lua|r|jl)$/i,
  // anything under an evals/ or grader(s)/ directory. Not eval/ (an interpreter's package) or scoring/ (a product module).
  /(^|\/)(evals|graders?)\//i,
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
  // "improved" a scanner count by deleting its rules must show 0%
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
// The mandates in force are the base ref's (`baseMandates`, resolved by gateDefAtRef), in their head
// version when both have them: deleting a mandate in the same change that violates it does not
// clear it, and one the change adds does not apply to it (see below). A mandate removed at head but violated in the diff is reported with `removed: true`; one
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
  // a rule this change adds does not apply to the change adding it: the commit that signs a contract adds the
  // very files the contract protects. Deleting or narrowing a rule stays caught, through the base list above.
  const baseNames = new Set((Array.isArray(baseMandates) ? baseMandates : []).map((m) => m && m.name));
  const mandates = [...headList.filter((m) => m && baseNames.has(m.name)), ...kept];
  if (!mandates.length) return [];
  let changed = [];
  try { changed = git(['diff', '--name-only', '--no-renames', base, head], repo).split('\n').filter(Boolean); } catch { return []; }   // --no-renames: a move out of a protected path also touches it
  const out = [];
  for (const m of mandates) {
    const pats = (Array.isArray(m.paths) ? m.paths : []).filter((s) => typeof s === 'string' && s.trim());
    if (!pats.length) continue;
    const res = pats.map(globToRe);
    const hit = changed.filter((f) => res.some((re) => re.test(f)));
    if (hit.length) out.push({ name: String(m.name || 'mandate'), reason: m.reason ? String(m.reason).slice(0, 300) : '', files: hit.slice(0, 20), ...(m.allowable ? { allowable: m.allowable } : {}), ...(m.__removed ? { removed: true } : {}), ...(m.__edited ? { edited: true } : {}) });
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
  const all = git(['diff', '--name-only', '--no-renames', base, head], repo).split('\n').filter(Boolean);
  const nonSrc = (p) => isNonSource(p) || isEval(p);
  return { source: all.filter((p) => !nonSrc(p)), nonSource: all.filter(nonSrc) };
}

// measure the given metric defs in ONE worktree at `base` with ONLY the source slice of base→head
// applied (checked out once, patched once, set up once), so re-proving three improved metrics costs
// one checkout, not three. Returns { [name]: { samples, hadSourceChange, applyFailed? } }.
// package.json and pyproject.toml are source and goalposts in one file: dependencies belong to the
// change, the test command and the test runner's options do not. The source-only tree keeps the change's
// file but puts those keys back as they were at base, so `"test": "true"` or `addopts = "-k mul"` cannot
// carry a win. A test command that really had to change is a declared change: --allow.
const JS_TEST_KEYS = ['scripts', 'jest', 'ava', 'mocha', 'nyc', 'c8', 'vitest', 'tap'];
const PY_TEST_TABLE = /^\[\s*tool\.(pytest|coverage|tox)[\].]/;
function tomlTables(text) {   // [header, lines] pairs in file order; the first has no header
  const out = [[null, []]];
  for (const line of text.split('\n')) { if (/^\s*\[/.test(line)) out.push([line.trim(), [line]]); else out[out.length - 1][1].push(line); }
  return out;
}
function holdGoalposts(repo, base, wt, source) {
  for (const p of source) {
    const name = p.split('/').pop();
    if (name !== 'package.json' && name !== 'pyproject.toml') continue;
    let before; try { before = git(['show', `${base}:${p}`], repo); } catch { continue; }   // a new file has no base to hold
    const f = join(wt, p);
    try {
      if (name === 'package.json') {
        const a = JSON.parse(before), b = JSON.parse(readFileSync(f, 'utf8'));
        for (const k of JS_TEST_KEYS) { if (k in a) b[k] = a[k]; else delete b[k]; }
        writeFileSync(f, JSON.stringify(b, null, 2) + '\n');
      } else {
        const held = tomlTables(before).filter(([h]) => h && PY_TEST_TABLE.test(h));
        const kept = tomlTables(readFileSync(f, 'utf8')).filter(([h]) => !h || !PY_TEST_TABLE.test(h));
        writeFileSync(f, [...kept, ...held].map(([, l]) => l.join('\n')).join('\n') + '\n');
      }
    } catch { /* an unreadable manifest stays as the change left it */ }
  }
}

function measureSourceOnlyAll(repo, base, head, defs, cfg, repeat) {
  const out = {};
  if (!defs.length) return out;
  const { source } = changedSourcePaths(repo, base, head, evaluatorMatcher(cfg));
  if (!source.length) { for (const m of defs) out[m.name] = { samples: [], hadSourceChange: false }; return out; } // a "win" with zero source edits = goalposts moved
  const wt = mkdtempSync(join(tmpdir(), tmpPrefix(repo, 'promptwheel-src')));
  git(['worktree', 'add', '--quiet', '--detach', wt, base], repo);
  try {
    const env = bridgeEnv(repo, wt, cfg);
    // --binary so a binary source file (an image, a model blob under src/) travels in the patch; without
    // it git prints "Binary files differ", the apply fails, and a win the source never earned would
    // read as unprovable. Untrimmed: a binary hunk ends in a blank line the apply needs.
    const patch = execFileSync('git', ['diff', '--binary', base, head, '--', ...source], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (patch.trim()) {
      // stdio stderr 'ignore': git apply --3way prints "Applied patch ... cleanly" to stderr; that
      // is noise on an otherwise-quiet run (and corrupts --json for callers that fold in stderr).
      const tryApply = (extra) => { execFileSync('git', ['apply', '--whitespace=nowarn', ...extra], { cwd: wt, input: patch, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] }); };
      try { tryApply(['--3way']); }
      catch { try { tryApply([]); } catch { for (const m of defs) out[m.name] = { samples: [], hadSourceChange: true, applyFailed: true }; return out; } }
    }
    holdGoalposts(repo, base, wt, source);   // the parts of a mixed file that define the tests stay as they were at base
    runSetup(wt, cfg, env); // build the patched tree, so a build-gated metric measures the source edit
    for (const m of defs) {
      const samples = [];
      for (let i = 0; i < repeat; i++) samples.push(runMetric(wt, m, env));
      out[m.name] = { samples, hadSourceChange: true };
    }
    return out;
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
  // the win could not be re-proven at all: never a pass. gate() turns `unprovable` into INCONCLUSIVE.
  if (srcResult.applyFailed) return { gamed: null, unprovable: true, sourceOnly: null, retained: null, reason: 'the source-only patch could not be applied, so the win cannot be re-proven from the source: inconclusive' };
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
// touching the real index or files, so a gate sees a file an agent just added.
// Returns 'HEAD' when nothing changed.
function workingSnapshot(repo) {
  const idxDir = mkdtempSync(join(tmpdir(), tmpPrefix(repo, 'pw-idx')));
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
// abandoned /tmp checkout, so nothing accumulates in your repo or temp dir. It only ever removes a
// directory whose name is exactly what this engine generates (ENGINE_TMP): a folder named
// promptwheel-notes, or another repo's worktree named promptwheel-site-wt, is not ours at any age.
// Ages, by dir mtime: this repo's unregistered checkout after 1h; this repo's still-registered worktree
// after a full day (a killed run leaves it registered, and a younger one may be a concurrent gate still
// measuring); a dir tagged for ANOTHER repo after a full day (an orphan of a repo that was deleted or
// moved: a new real path is a new tag nobody will ever claim). A registered worktree that is not
// tagged for this repo is never touched: it may be yours.
function selfHeal(repo) {
  try {
    git(['worktree', 'prune'], repo); // remove registry entries whose dir is already gone (always safe)
    const tracked = new Set(
      git(['worktree', 'list', '--porcelain'], repo)
        .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim()),
    );
    const tmp = tmpdir(), now = Date.now(), mine = tmpOwnerTag(repo);
    for (const name of readdirSync(tmp)) {
      const made = ENGINE_TMP.exec(name);
      if (!made) continue;   // not a name this engine generates (worktrees + temp-index dirs): never removed
      const tag = made[2];
      // ours after an hour; another repo's only after a full day
      const p = join(tmp, name);
      if (tracked.has(p) && tag !== mine) continue;   // a registered worktree this repo's gate did not make
      const maxAge = tag === mine && !tracked.has(p) ? 3600_000 : 86_400_000;
      // lstat: the engine makes directories, so a file or a symlink under one of its names is left alone
      try { const st = lstatSync(p); if (st.isDirectory() && st.mtimeMs < now - maxAge) rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
    git(['worktree', 'prune'], repo);   // drop the registry entries of anything removed above
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
const GATE_SCALARS = ['gamingThreshold', 'evaluatorPaths', 'allowTrailer', 'setup', 'env', 'linkDirs', 'linkNodeModules'];
// what runs or shapes every measurement besides the metric's own command. A setup can rewrite a test and an
// env var can skip one, so these are part of the gate: fingerprinted, and held at their base values for the
// change that edits them (see detectGamingPass).
const measureOf = (s) => ({ setup: s.setup, env: s.env, linkDirs: s.linkDirs, linkNodeModules: s.linkNodeModules });
const measuredWith = (s) => JSON.stringify([s.setup ?? null, Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).sort(), [...linkDirsOf(s)].sort()]);

// Resolve the gate definition as of `ref` (metrics + mandates + scalars), following `extends` by
// reading every file from that ref via `git show`, mirroring resolveConfig (a parent's mandates
// hold beneath it; a local mandate of the same name overrides). Returns { metrics:Map, scalars }
// with scalars.mandates, or null when there is no config at `ref` (gate() then falls back to the
// zero-config gate the repo ran under, see zeroConfigGate). Never exits: any missing/unreadable file or
// parse error yields null (that branch simply contributes nothing), and `partial` says an extends target
// could not be read at `ref` (it lives outside the repo), so how the base measured is not fully known.
function gateDefAtRef(repo, ref) {
  // quiet: a missing path makes `git show` exit nonzero and print "fatal:" to stderr; swallow it
  const readAt = (p) => { try { return execFileSync('git', ['show', `${ref}:${p}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  const seen = new Set();
  let partial = false;
  const resolve = (p) => {
    if (seen.has(p)) return null;
    seen.add(p);
    const raw = readAt(p);
    if (raw == null) return null;
    let cfg; try { cfg = JSON.parse(raw); } catch { return null; }
    const byName = new Map(); const mandatesByName = new Map(); const scalars = {};
    for (const ext of [].concat(cfg.extends || [])) {
      if (isAbsolute(ext)) { partial = true; continue; }   // outside the repo, cannot git-show; unchanged anyway
      const bp = join(dirname(p), ext).split('\\').join('/');
      const again = seen.has(bp);                    // a diamond: already merged, not a missing piece
      const base = resolve(bp);
      if (!base) { if (!again) partial = true; continue; }
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
  const def = resolve('promptwheel.config.json');
  return def && { ...def, partial };
}

// The gate a repo with no config ran under: the detected test command (source-only re-run on) with the
// stack's env and linkDirs, detected from the tracked files as of `ref`. A change that adds the first
// config is judged against this, so `tests_pass.cmd: "true"` in a new config is an edited guard, not a
// fresh start. `initSetup` is the setup `init` would add: a first config that carries exactly it has not
// changed how the gate measures. With no test command to detect (the placeholder) the old gate measured
// nothing, so its setup is no baseline (`partial`).
function zeroConfigGate(repo, ref) {
  const at = stackAt(repo, ref), auto = autoConfig(repo, at);
  return { metrics: new Map(auto.metrics.map((m) => [m.name, m])), scalars: { mandates: [], ...measureOf(auto) }, zeroConfig: true, initSetup: detectSetup(repo, at), partial: auto.metrics[0].cmd === PLACEHOLDER_TEST };
}

// how a metric is measured and judged: change any of these on a guard and it is a different guard
// what init writes when it finds no test command. It guards nothing, so replacing it is setup, not a weakened gate.
const PLACEHOLDER_TEST = 'echo "set your test command in promptwheel.config.json" && false';
const measuredBy = (m) => JSON.stringify([m.cmd ?? null, m.extract ?? 'number', m.direction || 'up', m.exact === true, m.report === true]);
// an order-independent SHA-256 (truncated) fingerprint of a gate definition, for the audit record
function gateFingerprint(metricsList, scalars) {
  const norm = {
    metrics: metricsList.map((m) => ({
      name: m.name, guard: m.guard === true, measuredBy: measuredBy(m),
      gamingThreshold: m.gamingThreshold ?? null, gamingCheck: m.gamingCheck !== false,
    })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    gamingThreshold: scalars.gamingThreshold ?? null,
    evaluatorPaths: Array.isArray(scalars.evaluatorPaths) ? [...scalars.evaluatorPaths].sort() : [],
    measuredWith: measuredWith(scalars),
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
  try { changed = git(['diff', '--name-only', '--no-renames', base, head], repo).split('\n').filter(Boolean).filter(isEval); }
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

// guarded metrics that HEAD dropped relative to BASE (removed entirely, or guard turned off), or
// measures another way (a new cmd, extract, direction, exact or report flag): `cmd: "true"` is a dropped guard too
function gateWeakenings(baseGate, headMetrics) {
  if (!baseGate) return [];
  const head = new Map(headMetrics.map((m) => [m.name, m]));
  const weak = [];
  for (const bm of baseGate.metrics.values()) {
    if (bm.guard !== true) continue;                 // only a guard protects anything
    const hm = head.get(bm.name);
    if (!hm) weak.push({ name: bm.name, change: 'guard-removed', def: bm });
    else if (hm.guard !== true) weak.push({ name: bm.name, change: 'guard-disabled', def: bm });
    else if (!bm.report && bm.cmd !== PLACEHOLDER_TEST && measuredBy(hm) !== measuredBy(bm)) weak.push({ name: bm.name, change: 'guard-edited', def: bm });
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

// A change is judged by the gate that was in force before it (`baseGate`: the config at base, or the
// zero-config gate when this change adds the first config). So a change cannot switch off the source-only
// re-run for a metric that had it, loosen gamingThreshold, or swap the setup, env or linked dirs it is
// measured with: the base values hold for the change that edits them, and apply from the next one.
const gamingCheckOff = (cm, baseGate) => {
  if (!cm || cm.gamingCheck !== false) return false;
  const bm = baseGate && baseGate.metrics.get(cm.name);
  return !bm || bm.gamingCheck === false;   // off before this change too, or a metric this change adds
};
function gamingThresholdFor(cm, cfg, baseGate) {
  const now = cm.gamingThreshold ?? cfg.gamingThreshold ?? 0.5;
  const bm = baseGate && baseGate.metrics.get(cm.name);
  const before = bm ? (bm.gamingThreshold ?? baseGate.scalars.gamingThreshold ?? (baseGate.partial ? now : 0.5)) : now;
  return Math.max(now, before);   // the stricter of before and after
}

// The three Section 3 checks, run only with detectGaming, in order: (1) re-prove every actual
// win with the agent's source edits alone; (2) content-hash auto-fail: a declared evaluatorPath
// gate file edited in this diff is a moved goalpost, so a metric that improved alongside it is
// gamed by declaration, deterministic even if the source-only re-run read inert; (3) gate
// integrity: take the gate as of BASE, re-measure any guard HEAD dropped, edited or measures with
// another setup, env or linked dirs, under its base definition (it only counts as tampering if it
// WOULD HAVE FAILED at head), and fingerprint the gate definition at both refs (metrics,
// evaluatorPaths, gamingThreshold, mandates, setup, env, linked dirs) so a quietly deleted guard
// or mandate is tamper-evident: base != head is recorded as gate.changed and
// printed, whatever the verdict. Mutates `metrics` in place (gamed/sourceOnly/retained/
// gamingReason) and returns the report.gate record. An allow trailer can still clear a gamed
// metric afterwards, in gate().
function detectGamingPass(repo, base, head, cfg, metrics, repeat, baseGate) {
  // how the base measured. Unknown (`partial`) reads as unchanged; so does a first config that adds only the setup `init` detects
  const bs = baseGate ? (baseGate.partial ? { ...baseGate.scalars, ...measureOf(cfg) } : baseGate.scalars) : null;
  const asInit = !!bs && baseGate.zeroConfig && measuredWith({ ...bs, setup: baseGate.initSetup }) === measuredWith(cfg);
  const measureChanged = !!bs && !asInit && measuredWith(bs) !== measuredWith(cfg);
  const baseRun = measureChanged ? { ...cfg, ...measureOf(bs) } : cfg;   // the head gate, run with the base setup, env and linked dirs
  const toProve = [];
  for (const m of metrics) {
    if (m.status !== 'improved') continue;
    const cm = cfg.metrics.find((c) => c.name === m.name);
    if (gamingCheckOff(cm, baseGate)) continue;   // tripwire / test-side guards aren't re-proven from source (their gain legitimately lives in test files)
    toProve.push(cm);
  }
  const srcResults = measureSourceOnlyAll(repo, base, head, toProve, baseRun, repeat);   // one patched checkout for all of them
  for (const cm of toProve) {
    const m = metrics.find((x) => x.name === cm.name);
    const j = judgeGaming(m, srcResults[cm.name], gamingThresholdFor(cm, cfg, baseGate));
    m.gamed = j.gamed; m.sourceOnly = j.sourceOnly; m.retained = j.retained; m.gamingReason = j.reason;
    if (j.unprovable) m.unprovable = true;
  }
  // A green that stays green proves nothing about the tests. When a change edits the source and the tests
  // together, run the old tests on the new source: if they fail, say so. Only a note, never a verdict: an
  // intended API change does this too, and no deterministic check can tell the two apart.
  const split = changedSourcePaths(repo, base, head, evaluatorMatcher(cfg));
  if (split.source.length && split.nonSource.length) {
    const held = metrics.filter((m) => m.status === 'unchanged' && m.direction === 'pass' && m.after === 1 && !m.tripwire);
    const defs = held.map((m) => cfg.metrics.find((c) => c.name === m.name)).filter(Boolean);
    const res = measureSourceOnlyAll(repo, base, head, defs, baseRun, repeat);
    for (const m of held) { const r = res[m.name]; if (r && r.samples && r.samples.length && median(r.samples) !== 1) m.heldByTestEdit = true; }
  }
  // a file declared as a goalpost before this change still is one for this change: dropping the declaration in the
  // same diff that edits the file does not make the edit count as source
  const declared = [...new Set([...(cfg.evaluatorPaths || []), ...((baseGate && baseGate.scalars.evaluatorPaths) || [])])];
  const evalChanged = changedEvaluatorPaths(repo, base, head, { ...cfg, evaluatorPaths: declared });
  if (evalChanged.length) {
    for (const m of metrics) {
      if (m.status !== 'improved' || m.gamed === true) continue;
      const cm = cfg.metrics.find((c) => c.name === m.name);
      if (gamingCheckOff(cm, baseGate)) continue; // tripwire/test-side guards legitimately live in gate files
      m.gamed = true;
      m.gamingReason = `a declared evaluatorPath gate file changed in this diff (${evalChanged.map((e) => e.path).join(', ')}); a win alongside a goalpost edit is gamed by declaration`;
    }
  }
  const weak = gateWeakenings(baseGate, cfg.metrics);
  // the setup, env or linked dirs changed: every guard the base had is measured again the way it was measured before
  if (measureChanged) for (const bm of baseGate.metrics.values()) {
    if (bm.guard === true && !bm.report && bm.cmd !== PLACEHOLDER_TEST && !weak.some((w) => w.name === bm.name)) weak.push({ name: bm.name, change: 'measurement-edited', def: bm });
  }
  const weakened = [];
  if (weak.length) {
    const defs = weak.map((w) => w.def);
    const b = measureAt(repo, base, { ...baseRun, metrics: defs }, repeat);
    const a = measureAt(repo, head, { ...baseRun, metrics: defs }, repeat);
    const evs = new Map();
    for (const w of weak) {
      const ev = evaluate(w.def, b[w.name], a[w.name], repeat);
      evs.set(w.name, ev);
      // an edited guard that still fails under its old definition was turned green by the edit, not the code
      let hidden = !ev.ok || (w.change === 'guard-edited' && ev.inert);
      // a guard measured another way counts only when the new measurement hides it: it fails the old way and reads fine the new way
      if (w.change === 'measurement-edited') { const hm = metrics.find((x) => x.name === w.name); hidden = (!ev.ok || !!ev.inert) && !!hm && hm.ok && !hm.inert; }
      if (hidden) weakened.push({ name: w.name, change: w.change, status: ev.inert ? 'failed' : ev.status });
    }
    // a win under the old definition still has to be earned in the source: swapping or renaming the guard in the same
    // change does not skip the source-only re-run
    const won = weak.filter((w) => w.def.gamingCheck !== false && !weakened.some((x) => x.name === w.name) && evs.get(w.name).status === 'improved');
    if (won.length) {
      const src = measureSourceOnlyAll(repo, base, head, won.map((w) => w.def), baseRun, repeat);
      for (const w of won) {
        const j = judgeGaming({ name: w.name, direction: w.def.direction || 'up', guard: true, ...evs.get(w.name) }, src[w.name], w.def.gamingThreshold ?? (bs && bs.gamingThreshold) ?? 0.5);
        if (j.gamed) weakened.push({ name: w.name, change: w.change, status: 'gamed' });
      }
    }
  }
  // the fingerprint is of a config file: `base` stays null when there was none there (the zero-config gate is not a file)
  const fpBase = baseGate && !baseGate.zeroConfig ? gateFingerprint([...baseGate.metrics.values()], bs) : null;
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

// Section 1 verdict from the measured facts, pure, so the precedence can be checked in isolation:
// a mandate hit or a guarded regression is FAIL; a win that did not survive the source-only re-run
// (or a weakened gate) is GAMED; INCONCLUSIVE when nothing could be certified. A guard that never
// runs (inert: a pass/fail metric stuck at 0 across both refs) verifies nothing, so a bare no-op
// run is not laundered into a green PASS, BUT an inert guard must not bury a genuine, measured win
// elsewhere (a loop reading the verdict would throw away a good change). And a
// win whose source-only re-run could not be applied (`unprovable`) is never a PASS either: a green
// the engine could not re-prove is exactly the green it exists to doubt.
export function deriveVerdict(metrics, gateInfo = null, mandated = false) {
  const failed = metrics.some((m) => m.guard && !m.ok);
  const gamed = metrics.some((m) => m.gamed === true) || !!(gateInfo && gateInfo.weakened && !gateInfo.allowed);
  const inertNoWin = metrics.some((m) => m.inert) && !metrics.some((m) => m.status === 'improved' && !m.tripwire);   // a tripwire moving is not a measured win
  const unprovable = metrics.some((m) => m.unprovable === true);
  const inconclusive = !failed && !gamed && (inertNoWin || unprovable);
  return (mandated || failed) ? 'fail' : gamed ? 'gamed' : inconclusive ? 'inconclusive' : 'pass';
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
    ensureCommit(repo, base, 'base');
    ensureCommit(repo, head, 'head');
  }

  const before = measureAt(repo, base, cfg, repeat);
  const after = measureAt(repo, head, cfg, repeat);
  // a guard this change adds has no value at base, because its scanner did not exist there. That is adoption,
  // not a failure: it starts counting from head. Removing a guard is still caught (gateWeakenings), and a guard the
  // base contract already had still fails when it cannot be measured. A zero-config run has no contract to adopt.
  const fileGate = gateDefAtRef(repo, base);
  const baseDefs = opts.config ? null : fileGate;
  const adopted = (name) => !opts.config && !(baseDefs && baseDefs.metrics.has(name));
  // the gate in force before this change: the config committed at base, or, when this change adds the
  // first config, the zero-config gate the repo ran under until now
  const baseGate = opts.detectGaming ? (fileGate || (opts.config ? null : zeroConfigGate(repo, base))) : null;
  const metrics = cfg.metrics.map((m) => {
    const ev = evaluate(m, before[m.name], after[m.name], repeat);
    if (ev.status === 'unmeasurable' && ev.before == null && ev.after != null && adopted(m.name)) { ev.ok = true; ev.adopted = true; }
    // a `report` guard tells you and does not fail: a contract can start by watching and tighten later
    if (m.report && !ev.ok && ev.status === 'regressed') { ev.ok = true; ev.noted = true; }
    // an inert guard: did its command run and fail, or never run? `ran` says where it ran (absent: at neither ref)
    if (ev.inert && m.cmd !== PLACEHOLDER_TEST) {
      const nb = neverRan(before[m.name]), na = neverRan(after[m.name]);
      if (!nb || !na) ev.ran = !nb && !na ? 'both' : nb ? 'head' : 'base';
      const note = failNotes.get(after[m.name]) || failNotes.get(before[m.name]);   // a hint: a missing dependency or tests that fail
      if (note) Object.assign(ev, note);
    }
    return { name: m.name, direction: m.direction || 'up', guard: !!m.guard, ...(gamingCheckOff(m, baseGate) ? { tripwire: true } : {}), ...ev };
  });
  // Section 3 (gaming detection), on by default: mutates `metrics` and yields the gate record
  const gateInfo = opts.detectGaming ? detectGamingPass(repo, base, head, cfg, metrics, repeat, baseGate) : null;
  // declared override: a Promptwheel-Allow trailer (or --allow) acknowledges an intentional
  // goalpost/gate change, so a would-be GAMED becomes PASS, recorded in report.allowed for review.
  // It covers an `unprovable` win too (the source-only re-run could not be applied): the declared
  // intent is exactly the uncertainty that verdict expresses, and without this a declared change
  // whose source slice will not re-apply had no override short of turning the check off.
  // A trailer is off when the committed contract says `allowTrailer: false` or the caller set
  // PROMPTWHEEL_NO_ALLOW_TRAILER (Sawbuck does, for a commit an agent made): an agent can write a
  // commit message, so where the threat is the agent itself only the --allow flag counts. The base
  // ref's contract is read too, so an agent cannot turn trailers back on in the change it is making.
  const trailersOff = () => !!process.env.PROMPTWHEEL_NO_ALLOW_TRAILER || cfg.allowTrailer === false || ((gateDefAtRef(repo, base) || {}).scalars || {}).allowTrailer === false;
  const allow = opts.allow ? { reason: String(opts.allow).slice(0, 300), by: 'flag' } : (opts.working || trailersOff() ? null : readAllowTrailer(repo, head));
  let allowed = null;
  if (opts.detectGaming && allow) {
    const gm = metrics.filter((m) => m.gamed === true);
    const up = metrics.filter((m) => m.unprovable === true);
    const gw = !!(gateInfo && gateInfo.weakened);
    if (gm.length || up.length || gw) {
      const names = [...new Set([...gm, ...up].map((m) => m.name))];
      allowed = { reason: allow.reason, cleared: [...names, ...(gw ? ['gate'] : [])] };
      for (const m of gm) { m.gamed = false; m.allowed = true; }
      for (const m of up) { m.unprovable = false; m.allowed = true; }
      if (gw) gateInfo.allowed = true;
    }
  }
  // `allowable: true` on a guarded metric (the supply-chain counters: a new dependency or lifecycle
  // script is sometimes the job) lets the same declared reason clear THAT metric's regression, so the
  // change passes with the reason on the record instead of the guard being loosened to let it through.
  // Never implicit: without a reason an allowable guard fails like any other, and the reason is recorded.
  {
    // `allowable: 'flag'` takes the reason from the --allow flag only, never from a commit trailer: an
    // agent can write a trailer, so a guard meant to stop a compromised agent cannot be cleared by one.
    const mode = new Map((cfg.metrics || []).filter((c) => c && c.allowable && c.name).map((c) => [c.name, c.allowable]));
    const ga = metrics.filter((m) => m.guard && !m.ok && mode.has(m.name) && (mode.get(m.name) === true || !allow || allow.by === 'flag'));
    const held = metrics.filter((m) => m.guard && !m.ok && mode.has(m.name) && !ga.includes(m));
    for (const m of held) m.allowable = true;
    if (ga.length && allow) {
      allowed = allowed || { reason: allow.reason, cleared: [] };
      for (const m of ga) { m.ok = true; m.allowed = true; allowed.cleared.push(m.name); }
    } else for (const m of ga) m.allowable = true;   // failed, and a declared reason would clear it: say so in the report
  }
  // mandates: a protected-path hard rule fails the gate no matter what the metrics say.
  // The base ref's mandates count too (resolved through `extends` by gateDefAtRef), so a change
  // cannot clear a mandate by deleting it in the same diff that violates it.
  const baseMandates = (gateInfo && gateInfo.baseMandates) || (!opts.detectGaming ? ((gateDefAtRef(repo, base) || {}).scalars || {}).mandates : null);
  let mandateViolations = checkMandates(repo, base, head, cfg, baseMandates);
  // an allowable mandate (the lock file) changes only with a reason from the --allow flag, recorded
  // like any other override; a commit trailer never clears one.
  if (allow && allow.by === 'flag') {
    const clear = mandateViolations.filter((v) => v.allowable);
    if (clear.length) {
      allowed = allowed || { reason: allow.reason, cleared: [] };
      for (const v of clear) allowed.cleared.push(`mandate:${v.name}`);
      mandateViolations = mandateViolations.filter((v) => !v.allowable);
    }
  }
  const mandated = mandateViolations.length > 0;
  const verdict = deriveVerdict(metrics, gateInfo, mandated);
  const explained = explainMetrics(repo, metrics);
  const report = {
    ...(explained ? { explained } : {}),
    base: short(repo, base), head: short(repo, head), repeat, mode: opts.working ? 'working' : 'refs',
    verdict, metrics,
    ...(mandateViolations.length ? { mandates: mandateViolations } : {}),
    ...(gateInfo ? { gate: gateInfo } : {}),
    ...(allowed ? { allowed } : {}),
  };
  // a setup command that failed, at the ref it failed at: the usual reason a metric could not be measured
  const sb = setupFails.get(before), sa = setupFails.get(after);
  if (sb || sa) report.setup = { ...(sb ? { base: sb } : {}), ...(sa ? { head: sa } : {}) };
  // provenance receipt: makes the verdict tamper-evident + reproducible ("re-run and get the same
  // verdict is checkable"). Additive to the record; never changes the verdict.
  report.provenance = {
    tool: 'promptwheel', toolVersion: TOOL_VERSION,
    baseSha: safeRev(repo, base), headSha: opts.working ? head : safeRev(repo, head),
    configHash: gateFingerprint(cfg.metrics, cfg),
    verdictHash: verdictFingerprint(report),
  };
  return report;
}

function run(argv) {
  const args = parseArgs(argv);
  const repo = repoRoot(process.cwd());
  let config;
  if (!hasConfigFile(repo) && !args.noAuto) {
    config = autoConfig(repo);
    console.error(`no promptwheel.config.json, auto-gating the detected test command: ${config.metrics[0].cmd}  (promptwheel init to customize; --no-auto to require a config)`);
  }
  const report = gate(repo, { base: args.base, head: args.head, working: args.working, repeat: args.repeat, detectGaming: args.detectGaming, allow: args.allow, config });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (args.markdown) console.log(renderMarkdown(report));
  else printHuman(report);
  process.exit(verdictExitCode(report.verdict));
}

// ---------------------------------------------------------------------------
// init, write a starter config so a newcomer isn't staring at a blank page
// ---------------------------------------------------------------------------
const LINT_CMD = 'npx eslint . -f unix 2>/dev/null | grep -c " error " || true';
const PRESETS = {
  'antihack': { desc: 'catch reward-hacking: a target + tripwires; pairs with `run --detect-gaming` (source-only re-run)',
    metrics: [
      { name: 'tests_pass', cmd: '__TESTCMD__', extract: 'exit', direction: 'pass', guard: true },
      { name: 'test_count', cmd: 'grep -rIoE "\\b(it|test|describe) ?\\(|def test_" --exclude-dir=node_modules --exclude-dir=.promptwheel --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
      { name: 'skipped_tests', cmd: 'grep -rIoE "\\.(skip|only) ?\\(|xit ?\\(|@pytest\\.mark\\.skip" --exclude-dir=node_modules --exclude-dir=.promptwheel --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
      { name: 'suppressions', cmd: 'grep -rIoE "eslint-disable|@ts-(ignore|nocheck)|# ?type: ?ignore|# ?noqa|# ?nosec|//nolint|#!?\\[allow\\(" --exclude-dir=node_modules --exclude-dir=.promptwheel --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
      { name: 'assertions', cmd: 'grep -rIoE "expect ?\\(|\\bassert|\\bt\\.(is|deepEqual|throws|truthy|falsy|not|ok) ?\\(" --exclude-dir=node_modules --exclude-dir=.promptwheel --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
    ] },
  'no-ai-tells': { desc: 'opt-in: fail the gate if the em-dash count rises (an AI writing tell); some projects use them on purpose, so it is not a default',
    metrics: [
      { name: 'em_dashes', cmd: 'grep -rIoe "—" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
    ] },
  // supply-chain: the step every npm supply-chain attack needs inside a target repo is a supply-chain
  // edit (a lifecycle script, a new dependency, a non-registry lock source, a workflow or publish
  // config). Paths and counts, checked deterministically: three guarded counts that must not rise
  // without a declared reason (`allowable`), plus mandates that freeze the paths. The contract itself is
  // one of those paths, lifted only by a person's --allow: otherwise a change that only weakens a rule
  // passes, and the next change is judged by the weakened contract.
  'supply-chain': { allowTrailer: false, desc: 'gate: no new lifecycle scripts, dependencies, or non-registry lock sources without a recorded reason; the agent cannot touch workflows, registries, publish scripts, or the contract',
    evaluatorPaths: ['promptwheel.config.json', 'sawbuck.config.json'],
    mandates: [
      { name: 'contract-frozen', paths: ['promptwheel.config.json', 'sawbuck.config.json'], allowable: 'flag', reason: 'the contract changes with a reason from a person (--allow), never as a side effect of a change' },
      { name: 'workflows-frozen', paths: ['.github/workflows/**'], reason: 'workflows run with the repository secrets; change them in a separate, reviewed change' },
      { name: 'registry-config-frozen', paths: ['.npmrc', '.yarnrc', '.yarnrc.yml'], reason: 'registry and token configuration decides where packages come from and where credentials go' },
      { name: 'build-images-frozen', paths: ['Dockerfile*', 'docker-compose*'], reason: 'what runs at build and deploy time is not an agent decision' },
      { name: 'publish-scripts-frozen', paths: ['scripts/release*', 'scripts/publish*'], reason: 'the publish path is how a compromise spreads' },
      { name: 'codeowners-frozen', paths: ['CODEOWNERS'], reason: 'review ownership is set by people' },
      { name: 'scanner-frozen', paths: ['.promptwheel/packs/**'], reason: 'the scanners that read the contract are not edited by the change they read' },
      { name: 'lock-frozen', paths: ['promptwheel.lock.json'], allowable: 'flag', reason: 'the architecture lock changes with a reason from a person (--allow), never as a side effect of a change' },
      { name: 'hooks-frozen', paths: ['.claude/settings.json', '.claude/settings.local.json', '.sawbuck/**'], allowable: 'flag', reason: 'the hooks that enforce the contract change with a reason from a person (--allow), and are never detached by the agent' },
    ],
    metrics: [
      { name: 'lifecycle_scripts', cmd: 'node packs/supply-chain/scan.mjs lifecycle .', extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'dependency_entries', cmd: 'node packs/supply-chain/scan.mjs deps .', extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'lock_nonregistry_sources', cmd: 'node packs/supply-chain/scan.mjs lock-sources .', extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'unpinned_execution', cmd: 'node packs/supply-chain/scan.mjs unpinned .', extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'install_policy_gaps', cmd: 'node packs/supply-chain/scan.mjs policy .', extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'lock_drift', cmd: 'node packs/supply-chain/lock.mjs drift .', extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'pins_changed', cmd: 'node packs/supply-chain/lock.mjs pins .', extract: 'number', direction: 'down', exact: true, guard: true, gamingCheck: false, allowable: 'flag' },
    ] },
};

function detectTestCmd(repo, { has, read } = stackAt(repo)) {
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  // the venv is not tracked: it is looked for on disk whichever ref the stack is read from
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) return existsSync(join(repo, '.venv/bin/pytest')) ? '.venv/bin/pytest -q' : 'pytest -q';
  // only trust `npm test` when a test script actually exists, otherwise the metric can
  // never pass and the gate would "protect" nothing (very common in Next.js app repos)
  try {
    if (JSON.parse(read('package.json')).scripts?.test) return 'npm test --silent';
  } catch { /* no or unparsable package.json, fall through */ }
  return PLACEHOLDER_TEST;
}

// deps that live outside git + the env a test needs, defaulted per stack. init writes these into
// config; the measurement bridge (bridgeEnv/runSetup) consumes them, keeps the engine agnostic.
// a per-ref build/install so the MEASURED worktree is actually runnable. Closes the "inert" class
// where the detected test command cannot run without a build first (a 10-repo replay put this at
// ~2/3 of gates). Written by `init` into `setup`; a failed setup stays honest (inert -> inconclusive,
// never a fake green). Kept out of the zero-config default so the fast per-turn path stays fast.
function detectSetup(repo, { has, read } = stackAt(repo)) {
  try {
    const pkg = JSON.parse(read('package.json'));
    if (pkg.scripts && pkg.scripts.build) return 'npm run build --if-present';   // TS/bundler tests that run against a built dir
  } catch { /* no or unparsable package.json */ }
  if (has('pyproject.toml') || has('setup.py')) return 'pip install -e . --quiet 2>/dev/null || true';   // editable install so imports resolve the measured ref
  return undefined;
}

function detectEnv(repo, { has } = stackAt(repo)) {
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
  const repo = (() => { try { return repoRoot(process.cwd()); } catch { return process.cwd(); } })();
  const out = join(repo, 'promptwheel.config.json');
  if (existsSync(out) && !argv.includes('--force')) die('promptwheel.config.json already exists, pass --force to overwrite');
  const pi = argv.indexOf('--preset');
  const presetName = pi >= 0 ? argv[pi + 1] : null;
  let allowTrailer, metrics, note, evaluatorPaths, mandates;
  if (presetName) {
    const p = PRESETS[presetName];
    if (!p) die(`unknown preset "${presetName}", try: promptwheel init --list`);
    evaluatorPaths = p.evaluatorPaths;   // a preset may ship a starter evaluator allowlist (supply-chain: the contract)
    mandates = p.mandates; allowTrailer = p.allowTrailer;               // a preset may ship hard rules (supply-chain: workflows, registries, publish scripts, hooks)
    metrics = p.metrics.map((m) => m.cmd === '__TESTCMD__' ? { ...m, cmd: detectTestCmd(repo) } : m); // fill the preset's target
    // pack-backed presets: the referenced scripts live in THIS package, not
    // the user's repo, copy them in so the generated config is
    // self-contained and committable (a bare reference silently 404'd)
    const installed = new Set();   // a pack several metrics run (supply-chain) is copied and announced once
    metrics = metrics.map((m) => {
      const pk = /(^|\s)(packs\/[\w-]+)\//.exec(m.cmd);
      if (!pk) return m;
      if (installed.has(pk[2])) return { ...m, cmd: m.cmd.replaceAll(pk[2] + '/', `.promptwheel/${pk[2]}/`) };
      installed.add(pk[2]);
      const src = fileURLToPath(new URL(`../${pk[2]}/`, import.meta.url));
      const dst = join(repo, '.promptwheel', pk[2]);
      mkdirSync(dst, { recursive: true });
      const files = readdirSync(src);
      for (const f of files) copyFileSync(join(src, f), join(dst, f));
      console.log(`  ✓ installed ${pk[2]} → .promptwheel/${pk[2]} (commit it with the config)`);
      // the gate measures in clean worktrees, so a pack that git ignores is absent at both refs and the metric reads
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
  writeFileSync(out, JSON.stringify({ repeat: 1, ...envCfg, ...(evaluatorPaths ? { evaluatorPaths } : {}), ...(mandates ? { mandates } : {}), ...(allowTrailer === false ? { allowTrailer } : {}), metrics }, null, 2) + '\n');
  console.log(`✓ wrote promptwheel.config.json, ${note}`);
  const lockTool = join(repo, '.promptwheel', 'packs', 'supply-chain', 'lock.mjs');
  if (existsSync(lockTool)) console.log(`✓ ${execFileSync(process.execPath, [lockTool, 'write', repo], { encoding: 'utf8' }).trim()} (commit it with the config)`);
  warnEditableInstall(repo);   // one-time advice at setup, never on the per-turn path
  if (!argv.includes('--no-agent-block')) {
    const wrote = writeAgentBlock(repo);
    if (wrote.length) console.log(`✓ wrote the agent guide (when to run the gate) to ${wrote.join(', ')}`);
  }
  console.log('\n  next:  promptwheel run --working   # gate your uncommitted changes');
  console.log('         promptwheel init --list     # other presets (antihack, no-ai-tells, supply-chain)');
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

const short = (repo, ref) => { try { return git(['rev-parse', '--short', ref], repo); } catch { return ref; } };

const wouldHave = (status) => (status === 'unmeasurable' ? 'been unmeasurable' : status);
function printHuman(r) {
  const arrowFor = (m) => (m.delta == null ? '?' : m.delta > 0 ? '▲' : m.delta < 0 ? '▼' : '=');
  console.log(`\nPromptWheel  ${r.base} → ${r.head}${r.repeat > 1 ? `  (×${r.repeat})` : ''}\n`);
  if (r.mandates) for (const md of r.mandates) console.log(`  ⛔ MANDATE "${md.name}" violated${md.reason ? ': ' + md.reason : ''}  (touched: ${md.files.join(', ')})${md.removed ? '  [deleted in this same change; a mandate stays in force for the change that removes it]' : md.edited ? '  [edited in this same change; the version before the change stays in force for the change that edits it]' : ''}`);
  for (const m of r.metrics) {
    const tag = m.guard ? (m.ok ? 'guard✓' : 'GUARD✗') : 'info';
    const d = m.delta == null ? 'n/a' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    console.log(`  ${arrowFor(m)} ${m.name.padEnd(18)} ${String(m.before).padStart(8)} → ${String(m.after).padStart(8)}  (${d}, ${m.status}) [${tag}, ${m.confidence}]`);
    if (m.inert && m.ran && m.cause === 'missing-dependency') console.log(`      ⚠ "${m.name}" could not run in the clean copy at either ref: ${m.detail}. Link or install what it needs (linkDirs or setup in promptwheel.config.json), then check again`);
    else if (m.inert && m.ran === 'both') console.log(`      ⚠ "${m.name}" ran and failed before and after this change, so it guards nothing here. Fix the failing tests, or the command, before trusting a pass`);
    else if (m.inert) console.log(`      ⚠ "${m.name}" ${m.ran ? `ran and failed at the ${m.ran} ref and did not run at the other` : 'never ran (same value at both refs)'}: its command needs a build/deps first, or is not your real test command. Fix: promptwheel init, or set setup/linkDirs in promptwheel.config.json`);
    if (m.gamed === true) console.log(`      🚩 GAMED, ${m.gamingReason}`);
  }
  if (r.setup) { const at = Object.keys(r.setup), f = r.setup[at[0]]; console.log(`  ⚠ setup failed (exit ${f.exit}) at the ${at.join(' and ')} ref${at.length > 1 ? 's' : ''}${f.lastLine ? ': ' + f.lastLine : ''}`); }
  if (r.gate && r.gate.weakened) for (const w of r.gate.weakened) console.log(w.change === 'measurement-edited'
    ? `  🚩 GATE WEAKENED, how the guard "${w.name}" is measured (setup, env or linked dirs) was edited in this change, and measured the way it was before it would have ${wouldHave(w.status)} at head (goalpost moved, not earned)`
    : `  🚩 GATE WEAKENED, the guard "${w.name}" was ${w.change === 'guard-removed' ? 'removed' : w.change === 'guard-edited' ? 'edited' : 'disabled'} in this change and it would have ${wouldHave(w.status)} at head (goalpost moved, not earned)`);
  if (r.gate && r.gate.changed) console.log(`  ⚠ gate definition changed in this change (fingerprint ${r.gate.fingerprint.base} -> ${r.gate.fingerprint.head}): a metric, guard, evaluatorPath, mandate, or the setup, env or linked dirs they are measured with was added, removed or edited; review promptwheel.config.json as part of the diff`);
  const failReason = r.mandates ? ', a mandate was violated (a protected path changed)' : ', a guarded metric regressed (beyond noise)';
  console.log(`\n  VERDICT: ${r.verdict.toUpperCase()}${r.verdict === 'fail' ? failReason : r.verdict === 'gamed' ? ', a metric "improved" by editing the goalposts, not the source' : r.verdict === 'inconclusive' ? ', a guard is inert (measured nothing); a pass cannot be certified' : ''}`);
  if (r.verdict === 'fail' && r.mandates) {
    const takes = r.mandates.filter((md) => md.allowable).map((md) => `"${md.name}"`);
    if (takes.length) console.log(`  intentional? ${takes.join(', ')} ${takes.length > 1 ? 'accept' : 'accepts'} a person's declared reason: promptwheel run --allow "<reason>" passes with the reason on the record`);
    if (takes.length < r.mandates.length) console.log(`  ${takes.length ? 'any other' : 'a'} mandate is a hard rule; if the change is truly intended, retire the mandate in promptwheel.config.json in a change of its own first (a tracked, tamper-evident change), do not work around it`);
  } else if (r.verdict === 'fail' && r.metrics.some((m) => m.allowable)) console.log(`  intentional? this guard accepts a person's declared reason: promptwheel run --allow "<reason>" passes with the reason on the record (${r.metrics.filter((m) => m.allowable).map((m) => m.name).join(', ')})`);
  else if (r.verdict === 'fail') console.log('  intentional? loosen that guard locally in promptwheel.config.json (guard:false, or override the inherited metric by name)');
  if (r.allowed) console.log(`  ✓ allowed: ${r.allowed.cleared.join(', ')} acknowledged as an intentional change, recorded (Promptwheel-Allow: ${r.allowed.reason})`);
  console.log('');
}

// PR-comment markdown (rendering lives in the tool so the GitHub Action stays thin)
// What a person needs when a check speaks: what changed, in words, and how to accept it.
const PLAIN = {
  lifecycle_scripts: 'a new install script', dependency_entries: 'a new dependency', lock_nonregistry_sources: 'a dependency from outside the registry',
  unpinned_execution: 'something that runs without a pinned version', install_policy_gaps: 'a weaker install policy', lock_drift: 'the shape of the repo changed',
  pins_changed: 'resolved dependency versions changed', tests_pass: 'tests stopped passing', test_count: 'fewer tests', skipped_tests: 'more skipped tests',
  suppressions: 'more silenced checks', assertions: 'fewer assertions',
};
function explainMetrics(repo, metrics) {
  const hit = metrics.filter((m) => m.noted || (m.guard && !m.ok));
  if (!hit.length) return null;
  let items = [];
  if (hit.some((m) => m.name === 'lock_drift')) {
    try { items = JSON.parse(execFileSync(process.execPath, ['.promptwheel/packs/supply-chain/lock.mjs', 'drift', '.', '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).slice(0, 8); } catch { /* words without the list */ }
  }
  return hit.map((m) => ({ metric: m.name, noted: !!m.noted, what: PLAIN[m.name] || m.name, ...(m.name === 'lock_drift' && items.length ? { items } : {}), ...(m.allowable ? { allowable: true } : {}) }));
}
// A reason a person left on a pull request. The newest `sawbuck-allow: <reason>` comment from someone with write
// access wins. A bot never counts. An agent signed in as that person can still post one: the record shows it.
export function allowFromComments(comments) {
  const trusted = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  for (const c of [...(comments || [])].reverse()) {
    if (!c || !c.user || c.user.type !== 'User' || !trusted.has(c.author_association)) continue;
    const m = String(c.body || '').match(/^\s*sawbuck-allow:[ \t]*(\S.*?)[ \t]*$/m);
    if (m) return `${m[1].slice(0, 280)} (approved by ${String(c.user.login).slice(0, 39)})`;
  }
  return '';
}

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
    ...(r.mandates ? [r.mandates.map((md) => `> ⛔ **Protected path touched:** \`${md.name}\`${md.reason ? ': ' + md.reason : ''} (touched \`${md.files.join('`, `')}\`)${md.removed ? ' (deleted in this same change; it stays in force for the change that removes it)' : md.edited ? ' (edited in this same change; the version before the change stays in force for the change that edits it)' : ''}`).join('\n'), ''] : []),
    ...(r.explained ? [...r.explained.map((x) => `> ${x.noted ? 'ℹ️ **Note:**' : '✋ **Needs a look:**'} ${x.what}${x.items ? ': `' + x.items.join('`, `') + '`' : ''}`), ...(r.explained.some((x) => !x.noted && x.allowable) ? ['>', '> To accept this, comment `sawbuck-allow: <your reason>` on this PR and re-run the check.'] : []), ''] : []),
    '| metric | before | after | Δ | status | confidence |',
    '|---|--:|--:|--:|---|---|',
    rows,
    '',
    r.verdict === 'gamed' ? '> 🚩 A metric "improved" only because the agent edited tests/config/grader, not the source. The win does not survive a source-only re-run.' : r.verdict === 'fail' ? (r.mandates ? '> ⛔ A protected path changed. This is a hard rule; no metric result clears it.' : '> ❌ A 🛡️ guarded metric regressed beyond the noise band.') : r.verdict === 'inconclusive' ? (r.metrics.some((m) => m.inert) && r.metrics.every((m) => !m.inert || m.ran === 'both') ? '> 🟡 A 🛡️ guarded check is **inert**, it fails before and after this change, so nothing was actually verified. Fix it before trusting a pass.' : '> 🟡 A 🛡️ guarded check is **inert**, it never runs, so nothing was actually verified. Fix its command before trusting a pass.') : '> ✅ No guarded metric regressed.',
    ...(r.gate && r.gate.weakened ? ['', `> 🚩 **Gate weakened:** ${r.gate.weakened.map((w) => `\`${w.name}\` ${w.change === 'guard-removed' ? 'removed' : w.change === 'guard-edited' ? 'edited' : w.change === 'measurement-edited' ? 'measured another way (setup, env or linked dirs)' : 'disabled'} (would have ${wouldHave(w.status)} at head)`).join('; ')}. The pass was bought by changing the gate, not by earning it.`] : []),
    ...(r.allowed ? ['', `> ✓ **Allowed:** \`${r.allowed.cleared.join('`, `')}\` cleared by a declared reason: ${r.allowed.reason}`] : []),
    ...(r.gate && r.gate.changed ? ['', `> ⚠ **Gate definition changed** in this diff (fingerprint \`${r.gate.fingerprint.base}\` -> \`${r.gate.fingerprint.head}\`): a metric, guard, evaluatorPath, mandate, or the setup, env or linked dirs they are measured with was added, removed or edited. Review the config change with the code.`] : []),
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
    else if (argv[i] === '--no-auto') a.noAuto = true;
    else if (argv[i] === '--allow') a.allow = argv[++i];
    else if (argv[i] === '--detect-gaming') a.detectGaming = true;
    else if (argv[i] === '--no-detect-gaming') a.detectGaming = false;
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
// shell, import) are in INTEGRATE.md.
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
// process.exit; every precondition failure (not a git repo, a missing / invalid config, no
// commits) throws an Error named ConfigError with exitCode 64. Reproducible from (base, head,
// config) alone.
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
export function check(options = {}) {
  // `repo` may name a subdirectory: the gate runs at the toplevel (that is where the config
  // lives), exactly as the CLI does from the same directory
  let start = process.cwd();
  if (options.repo) { try { start = realpathSync(options.repo); } catch { bad(`promptwheel: not inside a git repository (${options.repo})`); } }
  const repo = repoRoot(start);

  let config = options.config;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.metrics) || config.metrics.length === 0)
      bad('promptwheel check: options.config.metrics must be a non-empty array');
  } else if (!hasConfigFile(repo)) {
    if (options.auto === false) bad(`promptwheel check: no promptwheel.config.json in ${repo} (pass options.config, or allow auto-detect)`);
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
    if (m.gamed !== undefined && m.gamed !== null && typeof m.gamed !== 'boolean') E(`${at}.gamed must be a boolean, or null when the win could not be re-proven`);
    if (m.unprovable !== undefined && typeof m.unprovable !== 'boolean') E(`${at}.unprovable must be a boolean when present`);
    if (m.unprovable === false && m.allowed !== true) E(`${at}.unprovable is false but no declared override cleared it (allowed must be true)`);
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
    if (report.verdict === 'pass' && report.metrics.some((m) => m.unprovable === true))
      E("verdict 'pass' but a metric is unprovable (its source-only re-run could not be applied)");
    if (report.verdict === 'pass' && gateWeakened)
      E("verdict 'pass' but report.gate.weakened is non-empty (the gate was weakened)");
    if (report.verdict === 'gamed' && !report.metrics.some((m) => m.gamed === true) && !gateWeakened)
      E("verdict 'gamed' but no metric is gamed:true and report.gate records no weakening");
  }

  return { ok: errors.length === 0, errors };
}

// the flags each command accepts. An unknown --flag is a usage error (exit 64), never silently
// ignored: a typo in a CI step must not turn `--no-detect-gaming` into the default gate or `--allow`
// into nothing, and INTEGRATE.md promises a bad flag exits 64. A flag that takes a value consumes
// the next argument; anything not starting with `-` is positional. --no-record does nothing now that
// no record is written, and stays accepted because Sawbuck and existing CI steps pass it.
const GATE_FLAGS = ['--base', '--head', '--repeat', '--working', '--no-record', '--no-auto', '--allow', '--detect-gaming', '--no-detect-gaming', '--json', '--markdown'];
const COMMAND_FLAGS = {
  run: GATE_FLAGS, init: ['--preset', '--list', '--force', '--no-agent-block'], lock: [],
};
// what each valued flag needs. A missing or unusable value is a usage error too: `--repeat abc` must not
// measure nothing and read FAIL, and `--allow` with nothing after it must not run as if no reason was asked for.
const VALUED_FLAGS = { '--base': 'a ref', '--head': 'a ref', '--repeat': 'a whole number, 1 or more', '--allow': 'a reason, e.g. --allow "the spec changed"', '--preset': 'a preset name (see promptwheel init --list)' };
function checkFlags(cmd, argv) {
  const known = new Set(COMMAND_FLAGS[cmd]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) continue;
    if (!known.has(a)) bad(`promptwheel ${cmd}: unknown flag ${a} (see promptwheel --help)`);
    if (!(a in VALUED_FLAGS)) continue;
    const v = argv[++i];
    const gone = v === undefined || known.has(v);   // nothing after the flag, or the next flag
    // an empty --base or --head is the default ref: the Action passes an empty base outside a pull request
    const blank = !gone && !v.trim() && !(v === '' && (a === '--base' || a === '--head'));
    if (gone || blank) bad(`promptwheel ${cmd}: ${a} needs ${VALUED_FLAGS[a]}`);
    if (a === '--repeat' && !/^[1-9]\d*$/.test(v)) bad(`promptwheel ${cmd}: --repeat needs ${VALUED_FLAGS[a]} (got "${v}")`);
  }
}

// read PR comments on stdin: a JSON array, or one comment per line as `gh api --paginate --jq '.[]'` prints every
// page. Streamed: readFileSync(0) corrupted the heap on Node 24.22 reading a live paginated gh pipe.
async function prAllow() {
  let t = ''; process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) t += chunk;
  t = t.trim(); let c = [];
  try { c = [].concat(JSON.parse(t || '[]')); } catch { try { c = t.split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* unreadable, no approval */ } }
  process.stdout.write(allowFromComments(c));
}

// write or refresh the architecture lock from the tree as it stands. A person runs this: the lock file is
// a mandate, so the refreshed file passes the gate only with --allow "<reason>".
async function lock() {
  const repo = repoRoot(process.cwd());
  const { writeLock, LOCK_FILE } = await import(new URL('../packs/supply-chain/lock.mjs', import.meta.url));
  console.log(`✓ ${writeLock(repo)} items locked in ${LOCK_FILE} (commit it; a later change to it needs promptwheel run --allow "<reason>")`);
}

function dispatch() {
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--version' || first === '-v') { console.log(TOOL_VERSION ?? 'unknown'); process.exit(0); }
  const cmd = (rest.includes('--help') || rest.includes('-h')) ? 'help' : first;   // `promptwheel run --help` is a help request, not a gate run
  if (cmd in COMMAND_FLAGS) checkFlags(cmd, rest);
  if (cmd === 'run') run(rest);
  else if (cmd === 'pr-allow') return prAllow();
  else if (cmd === 'init') init(rest);
  else if (cmd === 'lock') return lock(rest);
  else {
    const help = !cmd || cmd === '--help' || cmd === '-h' || cmd === 'help';
    if (!help) console.error(`unknown command: ${cmd}`);
    console.log([
      'PromptWheel: a deterministic, zero-LLM check for your coding loop. It proves every change earned its win by re-running the result from the agent\'s source edits alone, so a green that came from editing the test reads GAMED.',
      '',
      '  promptwheel --version | -v                   print the version',
      '  promptwheel --help | -h                      this banner',
      '  promptwheel lock                             write promptwheel.lock.json, the shape of this repo (dependencies, install scripts, workflows, modules, import edges, routes, entry points, hosts); the supply-chain preset holds it',
      '  promptwheel init [--preset <name> | --list] [--no-agent-block]  write a starter config + an AGENTS.md guide so your agent runs the gate (OPTIONAL: run works zero-config, auto-detecting your test command)',
      '  promptwheel run [--base R] [--head R] [--repeat N] [--json|--markdown]',
      '       catches reward-hacking BY DEFAULT, re-proves each win from SOURCE edits alone (verdict GAMED,',
      '       exit 2, when a metric only moved by editing tests/config/grader). Use --no-detect-gaming for the bare gate.',
      '  promptwheel run --working                    gate uncommitted changes (incl. newly added files)',
      '  promptwheel pr-allow < comments.json         print the newest `sawbuck-allow: <reason>` from a PR comment by someone with write access (the Action uses it)',
      '  promptwheel run --allow "<reason>"           acknowledge an intentional test/config change (or a `Promptwheel-Allow: <reason>` commit trailer; `Sawbuck-Allow:` is an alias): recorded, not flagged GAMED',
      '',
      'Exit codes: 0 pass · 1 fail (a guarded metric regressed, or a mandate was violated) · 2 gamed · 3 inconclusive · 64 usage or config error (never a verdict).',
      'Integrate (library / conform / shell): see INTEGRATE.md. Import: `import { check } from \'promptwheel\'`.',
      'Config:   promptwheel.config.json → { extends?, metrics:[{ name, cmd, direction, extract?, guard? }] }   (or: promptwheel init)',
      '          extends: a path (or array) to a shared base config, repos INHERIT its guardrails; local metrics override by name.',
    ].join('\n'));
    process.exit(help ? 0 : EX_USAGE);
  }
}

// run the CLI only when invoked directly (resolves symlinks so the npm bin still works)
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* not main */ }
async function main() {
  try { await dispatch(); }
  catch (e) { if (e && e.name === 'ConfigError') die(e.message); throw e; }
}
if (isMain) main();
