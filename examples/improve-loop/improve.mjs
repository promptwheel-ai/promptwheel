#!/usr/bin/env node
// One step of an improve loop: run an attempt, ask the gate, keep the change or put it back.
//
// The engine had this as `promptwheel improve --attempt` from 0.0.2. Version 0.8.0 removed it as a command nothing
// relied on. On 2026-11-21 the owner asked for it back. It lives here, outside the engine and outside the npm
// package: the engine stays the check, and this is one loop built on the check. It shells `promptwheel run --json`
// and reads the report. test/improve-loop.test.mjs holds it to what this header says.
//
//   node improve.mjs --attempt "<command that changes the repo>" [--label <name>] [--target score]
//                    [--cheaper cost] [--floor] [--repeat N] [--base-cache <dir>] [--may-change <patterns>] [--json]
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
// --may-change "src/**, prompts/*.md" names the paths an attempt may touch. A try that changes, adds, deletes or
// moves anything else is put back whole, and the gate is not asked. The patterns read as the gate reads its own:
// a bare name matches at any depth, a pattern with a slash starts at the top of the repo, * stops at a slash and
// ** crosses it. The names come from the commit that would be judged, so nothing gets round the list.
// (From treegate's step, the other session's copy of this file, 2026-11-21: one step again.)
//
// Every attempt, kept or not, is one line in .git/improve/attempts.jsonl, and the change itself stays reachable as
// refs/improve/<n>. The attempt command gets the path of that record in IMPROVE_RECORD (and the target's name in
// IMPROVE_TARGET), so a proposer can read what was already tried.
//
// What is judged is what is kept. The attempt's change is made into one commit, the gate judges that commit, and
// that same tree is what goes on the branch. No git hook runs, and a file edited after the gate looked is not in it.
// An attempt that commits its own work is judged all the same.
//
// The loop's own files are read before the attempt and put back after it: the record, the floor, the refs of
// earlier tries, the base cache, the gate program (when PROMPTWHEEL names its file) and this step. The record line
// says which the attempt had touched. A file the attempt hides from git is shown again, so it is judged too.
//
// Git's own files are held the same way, because the step and the gate both run git: the repo's config, hooks and
// info folder, your global git config, and every ref but the branch the step is on. A hook, a filter, a replace
// ref or an fsmonitor command that an attempt sets is gone before the change is judged. After the attempt, the
// step's git calls and the gate's run no hook at all, whatever folder the hooks are in.
//
// This is not a sandbox. The attempt runs as you, with your shell. Stop it with Ctrl-C and the attempt is put back.
// What git does not track is out of sight: an installed dependency the scorer runs, a database, a process the
// attempt leaves running. To hold those, run the attempt where it cannot write them.
//
// stdout is one line (or with --json, the record line). What the attempt prints goes to stderr.
// Exit codes, so `while node improve.mjs --attempt ...; do :; done` stops by itself:
//   0 kept · 1 put back, a guard got worse, the floor held, or it changed what it may not · 2 put back, gamed ·
//   3 put back, nothing improved or nothing could be measured · 64 could not run.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const die = (message) => { console.error(`improve: ${message}`); process.exit(64); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const holds = (...args) => { try { git(...args); return true; } catch { return false; } };

// A flag this does not know is an error, not a flag to drop: a mistyped --floor would turn the floor off.
const VALUED = ['--attempt', '--label', '--target', '--cheaper', '--repeat', '--base-cache', '--may-change'], BARE = ['--floor', '--json'];
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
// The same pattern rules as the gate's evaluatorPaths and mandates, so one pattern means one thing in both places.
const globToRe = (glob) => {
  const anchored = glob.startsWith('/'), g = anchored ? glob.slice(1) : glob;
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  return new RegExp(`${anchored || glob.includes('/') ? '^' : '(^|/)'}${body}$`);
};
const may = args['--may-change'] === undefined ? null : args['--may-change'].split(',').map((s) => s.trim()).filter(Boolean).map(globToRe);
if (may && !may.length) die('--may-change needs at least one path pattern: an empty list is not a list');
const gateCommand = process.env.PROMPTWHEEL ? process.env.PROMPTWHEEL.split(' ') : [process.execPath, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'promptwheel.mjs')];

