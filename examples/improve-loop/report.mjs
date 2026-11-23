#!/usr/bin/env node
// The loop's report. Every try, kept or put back, read from the record. Nothing here is asked of a model.
//
//   node report.mjs [--json]
//
// It reads three things the loop left in this clone: the step's record (.git/improve/attempts.jsonl, one line a
// try), the change each try made (refs/improve/<n>), and the run's own account (.git/improve/runs.jsonl). It
// prints every try, and then checks that the three agree:
//
//   - the tries are numbered 1, 2, 3 with none missing and none twice
//   - every try that made a change can still be read, and no change is there without its line
//   - every kept change is still in the branch
//   - each run saw the same results, in the same order, as the record holds
//
// If they do not agree it says "whole: no", says why, and exits 1. A try that was put back cannot be dropped from
// this report by deleting its line: the numbering, its ref and the run's account all still name it.
// What this cannot see: a person who edits all three by hand.
// Exit codes: 0 whole · 1 not whole · 64 could not run.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const die = (message) => { console.error(`report: ${message}`); process.exit(64); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const holds = (...args) => { try { git(...args); return true; } catch { return false; } };
const flags = process.argv.slice(2); for (const f of flags) if (f !== '--json') die(`unknown flag ${f}`);
let gitDir; try { gitDir = git('rev-parse', '--absolute-git-dir'); } catch { die('not inside a git repository'); }
const dir = join(gitDir, 'improve'), wrong = [];
const read = (file, what) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { wrong.push(`${what}: line ${i + 1} cannot be read`); return null; } }).filter(Boolean) : []);
const tries = read(join(dir, 'attempts.jsonl'), 'the record'), runs = read(join(dir, 'runs.jsonl'), "the run's account");
if (!tries.length && !runs.length) die('there is no record here yet: no try has been made in this clone');

