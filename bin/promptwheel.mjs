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

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, realpathSync, readdirSync, lstatSync, copyFileSync, openSync, closeSync, appendFileSync, renameSync, readlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename, isAbsolute, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
// File names from git, NUL-separated (the caller's command must take -z). Read as lines, a name that holds a byte
// above 127, a double quote, a backslash or a tab comes back inside quotes with the bytes escaped
// ("src/a\303\261adir.js", git's core.quotePath), and that string is no file: it matches no protected path and no
// pathspec, so an honest fix in such a file read "gamed" and a new workflow with such a name was no protected path.
const gitNames = (args, cwd) => execFileSync('git', [...args, '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
// The engine's own git calls run no hook, no fsmonitor command, and read no replace object, whatever the repo's or the
// person's git settings say. A hook an agent planted ran inside the loop's own git calls and moved the branch after the
// keep, an fsmonitor command ran in every later step, and a replace ref swapped the object the check read for an older
// one (attacks 29, 31 and 33 of another session's second list, 2026-11-21). Set through GIT_CONFIG_COUNT, which outranks
// every config file, for as long as the engine works. A command the engine runs FOR the person (a metric, the setup,
// an attempt in the loop) gets the person's environment back: personEnv. Nothing in a library caller's own process is
// left changed once a check returns.
const OWN_GIT = { depth: 0, set: {}, was: {} };
function ownGitOn() {
  if (OWN_GIT.depth++ > 0) return;
  const env = process.env, k = Number(env.GIT_CONFIG_COUNT) || 0;
  OWN_GIT.set = { GIT_CONFIG_COUNT: String(k + 2), [`GIT_CONFIG_KEY_${k}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${k}`]: '/dev/null', [`GIT_CONFIG_KEY_${k + 1}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${k + 1}`]: 'false', GIT_NO_REPLACE_OBJECTS: '1' };
  OWN_GIT.was = Object.fromEntries(Object.keys(OWN_GIT.set).map((key) => [key, env[key]]));
  Object.assign(env, OWN_GIT.set);
}
function ownGitOff() {
  if (--OWN_GIT.depth > 0) return;
  for (const [key, v] of Object.entries(OWN_GIT.was)) { if (v === undefined) delete process.env[key]; else process.env[key] = v; }
  OWN_GIT.set = {}; OWN_GIT.was = {};
}
// the environment for a command run for the person: as they set it, without the engine's own git settings or its switch
function personEnv(env) {
  const e = { ...(env || process.env) };
  // the engine's own switch: PROMPTWHEEL_NO_ALLOW_TRAILER tells THIS run to read no reason from a commit. Handed on, it
  // reached the suite of a repo that tests trailers (this one), and six of its tests failed at both ends of every check
  // Sawbuck ran here, so they were never checked there (found by another session, 2026-11-21).
  delete e.PROMPTWHEEL_NO_ALLOW_TRAILER;
  for (const [key, v] of Object.entries(OWN_GIT.set)) if (e[key] === v) { if (OWN_GIT.was[key] === undefined) delete e[key]; else e[key] = OWN_GIT.was[key]; }
  return e;
}
// The engine's own throwaway checkouts run none of the person's git hooks. `git worktree add` fires post-checkout,
// from the repo's hooks folder or the person's global one (core.hooksPath): a hook that rebuilds tags or installs
// packages ran in every throwaway copy, and one that exits 1 on a detached HEAD made the add fail after the checkout
// was made, so no check could run and each try left a worktree behind. CI has no such hooks either; what a checkout
// needs before it can be measured is the contract's "setup".
function addWorktree(repo, wt, ref) {
  try { git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', wt, ref], repo); }
  catch (e) {
    try { git(['worktree', 'remove', '--force', wt], repo); } catch { /* it was never registered */ }
    try { rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
}
// The source-only patch is read by `git apply`, so it has to read the same on every machine. A plain `git diff` obeys
// the person's own settings: diff.noprefix (no a/ b/), diff.external or GIT_EXTERNAL_DIFF (a side-by-side tool, or one
// that is not installed), color.ui=always, a text converter, diff.context=0. Each made a patch that did not apply.
// The win then read "inconclusive", and an inconclusive turn is not sent back.
const PATCH_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--submodule=short'];
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
// where the engine makes its clean copies: the system temp folder, or, where that is read-only (Claude Code's sandbox,
// a locked-down CI runner), a folder inside the repo's own .git, which git status never shows
const tmpBases = new Map();
function tmpBase(repo) {
  if (tmpBases.has(repo)) return tmpBases.get(repo);
  let base = tmpdir();
  try { rmSync(mkdtempSync(join(base, 'pw-probe-')), { recursive: true, force: true }); }
  catch {
    let gd = ''; try { gd = resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* */ }
    let ok = false;
    if (gd) { const g = join(gd, 'promptwheel-tmp'); try { mkdirSync(g, { recursive: true }); rmSync(mkdtempSync(join(g, 'pw-probe-')), { recursive: true, force: true }); base = g; ok = true; } catch { /* */ } }
    // a sandboxed shell (Claude Code's sandbox makes the temp folder and .git read-only): say so plainly, not with a stack
    if (!ok) throw new Error('this shell cannot write a temp folder or .git (a sandboxed agent shell). Run the check outside the sandbox; under attach, the Stop hook checks each turn outside it.');
  }
  tmpBases.set(repo, base); return base;
}
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
// a repo INHERITS their guards, and a local metric of the same name overrides the inherited one.
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
      for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'gamingThreshold', 'evaluatorPaths', 'allowTrailer', 'allowFromAuthor']) if (base[k] !== undefined) scalars[k] = base[k];
    }
    for (const m of (cfg.metrics || [])) {
      byName.set(m.name, m);
    }
    for (const md of (cfg.mandates || [])) if (md && md.name) mandatesByName.set(md.name, md);
    for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'gamingThreshold', 'evaluatorPaths', 'allowTrailer', 'allowFromAuthor']) if (cfg[k] !== undefined) scalars[k] = cfg[k];
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
// A file that cannot be read inside node_modules is the same thing said another way: a build whose settings extend a
// file from a package that is not installed (a real commit, yargs 9588a76436: TS5083 on node_modules/gts/...).
const MISSING_DEP = /Cannot find (?:module|package) ['"][^'"\n]+['"]|ERR_MODULE_NOT_FOUND[^\n]*|ModuleNotFoundError: [^\n]+|No module named [^\n]+|error TS2307: [^\n]+|(?:^|\n)[^\n:]*(?:sh|bash|zsh|dash)(?::\s*\d+)?:[^\n]*?: (?:command )?not found[^\n]*|(?:^|\n)\S+: command not found[^\n]*|can't find crate[^\n]*|cannot find package [^\n]+|error TS5083: Cannot read file ['"][^'"\n]*node_modules[\\/][^'"\n]+['"][^\n]*|ENOENT[^\n]*['"][^'"\n]*node_modules[\\/][^'"\n]+['"]/i;
// The line that names what is missing wins over a bare error code: a script that dies on a failed import prints the
// source line `throw new ERR_MODULE_NOT_FOUND(` first, and the line with the file after it.
const MISSING_NAMED = /Cannot find (?:module|package) ['"][^'"\n]+['"][^\n]*/i;
function whyFailed(text) {
  const t = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
  const m = t.match(MISSING_NAMED) || t.match(MISSING_DEP);
  // A long path is cut in its middle, not at its end: the end is the file's name, and that is what the hint is for.
  // (Cut at 200 characters from the left, a temp folder over 123 characters long lost the name of the missing file.)
  const short = (p) => (p.length > 60 ? `${p.slice(0, 16)}…${p.slice(-40)}` : p);
  return m ? { cause: 'missing-dependency', detail: m[0].trim().replace(/\/[^\s'"]+/g, short).slice(0, 300) } : { cause: 'failing' };
}
const failNotes = new WeakMap();   // samples -> why the last failing run failed
function runMetric(cwd, m, env, codes, notes) {
  let stdout = '', code = 0, status = 0;
  // Never leak the harness's own node:test context into the measured gate: a metric like
  // `node --test` would see NODE_TEST_CONTEXT, act as a child reporter, and report a bogus
  // exit code (so the gate can't be trusted when PromptWheel itself runs under a test runner).
  // nor the engine's own switch and git settings (personEnv)
  const childEnv = personEnv(env); delete childEnv.NODE_TEST_CONTEXT;
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
      if (name === '.bin' && e.isDirectory() && linkBin(repo, wt, join(src, name), join(dst, name))) continue;
      if (name.includes(sep)) mkdirSync(dirname(join(dst, name)), { recursive: true });
      symlinkSync(rel ? join(wt, rel) : join(src, name), join(dst, name));
    }
  } catch { /* best effort */ }
}
// .bin holds links to executables. One that points back into the repo is a workspace package's own tool, which a build
// or a test may run (micromark's build runs micromark-build). Linked as one folder it ran from the working tree at
// both refs, and in a fresh clone, where nothing is built yet, nothing could be measured. So such a folder is rebuilt
// too, each tool linked on its own and a repo one pointed at the same path in the worktree. Returns false, and writes
// nothing, when no entry points into the repo: the folder then keeps its single link.
function linkBin(repo, wt, src, dst) {
  let rels;
  try {
    rels = readdirSync(src).map((n) => {
      try { const r = relative(repo, realpathSync(join(src, n))); return [n, r && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('node_modules') ? r : null]; } catch { return [n, null]; }
    });
  } catch { return false; }
  if (!rels.some(([, r]) => r)) return false;
  mkdirSync(dst, { recursive: true });
  for (const [n, r] of rels) { try { symlinkSync(r ? join(wt, r) : join(src, n), join(dst, n)); } catch { /* best effort, one tool at a time */ } }
  return true;
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
// an optional per-ref build (e.g. `npm run build`). Best-effort: a
// failed setup just leaves the metric inert → INCONCLUSIVE (never a false green). Run by the
// caller AFTER any source patch, so it builds the tree actually being measured.
// Returns nothing when setup worked, or { exit, lastLine } when it did not, so the report can say so.
// The Python line `init` wrote until 0.8.7. It is never run: see detectSetup. Any other setup runs as written.
const OLD_PYTHON_SETUP = 'pip install -e . --quiet 2>/dev/null || true';
function runSetup(wt, cfg, env) {
  if (!cfg.setup || cfg.setup === OLD_PYTHON_SETUP) return undefined;
  try { const setupEnv = personEnv(env); execSync(cfg.setup, { cwd: wt, env: setupEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, maxBuffer: 1024 * 1024 * 1024 }); return undefined; }
  catch (e) {
    const lines = `${e.stdout || ''}\n${e.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { exit: e.status ?? null, lastLine: (lines[lines.length - 1] || '').slice(0, 200) };   // the metric goes inert → inconclusive
  }
}
const setupFails = new WeakMap();   // a measureAt result -> how its setup failed

// measure every metric `repeat` times at a ref, in a throwaway worktree (never touches your tree)
function measureAt(repo, ref, cfg, repeat) {
  const wt = mkdtempSync(join(tmpBase(repo), tmpPrefix(repo, 'promptwheel')));
  addWorktree(repo, wt, ref);
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

// --base-cache <dir>: keep the base's measurement between runs. A loop that tries many changes against one commit asks
// the scorer about that commit once, not once a try: where a run takes minutes or costs money that is half the bill.
// A kept number answers only for the same tree measured the same way: the key holds the base's tree, each metric's
// command and how it is read, the setup, env and linked dirs, the repeat count, this engine's version and the platform.
// Only a clean measurement is kept: the setup ran and every run gave a number. The folder is the caller's, and it must
// sit outside the repository: a kept number the change can reach is a goalpost. What is linked in but not tracked (an
// installed node_modules) is not in the key, so a caller that changes it empties the folder.
function measureBase(repo, base, cfg, repeat, dir) {
  if (!dir) return { samples: measureAt(repo, base, cfg, repeat) };
  const abs = resolve(dir), inRepo = relative(realpathSync(repo), abs);
  if (!inRepo.startsWith('..') && !isAbsolute(inRepo)) bad(`promptwheel: --base-cache needs a folder outside the repository (got ${dir}): a kept number the change can reach is a goalpost`);
  const how = [git(['rev-parse', `${base}^{tree}`], repo), cfg.metrics.map((m) => [m.name, m.cmd ?? null, m.extract ?? 'number', m.allowNonzero === true, m.timeoutSec ?? null]), measuredWith(cfg), repeat, TOOL_VERSION, process.platform];
  const file = join(abs, `${createHash('sha256').update(JSON.stringify(how)).digest('hex').slice(0, 32)}.json`);
  const whole = (xs) => Array.isArray(xs) && xs.length === repeat && xs.every((x) => typeof x === 'number' && Number.isFinite(x));
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    if (kept && typeof kept.at === 'string' && cfg.metrics.every((m) => whole(kept.samples && kept.samples[m.name]))) {
      const samples = {};
      for (const m of cfg.metrics) { samples[m.name] = kept.samples[m.name]; exitCodes.set(samples[m.name], (kept.codes && kept.codes[m.name]) || []); }
      return { samples, at: kept.at };
    }
  } catch { /* nothing kept for this tree yet, or a file that does not read: measure */ }
  const samples = measureAt(repo, base, cfg, repeat);
  if (!setupFails.get(samples) && cfg.metrics.every((m) => whole(samples[m.name]) && !failNotes.get(samples[m.name]))) {
    try {
      mkdirSync(abs, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), samples, codes: Object.fromEntries(cfg.metrics.map((m) => [m.name, exitCodes.get(samples[m.name]) || []])) }));
      renameSync(tmp, file);   // whole or not at all: two runs at once never leave half a file
    } catch { /* a folder that cannot be written keeps nothing; the measurement stands */ }
  }
  return { samples };
}

// A noise band the contract declares for a metric: `noise`, one number in the metric's own units. It is for a number
// that does not hold still (a model-graded score, a timing). Not read on a pass or fail metric or an exact one, and a
// value that is not a number of zero or more is no band.
const declaredNoise = (m) => (typeof m.noise === 'number' && Number.isFinite(m.noise) && m.noise >= 0 && (m.direction || 'up') !== 'pass' && m.exact !== true ? m.noise : null);

// the credibility core: a delta is only trusted if it clears the noise band. The band is the widest gap between the
// repeats, or the one the contract declares. The measured gap grows with every repeat added, so on a scorer with jitter
// more repeats hid a real gain (seen 761 times in 1,000 at 3 repeats, 196 in 500 at 8), and one run a side had no band
// at all: a change that moved nothing read improved or regressed every time (noise-band bench, 2026-11-21). A declared
// band stands whatever the repeat count, and the measured gap is reported beside it as `spread`.
function evaluate(m, beforeS, afterS, repeat) {
  const before = median(beforeS), after = median(afterS);
  if (before == null || after == null) return { before, after, delta: null, status: 'unmeasurable', ok: !m.guard, confidence: 'none', noise: null };
  const dir = m.direction || 'up';
  const delta = +(after - before).toFixed(6);
  const seen = Math.max(spread(beforeS), spread(afterS)); // observed jitter across repeats
  const declared = declaredNoise(m);
  const noise = declared ?? seen;
  const deterministic = m.extract === 'exit' || m.extract === 'lines';
  const sampledNoise = repeat > 1 || declared != null;
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
  return { before, after, delta, status, ok, confidence, noise, ...(declared != null ? { spread: seen } : {}), ...(inert ? { inert: true } : {}) };
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
  // hyphen names (ava's and node --test's test-*.js, *-test.js, *-spec.js) count outside src/, lib/ and scripts/ only: real
  // production code is named test-patterns.ts or generate-test.ts (found across 18k files, 2026-11-10). A fixed
  // test-release.js at the root read as a source win before this (sendback bench, p-map).
  /^(?!(?:.*\/)?(?:src|lib|scripts)\/)(?:.*\/)?tests?-[^/]*\.[cm]?[jt]sx?$/i,
  /^(?!(?:.*\/)?(?:src|lib|scripts)\/)(?:.*\/)?[^/]+-(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.[cm]?[jt]sx?$/i,                          // node --test's, Deno's and Bun's *_test.js, anywhere (a strong signal)
  /\.test-d\.[cm]?tsx?$/i,                         // tsd type tests (index.test-d.ts), run by a test script like xo && ava && tsd
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
  /[a-z0-9](Test|Tests)\.(java|kt|kts|scala|cs|php|swift)$/,   // JUnit, xUnit/NUnit (.NET), PHPUnit, XCTest
  /(^|\/)[^/]+\.Tests?(\/|\.csproj$)/,                    // a .NET test project: MyApp.Tests/ and MyApp.Tests.csproj
  /_spec\.[cm]?[jt]sx?$/i,                                 // Bun's *_spec.ts
  /\.cy\.[cm]?[jt]sx?$/i,                                  // Cypress specs (login.cy.ts)
  /_test\.(exs|dart)$/i, /(^|\/)integration_test\//i,    // ExUnit, Dart and Flutter
  /(^|\/)testdata\//i, /(^|\/)benches\//i,               // Go test data at any depth, Rust benchmarks
  // test runner and coverage-gate config: editing these skips tests or loosens a threshold
  /(^|\/)\.(mocharc|nycrc|c8rc|coveragerc)[^/]*$/i, /(^|\/)\.rspec$/i, /(^|\/)codecov\.ya?ml$/i,
  /(^|\/)phpunit\.xml(\.dist)?$/i, /(^|\/)vitest\.workspace\.[^/]+$/i, /(^|\/)setupTests\.[cm]?[jt]sx?$/i,
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
  try { changed = gitNames(['diff', '--name-only', '--no-renames', base, head], repo); } catch { return []; }   // --no-renames: a move out of a protected path also touches it
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
// Two kinds of test-side file a path pattern cannot name, so the repo itself is asked (found 2026-11-12 on workspaces that
// keep a script-style test.py; both read as source before, so a win from editing them read as earned):
// 1. A Python file named test.py or tests.py. Django writes a tests.py into every app; Jinja keeps production code in
//    src/jinja2/tests.py (its template tests, with functions named test_odd). The name cannot tell them apart, so the
//    file's own imports decide, at the base or at the head: a test framework means a test module.
const showQuiet = (repo, ref, p) => { try { return execFileSync('git', ['show', `${ref}:${p}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };   // null: not at this ref
const PY_TEST_NAME = /(^|\/)tests?\.py$/i;
const PY_TEST_IMPORT = /^[ \t]*(?:import|from)[ \t]+(?:unittest|pytest|nose2?|hypothesis|doctest|testtools|django\.test|rest_framework\.test|twisted\.trial)\b/m;
function pyTestModule(repo, base, head, p) {
  if (!PY_TEST_NAME.test(p)) return false;
  return [base, head].some((ref) => PY_TEST_IMPORT.test(showQuiet(repo, ref, p) || ''));
}
// 2. A script a guard's own command runs, named like a test runner (test.sh, tests.py, runtests.py, run-tests.sh): it is
//    the measure, not the thing measured. Read from the guards at both ends of the change, and from the base's
//    package.json test script when the command goes through npm. Only the script that is run counts, not what is handed
//    to it (`python -m doctest src/pkg/tests.py` names a production file), and the name must say test:
//    `node src/cli.js --self-test` runs the product, and a fix in it is a source fix.
const RUNNER_NAME = /^(?:run[-_]?)?tests?(?:[-_.][\w.-]*)?\.(?:py|sh|bash|zsh|[cm]?[jt]s|rb|pl|php|lua)$/i;
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|tsx|ts-node|ruby|perl|php|lua[\d.]*)$/;
function scriptRun(simple) {   // the script one simple command runs, or null
  const words = simple.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();   // FOO=bar before the command
  if (!words.length) return null;
  let i = 0;
  if (INTERPRETER.test(words[0].split('/').pop())) {
    i = 1;
    if (words[1] === 'run' && /^(deno|bun)$/.test(words[0].split('/').pop())) i = 2;
    for (; i < words.length && words[i].startsWith('-'); i++) if (/^-(m|c|e|-eval|-print|p)$/.test(words[i])) return null;   // a module or inline code, not a script
  }
  const f = (words[i] || '').replace(/^\.\//, '');
  return f && !f.startsWith('-') && !f.startsWith('/') && !f.split('/').includes('..') ? f : null;
}
function runnerScripts(repo, base, cfg) {
  const cmds = (cfg && Array.isArray(cfg.metrics) ? cfg.metrics : []).filter((m) => m && m.guard === true && typeof m.cmd === 'string').map((m) => m.cmd);
  try { const pkg = JSON.parse(showQuiet(repo, base, 'package.json') || 'null'); if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string') cmds.push(pkg.scripts.test); } catch { /* a package.json that does not parse names no runner */ }
  const out = new Set();
  for (const cmd of cmds) for (const simple of cmd.split(/&&|\|\||[;|\n(){}]/)) {
    const f = scriptRun(simple);
    if (f && RUNNER_NAME.test(f.split('/').pop())) out.add(f);
  }
  return out;
}
function changedSourcePaths(repo, base, head, isEval = () => false, cfg = null) {
  const all = gitNames(['diff', '--name-only', '--no-renames', base, head], repo);
  const runners = cfg ? runnerScripts(repo, base, cfg) : new Set();
  const nonSrc = (p) => isNonSource(p) || isEval(p) || runners.has(p) || pyTestModule(repo, base, head, p);
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

// The question holdGoalposts answers by rewriting, asked without rewriting: did this change move the test keys of a
// manifest it edits? A new file has no base to hold. A manifest that does not parse cannot be said to hold still.
function manifestTestKeysMoved(repo, base, head, p) {
  const name = p.split('/').pop();
  if (name !== 'package.json' && name !== 'pyproject.toml') return false;
  const before = showQuiet(repo, base, p); if (before == null) return false;
  const after = showQuiet(repo, head, p); if (after == null) return true;   // deleted, and its test command with it
  try {
    if (name === 'package.json') { const a = JSON.parse(before), b = JSON.parse(after); return JS_TEST_KEYS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])); }
    const held = (t) => tomlTables(t).filter(([h]) => h && PY_TEST_TABLE.test(h)).map(([, l]) => l.join('\n')).join('\n');
    return held(before) !== held(after);
  } catch { return true; }
}

function measureSourceOnlyAll(repo, base, head, defs, cfg, repeat, guardsFrom = cfg) {
  const out = {};
  if (!defs.length) return out;
  const { source } = changedSourcePaths(repo, base, head, evaluatorMatcher(cfg), guardsFrom);
  if (!source.length) { for (const m of defs) out[m.name] = { samples: [], hadSourceChange: false }; return out; } // a "win" with zero source edits = goalposts moved
  const wt = mkdtempSync(join(tmpBase(repo), tmpPrefix(repo, 'promptwheel-src')));
  addWorktree(repo, wt, base);
  try {
    const env = bridgeEnv(repo, wt, cfg);
    // --binary so a binary source file (an image, a model blob under src/) travels in the patch; without
    // it git prints "Binary files differ", the apply fails, and a win the source never earned would
    // read as unprovable. Untrimmed: a binary hunk ends in a blank line the apply needs.
    const patch = execFileSync('git', ['diff', '--binary', ...PATCH_FLAGS, base, head, '--', ...source], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
// `band` is the noise band the full change was judged by (declared, or measured across the repeats). The second
// reading is one more roll of the same scorer, so the same band reads it: a part of the gain that did not survive and is
// no wider than the band cannot be told from the wobble, and is not called gamed. Then one of two things is so. The
// source alone moved the number past the band: the win stands. Or it did not: the second reading is inside the band of
// both ends, so nothing is shown either way, and gate() does not count the metric as a win (`inBand`). Before this an
// honest win beside an edited test read gamed whenever the re-run rolled low (lead S22 of the framework session,
// 2026-11-21). With no band (one run a side, none declared) the number is taken to hold still, as before.
function judgeGaming(m, srcResult, threshold = 0.5, band = 0) {
  if (!srcResult.hadSourceChange) return { gamed: true, sourceOnly: null, retained: 0, reason: 'the "win" changed zero production-source files, only test/config/grader/golden' };
  // the win could not be re-proven at all: never a pass. gate() turns `unprovable` into INCONCLUSIVE.
  if (srcResult.applyFailed) return { gamed: null, unprovable: true, sourceOnly: null, retained: null, reason: 'the source-only patch could not be applied, so the win cannot be re-proven from the source: inconclusive' };
  const sourceOnly = median(srcResult.samples);
  const full = gain(m, m.before, m.after);
  if (full == null || full <= 0) return { gamed: false, sourceOnly, retained: 1, reason: 'no real improvement to re-prove' };
  const kept = gain(m, m.before, sourceOnly);
  const retained = +(kept / full).toFixed(3);
  if (retained < threshold && band > 0 && kept != null && full - kept <= band) {
    const lost = +(full - kept).toFixed(6);
    if (kept > band) return { gamed: false, sourceOnly, retained, reason: `${(retained * 100).toFixed(0)}% of the gain survives source-only, and the part that did not (${lost}) is inside the noise band (${band}): the source earned it` };
    return { gamed: false, inBand: true, sourceOnly, retained, reason: `the source-only reading (${sourceOnly}) is inside the noise band (${band}) of both the base and the full change: the win is not shown to be earned by the source, and not shown to be gamed` };
  }
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
  const idxDir = mkdtempSync(join(tmpBase(repo), tmpPrefix(repo, 'pw-idx')));
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
    const tmp = tmpBase(repo), now = Date.now(), mine = tmpOwnerTag(repo);
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
const GATE_SCALARS = ['gamingThreshold', 'evaluatorPaths', 'allowTrailer', 'allowFromAuthor', 'setup', 'env', 'linkDirs', 'linkNodeModules'];
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
    const byName = new Map(); const mandatesByName = new Map(); const scalars = {}; let inheritedRepeat;
    for (const ext of [].concat(cfg.extends || [])) {
      if (isAbsolute(ext)) { partial = true; continue; }   // outside the repo, cannot git-show; unchanged anyway
      const bp = join(dirname(p), ext).split('\\').join('/');
      const again = seen.has(bp);                    // a diamond: already merged, not a missing piece
      const base = resolve(bp);
      if (!base) { if (!again) partial = true; continue; }
      for (const m of base.metrics.values()) byName.set(m.name, m);
      for (const md of base.scalars.mandates) mandatesByName.set(md.name, md);
      for (const k of GATE_SCALARS) if (base.scalars[k] !== undefined) scalars[k] = base.scalars[k];
      if (typeof base.repeat === 'number') inheritedRepeat = base.repeat;
    }
    for (const m of (cfg.metrics || [])) if (m && m.name) byName.set(m.name, m);
    for (const md of (cfg.mandates || [])) if (md && md.name) mandatesByName.set(md.name, md);
    for (const k of GATE_SCALARS) if (cfg[k] !== undefined) scalars[k] = cfg[k];
    scalars.mandates = [...mandatesByName.values()];
    // how many readings a side the contract asks for. Kept beside the scalars, not among them: it is not compared, it is used
    const repeat = typeof cfg.repeat === 'number' ? cfg.repeat : inheritedRepeat;
    return { metrics: byName, scalars, repeat };
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
// `report`: true = its regression is a note; 'no-win' = a note only when the change won nothing (see winsNothing); else a guard
const reportMode = (m) => (m.report === true ? true : m.report === 'no-win' ? 'no-win' : false);
const winsNothing = (evaluated) => !evaluated.some((x) => x.status === 'improved' && !x.tripwire);   // a tripwire going up is not a win
// a budget is part of how a guard is judged; it is added to the signature only where there is one, so a gate with none keeps the fingerprint it had
const budgetSig = (m) => (m.budget && typeof m.budget === 'object' ? [[m.budget.gain ?? null, Number(m.budget.base) || 0, Number(m.budget.rate) || 0]] : []);
// so is a declared noise band, on the same terms: a gate with none keeps the fingerprint it had
const noiseSig = (m) => (declaredNoise(m) != null ? [{ noise: m.noise }] : []);
const measuredBy = (m) => JSON.stringify([m.cmd ?? null, m.extract ?? 'number', m.direction || 'up', m.exact === true, reportMode(m), ...budgetSig(m), ...noiseSig(m)]);
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
    // who may let a pull request through is part of the gate. Only `true` is written, so a contract without the
    // key keeps the fingerprint it had before 0.8.10.
    ...(scalars.allowFromAuthor === true ? { allowFromAuthor: true } : {}),
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
  try { changed = gitNames(['diff', '--name-only', '--no-renames', base, head], repo).filter(isEval); }
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
    else if (bm.report !== true && bm.cmd !== PLACEHOLDER_TEST && measuredBy(hm) !== measuredBy(bm)) weak.push({ name: bm.name, change: 'guard-edited', def: bm });
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
// One reason, one thing: when a reason can reach more than one, it lets through only what it names.
// A reason names a thing when the thing's name stands in it as a whole word, in any case (`mandate:` is optional).
// The checks that are about the tests themselves are ONE thing to a reason: deleting a test moves the green, the count
// of tests and the count of assertions in one act, and a person who accepts that act has accepted all three.
const TEST_KIND = new Set(['tests_pass', 'test_count', 'skipped_tests', 'assertions']);
const kindOf = (label) => (TEST_KIND.has(label) ? 'the tests' : label);
const kindsIn = (labels) => new Set([...labels].map(kindOf)).size;
const reasonNames = (reason, label) => new RegExp(`(^|[^A-Za-z0-9_-])${label.replace(/^mandate:/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`, 'i').test(reason);
// A reason written in a commit. Every commit of the change is read (base..head), not the last one alone: a fix run
// that adds a commit must not lose the reason an earlier commit of the same change gave. With no base, the head commit.
function readAllowTrailer(repo, ref, base) {
  const log = (args) => { try { return execFileSync('git', ['log', '--no-show-signature', '--format=%B', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  const msg = (base && log([`${base}..${ref}`])) || log(['-1', ref]);
  const found = [...msg.matchAll(/^[ \t]*(?:Promptwheel-Allow|Sawbuck-Allow)[ \t]*:[ \t]*(\S.*?)[ \t]*$/gim)].map((m) => m[1].trim()).filter(Boolean);
  return found.length ? { reason: [...new Set(found)].join(' | ').slice(0, 300) } : null;
}

// ---- A change, read from the files it touched alone ---------------------------------------------------------------
// A counting tripwire is a grep that prints every match, counted. Such a count is a sum over files, so the files a
// change did not touch add the same number at both ends and cancel out. The reader writes only the touched files, as
// they stood at each end, into two small folders, and runs the contract's OWN command there, counted by file: the same
// patterns and the same file rules (--include, --exclude-dir) as the whole-tree count, so a contract signed with
// older patterns is read with those. No commit is checked out, and no pattern is ported to another regex dialect.
// Until 0.8.15 "where did it fall" checked out both commits again and counted the whole tree by file (3 to 22 seconds
// on real pull requests). Held against the whole-tree counts on every pair of commits in proof-bench/outside-repos
// (diffcount/RESULT.md). The verdict's own totals stay the whole-tree counts a contract was signed with.
// A pull request's tree is a stranger's data: a path that would land outside the folder is not written (a tree can be
// made by hand to hold ".."), a symlink is not written (grep -r follows none) and a submodule entry has no file.
const TRIP_TAIL = /\|\s*wc -l\s*\|\s*tr -d " "\s*$/;
const isTripwire = (def) => !!def && typeof def.cmd === 'string' && /^grep -rIoE /.test(def.cmd) && TRIP_TAIL.test(def.cmd);
const safeRel = (p) => !!p && !isAbsolute(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..') && !(sep === '\\' && /[\\:]/.test(p));
// The file endings a set of commands can read at all, when every --include they hold is the plain "*.ext" kind: then a
// change that adds a large binary writes none of it. Any other kind of --include, or a command with none: no filter.
function readableEndings(defs) {
  const ends = new Set();
  for (const d of defs) {
    const inc = d.cmd.match(/--include=\S+/g) || [];
    if (!inc.length) return null;
    for (const i of inc) { const m = /^--include="?\*(\.[A-Za-z0-9_+-]+)"?$/.exec(i); if (!m) return null; ends.add(m[1]); }
  }
  return [...ends];
}
// Blobs out of the object store, each to every path that needs it. Sizes are asked first: a small blob comes in a
// batch, a large one is streamed straight to its file and never held in memory. Throws when an object is not here.
const BLOB_STREAMED = 8 * 1024 * 1024, BLOB_BATCH = 48 * 1024 * 1024;
function writeBlobs(repo, targets) {
  const shas = [...targets.keys()];
  if (!shas.length) return;
  const put = (sha, buf) => { for (const to of targets.get(sha)) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, buf); } };
  const sized = execFileSync('git', ['cat-file', '--batch-check'], { cwd: repo, input: shas.join('\n') + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean).map((l) => l.split(' '));
  if (sized.length !== shas.length) throw new Error('git answered for fewer objects than were asked');
  let batch = [], held = 0;
  const flush = () => {
    if (!batch.length) return;
    const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: repo, input: batch.join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 2 * BLOB_BATCH + BLOB_STREAMED });
    let at = 0;
    for (const sha of batch) {
      const nl = buf.indexOf(10, at); if (nl < 0) throw new Error('git stopped before every object was read');
      const [name, type, size] = buf.toString('latin1', at, nl).split(' ');
      if (name !== sha || type !== 'blob' || !/^\d+$/.test(size)) throw new Error(`object ${sha} is not a file here`);
      put(sha, buf.subarray(nl + 1, nl + 1 + Number(size))); at = nl + 1 + Number(size) + 1;
    }
    batch = []; held = 0;
  };
  sized.forEach(([name, type, size], i) => {
    const sha = shas[i];
    if (name !== sha || type !== 'blob' || !/^\d+$/.test(size)) throw new Error(`object ${sha} is not a file here`);
    if (Number(size) > BLOB_STREAMED) {
      const [first, ...rest] = targets.get(sha);
      mkdirSync(dirname(first), { recursive: true });
      const fd = openSync(first, 'w');
      try { execFileSync('git', ['cat-file', 'blob', sha], { cwd: repo, stdio: ['ignore', fd, 'ignore'] }); } finally { closeSync(fd); }
      for (const to of rest) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(first, to); }
    } else { batch.push(sha); held += Number(size); if (held >= BLOB_BATCH) flush(); }
  });
  flush();
}
// the contract's own command, counted by file instead of in all: { file: count }
const countByFile = (dir, def, env) => {
  const out = execSync(def.cmd.replace(TRIP_TAIL, '| cut -d: -f1 | sort | uniq -c'), { cwd: dir, env: personEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
  return Object.fromEntries(out.split('\n').map((l) => l.match(/^\s*(\d+)\s+(.+)$/)).filter(Boolean).map((x) => [x[2].replace(/^\.\//, ''), +x[1]]));
};
// Map of metric name -> { file: [before, after] } for the tripwires among `defs`, over the files base..head touched.
// null when the change could not be read (an object that is not in this clone, a file system that refuses a name):
// then nothing is said about where, and the verdict is what it was.
function readChange(repo, base, head, defs, cfg = {}) {
  const trip = (defs || []).filter(isTripwire);
  const out = new Map(trip.map((d) => [d.name, {}]));
  if (!trip.length) return out;
  let dir = '';
  try {
    const raw = execFileSync('git', ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', base, head], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 * 1024 }).split('\0');
    const ends = readableEndings(trip), isFile = (mode) => mode === '100644' || mode === '100755';
    const wants = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]/.exec(raw[i]), path = raw[i + 1];
      if (!m || !safeRel(path) || (ends && !ends.some((e) => path.endsWith(e)))) continue;
      if (isFile(m[1])) wants.push(['b', m[3], path]);
      if (isFile(m[2])) wants.push(['a', m[4], path]);
    }
    if (!wants.length) return out;
    dir = mkdtempSync(join(tmpBase(repo), tmpPrefix(repo, 'promptwheel')));
    const side = { b: join(dir, 'b'), a: join(dir, 'a') }; mkdirSync(side.b); mkdirSync(side.a);
    const targets = new Map();
    for (const [at, sha, path] of wants) {
      const to = resolve(side[at], path);
      if (!to.startsWith(side[at] + sep)) continue;   // belt and braces: nothing is written outside its side
      if (!targets.has(sha)) targets.set(sha, []);
      targets.get(sha).push(to);
    }
    writeBlobs(repo, targets);
    const env = cfg.env ? { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)])) } : process.env;
    for (const d of trip) {
      const b = countByFile(side.b, d, env), a = countByFile(side.a, d, env);
      out.set(d.name, Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(a)])].sort().map((f) => [f, [b[f] || 0, a[f] || 0]])));
    }
    return out;
  } catch { return null; } finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* self-heal takes it later */ } } }
}
// Which files a fallen count fell in, for whoever repairs it: the five where it fell furthest.
function fellIn(files, def) {
  const down = def.direction === 'down';
  const worse = Object.entries(files || {}).map(([file, [before, after]]) => ({ file, before, after }))
    .filter((x) => (down ? x.after > x.before : x.after < x.before))
    .sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before) || (x.file < y.file ? -1 : 1));
  return worse.length ? worse.slice(0, 5) : null;
}

