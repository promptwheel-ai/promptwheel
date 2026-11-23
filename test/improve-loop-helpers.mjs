// Shared by the loop's tests (improve-loop-step, -wall and -run): a small repo, the gate, and the four programs under test.
//
// Every test builds its own repo, runs the real program against the real gate, and reads what is left behind:
// the exit code, the commits, the files and the record. What a program prints is checked too, but never trusted alone.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), HERE = join(ROOT, 'examples', 'improve-loop');
export const STEP = join(HERE, 'improve.mjs'), WALL = join(HERE, 'wall.mjs'), RUN = join(HERE, 'run.mjs'), REPORT = join(HERE, 'report.mjs');
// The gate is the engine in this checkout.
export const GATE = join(ROOT, 'bin', 'promptwheel.mjs');
if (!existsSync(GATE)) { console.error(`no engine at ${GATE}`); process.exit(64); }

export const TMP_ROOT = mkdtempSync(join(tmpdir(), 'improve-loop-test-'));
process.env.TMPDIR = TMP_ROOT;   // the gate's clean copies and the wall's copies go under it too, and all of it is removed at exit
process.on('exit', () => rmSync(TMP_ROOT, { recursive: true, force: true }));
// A home folder made here. The step puts git's global config back when an attempt edits it, so no test may ever
// be pointed at yours.
export const HOME = join(TMP_ROOT, 'home'); mkdirSync(HOME);
process.env.HOME = HOME; process.env.XDG_CONFIG_HOME = join(HOME, '.config'); delete process.env.GIT_CONFIG_GLOBAL;
export const NODE = process.execPath;
export const ENV = { ...process.env, PROMPTWHEEL: `${NODE} ${GATE}` };

export const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const put = (d, f, text) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), text); };
export const read = (d, f) => { try { return readFileSync(join(d, f), 'utf8').trim(); } catch { return null; } };
export const head = (d) => git(d, 'rev-parse', 'HEAD');
export const at = (d, f, ref = 'HEAD') => { try { return git(d, 'show', `${ref}:${f}`); } catch { return null; } };   // a file as a commit holds it
export const clean = (d) => git(d, 'status', '--porcelain') === '';
export const asked = (d) => (existsSync(`${d}.asked`) ? readFileSync(`${d}.asked`, 'utf8').split('\n').filter(Boolean).length : 0);
export const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const record = (d) => lines(join(d, '.git', 'improve', 'attempts.jsonl'));
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // one shell word, whatever is in it

// Helpers an attempt calls. They sit outside every repo, so they are never part of a change.
export const BUMP = join(TMP_ROOT, 'bump.sh');   // bump.sh <file> <by>: add a number to the number in a file
writeFileSync(BUMP, 'v=$(cat "$1"); echo $(( v + $2 )) > "$1"\n');
export const bump = (file, by) => `sh ${BUMP} ${file} ${by}`;

// A small repo with a score and a cost, both guards. The score is what the source says plus what the grader's own
// file says, so a change can win by the source (honest) or by the grader's file (gamed). Every reading of the score
// is counted in a file beside the repo. `over` changes a metric, adds a top-level setting, or adds files.
export function toy(over = {}) {
  const d = mkdtempSync(join(TMP_ROOT, 'repo-'));
  git(d, 'init', '-q', '-b', 'main', '.'); git(d, 'config', 'user.email', 't@example.com'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'commit.gpgsign', 'false');
  put(d, 'src/score.txt', '100\n'); put(d, 'src/cost.txt', '100\n'); put(d, 'evals/bonus.txt', '0\n'); put(d, 'README.md', 'toy\n');
  put(d, '.gitignore', 'ignored/\nnode_modules/\n');
  const score = { name: 'score', cmd: `echo x >> ${d}.asked; ${over.scorer || 'echo $(( $(cat src/score.txt) + $(cat evals/bonus.txt) ))'}`, extract: 'number', direction: 'up', guard: true, ...(over.score || {}) };
  const cost = { name: 'cost', cmd: 'cat src/cost.txt', extract: 'number', direction: 'down', guard: true, ...(over.cost || {}) };
  put(d, 'promptwheel.config.json', JSON.stringify({ metrics: [score, cost], evaluatorPaths: ['evals/bonus.txt', 'promptwheel.config.json'], ...(over.top || {}) }, null, 2) + '\n');
  for (const [f, text] of Object.entries(over.files || {})) put(d, f, text);
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'start: score 100, cost 100');
  for (const [f, text] of Object.entries(over.untracked || {})) put(d, f, text);
  return d;
}

// One rule every scenario is held to, whatever else it tests: after the step or a run has ended, refs/improve/<n> holds
// a change exactly when line n of the record names one, and it is that change. The report reads the two as "not
// whole" when they differ. (Found 2026-11-22 by running the report after the guide's own lines.)
export const agree = (d) => {
  let gitDir, refs;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    refs = Object.fromEntries(execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/improve'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map((l) => l.split(' ')));
  } catch { return; }   // no repository here: nothing to hold
  const f = join(gitDir, 'improve', 'attempts.jsonl'); let rows;
  try { rows = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; } catch { return; }   // a record a test broke on purpose
  if (rows.some((l) => l.refsLost)) return;   // the step said itself that a ref could not be put back
  for (const l of rows) if (l.candidate && refs[`refs/improve/${l.n}`] !== l.candidate) throw new Error(`line ${l.n} (${l.result}) names a change, and refs/improve/${l.n} does not hold it`);
  for (const ref of Object.keys(refs)) if (!rows.some((l) => `refs/improve/${l.n}` === ref && l.candidate)) throw new Error(`${ref} holds a change, and the record has no line for it`);
};
export const run = (file, d, args, env = {}) => {
  const r = spawnSync(NODE, [file, ...args], { cwd: d, encoding: 'utf8', env: { ...ENV, ...env }, timeout: 120000 });
  if (file === STEP || file === RUN) agree(d);
  return { code: r.status, out: r.stdout, err: r.stderr, signal: r.signal };
};
export const step = (d, attempt, ...flags) => run(STEP, d, ['--attempt', attempt, ...flags]);
// the same attempt, run behind the wall: the step is handed the wall as its attempt command
export const walled = (attempt, ...wallFlags) => `${NODE} ${WALL} ${wallFlags.join(' ')} -- ${q(attempt)}`;
