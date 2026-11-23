#!/usr/bin/env node
// The compounding test: does an agent that is shown the playbook keep more of its attempts than one that is not?
// It is the claim gate for the record's views (docs/LEARNING.md): no page says the loop gets better with use until
// the playbook arm beats the control arm here, on real use, judged by the check itself. A result that shows no gap
// is a result too, and is written down the same way.
//
//   node bench/compounding-ab.mjs --repo <dir> --attempts 20 --agent '<cmd>'
//     The arms take turns. The playbook arm gets PW_PLAYBOOK=<a file holding a fresh `promptwheel playbook`>;
//     the control arm gets PW_PLAYBOOK="". The agent command decides how to use it, for example:
//       --agent 'claude -p "$(cat "$PW_PLAYBOOK" 2>/dev/null) Improve one measure in this repo." < /dev/null'
//     Each attempt is one `promptwheel improve --json --target <measure>` (the loop step, the one keeper): kept or put back by the check. Both arms write the one
//     record, so the control arm's attempts are in the playbook the other arm reads. That is the design: the question
//     is whether SEEING the record changes what is kept, not whether the two arms have different pasts.
//
//   node bench/compounding-ab.mjs --self-test
//     Checks the harness itself with scripted attempts (no agent, no network).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptwheel.mjs');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
// the loop step's own words for what became of a try
const RESULTS = ['kept', 'flat', 'worse', 'gamed', 'unsure', 'nothing', 'rewrote', 'outside', 'contract', 'stopped', 'error'];
const empty = () => Object.fromEntries(RESULTS.map((r) => [r, 0]));

function attempt(repo, agentCmd, playbookPath, target) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [PW, 'improve', '--json', '--target', target, '--attempt', agentCmd], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, PW_PLAYBOOK: playbookPath }, timeout: 1_800_000, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) { out = `${e.stdout || ''}`; }   // a thrown-away attempt exits 1, 2 or 3 and still prints its report
  try { const r = JSON.parse(out).result; return RESULTS.includes(r) ? r : 'error'; } catch { return 'error'; }
}

function renderPlaybook(repo, dir) {
  const p = join(dir, 'playbook.md');
  try { writeFileSync(p, execFileSync(process.execPath, [PW, 'playbook'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { writeFileSync(p, ''); }   // no record yet: the first attempt of the playbook arm reads an empty file
  return p;
}

const total = (t) => RESULTS.reduce((s, r) => s + t[r], 0);
const rate = (t) => (total(t) ? t.kept / total(t) : 0);
function report(tally) {
  console.log('\nthe compounding test: attempts kept in each arm, judged by the check\n');
  for (const [arm, t] of Object.entries(tally)) console.log(`  ${arm.padEnd(9)} ${RESULTS.map((r) => `${r} ${t[r]}`).join(' · ')}  -> kept ${(rate(t) * 100).toFixed(0)}%`);
  const gap = rate(tally.playbook) - rate(tally.control);
  const n = total(tally.playbook) + total(tally.control);
  console.log(`\n  gap (playbook less control): ${(gap * 100).toFixed(0)} points over ${n} attempts`);
  console.log(n < 20 ? '  Under 20 attempts: a direction at best. The claim stays closed.'
    : gap > 0.15 ? '  The gap clears the coarse bar (15 points at 20 attempts or more). Run it on a second repo before any claim.'
      : '  No gap worth the name: the playbook did NOT show compounding here. That is a result too.');
  return gap;
}

if (args.includes('--self-test')) {
  // scripted attempts: the playbook arm makes a real improvement, the control arm does nothing
  const d = mkdtempSync(join(tmpdir(), 'pw-ab-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [
    { name: 'todos', cmd: 'grep -c TODO app.js || true', extract: 'number', direction: 'down', guard: true }] }));
  writeFileSync(join(d, 'app.js'), Array.from({ length: 8 }, (_, i) => `line${i} // TODO`).join('\n') + '\n');
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  const tally = { playbook: empty(), control: empty() };
  let sawPlaybook = false;
  const pbDir = mkdtempSync(join(tmpdir(), 'pw-ab-pb-'));
  for (let i = 0; i < 6; i++) {
    const arm = i % 2 === 0 ? 'playbook' : 'control';
    const pb = arm === 'playbook' ? renderPlaybook(d, pbDir) : '';
    // the scripted "agent" of the playbook arm acts only when it was handed a playbook file: the hand-over is tested too
    const cmd = arm === 'playbook' ? "test -n \"$PW_PLAYBOOK\" && node -e 'const fs=require(\"fs\");fs.writeFileSync(\"app.js\",fs.readFileSync(\"app.js\",\"utf8\").replace(\" // TODO\",\"\"))'" : 'test -z "$PW_PLAYBOOK"';
    if (pb) sawPlaybook = true;
    tally[arm][attempt(d, cmd, pb, 'todos')] += 1;
  }
  const gap = report(tally);
  rmSync(d, { recursive: true, force: true }); rmSync(pbDir, { recursive: true, force: true });
  if (sawPlaybook && tally.playbook.kept === 3 && tally.control.nothing === 3 && gap === 1) { console.log('\nself-test passed: the harness works\n'); process.exit(0); }
  console.error('\nself-test FAILED'); process.exit(1);
}

const repo = opt('--repo'); const agent = opt('--agent'); const target = opt('--target'); const attempts = parseInt(opt('--attempts', '10'), 10);
if (!repo || !agent || !target) { console.error('usage: compounding-ab.mjs --repo <dir> --target <measure> --attempts N --agent "<cmd>"   (or --self-test)'); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), 'pw-ab-'));
const tally = { playbook: empty(), control: empty() };
try {
  for (let i = 0; i < attempts; i++) {
    const arm = i % 2 === 0 ? 'playbook' : 'control';
    const pb = arm === 'playbook' ? renderPlaybook(repo, scratch) : '';
    const result = attempt(repo, agent, pb, target);
    tally[arm][result] += 1;
    console.error(`  attempt ${i + 1} of ${attempts} [${arm}] -> ${result}`);
  }
  report(tally);
} finally { rmSync(scratch, { recursive: true, force: true }); }