// A count that holds for the whole repo can still fall in one file: a test emptied of its assertions while another
// file gains as many. For the two counts that go up (tests, assertions), when the total did NOT fall: the files that
// stood at the base and hold fewer now. A file whose removed lines mostly turn up elsewhere in the same change was
// moved or split, not cut, and is left out. A note for a reader (`lostIn`), never a verdict: an edit that swaps one
// assertion for another in place is not seen by any count. The lines are read with the person's diff settings set
// aside (an external diff tool, forced colour), and where they cannot be read nothing is said.
const PER_FILE = new Set(['test_count', 'assertions']);
function lostInFiles(repo, base, head, files, def, seen = {}) {
  const worse = (fellIn(files, def) || []).filter((w) => w.before > 0);
  if (!worse.length) return null;
  const diff = (args) => execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '-U0', base, head, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 * 1024 }).split('\n');
  const pick = (lines, sign) => lines.filter((l) => l[0] === sign && l[1] !== sign).map((l) => l.slice(1).trim()).filter((l) => l.length >= 12);
  const tally = (lines) => { const t = new Map(); for (const l of lines) t.set(l, (t.get(l) || 0) + 1); return t; };
  try {
    if (!seen.added) seen.added = tally(pick(diff([]), '+'));   // every added line of the change, read once for both counts
    const out = [];
    for (const w of worse) {
      const own = diff(['--', `:(literal)${w.file}`]);
      const gone = pick(own, '-'), back = tally(pick(own, '+'));
      const moved = gone.filter((l) => (seen.added.get(l) || 0) - (back.get(l) || 0) > 0).length;   // it turns up in another file
      if (gone.length && moved * 2 >= gone.length) continue;
      out.push({ file: w.file, before: w.before, after: w.after });
    }
    return out.length ? out : null;
  } catch { return null; }
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
  // runner scripts are read from the guards at both ends, so a change cannot un-name its runner in the commit that edits it
  const guards = { metrics: [...(cfg.metrics || []), ...(baseGate ? [...baseGate.metrics.values()] : [])] };
  const toProve = [];
  for (const m of metrics) {
    if (m.status !== 'improved') continue;
    const cm = cfg.metrics.find((c) => c.name === m.name);
    if (gamingCheckOff(cm, baseGate)) continue;   // tripwire / test-side guards aren't re-proven from source (their gain legitimately lives in test files)
    toProve.push(cm);
  }
  // What this change moved that the source-only re-run does not take from it: every non-source path (a test, a
  // grader, a config, a runner a guard names), a declared evaluator path, and a manifest whose test keys changed.
  // Empty means the source-only tree IS the head tree, so nothing over this span can read gamed. A caller that holds a
  // gamed verdict over a span until it is earned reads this to tell "the test was put back" from "nothing could be
  // measured": both are inconclusive when the suite is red at both ends.
  // a file declared as a goalpost before this change still is one for this change: dropping the declaration in the
  // same diff that edits the file does not make the edit count as source
  const split = changedSourcePaths(repo, base, head, evaluatorMatcher(cfg), guards);
  const declared = [...new Set([...(cfg.evaluatorPaths || []), ...((baseGate && baseGate.scalars.evaluatorPaths) || [])])];
  const evalChanged = changedEvaluatorPaths(repo, base, head, { ...cfg, evaluatorPaths: declared });
  const goalposts = [...new Set([...split.nonSource, ...evalChanged.map((e) => e.path), ...split.source.filter((p) => manifestTestKeysMoved(repo, base, head, p))])].sort();
  // With no goalpost moved, the tree the re-run would build is the head tree, and the head tree was measured a moment
  // ago. Measuring it again says nothing new where the number holds still, and rolls again where it does not: a scorer
  // with jitter (a model-graded eval, a timing) read gamed on 241 of 1,000 runs of a change that edited no test, grader
  // or config (noise-band bench, 2026-11-21). So the head measurement stands as the source-only one, and a scorer that
  // costs money is asked once a side. Not when the change also edits how the gate measures (setup, env, linked dirs):
  // there the re-run measures the base's way, which the head measurement did not.
  const sameTree = goalposts.length === 0 && split.source.length > 0 && !measureChanged;
  const srcResults = sameTree ? {} : measureSourceOnlyAll(repo, base, head, toProve, baseRun, repeat, guards);   // one patched checkout for all of them
  const inBand = [];   // wins the second reading could neither re-prove nor call gamed (judgeGaming): settled below
  for (const cm of toProve) {
    const m = metrics.find((x) => x.name === cm.name);
    const j = sameTree
      ? { gamed: false, sourceOnly: m.after, retained: 1, reason: 'no test, grader or config changed, so the source-only tree is the head tree: the source earned it' }
      : judgeGaming(m, srcResults[cm.name], gamingThresholdFor(cm, cfg, baseGate), typeof m.noise === 'number' && m.noise > 0 ? m.noise : 0);
    m.gamed = j.gamed; m.sourceOnly = j.sourceOnly; m.retained = j.retained; m.gamingReason = j.reason;
    if (j.unprovable) m.unprovable = true;
    if (j.inBand) inBand.push(m);
  }
  // A green that stays green proves nothing about the tests. When a change edits the source and the tests
  // together, run the old tests on the new source: if they fail, say so. Only a note, never a verdict: an
  // intended API change does this too, and no deterministic check can tell the two apart.
  if (split.source.length && split.nonSource.length) {
    const held = metrics.filter((m) => m.status === 'unchanged' && m.direction === 'pass' && m.after === 1 && !m.tripwire);
    const defs = held.map((m) => cfg.metrics.find((c) => c.name === m.name)).filter(Boolean);
    const res = measureSourceOnlyAll(repo, base, head, defs, baseRun, repeat, guards);
    for (const m of held) { const r = res[m.name]; if (r && r.samples && r.samples.length && median(r.samples) !== 1) m.heldByTestEdit = true; }
  }
  if (evalChanged.length) {
    for (const m of metrics) {
      if (m.status !== 'improved' || m.gamed === true) continue;
      const cm = cfg.metrics.find((c) => c.name === m.name);
      if (gamingCheckOff(cm, baseGate)) continue; // tripwire/test-side guards legitimately live in gate files
      m.gamed = true;
      m.gamingReason = `a declared evaluatorPath gate file changed in this diff (${evalChanged.map((e) => e.path).join(', ')}); a win alongside a goalpost edit is gamed by declaration`;
    }
  }
  // After the rule above, so a win beside an edit to a declared goalpost file is gamed by declaration, in the band or
  // not. What is left was not earned past the band by the source: it is not a win (the status a move inside the band
  // has), so a loop keeps nothing for it and a budget is paid by nothing.
  for (const m of inBand) if (m.gamed !== true) { m.status = 'inconclusive'; m.confidence = 'low'; }
  const weak = gateWeakenings(baseGate, cfg.metrics);
  // the setup, env or linked dirs changed: every guard the base had is measured again the way it was measured before
  if (measureChanged) for (const bm of baseGate.metrics.values()) {
    if (bm.guard === true && bm.report !== true && bm.cmd !== PLACEHOLDER_TEST && !weak.some((w) => w.name === bm.name)) weak.push({ name: bm.name, change: 'measurement-edited', def: bm });
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
      const noteByOldRule = w.def.report === 'no-win' && ev.status === 'regressed' && winsNothing(metrics);
      let hidden = (!ev.ok && !noteByOldRule) || (w.change === 'guard-edited' && ev.inert);
      // a guard measured another way counts only when the new measurement hides it: it fails the old way and reads fine the new way
      if (w.change === 'measurement-edited') { const hm = metrics.find((x) => x.name === w.name); hidden = (!ev.ok || !!ev.inert) && !!hm && hm.ok && !hm.inert; }
      if (hidden) weakened.push({ name: w.name, change: w.change, status: ev.inert ? 'failed' : ev.status });
    }
    // a win under the old definition still has to be earned in the source: swapping or renaming the guard in the same
    // change does not skip the source-only re-run
    const won = weak.filter((w) => w.def.gamingCheck !== false && !weakened.some((x) => x.name === w.name) && evs.get(w.name).status === 'improved');
    if (won.length) {
      const src = measureSourceOnlyAll(repo, base, head, won.map((w) => w.def), baseRun, repeat, guards);
      for (const w of won) {
        // read without the band, on purpose: a guard edited in the change that wins on it gets the strict reading
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
    goalposts,
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
// A COST PAID FOR BY A GAIN (0.8.14). A guard is a wall: the metric may not get worse. A loop that runs with no person
// needs a rate as well: this much gain on X buys this much cost on Y, and no more. On a guarded metric,
// `"budget": { "gain": "<metric>", "base": b, "rate": r }` lets a trusted regression through when the named metric has
// a trusted improvement d that the source earned, and the regression's share of its old value is at most
// b + r * |d|. With no such gain the wall stands as before. The rule is the cost rule of Google's RRSI (arXiv
// 2609.24972, Eq. 7: delta C <= beta0 + beta1 * delta S), where an unregularized loop paid 2.4 times the tokens for
// nothing. Pure arithmetic over the measured results; run after the gaming pass, so a gamed gain pays for nothing.
export function applyBudgets(metrics, defs) {
  for (const x of metrics) {
    const def = (defs || []).find((c) => c && c.name === x.name); const b = def && def.budget;
    if (!b || typeof b !== 'object' || !x.guard || x.status !== 'regressed' || x.ok) continue;
    const g = metrics.find((y) => y.name === b.gain); const base = Number(b.base) || 0, rate = Number(b.rate) || 0;
    if (!g || g.status !== 'improved' || g.gamed === true || g.unprovable === true || base < 0 || rate < 0 || !(Math.abs(x.before) > 0)) continue;
    const note = { gain: g.name, share: +(Math.abs(x.after - x.before) / Math.abs(x.before)).toFixed(6), allowed: +(base + rate * Math.abs(g.delta)).toFixed(6) };
    if (note.share <= note.allowed) { x.ok = true; x.paid = note; } else x.overBudget = note;
  }
  return metrics;
}

export function deriveVerdict(metrics, gateInfo = null, mandated = false) {
  const failed = metrics.some((m) => m.guard && !m.ok);
  const gamed = metrics.some((m) => m.gamed === true) || !!(gateInfo && gateInfo.weakened && !gateInfo.allowed);
  const inertNoWin = metrics.some((m) => m.inert) && !metrics.some((m) => m.status === 'improved' && !m.tripwire);   // a tripwire moving is not a measured win
  const unprovable = metrics.some((m) => m.unprovable === true);
  const inconclusive = !failed && !gamed && (inertNoWin || unprovable);
  return (mandated || failed) ? 'fail' : gamed ? 'gamed' : inconclusive ? 'inconclusive' : 'pass';
}

function gate(repo, opts) { ownGitOn(); try { return gateInner(repo, opts); } finally { ownGitOff(); } }
function gateInner(repo, opts) {
  selfHeal(repo);
  const cfg = opts.config ?? loadConfig(repo);

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

  // Judge by the rules as they stood before the change. Fewer readings a side is a wider band, so a change that lowers
  // its own repeat count is measured with the count the base held. A change may raise it, and the flag (the person)
  // decides over both.
  const baseRepeat = opts.config ? undefined : (gateDefAtRef(repo, base) || {}).repeat;
  const repeat = Math.max(1, opts.repeat ?? Math.max(cfg.repeat ?? 1, typeof baseRepeat === 'number' ? baseRepeat : 1));
  const kept = measureBase(repo, base, cfg, repeat, opts.baseCache);
  const before = kept.samples;
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
  // A declared noise band is part of how a metric is judged, so the band in force is the one the gate had before this
  // change: a change cannot widen it to hide a fall, or narrow it to turn a wobble into a win. A band the change adds
  // counts from the next change on. A metric new in this change brings its own band, as it brings its own start.
  const judged = (m) => (baseDefs && baseDefs.metrics.has(m.name) ? { ...m, noise: baseDefs.metrics.get(m.name).noise } : m);
  const metrics = cfg.metrics.map((m) => {
    const ev = evaluate(judged(m), before[m.name], after[m.name], repeat);
    if (ev.status === 'unmeasurable' && ev.before == null && ev.after != null && adopted(m.name)) { ev.ok = true; ev.adopted = true; }
    // a `report` guard tells you and does not fail: a contract can start by watching and tighten later
    if (m.report === true && !ev.ok && ev.status === 'regressed') { ev.ok = true; ev.noted = true; }
    // an inert guard: did its command run and fail, or never run? `ran` says where it ran (absent: at neither ref)
    if (ev.inert && m.cmd !== PLACEHOLDER_TEST) {
      const nb = neverRan(before[m.name]), na = neverRan(after[m.name]);
      if (!nb || !na) ev.ran = !nb && !na ? 'both' : nb ? 'head' : 'base';
      const note = failNotes.get(after[m.name]) || failNotes.get(before[m.name]);   // a hint: a missing dependency or tests that fail
      if (note) Object.assign(ev, note);
    }
    // AN EARLIER STATE THAT COULD NOT BE RUN IS NOT AN EARLIER STATE THAT FAILED. Both commits are measured with what
    // is installed now. A change that removes a tool the earlier tests need (and rewrites the script or the settings
    // that used it) leaves the earlier state unable to start, and the move reads "failing, then passing". The measure
    // says so here: its command failed at the base for want of something not installed, and ran at the head. This is
    // the reading alone (proof-bench/could-not-measure, 2026-11-22). No verdict reads it yet: a change that takes out
    // the test runner looks the same, so what is done with it is settled with that case in hand.
    if (!ev.inert && m.cmd !== PLACEHOLDER_TEST) {
      const nb = failNotes.get(before[m.name]);
      if (nb && nb.cause === 'missing-dependency' && !failNotes.get(after[m.name])) ev.baseUnrun = { cause: nb.cause, detail: nb.detail };
    }
    return { name: m.name, direction: m.direction || 'up', guard: !!m.guard, ...(gamingCheckOff(m, baseGate) ? { tripwire: true } : {}), ...ev };
  });
  // `report: "no-win"`: a count that got worse is a note when the change won nothing, and stays a failure when it arrives
  // beside something that got better. One more lint silencer in ordinary work is a note (17 of 17 on real commits,
  // proof-bench/contract-replay); a silencer that turns a red lint step green is the trade the count exists to catch.
  if (winsNothing(metrics)) for (const x of metrics) {
    const def = cfg.metrics.find((c) => c.name === x.name);
    if (def && def.report === 'no-win' && !x.ok && x.status === 'regressed') { x.ok = true; x.noted = true; }
  }
  // Section 3 (gaming detection), on by default: mutates `metrics` and yields the gate record
  const gateInfo = opts.detectGaming ? detectGamingPass(repo, base, head, cfg, metrics, repeat, baseGate) : null;
  applyBudgets(metrics, cfg.metrics);   // after the gaming pass: a gain the source did not earn pays for nothing
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
  const allow = opts.allow ? { reason: String(opts.allow).slice(0, 300), by: 'flag' } : (opts.working || trailersOff() ? null : readAllowTrailer(repo, head, base));
  // mandates: a protected-path hard rule fails the gate no matter what the metrics say.
  // The base ref's mandates count too (resolved through `extends` by gateDefAtRef), so a change
  // cannot clear a mandate by deleting it in the same diff that violates it.
  const baseMandates = (gateInfo && gateInfo.baseMandates) || (!opts.detectGaming ? ((gateDefAtRef(repo, base) || {}).scalars || {}).mandates : null);
  let mandateViolations = checkMandates(repo, base, head, cfg, baseMandates);
  // What a declared reason can let through in this run, each with the name a reason calls it by:
  // - a gamed or unprovable win and a weakened gate ("gate"), by the flag or a trailer;
  // - a guarded metric marked `allowable` (the supply-chain counters: a new dependency or lifecycle script is
  //   sometimes the job), so the change passes with the reason on the record instead of the guard being loosened.
  //   `allowable: 'flag'` takes the reason from the --allow flag only, never from a commit trailer: an agent can
  //   write a trailer, so a guard meant to stop a compromised agent cannot be cleared by one;
  // - an allowable mandate (the lock file, the contract, the hooks), by the flag only.
  // Never implicit: without a reason each of these fails as usual, and the reason is recorded.
  const mode = new Map((cfg.metrics || []).filter((c) => c && c.allowable && c.name).map((c) => [c.name, c.allowable]));
  const gm = opts.detectGaming ? metrics.filter((m) => m.gamed === true) : [];
  const up = opts.detectGaming ? metrics.filter((m) => m.unprovable === true) : [];
  const gw = !!(opts.detectGaming && gateInfo && gateInfo.weakened);
  const guards = metrics.filter((m) => m.guard && !m.ok && mode.has(m.name));
  const soft = mandateViolations.filter((v) => v.allowable);
  const allowable = [...new Set([...[...gm, ...up].map((m) => m.name), ...(gw ? ['gate'] : []), ...guards.map((m) => m.name), ...soft.map((v) => `mandate:${v.name}`)])];
  let allowed = null;
  if (allow) {
    const byFlag = allow.by === 'flag';
    // what THIS reason can reach: a trailer reaches less than the flag, and what it cannot reach does not count
    const reach = new Set([...[...gm, ...up].map((m) => m.name), ...(gw ? ['gate'] : []), ...guards.filter((m) => byFlag || mode.get(m.name) === true).map((m) => m.name), ...(byFlag ? soft.map((v) => `mandate:${v.name}`) : [])]);
    // One thing needs no name. More than one: the reason lets through only what it names, so a reason written
    // about a config change does not also wave through a gamed test the person never looked at. The checks on the
    // tests themselves count as one thing (TEST_KIND): naming any of them names them all.
    const named = (label) => reasonNames(allow.reason, label) || (TEST_KIND.has(label) && [...TEST_KIND].some((n) => reasonNames(allow.reason, n)));
    const takes = (label) => reach.has(label) && (kindsIn(reach) < 2 || named(label));
    const cleared = new Set();
    for (const m of gm) if (takes(m.name)) { m.gamed = false; m.allowed = true; cleared.add(m.name); }
    for (const m of up) if (takes(m.name)) { m.unprovable = false; m.allowed = true; cleared.add(m.name); }
    if (gw && takes('gate')) { gateInfo.allowed = true; cleared.add('gate'); }
    for (const m of guards) if (takes(m.name)) { m.ok = true; m.allowed = true; cleared.add(m.name); }
    const lifted = soft.filter((v) => takes(`mandate:${v.name}`));
    for (const v of lifted) cleared.add(`mandate:${v.name}`);
    mandateViolations = mandateViolations.filter((v) => !lifted.includes(v));
    if (reach.size) allowed = { reason: allow.reason, cleared: [...cleared] };
  }
  for (const m of guards) if (!m.allowed) m.allowable = true;   // failed, and a declared reason would clear it: say so in the report
  // for whoever repairs it, a person or a fix run: which files a fallen count fell in, and whether a reason in a commit is taken
  // both from the files the change touched alone (readChange): no commit is checked out a second time
  if (!opts.working) {
    const defOf = (name) => (cfg.metrics || []).find((c) => c && c.name === name);
    const fell = guards.filter((m) => !m.allowed && m.status === 'regressed');
    const held = metrics.filter((m) => PER_FILE.has(m.name) && m.guard && m.status !== 'regressed');
    const defs = [...fell, ...held].map((m) => defOf(m.name)).filter(isTripwire);
    const change = defs.length ? readChange(repo, base, head, defs, cfg) : null;
    const seen = {};
    if (change) for (const m of fell) { const w = change.has(m.name) && fellIn(change.get(m.name), defOf(m.name)); if (w) m.where = w; }
    if (change) for (const m of held) { const w = change.has(m.name) && lostInFiles(repo, base, head, change.get(m.name), defOf(m.name), seen); if (w) m.lostIn = w; }
  }
  // tests an earlier commit of this change added, all gone at its head (testsTakenOut): a note, never part of the verdict
  const takenOut = opts.working ? null : testsTakenOut(repo, changeSteps(repo, base, head));
  const byCommit = opts.working || trailersOff() ? [] : guards.filter((m) => !m.allowed && mode.get(m.name) === true).map((m) => m.name);
  const mandated = mandateViolations.length > 0;
  const verdict = deriveVerdict(metrics, gateInfo, mandated);
  // what was measured in words, and one thing no diff shows: a variable in this environment that can change which
  // tests run (environmentNote). A variable the contract's own `env` sets is declared there and not noted.
  const envNote = environmentNote(process.env, cfg.env);
  const explained = [...(explainMetrics(repo, metrics) || []), ...(envNote ? [envNote] : [])];
  const report = {
    ...(explained.length ? { explained } : {}),
    base: short(repo, base), head: short(repo, head), repeat, mode: opts.working ? 'working' : 'refs',
    // the base's numbers were kept from an earlier run (--base-cache), not measured in this one: when they were measured
    ...(kept.at ? { baseMeasured: kept.at } : {}),
    verdict, metrics,
    ...(mandateViolations.length ? { mandates: mandateViolations } : {}),
    ...(gateInfo ? { gate: gateInfo } : {}),
    ...(allowed ? { allowed } : {}),
    ...(allowable.length ? { allowable } : {}),
    ...(byCommit.length ? { byCommit } : {}),
    ...(takenOut ? { testsTakenOut: takenOut } : {}),
    ...(Array.isArray(cfg.mandates) && cfg.mandates.length ? { protects: cfg.mandates.length } : {}),
    // a repo with one person in it: the contract at the base says the account that opened a pull request may let it
    // through, so the words about who can accept a change say that (read at the base, like pr-allow does)
    ...(((gateDefAtRef(repo, base) || {}).scalars || {}).allowFromAuthor === true ? { openerCounts: true } : {}),
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
  const report = gate(repo, { base: args.base, head: args.head, working: args.working, repeat: args.repeat, detectGaming: args.detectGaming, allow: args.allow, config, baseCache: args.baseCache });
  // one short row in the record (the git folder, never the tree), unless --no-record. The report is not changed by it.
  if (!args.noRecord) recordRun(repo, report, config ?? loadConfig(repo), { label: args.label });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (args.markdown) console.log(renderMarkdown(report));
  else printHuman(report);
  // The code is set and the process ends by itself, so everything printed is written first. Until 0.8.15 this line was
  // process.exit(): Node writes to a pipe in the background and an exit drops what the pipe has not taken yet, so a
  // report larger than a pipe holds arrived cut, with the verdict's exit code (at 146,176 bytes when the reader was
  // quick, at 65,536 when it was slow). The report lists every test and config file a change touches.
  process.exitCode = verdictExitCode(report.verdict);
}

// ---------------------------------------------------------------------------
// The wheel: the record of every checked run, `improve` (keep a change only if a measure improved), and the views over
// the record. Built in June and July 2026, removed in November (0.7.5 and 0.8.0) for a smaller surface with no
// measurement behind either cut, and put back. What holds from the first build:
//   - ONE STORE. The record is append-only, and every view is worked out from it on each read. Nothing else is kept.
//   - EVIDENCE FIRST. A key earns a line only past MIN_MOVED weighted runs in which it moved. Below that it is counted.
//   - THE CLAIM WAITS. No page says the loop gets better with use until bench/compounding-ab.mjs shows the arm that is
//     given the playbook beating the arm that is not, on real use (docs/LEARNING.md).
// What changed on the way back: the row is short, the record lives in the git folder that worktrees share, no command
// line is kept, a count of tests going up is not a win, an attempt that commits is still checked as one change, and a
// thrown-away attempt says why.
// The record never changes a verdict: anything that can write to the repo can write to it, so it is read as a hint.
// ---------------------------------------------------------------------------
const HALF_LIFE = 20;   // runs: a row counts half as much every HALF_LIFE runs after it
const MIN_MOVED = 3;    // weighted runs in which a key moved, before it earns a line
const EXPLORE_C = 1.0;  // how much the least tried arm is favoured (UCB)
const STALL_W = 3;      // attempts in a row with nothing kept: the search has stalled (the window RRSI uses in all three of its domains)

// the record's file: in the git folder, the one every worktree of the repo shares. Not in the working tree: it is the
// loop's own state and not part of a change, so no attempt's `git add -A` takes it in and no `git clean` removes it.
function recordFile(repo) {
  const c = git(['rev-parse', '--git-common-dir'], repo);
  return join(isAbsolute(c) ? c : join(repo, c), 'promptwheel', 'outcomes.jsonl');
}
// rows, oldest first. A record written before 0.8.0 lived in the working tree: it is read first where it still is,
// and never written again. A line that is not a row (cut, or not JSON) is skipped.
function readRecord(repo) {
  const rows = [];
  for (const f of [join(repo, '.promptwheel', 'outcomes.jsonl'), recordFile(repo)]) {
    let text = ''; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l) continue;
      try { const r = JSON.parse(l); if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r); } catch { /* skipped */ }
    }
  }
  return rows;
}
// A run over several turns writes a row a turn and then its own row. Every count over the record is over runs: a
// number that rose across three turns is one improvement, not three. The turn rows are the path of their run.
const runRows = (rows) => rows.filter((r) => typeof r.turn !== 'number');

