#!/usr/bin/env node
// The loop's one keeper: run an attempt, ask the gate, keep the change or put it back.
//
// The engine had this as `promptwheel improve --attempt` from 0.0.2. Version 0.8.0 removed it as a command nothing
// relied on. On 2026-11-21 the owner asked for it back, and the same day, with three copies of it about (this file,
// the copy in treegate, and a command inside the engine), he chose one keeper. This is it. It lives outside the
// engine and asks the engine as a separate process: the engine stays the check, and this is the loop built on the
// check. It shells `promptwheel run --json` and reads the report. `promptwheel improve` runs this file, so it ships
// with the package. test/improve-loop.test.mjs holds it to what this header says.
//
//   node improve.mjs --attempt "<command that changes the repo>" [--label <name>] [--target score]
//                    [--cheaper cost] [--floor] [--repeat N] [--base-cache <dir>] [--may-change <patterns>]
//                    [--turns N] [--patience P] [--json]
//
// A change is kept only when the gate passes AND the target metric improved. With --cheaper <metric>, a change is
// also kept when the target held (or moved inside its noise band) and that metric fell. A pass with nothing
// improved is not kept: the gate passes a change that does nothing.
//
// --target is score unless named. `promptwheel improve` names it when the contract leaves no choice: its only
// measure, or its only one that is not a tripwire (gamingCheck false). A contract that leaves a choice, or cannot be
// read, is refused there before the attempt runs.
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
// The contract is the person's. A change the gate would keep is put back when it touched promptwheel.config.json,
// a file inside the repo that it extends, or a file its evaluatorPaths name, as they stand at the commit the step
// starts on (result `contract`, exit 1). A change the gate already sends back keeps the gate's result.
//
// --turns N judges over a number of turns. One attempt judged alone is put back unless it improved by itself, so a
// change that needs a level step first could never be kept. With --turns each turn goes on from where the last one
// left the tree, the WHOLE change so far is judged against the commit the run started from (so a test edited at one
// turn makes no win at a later one), the reading is handed to the next turn in a file (PW_FEEDBACK, with PW_TURN and
// PW_TURNS), and the best turn is kept as one commit, after it is measured once more. The run ends early when a turn
// that ended by itself changed nothing, when the target can go no further, or after --patience turns (3) with no new
// best once there is one. Every turn is a line in the record, and the run ends with a line of its own.
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
// A run that is killed outright cannot put anything back. It leaves .git/improve/running.json, and the next run
// names the commit it started from before it does anything.
//
// This is not a sandbox. The attempt runs as you, with your shell. Stop it with Ctrl-C and the attempt is put back
// (after several turns, a best turn that had passed is kept). What git does not track is out of sight: an installed
// dependency the scorer runs, a database, a process the attempt leaves running. To hold those, run the attempt
// where it cannot write them.
//
// An attempt that could not run is not a try. If the attempt command ends with 64 (how the programs here say "could
// not run"), or the shell could not run or find it (126, 127) and no file changed, the step puts back whatever is
// there, writes no line and exits 64. So a broken command stops a loop and cannot use up its tries. An attempt that
// fails any other way and changed nothing is a try, on record as "nothing". In a run over turns this holds for the
// first turn. At a later turn the run ends there, as a run ends: a best turn that had passed is kept once it wins
// again when measured once more, and anything else is put back.
//
// stdout is one line (or with --json, the record line). What the attempt prints goes to stderr.
// Exit codes, so `while node improve.mjs --attempt ...; do :; done` stops by itself:
//   0 kept · 1 put back, a guard got worse, the floor held, it changed what it may not, or it changed the contract ·
//   2 put back, gamed · 3 put back, nothing improved or nothing could be measured · 64 could not run, or the
//   attempt could not.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let marked = null;   // the mark of this run, removed on every way out
const unmark = () => { if (marked) { try { rmSync(marked, { force: true }); } catch { /* best effort */ } marked = null; } };
const die = (message) => { unmark(); console.error(`improve: ${message}`); process.exit(64); };
// The most one read from git or the gate may hold. Node's own cap is 1 MB, and git's list of a change of some 20,000
// files is more than that, and so is the gate's report on it: the step ended with ENOBUFS and the try was on no
// record. A change wider than this room is put back and written down as one that could not be measured (exit 3),
// never left off the record. IMPROVE_READ_MAX sets the room, in bytes.
const READ_MAX = Number(process.env.IMPROVE_READ_MAX) > 0 ? Number(process.env.IMPROVE_READ_MAX) : 256 * 1024 * 1024;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: READ_MAX }).trim();
const holds = (...args) => { try { git(...args); return true; } catch { return false; } };

