// Dep-free test suite (node:test). Run: npm test  (or: node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, evaluate, median, spread, renderMarkdown } from '../bin/promptwheel.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptwheel.mjs');

// ---------------------------------------------------------------- unit: extract
test('extract: number = last number in output', () => assert.equal(extract('errors 3, then 7\n', 0), 7));
test('extract: exit code → 1/0', () => { assert.equal(extract('x', 0, 'exit'), 1); assert.equal(extract('x', 2, 'exit'), 0); });
test('extract: lines counts non-empty lines', () => assert.equal(extract('a\n\nb\n', 0, 'lines'), 2));
test('extract: regex first capture', () => assert.equal(extract('coverage: 88%', 0, { regex: 'coverage: (\\d+)' }), 88));
test('extract: null when no number', () => assert.equal(extract('nothing here', 0), null));

// ------------------------------------------------------------ unit: median/spread
test('median: odd and even', () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); });
test('median: empty → null', () => assert.equal(median([]), null));
test('spread: max - min', () => { assert.equal(spread([5, 2, 9]), 7); assert.equal(spread([]), 0); });

// -------------------------------------------------------------- unit: evaluate
const m = (over = {}) => ({ direction: 'down', guard: true, extract: 'number', ...over });

test('evaluate: improvement beyond noise → improved/medium/ok', () => {
  const ev = evaluate(m(), [10, 11], [4, 5], 2);
  assert.equal(ev.status, 'improved'); assert.equal(ev.ok, true); assert.equal(ev.confidence, 'medium');
});
test('evaluate: zero observed noise → high confidence', () => {
  const ev = evaluate(m(), [10, 10], [5, 5], 2);
  assert.equal(ev.status, 'improved'); assert.equal(ev.confidence, 'high');
});
test('evaluate: guarded regression beyond noise → fails (ok=false)', () => {
  const ev = evaluate(m(), [5, 5], [9, 9], 2);
  assert.equal(ev.status, 'regressed'); assert.equal(ev.ok, false);
});
test('evaluate: delta inside noise band → inconclusive, never fails a guard', () => {
  const ev = evaluate(m(), [200, 210], [205, 215], 2); // delta 5 ≤ noise 10
  assert.equal(ev.status, 'inconclusive'); assert.equal(ev.ok, true); assert.equal(ev.confidence, 'low');
});
test('evaluate: single read → unverified (noise unknown)', () => {
  assert.equal(evaluate(m({ guard: false }), [5], [4], 1).confidence, 'unverified');
});
test('evaluate: deterministic extract → high even on a single read', () => {
  assert.equal(evaluate(m({ extract: 'exit' }), [1], [1], 1).confidence, 'high');
});
test('evaluate: non-guard informational metric never fails', () => {
  assert.equal(evaluate(m({ guard: false }), [5, 5], [9, 9], 2).ok, true);
});

// ------------------------------------------------------------- unit: renderMarkdown
test('renderMarkdown: includes verdict, metric, delta', () => {
  const md = renderMarkdown({ base: 'a', head: 'b', mode: 'refs', repeat: 1, verdict: 'pass',
    metrics: [{ name: 'todos', guard: true, before: 4, after: 2, delta: -2, status: 'improved', confidence: 'high' }] });
  assert.match(md, /PASS/); assert.match(md, /todos/); assert.match(md, /-2/);
});

// ------------------------------------------------------------- integration helpers
function tmpRepo(metrics) {
  const d = mkdtempSync(join(tmpdir(), 'pw-test-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics }));
  return d;
}
const rev = (d, r = 'HEAD') => execFileSync('git', ['rev-parse', r], { cwd: d, encoding: 'utf8' }).trim();
const commitAll = (d, msg) => { execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['commit', '-qm', msg], { cwd: d }); };
function pw(d, args) {
  try { return { out: execFileSync('node', [ENGINE, ...args], { cwd: d, encoding: 'utf8' }), code: 0 }; }
  catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status }; }
}
const TODOS = { name: 'todos', cmd: 'grep -rn TODO . --include=*.js 2>/dev/null | wc -l', extract: 'number', direction: 'down', guard: true };

// -------------------------------------------------------- integration: run pass/fail
test('run: passes on improvement (exit 0), fails on guarded regression (exit 1)', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'improve');
  let r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 0); assert.match(r.out, /improved/);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\nc // TODO\n'); commitAll(d, 'regress');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 1); assert.match(r.out, /FAIL/);
  rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------ integration: --working + reward stream
test('run --working: measures uncommitted change, leaves tree untouched, records outcome', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); // uncommitted improvement
  const r = pw(d, ['run', '--working']);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(d, 'app.js'), 'utf8').includes('TODO'), false); // tree still has the change
  assert.ok(existsSync(join(d, '.promptwheel', 'outcomes.jsonl')));               // reward stream written
  rmSync(d, { recursive: true, force: true });
});

// -------------------------------------------- integration: improve keep / revert
test('improve: keeps on improvement (commits), reverts on regression (no new commit)', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  const base = rev(d);
  let r = pw(d, ['improve', '--attempt', "sed -i 's| // TODO||' app.js"]);
  assert.equal(r.code, 0); assert.match(r.out, /kept/);
  const kept = rev(d);
  assert.notEqual(base, kept); // a commit was made
  r = pw(d, ['improve', '--attempt', "echo 'x // TODO' >> app.js"]); // regression
  assert.equal(r.code, 1);
  assert.equal(rev(d), kept); // reverted — HEAD unchanged
  rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------ integration: insights
test('insights: aggregates the reward stream into per-metric stats', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\nc // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb // TODO\n'); commitAll(d, 'c1');
  pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']); // records an improvement
  const r = pw(d, ['insights', '--json']);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.out);
  assert.equal(data.runs, 1);
  assert.equal(data.metrics[0].name, 'todos');
  assert.equal(data.metrics[0].improved, 1);
  rmSync(d, { recursive: true, force: true });
});
