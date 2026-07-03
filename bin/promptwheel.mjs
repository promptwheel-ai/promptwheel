#!/usr/bin/env node
// PromptWheel — the per-turn reward for AI coding loops (a.k.a. the outcome gate for AI code).
//
// For any change (base ref → head ref), measure each configured metric in an
// isolated git worktree BEFORE and AFTER, enforce regression guards, and refuse
// to trust a delta that sits inside the measurement noise band. Emits a
// structured {verdict, metric, delta, confidence}. The thing base agents don't do:
// verify a real number moved — not just "the diff applied / tests passed".
//
// Zero deps, zero build. Node 18+.
//   promptwheel run [--base R] [--head R] [--repeat N] [--json]

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, appendFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
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

function readConfigFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.error(`invalid config ${p}: ${e.message}`); process.exit(2); }
}

const relOf = (repo, p) => { try { return relative(repo, p) || p; } catch { return p; } };

// resolve a config + its `extends` chain into a flat, provenance-tagged metric list.
// `extends` is a path (or array of paths) to base configs, relative to the config file:
// a repo INHERITS their guardrails, and a local metric of the same name overrides the inherited one.
function resolveConfig(p, repo, label, seen) {
  const abs = realpathSync(p);
  if (seen.has(abs)) { console.error(`config inheritance cycle at ${relOf(repo, p)}`); process.exit(2); }
  seen.add(abs);
  try {
    const cfg = readConfigFile(p);
    const byName = new Map();
    const scalars = {};
    for (const ref of [].concat(cfg.extends || [])) {
      const bp = isAbsolute(ref) ? ref : join(dirname(p), ref);
      if (!existsSync(bp)) { console.error(`extends target not found: ${ref} (from ${relOf(repo, p)})`); process.exit(2); }
      const base = resolveConfig(bp, repo, relOf(repo, bp), seen);
      for (const m of base.metrics) byName.set(m.name, m);
      for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'record', 'gamingThreshold']) if (base[k] !== undefined) scalars[k] = base[k];
    }
    for (const m of (cfg.metrics || [])) {
      byName.set(m.name, { ...m, __src: label, __override: byName.has(m.name) });
    }
    for (const k of ['repeat', 'linkNodeModules', 'linkDirs', 'env', 'setup', 'record', 'gamingThreshold']) if (cfg[k] !== undefined) scalars[k] = cfg[k];
    return { ...scalars, metrics: [...byName.values()] };
  } finally {
    seen.delete(abs); // only ACTIVE ancestors are a cycle — a diamond (a base reached two ways) is fine
  }
}

function loadConfig(repo) {
  const candidates = ['promptwheel.config.json', 'outcome-gate.config.json']; // back-compat alias
  const p = candidates.map((c) => join(repo, c)).find(existsSync);
  if (!p) { console.error('no promptwheel.config.json — run: promptwheel init   (writes one for your stack)'); process.exit(2); }
  const cfg = resolveConfig(p, repo, 'local', new Set());
  if (!Array.isArray(cfg.metrics) || cfg.metrics.length === 0) {
    console.error('config.metrics must be a non-empty array'); process.exit(2);
  }
  return cfg;
}

function resolveBase(repo, base) {
  if (base) return base;
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    try { return git(['merge-base', 'HEAD', b], repo); } catch { /* keep trying */ }
  }
  return git(['rev-parse', 'HEAD~1'], repo);
}

function runMetric(cwd, m, env) {
  let stdout = '', code = 0;
  try {
    stdout = execSync(m.cmd, { cwd, env: env || process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: (m.timeoutSec ?? 300) * 1000 });
  } catch (e) { code = e.status ?? 1; stdout = `${e.stdout || ''}${e.stderr || ''}`; }
  return extract(stdout, code, m.extract);
}

// extract modes: 'number' (last number, default) | 'lines' | 'exit' | {regex}
function extract(stdout, code, mode) {
  mode = mode || 'number';
  if (mode === 'exit') return code === 0 ? 1 : 0;
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
// not here — the engine stays ecosystem-agnostic.
function bridgeEnv(repo, wt, cfg) {
  const linkDirs = Array.isArray(cfg.linkDirs) ? cfg.linkDirs : (cfg.linkNodeModules === false ? [] : ['node_modules']);
  for (const d of linkDirs) {
    if (existsSync(join(repo, d)) && !existsSync(join(wt, d))) {
      try { symlinkSync(join(repo, d), join(wt, d)); } catch { /* best effort */ }
    }
  }
  if (!cfg.env) return process.env;
  return { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v).replaceAll('{wt}', wt)])) };
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
  else if (!sampledNoise) confidence = 'unverified';       // single read — noise unknown; run --repeat to trust
  else if (noise === 0) confidence = 'high';
  else if (withinNoise) confidence = 'low';                // delta is inside the jitter — not real
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
  // missing script, failed install) — surface it instead of folding into a green verdict.
  const inert = !!m.guard && dir === 'pass' && before === 0 && after === 0;
  return { before, after, delta, status, ok, confidence, noise, ...(inert ? { inert: true } : {}) };
}

