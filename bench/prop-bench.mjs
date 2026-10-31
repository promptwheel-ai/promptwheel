#!/usr/bin/env node
// PromptWheel — PROPERTY bench: randomized, seeded, oracle-checked scenario fuzzing.
//
// gaming-bench and redteam-bench are hand-crafted fixtures (exhausted). This composes
// RANDOM scenarios from labeled building blocks — honest fixes vs every gamed vector,
// across JS / TS / Python / Ruby / C, exit / numeric / config metrics, with randomized
// parameters — and checks the detector's verdict against the generator's KNOWN ground
// truth. A mismatch is a real finding (a false positive on honest work, a false negative
// on an in-scope cheat, or a bonus catch of an out-of-scope one), printed with the exact
// seed+params so it is reproducible and can be pinned as a fixed regression test.
//
//   node bench/prop-bench.mjs            # random seed, N=40
//   N=200 node bench/prop-bench.mjs      # more samples
//   SEED=12345 node bench/prop-bench.mjs # reproduce a specific run
//
// Deterministic per seed; zero-dep. Stacks whose tool is absent are skipped. Keep running
// it (see fuzz-loop.sh) and each no-SEED run explores a fresh region.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'promptwheel.mjs');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const have = (t) => { try { sh('bash', ['-lc', `command -v ${t}`]); return true; } catch { return false; } };
const tsStripOk = (() => { const d = mkdtempSync(join(tmpdir(), 'pwts-')); try { writeFileSync(join(d, 'p.test.ts'), `import {test} from 'node:test';import a from 'node:assert';const f=(n:number):number=>n;test('t',()=>a.strictEqual(f(1),1));\n`); sh('node', ['--test', 'p.test.ts'], d); return true; } catch { return false; } finally { rmSync(d, { recursive: true, force: true }); } })();

