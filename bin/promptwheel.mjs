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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function loadConfig(repo) {
  const candidates = ['promptwheel.config.json', 'outcome-gate.config.json']; // back-compat alias
  const p = candidates.map((c) => join(repo, c)).find(existsSync);
  if (!p) { console.error('no promptwheel.config.json — run: promptwheel init   (writes one for your stack)'); process.exit(2); }
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
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

function runMetric(cwd, m) {
  let stdout = '', code = 0;
  try {
    stdout = execSync(m.cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: (m.timeoutSec ?? 300) * 1000 });
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

// measure every metric `repeat` times at a ref, in a throwaway worktree (never touches your tree)
function measureAt(repo, ref, metrics, linkNodeModules, repeat) {
  const wt = mkdtempSync(join(tmpdir(), 'promptwheel-'));
  git(['worktree', 'add', '--quiet', '--detach', wt, ref], repo);
  try {
    if (linkNodeModules && existsSync(join(repo, 'node_modules')) && !existsSync(join(wt, 'node_modules'))) {
      try { symlinkSync(join(repo, 'node_modules'), join(wt, 'node_modules')); } catch { /* best effort */ }
    }
    const out = {};
    for (const m of metrics) {
      const samples = [];
      for (let i = 0; i < repeat; i++) samples.push(runMetric(wt, m));
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
  return { before, after, delta, status, ok, confidence, noise };
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

// the shared core: measure a change (base→head) and return the structured report
function gate(repo, opts) {
  const cfg = loadConfig(repo);
  const repeat = Math.max(1, opts.repeat ?? cfg.repeat ?? 1);
  const linkNM = cfg.linkNodeModules !== false;

  let base, head;
  if (opts.working) {
    // measure uncommitted changes — tracked AND untracked — via a temp-index snapshot;
    // never touches the real index or working tree. (A loop agent's most common action
    // is to ADD a file; `git stash create` omits untracked, which silently reverted them.)
    base = 'HEAD';
    head = workingSnapshot(repo);
  } else {
    base = resolveBase(repo, opts.base);
    head = opts.head || 'HEAD';
  }

  const before = measureAt(repo, base, cfg.metrics, linkNM, repeat);
  const after = measureAt(repo, head, cfg.metrics, linkNM, repeat);
  const metrics = cfg.metrics.map((m) => {
    const ev = evaluate(m, before[m.name], after[m.name], repeat);
    return { name: m.name, direction: m.direction || 'up', guard: !!m.guard, ...ev };
  });
  const verdict = metrics.some((m) => m.guard && !m.ok) ? 'fail' : 'pass';
  const report = { base: short(repo, base), head: short(repo, head), repeat, mode: opts.working ? 'working' : 'refs', verdict, metrics };
  if (!opts.noRecord && cfg.record !== false) recordOutcome(repo, report);
  return report;
}

function run(argv) {
  const args = parseArgs(argv);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const report = gate(repo, { base: args.base, head: args.head, working: args.working, repeat: args.repeat, noRecord: args.noRecord });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (args.markdown) console.log(renderMarkdown(report));
  else printHuman(report);
  process.exit(report.verdict === 'pass' ? 0 : 1);
}

// the moat: append every gated run to a per-repo outcome record (best-effort, never fails the gate)
function recordOutcome(repo, report) {
  try {
    const dir = join(repo, '.promptwheel');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'outcomes.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...report }) + '\n');
  } catch { /* recording must never break the gate */ }
}

// the flywheel: run any agent/script, gate the result, keep the change ONLY if a metric improved
function improve(argv) {
  const args = parseArgs(argv);
  if (!args.attempt) { console.error('improve requires --attempt "<command that changes the repo>"'); process.exit(2); }
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  const dirty = git(['status', '--porcelain'], repo).split('\n').filter((l) => l.trim() && !l.includes('.promptwheel'));
  if (dirty.length) { console.error('working tree not clean — commit or stash first (improve needs a clean base to revert to)'); process.exit(2); }

  console.error(`▶ attempt: ${args.attempt}`);
  try { execSync(args.attempt, { cwd: repo, stdio: 'inherit' }); }
  catch (e) { console.error(`  (attempt exited ${e.status ?? 1} — gating whatever it changed)`); }

  const report = gate(repo, { working: true, repeat: args.repeat, noRecord: args.noRecord });
  const noChange = report.metrics.every((m) => m.delta === 0 || m.delta == null);
  const improvedNames = report.metrics.filter((m) => m.status === 'improved').map((m) => m.name);

  // result + exit code express loop progress so `while improve; do :; done` converges:
  //   0 = kept a real win · 1 = guarded regression (reverted) · 3 = plateau/no-op (reverted)
  let result, exit, note;
  if (report.verdict === 'fail') { result = 'regression'; exit = 1; revert(repo); note = '✗ guarded regression — reverted'; }
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
// this is the substrate a future ACE playbook / UCB work-discovery loop trains on,
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
};

function detectTestCmd(repo) {
  const has = (f) => existsSync(join(repo, f));
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) return 'pytest -q';
  if (has('package.json')) return 'npm test --silent';
  return 'echo "set your test command in promptwheel.config.json" && false';
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
    note = presetName;
  } else {
    // sensible default: tests-pass (guarded) + lint (info — can't fail a newcomer's first run)
    const testCmd = detectTestCmd(repo);
    metrics = [
      { name: 'tests_pass', cmd: testCmd, extract: 'exit', direction: 'pass', guard: true },
      { name: 'lint_errors', cmd: LINT_CMD, extract: 'number', direction: 'down', guard: false },
    ];
    note = `tests-pass + lint (detected: ${testCmd})`;
  }
  writeFileSync(out, JSON.stringify({ repeat: 1, metrics }, null, 2) + '\n');
  console.log(`✓ wrote promptwheel.config.json — ${note}`);
  console.log('\n  next:  promptwheel run --working   # gate your uncommitted changes');
  console.log('         promptwheel init --list     # other presets (llm-eval, bundle-size, …)');
}

const short = (repo, ref) => { try { return git(['rev-parse', '--short', ref], repo); } catch { return ref; } };

function printHuman(r) {
  const arrowFor = (m) => (m.delta == null ? '?' : m.delta > 0 ? '▲' : m.delta < 0 ? '▼' : '=');
  console.log(`\nPromptWheel  ${r.base} → ${r.head}${r.repeat > 1 ? `  (×${r.repeat})` : ''}\n`);
  for (const m of r.metrics) {
    const tag = m.guard ? (m.ok ? 'guard✓' : 'GUARD✗') : 'info';
    const d = m.delta == null ? '—' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    console.log(`  ${arrowFor(m)} ${m.name.padEnd(18)} ${String(m.before).padStart(8)} → ${String(m.after).padStart(8)}  (${d}, ${m.status}) [${tag}, ${m.confidence}]`);
  }
  console.log(`\n  VERDICT: ${r.verdict.toUpperCase()}${r.verdict === 'fail' ? '  — a guarded metric regressed (beyond noise)' : ''}\n`);
}

// PR-comment markdown (rendering lives in the tool so the GitHub Action stays thin)
function renderMarkdown(r) {
  const icon = r.verdict === 'pass' ? '✅' : '❌';
  const sIcon = { improved: '🟢', regressed: '🔴', unchanged: '⚪', inconclusive: '🟡', unmeasurable: '⚫' };
  const rows = r.metrics.map((m) => {
    const d = m.delta == null ? '—' : (m.delta > 0 ? `+${m.delta}` : `${m.delta}`);
    return `| ${m.guard ? '🛡️ ' : ''}${m.name} | ${m.before} | ${m.after} | ${d} | ${sIcon[m.status] || ''} ${m.status} | ${m.confidence} |`;
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
    r.verdict === 'fail' ? '> ❌ A 🛡️ guarded metric regressed beyond the noise band.' : '> ✅ No guarded metric regressed.',
    '',
    '<sub>🛡️ = guard · _prove every change moved a metric_ · [PromptWheel](https://github.com/promptwheel-ai/promptwheel)</sub>',
  ].join('\n');
}

function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--head') a.head = argv[++i];
    else if (argv[i] === '--repeat') a.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--working') a.working = true;
    else if (argv[i] === '--no-record') a.noRecord = true;
    else if (argv[i] === '--attempt') a.attempt = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--markdown') a.markdown = true;
  }
  return a;
}

// pure, side-effect-free helpers are exported for unit testing; the CLI below only
// runs when this file is executed directly (not when imported by the test suite).
export { extract, evaluate, median, spread, renderMarkdown };

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') run(rest);
  else if (cmd === 'improve') improve(rest);
  else if (cmd === 'insights') insights(rest);
  else if (cmd === 'init') init(rest);
  else {
    console.log([
      'PromptWheel — the per-turn reward for AI coding loops. Prove a change moved a metric.',
      '',
      '  promptwheel init [--preset <name> | --list]  write a starter config for your stack',
      '  promptwheel run [--base R] [--head R] [--repeat N] [--json|--markdown]',
      '  promptwheel run --working                    gate uncommitted changes (incl. newly added files)',
      '  promptwheel improve --attempt "<cmd>"        run an agent/script; keep only if a metric improved',
      '                                               exit 0=kept · 1=regression · 3=plateau · add --json',
      '  promptwheel insights                         which metrics actually respond (loop memory)',
      '',
      'Loop it:  while promptwheel improve --attempt "$AGENT"; do :; done   # stops on plateau/regression',
      'Config:   promptwheel.config.json → { metrics:[{ name, cmd, direction, extract?, guard? }] }   (or: promptwheel init)',
    ].join('\n'));
    process.exit(cmd ? 2 : 0);
  }
}

// run the CLI only when invoked directly (resolves symlinks so the npm bin still works)
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* not main */ }
if (isMain) main();
