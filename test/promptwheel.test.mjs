// Dep-free test suite (node:test). Run: npm test  (or: node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, evaluate, median, spread, renderMarkdown, isNonSource, gain, judgeGaming } from '../bin/promptwheel.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptwheel.mjs');

// ---------------------------------------------------------------- unit: extract
test('extract: number = last number in output', () => assert.equal(extract('errors 3, then 7\n', 0), 7));
test('extract: exit code → 1/0', () => { assert.equal(extract('x', 0, 'exit'), 1); assert.equal(extract('x', 2, 'exit'), 0); });
test('extract: lines counts non-empty lines', () => assert.equal(extract('a\n\nb\n', 0, 'lines'), 2));
test('extract: regex first capture', () => assert.equal(extract('coverage: 88%', 0, { regex: 'coverage: (\\d+)' }), 88));
test('extract: regex capture wins over last-number fallback', () =>
  assert.equal(extract('coverage: 88% of 200 lines', 0, { regex: 'coverage: (\\d+)' }), 88));
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
test('evaluate: one missing side → unmeasurable, never regressed', () => {
  const ev = evaluate(m(), [], [5, 5], 2);
  assert.equal(ev.status, 'unmeasurable'); assert.equal(ev.delta, null);
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

// ---------------------------------------------------------- unit: gaming detection
test('isNonSource: tests/config/grader/golden are non-source', () => {
  for (const p of ['app.test.js', 'test.js', 'tests.ts', 'src/__tests__/x.ts', 'spec/y.js',
    'eval.mjs', 'grader.ts', 'fixtures/a.json', 'x.snap', 'golden.json', 'tsconfig.json',
    'jest.config.js', '.eslintrc.json', 'pytest.ini', 'conftest.py', 'src/foo_test.py'])
    assert.equal(isNonSource(p), true, p);
});
test('isNonSource: real production source is NOT non-source', () => {
  for (const p of ['src/app.js', 'lib/handler.ts', 'index.mjs', 'latest.js', 'mytest.js', 'contest.py'])
    assert.equal(isNonSource(p), false, p);
});
test('isNonSource: tool-named CONFIG is non-source; tool-named SOURCE is source', () => {
  for (const p of ['jest.config.ts', 'eslint.config.mjs', 'playwright.config.js', 'karma.conf.js', 'jest.setup.ts', 'tsconfig.base.json'])
    assert.equal(isNonSource(p), true, p);
  for (const p of ['cli/src/installers/eslint.ts', 'src/vitest-helpers.ts', 'lib/babel.ts'])
    assert.equal(isNonSource(p), false, p);  // corpus finding: production file named after a tool must stay in the source slice
});
test('gain: directional improvement', () => {
  assert.equal(gain({ direction: 'up' }, 5, 8), 3);
  assert.equal(gain({ direction: 'down' }, 8, 5), 3);
  assert.equal(gain({ direction: 'pass' }, 0, 1), 1);
  assert.equal(gain({ direction: 'pass' }, 0, 0), -1);
});
test('judgeGaming: zero source change → gamed', () =>
  assert.equal(judgeGaming({ before: 0, after: 1, direction: 'pass' }, { hadSourceChange: false }).gamed, true));
test('judgeGaming: source reproduces the full win → not gamed', () => {
  const j = judgeGaming({ before: 0, after: 1, direction: 'pass' }, { hadSourceChange: true, samples: [1] });
  assert.equal(j.gamed, false); assert.equal(j.retained, 1);
});
test('judgeGaming: source reproduces <half the win → gamed', () => {
  const j = judgeGaming({ before: 100, after: 40, direction: 'down' }, { hadSourceChange: true, samples: [85] });
  assert.equal(j.gamed, true); assert.equal(j.retained, 0.25);
});
test('judgeGaming: exactly half the gain retained → NOT gamed (boundary)', () => {
  const j = judgeGaming({ before: 100, after: 60, direction: 'down' }, { hadSourceChange: true, samples: [80] });
  assert.equal(j.retained, 0.5); assert.equal(j.gamed, false);
});
test('judgeGaming: gamingThreshold is honored (same retention, different verdicts)', () => {
  const src = { hadSourceChange: true, samples: [80] }; // retained 0.5
  assert.equal(judgeGaming({ before: 100, after: 60, direction: 'down' }, src, 0.6).gamed, true);
  assert.equal(judgeGaming({ before: 100, after: 60, direction: 'down' }, src, 0.4).gamed, false);
});

// ------------------------------------------ integration: --detect-gaming end-to-end
test('run --detect-gaming: catches a win made by editing the test; passes a real source fix', () => {
  const TP = { name: 'tests_pass', cmd: 'node app.test.js', extract: 'exit', direction: 'pass', guard: true };
  const d = tmpRepo([TP]);
  writeFileSync(join(d, 'src.js'), 'module.exports = { add: (a,b)=>a+b };\n');
  writeFileSync(join(d, 'app.test.js'), "const A=require('assert');const {add,subtract}=require('./src');A.strictEqual(add(2,2),4);A.strictEqual(subtract(5,3),2);\n");
  commitAll(d, 'base'); const base = rev(d);
  // GAMED: delete the failing assertion (edit the TEST); source untouched
  writeFileSync(join(d, 'app.test.js'), "const A=require('assert');const {add}=require('./src');A.strictEqual(add(2,2),4);\n");
  commitAll(d, 'gamed'); const gamed = rev(d);
  let r = pw(d, ['run', '--base', base, '--head', gamed, '--detect-gaming', '--no-record']);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /GAMED/);
  // LEGIT: implement subtract in SOURCE; test intact
  execFileSync('git', ['checkout', '-q', base], { cwd: d });
  writeFileSync(join(d, 'src.js'), 'module.exports = { add: (a,b)=>a+b, subtract: (a,b)=>a-b };\n');
  commitAll(d, 'legit'); const legit = rev(d);
  r = pw(d, ['run', '--base', base, '--head', legit, '--detect-gaming', '--no-record']);
  assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /GAMED/);
  rmSync(d, { recursive: true, force: true });
});

