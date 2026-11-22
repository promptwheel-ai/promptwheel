#!/usr/bin/env node
// The loop's wall. Run an attempt in a copy of the tree, and hand back only the files.
//
//   node wall.mjs [--with <path>]... [--minutes N] [--no-record] -- "<attempt command>"
//
// Use it as the attempt of a loop step:
//   node improve.mjs --attempt 'node wall.mjs --with node_modules -- "sh agent.sh"'
//
// The attempt runs in a new folder that holds the tracked files of HEAD and a git repo of its own. Your .git is
// not there: its hooks, config, refs, record and index are out of reach of anything the attempt does by a path
// inside its folder. When the attempt ends, what it changed, added or deleted is brought into your tree as plain
// working changes, as if it had run there. Files git ignores are not brought back: they go with the copy.
//
//   --with <path>   also copy a folder git does not track (node_modules, vendor, .venv). The attempt gets its own
//                   copy to read and to scribble on. Nothing in it is brought back.
//   --minutes N     end the attempt after N minutes. Nothing is brought back, and the exit code is 124. At most 35,000.
//   --no-record     do not hand the attempt the loop's record (IMPROVE_RECORD). Without this flag it gets a copy.
//
// When the attempt ends, every process still running in its group is ended too.
//
// This is a copy, not a sandbox. The attempt still runs as you. It can find your real repo by its full path and
// write files there that git ignores, read anything you can read, and start a process that leaves its group. To
// stop those, make the attempt command a container that is handed this folder and nothing else:
//   node wall.mjs -- 'docker run --rm --network none -u $(id -u):$(id -g) -v "$PWD":"$PWD" -w "$PWD" <image> sh agent.sh'
// If the real tree did change while the attempt ran, this says so, and the change is judged with the rest.
//
// Exit codes: the attempt's own · 124 out of time · 65 nothing could be handed back · 64 could not run.
// A stopped attempt (Ctrl-C) hands nothing back, and this ends by the same signal.
import { execFileSync, spawn } from 'node:child_process';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';

