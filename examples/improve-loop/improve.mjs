#!/usr/bin/env node
// One step of an improve loop: run an attempt, ask the gate, keep the change or put it back.
//
// The engine had this as `promptwheel improve --attempt` from 0.0.2. Version 0.8.0 removed it as a command nothing
// relied on. On 2026-11-21 the owner asked for it back. It lives here, outside the engine and outside the npm
// package: the engine stays the check, and this is one loop built on the check. It shells `promptwheel run --json`
// and reads the report. test/improve-loop.test.mjs holds it to what this header says.
//
//   node improve.mjs --attempt "<command that changes the repo>" [--label <name>] [--target score]
//                    [--cheaper cost] [--floor] [--repeat N] [--base-cache <dir>] [--json]
//
// A change is kept only when the gate passes AND the target metric improved. With --cheaper <metric>, a change is
// also kept when the target held (or moved inside its noise band) and that metric fell. A pass with nothing
// improved is not kept: the gate passes a change that does nothing.
//
// --floor holds every kept change against the best target value so far, not only against its parent. Without it,
// small drops that each sit inside the noise band add up: each step passes, and the score walks downhill. The gate
// compares two commits and keeps no history, so the floor lives here, in .git/improve/best.json.
//
// --base-cache <dir> is handed to the gate, so the base is measured once. The folder must sit outside the repo.
//
// Every attempt, kept or not, is one line in .git/improve/attempts.jsonl, and the change itself stays reachable as
// refs/improve/<n>. The attempt command gets the path of that record in IMPROVE_RECORD (and the target's name in
// IMPROVE_TARGET), so a proposer can read what was already tried. The record is the loop's: if an attempt edits it
// or the floor file, both are put back as they were. An attempt that commits its own work is judged all the same.
//
// This is not a sandbox. The attempt runs as you, with your shell. Stop it with Ctrl-C and the attempt is put back.
//
// stdout is one line (or with --json, the record line). What the attempt prints goes to stderr.
// Exit codes, so `while node improve.mjs --attempt ...; do :; done` stops by itself:
//   0 kept · 1 put back, a guard got worse or the floor held · 2 put back, gamed ·
//   3 put back, nothing improved or nothing could be measured · 64 could not run.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const die = (message) => { console.error(`improve: ${message}`); process.exit(64); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const holds = (...args) => { try { git(...args); return true; } catch { return false; } };

// A flag this does not know is an error, not a flag to drop: a mistyped --floor would turn the floor off.
const VALUED = ['--attempt', '--label', '--target', '--cheaper', '--repeat', '--base-cache'], BARE = ['--floor', '--json'];
const args = {};
for (let i = 0, argv = process.argv.slice(2); i < argv.length; i++) {
  if (BARE.includes(argv[i])) args[argv[i]] = true;
  else if (!VALUED.includes(argv[i])) die(`unknown flag ${argv[i]}`);
  else if (argv[i + 1] === undefined) die(`${argv[i]} needs a value`);
  else { args[argv[i]] = argv[i + 1]; i++; }
}
const attempt = args['--attempt'];
if (!attempt) die('--attempt "<command that changes the repo>" is required');
const label = args['--label'] ?? attempt, target = args['--target'] ?? 'score', cheaper = args['--cheaper'], floor = args['--floor'] === true;
const gateCommand = process.env.PROMPTWHEEL ? process.env.PROMPTWHEEL.split(' ') : [process.execPath, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'promptwheel.mjs')];

let root; try { root = git('rev-parse', '--show-toplevel'); } catch { die('not inside a git repository'); }
process.chdir(root);
let base; try { base = git('rev-parse', '--verify', 'HEAD'); } catch { die('this repository has no commit yet: the loop needs one to put a change back to'); }
if (git('status', '--porcelain')) die('the working tree is not clean: commit or stash first, so there is something to put back to');
const branch = () => { try { return git('symbolic-ref', '-q', 'HEAD'); } catch { return null; } };   // null on a detached HEAD
const on = branch();