// --help prints the header of this file, which is the whole of its documentation, and runs nothing.
if (process.argv.slice(2).some((x) => x === '--help' || x === '-h')) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
// A flag this does not know is an error, not a flag to drop: a mistyped --floor would turn the floor off.
const VALUED = ['--attempt', '--label', '--target', '--cheaper', '--repeat', '--base-cache', '--may-change', '--turns', '--patience'], BARE = ['--floor', '--json'];
const args = {};
for (let i = 0, argv = process.argv.slice(2); i < argv.length; i++) {
  if (BARE.includes(argv[i])) args[argv[i]] = true;
  else if (!VALUED.includes(argv[i])) die(`unknown flag ${argv[i]}`);
  else if (argv[i + 1] === undefined) die(`${argv[i]} needs a value`);
  else { args[argv[i]] = argv[i + 1]; i++; }
}
const attempt = args['--attempt'];
if (!attempt) die('--attempt "<command that changes the repo>" is required');
// Hooks are held off for the step's own git calls through GIT_CONFIG_COUNT. Git reads that from 2.31 on. An older git
// ignores it and says nothing, so the step does not run on one, and a version it cannot read is not guessed at.
{ let said = ''; try { said = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* said below */ }
  const v = /^git version (\d+)\.(\d+)/.exec(said);
  if (!v || Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 31)) die(`git 2.31 or newer is needed, and this is "${said || 'no git at all'}": an older git does not hold hooks off for the step's own calls`); }
// The name of a try, when none is given: the first word of its command, and of that word only the program's name. The
// label is the kept commit's subject and a field of the record, and both are pushed with the repo. The whole command
// can hold a prompt someone typed for an agent, or a key set in front of it (NAME=value), and until 0.8.19 it was the
// default. `--label` names a try otherwise, and is kept as given.
// The words of a shell line, as sh splits the first few: quotes kept together, $( ) and ` ` kept whole, the operators
// ; & | ( ) apart. A first form split on spaces alone, and a second reader found a name made of part of a quoted value
// (API_KEY='sk... part2' perl named the try "part2").
const shellWords = (cmd, max = 12) => {
  const s = String(cmd), out = []; let w = '', q = null, depth = 0;
  for (let i = 0; i < s.length && out.length < max; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) w += s[++i]; else w += c; continue; }
    if (depth) { w += c; if (c === '(') depth++; else if (c === ')') depth--; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '\\' && i + 1 < s.length) { w += s[++i]; continue; }
    if (c === '$' && s[i + 1] === '(') { w += '$('; i++; depth = 1; continue; }
    if (c === '`') { const j = s.indexOf('`', i + 1); const end = j < 0 ? s.length : j + 1; w += s.slice(i, end); i = end - 1; continue; }
    if (/\s/.test(c) || ';&|()'.includes(c)) { if (w) { out.push(w); w = ''; } if (!/\s/.test(c)) out.push(c); continue; }
    w += c;
  }
  if (w && out.length < max) out.push(w);
  return out;
};
const firstWord = (cmd) => {
  const word = shellWords(cmd).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^[;&|()]+$/.test(w) && /[A-Za-z0-9]/.test(w)) || '';
  const name = word.split(/[\/\\]/).filter(Boolean).pop() || '';
  return ((name.match(/[A-Za-z0-9_.+-]+/) || [''])[0]).slice(0, 60) || 'attempt';
};
const label = args['--label'] ?? firstWord(attempt), target = args['--target'] ?? 'score', cheaper = args['--cheaper'], floor = args['--floor'] === true;
const whole = (flag, dflt) => { if (args[flag] === undefined) return dflt; const v = Number(args[flag]); if (!Number.isInteger(v) || v < 1) die(`${flag} needs a whole number of 1 or more`); return v; };
const turns = whole('--turns', 1), patience = whole('--patience', 3);
// The same pattern rules as the gate's evaluatorPaths and mandates, so one pattern means one thing in both places.
const globToRe = (glob) => {
  const anchored = glob.startsWith('/'), g = anchored ? glob.slice(1) : glob;
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  return new RegExp(`${anchored || glob.includes('/') ? '^' : '(^|/)'}${body}$`);
};
const may = args['--may-change'] === undefined ? null : args['--may-change'].split(',').map((s) => s.trim()).filter(Boolean).map(globToRe);
if (may && !may.length) die('--may-change needs at least one path pattern: an empty list is not a list');
const gateCommand = process.env.PROMPTWHEEL ? process.env.PROMPTWHEEL.split(' ') : [process.execPath, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'promptwheel.mjs')];
const attemptEnv = { ...process.env };   // the attempt runs with your environment, as it was before this step set anything