let root; try { root = git('rev-parse', '--show-toplevel'); } catch { die('not inside a git repository'); }
process.chdir(root);
let base; try { base = git('rev-parse', '--verify', 'HEAD'); } catch { die('this repository has no commit yet: the loop needs one to put a change back to'); }
if (git('status', '--porcelain')) die('the working tree is not clean: commit or stash first, so there is something to put back to');
// A file can be hidden from git (skip-worktree, assume-unchanged). git status then calls the tree clean when it is not.
const hidden = () => git('ls-files', '-v', '-z').split('\0').filter((l) => l && !l.startsWith('H ')).map((l) => l.slice(2));
const hiddenAtStart = hidden();
const edited = hiddenAtStart.filter((f) => existsSync(f) && git('hash-object', '--', f) !== git('rev-parse', `:${f}`));
if (edited.length) die(`the working tree is not clean: these files are edited and hidden from git: ${edited.join(', ')}. Show them again first: git update-index --no-skip-worktree <file> (or --no-assume-unchanged)`);
const branch = () => { try { return git('symbolic-ref', '-q', 'HEAD'); } catch { return null; } };   // null on a detached HEAD
const on = branch();

// What the loop knows, and what it judges with, is read before the attempt runs and written back after it if the
// attempt touched it. The attempt is handed the record to read, a floor the attempt can lower is no floor, and a
// gate, a step or a kept base number the attempt can rewrite judges nothing.
const recordDir = join(git('rev-parse', '--absolute-git-dir'), 'improve');
const record = join(recordDir, 'attempts.jsonl'), bestFile = join(recordDir, 'best.json');
const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
const bytes = (file) => (isFile(file) ? readFileSync(file) : null);
const gateFile = gateCommand.slice(1).filter((a) => /\.[cm]?js$/.test(a)).map((a) => resolve(a)).find(isFile);
const cacheDir = args['--base-cache'] ? resolve(args['--base-cache']) : null;
const cached = () => (cacheDir && existsSync(cacheDir) ? readdirSync(cacheDir).map((f) => join(cacheDir, f)).filter(isFile) : []);
// Git's own files. An attempt can write them, git does not track them, and they change what git does for the step
// and for the gate: a hook runs, a filter rewrites a file on its way in or out, a replace ref swaps one object for
// another. The config files are the ones git names for this repo, and the places it would look for a global one.
const common = resolve(git('rev-parse', '--git-common-dir')), home = process.env.HOME || homedir(), xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
const named = (key) => { try { return git('config', '--path', '--get', key); } catch { return null; } };
const settings = [...new Set([
  join(common, 'config'), join(git('rev-parse', '--absolute-git-dir'), 'config.worktree'), process.env.GIT_CONFIG_GLOBAL || join(home, '.gitconfig'),
  join(xdg, 'git', 'config'), join(xdg, 'git', 'attributes'), join(xdg, 'git', 'ignore'), named('core.attributesFile'), named('core.excludesFile'),
  ...execFileSync('git', ['config', '--list', '--show-origin', '-z'], { encoding: 'utf8' }).split('\0').filter((x) => x.startsWith('file:')).map((x) => x.slice(5)),
].filter(Boolean).map((f) => resolve(f)))].filter((f) => !existsSync(f) || isFile(f));   // a plain file, or nothing there yet. Never /dev/null or a folder.
const gitDirs = [[join(common, 'hooks'), 'git hooks'], [join(common, 'info'), 'git settings']];
const inGitDirs = () => gitDirs.flatMap(([dir, what]) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((f) => [join(dir, f), what]).filter(([f]) => isFile(f)) : []));
const linkOf = (file) => { try { return readlinkSync(file); } catch { return null; } };   // where a link points, or null for a plain file
const own = [[record, 'record'], [bestFile, 'floor'], [fileURLToPath(import.meta.url), 'step'], ...(gateFile ? [[gateFile, 'gate']] : []), ...cached().map((f) => [f, 'base cache']),
  ...settings.map((f) => [f, f.startsWith(`${common}/`) ? 'git settings' : `your git settings (${f})`]), ...inGitDirs()]
  .map(([file, what]) => ({ file, what, was: bytes(file), mode: isFile(file) ? statSync(file).mode : null, link: linkOf(file) }));