// What the loop knows is read before the attempt runs and written back after it if the attempt touched it. The
// attempt is handed the record to read, and a floor the attempt can lower is no floor.
const recordDir = join(git('rev-parse', '--absolute-git-dir'), 'improve');
const record = join(recordDir, 'attempts.jsonl'), bestFile = join(recordDir, 'best.json');
const slurp = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const known = { [record]: slurp(record), [bestFile]: slurp(bestFile) };
const n = (known[record] || '').split('\n').filter(Boolean).length + 1;
let best = null;   // the best commit so far and what it scored; nothing until a change is kept under --floor
if (floor && known[bestFile] != null) {
  try { best = JSON.parse(known[bestFile]); } catch { /* said below */ }
  if (!best || typeof best.commit !== 'string' || typeof best.score !== 'number') die(`the floor file cannot be read (${bestFile}). Delete it to start the floor again from this commit`);
  if (!holds('cat-file', '-e', `${best.commit}^{commit}`)) die(`the best commit ${best.commit.slice(0, 12)} is gone from this clone. Delete ${bestFile} to start the floor again from this commit`);
}

// Ctrl-C reaches this step and the attempt together. Stay alive through it, so a half-made change is put back.
process.on('SIGINT', () => {});
const tried = spawnSync(attempt, { shell: true, stdio: ['inherit', 2, 2], env: { ...process.env, IMPROVE_RECORD: record, IMPROVE_TARGET: target } });

let recordPutBack = false;
mkdirSync(recordDir, { recursive: true });
for (const [file, text] of Object.entries(known)) if (slurp(file) !== text) { recordPutBack = true; if (text == null) rmSync(file, { force: true }); else writeFileSync(file, text); }

const putBack = () => { git('reset', '-q', '--hard', base); git('clean', '-qfd'); };
const note = (result, why, extra = {}) => {
  const line = { n, at: new Date().toISOString(), label, base, result, why, ...extra, ...(recordPutBack ? { recordPutBack: true } : {}) };
  appendFileSync(record, JSON.stringify(line) + '\n');
  return line;
};
const finish = (result, why, exit, extra) => {
  const line = note(result, why, extra);
  console.log(args['--json'] ? JSON.stringify(line) : `${String(n).padStart(2)}  ${result.padEnd(8)} ${label}: ${why}`);
  process.exit(exit);
};

