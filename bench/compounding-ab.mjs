#!/usr/bin/env node
// Compounding A/B — the acceptance test for the Phase-5 playbook (docs/LEARNING.md).
// Claim gate: NO public "the loop learns" claim until the playbook arm beats the control
// arm here, on real usage data, judged by the gate itself.
//
//   node bench/compounding-ab.mjs --repo <dir> --attempts 20 --agent '<cmd>'
//     Alternates arms. The playbook arm gets PW_PLAYBOOK=<path to a fresh playbook render>;
//     the control arm gets PW_PLAYBOOK="". Your agent cmd decides how to use it, e.g.:
//       --agent 'claude -p "$(cat "$PW_PLAYBOOK" 2>/dev/null) improve a metric"'
//     Each attempt runs `promptwheel improve --json` — kept/reverted by the gate.
//
//   node bench/compounding-ab.mjs --self-test
//     Verifies the harness mechanics with scripted attempts (no agent, no network).
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptwheel.mjs');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

function attempt(repo, agentCmd, playbookPath) {
  let out = '';
  try {
    out = execFileSync('node', [PW, 'improve', '--json', '--attempt', agentCmd], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, PW_PLAYBOOK: playbookPath }, timeout: 600_000,
    });
  } catch (e) { out = `${e.stdout || ''}`; }
  try { return JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)).result || 'error'; }
  catch { return 'error'; }
}

function renderPlaybook(repo, dir) {
  const p = join(dir, 'playbook.md');
  try { writeFileSync(p, execFileSync('node', [PW, 'playbook'], { cwd: repo, encoding: 'utf8' })); }
  catch { writeFileSync(p, ''); }
  return p;
}

function report(tally) {
  const rate = (t) => (t.kept + t.plateau + t.regression + t.gamed + t.error) ? t.kept / (t.kept + t.plateau + t.regression + t.gamed + t.error) : 0;
  const a = tally.playbook, b = tally.control;
  console.log('\ncompounding A/B — kept-rate per arm (judged by the gate, which the agent cannot game)\n');
  for (const [arm, t] of Object.entries(tally)) {
    console.log(`  ${arm.padEnd(9)} kept ${t.kept} · plateau ${t.plateau} · regression ${t.regression} · gamed ${t.gamed} · error ${t.error}  → kept-rate ${(rate(t) * 100).toFixed(0)}%`);
  }
  const gap = rate(a) - rate(b);
  const n = Object.values(tally).reduce((s, t) => s + t.kept + t.plateau + t.regression + t.gamed + t.error, 0);
  console.log(`\n  gap (playbook − control): ${(gap * 100).toFixed(0)} points over ${n} attempts`);
  console.log(n < 20
    ? '  ⚠ under 20 attempts — directional at best; the claim gate stays CLOSED.'
    : gap > 0.15 ? '  gap clears the coarse bar (≥15 points at n≥20) — rerun on a second repo before claiming anything.'
      : '  no meaningful gap — the playbook did NOT prove compounding here. That result is publishable too.');
  return gap;
}

if (args.includes('--self-test')) {
  // scripted attempts: playbook arm makes a real improvement, control arm no-ops.
  const d = mkdtempSync(join(tmpdir(), 'pw-ab-'));
  const g = (a) => execFileSync('git', a, { cwd: d });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  writeFileSync(join(d, '.gitignore'), '.promptwheel/\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [
    { name: 'todos', cmd: 'grep -c TODO app.js || true', extract: 'number', direction: 'down', guard: true }] }));
  writeFileSync(join(d, 'app.js'), Array.from({ length: 8 }, (_, i) => `line${i} // TODO`).join('\n') + '\n');
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  const tally = { playbook: { kept: 0, plateau: 0, regression: 0, gamed: 0, error: 0 }, control: { kept: 0, plateau: 0, regression: 0, gamed: 0, error: 0 } };
  for (let i = 0; i < 6; i++) {
    const arm = i % 2 === 0 ? 'playbook' : 'control';
    const cmd = arm === 'playbook' ? "sed -i '0,/ \\/\\/ TODO/s///' app.js" : 'true';
    tally[arm][attempt(d, cmd, '')] += 1;
  }
  const gap = report(tally);
  rmSync(d, { recursive: true, force: true });
  if (tally.playbook.kept === 3 && tally.control.plateau === 3 && gap === 1) { console.log('\nself-test PASS — harness mechanics verified\n'); process.exit(0); }
  console.error('\nself-test FAIL'); process.exit(1);
}

const repo = opt('--repo'); const agent = opt('--agent'); const attempts = parseInt(opt('--attempts', '10'), 10);
if (!repo || !agent) { console.error('usage: compounding-ab.mjs --repo <dir> --attempts N --agent "<cmd>"   (or --self-test)'); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), 'pw-ab-'));
const tally = { playbook: { kept: 0, plateau: 0, regression: 0, gamed: 0, error: 0 }, control: { kept: 0, plateau: 0, regression: 0, gamed: 0, error: 0 } };
try {
  for (let i = 0; i < attempts; i++) {
    const arm = i % 2 === 0 ? 'playbook' : 'control';
    const pb = arm === 'playbook' ? renderPlaybook(repo, scratch) : '';
    const result = attempt(repo, agent, pb);
    tally[arm][result in tally[arm] ? result : 'error'] += 1;
    console.error(`  attempt ${i + 1}/${attempts} [${arm}] → ${result}`);
  }
  report(tally);
} finally { rmSync(scratch, { recursive: true, force: true }); }