// ---------------------------------------------------------------------------
// gaming detection (antihack): re-prove a "win" using ONLY the agent's source edits.
// If the improvement evaporates once test/config/grader/golden changes are reverted,
// the agent moved the goalposts (edited the test, mocked the grader, suppressed the
// lint rule, deleted the feature) instead of earning it. Pure arithmetic, fully
// explainable — the thing the loop-owner structurally won't ship about its own agent.
// ---------------------------------------------------------------------------
const NON_SOURCE = [
  /(^|\/)(tests?|__tests?__|spec|e2e|fixtures|snapshots|__snapshots__|__mocks__)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)tests?\.[cm]?[jt]sx?$/i,                 // a file literally named test.js / tests.ts
  /(^|\/)test_[^/]*\.py$/i, /_test\.py$/i, /(^|\/)conftest\.py$/i,
  /\.snap$/i, /(^|\/)golden[^/]*$/i, /\.golden$/i,
  /(^|\/)(eval|grader|score)[^/]*\.[cm]?[jt]s$/i,
  // config files only — require a .config/.conf/.setup segment so PRODUCTION source that
  // happens to be named after a tool (e.g. src/installers/eslint.ts) is NOT swept out of
  // the source slice (a false sweep here can flag an honest win as GAMED).
  /(^|\/)(jest|vitest|playwright|cypress|karma|babel|eslint|pytest)[^/]*\.(config|conf|setup)\.[^/]+$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)\.(eslintrc|babelrc|prettierrc)[^/]*$/i,
  /(^|\/)(pytest\.ini|setup\.cfg|\.flake8|tox\.ini|eslint\.config\.[cm]?js)$/i,
];
const isNonSource = (p) => NON_SOURCE.some((re) => re.test(p));

// split the agent's changed files into production-source vs test/config/grader/golden
function changedSourcePaths(repo, base, head) {
  const all = git(['diff', '--name-only', base, head], repo).split('\n').filter(Boolean);
  return { source: all.filter((p) => !isNonSource(p)), nonSource: all.filter(isNonSource) };
}