test('run --detect-gaming: a gamingCheck:false guard is exempt from the source-only re-run (no FP on test-side gains)', () => {
  // tests_pass is the source-proven target; `asserts` is a test-side guard that must NOT be re-proven from source
  const d = tmpRepo([
    { name: 'tests_pass', cmd: 'node t.js', extract: 'exit', direction: 'pass', guard: true },
    { name: 'asserts', cmd: 'grep -roE "ok" x.test.js 2>/dev/null | wc -l | tr -d " "', extract: 'number', direction: 'up', guard: true, gamingCheck: false },
  ]);
  writeFileSync(join(d, 'src.js'), 'module.exports={f:()=>1};\n');
  writeFileSync(join(d, 't.js'), "const a=require('assert');const{f,g}=require('./src');a.strictEqual(f(),1);a.strictEqual(g(),2);\n"); // g missing → fails
  writeFileSync(join(d, 'x.test.js'), 'ok\n');
  commitAll(d, 'base'); const base = rev(d);
  writeFileSync(join(d, 'src.js'), 'module.exports={f:()=>1,g:()=>2};\n'); // real source fix → tests pass
  writeFileSync(join(d, 'x.test.js'), 'ok\nok\nok\n');                      // test-side gain (asserts 1→3)
  commitAll(d, 'head');
  const r = pw(d, ['run', '--base', base, '--head', 'HEAD', '--detect-gaming', '--no-record']);
  assert.equal(r.code, 0, r.out);          // PASS — the test-side gain must not be flagged GAMED
  assert.doesNotMatch(r.out, /GAMED/);
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
  assert.equal(r.code, 0); // exit 0 = kept (the ✓ decision line now goes to stderr)
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

const jsonOf = (out) => JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)); // strip trailing stderr note

// -------------------------------------- R2: --working sees newly added (untracked) files
test('run --working: SEES newly added untracked files (the dominant agent action)', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'base');   // 0 TODOs committed
  writeFileSync(join(d, 'new.js'), 'x // TODO\n');                    // untracked new file
  const r = pw(d, ['run', '--working', '--no-record']);
  assert.equal(r.code, 1);                       // todos 0->1 guarded regression — only visible if untracked is snapshotted
  assert.ok(existsSync(join(d, 'new.js')));       // working tree untouched
  rmSync(d, { recursive: true, force: true });
});

test('improve: KEEPS a turn that adds a new file (used to delete it via clean -fd)', () => {
  const DONE = { name: 'done', cmd: 'grep -rho DONE . --include=*.js 2>/dev/null | wc -l', extract: 'number', direction: 'up', guard: true };
  const d = tmpRepo([DONE]);
  writeFileSync(join(d, 'app.js'), '// start\n'); commitAll(d, 'base');
  const r = pw(d, ['improve', '--attempt', 'printf "DONE\\n" > done.js']);
  assert.equal(r.code, 0);                          // exit 0 = kept
  assert.ok(existsSync(join(d, 'done.js')));       // the new file survived (the bug deleted it)
  rmSync(d, { recursive: true, force: true });
});