let root; try { root = git('rev-parse', '--show-toplevel'); } catch { die('not inside a git repository'); }
process.chdir(root);
let base; try { base = git('rev-parse', '--verify', 'HEAD'); } catch { die('this repository has no commit yet: the loop needs one to put a change back to'); }
const recordDir = join(git('rev-parse', '--absolute-git-dir'), 'improve');
const record = join(recordDir, 'attempts.jsonl'), bestFile = join(recordDir, 'best.json'), markFile = join(recordDir, 'running.json'), feedbackFile = join(recordDir, 'feedback.txt');
// A run that was killed outright left its mark, and maybe its change in the tree. Say so before anything else.
if (existsSync(markFile)) {
  let m = null; try { m = JSON.parse(readFileSync(markFile, 'utf8')); } catch { /* a mark that cannot be read is still a mark */ }
  let alive = false; try { if (m && m.pid && m.pid !== process.pid) { process.kill(m.pid, 0); alive = true; } } catch { /* gone */ }
  if (alive) die(`another run of the loop is going in this repo (process ${m.pid})`);
  const from = m && typeof m.start === 'string' ? m.start : null;
  if (git('status', '--porcelain', '--untracked-files=all')) die(`a run that started at ${from ? from.slice(0, 12) : 'a commit this cannot read'} did not finish, and what it had changed is still in the tree. If none of it is yours, put the tree back with:\n  git reset --hard ${from || 'HEAD'} && git clean -fd\nThen run the loop again`);
  rmSync(markFile, { force: true });
}
if (git('status', '--porcelain')) die('the working tree is not clean: commit or stash first, so there is something to put back to');
// A file can be hidden from git (skip-worktree, assume-unchanged). git status then calls the tree clean when it is not.
const hidden = () => git('ls-files', '-v', '-z').split('\0').filter((l) => l && !l.startsWith('H ')).map((l) => l.slice(2));
const hiddenAtStart = hidden();
const edited = hiddenAtStart.filter((f) => existsSync(f) && git('hash-object', '--', f) !== git('rev-parse', `:${f}`));
if (edited.length) die(`the working tree is not clean: these files are edited and hidden from git: ${edited.join(', ')}. Show them again first: git update-index --no-skip-worktree <file> (or --no-assume-unchanged)`);
const branch = () => { try { return git('symbolic-ref', '-q', 'HEAD'); } catch { return null; } };   // null on a detached HEAD
const on = branch();
// The contract, as it stands at the commit the step starts on: the config file, a file inside the repo it extends,
// and the files its evaluatorPaths name. In the loop the contract is the person's, not the attempt's.
const contract = (() => {
  let cfg = null; try { cfg = JSON.parse(git('show', `${base}:promptwheel.config.json`)); } catch { return () => false; }
  const ext = [].concat((cfg && cfg.extends) || []).filter((x) => typeof x === 'string').map((x) => relative(root, resolve(root, x))).filter((x) => x && !x.startsWith('..') && !isAbsolute(x));
  const evals = (cfg && Array.isArray(cfg.evaluatorPaths) ? cfg.evaluatorPaths : []).filter((x) => typeof x === 'string' && x.trim()).map(globToRe);
  return (f) => f === 'promptwheel.config.json' || ext.includes(f) || evals.some((re) => re.test(f));
})();

// What the loop knows, and what it judges with, is read before the attempt runs and written back after it if the
// attempt touched it. The attempt is handed the record to read, a floor the attempt can lower is no floor, and a
// gate, a step or a kept base number the attempt can rewrite judges nothing.
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
// read again before every attempt: over several turns the record grows, and the gate fills the base cache
const snapshot = () => [[record, 'record'], [bestFile, 'floor'], [fileURLToPath(import.meta.url), 'step'], ...(gateFile ? [[gateFile, 'gate']] : []), ...cached().map((f) => [f, 'base cache']),
  ...settings.map((f) => [f, f.startsWith(`${common}/`) ? 'git settings' : `your git settings (${f})`]), ...inGitDirs()]
  .map(([file, what]) => ({ file, what, was: bytes(file), mode: isFile(file) ? statSync(file).mode : null, link: linkOf(file) }));
