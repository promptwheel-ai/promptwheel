#!/usr/bin/env node
// Build the "catch your agent gaming the metric" demo as an asciicast (v2) and, when `agg`
// is on PATH, render demo/promptwheel.gif. Zero-dep. The terminal frames are synthesized from
// the REAL `promptwheel run` output (captured from a throwaway repo), so the GIF shows exactly
// what the tool prints, with only the narration lines and the shell prompt added for framing.
//
//   node demo/make-demo.mjs
//
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'bin', 'promptwheel.mjs');
const CAST = join(HERE, 'promptwheel.cast');
const GIF = join(HERE, 'promptwheel.gif');
const COLS = 86, ROWS = 24;

// ---- a throwaway repo: c1 task (red) -> c2 cheat (edit the test) -> c3 honest fix ----
const d = mkdtempSync(join(tmpdir(), 'pw-demo-'));
const g = (a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
const rev = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
g(['init', '-q']); g(['config', 'user.email', 'demo@demo']); g(['config', 'user.name', 'demo']); g(['config', 'commit.gpgsign', 'false']);
writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
writeFileSync(join(d, 'promptwheel.config.json'),
  JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [
    { name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true } ] }, null, 2) + '\n');
writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;   // BUG: should be a - b\n');
const TEST = (expect) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { sub } from './calc.mjs';\ntest('sub(5,3) === 2', () => assert.strictEqual(sub(5, 3), ${expect}));\n`;
writeFileSync(join(d, 'calc.test.mjs'), TEST(2));
g(['add', '-A']); g(['commit', '-qm', 'task: make sub(5,3) return 2 (test is red)']);
const c1 = rev();
writeFileSync(join(d, 'calc.test.mjs'), TEST(8));                 // c2: the cheat
g(['add', '-A']); g(['commit', '-qm', 'make the test pass']);
const c2 = rev();
g(['checkout', '-q', c1]);
writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;   // actually fixed\n');  // c3: honest fix
writeFileSync(join(d, 'calc.test.mjs'), TEST(2));
g(['add', '-A']); g(['commit', '-qm', 'fix sub in the source']);
const c3 = rev();

const run = (base, head) => {
  try { return { out: execFileSync('node', [ENGINE, 'run', '--base', base, '--head', head, '--no-record'], { cwd: d, encoding: 'utf8' }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '').toString(), code: typeof e.status === 'number' ? e.status : 1 }; }
};
const gamed = run(c1, c2);
const pass = run(c1, c3);
rmSync(d, { recursive: true, force: true });

// ---- synthesize the asciicast ----
const CY = (s) => `\x1b[1;36m${s}\x1b[0m`;     // narration (framing, not tool output)
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const PR = '\x1b[1;32m$\x1b[0m ';              // shell prompt
const nl = (s) => s.replace(/\n/g, '\r\n');
const events = [];
let t = 0;
const at = (dt, data) => { t = +(t + dt).toFixed(3); events.push([t, 'o', data]); };
const line = (dt, s) => at(dt, nl(s + '\n'));

line(0.4, CY('  promptwheel: catch your agent gaming the metric'));
line(0.4, '');
line(0.8, DIM('  task for the agent: make sub(5,3) return 2. the code is wrong, the test is red.'));
line(1.3, CY('  attempt 1: the agent edits the TEST to expect the bug, the suite goes green.'));
at(0.5, PR); at(0.7, nl(`promptwheel run --base ${c1} --head ${c2}\n`));
at(1.1, nl(gamed.out.replace(/^\n/, '')));
at(0.5, PR); at(0.5, nl('echo $?\n')); at(0.5, nl(`${gamed.code}\n`));
line(1.8, DIM('  the source never changed. the green did not survive a source-only re-run.'));
line(1.4, CY('  attempt 2: the agent fixes the SOURCE instead.'));
at(0.5, PR); at(0.7, nl(`promptwheel run --base ${c1} --head ${c3}\n`));
at(1.1, nl(pass.out.replace(/^\n/, '')));
at(0.5, PR); at(0.5, nl('echo $?\n')); at(0.5, nl(`${pass.code}\n`));
line(1.8, CY('  a green now means the code was fixed, not the test. deterministic, zero-LLM.'));
at(2.5, '');

const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(Date.now() / 1000), env: { TERM: 'xterm-256color' } };
writeFileSync(CAST, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
console.log(`wrote ${CAST}  (verdicts: attempt1=${gamed.code === 2 ? 'GAMED' : gamed.code}, attempt2=${pass.code === 0 ? 'PASS' : pass.code})`);

let agg = null;
try { execFileSync('sh', ['-c', 'command -v agg'], { stdio: 'ignore' }); agg = 'agg'; } catch { /* not installed */ }
if (agg) {
  execFileSync('agg', ['--font-size', '18', '--cols', String(COLS), '--rows', String(ROWS), CAST, GIF], { stdio: 'inherit' });
  console.log(`wrote ${GIF}`);
} else {
  console.log('agg not found; install it (https://github.com/asciinema/agg) and run: agg demo/promptwheel.cast demo/promptwheel.gif');
}