// ------------------------- R3: improve exit codes express loop progress + --json result
test('improve: exit 0=kept / 1=regression / 3=plateau, with --json result field', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  let r = pw(d, ['improve', '--json', '--attempt', "sed -i 's| // TODO||' app.js"]); // improves
  assert.equal(r.code, 0); assert.equal(jsonOf(r.out).result, 'kept');
  r = pw(d, ['improve', '--json', '--attempt', 'true']);                              // no-op
  assert.equal(r.code, 3); assert.equal(jsonOf(r.out).result, 'plateau');
  r = pw(d, ['improve', '--json', '--attempt', "echo 'z // TODO' >> app.js"]);        // regresses
  assert.equal(r.code, 1); assert.equal(jsonOf(r.out).result, 'regression');
  rmSync(d, { recursive: true, force: true });
});

// --------------------------------------------------------------- R4: init + presets
test('init: writes a starter config for the stack, refuses overwrite without --force', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-init-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"exit 0"}}');
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  let r = pw(d, ['init']);
  assert.equal(r.code, 0); assert.ok(existsSync(join(d, 'promptwheel.config.json')));
  const written = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics;
  assert.ok(written.some((m) => m.name === 'tests_pass'));
  assert.ok(written.some((m) => m.name === 'assertions'), 'default config includes antihack tripwires');
  assert.ok(!written.some((m) => m.name === 'lint_errors'), 'no lint metric when eslint is absent');
  assert.equal(pw(d, ['init']).code, 2);          // refuses overwrite
  assert.equal(pw(d, ['init', '--list']).code, 0); // catalog
  rmSync(d, { recursive: true, force: true });
});

// ---------------------- the newcomer's first cheat: gut the tests, metric stays flat
test('default init config: weakening the suite (flat metric) FAILS via tripwires', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-gut-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"node --test"}}');
  writeFileSync(join(d, 'src.mjs'), 'export const add=(a,b)=>a+b;\n');
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; import {add} from './src.mjs';\ntest('a', () => assert.equal(add(1,2),3));\ntest('b', () => assert.equal(add(2,2),4));\n");
  assert.equal(pw(d, ['init']).code, 0);
  commitAll(d, 'base');
  // gut the suite: tests_pass stays 1 → 1, but assertions/test_count drop
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test';\ntest('trivial', () => {});\n");
  const r = pw(d, ['run', '--working', '--no-record']);
  assert.equal(r.code, 1, r.out);               // guarded tripwire regression — not a silent PASS
  assert.match(r.out, /FAIL/);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------- config-level gamingThreshold flows through the gate
test('run --detect-gaming: gamingThreshold from config flips a half-retained win to GAMED', () => {
  const DONE = { name: 'done', cmd: 'grep -rho DONE . --include=*.js --include=*.mjs 2>/dev/null | wc -l', extract: 'number', direction: 'up', guard: true };
  const mk = (threshold) => {
    const d = tmpRepo([DONE]);
    if (threshold != null) {
      const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
      writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ ...cfg, gamingThreshold: threshold }));
    }
    writeFileSync(join(d, 'src.js'), '// start\n');
    writeFileSync(join(d, 'x.test.js'), '// tests\n');
    commitAll(d, 'base'); const base = rev(d);
    writeFileSync(join(d, 'src.js'), '// DONE\n');      // half the gain from source…
    writeFileSync(join(d, 'x.test.js'), '// DONE\n');   // …half from a test file
    commitAll(d, 'head');
    const r = pw(d, ['run', '--base', base, '--head', 'HEAD', '--detect-gaming', '--no-record']);
    rmSync(d, { recursive: true, force: true });
    return r;
  };
  assert.equal(mk(null).code, 0);                 // default 0.5: retained 0.5 → earned
  const r = mk(0.6);
  assert.equal(r.code, 2, r.out);                 // threshold 0.6: same change → GAMED
  assert.match(r.out, /GAMED/);
});

// ------------------------- corpus finding: the fake-green class (inert guard)
test('run: a guarded pass metric that never passes warns loudly instead of silent green', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'false', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'a.js'), '2\n'); commitAll(d, 'c1');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 0);                        // not a regression — but not silent either
  assert.match(r.out, /never passed at either ref/);
  rmSync(d, { recursive: true, force: true });
});