let own = snapshot();
const text = (what) => { const { was } = own.find((x) => x.what === what); return was == null ? null : was.toString('utf8'); };
const refs = () => Object.fromEntries(git('for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([ref]) => ref !== on));   // every ref but the branch this is on
let refsAtStart = refs();
let n = (text('record') || '').split('\n').filter(Boolean).length + 1;
let best = null;   // the best commit so far and what it scored; nothing until a change is kept under --floor
if (floor && text('floor') != null) {
  try { best = JSON.parse(text('floor')); } catch { /* said below */ }
  if (!best || typeof best.commit !== 'string' || typeof best.score !== 'number') die(`the floor file cannot be read (${bestFile}). Delete it to start the floor again from this commit`);
  if (!holds('cat-file', '-e', `${best.commit}^{commit}`)) die(`the best commit ${best.commit.slice(0, 12)} is gone from this clone. Delete ${bestFile} to start the floor again from this commit`);
}
mkdirSync(recordDir, { recursive: true });
writeFileSync(markFile, JSON.stringify({ start: base, branch: on, pid: process.pid, at: new Date().toISOString() }) + '\n'); marked = markFile;

// Ctrl-C reaches this step and the attempt together. Stay alive through it, so a half-made change is put back.
// A signal is only seen once the step lets the event loop turn, so over several turns it breathes after each
// blocking step: an attempt that catches Ctrl-C and ends by itself has still stopped the run.
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
const breath = () => new Promise((r) => setTimeout(r, 0));

// From here on, no git call of this step or of the gate runs a hook or an fsmonitor command, whatever the repo's
// config says and whatever folder the hooks are in. A repo that keeps its hooks in a tracked folder has them edited
// like any other file. These settings outrank every config file. The attempt itself gets the environment it had.
const k = Number(process.env.GIT_CONFIG_COUNT) || 0;
const quiet = { GIT_CONFIG_COUNT: String(k + 2), [`GIT_CONFIG_KEY_${k}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${k}`]: '/dev/null', [`GIT_CONFIG_KEY_${k + 1}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${k + 1}`]: 'false' };

const restored = new Set(), refsLost = [];   // which of the loop's own files the attempt touched, and what could not be put back
const wrote = new Set();                     // the refs under refs/improve that this run of the step put there
let asks = 0;   // how often the gate was asked in this try: what the try cost
const putBack = () => { git('reset', '-q', '--hard', base, '--'); git('clean', '-qfd'); };   // `--`: a file named as that commit would make git refuse
const note = (result, why, extra = {}) => {
  // One rule, kept here because every line is written here: refs/improve/<n> holds a change exactly when line n names
  // one, and it is that change. The report holds the record to this rule, and says "not whole" when it is broken.
  // - A change this run made is named by the line under its number, whatever else the line says: a change too wide
  //   to read and a turn stopped while its check ran are on record, and what they changed stays readable.
  // - The closing line of a run over turns names its best turn's change, which is so readable under its number too.
  // - Nothing is taken away here. The refs are shared by every worktree of a repo, each worktree keeps a record and
  //   numbers of its own, and a ref this run did not write (`wrote`) is not this run's to touch.
  const ref = `refs/improve/${n}`;
  if (!extra.candidate && wrote.has(ref)) extra = { ...extra, candidate: git('rev-parse', ref) };
  if (extra.candidate) git('update-ref', ref, extra.candidate);
  const line = { n, at: new Date().toISOString(), label, base, target, result, why, ...extra, ...(asks ? { asks } : {}), ...(restored.size ? { recordPutBack: true, restored: [...restored] } : {}), ...(refsLost.length ? { refsLost } : {}) };
  appendFileSync(record, JSON.stringify(line) + '\n');
  n++;
  return line;
};
const finish = (result, why, exit, extra) => {
  const line = note(result, why, extra);
  const touched = restored.size ? ` (the attempt touched the loop's own files, which were put back: ${[...restored].join(', ')})` : '';
  unmark();
  console.log(args['--json'] ? JSON.stringify(line) : `${String(line.n).padStart(2)}  ${result.padEnd(8)} ${label}: ${why}${touched}`);
  process.exit(exit);
};

// An attempt that could not run is not a try. 64 is how the programs here say "could not run", and 126 and 127 are
// the shell saying the command could not be run or was not found. Nothing is judged and no line is written, so a
// broken attempt command stops a loop and does not use up its tries. A command that changed files and then ended
// 126 or 127 did run in part, and that change is judged like any other.
const couldNotRun = (tried, changedSomething) => tried.status === 64 || (!changedSomething && (tried.status === 126 || tried.status === 127));
const notATry = (tried, when = '') => `the attempt could not run (exit ${tried.status})${when}. Nothing was tried and nothing is on record: fix the attempt command, then run this again`;

// Runs the attempt once, then puts back whatever it did to what judges it. Returns how the attempt's command ended.
const tryOnce = (env) => {
  own = snapshot(); refsAtStart = refs();
  const tried = spawnSync(attempt, { shell: true, stdio: ['inherit', 2, 2], env: { ...attemptEnv, IMPROVE_RECORD: record, IMPROVE_TARGET: target, ...env } });
  Object.assign(process.env, quiet);
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
  return tried;
};

// Where the attempt left the branch. A proposer that commits by itself must not skip the gate, and one that throws
// commits away must not take a kept change with it. Each returns the reason it refused (and has recorded), or null.
const leftBranch = () => {
  if (branch() === on) return null;
  const why = `the attempt left the repo on another branch or commit (it started on ${on || 'a detached HEAD'} at ${base.slice(0, 12)}). Nothing was judged or kept: put it back by hand`;
  note('rewrote', why); return why;
};
const foldOrRefuse = () => {
  const now = git('rev-parse', 'HEAD');
  if (now !== base && holds('merge-base', '--is-ancestor', base, now)) git('reset', '-q', base, '--');   // its commits become a working change, judged like any other
  else if (now !== base) {
    git('update-ref', `refs/improve/${n}`, now); wrote.add(`refs/improve/${n}`); putBack();
    const why = `the attempt moved the branch off the commit it started on. It is put back, and where the attempt left it is under refs/improve/${n}`;
    note('rewrote', why, { candidate: now }); return why;
  }
  return null;
};

// The change so far, against the commit the step started on, made into a commit that no branch points at. This
// commit is what the gate judges. Its message is one line, so nothing in a label can read as a reason in a commit.
const candidateOf = (subject) => {
  git('add', '-A');
  const files = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const tree = git('write-tree');
  const candidate = git('commit-tree', tree, '-p', base, '-m', subject);
  git('update-ref', `refs/improve/${n}`, candidate); wrote.add(`refs/improve/${n}`);
  git('reset', '-q');
  return { files, tree, candidate };
};

const ask = (...refs) => {
  asks++;
  const run = spawnSync(gateCommand[0], [...gateCommand.slice(1), 'run', ...refs, '--json', ...(args['--repeat'] ? ['--repeat', args['--repeat']] : []), ...(args['--base-cache'] ? ['--base-cache', args['--base-cache']] : [])], { encoding: 'utf8', maxBuffer: READ_MAX });
  if (run.error && run.error.code === 'ENOBUFS') throw Object.assign(new Error("the gate's report is more than the step reads at once"), { code: 'ENOBUFS' });
  try { return JSON.parse(run.stdout); } catch { throw new Error(`could not read the gate's report (exit ${run.status}): ${(run.stderr || '').trim().slice(0, 300)}`); }
};
const moved = (m) => (m.after == null ? `${m.name} could not be read${m.before == null ? '' : ' after the change'}` : `${m.name} ${m.before} to ${m.after}`);
const changedSince = (candidate) => execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, candidate, '--'], { encoding: 'utf8', maxBuffer: READ_MAX }).split('\0').filter(Boolean);

