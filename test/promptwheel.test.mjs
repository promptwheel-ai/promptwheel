// Dep-free test suite (node:test). Run: npm test  (or: node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, evaluate, median, spread, renderMarkdown, isNonSource, evaluatorMatcher, gain, judgeGaming, verdictFingerprint,
  check, verdictExitCode, conformsToContract, VERDICTS, METRIC_STATUSES, DIRECTIONS, CONTRACT_VERSION } from '../bin/promptwheel.mjs';

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
  assert.equal(rev(d), kept); // reverted, HEAD unchanged
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
  assert.equal(r.code, 1);                       // todos 0->1 guarded regression, only visible if untracked is snapshotted
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

test('improve: a gamed attempt (test edited to pass, source untouched) exits 2 and is reverted', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');   // BUG
  writeFileSync(join(d, 'calc.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; import { sub } from './calc.mjs'; test('s', () => assert.strictEqual(sub(5, 3), 2));\n");
  commitAll(d, 'base: red'); const base = rev(d);
  const r = pw(d, ['improve', '--json', '--attempt', "sed -i 's|, 2))|, 8))|' calc.test.mjs"]); // green by editing the TEST
  assert.equal(r.code, 2, r.out); assert.equal(jsonOf(r.out).result, 'gamed');
  assert.equal(rev(d), base);                                                     // reverted, no commit
  assert.match(readFileSync(join(d, 'calc.test.mjs'), 'utf8'), /, 2\)\)/);         // the test edit is gone
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

test('init --preset security-antihack: security gate + tripwires + evaluatorPaths + installed pack', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-secah-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const r = pw(d, ['init', '--preset', 'security-antihack']);
  assert.equal(r.code, 0, r.out);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  const names = cfg.metrics.map((m) => m.name);
  assert.ok(names.includes('security_findings'), 'has the security-findings gate');
  assert.ok(names.includes('suppressions'), 'has the antihack suppression tripwire');
  assert.ok(Array.isArray(cfg.evaluatorPaths) && cfg.evaluatorPaths.length, 'ships a starter evaluatorPaths');
  const sf = cfg.metrics.find((m) => m.name === 'security_findings');
  assert.match(sf.cmd, /\.promptwheel\/packs\/security\//, 'pack path rewritten into .promptwheel (evaluator-protected)');
  assert.ok(existsSync(join(d, '.promptwheel/packs/security/scan.mjs')), 'scanner pack copied in');
  assert.match(cfg.metrics.find((m) => m.name === 'suppressions').cmd, /nosec/, 'suppression tripwire also greps bandit-style # nosec');
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
  assert.equal(r.code, 0); // diamond resolves, no false "cycle" exit 2
  const names = JSON.parse(r.out).guards.map((x) => x.name);
  for (const n of ['base_m', 'b_m', 'c_m', 'local_m']) assert.ok(names.includes(n), `missing ${n}`);
  rmSync(d, { recursive: true, force: true });
});

test('extends: a real self-cycle still exits 64 (config error)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-cycle-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: './promptwheel.config.json', metrics: [{ name: 'm', cmd: 'echo 1', extract: 'number', direction: 'up' }] }));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
  assert.equal(pw(d, ['guards']).code, 64); // true cycle caught
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

// --- security guard-pack (decanted from securitychecks) ---
test('security pack: scanner detects P0 invariants and passes clean code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-sec-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'),
    "res.setHeader('Access-Control-Allow-Origin', '*');\nconst STRIPE_SECRET = 'sk_live_x';\n");
  const scan = join(dirname(ENGINE), '..', 'packs', 'security', 'scan.mjs');
  const vuln = Number(execFileSync('node', [scan, dir], { encoding: 'utf8' }).trim());
  assert.ok(vuln >= 2, `expected >=2 findings, got ${vuln}`);
  writeFileSync(join(dir, 'src/a.ts'), 'export const add = (a, b) => a + b;\n');
  const clean = Number(execFileSync('node', [scan, dir], { encoding: 'utf8' }).trim());
  assert.equal(clean, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("published tarball includes every file the CLI shells out to", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes("packs/security/scan.mjs"),
    "security playbook's scanner must ship in the tarball");
});