try {
  // Where the attempt left the branch. A proposer that commits by itself must not skip the gate, and one that
  // throws commits away must not take a kept change with it.
  if (branch() !== on) {
    const why = `the attempt left the repo on another branch or commit (it started on ${on || 'a detached HEAD'} at ${base.slice(0, 12)}). Nothing was judged or kept: put it back by hand`;
    note('rewrote', why); die(why);
  }
  if (tried.signal) { putBack(); const why = `the attempt was stopped (${tried.signal}), so it is put back`; note('stopped', why); die(why); }
  const now = git('rev-parse', 'HEAD');
  if (now !== base && holds('merge-base', '--is-ancestor', base, now)) git('reset', '-q', base);   // its commits become a working change, judged like any other
  else if (now !== base) {
    git('update-ref', `refs/improve/${n}`, now); putBack();
    const why = `the attempt moved the branch off the commit it started on. It is put back, and where the attempt left it is under refs/improve/${n}`;
    note('rewrote', why, { candidate: now }); die(why);
  }
  if (!git('status', '--porcelain')) finish('nothing', 'the attempt changed no file', 3);

  // Keep the attempt reachable whatever happens to it: a commit that no branch points at.
  git('add', '-A');
  const files = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const candidate = git('commit-tree', git('write-tree'), '-p', base, '-m', `attempt ${n}: ${label}`);
  git('update-ref', `refs/improve/${n}`, candidate);
  git('reset', '-q');

  const ask = (...refs) => {
    const run = spawnSync(gateCommand[0], [...gateCommand.slice(1), 'run', ...refs, '--json', ...(args['--repeat'] ? ['--repeat', args['--repeat']] : []), ...(args['--base-cache'] ? ['--base-cache', args['--base-cache']] : [])], { encoding: 'utf8' });
    try { return JSON.parse(run.stdout); } catch { throw new Error(`could not read the gate's report (exit ${run.status}): ${(run.stderr || '').trim().slice(0, 300)}`); }
  };
  const report = ask('--working');
  const metric = (name, r = report) => r.metrics.find((m) => m.name === name);
  const t = metric(target), c = cheaper ? metric(cheaper) : null;
  for (const [name, found] of [[target, t], [cheaper, cheaper ? c : true]]) if (!found) throw new Error(`the gate has no metric named "${name}"`);
  const metrics = report.metrics.map(({ name, before, after, status, ok, gamed, paid, overBudget }) => ({ name, before, after, status, ok, ...(gamed ? { gamed } : {}), ...(paid ? { paid } : {}), ...(overBudget ? { overBudget } : {}) }));
  const seen = { candidate, files, verdict: report.verdict, metrics };
  const moved = (m) => (m.after == null ? `${m.name} could not be read${m.before == null ? '' : ' after the change'}` : `${m.name} ${m.before} to ${m.after}`);

  // The verdict word is `fail` when a gamed win sits beside a guard that got worse, so read the marks too.
  const gamed = report.metrics.filter((m) => m.gamed === true);
  if (report.verdict === 'gamed' || gamed.length) { putBack(); finish('gamed', `${gamed.map((m) => m.name).join(', ') || 'a metric'} moved by changing what it is measured with`, 2, seen); }
  if (report.verdict === 'fail') { putBack(); finish('worse', report.metrics.filter((m) => m.guard && !m.ok).map(moved).join(', ') || 'a protected path or the gate itself changed', 1, seen); }
  if (report.verdict !== 'pass') { putBack(); finish('unsure', 'the gate could not measure it', 3, seen); }

  const held = t.status === 'unchanged' || t.status === 'inconclusive';   // the same, or a move inside the noise band
  const why = t.status === 'improved' ? moved(t) + (c && c.paid ? `, ${moved(c)} paid for` : '')
    : (c && held && c.status === 'improved') ? `${target} ${t.status === 'unchanged' ? `held at ${t.after}` : `${t.before} to ${t.after}, inside its band`}, ${moved(c)}` : null;
  if (!why) { putBack(); finish('flat', `${target} did not improve (${t.status})`, 3, seen); }

  // The floor: the change also has to hold against the best commit so far. A second ask of the gate, with that
  // commit as the base. The parent is the best until something is kept that scores under it.
  const better = (a, b) => (t.direction === 'down' ? a < b : a > b);
  const top = best || { commit: base, score: t.before };
  if (floor && top.commit !== base) {
    const b = metric(target, ask('--base', top.commit, '--head', candidate));
    if (!b || b.after == null) { putBack(); finish('unsure', `the gate could not measure ${target} against its best`, 3, seen); }
    if (b.status === 'regressed') { putBack(); finish('worse', `${target} was ${b.before} at its best and is ${b.after} now: under the floor`, 1, { ...seen, floor: { best: top.commit, before: b.before, after: b.after } }); }
  }

  git('add', '-A');
  git('commit', '-q', '-m', `improve: ${label}\n\n${why}`);
  const commit = git('rev-parse', 'HEAD');
  if (floor) writeFileSync(bestFile, JSON.stringify(better(t.after, top.score) ? { commit, score: t.after } : top) + '\n');
  finish('kept', why, 0, { ...seen, commit });
} catch (e) {
  // anything this did not plan for: put the attempt back and say so, with the code for "could not run"
  try { putBack(); } catch { /* the message below is what matters */ }
  die(String(e.message || e).split('\n').filter((l) => l.trim()).slice(0, 3).join(' '));
}