// How a candidate stands against the commit the step started on: what the gate says, read with the step's rules.
const judge = ({ files, candidate }) => {
  // What may change. The names are read from the commit the gate would judge, a move counts at both ends, and a
  // try that touched anything else is put back whole: half of a change is not a change anyone made.
  if (may) {
    const outside = changedSince(candidate).filter((f) => !may.some((re) => re.test(f)));
    if (outside.length) return { standing: 'outside', why: `it changed what it may not: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` and ${outside.length - 3} more` : ''}`, extra: { candidate, files, outside } };
  }
  const report = ask('--base', base, '--head', candidate);
  const metric = (name, r = report) => r.metrics.find((m) => m.name === name);
  const t = metric(target), c = cheaper ? metric(cheaper) : null;
  for (const [name, found] of [[target, t], [cheaper, cheaper ? c : true]]) if (!found) throw new Error(`the gate has no metric named "${name}"`);
  // `noise` is the band the gate held this try to (the one the contract declares, else the spread it measured): a run
  // reads it here to know when no gain could be kept any more
  const metrics = report.metrics.map(({ name, before, after, status, ok, noise, gamed, paid, overBudget }) => ({ name, before, after, status, ok, ...(typeof noise === 'number' ? { noise } : {}), ...(gamed ? { gamed } : {}), ...(paid ? { paid } : {}), ...(overBudget ? { overBudget } : {}) }));
  const seen = { candidate, files, verdict: report.verdict, metrics };
  // The verdict word is `fail` when a gamed win sits beside a guard that got worse, so read the marks too.
  const gamed = report.metrics.filter((m) => m.gamed === true);
  if (report.verdict === 'gamed' || gamed.length) return { standing: 'gamed', why: `${gamed.map((m) => m.name).join(', ') || 'a metric'} moved by changing what it is measured with`, extra: seen, report };
  if (report.verdict === 'fail') return { standing: 'worse', why: report.metrics.filter((m) => m.guard && !m.ok).map(moved).join(', ') || 'a protected path or the gate itself changed', extra: seen, report };
  if (report.verdict !== 'pass') return { standing: 'unsure', why: 'the gate could not measure it', extra: seen, report };
  const held = t.status === 'unchanged' || t.status === 'inconclusive';   // the same, or a move inside the noise band
  const why = t.status === 'improved' ? moved(t) + (c && c.paid ? `, ${moved(c)} paid for` : '')
    : (c && held && c.status === 'improved') ? `${target} ${t.status === 'unchanged' ? `held at ${t.after}` : `${t.before} to ${t.after}, inside its band`}, ${moved(c)}` : null;
  if (!why) return { standing: 'flat', why: `${target} did not improve (${t.status})`, extra: seen, report };
  // the contract is the person's: a change the gate would keep is put back when it touched it
  const touched = changedSince(candidate).filter(contract);
  if (touched.length) return { standing: 'contract', why: `it changed the contract (${touched.slice(0, 3).join(', ')}): in the loop the contract is the person's`, extra: seen, report };
  // how far ahead: the target's gain first, a saving under --cheaper only breaks a tie
  const gainOf = (m) => (m && m.status === 'improved' && typeof m.before === 'number' && typeof m.after === 'number' ? Math.abs(m.after - m.before) : 0);
  const topped = (t.direction === 'pass' && t.after === 1) || (t.direction === 'down' && t.after === 0);
  return { standing: 'win', why, extra: seen, report, t, gain: gainOf(t) + gainOf(c) * 1e-9, topped };
};
const exitOf = { gamed: 2, worse: 1, unsure: 3, flat: 3, outside: 1, contract: 1, nothing: 3 };