const die = (message, code = 64) => { console.error(`wall: ${message}`); process.exit(code); };
// this program's own git calls run no hook and no fsmonitor command, in your repo or in the copy
const git = (args, opts = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const said = (e) => String(e.stderr || e.message || e).split('\n').filter((l) => l.trim()).slice(0, 2).join(' ');

// A flag this does not know is an error, not a flag to drop: a mistyped --minutes would run with no time limit.
const argv = process.argv.slice(2), cut = argv.indexOf('--'), withPaths = [];
let minutes = null, handRecord = true;
if (cut < 0 || cut === argv.length - 1) die('give the attempt after --, as one quoted command:  node wall.mjs -- "<command>"');
for (let i = 0; i < cut; i++) {
  if (argv[i] === '--no-record') handRecord = false;
  else if (argv[i] !== '--with' && argv[i] !== '--minutes') die(`unknown flag ${argv[i]}`);
  else if (i + 1 >= cut) die(`${argv[i]} needs a value`);
  else if (argv[i] === '--with') withPaths.push(argv[++i]);
  else {
    minutes = Number(argv[++i]); if (!(minutes > 0)) die('--minutes needs a number above 0');
    // Node's timer cannot count past about 35,791 minutes. Asked for more it fires at once, and the attempt would be ended in its first millisecond.
    if (minutes > 35000) die('--minutes cannot be more than 35,000 (about 24 days): the timer cannot count further, and would end the attempt at once');
  }
}
// one word after -- is a shell command, as the step would run it. Several words are a program and its arguments.
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const command = argv.length - cut === 2 ? argv[cut + 1] : argv.slice(cut + 1).map(q).join(' ');

let root; try { root = git(['rev-parse', '--show-toplevel']); } catch { die('not inside a git repository'); }
process.chdir(root);
let head; try { head = git(['rev-parse', '--verify', 'HEAD']); } catch { die('this repository has no commit yet, so there is no tree to copy'); }
if (git(['status', '--porcelain'])) die('the tree is not clean: commit or stash first. The copy is made from HEAD, and your own edits would not be in it');
const hidden = () => git(['ls-files', '-v', '-z']).split('\0').filter((l) => l && !l.startsWith('H ')).map((l) => l.slice(2));
const edited = hidden().filter((f) => existsSync(f) && git(['hash-object', '--', f]) !== git(['rev-parse', `:${f}`]));
if (edited.length) die(`the tree is not clean: these files are edited and hidden from git: ${edited.join(', ')}`);
const branch = () => { try { return git(['symbolic-ref', '-q', 'HEAD']); } catch { return null; } };
const on = branch();
for (const p of withPaths) {
  const n = normalize(p);
  if (isAbsolute(n) || n === '..' || n.startsWith(`..${sep}`) || n === '.' || n.split(sep)[0] === '.git') die(`--with ${p}: give a path inside this repo, and not its .git`);
  if (!existsSync(n)) die(`--with ${p}: there is no such path in this repo`);
}

// ---------------------------------------------------------------- the copy
const W = mkdtempSync(join(tmpdir(), 'improve-wall-')), tree = join(W, basename(root));
if (`${tree}${sep}`.startsWith(`${root}${sep}`)) { rmSync(W, { recursive: true, force: true }); die('the temp folder is inside this repo (TMPDIR), so a copy made there would not be outside it'); }
const tidy = () => rmSync(W, { recursive: true, force: true });
// What the attempt is handed: your environment, without the variables that would point git at your repo.
const env = { ...process.env, PWD: tree };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'OLDPWD']) delete env[key];
const inCopy = (args) => git(args, { cwd: tree, env });
try {
  // the tracked files of HEAD, through an index made here: a file hidden in your own index is copied like any other
  const index = { ...process.env, GIT_INDEX_FILE: join(W, 'index') };
  mkdirSync(tree);
  git(['read-tree', head], { env: index }); git(['checkout-index', '--all', `--prefix=${tree}${sep}`], { env: index });
  rmSync(join(W, 'index'), { force: true });
  // a git repo of its own, so the attempt can run git and nothing it does there is yours
  inCopy(['init', '-q', '-b', on ? on.replace(/^refs\/heads\//, '') : 'main']);
  for (const key of ['user.name', 'user.email']) { try { inCopy(['config', key, git(['config', '--get', key])]); } catch { /* none is set */ } }
  inCopy(['add', '-A', '-f']);
  inCopy(['-c', 'user.name=improve', '-c', 'user.email=improve@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `the tree at ${head.slice(0, 12)}`]);
  for (const p of withPaths) cpSync(normalize(p), join(tree, normalize(p)), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  if (env.IMPROVE_RECORD) {   // the loop's record: a copy to read, or nothing
    const from = env.IMPROVE_RECORD; delete env.IMPROVE_RECORD;
    if (handRecord) { env.IMPROVE_RECORD = join(W, 'record.jsonl'); if (existsSync(from)) copyFileSync(from, env.IMPROVE_RECORD); }
  }
} catch (e) { tidy(); die(`could not make the copy: ${said(e)}`); }

// ---------------------------------------------------------------- the attempt, in its own process group
const child = spawn(command, { shell: true, cwd: tree, stdio: 'inherit', env, detached: true });
const end = (signal) => { try { process.kill(-child.pid, signal); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = null, late = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopped = stopped || signal; end(signal); setTimeout(() => end('SIGKILL'), 2000).unref(); });
const timer = minutes ? setTimeout(() => { late = true; end('SIGTERM'); setTimeout(() => end('SIGKILL'), 2000).unref(); }, minutes * 60000) : null;
const [code, signal] = await new Promise((r) => { child.on('error', (e) => r([127, null, e])); child.on('exit', (c, s) => r([c, s])); });
clearTimeout(timer);
// whatever the attempt left running in its group ends here, before anything is read from the copy
for (let i = 0; i < 100 && end('SIGKILL'); i++) await sleep(10);

const leave = (message, exit) => {
  tidy(); console.error(`wall: ${message}`);
  if (stopped) { process.removeAllListeners(stopped); process.kill(process.pid, stopped); setTimeout(() => process.exit(130), 500); } else process.exit(exit);
};
if (stopped) leave(`the attempt was stopped (${stopped}). Nothing is handed back`);
else if (late) leave(`the attempt ran out of time (${minutes} minutes) and was ended. Nothing is handed back`, 124);
else if (signal) leave(`the attempt was ended by ${signal}. Nothing is handed back`, 65);
else {
  // ---------------------------------------------------------------- hand the files back
  let P = null;
  try {
    if (git(['rev-parse', 'HEAD']) !== head || branch() !== on) leave('your repo moved to another commit or branch while the attempt ran in the copy. Nothing is handed back', 65);
    const reached = git(['status', '--porcelain', '-z']).split('\0').filter(Boolean).map((l) => l.slice(2).trim());
    if (reached.length) console.error(`wall: your real tree changed while the attempt ran in the copy (${reached.slice(0, 5).join(', ')}). The attempt reached it by its full path, or something else wrote there. It is judged with the rest`);
    // The copy as a tree, made with your repo's object store and an index made now, in a folder nothing the attempt
    // started has seen. New files that git ignores are not in it, and neither is the copy's own .git: git never
    // adds a folder of that name. What comes back is files, never the copy's git state.
    P = mkdtempSync(join(tmpdir(), 'improve-back-'));
    const index = { ...process.env, GIT_INDEX_FILE: join(P, 'index') }, gitDir = git(['rev-parse', '--absolute-git-dir']);
    git(['read-tree', head], { env: index });
    git(['--git-dir', gitDir, '--work-tree', tree, 'add', '-A'], { env: index });
    const made = git(['write-tree'], { env: index });
    rmSync(P, { recursive: true, force: true }); P = null;
    if (made !== git(['rev-parse', `${head}^{tree}`])) {
      const changed = git(['diff-tree', '-r', '--name-only', '--no-renames', '-z', head, made]).split('\0').filter(Boolean);
      const unseen = hidden().filter((f) => changed.includes(f));
      if (unseen.length) leave(`these files are hidden from git in your repo, so a change to them cannot be handed back: ${unseen.join(', ')}. Nothing is handed back`, 65);
      git(['read-tree', '-m', '-u', head, made]);   // files change in your tree; a file you edited meanwhile makes this refuse
      git(['reset', '-q']);                          // and they are plain working changes, as any attempt leaves them
    }
  } catch (e) {
    if (P) rmSync(P, { recursive: true, force: true });
    leave(`could not hand the files back: ${said(e)}`, 65);
  }
  tidy();
  process.exit(code ?? 1);
}