const text = (what) => { const { was } = own.find((x) => x.what === what); return was == null ? null : was.toString('utf8'); };
const refs = () => Object.fromEntries(git('for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([ref]) => ref !== on));   // every ref but the branch this is on
const refsAtStart = refs();
const n = (text('record') || '').split('\n').filter(Boolean).length + 1;
let best = null;   // the best commit so far and what it scored; nothing until a change is kept under --floor
if (floor && text('floor') != null) {
  try { best = JSON.parse(text('floor')); } catch { /* said below */ }
  if (!best || typeof best.commit !== 'string' || typeof best.score !== 'number') die(`the floor file cannot be read (${bestFile}). Delete it to start the floor again from this commit`);
  if (!holds('cat-file', '-e', `${best.commit}^{commit}`)) die(`the best commit ${best.commit.slice(0, 12)} is gone from this clone. Delete ${bestFile} to start the floor again from this commit`);
}

// Ctrl-C reaches this step and the attempt together. Stay alive through it, so a half-made change is put back.
process.on('SIGINT', () => {});
const tried = spawnSync(attempt, { shell: true, stdio: ['inherit', 2, 2], env: { ...process.env, IMPROVE_RECORD: record, IMPROVE_TARGET: target } });

// From here on, no git call of this step or of the gate runs a hook or an fsmonitor command, whatever the repo's
// config says and whatever folder the hooks are in. A repo that keeps its hooks in a tracked folder has them edited
// like any other file. These settings outrank every config file.
const k = Number(process.env.GIT_CONFIG_COUNT) || 0;
Object.assign(process.env, { GIT_CONFIG_COUNT: String(k + 2), [`GIT_CONFIG_KEY_${k}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${k}`]: '/dev/null', [`GIT_CONFIG_KEY_${k + 1}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${k + 1}`]: 'false' });

const restored = new Set(), refsLost = [];   // which of the loop's own files the attempt touched, and what could not be put back
let asks = 0;   // how often the gate was asked in this try: what the try cost
const putBack = () => { git('reset', '-q', '--hard', base); git('clean', '-qfd'); };
const note = (result, why, extra = {}) => {
  const line = { n, at: new Date().toISOString(), label, base, result, why, ...extra, ...(asks ? { asks } : {}), ...(restored.size ? { recordPutBack: true, restored: [...restored] } : {}), ...(refsLost.length ? { refsLost } : {}) };
  appendFileSync(record, JSON.stringify(line) + '\n');
  return line;
};
const finish = (result, why, exit, extra) => {
  const line = note(result, why, extra);
  const touched = restored.size ? ` (the attempt touched the loop's own files, which were put back: ${[...restored].join(', ')})` : '';
  console.log(args['--json'] ? JSON.stringify(line) : `${String(n).padStart(2)}  ${result.padEnd(8)} ${label}: ${why}${touched}`);
  process.exit(exit);
};

try {
  // The loop's own files, as they were. Anything the attempt added to the base cache goes too: a number planted
  // there before the base is first measured would be read as the base.
  for (const { file, what, was, mode, link } of own) {
    const now = bytes(file);
    if (now == null ? was == null && !existsSync(file) : was != null && now.equals(was)) continue;
    restored.add(what);
    // a file that was a link to a file elsewhere (a dotfiles folder) stays that link, and is written through it
    if (link == null || linkOf(file) !== link) { rmSync(file, { recursive: true, force: true }); if (link != null) symlinkSync(link, file); }
    if (was != null) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, was); chmodSync(file, mode); }
  }
  for (const file of cached()) if (!own.some((x) => x.file === file)) { restored.add('base cache'); rmSync(file, { force: true }); }
  for (const [file, what] of inGitDirs()) if (!own.some((x) => x.file === file)) { restored.add(what); rmSync(file, { force: true }); }   // a hook or an attributes file the attempt made
  mkdirSync(recordDir, { recursive: true });
  // Every ref goes back to where it was, and a ref the attempt made is removed: a tag, a branch, a replace ref.
  // The branch this is on is the one thing an attempt may move, and it is dealt with just below.
  const refsNow = refs(), here = branch();   // a branch the attempt made and left the repo on is not removed: it is refused below, and yours to look at
  for (const [ref, sha] of Object.entries(refsAtStart)) {
    if (refsNow[ref] === sha) continue;
    if (holds('cat-file', '-e', sha)) { git('update-ref', ref, sha); restored.add('refs'); } else refsLost.push(ref);
  }
  for (const ref of Object.keys(refsNow)) if (!(ref in refsAtStart) && ref !== here) { git('update-ref', '-d', ref); restored.add('refs'); }
  // a file the attempt hid from git is shown again, so its change is judged and put back like any other
  const hid = hidden().filter((f) => !hiddenAtStart.includes(f));
  for (const show of hid.length ? ['--no-skip-worktree', '--no-assume-unchanged'] : []) git('update-index', show, '--', ...hid);   // one flag a call: git clears only one when both are given

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

  // Keep the attempt reachable whatever happens to it: a commit that no branch points at. This commit is what the
  // gate judges. Its message is one line, so nothing in a label can read as a reason written in a commit.
  git('add', '-A');
  const files = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const tree = git('write-tree');
  const candidate = git('commit-tree', tree, '-p', base, '-m', `attempt ${n}: ${label.replace(/\s+/g, ' ')}`);
  git('update-ref', `refs/improve/${n}`, candidate);
  git('reset', '-q');

  // What may change. The names are read from the commit the gate would judge, a move counts at both ends, and a
  // try that touched anything else is put back whole: half of a change is not a change anyone made.
  if (may) {
    const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, candidate], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const outside = changed.filter((f) => !may.some((re) => re.test(f)));
    if (outside.length) { putBack(); finish('outside', `it changed what it may not: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` and ${outside.length - 3} more` : ''}`, 1, { candidate, files, outside }); }
  }

  const ask = (...refs) => {
    asks++;
    const run = spawnSync(gateCommand[0], [...gateCommand.slice(1), 'run', ...refs, '--json', ...(args['--repeat'] ? ['--repeat', args['--repeat']] : []), ...(args['--base-cache'] ? ['--base-cache', args['--base-cache']] : [])], { encoding: 'utf8' });
    try { return JSON.parse(run.stdout); } catch { throw new Error(`could not read the gate's report (exit ${run.status}): ${(run.stderr || '').trim().slice(0, 300)}`); }
  };
  const report = ask('--base', base, '--head', candidate);
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

  // What is kept is the tree the gate judged, as a commit made here: no hook runs, and the working tree is not read
  // again. A file edited since the gate looked is not in it, and goes with the reset.
  const commit = git('commit-tree', tree, '-p', base, '-m', `improve: ${label}\n\n${why}`);
  git('reset', '-q', '--hard', commit); git('clean', '-qfd');
  if (floor) writeFileSync(bestFile, JSON.stringify(better(t.after, top.score) ? { commit, score: t.after } : top) + '\n');
  finish('kept', why, 0, { ...seen, commit });
} catch (e) {
  // anything this did not plan for: put the attempt back and say so, with the code for "could not run"
  try { putBack(); } catch { /* the message below is what matters */ }
  die(String(e.message || e).split('\n').filter((l) => l.trim()).slice(0, 3).join(' '));
}