// The floor, then the keep. The change also has to hold against the best commit so far: a second ask of the gate,
// with that commit as the base. The parent is the best until something is kept that scores under it. What is kept
// is the tree the gate judged, as a commit made here: no hook runs, and the working tree is not read again. A file
// edited since the gate looked is not in it, and goes with the reset.
const keep = ({ tree, candidate }, t, why, extra) => {
  const better = (a, b) => (t.direction === 'down' ? a < b : a > b);
  const top = best || { commit: base, score: t.before };
  if (floor && top.commit !== base) {
    const b = ask('--base', top.commit, '--head', candidate).metrics.find((m) => m.name === target);
    if (!b || b.after == null) { putBack(); finish('unsure', `the gate could not measure ${target} against its best`, 3, extra); }
    if (b.status === 'regressed') { putBack(); finish('worse', `${target} was ${b.before} at its best and is ${b.after} now: under the floor`, 1, { ...extra, floor: { best: top.commit, before: b.before, after: b.after } }); }
  }
  const commit = git('commit-tree', tree, '-p', base, '-m', `improve: ${label}\n\n${why}`);
  git('reset', '-q', '--hard', commit, '--'); git('clean', '-qfd');
  if (floor) writeFileSync(bestFile, JSON.stringify(better(t.after, top.score) ? { commit, score: t.after } : top) + '\n');
  finish('kept', why, 0, { ...extra, commit });
};

// What the next turn is told: how the whole change so far stands against the start, measure by measure.
const feedbackText = (turn, last) => {
  const out = [`Turn ${turn} of ${turns}. What is measured is the whole change since this run started, against the commit it started from.`];
  if (!last) out.push('Nothing is measured yet.');
  else {
    if (last.code !== 0 && last.same) out.push(`The command of turn ${last.t} ended with code ${last.code} and changed nothing on disk: it was stopped, or it failed, before anything was saved. Save each file as soon as it is done.`);
    else if (last.code !== 0) out.push(`The command of turn ${last.t} ended with code ${last.code}: it was stopped, or it failed. What it had saved by then is in the tree.`);
    if (last.report) {
      out.push(`After turn ${last.t}:`);
      for (const m of last.report.metrics) {
        const word = m.status === 'improved' ? 'better' : m.status === 'regressed' ? 'worse' : m.status === 'unchanged' ? 'the same' : 'not measured';
        out.push(`  ${m.name}: ${m.before ?? '?'} at the start, ${m.after ?? '?'} now (${word})`);
      }
    }
    if (last.standing === 'contract') out.push(`THE CONTRACT WAS CHANGED at turn ${last.t}: ${last.why}. Put it back as it was at the start. In the loop the contract is not the attempt's to change.`);
    if (last.standing === 'outside') out.push(`OUTSIDE WHAT MAY CHANGE at turn ${last.t}: ${last.why}. Put those files back as they were at the start.`);
    if (last.standing === 'worse') out.push(`WORSE THAN AT THE START: ${last.why}. The run is kept only if nothing is worse at its end.`);
    if (last.standing === 'gamed') out.push('A measure went up by a change to the tests or the contract, not the source. That is not a win, at this turn or a later one.');
    if (last.standing === 'win') out.push('As it stands this would be kept. A later turn may gain more. The best turn is the one that is kept.');
  }
  out.push('The tests and the contract that count are the ones from the start. A change to the tests or the contract cannot make a win.');
  return out.join('\n') + '\n';
};