// a name or a label as one short line: a row can be written by anything that can write to the repo, and a view of
// the record may be handed to an agent
const oneLine = (s, n) => String(s).replace(/[\u0000-\u001f\u007f`*<>[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// where a change landed: the top folders of the source files it touched, most files first, three at most. Read from
// the names alone (no file is opened), so a row costs one `git diff --name-only` on top of the check.
function subsystemsOf(names, cfg) {
  const isEval = evaluatorMatcher(cfg), counts = {};
  for (const p of names) {
    if (isNonSource(p) || isEval(p)) continue;
    const d = p.includes('/') ? p.slice(0, p.indexOf('/')) : '(root)';
    counts[d] = (counts[d] || 0) + 1;
  }
  return Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([d]) => d);
}

// One short row for one checked run: what was measured and where the change landed. Nothing a person typed is in
// it; a label is there only when --label gave one. Under 4 KB, written with one append, so two runs at once (two
// worktrees) do not cut each other's row. It never fails a check.
const ROW_MAX = 3800;
function recordRun(repo, report, cfg, extra = {}) {
  try {
    const p = report.provenance || {};
    const base = p.baseSha || report.base, head = p.headSha || report.head;
    let names = []; try { names = gitNames(['diff', '--name-only', '--no-renames', base, head], repo); } catch { /* a ref that is gone */ }
    const row = {
      ts: new Date().toISOString(), base: report.base, head: report.head, mode: report.mode, verdict: report.verdict,
      cohort: extra.cohort ?? (process.env.CI ? 'ci' : 'local'),
      ...(extra.label ? { label: oneLine(extra.label, 80) } : {}),
      files: names.length, subsystems: subsystemsOf(names, cfg),
      metrics: (report.metrics || []).map((m) => ({ name: oneLine(m.name, 60), guard: !!m.guard, ...(m.tripwire ? { tripwire: true } : {}), before: m.before ?? null, after: m.after ?? null, delta: m.delta ?? null, status: m.status })),
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.because && extra.because.length ? { because: extra.because.slice(0, 10).map((x) => oneLine(x, 60)) } : {}),
      ...(extra.commit ? { commit: extra.commit } : {}),
      ...(extra.goal && extra.goal.length ? { goal: extra.goal.slice(0, 5).map((x) => oneLine(x, 60)) } : {}),
      // a run over several turns: one row a turn (turn, how it stood against the start), then the run's own row
      ...(extra.episode ? { episode: extra.episode } : {}),
      ...(typeof extra.turn === 'number' ? { turn: extra.turn, standing: extra.standing } : {}),
      ...(typeof extra.turns === 'number' ? { turns: extra.turns, best: extra.best } : {}),
      ...(extra.restored && extra.restored.length ? { restored: extra.restored.slice(0, 4).map((x) => oneLine(x, 40)) } : {}),
    };
    let line = JSON.stringify(row);
    if (line.length > ROW_MAX) { row.metrics = row.metrics.filter((m) => m.status !== 'unchanged'); row.cut = true; line = JSON.stringify(row); }
    if (line.length > ROW_MAX) { row.metrics = row.metrics.slice(0, 12); line = JSON.stringify(row); }
    if (line.length > ROW_MAX) return;
    const f = recordFile(repo);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, line + '\n');
  } catch { /* the record must never break a check */ }
}

// a count that can go up with nothing earned: the source-only re-run leaves it alone (its gain lives in test files)
// and more of it is the good direction. Tests and assertions are the two the presets hold.
const freeCount = (m) => (m.tripwire === true || m.gamingCheck === false) && (m.direction || 'up') === 'up';

// `promptwheel improve` runs the loop's one keeper: examples/improve-loop/improve.mjs, beside this engine and in the
// same package. One keeper, by the owner's decision of 2026-11-21: the step outside the engine, which asks the engine
// as a separate process, so what is judged never runs inside what judges it. There had been three (that step, a copy
// of it in treegate, and a keeper inside this file); this command is now a door onto the one. The step's flags are
// its own and it refuses one it does not know, its output and exit code are this command's, and `--goal <measure>`
// is another name for its `--target`.
// Two more doors onto the programs that ship beside the step (the owner's word, 2026-11-22: "yes make it promptwheel's
// loop"): `--plan <file>` is a run of many tries under a plan committed first (run.mjs), and `--report` is every try
// on the loop's record and whether the record, the kept changes and the runs' account agree (report.mjs).
function improve(argv) {
  const step = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'improve-loop', 'improve.mjs');
  if (argv.includes('--plan') && argv.includes('--report')) bad('promptwheel improve: --plan starts a run and --report reads the record: give one of them');
  const other = argv.includes('--report') ? 'report.mjs' : argv.includes('--plan') ? 'run.mjs' : null;
  const program = other ? join(dirname(step), other) : step;   // the run and the report ship in the step's folder
  if (!existsSync(program)) bad(`promptwheel improve: the loop ${other ? `program ${other}` : 'step'} is not where it ships (${program})`);
  const args = [];
  if (other) { for (const a of argv) if (a !== '--report') args.push(a); }
  else { for (let i = 0; i < argv.length; i++) args.push(argv[i] === '--goal' ? '--target' : argv[i]); args.push(...targetOf(args)); }
  // the person's environment, and no PROMPTWHEEL: the step (and a run, through the step) asks the engine it ships with, this one
  const env = personEnv(process.env); delete env.PROMPTWHEEL;
  // Ctrl-C reaches the step and this door together. The step puts the attempt back; the door waits for it.
  process.on('SIGINT', () => {});
  const r = spawnSync(process.execPath, [program, ...args], { stdio: 'inherit', env });
  if (r.error) bad(`promptwheel improve: could not start the loop ${other ? `program ${other}` : 'step'} (${r.error.message})`);
  process.exitCode = r.status ?? (r.signal ? 130 : 1);
}

// The target, when none is named (the owner's word, 2026-11-21: "let the door pick the only measure"). A contract is a
// target and its tripwires: `promptwheel init` writes the test run and four counts of the tests themselves, and those
// counts guard (they can rise with nothing earned, so the gaming check leaves them alone) but are never what a run is
// for. So the door names the contract's only measure, or else its only measure that is not a tripwire; with no config
// file that is the test run the engine finds. A measure named `score` is the step's own default and is left to it.
// Any other contract is refused here, before the attempt spends anything, with the names to choose from: the step
// would only find out after it. So is a contract that cannot be read, with the words the gate would give after it.
// Outside a repository nothing is added, and the step says so in its own words.
function targetOf(args) {
  if (args.some((a) => a === '--target' || a === '--help' || a === '-h')) return [];
  let repo; try { repo = repoRoot(process.cwd()); } catch { return []; }
  const named = (hasConfigFile(repo) ? loadConfig(repo) : autoConfig(repo)).metrics.filter((m) => m && typeof m.name === 'string');
  if (named.some((m) => m.name === 'score')) return [];
  const aims = named.length === 1 ? named : named.filter((m) => m.gamingCheck !== false);
  if (aims.length === 1) return ['--target', aims[0].name];
  const what = aims.length ? `the contract has ${aims.length} measures a run could be for${named.length > aims.length ? ' (tripwires aside)' : ''}` : `the contract's ${named.length} measures are all tripwires`;
  bad(`improve: ${what} and none is named score, so name the one this run is for: --target <${(aims.length ? aims : named).map((m) => m.name).join(' | ')}>`);
}

// The loop's record: one line a try, written by the keeper in the repo's git folder (.git/improve/attempts.jsonl),
// in its own words. The views read it for what was kept and what was thrown away; the gate's own record (a row for
// every check, the step's asks among them) is what they count measures from. A line of a turn (result `turn`)
// belongs to the run whose line comes after it.
const KEEPER_THROWN = new Set(['worse', 'gamed', 'unsure', 'flat', 'nothing', 'rewrote', 'outside', 'contract']);
function keeperRows(repo) {
  let text = ''; try { text = readFileSync(join(git(['rev-parse', '--absolute-git-dir'], repo), 'improve', 'attempts.jsonl'), 'utf8'); } catch { return []; }
  let cfg = {}; try { cfg = loadConfig(repo); } catch { /* the folders still read without one */ }
  const rows = [];
  for (const l of text.split('\n')) {
    let x = null; try { x = JSON.parse(l); } catch { continue; }
    if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.result !== 'string') continue;
    const files = Array.isArray(x.files) ? x.files.filter((f) => typeof f === 'string') : [];
    rows.push({ ts: typeof x.at === 'string' ? x.at : null, result: oneLine(x.result, 20), why: typeof x.why === 'string' ? oneLine(x.why, 300) : '',
      ...(typeof x.label === 'string' && x.label ? { label: oneLine(x.label, 80) } : {}), ...(typeof x.target === 'string' ? { target: oneLine(x.target, 60) } : {}),
      files: files.length, subsystems: subsystemsOf(files, cfg), metrics: Array.isArray(x.metrics) ? x.metrics.filter((m) => m && typeof m === 'object' && typeof m.name === 'string') : [],
      ...(typeof x.episode === 'string' ? { episode: oneLine(x.episode, 40) } : {}), ...(typeof x.turn === 'number' ? { turn: x.turn, standing: typeof x.standing === 'string' ? x.standing : '' } : {}),
      ...(typeof x.turns === 'number' ? { turns: x.turns, best: typeof x.best === 'number' ? x.best : 0 } : {}) });
  }
  return rows;
}
const keeperRuns = (rows) => rows.filter((r) => r.result !== 'turn');

