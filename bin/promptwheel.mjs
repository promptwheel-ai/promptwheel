#!/usr/bin/env node
// PromptWheel — the outcome gate for AI code. Prove every change moved a metric.
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
import { readFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  if (!p) { console.error(`no promptwheel.config.json in ${repo}`); process.exit(2); }
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
// the shared core: measure a change (base→head) and return the structured report
function gate(repo, opts) {
  const cfg = loadConfig(repo);
  const repeat = Math.max(1, opts.repeat ?? cfg.repeat ?? 1);
  const linkNM = cfg.linkNodeModules !== false;

  let base, head;
  if (opts.working) {
    // measure uncommitted (tracked) changes via a snapshot commit; never disturbs the working tree
    const snap = git(['stash', 'create'], repo); // '' when clean
    base = 'HEAD';
    head = snap || 'HEAD';
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
  printHuman(report);

  const noChange = report.metrics.every((m) => m.delta === 0 || m.delta == null);
  const improvedNames = report.metrics.filter((m) => m.status === 'improved').map((m) => m.name);
  if (report.verdict === 'fail') { console.log('  ✗ guarded regression — reverting\n'); revert(repo); process.exit(1); }
  if (noChange) { console.log('  = no metric moved — reverting\n'); revert(repo); process.exit(0); }
  if (improvedNames.length === 0) { console.log('  = nothing improved beyond noise — reverting\n'); revert(repo); process.exit(0); }

  git(['add', '-A'], repo);
  execFileSync('git', ['commit', '-qm', `promptwheel: ${args.attempt} [improved ${improvedNames.join(', ')}]`], { cwd: repo });
  console.log(`  ✓ kept — committed ${git(['rev-parse', '--short', 'HEAD'], repo)} (improved ${improvedNames.join(', ')})\n`);
}

// discard the attempt's changes; keep the .promptwheel outcome record
function revert(repo) {
  git(['reset', '--hard', 'HEAD'], repo);
  try { git(['clean', '-fd', '-e', '.promptwheel'], repo); } catch { /* best effort */ }
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
  }
  return a;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'run') run(rest);
else if (cmd === 'improve') improve(rest);
else {
  console.log([
    'PromptWheel — the outcome gate for AI code. Prove every change moved a metric.',
    '',
    '  promptwheel run [--base <ref>] [--head <ref>] [--repeat <N>] [--json]',
    '  promptwheel run --working                 measure uncommitted changes (HEAD → working tree)',
    '  promptwheel run --no-record               skip appending to .promptwheel/outcomes.jsonl',
    '  promptwheel improve --attempt "<cmd>"     run an agent/script, keep the change only if a metric improved',
    '',
    'Config: promptwheel.config.json → { metrics: [{ name, cmd, direction, extract?, guard? }] }',
  ].join('\n'));
  process.exit(cmd ? 2 : 0);
}