try {
  if (turns === 1) {
    // ---- one try: the attempt, judged alone ----
    try { writeFileSync(feedbackFile, feedbackText(1, null)); } catch { /* the attempt runs without it */ }
    const tried = tryOnce({ PW_TURN: '1', PW_TURNS: '1', PW_FEEDBACK: feedbackFile });
    const left = leftBranch(); if (left) die(left);
    if (tried.signal) { putBack(); const why = `the attempt was stopped (${tried.signal}), so it is put back`; note('stopped', why); die(why); }
    const refused = foldOrRefuse(); if (refused) die(refused);
    const changedSomething = git('status', '--porcelain') !== '';
    if (couldNotRun(tried, changedSomething)) { putBack(); die(notATry(tried)); }
    if (!changedSomething) finish('nothing', 'the attempt changed no file', 3);
    const made = candidateOf(`attempt ${n}: ${label.replace(/\s+/g, ' ')}`);
    const j = judge(made);
    if (j.standing !== 'win') { putBack(); finish(j.standing, j.why, exitOf[j.standing], j.extra); }
    keep(made, j.t, j.why, j.extra);
  }

  // ---- a run over several turns: each turn goes on from the last, and the whole change is judged against the start ----
  const episode = `${base.slice(0, 7)}-${Date.now().toString(36)}`;
  const baseTree = git('rev-parse', `${base}^{tree}`);
  let lead = null, last = null, judged = null, sinceBest = 0, prevTree = baseTree, turnsRun = 0, ended = '', couldNot = null;
  for (let t = 1; t <= turns; t++) {
    try { writeFileSync(feedbackFile, feedbackText(t, last)); } catch { /* the attempt runs without it */ }
    console.error(`▶ turn ${t} of ${turns}: ${label}`);
    const tried = tryOnce({ PW_TURN: String(t), PW_TURNS: String(turns), PW_FEEDBACK: feedbackFile });
    await breath();
    const left = leftBranch(); if (left) die(left);
    // stopped: a best turn that had passed its whole check is kept; anything else is put back
    const stop = (how) => {
      // A turn stopped while its check ran had made a change, stored under the next number. The win that is kept below
      // takes a number too, so the stopped turn gets its line first: what it changed stays readable under its own.
      if (lead && wrote.has(`refs/improve/${n}`)) note('stopped', `the attempt was stopped (${how}) at turn ${t}, so it is put back`, { episode, turn: t, turns: turnsRun });
      if (lead) { console.error(`  (stopped at turn ${t}: turn ${lead.t} had passed its check and is kept)`); keep(lead.made, lead.j.t, `${lead.j.why} (turn ${lead.t} of ${turnsRun}; stopped at turn ${t})`, { ...lead.j.extra, episode, turns: turnsRun, best: lead.t }); }
      putBack(); const why = `the attempt was stopped (${how}) at turn ${t}, so it is put back`; note('stopped', why, { episode, turns: turnsRun, best: 0 }); die(why);
    };
    if (tried.signal || interrupted) stop(tried.signal || 'SIGINT');
    const refused = foldOrRefuse(); if (refused) die(refused);
    // the whole change so far, as a tree. A turn that left it as the last turn did is not judged again: the gate is
    // not asked twice about one tree.
    git('add', '-A'); const treeNow = git('write-tree'); git('reset', '-q');
    // An attempt that could not run is not a try (couldNotRun, above). Over turns, what it changed is what the turn
    // itself changed. At the first turn it is no try at all. At a later turn the run ends here, as a run ends: a best
    // turn is kept only if it wins again when measured once more (an unattended run is where a noisy win slips in),
    // and anything else is put back, below.
    if (couldNotRun(tried, treeNow !== prevTree)) {
      if (t === 1) { putBack(); die(notATry(tried)); }
      console.error(`  (the attempt could not run at turn ${t}: the run ends there)`);
      couldNot = { t, status: tried.status }; ended = `the attempt could not run at turn ${t} (exit ${tried.status})`; break;
    }
    turnsRun = t;
    const code = tried.status ?? 1;
    let j, made = null;
    if (treeNow === baseTree) j = { standing: 'nothing', why: 'the change so far is no change at all' };
    else if (treeNow === prevTree) j = { standing: 'same', why: 'the turn changed nothing' };
    else {
      made = candidateOf(`attempt ${n}: ${label.replace(/\s+/g, ' ')} (turn ${t} of ${turns})`);
      // a check cut short by Ctrl-C measured nothing that can be trusted: that is a stop, not an error
      try { j = judge(made); } catch (e) { await breath(); if (interrupted) stop('SIGINT'); throw e; }
    }
    last = { t, code, same: treeNow === prevTree, standing: j.standing, why: j.why, report: j.report || null };
    if (j.standing !== 'same') judged = last;
    note('turn', j.why, { ...(j.extra || {}), episode, turn: t, turns, standing: j.standing });
    console.error(`  turn ${t}: ${j.standing === 'win' ? `ahead (${j.why})` : `${j.standing} (${j.why})`}`);
    if (j.standing === 'win' && (!lead || j.gain > lead.j.gain)) { lead = { t, made, j }; sinceBest = 0; } else if (lead) sinceBest++;
    // A turn that changed nothing ends the run only when its command ended by itself: an agent saying it is done.
    // One that was cut off by a limit, or failed, has said nothing of the kind.
    if (last.same && code === 0) { ended = 'a turn changed nothing'; break; }
    prevTree = treeNow;
    if (lead && j.standing === 'win' && j.topped) { ended = 'the target can go no further'; break; }
    if (lead && sinceBest >= patience) { ended = `${patience} turn${patience === 1 ? '' : 's'} in a row with no new best`; break; }
  }
  const after = ended ? ` (the run ended after turn ${turnsRun}: ${ended})` : '';
  const runExtra = { episode, turns: turnsRun, best: lead ? lead.t : 0 };
  if (lead && turnsRun > 1) {
    // The second look: N turns are N tries at a measure that may be noisy, so the best turn is measured once more
    // and kept only if it still wins. It is the commit that was judged at its turn that is measured again.
    const again = judge(lead.made);
    if (again.standing !== 'win') { putBack(); finish('flat', `turn ${lead.t} had won (${lead.j.why}), and the win did not show again when it was measured once more${after}`, 3, { ...again.extra, ...runExtra, best: 0 }); }
    lead.j = again;
  }
  if (lead) keep(lead.made, lead.j.t, `${lead.j.why}${turnsRun > 1 ? ` (turn ${lead.t} of ${turnsRun})` : ''}${after}`, { ...lead.j.extra, ...runExtra });
  putBack();
  // a run that ended on an attempt that could not run, with no best turn: put back, and the code for "could not run"
  if (couldNot) { const why = `the attempt could not run (exit ${couldNot.status}) at turn ${couldNot.t}, so the run ends there and is put back`; note('stopped', why, runExtra); die(why); }
  const s = judged ? judged.standing : 'nothing';   // the run reads as the last turn that was judged
  finish(s, `${judged ? judged.why : 'nothing was measured'}${after}`, exitOf[s] ?? 3, runExtra);
} catch (e) {
  // a change wider than the step reads at once (READ_MAX): put back, and on record as one that could not be measured
  if (e && e.code === 'ENOBUFS') {
    try { putBack(); } catch { /* the line below still says what happened */ }
    const room = READ_MAX >= 1048576 ? `${Math.round(READ_MAX / 1048576)} MB` : `${READ_MAX} bytes`;
    finish('nothing', `the change is too wide to read: more than ${room} came from git or the gate at once, so it was not measured and is put back`, 3);
  }
  // anything this did not plan for: put the attempt back and say so, with the code for "could not run". No line is
  // written for it (it is not a try), so the change this run put under the next number is taken away again.
  try { putBack(); } catch { /* the message below is what matters */ }
  try { if (wrote.has(`refs/improve/${n}`)) git('update-ref', '-d', `refs/improve/${n}`); } catch { /* the message below is what matters */ }
  die(String(e.message || e).split('\n').filter((l) => l.trim()).slice(0, 3).join(' '));
}