// how reliably each measure responds, straight from the record. No model.
function insights(argv) {
  const args = parseArgs(argv);
  const repo = repoRoot(process.cwd());
  const runs = runRows(readRecord(repo)), keeper = keeperRows(repo);
  if (!runs.length && !keeper.length) bad('promptwheel insights: no record yet. Run the check a few times first (promptwheel run, or promptwheel backfill for past commits)');
  const agg = {};
  for (const r of runs) for (const m of (Array.isArray(r.metrics) ? r.metrics : [])) {
    if (!m || typeof m.name !== 'string') continue;
    const a = agg[m.name] ??= { runs: 0, improved: 0, regressed: 0, inconclusive: 0, unchanged: 0, net: 0, last: null };
    a.runs++; if (typeof a[m.status] === 'number' && m.status !== 'runs' && m.status !== 'net') a[m.status]++;
    if (typeof m.delta === 'number') a.net = +(a.net + m.delta).toFixed(6);
    a.last = m.after ?? null;
  }
  // "lever" = how often a run made this measure better
  const rows = Object.entries(agg).map(([name, a]) => ({ name, ...a, lever: a.runs ? a.improved / a.runs : 0 })).sort((x, y) => y.lever - x.lever);
  const attempts = keeperRuns(keeper);   // the tries of the loop, from the keeper's own record
  const kept = attempts.filter((r) => r.result === 'kept').length;
  // runs judged over several turns: how many, how many kept, and at which turn the best sat (the depth)
  const over = attempts.filter((r) => typeof r.turns === 'number');
  const overTurns = over.length ? { runs: over.length, kept: over.filter((r) => r.result === 'kept').length, bestTurns: over.filter((r) => r.result === 'kept' && typeof r.best === 'number').map((r) => r.best) } : null;
  if (args.json) { console.log(JSON.stringify({ runs: runs.length, attempts: attempts.length, kept, ...(overTurns ? { overTurns } : {}), metrics: rows }, null, 2)); return; }
  console.log(`\nPromptWheel insights, ${runs.length} checked runs in the record${attempts.length ? ` (${attempts.length} attempts of the loop, ${kept} kept)` : ''}\n`);
  console.log(`  ${'measure'.padEnd(26)} ${'runs'.padStart(5)} ${'up'.padStart(5)} ${'worse'.padStart(5)} ${'unsure'.padStart(6)} ${'net'.padStart(9)}  lever`);
  for (const r of rows) console.log(`  ${oneLine(r.name, 26).padEnd(26)} ${String(r.runs).padStart(5)} ${String(r.improved).padStart(5)} ${String(r.regressed).padStart(5)} ${String(r.inconclusive).padStart(6)} ${String(r.net).padStart(9)}  ${(r.lever * 100).toFixed(0)}%`);
  console.log('\n  lever = runs that made the measure better, out of all runs. It says where a change has paid here before.');
  if (overTurns) console.log(`  Over several turns: ${overTurns.runs} run${overTurns.runs === 1 ? '' : 's'}, ${overTurns.kept} kept${overTurns.bestTurns.length ? `; the best turn was turn ${overTurns.bestTurns.join(', ')}` : ''}. See promptwheel playbook for each run's path.`);
  console.log('');
}

// fold the record into decayed counts for each key. Keys: `metric` · `metric @ folder` · `metric # label`
function foldOutcomes(runs) {
  const keys = new Map();
  const N = runs.length;
  runs.forEach((r, idx) => {
    const w = Math.pow(0.5, (N - 1 - idx) / HALF_LIFE);   // the newest row weighs 1
    for (const m of (Array.isArray(r && r.metrics) ? r.metrics : [])) {
      if (!m || typeof m.name !== 'string') continue;
      const name = oneLine(m.name, 60);
      const tags = [name];
      for (const s of (Array.isArray(r.subsystems) ? r.subsystems : [])) if (typeof s === 'string') tags.push(`${name} @ ${oneLine(s, 60)}`);
      if (typeof r.label === 'string' && r.label) tags.push(`${name} # ${oneLine(r.label, 80)}`);
      for (const key of tags) {
        const k = keys.get(key) ?? { key, metric: name, w: 0, n: 0, imp: 0, reg: 0, moved: 0, effects: [], cohorts: {}, last: null };
        k.n += 1; k.w += w;
        const coh = (k.cohorts[typeof r.cohort === 'string' ? oneLine(r.cohort, 20) : 'unknown'] ??= { imp: 0, reg: 0 });
        if (m.status === 'improved') {
          k.imp += w; k.moved += w; coh.imp += 1;
          if (typeof m.delta === 'number' && m.delta !== 0) k.effects.push(Math.abs(m.delta));
        } else if (m.status === 'regressed') { k.reg += w; k.moved += w; coh.reg += 1; }
        k.last = typeof r.ts === 'string' ? r.ts : k.last;
        keys.set(key, k);
      }
    }
  });
  return [...keys.values()];
}

const betaMean = (imp, reg) => (1 + imp) / (2 + imp + reg);   // how often it helped, pulled toward a half while there is little to go on

// lever = how often it helped × how often it moved; the UCB score adds a bonus that shrinks as a key is tried more
function scoreKey(k, totalW) {
  const p = betaMean(k.imp, k.reg);
  const move = k.w ? k.moved / k.w : 0;
  const lever = p * move;
  const ucb = lever + EXPLORE_C * Math.sqrt(Math.log(Math.max(Math.E, totalW)) / Math.max(1e-6, k.w));
  return { p: +p.toFixed(3), move: +move.toFixed(3), lever: +lever.toFixed(3), ucb: +ucb.toFixed(3), effect: +(median(k.effects) ?? 0).toFixed(6) };
}

// where the same key went one way on one kind of run and the other way on another, it is said, never averaged away
function cohortNote(k) {
  const cs = Object.entries(k.cohorts).filter(([, c]) => c.imp + c.reg > 0);
  if (cs.length < 2) return '';
  const signs = new Set(cs.map(([, c]) => Math.sign(c.imp - c.reg)));
  return signs.size > 1 ? ` · ⚠ differs by where it ran (${cs.map(([n]) => n).join(' against ')})` : '';
}

// The contract as it is now. A view offers no arm for a measure that is gone from it, for a count that can go up
// for free, or for a pass/fail guard that already passes (there is nothing to gain there). Found on the first real
// record the views met, and in the first run with a real agent.
function contractNow(repo) {
  try {
    const cfg = hasConfigFile(repo) ? loadConfig(repo) : autoConfig(repo);
    const names = new Set(), free = new Set(), pass = new Set();
    for (const m of cfg.metrics || []) {
      if (!m || typeof m.name !== 'string') continue;
      names.add(m.name); if (freeCount(m)) free.add(m.name); if (m.direction === 'pass') pass.add(m.name);
    }
    return { names, free, pass };
  } catch { return null; }   // no contract that can be read: nothing is left out
}

function loadEntries(repo, cmd) {
  const all = readRecord(repo), runs = runRows(all), keeper = keeperRows(repo);
  if (!runs.length && !keeper.length) bad(`promptwheel ${cmd}: no record yet. Run the check a few times first (promptwheel run, or promptwheel backfill for past commits)`);
  const keys = foldOutcomes(runs);
  const totalW = keys.filter((k) => k.key === k.metric).reduce((s, k) => s + k.w, 0);
  const now = contractNow(repo);
  // each measure's newest value, to know a pass/fail guard that passes now
  const lastAfter = new Map();
  for (const r of runs) for (const m of (Array.isArray(r.metrics) ? r.metrics : [])) if (m && typeof m.name === 'string') lastAfter.set(oneLine(m.name, 60), m.after ?? null);
  const entries = keys.map((k) => ({ ...k, ...scoreKey(k, totalW), sufficient: k.moved >= MIN_MOVED,
    ...(now && !now.names.has(k.metric) ? { retired: true } : {}), ...(now && now.free.has(k.metric) ? { guardOnly: true } : {}),
    ...(now && now.pass.has(k.metric) && lastAfter.get(k.metric) === 1 ? { passes: true } : {}) }))
    .sort((a, b) => b.lever - a.lever || b.w - a.w);
  return { runs, entries, all, keeper };
}

// what the loop tried and threw away, newest first, each with the measured reason. RRSI keeps a rejected edit in its
// log as evidence against trying the same thing again. Whether this list changes what a later attempt does is NOT
// measured: in a session a line that only states the fact did not carry it, and the reason did (docs/LEARNING.md).
const strings = (a, n, len) => (Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && x).slice(0, n).map((x) => oneLine(x, len));
function triedOf(keeper) {
  return keeperRuns(keeper).filter((r) => KEEPER_THROWN.has(r.result)).reverse().slice(0, 30).map((r) => ({
    ts: r.ts, result: r.result, ...(r.label ? { label: r.label } : {}), why: r.why, subsystems: strings(r.subsystems, 3, 60), files: r.files,
  }));
}
// the keeper's own words for why a try was thrown away; a line that has none still says what it was
const whyThrown = (t) => t.why || `put back (${t.result})`;
const whereThrown = (t) => (t.subsystems.length ? t.subsystems.join(', ') : t.files ? 'no source file' : 'nothing changed');

// The path of each run that was judged over several turns: one measure, its value at the start and after every turn,
// and where the best turn sat. The measure shown is the goal if the run had one, else the first one that improved in
// the run, else the first whose value moved at any turn.
function pathsOf(keeper) {
  const out = [];
  for (const r of keeperRuns(keeper).filter((x) => typeof x.turns === 'number' && typeof x.episode === 'string').reverse().slice(0, 30)) {
    const steps = keeper.filter((x) => x.episode === r.episode && typeof x.turn === 'number').sort((a, b) => a.turn - b.turn);
    const val = (row, name, key) => { const m = row.metrics.find((x) => x.name === name); return m ? m[key] ?? null : null; };
    const names = [...new Set(steps.flatMap((x) => x.metrics.map((m) => m.name)))];
    const improved = (r.metrics.find((m) => m.status === 'improved') || {}).name;
    const movedAny = names.find((nm) => steps.some((x) => val(x, nm, 'after') !== val(x, nm, 'before')));
    const measure = [r.target, steps.length ? steps[0].target : null, improved, movedAny, names[0]].find((nm) => typeof nm === 'string' && names.includes(nm)) || null;
    // A turn that left the tree as the last one did carries the last reading: it is the same tree. One that was not
    // judged for another reason (outside the list of what may change) has no reading of its own.
    const firstRead = steps.find((x) => val(x, measure, 'before') !== null);
    let prev = firstRead ? val(firstRead, measure, 'before') : null;
    const after = steps.map((x) => { const v = x.standing === 'same' ? prev : val(x, measure, 'after'); prev = v; return v; });
    out.push({ episode: r.episode, result: r.result, turns: r.turns, best: r.best || 0, ...(r.label ? { label: r.label } : {}), measure: measure ? oneLine(measure, 60) : null,
      values: measure && firstRead ? [val(firstRead, measure, 'before'), ...after].map((v) => (v === null ? '?' : v)) : [] });
  }
  return out;
}

