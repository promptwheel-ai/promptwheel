#!/usr/bin/env node
// flaky-bench: labeled flaky-fixture benchmark for `promptwheel flaky`.
// Five fixture classes, each with a KNOWN ground-truth axis (or stability);
// the bench runs the CLI against each and reports detection vs truth.
// Run: node bench/flaky-bench.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptwheel.mjs');
const NODE_TEST = (body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`;

function fixture(files, config) {
  const d = mkdtempSync(join(tmpdir(), 'pw-flaky-bench-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 'b@b']); g(['config', 'user.name', 'b']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\nstate.tmp\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(config));
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  return d;
}
const run = (d, args) => {
  try { return JSON.parse(execFileSync('node', [ENGINE, 'flaky', '--json', ...args], { cwd: d, encoding: 'utf8' })); }
  catch (e) { return JSON.parse(`${e.stdout || ''}`); }
};

const CASES = [
  { name: 'stable suite', truth: [], build: () => fixture(
      { 'ok.test.mjs': NODE_TEST(`test('ok', () => assert.ok(true));`) },
      { linkNodeModules: false, env: { TZ: 'UTC' }, metrics: [{ name: 'tests_pass', cmd: 'node --test ok.test.mjs', direction: 'pass', extract: 'exit', guard: true }] }) },
  { name: 'timezone-dependent assert', truth: ['time'], build: () => fixture(
      { 'tz.test.mjs': NODE_TEST(`test('tz', () => { const t = 1750000000000; assert.equal(new Date(t).getHours(), new Date(t).getUTCHours()); });`) },
      { linkNodeModules: false, env: { TZ: 'UTC' }, metrics: [{ name: 'tests_pass', cmd: 'node --test tz.test.mjs', direction: 'pass', extract: 'exit', guard: true }] }) },
  { name: 'seed-dependent (env-consumed)', truth: ['seed'], build: () => fixture(
      { 'seed.test.mjs': NODE_TEST(`test('seed', () => assert.notEqual(process.env.PW_SEED, '1337'));`) },
      { linkNodeModules: false, metrics: [{ name: 'tests_pass', cmd: 'node --test seed.test.mjs', direction: 'pass', extract: 'exit', guard: true }] }) },
  { name: 'order-dependent (shared state)', truth: ['order'], build: () => fixture(
      { 'a.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync('state.tmp', 'x');`,
        'b.mjs': `import { existsSync } from 'node:fs'; process.exit(existsSync('state.tmp') ? 0 : 1);` },
      { linkNodeModules: false, metrics: [{ name: 'tests_pass', cmd: 'rm -f state.tmp && node a.mjs && node b.mjs', direction: 'pass', extract: 'exit', guard: true }],
        flaky: { axes: { order: { variants: [{ label: 'reversed', cmd: 'rm -f state.tmp && node b.mjs && node a.mjs' }] } } } }) },
  { name: 'db-isolation-dependent (config axis)', truth: ['db'], build: () => fixture(
      { 'db.test.mjs': NODE_TEST(`test('db', () => assert.notEqual(process.env.DISABLE_TX, '1'));`) },
      { linkNodeModules: false, metrics: [{ name: 'tests_pass', cmd: 'node --test db.test.mjs', direction: 'pass', extract: 'exit', guard: true }],
        flaky: { axes: { db: { variants: [{ label: 'DISABLE_TX=1 (rollback off)', env: { DISABLE_TX: '1' } }] } } } }) },
  { name: 'unstable at rest (race)', truth: ['base'], build: () => fixture(
      { 'race.test.mjs': NODE_TEST(`test('race', () => assert.ok(process.hrtime()[1] % 2 === 0));`) },
      { linkNodeModules: false, metrics: [{ name: 'tests_pass', cmd: 'node --test race.test.mjs', direction: 'pass', extract: 'exit', guard: true }] }) },
];

let correct = 0;
console.log('fixture'.padEnd(38), 'truth'.padEnd(8), 'detected'.padEnd(14), 'score', ' verdict');
for (const c of CASES) {
  const d = c.build();
  const rep = run(d, ['--runs', '4']);
  const detected = [...(rep.baseUnstable ? ['base'] : []), ...rep.flipped];
  const truthSet = new Set(c.truth);
  const ok = c.truth.every((t) => detected.includes(t)) && (c.truth.length > 0) === (rep.verdict === 'FLAKY' || rep.baseUnstable);
  if (ok) correct++;
  console.log(c.name.padEnd(38), (c.truth.join(',') || '—').padEnd(8), (detected.join(',') || '—').padEnd(14), String(rep.score).padStart(3), '  ' + rep.verdict + (ok ? '' : '   ✗ MISS'));
  rmSync(d, { recursive: true, force: true });
}
console.log(`\n${correct}/${CASES.length} fixtures correctly attributed`);
process.exit(correct === CASES.length ? 0 : 1);