// ---------------------------------------------------------------- do the three accounts agree
tries.forEach((t, i) => { if (t.n !== i + 1) wrong.push(`the record's line ${i + 1} says it is try ${t.n}: a try is missing, or one is there twice`); });
const refs = Object.fromEntries(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/improve').split('\n').filter(Boolean).map((l) => l.split(' ')));
for (const t of tries) {
  if (t.candidate && refs[`refs/improve/${t.n}`] !== t.candidate) wrong.push(`try ${t.n}: the change it made can no longer be read (refs/improve/${t.n})`);
  if (t.result === 'kept' && !(t.commit && holds('merge-base', '--is-ancestor', t.commit, 'HEAD'))) wrong.push(`try ${t.n} was kept, and its commit is not in the branch now`);
}
for (const ref of Object.keys(refs)) if (!tries.some((t) => `refs/improve/${t.n}` === ref && t.candidate)) wrong.push(`${ref} holds a change, and the record has no line for it`);
const begun = runs.filter((r) => r.begin).map((b) => ({ ...b, done: runs.find((r) => r.end && r.run === b.run) || null }));
for (const b of begun) {
  if (!b.done) { wrong.push(`run ${b.run} began and has no end: it was killed, or it is still going`); continue; }
  const seen = tries.filter((t) => t.n >= b.from && t.n <= b.done.to).map((t) => t.result);
  if (JSON.stringify(seen) !== JSON.stringify(b.done.results)) wrong.push(`run ${b.run} saw ${b.done.results.length} tries (${b.done.results.join(', ') || 'none'}), and the record holds ${seen.length} for it (${seen.join(', ') || 'none'})`);
}
const inRun = (t) => begun.find((b) => t.n >= b.from && t.n <= (b.done ? b.done.to : Infinity));

// ---------------------------------------------------------------- what happened
const count = (list) => { const c = {}; for (const t of list) c[t.result] = (c[t.result] || 0) + 1; return c; };
const metric = (t, name) => (t.metrics || []).find((m) => m.name === name);
const sum = (list, target) => {
  const judged = list.filter((t) => metric(t, target)), kept = list.filter((t) => t.result === 'kept');
  return { tries: list.length, kept: kept.length, results: count(list), asks: list.reduce((n, t) => n + (t.asks || 0), 0),
    start: judged.length ? metric(judged[0], target).before : null, now: kept.length ? metric(kept[kept.length - 1], target).after : (judged.length ? metric(judged[0], target).before : null),
    touched: list.filter((t) => t.restored).map((t) => ({ n: t.n, what: t.restored })) };
};
const groups = [...begun.map((b) => ({ run: b, list: tries.filter((t) => inRun(t) === b) })), { run: null, list: tries.filter((t) => !inRun(t)) }].filter((g) => g.run || g.list.length);
const report = { whole: wrong.length === 0, wrong, runs: groups.map(({ run, list }) => ({
  ...(run ? { run: run.run, plan: run.planPath, planBlob: run.planBlob, arm: run.arm || null, base: run.base, began: run.at, ended: run.done ? run.done.ended : null, planned: run.plan.tries, mayChange: run.plan.mayChange, wall: run.plan.wall !== false,
    ...(run.heldOut !== undefined || (run.done && run.done.heldOut !== undefined) ? { heldOut: { start: run.heldOut ?? null, end: run.done ? run.done.heldOut ?? (runs.find((r) => r.run === run.run && r.heldOutLate !== undefined) || {}).heldOutLate ?? null : null } } : {}) } : { run: null }),
  target: run ? run.plan.target : 'score', ...sum(list, run ? run.plan.target : 'score'),
  list: list.map((t) => ({ n: t.n, result: t.result, why: t.why, label: t.label, ...(t.candidate ? { change: `refs/improve/${t.n}` } : {}), ...(t.commit ? { commit: t.commit } : {}) })),
})) };
// It prints, sets its exit code and ends by itself, so everything printed is written first. It used to end with
// process.exit(). Piped, a report longer than a pipe holds (64 KB) then arrived cut, without its last line, the one
// that says whether the record is whole. The exit code was right. PromptWheel's gate had the same fault until 0.8.16.
if (flags.includes('--json')) console.log(JSON.stringify(report, null, 1)); else words();
process.exitCode = report.whole ? 0 : 1;

function words() {
  const ENDED = { tries: 'every try in the plan was used', flat: 'stopped early: too many tries in a row kept nothing', 'no room': 'stopped early: no room was left for a gain that could be kept', stopped: 'stopped by a person', 'could not run': 'a try could not run', lost: 'the run was killed. Its results are read from the record' };
  for (const r of report.runs) {
    console.log(r.run ? `run ${r.run}: plan ${r.plan} (${r.planBlob.slice(0, 12)})${r.arm ? `, arm ${r.arm}` : ''}, began ${r.began.slice(0, 16).replace('T', ' ')} at ${r.base.slice(0, 12)}` : 'tries made outside a run (the step was called by hand):');
    if (r.run) console.log(`  ${r.tries} of ${r.planned} tries. Ended: ${ENDED[r.ended] || 'not ended'}. May change: ${r.mayChange.join(', ')}. Wall: ${r.wall ? 'on' : 'off'}.`);
    console.log(`  kept ${r.kept} of ${r.tries}${r.tries ? ` (${Math.round((100 * r.kept) / r.tries)}%)` : ''}${Object.entries(r.results).filter(([k]) => k !== 'kept').map(([k, v]) => ` · ${k} ${v}`).join('')}`);
    if (r.start != null) console.log(`  ${r.target}: ${r.start} at the start, ${r.now} now`);
    if (r.heldOut) console.log(`  held-out: ${r.heldOut.start ?? 'could not be read'} at the start, ${r.heldOut.end ?? (['tries', 'flat', 'no room'].includes(r.ended) ? 'could not be read' : 'not measured, the run did not finish')} at the end`);
    console.log(`  the gate was asked ${r.asks} ${r.asks === 1 ? 'time' : 'times'}`);
    for (const t of r.touched) console.log(`  try ${t.n} touched the loop's own files, which were put back: ${t.what.join(', ')}`);
    for (const t of r.list) console.log(`  ${String(t.n).padStart(3)}  ${t.result.padEnd(8)} ${t.why}`);
    console.log();
  }
  console.log(report.whole ? 'whole: yes. The record, the kept changes and each run\'s own account agree, and every try is listed above.' : `whole: no.\n${wrong.map((x) => `  - ${x}`).join('\n')}`);
}