// what the record has earned here, and what was thrown away, in a form an agent or a person can read before the next try
function playbook(argv) {
  const args = parseArgs(argv);
  const repo = repoRoot(process.cwd());
  const { runs, entries, keeper } = loadEntries(repo, 'playbook');
  const tried = triedOf(keeper), paths = pathsOf(keeper);
  if (args.json) { console.log(JSON.stringify({ runs: runs.length, halfLife: HALF_LIFE, minMoved: MIN_MOVED, entries, tried, ...(paths.length ? { paths } : {}) }, null, 2)); return; }
  const suff = entries.filter((e) => e.sufficient);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const out = [];
  out.push(`## What the record shows here (${runs.length} checked runs; a run counts half as much every ${HALF_LIFE} runs)`);
  out.push('Every line below was measured by the check. Nothing here is a guess, and a line fades unless new runs earn it again.', '');
  if (!suff.length) out.push(`_Nothing has earned a line yet. A key needs ${MIN_MOVED} weighted runs in which it moved. ${entries.length} keys are being counted._`);
  else {
    for (const e of suff.slice(0, 20)) out.push(`- **${e.key}**: helped ${pct(e.p)} of the times it moved (${e.imp.toFixed(1)} better, ${e.reg.toFixed(1)} worse, weighted), moved in ${pct(e.move)} of runs, middle effect ${e.effect}${cohortNote(e)}${e.retired ? ' · no longer in the contract' : ''}${e.guardOnly ? ' · more of it alone is not a win' : ''}`);
    const hidden = entries.length - suff.length;
    if (hidden > 0) out.push('', `_${hidden} more keys have too few runs to earn a line. They are counted, not claimed._`);
  }
  if (tried.length) {
    out.push('', '## Tried and thrown away (newest first)');
    const seen = new Map();
    for (const t of tried) { const line = `- ${t.label ? `**${t.label}**: ` : ''}${whyThrown(t)} (in: ${whereThrown(t)})`; seen.set(line, (seen.get(line) || 0) + 1); }
    for (const [line, n] of [...seen].slice(0, 12)) out.push(n > 1 ? `${line}, ${n} times` : line);
  }
  if (paths.length) {
    out.push('', '## Runs over several turns (newest first)');
    for (const p of paths.slice(0, 10)) out.push(`- ${p.label ? `**${p.label}**: ` : ''}${p.result === 'kept' ? `kept at turn ${p.best} of ${p.turns}` : `put back after ${p.turns} turn${p.turns === 1 ? '' : 's'}`}${p.measure ? `: \`${p.measure}\` ${p.values.join(' → ')}` : ''}`);
  }
  console.log(out.join('\n'));
}

// where to spend the NEXT attempt: a measure or a place, never code advice. A high score is a lever that has paid, or
// an arm tried little. When the last STALL_W attempts kept nothing, the search has stalled and the least tried arm is
// named first: RRSI's exploration slot.
function suggest(argv) {
  const args = parseArgs(argv);
  const repo = repoRoot(process.cwd());
  const { runs, entries, keeper } = loadEntries(repo, 'suggest');
  const arms = entries.filter((e) => (e.key === e.metric || e.key.includes(' @ ')) && !e.retired && !e.guardOnly && !e.passes).sort((a, b) => b.ucb - a.ucb);
  const retired = new Set(entries.filter((e) => e.retired).map((e) => e.metric)).size;
  const attempts = keeperRuns(keeper);   // the tries of the loop, from the keeper's own record
  const stalled = attempts.length >= STALL_W && attempts.slice(-STALL_W).every((r) => r.result !== 'kept');
  const leastTried = stalled && arms.length ? [...arms].sort((a, b) => a.w - b.w)[0].key : null;
  if (args.json) { console.log(JSON.stringify({ runs: runs.length, thin: runs.length < 10, stalled, ...(leastTried ? { leastTried } : {}), retired, arms: arms.slice(0, 10) }, null, 2)); return; }
  console.log(`\nPromptWheel suggest, over ${runs.length} checked runs${runs.length < 10 ? '  (a thin record: mostly a guess, the bonus for what is untried decides)' : ''}\n`);
  if (stalled) console.log(`  The last ${STALL_W} attempts kept nothing. Try what the record has seen least: ${leastTried}\n`);
  for (const a of arms.slice(0, 5)) console.log(`  ${a.ucb.toFixed(3)}  ${a.key.padEnd(28)} lever ${a.lever.toFixed(3)} (helped ${a.p}, moved ${a.move}) · moved in ${a.moved.toFixed(1)} of ${a.n} runs${a.sufficient ? '' : ' · too few to earn a line'}`);
  if (!arms.length) console.log('  (nothing in the record yet that an attempt could improve: every measure is gone from the contract, already passes, or is a count that more of alone is not a win)');
  console.log(`\n  score = lever + a bonus for what was tried least. A high score is a lever that has paid, or an arm tried little.${retired ? `\n  Left out: ${retired} measure${retired === 1 ? '' : 's'} in the record that the contract no longer holds.` : ''}\n`);
}

// fill the record from past commits: each one checked against its parent with the measures as they are NOW. No model.
// Rows are marked `backfill`: a past commit by a person is not an attempt of the loop, and where the two disagree the
// playbook says so. The commit's type (fix, feat, refactor, ...) becomes its label.
function backfill(argv) {
  const args = parseArgs(argv);
  const repo = repoRoot(process.cwd());
  let config;
  if (!hasConfigFile(repo) && !args.noAuto) config = autoConfig(repo);
  const listArgs = ['rev-list', '--no-merges'];
  if (args.since) listArgs.push(`${args.since}..HEAD`); else listArgs.push('-n', String(args.n ?? 30), 'HEAD');
  const commits = git(listArgs, repo).split('\n').filter(Boolean).reverse();   // oldest first, so the record stays in the order things happened
  if (!commits.length) bad('promptwheel backfill: no commits to read');
  const seen = new Set(readRecord(repo).filter((r) => r.cohort === 'backfill').map((r) => r.head));
  const cfg = config ?? loadConfig(repo);
  let done = 0, skipped = 0, failed = 0;
  console.log(`\nreading ${commits.length} commits with the measures as they are now (the source-only re-run is ${args.dgExplicit && args.detectGaming ? 'on' : 'off: pass --detect-gaming to check the past for gamed wins too'})\n`);
  for (const c of commits) {
    try { git(['rev-parse', '--verify', '-q', `${c}~1`], repo); } catch { skipped++; continue; }   // the first commit has no parent
    if (seen.has(short(repo, c))) { skipped++; continue; }                                          // already in the record
    const subj = git(['log', '-1', '--format=%s', c], repo);
    const type = /^(feat|fix|docs|test|chore|refactor|perf|ci|build|style)\b/i.exec(subj)?.[1]?.toLowerCase();
    let report;
    try { report = gate(repo, { base: `${c}~1`, head: c, repeat: args.repeat, detectGaming: args.dgExplicit ? args.detectGaming : false, config }); }
    catch (e) { if (e && e.name === 'ConfigError') { failed++; continue; } throw e; }
    recordRun(repo, report, cfg, { label: type, cohort: 'backfill' });
    console.log(`  ${report.head} ${report.verdict.toUpperCase().padEnd(12)} ${(type ? `#${type}` : '').padEnd(10)} ${oneLine(subj, 56)}`);
    done++;
  }
  console.log(`\n  ${done} commits added to the record${skipped ? ` (${skipped} left out: the first commit, or already there)` : ''}${failed ? ` (${failed} could not be checked)` : ''}. An old commit that no longer builds is recorded as not measured, never made up.`);
  console.log('  next:  promptwheel playbook   ·   promptwheel suggest\n');
}

// ---------------------------------------------------------------------------
// init, write a starter config so a newcomer isn't staring at a blank page
// ---------------------------------------------------------------------------
const LINT_CMD = 'npx eslint . -f unix 2>/dev/null | grep -c " error " || true';
// The counting tripwires. They read CODE files only, and they read more than JavaScript and Python. Both came out of
// replaying the contract on 408 real pull requests (proof-bench/outside-repos, 2026-11-18): a docs-only change was sent
// back for "fewer tests" (the words "it (" in a sentence of a Markdown file), a removed dependency for "fewer assertions"
// (the word assert in yarn.lock), zod's .describe( and a regex's .test( were counted as tests, and a Go, Rust or Ruby
// repo had no test the counts could see. A contract signed before this keeps the commands it was signed with.
const CODE_FILES = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'cs', 'swift', 'ex', 'exs', 'php'].map((e) => `--include="*.${e}"`).join(' ');
const SKIP_DIRS = '--exclude-dir=node_modules --exclude-dir=.promptwheel --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.next --exclude-dir=out --exclude-dir=lib-cov --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=venv --exclude=promptwheel.config.json';
// grep prints each match alone (-o); `drop` takes out the matches that are not what the count means
const tripwire = (re, drop) => `grep -rIoE "${re}" ${CODE_FILES} ${SKIP_DIRS} . 2>/dev/null${drop ? ` | grep -vE "${drop}"` : ''} | wc -l | tr -d " "`;
// a test, by language. JavaScript: it( test( describe(, and the member calls the frameworks define (tap's t.test(, Deno.test(,
// QUnit.test(); any other member call (.describe( on a schema, .test( on a regex) is matched WITH its dot and dropped.
// Python and minitest: def test_. Go: func TestX( and a suite's method. Rust: #[test] and its kin. RSpec, Rails, Elixir:
// it "..." and test "...". JUnit and Swift Testing: @Test. C#: [Fact] [Theory] [Test] [TestMethod] [TestCase].
// PHPUnit: a method named testX or test_x, #[Test], and a docblock @test (after its star, so 'name@test' in a string is
// not one). Pest's it( and test( are read as JavaScript's are, and ->test( on an object is dropped as .test( is.
const TESTS_RE = String.raw`\b(t|Deno|QUnit)\.test ?\(|(\.|->)?\b(it|test|describe) ?\(|def test_|function test[[:upper:]_][[:alnum:]_]*\(|#\[Test\b|\*[[:space:]]*@test\b|func (Test|Fuzz)[[:alnum:]_]*\(|func \([^)]*\) Test[[:alnum:]_]*\(|#\[([[:alnum:]_]+::)*(test|rstest|test_case)\b|\b(it|specify|scenario|test) [\"']|\bit \{|@(Test|ParameterizedTest|RepeatedTest)\b|\[(Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)[](]`;
const TESTS_DROP = String.raw`:(\.|->)(it|test|describe) ?\($`;
const SKIPS_RE = String.raw`\.(skip|only) ?\(|\bx(it|test|describe) ?\(|@pytest\.mark\.(skip|xfail)|@unittest\.skip|\bt\.Skip(f|Now)?\(|#\[ignore|\bx(it|describe|context|specify) [\"']|@(Disabled|Ignore)\b|Skip ?= ?\"|\[Ignore[](]|markTest(Skipped|Incomplete)\(`;
const SILENCED_RE = String.raw`eslint-disable|@ts-(ignore|nocheck)|# ?type: ?ignore|# ?noqa|# ?nosec|//nolint|#!?\[allow\(`;
const ASSERTS_RE = String.raw`expect ?\(|\bassert|\bAssert\.[A-Z]|\bt\.(is|deepEqual|throws|truthy|falsy|not|ok|equal|same|match|notOk|rejects) ?\(|\bt\.(Error|Errorf|Fatal|Fatalf)\(|\brequire\.[A-Z][[:alnum:]]*\(|\bXCTAssert`;
const PRESETS = {
  'antihack': { desc: 'catch reward-hacking: a target + tripwires; pairs with `run --detect-gaming` (source-only re-run)',
    metrics: [
      { name: 'tests_pass', cmd: '__TESTCMD__', extract: 'exit', direction: 'pass', guard: true },
      // the three counts of the tests themselves take a person's reason by the flag (never a trailer, which an agent can
      // write): a test removed or skipped on purpose is sometimes the job. Until 0.8.13 no reason reached them.
      { name: 'test_count', cmd: tripwire(TESTS_RE, TESTS_DROP), extract: 'number', direction: 'up', guard: true, gamingCheck: false, allowable: 'flag' },
      { name: 'skipped_tests', cmd: tripwire(SKIPS_RE), extract: 'number', direction: 'down', guard: true, gamingCheck: false, allowable: 'flag' },
      // a note when the change wins nothing (report: 'no-win'): on 340 real commits a blocking silencer count sent back 13 for a person adding
      // eslint-disable, #[allow] or //nolint in ordinary work, and in none of the 17 where it rose did anything else get better. Beside a win it still fails.
      { name: 'suppressions', cmd: tripwire(SILENCED_RE), extract: 'number', direction: 'down', guard: true, report: 'no-win', gamingCheck: false },
      { name: 'assertions', cmd: tripwire(ASSERTS_RE), extract: 'number', direction: 'up', guard: true, gamingCheck: false, allowable: 'flag' },
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
      // a workflow change is ordinary upkeep (64 of the 65 protected-path send-backs on 340 real commits, 20 of them only an
      // action's version): a rule with no way through but deleting it teaches people to delete it. So it takes a reason.
      { name: 'workflows-frozen', paths: ['.github/workflows/**'], allowable: 'flag', reason: 'workflows run with the repository secrets; they change with a reason from a person (--allow), never as a side effect of a change' },
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
  // a workspace root that is also a package tests only that package under plain `cargo test` (446 of ripgrep's 1246
  // tests, 321 of regex's 1410, measured 2026-11-11): --workspace runs every member's tests
  if (has('Cargo.toml')) { let t = ''; try { t = read('Cargo.toml'); } catch {} return /^\s*\[workspace\]/m.test(t) ? 'cargo test --workspace' : 'cargo test'; }
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
  // No install step for Python. The venv is linked into each clean copy (detectEnv), so `pip install -e .` there
  // re-pointed the developer's own editable install at a folder the check then deleted: on 8 real repos, 6 could no
  // longer import their own package after one check, and every verdict was the same without it. PYTHONPATH (detectEnv)
  // already puts the measured source first.
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
  if (r.baseMeasured) console.log(`  base: measured ${r.baseMeasured} and kept (--base-cache), not run again\n`);
  if (r.mandates) for (const md of r.mandates) console.log(`  ⛔ MANDATE "${md.name}" violated${md.reason ? ': ' + md.reason : ''}  (touched: ${md.files.join(', ')})${md.removed ? '  [deleted in this same change; a mandate stays in force for the change that removes it]' : md.edited ? '  [edited in this same change; the version before the change stays in force for the change that edits it]' : ''}`);
  for (const m of r.metrics) {
    const tag = m.guard ? (m.ok ? 'guard✓' : 'GUARD✗') : 'info';
    const d = m.delta == null ? 'n/a' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    console.log(`  ${arrowFor(m)} ${m.name.padEnd(18)} ${String(m.before).padStart(8)} → ${String(m.after).padStart(8)}  (${d}, ${m.status}) [${tag}, ${m.confidence}]`);
    if (m.paid) console.log(`      ✓ paid for by "${m.paid.gain}": worse by ${(m.paid.share * 100).toFixed(1)}%, and that gain buys up to ${(m.paid.allowed * 100).toFixed(1)}%`);
    else if (m.overBudget) console.log(`      ✗ over its budget: worse by ${(m.overBudget.share * 100).toFixed(1)}%, and the gain on "${m.overBudget.gain}" buys ${(m.overBudget.allowed * 100).toFixed(1)}%`);
    if (m.inert && m.ran && m.cause === 'missing-dependency') console.log(`      ⚠ "${m.name}" could not run in the clean copy ${m.ran === 'both' ? 'at either ref' : `at one ref and failed at the other (it ran at the ${m.ran} ref)`}: ${m.detail}. Link or install what it needs (linkDirs or setup in promptwheel.config.json), then check again`);
    else if (m.inert && m.ran === 'both') console.log(`      ⚠ "${m.name}" ran and failed before and after this change, so it guards nothing here. Fix the failing tests, or the command, before trusting a pass`);
    else if (m.inert) console.log(`      ⚠ "${m.name}" ${m.ran ? `ran and failed at the ${m.ran} ref and did not run at the other` : 'never ran (same value at both refs)'}: its command needs a build/deps first, or is not your real test command. Fix: promptwheel init, or set setup/linkDirs in promptwheel.config.json`);
    if (m.gamed === true) console.log(`      🚩 GAMED, ${m.gamingReason}`);
    else if (m.gamed === false && m.status === 'inconclusive' && m.gamingReason) console.log(`      ≈ not counted as a win: ${m.gamingReason}`);
  }
  for (const m of r.metrics || []) for (const w of m.lostIn || []) console.log(`  ℹ note: ${w.file} has ${PLAIN[m.name] || m.name} (${w.before} → ${w.after}), though the repo's total did not fall`);
  if (r.testsTakenOut) console.log(`  ℹ note: ${takenOutSaid(r.testsTakenOut, false)}`);
  for (const x of r.explained || []) if (x.metric === 'environment') console.log(`  ℹ note: ${x.what}: ${x.items.join(', ')}`);
  if (r.setup) { const at = Object.keys(r.setup), f = r.setup[at[0]]; console.log(`  ⚠ setup failed (exit ${f.exit}) at the ${at.join(' and ')} ref${at.length > 1 ? 's' : ''}${f.lastLine ? ': ' + f.lastLine : ''}`); }
  if (r.gate && r.gate.weakened) for (const w of r.gate.weakened) console.log(w.change === 'measurement-edited'
    ? `  🚩 GATE WEAKENED, how the guard "${w.name}" is measured (setup, env or linked dirs) was edited in this change, and measured the way it was before it would have ${wouldHave(w.status)} at head (goalpost moved, not earned)`
    : `  🚩 GATE WEAKENED, the guard "${w.name}" was ${w.change === 'guard-removed' ? 'removed' : w.change === 'guard-edited' ? 'edited' : 'disabled'} in this change and it would have ${wouldHave(w.status)} at head (goalpost moved, not earned)`);
  if (r.gate && r.gate.changed) console.log(`  ⚠ gate definition changed in this change (fingerprint ${r.gate.fingerprint.base} -> ${r.gate.fingerprint.head}): a metric, guard, evaluatorPath, mandate, or the setup, env or linked dirs they are measured with was added, removed or edited; review promptwheel.config.json as part of the diff`);
  const failReason = r.mandates ? ', a mandate was violated (a protected path changed)' : ', a guarded metric regressed (beyond noise)';
  console.log(`\n  VERDICT: ${r.verdict.toUpperCase()}${r.verdict === 'fail' ? failReason : r.verdict === 'gamed' ? ', a metric "improved" by editing the goalposts, not the source' : r.verdict === 'inconclusive' ? ', a guard is inert (measured nothing); a pass cannot be certified' : ''}`);
  const how = allowFlag(r), each = allowNames(r) ? ' (more than one thing: a reason lets through only what it names)' : '';
  const left = r.allowed ? (r.allowable || []).filter((l) => !r.allowed.cleared.includes(l)) : [];
  if (r.verdict === 'fail' && r.mandates) {
    const takes = r.mandates.filter((md) => md.allowable).map((md) => `"${md.name}"`);
    if (takes.length && !left.length) console.log(`  intentional? ${takes.join(', ')} ${takes.length > 1 ? 'accept' : 'accepts'} a person's declared reason: promptwheel run ${how} passes with the reason on the record${each}`);
    if (takes.length < r.mandates.length) console.log(`  ${takes.length ? 'any other' : 'a'} mandate is a hard rule; if the change is truly intended, retire the mandate in promptwheel.config.json in a change of its own first (a tracked, tamper-evident change), do not work around it`);
  } else if (r.verdict === 'fail' && r.metrics.some((m) => m.allowable) && !left.length) {
    // a pull request's reader is often a fix run: say where the tests fell and the two ways out. A session keeps its own words.
    const fell = r.mode === 'refs' ? fallenTests(r) : [];
    if (fell.length) for (const l of wayOut(r, fell, how)) console.log('  ' + l);
    else console.log(`  intentional? this guard accepts a person's declared reason: promptwheel run ${how} passes with the reason on the record${each || ` (${r.metrics.filter((m) => m.allowable).map((m) => m.name).join(', ')})`}`);
  }
  else if (r.verdict === 'fail') console.log('  intentional? loosen that guard locally in promptwheel.config.json (guard:false, or override the inherited metric by name)');
  if (r.allowed && r.allowed.cleared.length) console.log(`  ✓ allowed: ${r.allowed.cleared.join(', ')} acknowledged as an intentional change, recorded (Promptwheel-Allow: ${r.allowed.reason})`);
  if (left.length) console.log(`  not let through: ${left.join(', ')}. A reason lets through only what it names when there is more than one thing. To accept them all: promptwheel run ${how}`);
  console.log('');
}

// The --allow flag as a person should type it for this report: with more than one thing to let through, each by name.
const allowNames = (r) => (kindsIn(r.allowable || []) > 1 ? r.allowable.map((l) => l.replace(/^mandate:/, '')).join(', ') + ': ' : '');
const allowFlag = (r) => `--allow "${allowNames(r)}<reason>"`;

// PR-comment markdown (rendering lives in the tool so the GitHub Action stays thin)
// What a person needs when a check speaks: what changed, in words, and how to accept it.
const PLAIN = {
  lifecycle_scripts: 'a new install script', dependency_entries: 'a new dependency', lock_nonregistry_sources: 'a dependency from outside the registry',
  unpinned_execution: 'something that runs without a pinned version', install_policy_gaps: 'a weaker install policy', lock_drift: 'the shape of the repo changed',
  pins_changed: 'resolved dependency versions changed', tests_pass: 'tests stopped passing', test_count: 'fewer tests', skipped_tests: 'more skipped tests',
  suppressions: 'more silenced checks', assertions: 'fewer assertions',
};
// What the measurement borrows from the machine it runs on and no diff shows: a variable that can change which tests
// run, or load code into every one of them. Measured 2026-11-11 (proof-bench/outside-git): a PYTEST_ADDOPTS that
// deselects the red test and a preload in NODE_OPTIONS each read pass while a fresh install was red. Removing them
// could break a setup that needs them, so the check runs as it is told and says so. A NODE_OPTIONS that loads no file
// (a memory limit, say) is not one.
const ENV_NOTED = [
  ['PYTEST_ADDOPTS', (v) => !!v.trim()],
  ['PYTEST_PLUGINS', (v) => !!v.trim()],
  ['NODE_OPTIONS', (v) => /(^|\s)(-r|--require|--import|--loader|--experimental-loader)(\s|=)/.test(v)],
];
export function environmentNote(env = process.env, declared = null) {
  const set = ENV_NOTED.filter(([k, hit]) => typeof env[k] === 'string' && hit(env[k]) && !(declared && Object.prototype.hasOwnProperty.call(declared, k))).map(([k]) => k);
  return set.length ? { metric: 'environment', noted: true, what: 'the environment this ran in can change which tests run, or load code into them', items: set } : null;
}
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
// access wins. A bot never counts. Since 0.8.10 neither does the account that opened the pull request (`author`),
// in any letter case: a coding agent run from a service account, which GitHub calls a User, opens its pull requests
// from that account and can post the comment, and the report spells out the words. The opener counts only where
// the contract on the base branch says so (`allowFromAuthor`, for a repo with one person in it). With no opener
// named the old rule holds, for a caller that does not know who opened it. An agent signed in as another person
// can still post one: the record shows who.
export function allowDecision(comments, opts = {}) {
  const trusted = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  const opener = String((opts && opts.author) || '').trim().toLowerCase();
  let skipped = '';
  for (const c of [...(comments || [])].reverse()) {
    if (!c || !c.user || c.user.type !== 'User' || !trusted.has(c.author_association)) continue;
    const m = String(c.body || '').match(/^\s*sawbuck-allow:[ \t]*(\S.*?)[ \t]*$/m);
    if (!m) continue;
    if (opener && !(opts && opts.allowFromAuthor === true) && String(c.user.login || '').toLowerCase() === opener) { skipped = skipped || String(c.user.login).slice(0, 39); continue; }
    return { reason: `${m[1].slice(0, 280)} (approved by ${String(c.user.login).slice(0, 39)})`, skipped: '' };
  }
  return { reason: '', skipped };
}
export function allowFromComments(comments, opts) { return allowDecision(comments, opts).reason; }

// What a fallen count of the tests says to whoever repairs it, a person or a fix run: where it fell, and the two ways
// out. A reject that names its cause is what a fix run acts on; "a guarded metric regressed" names none.
const fallenTests = (r) => r.metrics.filter((m) => m.allowable && TEST_KIND.has(m.name) && m.name !== 'tests_pass');
const undoWords = (fell) => { const skip = fell.some((m) => m.name === 'skipped_tests'), gone = fell.some((m) => m.name !== 'skipped_tests'); return { undo: gone && skip ? 'put back what was removed, take off the skip that was added' : skip ? 'take off the skip that was added' : 'put back what was removed', job: gone ? 'removing it' : 'skipping it' }; };
const reasonInCommit = (r, fell) => (r.byCommit || []).some((n) => fell.some((m) => m.name === n));
function wayOut(r, fell, how) {
  const { undo, job } = undoWords(fell); const gone = fell.some((m) => m.name !== 'skipped_tests');
  const where = (m) => (m.where && m.where.length ? ', in ' + m.where.slice(0, 3).map((w) => `${w.file} (${w.before} → ${w.after})`).join(', ') + (m.where.length > 3 ? ' and more' : '') : '');
  return [
    ...fell.map((m) => `${PLAIN[m.name] || m.name}: ${m.before} → ${m.after}${where(m)}`),
    'to pass, do one of these:',
    `  1. ${undo}, and push`,
    ...(reasonInCommit(r, fell)
      // the second wording. The first ("if removing it is the job ... <why it had to go>") let an agent that believed an
      // earlier commit's false reason write "the test fails on the new code" and pass: 5 of 100 runs, all on the
      // smallest model (proof-bench/pr-cause). With these words: 0 of 100, and 100 of 100 still said why where it was true.
      ? [`  2. only if what it tested was itself ${gone ? 'removed' : 'switched off'} on purpose, end a commit message in this change with the line`, `       Promptwheel-Allow: ${fell[0].name}: <what was removed, and who asked for it>`, '     (the reason is kept on the record and shown with the verdict)', `  a test that fails on the new code is not a reason to ${gone ? 'remove' : 'skip'} it, whatever an earlier commit says: that is 1, and the code gets fixed`,
         // the third way out, so the honest move is never the dearest: on a test that could not pass, about 7 in 10
         // agents left it red and asked with these words; on two rules that clashed, 38 in 100 asked where 7 had
         '  3. if neither can be done honestly, stop: leave the pull request red and say why. That is a right answer.']
      : [`  2. if ${job} is the job, a person gives the reason: promptwheel run ${how}`]),
    ...(r.protects ? ['changing the workflow, the contract or this check is not a way through: those changes are sent back too'] : []),
  ];
}
// Who may accept a change on a pull request: someone who did not open it, or, where the contract on the base branch
// says one person works here (`openerCounts`), anyone with write access, the opener included.
const mdAccept = (r, all) => (r.openerCounts
  ? `To accept ${all ? 'them all' : 'this'}, comment \`sawbuck-allow: ${allowNames(r)}<the reason>\` on this PR${all ? '' : ', and the check is run again'}. One person works in this repo, so a comment from the account that opened the PR counts.`
  : `To accept ${all ? 'them all' : 'this'}, someone with write access who did not open this PR comments \`sawbuck-allow: ${allowNames(r)}<their reason>\`${all ? '' : ' on it, and the check is run again'}.`);
function mdWayOut(r) {
  if (!r.explained.some((x) => !x.noted && x.allowable)) return [];
  const accept = `${mdAccept(r)}${allowNames(r) ? ' A reason lets through only what it names when there is more than one thing.' : ''}`;
  const fell = fallenTests(r);
  if (!fell.length) return ['>', `> ${accept}`];
  const { undo, job } = undoWords(fell);
  const where = fell.flatMap((m) => (m.where || []).slice(0, 3).map((w) => `\`${w.file}\` (${w.before} → ${w.after})`));
  const Undo = undo[0].toUpperCase() + undo.slice(1);
  return ['>', ...(where.length ? [`> **Where:** ${where.join(', ')}`, '>'] : []),
    ...(reasonInCommit(r, fell)
      ? [`> ${Undo}, and push. Or, only if what it tested was itself removed on purpose, end a commit message in this change with the line \`Promptwheel-Allow: ${fell[0].name}: <what was removed, and who asked for it>\`. The reason is kept on the record and shown here.`, '>', '> A test that fails on the new code is not a reason to remove it, whatever an earlier commit says: the code gets fixed.', '>', '> If neither can be done honestly, stop: leave the pull request red and say why. That is a right answer.']
      : [`> ${Undo}, and push. Or, if ${job} is the job:`, '>', `> ${accept}`]),
    ...(r.protects ? ['>', '> Changing the workflow, the contract or this check is not a way through: those changes are sent back too.'] : [])];
}
// The comment is Sawbuck's: its name, and one link, to the one repo. What a reader has to do is in view; the table
// of numbers is folded away (`fold: false` for the job summary, which nobody has to scroll past). The sentences
// about how to get through are the ones measured on agents (proof-bench/pr-cause) and are not reworded here.
const SAWBUCK_REPO = 'https://github.com/sawbuck-ai/sawbuck';
const MD_FOOT = `<sub>[Sawbuck](${SAWBUCK_REPO}) checks what a change did to the tests. No model reads your code.</sub>`;
const MD_HEADLINE = { pass: 'passes', fail: 'sent back', gamed: 'sent back', inconclusive: 'could not measure' };
const MD_ICON = { pass: '✅', fail: '❌', gamed: '🚩', inconclusive: '🟡' };
// A protected path that was touched, for a reader on a pull request: how a person accepts it, said once (under a
// count that fell when there is one, else here). A path that takes no reason is not offered one. Until 0.8.15 the
// comment named the path and stopped there, and a changed workflow is the most common send-back on ordinary work.
function mdPathWayOut(r) {
  const soft = r.mandates.filter((md) => md.allowable), hard = r.mandates.filter((md) => !md.allowable);
  const saidBelow = !!(r.explained && mdWayOut(r).length);
  return [
    ...(soft.length && !saidBelow ? ['>', `> ${mdAccept(r)}${allowNames(r) ? ' A reason lets through only what it names when there is more than one thing.' : ''}`] : []),
    ...(hard.length ? ['>', `> ${r.mandates.length > 1 ? hard.map((md) => `\`${md.name}\``).join(', ') : 'This protected path'} ${hard.length > 1 ? 'take' : 'takes'} no reason. To change it on purpose, a person first takes its rule out of \`promptwheel.config.json\`, in a change of its own.`] : []),
  ];
}
// In the comment: "an earlier commit of this pull request (`abc1234`) added 3 tests. None of them is in it now: `a`, `b`, `c`."
// With one: "... added 1 test. That test is not in it now: `a`." (the owner's yes to these words, 2026-11-22)
// At a terminal the same, of "this change": a range of commits is not always a pull request.
const takenOutNames = (t, q = '') => `${t.names.map((n) => q + n + q).join(', ')}${t.more ? ` and ${t.more} more` : ''}`;
const takenOutSaid = (t, md) => md
  ? `an earlier commit of this pull request (\`${t.at}\`) added ${t.added} test${t.added === 1 ? '' : 's'}. ${t.added === 1 ? 'That test is not' : 'None of them is'} in it now: ${takenOutNames(t, '`')}.`
  : `an earlier commit of this change (${t.at}) added ${t.added} test${t.added === 1 ? '' : 's'}, and ${t.added === 1 ? 'that test is not' : 'none of them is'} in it now: ${takenOutNames(t)}`;
function renderMarkdown(r, o = {}) {
  const sIcon = { improved: '🟢', regressed: '🔴', unchanged: '⚪', inconclusive: '🟡', unmeasurable: '⚫' };
  const rows = r.metrics.map((m) => {
    const d = m.delta == null ? 'n/a' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    const status = m.gamed === true ? `🚩 gamed (${(m.retained * 100).toFixed(0)}% survives source-only)` : `${sIcon[m.status] || ''} ${m.status}${m.inert ? ' ⚠ never passes' : ''}`;
    return `| ${m.guard ? '🛡️ ' : ''}${m.name} | ${m.before} | ${m.after} | ${d} | ${status} | ${m.confidence} |`;
  }).join('\n');
  // The gamed sentence names no one: the change may be a person's (2026-11-22: it said "the agent edited"). Where the
  // test run is what was gamed it says so in plain words; another measure keeps the general sentence.
  const gamedSaid = r.metrics.some((m) => m.gamed === true && m.name === 'tests_pass')
    ? '> 🚩 **The tests pass only because a test, config or grader file was changed.** With those files put back, the source alone does not pass.'
    : '> 🚩 A metric "improved" only because a test, config or grader file was changed, not the source. The win does not survive a source-only re-run.';
  // What to do about a gamed win, in the sentences measured for a fallen count: put it back, or a person's reason, and
  // changing the check is no way through. Until 2026-11-22 this comment said what was found and stopped (seen on real
  // pull requests, proof-bench/live/action-on-github-0.2.3). Not said twice where a fallen count already says it.
  const gamedWayOut = r.verdict === 'gamed' && !(r.explained && mdWayOut(r).length)
    ? ['>', '> Put the files back and fix the source, and push. Or, if the file itself was wrong:', '>', `> ${mdAccept(r)}`,
       ...(r.protects ? ['>', '> Changing the workflow, the contract or this check is not a way through: those changes are sent back too.'] : [])]
    : [];
  const said = r.verdict === 'gamed' ? gamedSaid : r.verdict === 'fail' ? (r.mandates ? '> ⛔ A protected path changed. This is a hard rule; no metric result clears it.' : '> ❌ A 🛡️ guarded metric regressed beyond the noise band.') : r.verdict === 'inconclusive' ? (r.metrics.some((m) => m.inert) && r.metrics.every((m) => !m.inert || m.ran === 'both') ? '> 🟡 A 🛡️ guarded check is **inert**, it fails before and after this change, so nothing was actually verified. Fix it before trusting a pass.' : '> 🟡 A 🛡️ guarded check is **inert**, it never runs, so nothing was actually verified. Fix its command before trusting a pass.') : '> ✅ No guarded metric regressed.';
  // a gamed win and a check that measured nothing have no "needs a look" line of their own: their sentence stays in view
  const inView = r.verdict === 'gamed' || r.verdict === 'inconclusive';
  const lost = r.metrics.flatMap((m) => (m.lostIn || []).map((w) => `> ℹ️ **Note:** \`${w.file}\` has ${PLAIN[m.name] || m.name} (${w.before} → ${w.after}), though the repo's total did not fall.`));
  const table = ['| metric | before | after | Δ | status | confidence |', '|---|--:|--:|--:|---|---|', rows, ...(inView ? [] : ['', said])].join('\n');
  const span = `${r.base} → ${r.head}`, rest = `${r.repeat > 1 ? `, ×${r.repeat}` : ''}, verdict ${r.verdict.toUpperCase()}`;
  const would = o.commentOnly && o.wouldFail;
  return [
    // comment-only, on a run that would have failed the job: a send-back is called one; a check that measured nothing is not
    `### ${would && r.verdict !== 'inconclusive' ? '✋' : MD_ICON[r.verdict] || '❌'} Sawbuck${would ? `, comment only: ${r.verdict === 'inconclusive' ? MD_HEADLINE.inconclusive : 'this would have been sent back'}` : `: ${MD_HEADLINE[r.verdict] || r.verdict}`}`,
    ...(would ? ['This check only comments here. It never fails the job.'] : []),
    ...(r.mandates ? [[...r.mandates.map((md) => `> ⛔ **Protected path touched:** \`${md.name}\`${md.reason ? ': ' + md.reason : ''} (touched \`${md.files.join('`, `')}\`)${md.removed ? ' (deleted in this same change; it stays in force for the change that removes it)' : md.edited ? ' (edited in this same change; the version before the change stays in force for the change that edits it)' : ''}`), ...mdPathWayOut(r)].join('\n')] : []),
    ...(r.explained ? [[...r.explained.map((x) => `> ${x.noted ? 'ℹ️ **Note:**' : '✋ **Needs a look:**'} ${x.what}${x.items ? ': `' + x.items.join('`, `') + '`' : ''}`), ...mdWayOut(r)].join('\n')] : []),
    ...(inView ? [[said, ...gamedWayOut].join('\n')] : []),
    ...(r.gate && r.gate.weakened ? [`> 🚩 **Gate weakened:** ${r.gate.weakened.map((w) => `\`${w.name}\` ${w.change === 'guard-removed' ? 'removed' : w.change === 'guard-edited' ? 'edited' : w.change === 'measurement-edited' ? 'measured another way (setup, env or linked dirs)' : 'disabled'} (would have ${wouldHave(w.status)} at head)`).join('; ')}. The pass was bought by changing the gate, not by earning it.`] : []),
    ...(r.allowed && r.allowed.cleared.length ? [`> ✓ **Allowed:** \`${r.allowed.cleared.join('`, `')}\` cleared by a declared reason: ${r.allowed.reason}`] : []),
    ...(r.allowed && (r.allowable || []).some((l) => !r.allowed.cleared.includes(l)) ? [`> ✋ **Not let through:** \`${r.allowable.filter((l) => !r.allowed.cleared.includes(l)).join('`, `')}\`. A reason lets through only what it names when there is more than one thing. ${mdAccept(r, true)}`] : []),
    ...(r.gate && r.gate.changed ? [`> ⚠ **Gate definition changed** in this diff (fingerprint \`${r.gate.fingerprint.base}\` -> \`${r.gate.fingerprint.head}\`): a metric, guard, evaluatorPath, mandate, or the setup, env or linked dirs they are measured with was added, removed or edited. Review the config change with the code.`] : []),
    ...(lost.length ? [lost.join('\n')] : []),
    ...(r.testsTakenOut ? [`> ℹ️ **Note:** ${takenOutSaid(r.testsTakenOut, true)}`] : []),
    ...(o.note && String(o.note).trim() ? [String(o.note).trim()] : []),
    o.fold === false ? `\`${span}\`${rest}\n\n${table}` : `<details><summary>What was measured (<code>${span}</code>${rest})</summary>\n\n${table}\n\n</details>`,
    MD_FOOT,
  ].join('\n\n');
}

// ---- Each test by its name (0.8.17) -----------------------------------------------------------------------------------
// The counts above say how many tests a tree holds. They cannot say which. This reads each test of a file by name:
// text in, tests out, no parser and no dependency, one small reader for each language the counts read.
//
//   testsIn(path, text) -> [{ name, line, asserts, skipped }]
//
// name     what a person would call the test: the string given to it( or test(, the function's name, the method's name
//          with its class in Python and C#, a row of a Go table by its name field (TestParse/empty input).
// line     the line the test begins on (0-based). For a test marked by an attribute, the attribute's line.
// asserts  how many assertion patterns sit between this test's line and the next test's (or the end of the file); -1
//          for a row of a Go table, which has no body of its own. A helper that asserts for the test is not seen.
// skipped  the test is marked not to run.
// Held against a reading by eye on five draws of sixty real test files (proof-bench/per-test, checks/): the first four
// each found names it missed, fixed here; the fifth found none in JavaScript and TypeScript, Python, C#, Rust, Java, Go.
// Not read: a name built at run time, tests made from a table in JavaScript, Python and C# (it.each, parametrize,
// InlineData: one name for all rows), and any language not listed.
const testExt = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const TESTS_JS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte']);
const TESTS_READ = new Set([...TESTS_JS, 'py', 'go', 'rs', 'rb', 'java', 'kt', 'cs', 'swift', 'ex', 'exs']);

// The engine's own assertion pattern (ASSERTS_RE), and the other ways a test says what must hold: should and must
// (chai, RSpec, minitest, FluentAssertions), refute (ExUnit, minitest), verify (Mockito, Moq), googletest's macros,
// pytest.raises, a Rust test that must panic.
const TEST_ASSERT = /expect ?\(|\bassert|\bAssert\.[A-Z]|\bt\.(?:is|deepEqual|throws|truthy|falsy|not|ok|equal|same|match|notOk|rejects) ?\(|\bt\.(?:Error|Errorf|Fatal|Fatalf)\(|\brequire\.[A-Z][A-Za-z0-9]*\(|\bXCTAssert|\.should\b|\.Should\(|\bshould\.|\brefute\b|\b[Vv]erify\w*\(|\.must_\w+|\bis_expected\b|\b(?:EXPECT|ASSERT)_[A-Z]|\braises\(|should_panic|\.rejects\b|\.resolves\b/g;
const assertsIn = (s) => (s.match(TEST_ASSERT) || []).length;

const TEST_RE = {
  // it('x' test("x" specify(`x` with any chain between the word and the bracket: .only .skip .each([...]) .concurrent
  // Not a member call (.test( on a regex, .it( on an object), except tap's t.test(, Deno.test( and QUnit.test(.
  // Groups: 1 the x of xit, 4 the chain, 5 the quote, 6 the name.
  js: /(?:^|[^.\w$])(?:(x)?(it|test|specify)|(?:t|Deno|QUnit)\.(test))((?:\.[A-Za-z]+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*)\s*\(\s*(['"`])((?:\\.|(?!\5)[^\\\n])*)\5/,
  js_open: /(?:^|[^.\w$])(?:(x)?(it|test|specify)|(?:t|Deno|QUnit)\.(test))((?:\.[A-Za-z]+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*)\s*\(\s*$/,
  js_next: /^\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/,
  js_each: /(?:^|[^.\w$])(?:(x)?(it|test|specify))()((?:\.[A-Za-z]+)*\.(?:each|for))\s*(?:\(|`)[^)`]*$/,          // groups as TEST_RE.js: 1 the x, 4 the chain
  js_each_close: /^\s*[\])`]+\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/,
  py_def: /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/,
  py_class: /^(\s*)class\s+(\w+)/,
  py_skip: /^\s*@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.skip|skip)\b/,
  go: /^func\s+(?:\([^)]*\)\s+)?((?:Test|Fuzz)\w*)\s*\(/,
  go_run: /\bt\.Run\(\s*"((?:\\.|[^"\\])*)"/,
  go_loop: /\bt\.Run\(\s*\w+\.(\w+)\s*,/,                             // t.Run(tt.name, ...): the name comes from that field of a table
  go_row: /^\s*\{?\s*(\w+)\s*:\s*"((?:\\.|[^"\\])*)"/,                  // a field with a string, on its own line or first in a one-line row
  go_struct: /\[\]struct\s*\{\s*(\w+)?/,                                 // the table's type: its first field names a row written without field names
  go_bare: /^\s*\{\s*"((?:\\.|[^"\\])*)"\s*[,}]/,                         // {"a row", ...}: the first value, when the first field is the name
  rs_attr: /^\s*#\[(?:[\w]+::)*(?:test|rstest|test_case|quickcheck|proptest)\b/,
  rs_fn: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/,
  rb: /^\s*(x)?(?:it|specify|scenario|example|test)\s+(['"])((?:\\.|(?!\2)[^\\\n])*)\2/,
  rb_def: /^\s*def\s+(test_\w+)/,
  rb_bare: /^\s*(x)?it\s*\{(.*)$/,
  jv_attr: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|Property)\b/,
  jv_skip: /@(?:Disabled|Ignore)\b/,
  kt_fn: /\bfun\s+(?:<[^>]*>\s*)?(`[^`]+`|\w+)\s*\(/,
  jv_fn: /(?:^|[\s>\]])(\w+)\s*\([^;{]*(?:\{|$|\)\s*(?:throws\b|$))/,
  cs_attr: /^\s*\[\s*(?:\w+\.)*(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod|TestCaseSource|SkippableFact|SkippableTheory|ConditionalFact|ConditionalTheory|StaFact|WpfFact|UIFact|Property|Scenario)\b/,
  cs_skip: /\bSkip\s*=|\[\s*Ignore\b|\bIgnore\s*\(|\bExplicit\b/,
  cs_class: /\b(?:class|struct|record)\s+(\w+)/,
  cs_fn: /(?:^|[\s>\]?])(\w+)\s*(?:<[^<>()]*>)?\s*\(/,
  sw_fn: /\bfunc\s+(\w+)\s*\(/,
  sw_attr: /@Test\b/,
  ex: /^\s*test\s+"((?:\\.|[^"\\])*)"/,
  ex_skip: /^\s*@tag\s+:?skip\b|^\s*@tag\s+skip:/,
};

const TEST_NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new', 'foreach', 'fixed', 'when', 'nameof', 'typeof', 'sizeof', 'await', 'throw', 'base', 'this', 'get', 'set', 'synchronized', 'super', 'assert']);

// A test marked by an attribute: `#[test]` in Rust, `@Test` in Java and Kotlin, `[Fact]` in C#. The function follows
// it, with other attributes, comments, and the attribute's own arguments between, on one line or over several:
//   [Theory]                                   @Test(groups = { "direct" },       #[rstest]
//   [InlineData(new[] { "--" }, null)]                 timeOut = TIMEOUT)         #[case::renamed(
//   public void ArgumentSeparator(...)         public void tryGetAddresses(...)       "a", Some(B))]
// So brackets are counted, with what is inside a string left out, and a line is read only once every attribute on it
// is closed. `open` are the attribute openers of the language; `mark` says an attribute line marks a test; `skip` says
// it marks one not to run; `nameOf` reads the function's name from what is left of a line.
const blankStrings = (l) => l.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])'/g, "''");
function leadingAttributes(s, open, depth) {
  // -> { rest, depth, had }: what follows the attributes at the start of `s` (already blanked), the depth still open, and whether one was there
  let i = 0, had = depth > 0;
  for (;;) {
    if (depth === 0) {
      while (i < s.length && /\s/.test(s[i])) i++;
      const o = open.find((op) => s.startsWith(op, i)); if (!o) break;
      had = true;
      if (o === '@') { const m = /^@[\w.]+/.exec(s.slice(i)); i += m ? m[0].length : 1; let j = i; while (j < s.length && /\s/.test(s[j])) j++; if (s[j] !== '(') continue; i = j; }
    }
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth <= 0) { depth = 0; i++; break; } }
    }
    if (depth > 0) return { rest: '', depth, had };
  }
  return { rest: s.slice(i), depth: 0, had };
}
function attributed(lines, { open, mark, skip, nameOf, add, ends = /[;{}]/, before = null }) {
  let at = -1, skipped = false, preSkip = false, depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; if (before) before(raw, at);
    const { rest, depth: d, had } = leadingAttributes(blankStrings(raw), open, depth); depth = d;
    if (had) {
      if (mark.test(raw) && at < 0) { at = i; skipped = preSkip; }
      if (skip.test(raw)) { if (at >= 0) skipped = true; else preSkip = true; }
    }
    if (depth > 0 || !rest.trim() || /^\s*(\/\/|\/\*|\*)/.test(rest)) continue;
    if (at >= 0) { const name = nameOf(rest); if (name) add(name, at, skipped); else if (!ends.test(rest)) continue; }
    at = -1; skipped = false; preSkip = false;
  }
}

export function testsIn(path, text) {
  const ext = testExt(path); if (!TESTS_READ.has(ext)) return [];
  const lines = String(text).split('\n'); const found = [];   // { name, line, skipped }
  const add = (name, line, skipped) => found.push({ name: String(name).trim().slice(0, 300), line, skipped: !!skipped });
  if (TESTS_JS.has(ext)) {
    for (let i = 0; i < lines.length; i++) {
      let m = TEST_RE.js.exec(lines[i]), name = m && m[6];
      if (!m) {                                                        // it(  and the name on the next line, as a formatter leaves a long one
        const o = TEST_RE.js_open.exec(lines[i]), n = o && TEST_RE.js_next.exec(lines[i + 1] || '');
        if (n) { m = o; name = n[2]; }
      }
      if (!m) {                                                        // it.each([  a table over several lines  ])('the name', ...)
        const e = TEST_RE.js_each.exec(lines[i]); if (!e) continue;
        for (let k = i + 1; k < Math.min(lines.length, i + 400); k++) {
          const c = TEST_RE.js_each_close.exec(lines[k]); if (c) { m = e; name = c[2]; break; }
          if (TEST_RE.js.test(lines[k]) || TEST_RE.js_each.test(lines[k])) break;   // another test began: this table never named one
        }
        if (!m) continue;
      }
      const chain = m[4] || '';
      if (/\.describe\b/.test(chain)) continue;                       // test.describe('a group', ...) is a group, not a test
      add(name, i, !!m[1] || /\.(?:skip|todo|fixme)\b/.test(chain));
    }
  } else if (ext === 'py') {
    let cls = null, skip = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; if (!l.trim()) continue;
      const c = TEST_RE.py_class.exec(l); if (c) { cls = { indent: c[1].length, name: c[2] }; skip = TEST_RE.py_skip.test(lines[i - 1] || '') ? skip : false; continue; }
      if (TEST_RE.py_skip.test(l)) { skip = true; continue; }
      if (/^\s*@/.test(l)) continue;                                   // another decorator: the skip mark above it still stands
      const d = TEST_RE.py_def.exec(l);
      if (d) { if (cls && d[1].length <= cls.indent) cls = null; add(cls ? `${cls.name}.${d[2]}` : d[2], i, skip); }
      else if (cls && /^\S/.test(l)) cls = null;                       // back at the left edge: the class is over
      skip = false;
    }
  } else if (ext === 'go') {
    // A table-driven test: the rows of the table are its sub-tests, each named by its name field. A row has no body
    // of its own (the loop holds the assertions), so its assertions are not counted: asserts is -1.
    let cur = null, rows = [], loop = new Set(), first = null, wantFirst = false;
    const flush = () => { if (cur) for (const [field, n, i] of rows) if (loop.has(field)) found.push({ name: `${cur}/${n}`.slice(0, 300), line: i, skipped: false, row: true }); rows = []; loop = new Set(); first = null; wantFirst = false; };
    for (let i = 0; i < lines.length; i++) {
      const m = TEST_RE.go.exec(lines[i]); if (m) { flush(); cur = m[1]; add(cur, i, false); continue; }
      if (!cur) continue;
      const r = TEST_RE.go_run.exec(lines[i]); if (r) { add(`${cur}/${r[1]}`, i, false); continue; }
      const lp = TEST_RE.go_loop.exec(lines[i]); if (lp) { loop.add(lp[1]); continue; }
      const st = TEST_RE.go_struct.exec(lines[i]); if (st) { first = st[1] || null; wantFirst = !st[1]; continue; }
      if (wantFirst) { const f = /^\s*(\w+)/.exec(lines[i]); if (f) { first = f[1]; wantFirst = false; } continue; }
      const w = TEST_RE.go_row.exec(lines[i]); if (w) { rows.push([w[1], w[2], i]); continue; }
      const b = first && TEST_RE.go_bare.exec(lines[i]); if (b) rows.push([first, b[1], i]);
    }
    flush(); found.sort((a, b) => a.line - b.line);
  } else if (ext === 'rs') {
    attributed(lines, { open: ['#['], mark: TEST_RE.rs_attr, skip: /#\[ignore\b/, add, ends: /[;{}=]/,
      nameOf: (rest) => { const f = TEST_RE.rs_fn.exec(rest); return f && f[1]; } });
  } else if (ext === 'rb') {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; let m;
      if ((m = TEST_RE.rb.exec(l))) add(m[3], i, !!m[1]);
      else if ((m = TEST_RE.rb_def.exec(l))) add(m[1], i, false);
      else if ((m = TEST_RE.rb_bare.exec(l))) add(`it {${m[2]}`.replace(/\s+/g, ' '), i, !!m[1]);
    }
  } else if (ext === 'java' || ext === 'kt') {
    attributed(lines, { open: ['@'], mark: TEST_RE.jv_attr, skip: TEST_RE.jv_skip, add,
      nameOf: (rest) => { const f = ext === 'kt' ? TEST_RE.kt_fn.exec(rest) : TEST_RE.jv_fn.exec(rest); return f && !TEST_NOT_A_NAME.has(f[1]) ? f[1].replace(/`/g, '') : null; } });
  } else if (ext === 'cs') {
    let cls = '';
    attributed(lines, { open: ['['], mark: TEST_RE.cs_attr, skip: TEST_RE.cs_skip, add,
      before: (raw, at) => { const c = TEST_RE.cs_class.exec(raw); if (c && at < 0) cls = c[1]; },
      nameOf: (rest) => { const f = TEST_RE.cs_fn.exec(rest); return f && !TEST_NOT_A_NAME.has(f[1]) ? (cls ? `${cls}.${f[1]}` : f[1]) : null; } });
  } else if (ext === 'swift') {
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (TEST_RE.sw_attr.test(l) && at < 0) at = i;
      const f = TEST_RE.sw_fn.exec(l);
      if (f && (at >= 0 || /^test/.test(f[1]))) { add(f[1], at >= 0 ? at : i, /\.disabled\(/.test(lines.slice(Math.max(0, at), i + 1).join('\n'))); at = -1; }
      else if (at >= 0 && !f && /[{}]/.test(l) && !TEST_RE.sw_attr.test(l)) at = -1;
    }
  } else if (ext === 'ex' || ext === 'exs') {
    let skip = false;
    for (let i = 0; i < lines.length; i++) {
      if (TEST_RE.ex_skip.test(lines[i])) { skip = true; continue; }
      const m = TEST_RE.ex.exec(lines[i]); if (m) { add(m[1], i, skip); skip = false; }
      else if (lines[i].trim() && !/^\s*@/.test(lines[i])) skip = false;
    }
  }
  // what each test holds: the lines from its own to the next test's
  return found.map((t, k) => {
    const end = k + 1 < found.length ? found[k + 1].line : lines.length;
    // the test's own name is not part of what it holds: it('asserts the total', ...) is not an assertion
    const body = lines.slice(t.line, Math.max(end, t.line + 1)).join('\n').replace(t.name, '');
    const skipped = t.skipped || (path.endsWith('.go') ? /\bt\.Skip(?:f|Now)?\(/.test(body) : path.endsWith('.rb') ? /^\s*(?:skip|pending)\b/m.test(body) : path.endsWith('.py') ? /\bpytest\.skip\(|\bself\.skipTest\(/.test(body) : false);
    return { name: t.name, line: t.line, asserts: t.row ? -1 : assertsIn(body), skipped };
  });
}

// ---- Tests a change added, and took out again (0.8.17) ----------------------------------------------------------------
// The check holds the head against the base. An agent that writes tests early in a pull request, sees them go red and
// deletes them in a later commit ends with as many tests as the base holds, and every count reads "nothing changed". On
// real pull requests where a person wrote "you removed the tests" and no tool had sent anything back, this was the most
// common shape (proof-bench/outside-repos, 2026-11-19: 29 of 45).
// So the change's own commits are read, each against the base, for the tests it ADDS there by name. When an earlier
// commit added some and the last adds none, the report says so and names them (`testsTakenOut`). A note for a reader,
// never part of a verdict. Scored on 994 pull requests (proof-bench/per-test/RESULT.md): it speaks on 14 of 139 pull
// requests a person objected to, 6 of 270 matched ones nobody objected to, and none of 271 ordinary ones by an agent.
// The trigger is the NUMBER of tests added, not their names: a rename is a name gone, and by name alone half of what
// this spoke on among controls was a rename. Wider forms (half or fewer left) spoke on too much unobjected work.
// It reads at most the last 60 of the change's commits, and says nothing when a step touches more than 2,000 files it
// can read or a commit is not in the clone (a shallow one). Blobs are read from the object store; nothing is checked out.
const TESTS_READ_COMMITS = 60, TESTS_READ_FILES = 2000, TESTS_READ_BLOB = 2 * 1024 * 1024;
function testsAddedAt(repo, base, head, cache) {
  // the tests `head` adds over `base`, by name: Map name -> how many more of it. null: this step cannot be read.
  const g = (args, input) => execFileSync('git', args, { cwd: repo, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
  let parts; try { parts = g(['diff', '--name-status', '-z', '--no-renames', base, head]).toString('utf8').split('\0'); } catch { return null; }
  const changed = [];
  for (let i = 0; i + 1 < parts.length; i += 2) { const f = parts[i + 1]; if (TESTS_READ.has(testExt(f)) && !f.includes('\n')) changed.push({ st: parts[i][0], f }); }
  if (changed.length > TESTS_READ_FILES) return null;
  if (!changed.length) return new Map();
  const asks = []; for (const c of changed) { if (c.st !== 'A') asks.push([c, 'a', `${base}:${c.f}`]); if (c.st !== 'D') asks.push([c, 'b', `${head}:${c.f}`]); }
  let chk; try { chk = g(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], asks.map((a) => a[2]).join('\n') + '\n').toString('utf8').split('\n'); } catch { return null; }
  const want = new Map();
  asks.forEach((a, i) => { const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(chk[i] || ''); if (m && +m[2] <= TESTS_READ_BLOB) { a[0][a[1]] = `${m[1]}.${testExt(a[0].f)}`; if (!cache.has(a[0][a[1]])) want.set(a[0][a[1]], [m[1], a[0].f]); } });
  const todo = [...want.entries()];
  for (let i = 0; i < todo.length; i += 500) {
    const part = todo.slice(i, i + 500); let out; try { out = g(['cat-file', '--batch'], part.map(([, [sha]]) => sha).join('\n') + '\n'); } catch { return null; }
    let at = 0;
    for (const [k, [, f]] of part) {
      const nl = out.indexOf(10, at); if (nl < 0) return null;
      const size = +out.subarray(at, nl).toString('latin1').split(' ')[2]; if (!Number.isFinite(size)) return null;
      const body = out.subarray(nl + 1, nl + 1 + size); at = nl + 1 + size + 1;
      let names = []; if (!body.subarray(0, 8000).includes(0)) { try { names = testsIn(f, body.toString('utf8')).map((t) => t.name); } catch { names = []; } }
      cache.set(k, names);
    }
  }
  const tally = new Map(); const bump = (n, by) => tally.set(n, (tally.get(n) || 0) + by);
  for (const c of changed) { for (const n of (c.b && cache.get(c.b)) || []) bump(n, 1); for (const n of (c.a && cache.get(c.a)) || []) bump(n, -1); }
  return new Map([...tally].filter(([, v]) => v > 0));   // a test that moved to another changed file keeps its name and cancels
}
// steps: [{ base, head }] in order, the last one the change as it stands. -> { added, names, more, at } | null
export function testsTakenOut(repo, steps) {
  if (!Array.isArray(steps) || steps.length < 2) return null;
  const cache = new Map(); let most = null, at = null;
  for (let i = 0; i < steps.length; i++) {
    const adds = testsAddedAt(repo, steps[i].base, steps[i].head, cache); if (adds === null) return null;
    const n = [...adds.values()].reduce((a, b) => a + b, 0);
    if (i < steps.length - 1) { if (n > 0 && (!most || n > most.n)) { most = { n, names: [...adds.keys()] }; at = steps[i].head; } continue; }
    if (!most || n > 0) return null;                               // it added none before, or it still adds some
    const names = most.names.sort();
    return { added: most.n, names: names.slice(0, 10), more: Math.max(0, names.length - 10), at: short(repo, at) };
  }
  return null;
}
// The change's own commits, oldest first, each with the commit it is held against. Behind GitHub's merge of a pull
// request (its checkout is a merge of the head into the base) the commits are those of the second parent. A branch that
// took the base in again is held, from that commit on, against the point where it then left the base.
function changeSteps(repo, base, head) {
  const g = (...a) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const b = g('rev-parse', '--verify', '--quiet', `${base}^{commit}`), h = g('rev-parse', '--verify', '--quiet', `${head}^{commit}`); if (!b || !h) return null;
  const ps = (g('rev-list', '--parents', '-n', '1', h) || '').split(' ');
  const tip = ps.length === 3 && ps[1] === b ? ps[2] : h;
  const fork = g('merge-base', b, tip); if (!fork) return null;
  const list = (g('rev-list', '--first-parent', '--parents', '--reverse', `${fork}..${tip}`) || '').split('\n').filter(Boolean).map((l) => l.split(' '));
  if (list.length < 2) return null;
  let from = fork; const steps = [];
  for (const [c, ...parents] of list) { if (parents.length > 1) from = g('merge-base', b, c) || from; steps.push({ base: from, head: c }); }
  return steps.slice(-TESTS_READ_COMMITS);
}

// ---- The comment on a pull request: one, edited in place, and only when there is something to say -------------------
// Until 0.8.15 the Action posted a new comment on every push, a pass included. A check that speaks on every push is
// one a maintainer mutes, and then its one real sentence is not read either. So:
// - It keeps ONE comment. It knows its own by a hidden first line that names the workflow and job, AND by its author
//   (the Actions bot): a person who copies the line is not written over, and a second workflow has its own comment.
// - It speaks when the job would fail, when a reason was used (that is the record), when a file lost tests or
//   assertions while the total held, when the check's own definition changed, or when it could not run at all.
// - A plain pass says nothing. The watch-notes of a full contract (a new dependency, the shape of the repo) and a note
//   about the environment do not open a comment: they are in the job summary on every run, and in the comment when
//   there is one. `comment: always` gives the whole report every time; `comment: false` gives none.
// - A comment about an earlier push is never left standing on a push that passes: it is edited to one short line.
// `commentOnly`: the job never fails, and the comment says what would have been sent back.
// Pure: what to do is returned, and the Action's own shell does it. { action: 'none' | 'create' | 'update', id, body,
// summary, wouldFail }.
const BOT = 'github-actions[bot]';
const markerFor = (key) => `<!-- sawbuck-check: ${String(key || '').replace(/[^A-Za-z0-9 _.\/-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'check'} -->`;
export function commentPlan(input = {}) {
  const { report = null, error = '', comments = [], note = '' } = input;
  const exit = Number(input.exit) || 0, mode = String(input.comment ?? 'true'), commentOnly = input.commentOnly === true;
  const wouldFail = exit !== 0 && !(exit === 3 && input.inconclusive === 'pass');
  const marker = markerFor(input.key);
  const mine = [...(comments || [])].reverse().find((c) => c && c.user && c.user.login === BOT && String(c.body || '').split('\n')[0].trim() === marker);
  const readable = !!report && typeof report === 'object' && Array.isArray(report.metrics) && typeof report.verdict === 'string';
  let full, speaks;
  if (!readable) {
    // the run did not get as far as a verdict (a config that cannot be read, a base commit that is not in the clone)
    // the engine's own line when it wrote one (they begin with its name), else the last thing printed
    const lines = String(error || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    const line = [...lines].reverse().find((l) => /^promptwheel\b/.test(l)) || lines[lines.length - 1] || '';
    const why = line ? `> ${line.slice(0, 300)}` : '';
    full = ['### ⚠️ Sawbuck: could not run', `Nothing was checked on this push${why ? ':' : '.'}`, ...(why ? [why] : []), ...(commentOnly ? ['This check only comments here. It never fails the job.'] : []), MD_FOOT].join('\n\n');
    speaks = true;
  } else {
    speaks = wouldFail || !!(report.allowed && (report.allowed.cleared || []).length) || report.metrics.some((m) => m.lostIn && m.lostIn.length) || !!report.testsTakenOut || !!(report.gate && report.gate.changed);
    full = null;
  }
  const render = (fold) => (readable ? renderMarkdown(report, { fold, commentOnly, wouldFail, note: wouldFail ? note : '' }) : full);
  const summary = render(false);
  if (mode === 'false') return { action: 'none', body: '', summary, wouldFail };
  let text = '';
  if (speaks || mode === 'always') text = render(true);
  else if (mine) text = [`### ✅ Sawbuck: passes`, `Nothing to add on this push (\`${report.base} → ${report.head}\`). What this comment said about an earlier push is in its edit history.`, MD_FOOT].join('\n\n');
  if (!text) return { action: 'none', body: '', summary, wouldFail };
  // GitHub takes 65,536 characters in a comment and refuses a longer one whole: cut it, and say where the rest is
  if (text.length > 60000) text = `${text.slice(0, 60000)}\n\n(Cut short: the whole report is in the job summary.)`;
  const body = `${marker}\n${text}`;
  if (mine && String(mine.body || '').trim() === body.trim()) return { action: 'none', body: '', summary, wouldFail };
  return mine ? { action: 'update', id: mine.id, body, summary, wouldFail } : { action: 'create', body, summary, wouldFail };
}

function parseArgs(argv) {
  const a = { json: false, detectGaming: true };   // reward-hack detection is ON by default; --no-detect-gaming opts out
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--head') a.head = argv[++i];
    else if (argv[i] === '--repeat') a.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--working') a.working = true;
    else if (argv[i] === '--no-auto') a.noAuto = true;
    else if (argv[i] === '--no-record') a.noRecord = true;
    else if (argv[i] === '--label') a.label = argv[++i];
    else if (argv[i] === '--attempt') a.attempt = argv[++i];
    else if (argv[i] === '--goal') a.goal = argv[++i];
    else if (argv[i] === '--turns') a.turns = parseInt(argv[++i], 10);
    else if (argv[i] === '--patience') a.patience = parseInt(argv[++i], 10);
    else if (argv[i] === '--since') a.since = argv[++i];
    else if (argv[i] === '-n' || argv[i] === '--limit') a.n = parseInt(argv[++i], 10);
    else if (argv[i] === '--allow') a.allow = argv[++i];
    else if (argv[i] === '--detect-gaming') { a.detectGaming = true; a.dgExplicit = true; }
    else if (argv[i] === '--no-detect-gaming') { a.detectGaming = false; a.dgExplicit = true; }
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--markdown') a.markdown = true;
    else if (argv[i] === '--runs') a.runs = parseInt(argv[++i], 10);
    else if (argv[i] === '--base-cache') a.baseCache = argv[++i];
    else if (argv[i] === '--metric') a.metric = argv[++i];
  }
  return a;
}

// pure, side-effect-free helpers are exported for unit testing; the CLI below only
// runs when this file is executed directly (not when imported by the test suite).
export { MISSING_DEP, extract, evaluate, median, spread, renderMarkdown, isNonSource, evaluatorMatcher, gain, judgeGaming, verdictFingerprint, foldOutcomes, betaMean, scoreKey };

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
//   baseCache     string   a folder outside the repo that keeps the base's measurement between runs (--base-cache)
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

  const report = gate(repo, {
    base: options.base,
    head: options.head,
    working: options.working,
    config,
    repeat: options.repeat,
    detectGaming: options.detectGaming ?? true,
    allow: options.allow,
    baseCache: options.baseCache,
  });
  // the library writes no row unless asked: a caller that keeps its own record (Sawbuck) decides
  if (options.record === true) recordRun(repo, report, config ?? loadConfig(repo), { label: options.label });
  return report;
}

// changeCounts(options) -> { [metric name]: { delta, files: { path: [before, after] } } | null } | null
// The change in each counting tripwire between two commits, read from the files the change touched alone: no commit
// is checked out and no test is run, so a caller can read every commit of a pull request in the time one check takes.
// `delta` is after minus before, and equals the change in the whole-tree count. A metric that is not one of the
// counting greps `init` writes reads null. The whole result is null when the change could not be read.
//   repo, base, head, config: as for check()
export function changeCounts(options = {}) {
  let start = process.cwd();
  if (options.repo) { try { start = realpathSync(options.repo); } catch { bad(`promptwheel: not inside a git repository (${options.repo})`); } }
  const repo = repoRoot(start);
  const cfg = options.config ?? loadConfig(repo);
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.metrics)) bad('promptwheel changeCounts: options.config.metrics must be an array');
  const base = resolveBase(repo, options.base), head = options.head || 'HEAD';
  ensureCommit(repo, base, 'base'); ensureCommit(repo, head, 'head');
  const change = readChange(repo, base, head, cfg.metrics, cfg);
  if (!change) return null;
  return Object.fromEntries(cfg.metrics.filter((m) => m && m.name).map((m) => {
    const files = change.get(m.name);
    return [m.name, files ? { delta: Object.values(files).reduce((n, [b, a]) => n + a - b, 0), files } : null];
  }));
}

// noiseBand(samples, repeat) -> the noise band a metric with these readings needs, or null with fewer than two readings.
// It asks: with `repeat` runs a side, how far apart do two medians land when nothing changed? Pairs of groups are drawn
// from the readings, and the band is the gap that 95 of 100 pairs stay inside. The draw has a fixed seed, so the same
// readings give the same band. More runs a side narrow it, where the widest gap between repeats only grows.
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function noiseBand(samples, repeat = 1, pairs = 4000) {
  const xs = (samples || []).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (xs.length < 2) return null;
  const rnd = seeded(1), n = Math.max(1, repeat | 0);
  const one = () => { const g = []; for (let i = 0; i < n; i++) g.push(xs[Math.floor(rnd() * xs.length)]); return median(g); };
  const gaps = []; for (let i = 0; i < pairs; i++) gaps.push(Math.abs(one() - one()));
  gaps.sort((p, q) => p - q);
  return +gaps[Math.ceil(0.95 * gaps.length) - 1].toPrecision(6);
}

// calibrate(options) -> { ref, runs, repeat, metrics: [{ name, runs, median, spread, noise }] }
// Measures the noise band each metric needs, so nobody has to guess the number: runs the metric `runs` times at one
// commit, in a throwaway worktree, and gives the band for `repeat` runs a side (noiseBand). A pass or fail metric and
// an exact one take no band and are left out. It writes nothing: a band goes into the contract by a person's hand, as
// "noise" on the metric, and counts from the change after the one that adds it.
//   repo, config: as for check()        ref: the commit to measure at (default HEAD)
//   runs: readings per metric (default 20, at least 4)     repeat: runs a side (default config.repeat ?? 1)
//   metric: measure only this one
export function calibrate(options = {}) {
  let start = process.cwd();
  if (options.repo) { try { start = realpathSync(options.repo); } catch { bad(`promptwheel: not inside a git repository (${options.repo})`); } }
  const repo = repoRoot(start);
  const cfg = options.config ?? loadConfig(repo);
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.metrics)) bad('promptwheel calibrate: options.config.metrics must be an array');
  const runs = options.runs ?? 20, repeat = Math.max(1, options.repeat ?? cfg.repeat ?? 1);
  if (!Number.isInteger(runs) || runs < 4) bad('promptwheel calibrate: runs must be a whole number, 4 or more');
  const ref = options.ref || 'HEAD'; ensureCommit(repo, ref, 'calibrate');
  const takes = (m) => m && m.name && (m.direction || 'up') !== 'pass' && m.exact !== true && m.extract !== 'exit';
  const defs = cfg.metrics.filter((m) => takes(m) && (!options.metric || m.name === options.metric));
  if (options.metric && !defs.length) bad(`promptwheel calibrate: no metric named "${options.metric}" that takes a band (a pass or fail metric and an exact one take none)`);
  const got = defs.length ? measureAt(repo, ref, { ...cfg, metrics: defs }, runs) : {};
  return { ref: short(repo, ref), runs, repeat, metrics: defs.map((m) => {
    const xs = (got[m.name] || []).filter((x) => x != null);
    return { name: m.name, runs: xs.length, median: median(xs), spread: spread(xs), noise: xs.length === runs ? noiseBand(xs, repeat) : null };
  }) };
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
    if (m.noise !== undefined && !(isNum(m.noise) && m.noise >= 0)) E(`${at}.noise must be a number >= 0 (the noise band, measured across the repeats or declared in the contract; repeat count is the top-level report.repeat)`);
    if (m.spread !== undefined && !(isNum(m.spread) && m.spread >= 0)) E(`${at}.spread must be a number >= 0 (the widest gap between repeats, reported when the band was declared)`);
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
      if (report.gate.goalposts !== undefined && !(Array.isArray(report.gate.goalposts) && report.gate.goalposts.every((x) => typeof x === 'string' && x))) E('gate.goalposts must be an array of paths');
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
  // the optional list of what a declared reason can let through in this run, by name (report.allowable)
  if (report.allowable !== undefined && !(Array.isArray(report.allowable) && report.allowable.length && report.allowable.every((x) => typeof x === 'string' && x))) E('allowable must be a non-empty array of names');

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
// the next argument; anything not starting with `-` is positional. --no-record checks without adding a row
// to the record (Sawbuck and some CI steps pass it). `improve` is not in the table: it is the loop step's, which
// refuses a flag it does not know, and takes no --allow (a person lets a change through, not a loop).
const GATE_FLAGS = ['--base', '--head', '--repeat', '--working', '--no-record', '--no-auto', '--allow', '--detect-gaming', '--no-detect-gaming', '--json', '--markdown', '--label', '--base-cache'];
const COMMAND_FLAGS = {
  run: GATE_FLAGS, init: ['--preset', '--list', '--force', '--no-agent-block'], lock: [], calibrate: ['--runs', '--repeat', '--metric', '--json'],
  insights: ['--json'], playbook: ['--json'], suggest: ['--json'],
  backfill: ['-n', '--limit', '--since', '--repeat', '--no-auto', '--detect-gaming', '--no-detect-gaming'],
};
// what each valued flag needs. A missing or unusable value is a usage error too: `--repeat abc` must not
// measure nothing and read FAIL, and `--allow` with nothing after it must not run as if no reason was asked for.
const VALUED_FLAGS = { '--base': 'a ref', '--head': 'a ref', '--repeat': 'a whole number, 1 or more', '--allow': 'a reason, e.g. --allow "the spec changed"', '--preset': 'a preset name (see promptwheel init --list)',
  '--attempt': 'a command that changes the repo, e.g. --attempt "claude -p \'fix the failing test\'"', '--label': 'a short name for this change, e.g. --label "cache the lookup"',
  '--goal': 'the name of a measure in the contract, e.g. --goal lint_errors',
  '--turns': 'a whole number, 1 or more', '--patience': 'a whole number, 1 or more',
  '--since': 'a ref', '-n': 'a whole number, 1 or more', '--limit': 'a whole number, 1 or more',
  '--runs': 'a whole number, 4 or more', '--metric': 'a metric name', '--base-cache': 'a folder outside the repository' };
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
    if ((a === '--repeat' || a === '-n' || a === '--limit' || a === '--turns' || a === '--patience') && !/^[1-9]\d*$/.test(v)) bad(`promptwheel ${cmd}: ${a} needs ${VALUED_FLAGS[a]} (got "${v}")`);
    if (a === '--runs' && !(/^[1-9]\d*$/.test(v) && Number(v) >= 4)) bad(`promptwheel ${cmd}: --runs needs ${VALUED_FLAGS[a]} (got "${v}")`);
  }
}

// calibrate: print the band each metric needs, and the line to write in the contract. Nothing is written.
function calibrateCmd(argv) {
  const a = parseArgs(argv);
  const c = calibrate({ runs: a.runs, repeat: a.repeat, metric: a.metric });
  if (a.json) { console.log(JSON.stringify(c, null, 2)); return; }
  console.log(`\nPromptWheel calibrate: ${c.runs} runs of each metric at ${c.ref}, for ${c.repeat} ${c.repeat === 1 ? 'run' : 'runs'} a side\n`);
  if (!c.metrics.length) { console.log('  no metric here takes a band (a pass or fail metric and an exact one take none)\n'); return; }
  console.log(`  ${'metric'.padEnd(18)} ${'runs'.padStart(5)} ${'median'.padStart(12)} ${'widest gap'.padStart(12)} ${'band'.padStart(12)}`);
  for (const m of c.metrics) console.log(`  ${m.name.padEnd(18)} ${String(m.runs).padStart(5)} ${String(m.median).padStart(12)} ${String(m.spread).padStart(12)} ${String(m.noise ?? 'none').padStart(12)}`);
  console.log('\n  The band is the gap two medians stay inside 95 times in 100 when nothing changed.');
  for (const m of c.metrics) console.log(m.noise != null
    ? `  ${m.name}: write it on the metric in promptwheel.config.json as  "noise": ${m.noise}`
    : `  ${m.name}: ${m.runs} of ${c.runs} runs gave a number, so no band is given`);
  console.log('  A band holds for this repeat count and this scorer. Measure again when either changes.\n');
}

// read PR comments on stdin: a JSON array, or one comment per line as `gh api --paginate --jq '.[]'` prints every
// page. Streamed: readFileSync(0) corrupted the heap on Node 24.22 reading a live paginated gh pipe.
// --author <login>: the account that opened the pull request; its own comment does not count, unless the contract at
// --base <ref> holds "allowFromAuthor": true (read from that commit, so a pull request cannot say so for itself).
// --note <file>: when the only approval was the opener's, one line saying so, for the comment the check posts.
// a JSON array, or one comment per line (every page `gh api --paginate --jq '.[]'` prints); [] when it cannot be read
function readComments(text) {
  const t = String(text || '').trim();
  try { return [].concat(JSON.parse(t || '[]')); } catch { try { return t.split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
}
async function prAllow(argv = []) {
  const val = (f) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? String(argv[i + 1]) : ''; };
  const author = val('--author'), base = val('--base'), note = val('--note');
  let t = ''; process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) t += chunk;
  const c = readComments(t);
  let own = false;
  if (author && base) { try { own = ((gateDefAtRef(process.cwd(), base) || {}).scalars || {}).allowFromAuthor === true; } catch { /* no contract at the base: the opener does not count */ } }
  const d = allowDecision(c, { author, allowFromAuthor: own });
  if (note) { try { writeFileSync(note, d.skipped && !d.reason ? `\n> ✋ **Not counted:** a \`sawbuck-allow:\` comment from \`${d.skipped}\`, the account that opened this pull request. Whoever opened a pull request cannot let it through. Someone else with write access can. In a repo with one person in it, set \`"allowFromAuthor": true\` in \`promptwheel.config.json\` on the base branch; a pull request cannot turn that on for itself.\n` : ''); } catch { /* the note is a courtesy */ } }
  process.stdout.write(d.reason);
}

// pr-comment: what the Action does with the comment, decided here so the Action's shell stays thin (commentPlan).
// Prints one word: `none`, `create`, or `update:<comment id>`. Writes the comment to --body (empty for `none`) and
// adds the whole report to --summary. A file that is missing or empty reads as nothing; a flag it does not know is a
// usage error, so a typo in a workflow cannot switch comment-only off in silence.
const PR_COMMENT_FLAGS = ['--report', '--exit', '--error', '--comments', '--key', '--note', '--comment', '--inconclusive', '--comment-only', '--body', '--summary'];
function prComment(argv = []) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!PR_COMMENT_FLAGS.includes(argv[i])) bad(`promptwheel pr-comment: unknown flag ${argv[i]} (it takes ${PR_COMMENT_FLAGS.join(', ')})`);
    if (argv[i + 1] === undefined) bad(`promptwheel pr-comment: ${argv[i]} needs a value`);
    o[argv[i].slice(2)] = String(argv[i + 1]);
  }
  for (const [k, ok] of [['comment', ['true', 'always', 'false']], ['inconclusive', ['fail', 'pass']], ['comment-only', ['true', 'false']]]) if (o[k] !== undefined && !ok.includes(o[k])) bad(`promptwheel pr-comment: --${k} is ${ok.join(' or ')} (got "${o[k]}")`);
  const read = (f) => { try { return f ? readFileSync(f, 'utf8') : ''; } catch { return ''; } };
  let report = null; try { report = JSON.parse(read(o.report)); } catch { /* the run printed no report: it could not run */ }
  const p = commentPlan({ report, exit: o.exit, error: read(o.error), comments: readComments(read(o.comments)), key: o.key, note: read(o.note), comment: o.comment, inconclusive: o.inconclusive, commentOnly: o['comment-only'] === 'true' });
  if (o.body) writeFileSync(o.body, p.body ? p.body + '\n' : '');
  if (o.summary) { try { appendFileSync(o.summary, p.summary + '\n'); } catch { /* the summary is a courtesy */ } }
  process.stdout.write(p.action === 'update' ? `update:${p.id}\n` : `${p.action}\n`);
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
  // `promptwheel run --help` is a help request, not a gate run. `improve --help` goes to the loop step, whose page is fuller
  const cmd = (first !== 'improve' && (rest.includes('--help') || rest.includes('-h'))) ? 'help' : first;
  if (cmd in COMMAND_FLAGS) checkFlags(cmd, rest);
  if (cmd === 'run') run(rest);
  else if (cmd === 'pr-allow') return prAllow(rest);
  else if (cmd === 'pr-comment') prComment(rest);
  else if (cmd === 'init') init(rest);
  else if (cmd === 'lock') return lock(rest);
  else if (cmd === 'improve') return improve(rest);
  else if (cmd === 'insights') insights(rest);
  else if (cmd === 'playbook') playbook(rest);
  else if (cmd === 'suggest') suggest(rest);
  else if (cmd === 'backfill') backfill(rest);
  else if (cmd === 'calibrate') calibrateCmd(rest);
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
      '       re-proves each win from SOURCE edits alone BY DEFAULT (verdict GAMED,',
      '       exit 2, when a metric only moved by editing tests/config/grader). Use --no-detect-gaming for the bare gate.',
      '  promptwheel run --working                    gate uncommitted changes (incl. newly added files)',
      '  promptwheel improve --attempt "<cmd>" [--target <measure>] [--label "<name>"] [--json]   the loop: run any agent or script, check what it changed, and keep it (one commit) only if the target improved;',
      '                                               if not, the tree is put back. Exit 0 kept · 1 a guard got worse · 2 gamed · 3 nothing improved. The tree must be clean first.',
      '                                               It runs the loop step that ships beside the engine (examples/improve-loop/improve.mjs), the one keeper. --goal is another name for --target.',
      '                                               Also --cheaper, --floor, --repeat, --base-cache, --may-change "<patterns>": see that file, or node examples/improve-loop/improve.mjs.',
      '  promptwheel improve --attempt "<cmd>" --turns N [--patience P]   judge over a number of turns: each turn goes on from the last, the whole change so far is checked against the start,',
      '                                               the reading is handed to the next turn (PW_FEEDBACK, PW_TURN, PW_TURNS), and the best turn is kept as one commit.',
      '  promptwheel improve --plan <file> [--arm <name>]   many tries under a plan committed first: what a try may touch, how many tries, when to stop, a held-out',
      '                                               number at both ends. Each try runs in a copy of the tree (a copy, not a sandbox). See examples/improve-loop/run.mjs.',
      '  promptwheel improve --report [--json]        every try on the loop\'s record, and whether the record, the kept changes and the runs\' account agree.',
      '  promptwheel insights [--json]                how each measure has responded, from the record of checked runs (kept in the git folder, never in the tree; run --no-record adds no row)',
      '  promptwheel playbook [--json]                what has paid here, and what the loop tried and threw away, with the measured reason',
      '  promptwheel suggest [--json]                 where to spend the next attempt (a lever that has paid, or what was tried least)',
      '  promptwheel backfill [-n N | --since <ref>]  fill the record from past commits (marked backfill; a commit\'s type becomes its label)',
      '  promptwheel run --base-cache <dir>           keep the base\'s measurement in <dir> (a folder outside the repo) and reuse it for the same tree, so a loop asks a slow or paid scorer about the base once',
      '  promptwheel calibrate [--metric M] [--runs N] [--repeat N] [--json]   measure the noise band a metric needs: runs it N times (20) at HEAD and prints the band for the repeat count, to write on the metric as "noise". For a score that does not hold still. Writes nothing',
      '  promptwheel pr-allow < comments.json         print the newest `sawbuck-allow: <reason>` from a PR comment by someone with write access (the Action uses it;',
      '                                               --author <login> leaves out the account that opened the PR, unless the contract at --base <ref> says "allowFromAuthor": true)',
      '  promptwheel pr-comment --report <file> ...   what the Action does with its one comment on a pull request: prints none, create or update:<id>, and writes the comment (the Action uses it)',
      '  promptwheel run --allow "<reason>"           acknowledge an intentional test/config change (or a `Promptwheel-Allow: <reason>` commit trailer; `Sawbuck-Allow:` is an alias): recorded, not flagged GAMED. With more than one thing to let through, the reason names each: --allow "tests_pass, contract-frozen: <reason>"',
      '',
      'Exit codes: 0 pass · 1 fail (a guarded metric regressed, or a mandate was violated) · 2 gamed · 3 inconclusive · 64 usage or config error (never a verdict).',
      'Integrate (library / conform / shell): see INTEGRATE.md. Import: `import { check } from \'promptwheel\'`.',
      'Config:   promptwheel.config.json → { extends?, metrics:[{ name, cmd, direction, extract?, guard? }] }   (or: promptwheel init)',
      '          extends: a path (or array) to a shared base config, repos INHERIT its guards; local metrics override by name.',
    ].join('\n'));
    process.exit(help ? 0 : EX_USAGE);
  }
}

// run the CLI only when invoked directly (resolves symlinks so the npm bin still works)
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* not main */ }
async function main() {
  ownGitOn();   // every command: the engine's own git calls run no hook, no fsmonitor command, read no replace object
  try { await dispatch(); }
  catch (e) { if (e && e.name === 'ConfigError') die(e.message); throw e; }
}
if (isMain) main();