// coarse change-location fingerprint for the outcome record: top source dirs of the diff
function subsystemsOf(repo, base, head) {
  try {
    const counts = {};
    for (const p of changedSourcePaths(repo, base, head).source) {
      const d = p.includes('/') ? p.slice(0, p.indexOf('/')) : '(root)';
      counts[d] = (counts[d] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
  } catch { return []; }
}

// measure `metric` in a worktree at `base` with ONLY the source slice of base→head applied.
function measureSourceOnly(repo, base, head, metric, cfg, repeat) {
  const { source } = changedSourcePaths(repo, base, head);
  if (!source.length) return { samples: [], hadSourceChange: false }; // a "win" with zero source edits = goalposts moved
  const wt = mkdtempSync(join(tmpdir(), 'promptwheel-src-'));
  git(['worktree', 'add', '--quiet', '--detach', wt, base], repo);
  try {
    const env = bridgeEnv(repo, wt, cfg);
    const patch = git(['diff', base, head, '--', ...source], repo);
    if (patch.trim()) {
      const tryApply = (extra) => { execFileSync('git', ['apply', '--whitespace=nowarn', ...extra], { cwd: wt, input: patch + '\n', encoding: 'utf8' }); };
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
// gamed = source edits alone reproduce less than `threshold` of the gain (default 0.5 — the
// rest came from editing the goalposts). Tune via `gamingThreshold` (config-level or per-metric).
function judgeGaming(m, srcResult, threshold = 0.5) {
  if (!srcResult.hadSourceChange) return { gamed: true, sourceOnly: null, retained: 0, reason: 'the "win" changed zero production-source files — only test/config/grader/golden' };
  if (srcResult.applyFailed) return { gamed: null, sourceOnly: null, retained: null, reason: 'source-only patch did not apply cleanly — inconclusive' };
  const sourceOnly = median(srcResult.samples);
  const full = gain(m, m.before, m.after);
  if (full == null || full <= 0) return { gamed: false, sourceOnly, retained: 1, reason: 'no real improvement to re-prove' };
  const retained = +(gain(m, m.before, sourceOnly) / full).toFixed(3);
  const gamed = retained < threshold;
  return { gamed, sourceOnly, retained, reason: gamed
    ? `only ${(retained * 100).toFixed(0)}% of the gain survives when test/config/grader changes are reverted (threshold ${(threshold * 100).toFixed(0)}%) — most of the "win" came from editing the goalposts`
    : `${(retained * 100).toFixed(0)}% of the gain survives source-only — the source earned it` };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// snapshot the working tree (tracked + untracked) into a dangling commit WITHOUT
// touching the real index or files — so a gate/improve sees a file an agent just added.
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

// self-heal: a hard-killed run (SIGKILL / power loss) can leave an orphaned worktree —
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
      if (tracked.has(p)) continue;                 // a live/registered worktree — leave it
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
  } catch { /* cleanup must never block the gate */ }
}

// Python editable installs (src-layout `pip install -e .`) can pin imports to the ORIGINAL
// checkout: the worktree's tests then import your current tree at BOTH refs and every delta
// reads 0 — the gate is structurally blind on that repo shape. Undetectable from the verdict
// (it looks like "unchanged"), so detect the editable install itself and warn. Verified by a
// controlled repro (CHANGELOG 0.2.2).
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
    if (out === 'HIT') console.error('⚠ editable install of this repo detected (pip install -e): worktree measurements may import your ORIGINAL checkout, not the measured ref — deltas can read 0. Use a non-editable install in the measuring venv, or put the worktree src on PYTHONPATH.');
  } catch { /* no python / cannot tell — stay quiet */ }
}

// the shared core: measure a change (base→head) and return the structured report
function gate(repo, opts) {
  selfHeal(repo);
  warnEditableInstall(repo);
  const cfg = loadConfig(repo);
  const repeat = Math.max(1, opts.repeat ?? cfg.repeat ?? 1);

  let base, head;
  if (opts.working) {
    // measure uncommitted changes — tracked AND untracked — via a temp-index snapshot;
    // never touches the real index or working tree. (A loop agent's most common action
    // is to ADD a file; `git stash create` omits untracked, which silently reverted them.)
    try { git(['rev-parse', '--verify', 'HEAD'], repo); }
    catch { console.error('no commits yet — make an initial commit before gating --working changes'); process.exit(2); }
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
  // antihack: re-prove every actual win with the agent's source edits alone
  if (opts.detectGaming) {
    for (const m of metrics) {
      if (m.status !== 'improved') continue;
      const cm = cfg.metrics.find((c) => c.name === m.name);
      if (cm.gamingCheck === false) continue;   // tripwire / test-side guards aren't re-proven from source (their gain legitimately lives in test files)
      const j = judgeGaming(m, measureSourceOnly(repo, base, head, cm, cfg, repeat), cm.gamingThreshold ?? cfg.gamingThreshold ?? 0.5);
      m.gamed = j.gamed; m.sourceOnly = j.sourceOnly; m.retained = j.retained; m.gamingReason = j.reason;
    }
  }
  const failed = metrics.some((m) => m.guard && !m.ok);
  const gamed = metrics.some((m) => m.gamed === true);
  // a guard that never runs (inert: a pass/fail metric stuck at 0 across both refs) verifies
  // nothing — don't launder that into a green PASS. The honest verdict is "couldn't measure".
  const inconclusive = !failed && !gamed && metrics.some((m) => m.inert);
  const verdict = failed ? 'fail' : gamed ? 'gamed' : inconclusive ? 'inconclusive' : 'pass';
  const report = {
    base: short(repo, base), head: short(repo, head), repeat, mode: opts.working ? 'working' : 'refs',
    // learning-substrate fields (Phase 5): cohort segments reliability by environment,
    // label attributes a change-type, subsystems fingerprint WHERE the change landed.
    cohort: opts.cohort ?? (process.env.CI ? 'ci' : 'local'),
    ...(opts.label ? { label: opts.label } : {}),
    subsystems: subsystemsOf(repo, base, head),
    verdict, metrics,
  };
  if (!opts.noRecord && cfg.record !== false) recordOutcome(repo, report);
  return report;
}

function run(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const report = gate(repo, { base: args.base, head: args.head, working: args.working, repeat: args.repeat, noRecord: args.noRecord, detectGaming: args.detectGaming, label: args.label });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (args.markdown) console.log(renderMarkdown(report));
  else printHuman(report);
  process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'gamed' ? 2 : report.verdict === 'inconclusive' ? 3 : 1);
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
  if (!args.attempt) { console.error('improve requires --attempt "<command that changes the repo>"'); process.exit(2); }
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const dirty = git(['status', '--porcelain'], repo).split('\n').filter((l) => l.trim() && !l.includes('.promptwheel'));
  if (dirty.length) { console.error('working tree not clean — commit or stash first (improve needs a clean base to revert to)'); process.exit(2); }

  console.error(`▶ attempt: ${args.attempt}`);
  try { execSync(args.attempt, { cwd: repo, stdio: 'inherit' }); }
  catch (e) { console.error(`  (attempt exited ${e.status ?? 1} — gating whatever it changed)`); }

  const report = gate(repo, { working: true, repeat: args.repeat, noRecord: args.noRecord, detectGaming: args.detectGaming, label: args.label ?? args.attempt });
  const noChange = report.metrics.every((m) => m.delta === 0 || m.delta == null);
  const improvedNames = report.metrics.filter((m) => m.status === 'improved').map((m) => m.name);

  // result + exit code express loop progress so `while improve; do :; done` converges:
  //   0 = kept a real win · 1 = guarded regression (reverted) · 3 = plateau/no-op OR inconclusive (reverted)
  let result, exit, note;
  if (report.verdict === 'fail') { result = 'regression'; exit = 1; revert(repo); note = '✗ guarded regression — reverted'; }
  else if (report.verdict === 'gamed') { result = 'gamed'; exit = 1; revert(repo); note = '🚩 gamed — a metric "improved" by editing tests/config, not source — reverted'; }
  else if (report.verdict === 'inconclusive') { result = 'inconclusive'; exit = 3; revert(repo); note = '≈ inconclusive — a guard measured nothing (inert); reverted'; }
  else if (noChange || improvedNames.length === 0) {
    result = 'plateau'; exit = 3; revert(repo);
    note = noChange ? '= no metric moved — reverted' : '= nothing improved beyond noise — reverted';
  } else {
    git(['add', '-A'], repo);
    execFileSync('git', ['commit', '-qm', `promptwheel: ${args.attempt} [improved ${improvedNames.join(', ')}]`], { cwd: repo });
    result = 'kept'; exit = 0;
    note = `✓ kept — committed ${git(['rev-parse', '--short', 'HEAD'], repo)} (improved ${improvedNames.join(', ')})`;
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

// Phase-5 seed: turn the accumulated reward stream into signal. Thin on purpose —
// this is the substrate a future outcome-curated playbook / UCB work-discovery loop trains on,
// NOT that loop itself. Just honest aggregation, no model.
function insights(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const f = join(repo, '.promptwheel', 'outcomes.jsonl');
  if (!existsSync(f)) { console.error('no outcome record yet — run the gate a few times first (.promptwheel/outcomes.jsonl)'); process.exit(2); }
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
  console.log(`\nPromptWheel insights — ${runs.length} gated runs recorded\n`);
  console.log(`  ${'metric'.padEnd(18)} ${'runs'.padStart(5)} ${'impr'.padStart(5)} ${'regr'.padStart(5)} ${'inconc'.padStart(6)} ${'net Δ'.padStart(9)}  lever`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(18)} ${String(r.runs).padStart(5)} ${String(r.improved).padStart(5)} ${String(r.regressed).padStart(5)} ${String(r.inconclusive).padStart(6)} ${String(r.net).padStart(9)}  ${(r.lever * 100).toFixed(0)}%`);
  }
  console.log('\n  lever = improved/runs — how reliably this metric actually responds. The');
  console.log('  highest-lever metrics are where an agent loop should spend its attempts.\n');
}

// ---------------------------------------------------------------------------
// Phase 5 — outcome-curated playbook + UCB work-discovery.
// Unfrozen 2026-07-02 by explicit founder decision overriding D7 (see docs/LEARNING.md).
// Design constraints that survive the unfreeze:
//   - PURE VIEW: the append-only ledger (.promptwheel/outcomes.jsonl) is the only store;
//     the playbook is re-derived on every read (decay at read time — no curator state to rot).
//   - EVIDENCE-GATED: a key renders a claim only past MIN_MOVED weighted observations;
//     everything below that is counted, not asserted.
//   - CLAIM-GATED: no public compounding claim until bench/compounding-ab.mjs passes on
//     real usage data. The gate on the CLAIM outlived the gate on the CODE.
// ---------------------------------------------------------------------------
const HALF_LIFE = 20;   // runs — an entry's weight halves every HALF_LIFE runs unless re-earned
const MIN_MOVED = 3;    // weighted moved-observations before a key earns a rendered claim
const EXPLORE_C = 1.0;  // UCB exploration constant

function readLedger(repo) {
  const f = join(repo, '.promptwheel', 'outcomes.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// fold the ledger into decayed per-key stats. keys: `metric` · `metric @ subsystem` · `metric # label`
function foldOutcomes(runs) {
  const keys = new Map();
  const N = runs.length;
  runs.forEach((r, idx) => {
    const w = Math.pow(0.5, (N - 1 - idx) / HALF_LIFE);   // idx N-1 = newest → weight 1
    for (const m of (r.metrics || [])) {
      const tags = [m.name];
      for (const s of (r.subsystems || [])) tags.push(`${m.name} @ ${s}`);
      if (r.label) tags.push(`${m.name} # ${r.label}`);
      for (const key of tags) {
        const k = keys.get(key) ?? { key, metric: m.name, w: 0, n: 0, imp: 0, reg: 0, moved: 0, effects: [], cohorts: {}, last: null };
        k.n += 1; k.w += w;
        const coh = (k.cohorts[r.cohort || 'unknown'] ??= { imp: 0, reg: 0 });
        if (m.status === 'improved') {
          k.imp += w; k.moved += w; coh.imp += 1;
          if (typeof m.delta === 'number' && m.delta !== 0) k.effects.push(Math.abs(m.delta));
        } else if (m.status === 'regressed') { k.reg += w; k.moved += w; coh.reg += 1; }
        k.last = r.ts || k.last;
        keys.set(key, k);
      }
    }
  });
  return [...keys.values()];
}

const betaMean = (imp, reg) => (1 + imp) / (2 + imp + reg);   // Beta(1,1)-smoothed helpfulness

// composite lever = smoothed helpfulness × responsiveness; UCB adds an exploration bonus
function scoreKey(k, totalW) {
  const p = betaMean(k.imp, k.reg);
  const move = k.w ? k.moved / k.w : 0;
  const lever = p * move;
  const ucb = lever + EXPLORE_C * Math.sqrt(Math.log(Math.max(Math.E, totalW)) / Math.max(1e-6, k.w));
  return { p: +p.toFixed(3), move: +move.toFixed(3), lever: +lever.toFixed(3), ucb: +ucb.toFixed(3), effect: +(median(k.effects) ?? 0).toFixed(6) };
}

// cohorts that disagree in sign are flagged, never averaged into a lie
function cohortNote(k) {
  const cs = Object.entries(k.cohorts).filter(([, c]) => c.imp + c.reg > 0);
  if (cs.length < 2) return '';
  const signs = new Set(cs.map(([, c]) => Math.sign(c.imp - c.reg)));
  return signs.size > 1 ? ' · ⚠ cohort-dependent (ci vs local disagree)' : '';
}

function loadEntries(repo) {
  const runs = readLedger(repo);
  if (!runs.length) { console.error('no outcome record yet — run the gate a few times first (.promptwheel/outcomes.jsonl)'); process.exit(2); }
  const keys = foldOutcomes(runs);
  const totalW = keys.filter((k) => k.key === k.metric).reduce((s, k) => s + k.w, 0);
  const entries = keys.map((k) => ({ ...k, ...scoreKey(k, totalW), sufficient: k.moved >= MIN_MOVED }))
    .sort((a, b) => b.lever - a.lever || b.w - a.w);
  return { runs, entries };
}

// the distilled, execution-earned context an agent (or CLAUDE.md) can consume
function playbook(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const { runs, entries } = loadEntries(repo);
  if (args.json) { console.log(JSON.stringify({ runs: runs.length, halfLife: HALF_LIFE, minMoved: MIN_MOVED, entries }, null, 2)); return; }
  const suff = entries.filter((e) => e.sufficient);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const out = [];
  out.push(`## Earned playbook — ${runs.length} gated runs, decay half-life ${HALF_LIFE} runs`);
  out.push('*(every line below was measured by the gate, not asserted; entries decay unless re-earned)*', '');
  if (!suff.length) {
    out.push(`_Nothing has earned a claim yet — a key needs ≥${MIN_MOVED} weighted moved-observations. Keep gating; ${entries.length} keys are accumulating._`);
  } else {
    for (const e of suff.slice(0, 20)) {
      out.push(`- **${e.key}** — helpful ${pct(e.p)} when it moves (${e.imp.toFixed(1)}✓/${e.reg.toFixed(1)}✗ weighted), responds in ${pct(e.move)} of runs, median effect ${e.effect}${cohortNote(e)}`);
    }
    const hidden = entries.length - suff.length;
    if (hidden > 0) out.push('', `_${hidden} more keys below the evidence threshold — counted, not asserted._`);
  }
  console.log(out.join('\n'));
}

// UCB work-discovery: where should the loop spend its NEXT attempt? Proposes measured
// targets (metric/subsystem arms) — never code advice; the measurement stays the message.
function suggest(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const { runs, entries } = loadEntries(repo);
  const arms = entries.filter((e) => e.key === e.metric || e.key.includes(' @ ')).sort((a, b) => b.ucb - a.ucb);
  if (args.json) { console.log(JSON.stringify({ runs: runs.length, thin: runs.length < 10, arms: arms.slice(0, 10) }, null, 2)); return; }
  console.log(`\nPromptWheel suggest — UCB over ${runs.length} gated runs${runs.length < 10 ? '  (thin record: exploration dominates — treat as a coin with opinions)' : ''}\n`);
  for (const a of arms.slice(0, 5)) {
    console.log(`  ${a.ucb.toFixed(3)}  ${a.key.padEnd(28)} lever ${a.lever.toFixed(3)} (helpful ${a.p}, responds ${a.move}) · evidence ${a.moved.toFixed(1)} moved / ${a.n} runs${a.sufficient ? '' : ' · below claim threshold'}`);
  }
  console.log('\n  score = lever + exploration bonus — high scores are either proven levers or under-explored arms.\n');
}

// backfill — seed the ledger from git history: replay past commits through the CURRENT
// metrics (LEARNING.md harvest path 1). Deterministic, no LLM. Rows are cohort-tagged
// 'backfill' — historical human commits are NOT live agent-loop evidence; the cohort
// machinery segments them and flags disagreement rather than averaging it away. The
// conventional-commit type (fix/feat/refactor/…) becomes the change-type label for free.
function backfill(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const listArgs = ['rev-list', '--no-merges'];
  if (args.since) listArgs.push(`${args.since}..HEAD`); else listArgs.push('-n', String(args.n ?? 30), 'HEAD');
  const commits = git(listArgs, repo).split('\n').filter(Boolean).reverse(); // oldest first → ledger stays chronological, decay stays honest
  if (!commits.length) { console.error('no commits to backfill'); process.exit(2); }
  const seen = new Set(readLedger(repo).filter((r) => r.cohort === 'backfill').map((r) => r.head));
  let done = 0, skipped = 0;
  console.log(`\nbackfilling ${commits.length} commits through the current metrics (gaming detection ${args.dgExplicit && args.detectGaming ? 'ON' : 'off — pass --detect-gaming to audit history too'})\n`);
  for (const c of commits) {
    try { git(['rev-parse', `${c}~1`], repo); } catch { skipped++; continue; }        // root commit
    if (seen.has(short(repo, c))) { skipped++; continue; }                            // already recorded
    const subj = git(['log', '-1', '--format=%s', c], repo);
    const type = /^(feat|fix|docs|test|chore|refactor|perf|ci|build|style)\b/i.exec(subj)?.[1]?.toLowerCase();
    const report = gate(repo, { base: `${c}~1`, head: c, repeat: args.repeat, detectGaming: args.dgExplicit ? args.detectGaming : false, label: type, cohort: 'backfill' });
    console.log(`  ${report.head} ${report.verdict.toUpperCase().padEnd(6)} ${type ? `#${type}`.padEnd(10) : ''.padEnd(10)} ${subj.slice(0, 56)}`);
    done++;
  }
  console.log(`\n  backfilled ${done}${skipped ? ` (skipped ${skipped}: root or already recorded)` : ''} — old commits that no longer build record as unmeasurable, never faked.`);
  console.log('  next:  promptwheel playbook   ·   promptwheel suggest\n');
}

// ---------------------------------------------------------------------------
// init — write a starter config so a newcomer isn't staring at a blank page
// ---------------------------------------------------------------------------
const LINT_CMD = 'npx eslint . -f unix 2>/dev/null | grep -c " error " || true';
const PRESETS = {
  'tests-pass': { desc: 'gate: your test suite still passes (command auto-detected)', metrics: null },
  'lint': { desc: 'track: lint error count does not climb',
    metrics: [{ name: 'lint_errors', cmd: LINT_CMD, extract: 'number', direction: 'down', guard: false }] },
  'bundle-size': { desc: 'track: build output size in kB',
    metrics: [{ name: 'bundle_kb', cmd: 'du -sk dist 2>/dev/null | cut -f1 || echo 0', extract: 'number', direction: 'down', guard: false }] },
  'llm-eval': { desc: 'gate: AI-feature eval pass-rate + est $/run (see examples/reliability-sprint)',
    metrics: [
      { name: 'eval_pass_rate', cmd: 'node eval.mjs', extract: 'number', direction: 'up', guard: true },
      { name: 'cost_per_run_usd', cmd: 'node estimate-cost.mjs', extract: 'number', direction: 'down', guard: true },
    ] },
  'antihack': { desc: 'catch reward-hacking: a target + tripwires; pairs with `run --detect-gaming` (source-only re-run)',
    metrics: [
      { name: 'tests_pass', cmd: '__TESTCMD__', extract: 'exit', direction: 'pass', guard: true },
      { name: 'test_count', cmd: 'grep -rIoE "\\b(it|test|describe) ?\\(|def test_" --exclude-dir=node_modules --exclude-dir=.git --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
      { name: 'skipped_tests', cmd: 'grep -rIoE "\\.(skip|only) ?\\(|xit ?\\(|@pytest\\.mark\\.skip" --exclude-dir=node_modules --exclude-dir=.git --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
      { name: 'suppressions', cmd: 'grep -rIoE "eslint-disable|@ts-(ignore|nocheck)|# ?type: ?ignore|# ?noqa|//nolint|#!?\\[allow\\(" --exclude-dir=node_modules --exclude-dir=.git --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'down', guard: true, gamingCheck: false },
      { name: 'assertions', cmd: 'grep -rIoE "expect ?\\(|\\bassert|\\bt\\.(is|deepEqual|throws|truthy|falsy|not|ok) ?\\(" --exclude-dir=node_modules --exclude-dir=.git --exclude=promptwheel.config.json . 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
    ] },
};

function detectTestCmd(repo) {
  const has = (f) => existsSync(join(repo, f));
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) return has('.venv/bin/pytest') ? '.venv/bin/pytest -q' : 'pytest -q';
  // only trust `npm test` when a test script actually exists — otherwise the metric can
  // never pass and the gate would "protect" nothing (very common in Next.js app repos)
  try {
    if (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts?.test) return 'npm test --silent';
  } catch { /* no or unparsable package.json — fall through */ }
  return 'echo "set your test command in promptwheel.config.json" && false';
}

// deps that live outside git + the env a test needs, defaulted per stack. init writes these into
// config; the measurement bridge (bridgeEnv/runSetup) consumes them — keeps the engine agnostic.
function detectEnv(repo) {
  const has = (f) => existsSync(join(repo, f));
  // Python: link the venv (3rd-party deps) and put the worktree src FIRST on PYTHONPATH, so imports
  // resolve the MEASURED ref instead of an editable install pointing back at your original checkout.
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) return { linkDirs: ['.venv'], env: { PYTHONPATH: '{wt}/src:{wt}' } }; // src/ AND flat layouts; worktree src wins over an editable install
  if (has('Cargo.toml')) return { linkDirs: ['target'] };
  return {};
}

// only offer the lint metric where eslint actually exists — otherwise it reads 0 forever
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

function init(argv) {
  if (argv.includes('--list')) {
    console.log('PromptWheel presets (promptwheel init --preset <name>):\n');
    for (const [k, p] of Object.entries(PRESETS)) console.log(`  ${k.padEnd(13)} ${p.desc}`);
    return;
  }
  const repo = (() => { try { return git(['rev-parse', '--show-toplevel'], process.cwd()); } catch { return process.cwd(); } })();
  const out = join(repo, 'promptwheel.config.json');
  if (existsSync(out) && !argv.includes('--force')) {
    console.error('promptwheel.config.json already exists — pass --force to overwrite'); process.exit(2);
  }
  const pi = argv.indexOf('--preset');
  const presetName = pi >= 0 ? argv[pi + 1] : null;
  let metrics, note;
  if (presetName) {
    const p = PRESETS[presetName];
    if (!p) { console.error(`unknown preset "${presetName}" — try: promptwheel init --list`); process.exit(2); }
    metrics = p.metrics || [{ name: 'tests_pass', cmd: detectTestCmd(repo), extract: 'exit', direction: 'pass', guard: true }];
    metrics = metrics.map((m) => m.cmd === '__TESTCMD__' ? { ...m, cmd: detectTestCmd(repo) } : m); // fill the preset's target
    note = presetName;
  } else {
    // default = the headline posture: guarded tests + the antihack tripwires, so the FIRST
    // cheat a newcomer tries (gut the tests while the metric stays flat) fails the gate —
    // "catch your agent cheating" must be true out of the box, not only under a preset.
    const testCmd = detectTestCmd(repo);
    const lint = hasEslint(repo);
    metrics = PRESETS['antihack'].metrics.map((m) => m.cmd === '__TESTCMD__' ? { ...m, cmd: testCmd } : m);
    if (lint) metrics = [...metrics, { name: 'lint_errors', cmd: LINT_CMD, extract: 'number', direction: 'down', guard: false }];
    note = `tests + antihack tripwires${lint ? ' + lint' : ''} (detected: ${testCmd})`;
  }
  const envCfg = presetName ? {} : detectEnv(repo);
  if (envCfg.linkDirs) note += ` · linking ${envCfg.linkDirs.join(', ')}`;
  writeFileSync(out, JSON.stringify({ repeat: 1, ...envCfg, metrics }, null, 2) + '\n');
  console.log(`✓ wrote promptwheel.config.json — ${note}`);
  console.log('\n  next:  promptwheel run --working   # gate your uncommitted changes');
  console.log('         promptwheel init --list     # other presets (llm-eval, bundle-size, …)');
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
  console.log('\nPromptWheel guardrails — effective set for this repo\n');
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
  for (const m of r.metrics) {
    const tag = m.guard ? (m.ok ? 'guard✓' : 'GUARD✗') : 'info';
    const d = m.delta == null ? '—' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    console.log(`  ${arrowFor(m)} ${m.name.padEnd(18)} ${String(m.before).padStart(8)} → ${String(m.after).padStart(8)}  (${d}, ${m.status}) [${tag}, ${m.confidence}]`);
    if (m.inert) console.log('      ⚠ never passed at either ref — this guard is protecting nothing (check its command)');
    if (m.gamed === true) console.log(`      🚩 GAMED — ${m.gamingReason}`);
  }
  console.log(`\n  VERDICT: ${r.verdict.toUpperCase()}${r.verdict === 'fail' ? '  — a guarded metric regressed (beyond noise)' : r.verdict === 'gamed' ? '  — a metric "improved" by editing the goalposts, not the source' : r.verdict === 'inconclusive' ? '  — a guard is inert (measured nothing); a pass cannot be certified' : ''}`);
  if (r.verdict === 'fail') console.log('  intentional? loosen that guard locally in promptwheel.config.json (guard:false, or override the inherited metric by name) — `promptwheel guards` shows the effective set');
  console.log('');
}

// PR-comment markdown (rendering lives in the tool so the GitHub Action stays thin)
function renderMarkdown(r) {
  const icon = r.verdict === 'pass' ? '✅' : r.verdict === 'gamed' ? '🚩' : r.verdict === 'inconclusive' ? '🟡' : '❌';
  const sIcon = { improved: '🟢', regressed: '🔴', unchanged: '⚪', inconclusive: '🟡', unmeasurable: '⚫' };
  const rows = r.metrics.map((m) => {
    const d = m.delta == null ? '—' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    const status = m.gamed === true ? `🚩 gamed (${(m.retained * 100).toFixed(0)}% survives source-only)` : `${sIcon[m.status] || ''} ${m.status}${m.inert ? ' ⚠ never passes' : ''}`;
    return `| ${m.guard ? '🛡️ ' : ''}${m.name} | ${m.before} | ${m.after} | ${d} | ${status} | ${m.confidence} |`;
  }).join('\n');
  return [
    `### ${icon} PromptWheel — outcome gate: **${r.verdict.toUpperCase()}**`,
    '',
    `\`${r.base} → ${r.head}\` · ${r.mode} mode${r.repeat > 1 ? ` · ×${r.repeat}` : ''}`,
    '',
    '| metric | before | after | Δ | status | confidence |',
    '|---|--:|--:|--:|---|---|',
    rows,
    '',
    r.verdict === 'gamed' ? '> 🚩 A metric "improved" only because the agent edited tests/config/grader — not the source. The win does not survive a source-only re-run.' : r.verdict === 'fail' ? '> ❌ A 🛡️ guarded metric regressed beyond the noise band.' : r.verdict === 'inconclusive' ? '> 🟡 A 🛡️ guarded check is **inert** — it never runs, so nothing was actually verified. Fix its command before trusting a pass.' : '> ✅ No guarded metric regressed.',
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
    else if (argv[i] === '--detect-gaming' || argv[i] === '--antihack') { a.detectGaming = true; a.dgExplicit = true; }
    else if (argv[i] === '--no-detect-gaming' || argv[i] === '--no-antihack') { a.detectGaming = false; a.dgExplicit = true; }
    else if (argv[i] === '--since') a.since = argv[++i];
    else if (argv[i] === '-n' || argv[i] === '--limit') a.n = parseInt(argv[++i], 10);
    else if (argv[i] === '--attempt') a.attempt = argv[++i];
    else if (argv[i] === '--label') a.label = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--markdown' || argv[i] === '--md') a.markdown = true;
  }
  return a;
}

// pure, side-effect-free helpers are exported for unit testing; the CLI below only
// runs when this file is executed directly (not when imported by the test suite).
export { extract, evaluate, median, spread, renderMarkdown, isNonSource, gain, judgeGaming, foldOutcomes, betaMean, scoreKey };

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') run(rest);
  else if (cmd === 'improve') improve(rest);
  else if (cmd === 'insights') insights(rest);
  else if (cmd === 'playbook') playbook(rest);
  else if (cmd === 'suggest') suggest(rest);
  else if (cmd === 'backfill') backfill(rest);
  else if (cmd === 'init') init(rest);
  else if (cmd === 'guards') guards(rest);
  else {
    console.log([
      'PromptWheel — catch your agent cheating. Prove a change moved a real metric (and that the agent earned it, not gamed it). The per-turn reward + source-only audit for AI coding loops.',
      '',
      '  promptwheel init [--preset <name> | --list]  write a starter config for your stack',
      '  promptwheel run [--base R] [--head R] [--repeat N] [--json|--markdown]',
      '       catches reward-hacking BY DEFAULT — re-proves each win from SOURCE edits alone (verdict GAMED,',
      '       exit 2, when a metric only moved by editing tests/config/grader). Use --no-detect-gaming for the bare gate.',
      '  promptwheel run --working                    gate uncommitted changes (incl. newly added files)',
      '  promptwheel improve --attempt "<cmd>"        run an agent/script; keep only if a metric improved',
      '                                               exit 0=kept · 1=regression · 3=plateau · add --json',
      '  promptwheel insights                         which metrics actually respond (raw counts)',
      '  promptwheel playbook [--json]                the earned playbook: decayed, evidence-gated claims distilled from the record',
      '  promptwheel suggest [--json]                 UCB work-discovery: where the next attempt should go (experimental)',
      '  promptwheel backfill [-n N | --since <ref>]  seed the ledger from git history (cohort-tagged; commit types become labels)',
      '  promptwheel guards                           show the effective guardrails (incl. inherited) + flag record',
      '',
      'Loop it:  while promptwheel improve --attempt "$AGENT"; do :; done   # stops on plateau/regression',
      'Config:   promptwheel.config.json → { extends?, metrics:[{ name, cmd, direction, extract?, guard? }] }   (or: promptwheel init)',
      '          extends: a path (or array) to a shared base config — repos INHERIT its guardrails; local metrics override by name.',
    ].join('\n'));
    process.exit(cmd ? 2 : 0);
  }
}

// run the CLI only when invoked directly (resolves symlinks so the npm bin still works)
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* not main */ }
if (isMain) main();