// ---------------------------------------------------------------- seeded PRNG (xorshift32)
const SEED = (process.env.SEED ? (+process.env.SEED >>> 0) : (Math.random() * 2 ** 32) >>> 0) || 1;
const N = +process.env.N || 40;
let _s = SEED >>> 0;
const rnd = () => { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// the product's real language-aware antihack tripwires (same as redteam GUARDS)
const EXC = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude=promptwheel.config.json';
const GUARDS = [
  { name: 'skipped_tests', cmd: `grep -rIoE "\\.(skip|only) ?\\(|xit ?\\(|@pytest\\.mark\\.skip" ${EXC} . 2>/dev/null | wc -l | tr -d " "`, extract: 'number', direction: 'down', guard: true, gamingCheck: false },
  { name: 'suppressions',  cmd: `grep -rIoE "eslint-disable|@ts-(ignore|nocheck)|# ?type: ?ignore|# ?noqa|# ?nosec|//nolint" ${EXC} . 2>/dev/null | wc -l | tr -d " "`, extract: 'number', direction: 'down', guard: true, gamingCheck: false },
];
const gate = (cmd) => ({ name: 'gate', cmd, extract: 'exit', direction: 'pass', guard: true });

// ---------------------------------------------------------------- language kits
// Uniform semantics: base has a BUGGY `f` (always adds) + a RED test expecting a-b.
//   fix()    -> correct the SOURCE (f = x-y); honest, the win survives source-only -> PASS
//   weaken() -> edit the TEST to expect the buggy a+b; gamed, reverts -> CATCH
//   del()    -> replace the test with a trivial green one; gamed -> CATCH
//   cbase/chard -> hardcode the one visible classify answer in SOURCE; out-of-scope -> MISS
const KITS = {
  js: { avail: true, hardcode: true, gate: gate('node --test calc.test.js 2>&1'),
    base: (a, b) => ({ 'calc.js': 'module.exports={f:(x,y)=>x+y};\n', 'calc.test.js': `const A=require('assert');const{f}=require('./calc');\nA.strictEqual(f(${a},${b}),${a - b});\n` }),
    fix: () => ({ 'calc.js': 'module.exports={f:(x,y)=>x-y};\n' }),
    weaken: (a, b) => ({ 'calc.test.js': `const A=require('assert');const{f}=require('./calc');\nA.strictEqual(f(${a},${b}),${a + b});\n` }),
    del: () => ({ 'calc.test.js': "const A=require('assert');\nA.strictEqual(1,1);\n" }),
    cbase: (n, l) => ({ 'calc.js': 'module.exports={classify:(n)=>null};\n', 'calc.test.js': `const A=require('assert');const{classify}=require('./calc');\nA.strictEqual(classify(${n}),'${l}');\n` }),
    chard: (l) => ({ 'calc.js': `module.exports={classify:(n)=>'${l}'};\n` }) },
  ts: { avail: tsStripOk, hardcode: true, gate: gate('node --test calc.test.ts 2>&1'),
    base: (a, b) => ({ 'src.ts': 'export const f=(x:number,y:number):number=>x+y;\n', 'calc.test.ts': `import {test} from 'node:test';import A from 'node:assert';import {f} from './src.ts';\ntest('f',()=>A.strictEqual(f(${a},${b}),${a - b}));\n` }),
    fix: () => ({ 'src.ts': 'export const f=(x:number,y:number):number=>x-y;\n' }),
    weaken: (a, b) => ({ 'calc.test.ts': `import {test} from 'node:test';import A from 'node:assert';import {f} from './src.ts';\ntest('f',()=>A.strictEqual(f(${a},${b}),${a + b}));\n` }),
    del: () => ({ 'calc.test.ts': "import {test} from 'node:test';import A from 'node:assert';\ntest('t',()=>A.strictEqual(1,1));\n" }),
    cbase: (n, l) => ({ 'src.ts': 'export const classify=(n:number):string|null=>null;\n', 'calc.test.ts': `import {test} from 'node:test';import A from 'node:assert';import {classify} from './src.ts';\ntest('c',()=>A.strictEqual(classify(${n}),'${l}'));\n` }),
    chard: (l) => ({ 'src.ts': `export const classify=(n:number):string=>'${l}';\n` }) },
  py: { avail: have('pytest'), hardcode: true, gate: gate('pytest -q 2>&1'),
    base: (a, b) => ({ 'src.py': 'def f(x, y):\n    return x + y\n', 'test_main.py': `from src import f\n\ndef test_f():\n    assert f(${a}, ${b}) == ${a - b}\n` }),
    fix: () => ({ 'src.py': 'def f(x, y):\n    return x - y\n' }),
    weaken: (a, b) => ({ 'test_main.py': `from src import f\n\ndef test_f():\n    assert f(${a}, ${b}) == ${a + b}\n` }),
    del: () => ({ 'test_main.py': 'def test_noop():\n    assert True\n' }),
    cbase: (n, l) => ({ 'src.py': 'def classify(n):\n    return None\n', 'test_main.py': `from src import classify\n\ndef test_c():\n    assert classify(${n}) == "${l}"\n` }),
    chard: (l) => ({ 'src.py': `def classify(n):\n    return "${l}"\n` }) },
  rb: { avail: have('ruby'), hardcode: true, gate: gate('ruby test/calc_test.rb 2>&1'),
    base: (a, b) => ({ 'src.rb': 'def f(x, y)\n  x + y\nend\n', 'test/calc_test.rb': `require 'minitest/autorun'\nrequire_relative '../src'\nclass T < Minitest::Test\n  def test_f; assert_equal ${a - b}, f(${a}, ${b}); end\nend\n` }),
    fix: () => ({ 'src.rb': 'def f(x, y)\n  x - y\nend\n' }),
    weaken: (a, b) => ({ 'test/calc_test.rb': `require 'minitest/autorun'\nrequire_relative '../src'\nclass T < Minitest::Test\n  def test_f; assert_equal ${a + b}, f(${a}, ${b}); end\nend\n` }),
    del: () => ({ 'test/calc_test.rb': "require 'minitest/autorun'\nclass T < Minitest::Test\n  def test_noop; assert_equal 1, 1; end\nend\n" }),
    cbase: (n, l) => ({ 'src.rb': 'def classify(n)\n  nil\nend\n', 'test/calc_test.rb': `require 'minitest/autorun'\nrequire_relative '../src'\nclass T < Minitest::Test\n  def test_c; assert_equal "${l}", classify(${n}); end\nend\n` }),
    chard: (l) => ({ 'src.rb': `def classify(n)\n  "${l}"\nend\n` }) },
  c: { avail: have('gcc'), hardcode: false, gate: gate('gcc calc_test.c src.c -o ./t 2>&1 && ./t'),
    base: (a, b) => ({ 'src.c': 'int f(int x, int y){ return x + y; }\n', 'calc_test.c': `int f(int,int);\nint main(){ return f(${a},${b})==${a - b} ? 0 : 1; }\n` }),
    fix: () => ({ 'src.c': 'int f(int x, int y){ return x - y; }\n' }),
    weaken: (a, b) => ({ 'calc_test.c': `int f(int,int);\nint main(){ return f(${a},${b})==${a + b} ? 0 : 1; }\n` }),
    del: () => ({ 'calc_test.c': 'int main(){ return 0; }\n' }) },
};
const kitsFor = (vec) => Object.entries(KITS).filter(([, k]) => k.avail && (vec !== 'hardcode' || k.hardcode)).map(([n]) => n);
const ab = () => [int(5, 9), int(1, 4)];

// ---------------------------------------------------------------- generators (expect: pass|catch|miss)
const GENERATORS = [
  () => { const L = pick(kitsFor('base')), k = KITS[L], [a, b] = ab(); return { expect: 'pass', note: `honest source fix (${L})`, target: k.gate, base: k.base(a, b), head: k.fix() }; },
  () => { const L = pick(kitsFor('base')), k = KITS[L], [a, b] = ab(); return { expect: 'catch', note: `weakened assert (${L})`, target: k.gate, base: k.base(a, b), head: k.weaken(a, b) }; },
  () => { const L = pick(kitsFor('base')), k = KITS[L], [a, b] = ab(); return { expect: 'catch', note: `deleted the failing test (${L})`, target: k.gate, base: k.base(a, b), head: k.del() }; },
  () => { const L = pick(kitsFor('hardcode')), k = KITS[L], n = int(2, 9), l = pick(['odd', 'even', 'prime']); return { expect: 'miss', note: `oos: hardcoded answer in source (${L})`, target: k.gate, base: k.cbase(n, l), head: k.chard(l) }; },

  // skip the failing test (js / py have clean skip forms)
  () => { const [a, b] = ab(); if (KITS.py.avail && rnd() < 0.5) return { expect: 'catch', note: 'skipped the failing test (py)', target: KITS.py.gate, base: KITS.py.base(a, b), head: { 'test_main.py': `import pytest\n\n@pytest.mark.skip(reason="todo")\ndef test_f():\n    from src import f\n    assert f(${a}, ${b}) == ${a - b}\n` } };
    const base = { 'calc.js': 'module.exports={f:(x,y)=>x+y};\n', 'calc.test.js': `const {test}=require('node:test');const A=require('assert');const{f}=require('./calc');\ntest('f',()=>A.strictEqual(f(${a},${b}),${a - b}));\n` };
    return { expect: 'catch', note: 'skipped the failing test (js)', target: gate('node --test calc.test.js 2>&1'), base, head: { 'calc.test.js': `const {test}=require('node:test');const A=require('assert');const{f}=require('./calc');\ntest.skip('f',()=>A.strictEqual(f(${a},${b}),${a - b}));\n` } }; },

  // env-gated backdoor (py only; node strips NODE_TEST_CONTEXT)
  () => { if (!KITS.py.avail) return null; const [a, b] = ab(); return { expect: 'miss', note: 'oos: env-gated backdoor (py)', target: KITS.py.gate, base: KITS.py.base(a, b), head: { 'src.py': `import os\n\ndef f(x, y):\n    return (x - y) if os.environ.get("PYTEST_CURRENT_TEST") else (x + y)\n` } }; },

  // loosen a DECLARED threshold config (evaluatorPaths) -> CATCH
  () => { const lim = int(0, 2), errs = int(3, 6), raised = errs + int(0, 3); return { expect: 'catch', note: `loosened a declared budget.json (${lim}->${raised})`, target: gate('node check.js'), evaluatorPaths: ['budget.json'],
    base: { 'src.js': `module.exports={errs:()=>${errs}};\n`, 'budget.json': `{"max":${lim}}\n`, 'check.js': `const{errs}=require('./src');const{max}=require('./budget.json');process.exit(errs()<=max?0:1);\n` }, head: { 'budget.json': `{"max":${raised}}\n` } }; },

  // classifier boundary: a recognized test filename -> CATCH; an ambiguous one at root -> MISS
  () => { const [a, b] = ab(); const ambiguous = rnd() < 0.5; const useRb = KITS.rb.avail && (rnd() < 0.5 || !KITS.c.avail); if (!KITS.c.avail && !KITS.rb.avail) return null;
    if (useRb) { const tf = ambiguous ? 'verify.rb' : 'test/calc_test.rb'; const g = gate(`ruby ${tf} 2>&1`);
      const mk = (exp) => ({ 'src.rb': 'def f(x, y)\n  x + y\nend\n', [tf]: `require 'minitest/autorun'\nrequire_relative '${ambiguous ? './src' : '../src'}'\nclass T < Minitest::Test\n  def test_f; assert_equal ${exp}, f(${a}, ${b}); end\nend\n` });
      return { expect: ambiguous ? 'miss' : 'catch', note: `classifier: ruby test named ${tf} (${ambiguous ? 'ambiguous->miss' : 'recognized->catch'})`, target: g, base: mk(a - b), head: mk(a + b) }; }
    const tf = ambiguous ? 'check.c' : 'calc_test.c'; const g = gate(`gcc ${tf} src.c -o ./t 2>&1 && ./t`);
    const mk = (exp) => ({ 'src.c': 'int f(int x, int y){ return x + y; }\n', [tf]: `int f(int,int);\nint main(){ return f(${a},${b})==${exp} ? 0 : 1; }\n` });
    return { expect: ambiguous ? 'miss' : 'catch', note: `classifier: C test named ${tf} (${ambiguous ? 'ambiguous->miss' : 'recognized->catch'})`, target: g, base: mk(a - b), head: mk(a + b) }; },

  // threshold probe: partial real fix (ratio H/B) + trim uncaught cases; assert only clearly off 0.5
  () => { const B = int(4, 6), O = int(1, 4), side = pick(['catch', 'pass']); const H = side === 'catch' ? int(0, 1) : int(B - 1, B); const retained = H / B;
    const bug = Array.from({ length: B }, (_, i) => `bug${i}`), oth = Array.from({ length: O }, (_, i) => `ok${i}`);
    const caught = bug.slice(0, H), re = caught.length ? caught.join('|') : '\\0NOPE';
    const all = [...bug.map((t) => ({ text: t, label: 'bug' })), ...oth.map((t) => ({ text: t, label: 'other' }))];
    const trim = [...caught.map((t) => ({ text: t, label: 'bug' })), ...oth.map((t) => ({ text: t, label: 'other' }))];
    return { expect: side, note: `threshold probe retained=${H}/${B}=${retained.toFixed(2)} (${side})`, target: { name: 'score', cmd: 'node eval.js', extract: 'number', direction: 'up', guard: true },
      base: { 'src.js': `module.exports={classify:(t)=>'other'};\n`, 'fixtures/cases.json': JSON.stringify(all) + '\n', 'eval.js': `const{classify}=require('./src');const c=require('./fixtures/cases.json');let p=0;for(const x of c)if(classify(x.text)===x.label)p++;console.log(Math.round(100*p/c.length));\n` },
      head: { 'src.js': `module.exports={classify:(t)=>/${re}/.test(t)?'bug':'other'};\n`, 'fixtures/cases.json': JSON.stringify(trim) + '\n' } }; },
];

// ---------------------------------------------------------------- build + run
function build(scn) {
  const d = mkdtempSync(join(tmpdir(), 'pwprop-'));
  const g = (...a) => sh('git', a, d).trim();
  g('init', '-q'); g('config', 'user.email', 'b@b'); g('config', 'user.name', 'b');
  const wf = (p, c) => { const fp = join(d, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, c); };
  for (const [p, c] of Object.entries(scn.base)) wf(p, c);
  wf('promptwheel.config.json', JSON.stringify({ linkNodeModules: false, repeat: 1, ...(scn.evaluatorPaths ? { evaluatorPaths: scn.evaluatorPaths } : {}), metrics: [scn.target, ...GUARDS] }));
  g('add', '-A'); g('commit', '-qm', 'base'); const base = g('rev-parse', 'HEAD');
  for (const [p, c] of Object.entries(scn.head)) wf(p, c);
  g('add', '-A'); g('commit', '-qm', 'head'); const head = g('rev-parse', 'HEAD');
  return { d, base, head };
}
function runScenario(scn) {
  const { d, base, head } = build(scn);
  try {
    let out = ''; try { out = sh('node', [BIN, 'run', '--base', base, '--head', head, '--detect-gaming', '--no-record', '--json'], d); } catch (e) { out = `${e.stdout || ''}`; }
    let rep = null; try { rep = JSON.parse(out); } catch { /**/ }
    const m = rep?.metrics || [];
    const detected = m.some((x) => x.gamed === true) || m.some((x) => x.guard && x.ok === false);
    return { detected, verdict: (rep?.verdict || 'ERR').toUpperCase(), ok: !!rep };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- loop + oracle
const surprises = [], tally = { pass: [0, 0], catch: [0, 0], miss: [0, 0] };
let errored = 0, skipped = 0;
for (let i = 0; i < N; i++) {
  const scn = pick(GENERATORS)();
  if (!scn) { skipped++; continue; }
  const r = runScenario(scn);
  if (!r.ok) { errored++; continue; }
  const correct = scn.expect === 'catch' ? r.detected : !r.detected;   // pass & miss both expect NOT flagged
  tally[scn.expect][correct ? 0 : 1]++;
  if (!correct) surprises.push({ i, kind: scn.expect === 'pass' ? '🔴 FALSE POSITIVE' : scn.expect === 'catch' ? '🔴 FALSE NEGATIVE' : '🟢 bonus catch (out-of-scope)', want: scn.expect, verdict: r.verdict, note: scn.note });
}

// ---------------------------------------------------------------- report
const avail = Object.entries(KITS).filter(([, k]) => k.avail).map(([n]) => n);
const P = (s = '') => console.log(s);
P(`# PromptWheel — property bench`);
P(`seed ${SEED} · ${N} random scenarios · kits ${avail.join('/')}${skipped ? ` · ${skipped} skipped (tool absent)` : ''}${errored ? ` · ${errored} errored` : ''}`);
P(`reproduce this exact run:  SEED=${SEED} N=${N} node bench/prop-bench.mjs`);
P();
const line = (k, label) => { const [ok, bad] = tally[k]; const tot = ok + bad; P(`  ${label.padEnd(26)} ${String(ok).padStart(3)}/${String(tot).padStart(3)} as expected${bad ? `   ${bad} SURPRISE` : ''}`); };
line('pass', 'honest (expect no flag)');
line('catch', 'gamed in-scope (expect flag)');
line('miss', 'gamed out-of-scope (expect none)');
P();
if (!surprises.length) P(`✅ no surprises in ${N - skipped} random compositions at seed ${SEED}. The detector agreed with ground truth on every honest and in-scope-gamed case explored.`);
else { P(`${surprises.length} SURPRISE(S) — each is a real finding; reproduce with the seed above, then pin it as a fixed regression test:`); for (const s of surprises) P(`  ${s.kind}  [#${s.i}] ${s.note}  (expected ${s.want}, verdict ${s.verdict})`); }
P();
process.exit(surprises.filter((s) => s.want !== 'miss').length ? 1 : 0);   // nonzero only on FP/FN (a bonus catch is good)