test("a preset whose command cannot run must NOT pass, cold llm-eval with missing scripts", () => {
  const d = mkdtempSync(join(tmpdir(), "pw-preset-"));
  const g = (a) => execFileSync("git", ["-C", d, ...a], { env: { ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g(["init", "-q"]);
  writeFileSync(join(d, "a.js"), "let x = 1;\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "one"]);
  execFileSync(process.execPath, [ENGINE, "init", "--preset", "llm-eval"], { cwd: d, encoding: "utf8" });
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [ENGINE, "run", "--base", "HEAD", "--head", "HEAD"], { cwd: d, encoding: "utf8" });
  } catch (e) { code = e.status; out = `${e.stdout || ""}${e.stderr || ""}`; }
  assert.notEqual(code, 0, "missing eval scripts must not exit 0");
  assert.ok(!/verdict:\s*PASS/i.test(out), "must not report PASS: " + out.slice(-200));
});

test("security preset installs its pack into the repo and the scanner actually runs", () => {
  const d = mkdtempSync(join(tmpdir(), "pw-sec-"));
  const g = (a) => execFileSync("git", ["-C", d, ...a], { env: { ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g(["init", "-q"]);
  writeFileSync(join(d, "a.js"), "let x = 1;\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "one"]);
  execFileSync(process.execPath, [ENGINE, "init", "--preset", "security"], { cwd: d, encoding: "utf8" });
  assert.ok(existsSync(join(d, ".promptwheel", "packs", "security", "scan.mjs")), "pack copied into repo");
  const cfg = JSON.parse(readFileSync(join(d, "promptwheel.config.json"), "utf8"));
  assert.match(cfg.metrics[0].cmd, /\.promptwheel\/packs\/security\/scan\.mjs/);
  g(["add", "-A"]); g(["commit", "-q", "-m", "wire promptwheel"]);
  const out = execFileSync(process.execPath, [ENGINE, "run", "--base", "HEAD", "--head", "HEAD", "--json"], { cwd: d, encoding: "utf8" });
  const rep = JSON.parse(out);
  assert.notEqual(rep.metrics[0].status, "unmeasurable", "scanner must actually run");
});

test("deleting the copied security pack's patterns is GAMED, not an improvement", () => {
  const d = mkdtempSync(join(tmpdir(), "pw-game-"));
  const g = (a) => execFileSync("git", ["-C", d, ...a], { env: { ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g(["init", "-q"]);
  writeFileSync(join(d, "app.js"), "const secret = 'AKIA1234567890ABCDEF';\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "base with a finding"]);
  execFileSync(process.execPath, [ENGINE, "init", "--preset", "security"], { cwd: d, encoding: "utf8" });
  g(["add", "-A"]); g(["commit", "-q", "-m", "wire security gate"]);
  // the cheat: gut the pattern database, touch nothing else
  writeFileSync(join(d, ".promptwheel", "packs", "security", "patterns.json"),
    JSON.stringify({ patterns: [] }) + "\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "improve security posture"]);
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath,
      [ENGINE, "run", "--base", "HEAD~1", "--head", "HEAD", "--detect-gaming", "--json"],
      { cwd: d, encoding: "utf8" });
  } catch (e) { code = e.status; out = `${e.stdout || ""}`; }
  const rep = JSON.parse(out);
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
  assert.throws(() => check({ repo: d, auto: false }), /no promptwheel\.config\.json/);
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

// ---------------------------------------------------------- integration: conformance CLI
test('conformance CLI: a conforming run exits 0; malformed JSON exits 1', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'improve');
  const ok = pw(d, ['conformance', '--cmd', `node ${ENGINE} run --base HEAD~1 --head HEAD --no-record --json`]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /conforms to the Verified-Outcome Contract/);
  writeFileSync(join(d, 'bad.json'), JSON.stringify({ base: 'a', head: 'b', verdict: 'green', metrics: [] }));
  const bad = pw(d, ['conformance', 'bad.json']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /does NOT conform/);
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
  r = pw(d, ['improve']);                                   // missing --attempt
  assert.equal(r.code, 64, r.out);
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