test('init: package.json WITHOUT a test script gets the self-describing placeholder', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-nots-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'package.json'), '{"name":"x"}');   // no scripts.test
  writeFileSync(join(d, 'a.js'), '1\n');
  assert.equal(pw(d, ['init']).code, 0);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.match(cfg.metrics.find((m) => m.name === 'tests_pass').cmd, /set your test command/);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------- self-heal: orphaned worktrees from a crashed run
test('self-heal: a stale /tmp worktree from a crashed run is cleaned on the next run', () => {
  const orphan = join(tmpdir(), 'promptwheel-ORPHANTEST');
  rmSync(orphan, { recursive: true, force: true });
  mkdirSync(orphan, { recursive: true });
  const old = new Date(Date.now() - 7200_000);     // 2h old → safely an orphan, not a live run
  utimesSync(orphan, old, old);
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  pw(d, ['run', '--working', '--no-record']);       // any gate triggers selfHeal first
  assert.equal(existsSync(orphan), false);          // the abandoned checkout was removed
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------- guardrail inheritance + observability
test('guards: inherits a base config, local overrides by name, reports provenance', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-inh-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'base.json'), JSON.stringify({ metrics: [
    { name: 'tests', cmd: 'true', extract: 'exit', direction: 'pass', guard: true },
    { name: 'lint', cmd: 'echo 0', extract: 'number', direction: 'down', guard: true },
  ] }));
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: './base.json', metrics: [
    { name: 'lint', cmd: 'echo 0', extract: 'number', direction: 'down', guard: false }, // loosen inherited guard → info
    { name: 'cost', cmd: 'echo 1', extract: 'number', direction: 'down', guard: true },  // add a local guard
  ] }));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  const r = pw(d, ['guards', '--json']);
  assert.equal(r.code, 0);
  const by = Object.fromEntries(JSON.parse(r.out).guards.map((x) => [x.name, x]));
  assert.equal(by.tests.source, 'base.json'); assert.equal(by.tests.guard, true);  // inherited + enforced
  assert.equal(by.lint.override, true); assert.equal(by.lint.guard, false);        // local override loosened it
  assert.equal(by.cost.source, 'local');                                           // added locally
  rmSync(d, { recursive: true, force: true });
});

test('extends: a diamond (two bases sharing a grandparent) is NOT a false cycle', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-diamond-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'd.json'), JSON.stringify({ metrics: [{ name: 'base_m', cmd: 'echo 1', extract: 'number', direction: 'up', guard: true }] }));
  writeFileSync(join(d, 'b.json'), JSON.stringify({ extends: './d.json', metrics: [{ name: 'b_m', cmd: 'echo 1', extract: 'number', direction: 'up' }] }));
  writeFileSync(join(d, 'c.json'), JSON.stringify({ extends: './d.json', metrics: [{ name: 'c_m', cmd: 'echo 1', extract: 'number', direction: 'up' }] }));
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: ['./b.json', './c.json'], metrics: [{ name: 'local_m', cmd: 'echo 1', extract: 'number', direction: 'up' }] }));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  const r = pw(d, ['guards', '--json']);
  assert.equal(r.code, 0); // diamond resolves — no false "cycle" exit 2
  const names = JSON.parse(r.out).guards.map((x) => x.name);
  for (const n of ['base_m', 'b_m', 'c_m', 'local_m']) assert.ok(names.includes(n), `missing ${n}`);
  rmSync(d, { recursive: true, force: true });
});

test('extends: a real self-cycle still exits 2', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-cycle-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: './promptwheel.config.json', metrics: [{ name: 'm', cmd: 'echo 1', extract: 'number', direction: 'up' }] }));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  assert.equal(pw(d, ['guards']).code, 2); // true cycle caught
  rmSync(d, { recursive: true, force: true });
});

test("guards: reports each guard's flag record from the stream", () => {
  const d = tmpRepo([TODOS]); // todos: direction down, guarded
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'c1'); // todos 0->2 = regression
  pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']); // records a flag
  const todos = JSON.parse(pw(d, ['guards', '--json']).out).guards.find((x) => x.name === 'todos');
  assert.equal(todos.guard, true);
  assert.ok(todos.flagged >= 1); // the regression shows up as a flag in the record
  rmSync(d, { recursive: true, force: true });
});
