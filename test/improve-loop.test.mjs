// The improve loop's tests (node:test, no dependencies). Run: npm test  (or: node --test)
//
// Why this file exists. The engine had this loop as `promptwheel improve --attempt` from 0.0.2. Version 0.8.0
// (ed4fb3c, 2026-11-05) removed it, with its four tests, as a command nothing relied on. On 2026-11-21 the owner
// asked for it back. It lives in examples/improve-loop now: outside the engine and outside the npm package. These
// tests are what holds it there. Ask the owner before removing the loop or thinning this file.
//
// Every test builds its own small repo, runs the real loop step against the real engine in this checkout, and
// reads what is left behind: the exit code, the line it printed, the commits, the files and the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RIG = join(ROOT, 'examples', 'improve-loop', 'improve.mjs');
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'pw-loop-'));
process.env.TMPDIR = TMP_ROOT;   // the engine's clean copies go under it too, and all of it is removed at exit
process.on('exit', () => rmSync(TMP_ROOT, { recursive: true, force: true }));
// A home folder made here. The step puts git's global config back when an attempt edits it, so no test is ever
// pointed at yours.
const HOME = join(TMP_ROOT, 'home'); mkdirSync(HOME);
process.env.HOME = HOME; process.env.XDG_CONFIG_HOME = join(HOME, '.config'); delete process.env.GIT_CONFIG_GLOBAL;
// PROMPTWHEEL empty: the loop uses the engine in this checkout, whatever the shell that runs the suite has set
const ENV = { ...process.env, PROMPTWHEEL: '' };

const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim();
const put = (d, f, text) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), text); };
const read = (d, f) => readFileSync(join(d, f), 'utf8').trim();
const head = (d) => git(d, 'rev-parse', 'HEAD');
const clean = (d) => git(d, 'status', '--porcelain') === '';
const state = (d) => `${read(d, 'src/score.txt')} ${read(d, 'src/cost.txt')}`;
const asks = (d) => (existsSync(`${d}.asked`) ? readFileSync(`${d}.asked`, 'utf8').split('\n').filter(Boolean).length : 0);
const record = (d) => { const f = join(d, '.git', 'improve', 'attempts.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const bestOf = (d) => JSON.parse(readFileSync(join(d, '.git', 'improve', 'best.json'), 'utf8'));

// Helpers the attempts call. They sit outside every repo, so they are never part of a change.
const BUMP = join(TMP_ROOT, 'bump.sh');        // bump.sh <file> <by>: add a number to the number in a file
writeFileSync(BUMP, 'v=$(cat "$1"); echo $(( v + $2 )) > "$1"\n');
const CFG = join(TMP_ROOT, 'cfg.mjs');         // cfg.mjs "<statement on c>": edit the gate's own config
writeFileSync(CFG, "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = 'promptwheel.config.json', c = JSON.parse(readFileSync(f, 'utf8'));\nnew Function('c', process.argv[2])(c);\nwriteFileSync(f, JSON.stringify(c, null, 2) + '\\n');\n");
const trade = (score, cost) => `sh ${BUMP} src/score.txt ${score} && sh ${BUMP} src/cost.txt ${cost}`;

// A small repo with a score and a cost. The score is what the source says plus what the grader's own file says, so
// a change can win by the source (honest) or by the grader's file (gamed). Every reading of the score is counted in
// a file beside the repo. `over` changes a metric, adds more metrics, or adds a top-level setting.
function toy(over = {}) {
  const d = mkdtempSync(join(TMP_ROOT, 'repo-'));
  git(d, 'init', '-q', '-b', 'main', '.'); git(d, 'config', 'user.email', 't@example.com'); git(d, 'config', 'user.name', 't');
  put(d, 'src/score.txt', '100\n'); put(d, 'src/cost.txt', '100\n'); put(d, 'evals/bonus.txt', '0\n'); put(d, 'README.md', 'toy\n'); put(d, '.gitignore', 'ignored/\n');
  const score = { name: 'score', cmd: `echo x >> ${d}.asked; echo $(( $(cat src/score.txt) + $(cat evals/bonus.txt) ))`, extract: 'number', direction: 'up', guard: true, ...(over.score || {}) };
  const cost = { name: 'cost', cmd: 'cat src/cost.txt', extract: 'number', direction: 'down', guard: true, ...(over.cost || {}) };
  put(d, 'promptwheel.config.json', JSON.stringify({ metrics: [score, cost, ...(over.more || [])], evaluatorPaths: ['evals/bonus.txt', 'promptwheel.config.json'], ...(over.top || {}) }, null, 2) + '\n');
  for (const [f, text] of Object.entries(over.files || {})) put(d, f, text);
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'start: score 100, cost 100');
  return d;
}
// One rule every scenario in this file is held to, whatever else it tests: after the step has run, refs/improve/<n>
// holds a change exactly when line n of the record names one, and it is that change. The loop's report reads the two
// as "not whole" when they differ. Found 2026-11-22, by running the report after the guide's own lines: a run over
// turns that kept its best turn, a try that could not be judged, and a stop while a check ran each left them apart,
// and no scenario here had read both.
const agree = (d) => {
  let gitDir, refs;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    refs = Object.fromEntries(execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/improve'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map((l) => l.split(' ')));
  } catch { return; }   // no repository here: nothing to hold
  const f = join(gitDir, 'improve', 'attempts.jsonl'); let lines;
  try { lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; } catch { return; }   // a record a test broke on purpose
  if (lines.some((l) => l.refsLost)) return;   // the step said itself that a ref could not be put back
  for (const l of lines) if (l.candidate) assert.equal(refs[`refs/improve/${l.n}`], l.candidate, `line ${l.n} (${l.result}) names a change, and refs/improve/${l.n} does not hold it`);
  for (const ref of Object.keys(refs)) assert.ok(lines.some((l) => `refs/improve/${l.n}` === ref && l.candidate), `${ref} holds a change, and the record has no line for it`);
};
const run = (d, args, env = {}) => { const r = spawnSync(process.execPath, [RIG, ...args], { cwd: d, encoding: 'utf8', env: { ...ENV, ...env }, timeout: 120000 }); agree(d); return { code: r.status, out: r.stdout, err: r.stderr }; };
const step = (d, attempt, ...flags) => run(d, ['--attempt', attempt, ...flags]);
const banded = () => toy({ score: { noise: 10 } });
// the same small trade again and again: 5 off the score, 10 off the cost. Returns each step's exit code.
const walk = (d, times, attempt, ...flags) => Array.from({ length: times }, () => step(d, attempt, '--cheaper', 'cost', ...flags).code);

// ------------------------------------------------------------------ what a step decides
test('loop: a real win is kept as one commit, and the step exits 0', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 110 > src/score.txt', '--label', 'raise the score');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ 1 {2}kept {5}raise the score: score 100 to 110\n$/);
  assert.equal(git(d, 'rev-list', '--count', 'HEAD'), '2', 'one new commit'); assert.equal(git(d, 'rev-parse', 'HEAD^'), base);
  assert.equal(git(d, 'log', '-1', '--format=%B'), 'improve: raise the score\n\nscore 100 to 110');
  assert.equal(read(d, 'src/score.txt'), '110'); assert.ok(clean(d));
});
test('loop: a change that makes a guard worse is put back: no commit, the file as it was, exit 1', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 90 > src/score.txt');
  assert.equal(r.code, 1); assert.match(r.out, / worse {3}.*score 100 to 90/);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop: after a kept win, a worse change is put back to the win, not to the start', () => {
  const d = toy();
  assert.equal(step(d, 'echo 110 > src/score.txt').code, 0);
  const kept = head(d);
  assert.equal(step(d, 'echo 105 > src/score.txt').code, 1);
  assert.equal(head(d), kept); assert.equal(read(d, 'src/score.txt'), '110'); assert.ok(clean(d));
});
test('loop: a kept change that adds a new file keeps the file (the old loop once deleted it with clean -fd)', () => {
  const d = toy();
  assert.equal(step(d, 'echo 110 > src/score.txt && echo notes > src/new.txt').code, 0);
  assert.equal(read(d, 'src/new.txt'), 'notes'); assert.equal(git(d, 'ls-files', 'src/new.txt'), 'src/new.txt', 'and it is in the commit');
});
test('loop: a win made only by a new file is seen by the gate and kept', () => {
  const d = toy({ score: { cmd: 'ls src | wc -l' } });   // the score is how many files src holds: two at the start
  const r = step(d, 'echo more > src/extra.txt');
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /score 2 to 3/); assert.equal(git(d, 'ls-files', 'src/extra.txt'), 'src/extra.txt');
});
test('loop: a new file from a change that is put back is removed', () => {
  const d = toy();
  assert.equal(step(d, 'echo 90 > src/score.txt && echo notes > src/new.txt && mkdir -p deep/er && echo x > deep/er/file.txt').code, 1);
  assert.ok(!existsSync(join(d, 'src/new.txt'))); assert.ok(!existsSync(join(d, 'deep'))); assert.ok(clean(d));
});
test('loop: a win made by the grader\'s own file, with the source untouched, is put back as gamed, exit 2', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 50 > evals/bonus.txt');
  assert.equal(r.code, 2); assert.match(r.out, / gamed {3}.*score moved by changing what it is measured with/);
  assert.equal(head(d), base); assert.equal(read(d, 'evals/bonus.txt'), '0'); assert.ok(clean(d));
});
test('loop: a win that is mostly the grader\'s file is put back as gamed too', () => {
  const d = toy(), base = head(d);
  assert.equal(step(d, 'echo 105 > src/score.txt && echo 50 > evals/bonus.txt').code, 2);   // 5 of the 55 came from the source
  assert.equal(head(d), base); assert.equal(state(d), '100 100'); assert.ok(clean(d));
});
test('loop: a gamed win beside a guard that got worse reads gamed, exit 2, though the gate\'s own word is fail', () => {
  const d = toy();
  const r = step(d, 'echo 50 > evals/bonus.txt && echo 150 > src/cost.txt');
  assert.equal(r.code, 2, r.out); assert.equal(record(d)[0].result, 'gamed'); assert.equal(record(d)[0].verdict, 'fail'); assert.ok(clean(d));
});
test('loop: a change that passes the gate and improves nothing is not kept, exit 3', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo more >> README.md');
  assert.equal(r.code, 3); assert.match(r.out, / flat {4}.*score did not improve \(unchanged\)/);
  assert.equal(record(d)[0].verdict, 'pass', 'the gate passed it: a pass is not a win');
  assert.equal(head(d), base); assert.equal(read(d, 'README.md'), 'toy'); assert.ok(clean(d));
});
test('loop: an attempt that changes no file is on record as nothing, exit 3', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'true');
  assert.equal(r.code, 3); assert.match(r.out, / nothing .*the attempt changed no file/);
  assert.equal(head(d), base); assert.equal(record(d).length, 1); assert.equal(asks(d), 0, 'and the gate is not asked');
});
test('loop: a win that costs more is put back when the gate has no rate for the cost, exit 1', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 110 > src/score.txt && echo 120 > src/cost.txt');
  assert.equal(r.code, 1); assert.match(r.out, / worse {3}.*cost 100 to 120/); assert.equal(head(d), base); assert.equal(state(d), '100 100');
});
test('loop: a change that leaves a guard unreadable is put back, and the line says which, exit 1', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'rm src/cost.txt && echo 110 > src/score.txt');   // the cost command prints no number now
  assert.equal(r.code, 1, r.out + r.err); assert.match(r.out, / worse {3}.*cost could not be read after the change/);
  assert.equal(head(d), base); assert.equal(state(d), '100 100'); assert.ok(clean(d));
});
test('loop: a guard that cannot be read on either side is not a pass: the change is put back, exit 1', () => {
  const d = toy({ cost: { cmd: 'true' } }), base = head(d);   // a cost command that prints no number at all
  const r = step(d, 'echo 110 > src/score.txt');
  assert.equal(r.code, 1, r.out + r.err); assert.match(r.out, / worse {3}.*: cost could not be read\n$/);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop: when the gate is unsure (a pass-or-fail guard is failing on both sides and nothing improved), the change is not kept, exit 3', () => {
  const d = toy({ more: [{ name: 'tests_pass', cmd: 'false', extract: 'exit', direction: 'pass', guard: true }] }), base = head(d);
  const r = step(d, 'echo more >> README.md');
  assert.equal(r.code, 3, r.out + r.err); assert.match(r.out, / unsure {2}.*the gate could not measure it/); assert.equal(record(d)[0].verdict, 'inconclusive');
  assert.equal(head(d), base); assert.equal(read(d, 'README.md'), 'toy'); assert.ok(clean(d));
});
test('loop: an attempt command that exits non-zero is still judged by what it changed', () => {
  const d = toy();
  assert.equal(step(d, 'echo 110 > src/score.txt; exit 7').code, 0, 'a good change from a command that failed is kept');
  assert.equal(step(d, 'echo 90 > src/score.txt; exit 7').code, 1, 'and a bad one is put back');
  assert.equal(read(d, 'src/score.txt'), '110');
});
test('loop: the step prints one line on stdout whatever the attempt prints, so a driver can read it', () => {
  const d = toy();
  const r = step(d, 'echo chatter from the proposer; echo 110 > src/score.txt');
  assert.equal(r.out, ' 1  kept     echo: score 100 to 110\n');   // named by the command's first word (0.8.19)
  assert.match(r.err, /chatter from the proposer/, 'the attempt\'s own words go to stderr');
});
test('loop --json: the step prints its record line as JSON instead', () => {
  const d = toy();
  const kept = JSON.parse(step(d, 'echo 110 > src/score.txt', '--json', '--label', 'up').out);
  assert.deepEqual([kept.n, kept.label, kept.result, kept.why, kept.commit], [1, 'up', 'kept', 'score 100 to 110', head(d)]);
  const back = JSON.parse(step(d, 'echo 90 > src/score.txt', '--json').out);
  assert.deepEqual([back.n, back.result, back.verdict], [2, 'worse', 'fail']); assert.deepEqual(back, record(d)[1], 'the same line the record holds');
});
test('loop: it runs from a folder inside the repo, and the attempt runs at the top', () => {
  const d = toy();
  const r = run(join(d, 'src'), ['--attempt', 'echo 110 > src/score.txt']);
  assert.equal(r.code, 0, r.err); assert.equal(read(d, 'src/score.txt'), '110');
});

// ------------------------------------------------------------------ what it will not do to your work
test('loop: it refuses a tree with an uncommitted edit: nothing runs and the edit is left alone (exit 64)', () => {
  const d = toy(), base = head(d); put(d, 'src/cost.txt', '77\n');
  const r = step(d, `echo ran > ${d}.ran; echo 110 > src/score.txt`);
  assert.equal(r.code, 64); assert.match(r.err, /working tree is not clean/);
  assert.equal(state(d), '100 77', 'the edit is still there, and the attempt changed nothing'); assert.ok(!existsSync(`${d}.ran`), 'the attempt never ran');
  assert.equal(head(d), base); assert.equal(record(d).length, 0);
});
test('loop: it refuses a tree with an untracked file and leaves the file alone (exit 64)', () => {
  const d = toy(); put(d, 'notes-of-mine.txt', 'keep me\n');
  assert.equal(step(d, 'echo 90 > src/score.txt').code, 64);
  assert.equal(read(d, 'notes-of-mine.txt'), 'keep me'); assert.equal(read(d, 'src/score.txt'), '100');
});
test('loop: putting a change back leaves ignored files alone', () => {
  const d = toy(); put(d, 'ignored/mine.txt', 'keep me\n');   // .gitignore lists ignored/
  assert.equal(step(d, 'echo 90 > src/score.txt').code, 1);
  assert.equal(read(d, 'ignored/mine.txt'), 'keep me');
});
test('loop: outside a git repository it exits 64', () => {
  const d = mkdtempSync(join(TMP_ROOT, 'plain-'));
  const r = run(d, ['--attempt', 'true'], { GIT_CEILING_DIRECTORIES: TMP_ROOT });
  assert.equal(r.code, 64); assert.match(r.err, /not inside a git repository/);
});
test('loop: with no --attempt it exits 64 and says what it needs', () => {
  const r = run(toy(), ['--label', 'x']);
  assert.equal(r.code, 64); assert.match(r.err, /--attempt "<command that changes the repo>" is required/);
});
test('loop: a flag it does not know is exit 64, not a flag that is quietly dropped (a mistyped --floor would turn the floor off)', () => {
  const d = toy(), base = head(d);
  const r = step(d, `echo ran > ${d}.ran; echo 110 > src/score.txt`, '--flor');
  assert.equal(r.code, 64); assert.match(r.err, /unknown flag --flor/); assert.ok(!existsSync(`${d}.ran`), 'the attempt never ran'); assert.equal(head(d), base);
});
test('loop: a flag that needs a value and has none is exit 64', () => {
  const r = run(toy(), ['--attempt', 'true', '--target']);
  assert.equal(r.code, 64); assert.match(r.err, /--target needs a value/);
});
test('loop: in a repository with no commit yet it exits 64: there is nothing to put a change back to', () => {
  const d = mkdtempSync(join(TMP_ROOT, 'empty-')); git(d, 'init', '-q', '-b', 'main', '.');
  const r = step(d, 'echo x > file.txt');
  assert.equal(r.code, 64); assert.match(r.err, /no commit yet/); assert.ok(!existsSync(join(d, 'file.txt')), 'the attempt never ran');
});
test('loop: when git cannot make a commit (no name is set), the attempt is put back and the step exits 64', () => {
  const d = toy(), base = head(d);
  git(d, 'config', '--unset', 'user.name'); git(d, 'config', '--unset', 'user.email'); git(d, 'config', 'user.useConfigOnly', 'true');
  const r = run(d, ['--attempt', 'echo 110 > src/score.txt'], { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' });
  assert.equal(r.code, 64, r.out + r.err); assert.equal(r.out, '');
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop: it works on a detached HEAD, and keeps the win there', () => {
  const d = toy(), base = head(d); git(d, 'checkout', '-q', '--detach');
  assert.equal(step(d, 'echo 110 > src/score.txt').code, 0);
  assert.equal(git(d, 'rev-parse', 'HEAD^'), base); assert.equal(git(d, 'rev-parse', 'main'), base, 'main is not moved');
});
test('loop: a target the gate does not measure is exit 64, and the attempt is put back', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 110 > src/score.txt', '--target', 'speed');
  assert.equal(r.code, 64); assert.match(r.err, /no metric named "speed"/);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop --cheaper: a metric the gate does not measure is exit 64 too, not a flag that is quietly dropped', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 110 > src/score.txt', '--cheaper', 'tokens');
  assert.equal(r.code, 64, r.out + r.err); assert.match(r.err, /no metric named "tokens"/);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop: when the gate cannot be run, the attempt is put back and the step exits 64', () => {
  const d = toy(), base = head(d);
  const r = run(d, ['--attempt', 'echo 110 > src/score.txt'], { PROMPTWHEEL: `${process.execPath} ${join(TMP_ROOT, 'no-such-engine.mjs')}` });
  assert.equal(r.code, 64); assert.match(r.err, /could not read the gate's report/);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop: stopped in the middle of an attempt (Ctrl-C), it puts the attempt back, notes it, and exits 64', async () => {
  const d = toy(), base = head(d);
  // its own process group, so the signal reaches the step and the attempt together, as Ctrl-C in a terminal does
  const child = spawn(process.execPath, [RIG, '--attempt', 'echo 90 > src/score.txt; echo new > src/new.txt; sleep 30'], { cwd: d, env: ENV, detached: true, stdio: 'ignore' });
  const ended = new Promise((done) => child.on('exit', (code, signal) => done(code ?? signal)));
  for (let i = 0; i < 200 && !existsSync(join(d, 'src/new.txt')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(d, 'src/new.txt')), 'the attempt is under way');
  process.kill(-child.pid, 'SIGINT');
  assert.equal(await ended, 64, 'the step ends by itself with the code for "could not run", so a while loop stops');
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(!existsSync(join(d, 'src/new.txt'))); assert.ok(clean(d));
  assert.deepEqual(record(d).map((x) => x.result), ['stopped']);
  agree(d);
});
test('loop: an attempt that commits its own bad work is still judged, and the commit is taken back', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 90 > src/score.txt && git commit -qam "the proposer commits by itself"');
  assert.equal(r.code, 1, `judged worse, not waved through as a change to no file: ${r.out}${r.err}`);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop: an attempt that commits its own good work is kept as one commit made by the loop', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 110 > src/score.txt && git commit -qam "step one" && echo 120 > src/score.txt', '--label', 'two steps');
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /score 100 to 120/, 'the committed step and the uncommitted one are judged together');
  assert.equal(git(d, 'rev-list', '--count', 'HEAD'), '2'); assert.equal(git(d, 'rev-parse', 'HEAD^'), base);
  assert.equal(git(d, 'log', '-1', '--format=%s'), 'improve: two steps'); assert.ok(clean(d));
});
test('loop: an attempt that leaves the repo on another branch is not judged or kept (exit 64)', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'git checkout -q -b elsewhere && echo 110 > src/score.txt && git commit -qam "on another branch"');
  assert.equal(r.code, 64, r.out + r.err); assert.match(r.err, /another branch/);
  assert.equal(git(d, 'rev-parse', 'main'), base, 'main is where it was');
});
test('loop: an attempt that throws away earlier commits is put back to where the step began (exit 64)', () => {
  const d = toy();
  assert.equal(step(d, 'echo 110 > src/score.txt').code, 0);
  const kept = head(d);
  const r = step(d, 'git reset -q --hard HEAD~1');   // the proposer drops the win the loop kept
  assert.equal(r.code, 64, r.out + r.err);
  assert.equal(head(d), kept, 'the kept win is still there'); assert.equal(read(d, 'src/score.txt'), '110'); assert.ok(clean(d));
  assert.equal(record(d)[1].result, 'rewrote');
});

// ------------------------------------------------------------------ the record
// A second reader of the rule above (the same night it was written) found what it took too much of: a line that names
// no change took away whatever sat under its number, and the refs are shared by every worktree of a repo while each
// worktree keeps its own record and its own numbers. The step only takes away a ref that this run of it put there.
test('loop: a try in another worktree of the repo, one that changes nothing, leaves this worktree\'s kept change readable', () => {
  const d = toy(); assert.equal(step(d, GOOD).code, 0);
  const kept = git(d, 'rev-parse', 'refs/improve/1'), wt = `${d}-wt`;
  git(d, 'worktree', 'add', '-q', '-b', 'other', wt);
  // not through step(): `agree` holds one record to the refs, and a second worktree has a record of its own
  const r = spawnSync(process.execPath, [RIG, '--attempt', 'true'], { cwd: wt, encoding: 'utf8', env: ENV, timeout: 120000 });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(git(d, 'rev-parse', '--verify', '-q', 'refs/improve/1'), kept, 'a ref another record names is not this run\'s to take away');
});
test('loop: every attempt, kept or not, is on record with what the gate saw', () => {
  const d = toy();
  step(d, 'echo 110 > src/score.txt', '--label', 'a'); step(d, 'echo 90 > src/score.txt', '--label', 'b'); step(d, 'echo 50 > evals/bonus.txt', '--label', 'c'); step(d, 'true', '--label', 'd');
  const rec = record(d);
  assert.deepEqual(rec.map((x) => [x.n, x.label, x.result]), [[1, 'a', 'kept'], [2, 'b', 'worse'], [3, 'c', 'gamed'], [4, 'd', 'nothing']]);
  assert.equal(rec[0].commit, head(d)); assert.equal(rec[1].base, rec[0].commit, 'the second attempt started from the kept commit');
  assert.deepEqual(rec[1].files, ['src/score.txt']); assert.equal(rec[1].verdict, 'fail');
  // noise: the band the gate held the try to. One read and no band in the contract: 0
  assert.deepEqual(rec[1].metrics.find((m) => m.name === 'score'), { name: 'score', before: 110, after: 90, status: 'regressed', ok: false, noise: 0 });
  assert.equal(rec[2].metrics.find((m) => m.name === 'score').gamed, true);
  assert.ok(rec.every((x) => !Number.isNaN(Date.parse(x.at))));
});
test('loop: a change that was put back stays reachable under refs/improve', () => {
  const d = toy(), base = head(d);
  step(d, 'echo 90 > src/score.txt && echo try > src/new.txt');
  const ref = git(d, 'rev-parse', 'refs/improve/1');
  assert.equal(git(d, 'rev-parse', `${ref}^`), base); assert.equal(record(d)[0].candidate, ref);
  assert.equal(git(d, 'show', `${ref}:src/score.txt`), '90'); assert.equal(git(d, 'show', `${ref}:src/new.txt`), 'try');
});
test('loop: the record lives in the git folder, so it is in no commit and never makes the tree dirty', () => {
  const d = toy();
  step(d, 'echo 110 > src/score.txt'); step(d, 'echo 90 > src/score.txt');
  assert.ok(existsSync(join(d, '.git', 'improve', 'attempts.jsonl'))); assert.ok(clean(d));
  assert.equal(git(d, 'ls-files').split('\n').filter((f) => /improve|attempts/.test(f)).length, 0);
});
test('loop: the attempt is handed the record and the target, so a proposer can read what was already tried', () => {
  const d = toy(), seen = `${d}.seen`, peek = join(TMP_ROOT, 'peek.sh');
  writeFileSync(peek, 'n=0; [ -f "$IMPROVE_RECORD" ] && n=$(grep -c . "$IMPROVE_RECORD")\necho "$IMPROVE_TARGET $n $IMPROVE_RECORD" >> "$1"\necho 90 > src/score.txt\n');
  step(d, `sh ${peek} ${seen}`); step(d, `sh ${peek} ${seen}`);
  const file = join(git(d, 'rev-parse', '--absolute-git-dir'), 'improve', 'attempts.jsonl');
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), [`score 0 ${file}`, `score 1 ${file}`]);
});
test('loop: a label is kept as given, quotes and all, and with no label the name of a try is the first word of its command', () => {
  const d = toy();
  step(d, 'echo 90 > src/score.txt', '--label', 'try "plan B", it\'s the 2nd'); step(d, 'echo 91 > src/score.txt');
  assert.deepEqual(record(d).map((x) => x.label), ['try "plan B", it\'s the 2nd', 'echo']);
});
// The label is the kept commit's subject and a field of the record, and both are pushed with the repo. Until 0.8.19 the
// default label was the whole attempt command, so a prompt typed for an agent, or a key set in front of the command,
// landed there. The owner's call (2026-11-23): the first word, and only the program's name in it.
test('loop: with no label, nothing of the attempt command but its first word lands in the kept commit, the record or what is printed', () => {
  const said = 'please fix the billing export for ACME'; const key = 'sk-not-a-real-key-123';
  // the last four were found by a second reader: a word split inside quotes or inside $( ) put part of a value in the name
  for (const [attempt, name] of [[`API_KEY=${key} sh -c "echo 120 > src/score.txt # ${said}"`, 'sh'], [`"/bin/sh" -c "echo 120 > src/score.txt # ${said}"`, 'sh'], [`( echo 120 > src/score.txt ) # ${said}`, 'echo'],
    [`API_KEY='${key} part2' sh -c "echo 120 > src/score.txt"`, 'sh'], [`PROMPT="${said}" sh -c "echo 120 > src/score.txt"`, 'sh'],
    [`TOKEN=$(echo ${key}) sh -c "echo 120 > src/score.txt"`, 'sh'], [`X=\`echo ${key}\` sh -c "echo 120 > src/score.txt"`, 'sh']]) {
    const d = toy(); const r = step(d, attempt);
    assert.equal(r.code, 0, r.out + r.err); assert.deepEqual(record(d).map((x) => [x.label, x.result]), [[name, 'kept']], attempt);
    assert.equal(git(d, 'log', '-1', '--format=%s'), `improve: ${name}`);
    for (const where of [git(d, 'log', '-1', '--format=%B'), readFileSync(join(d, '.git', 'improve', 'attempts.jsonl'), 'utf8'), r.out, r.err]) { assert.ok(!where.includes(said), 'the words typed for the agent'); assert.ok(!where.includes(key), 'the key set in front of the command'); }
  }
});
test('loop: an attempt that deletes or rewrites the record does not erase what was tried', () => {
  const d = toy();
  step(d, 'echo 90 > src/score.txt', '--label', 'first');
  step(d, 'rm -f "$IMPROVE_RECORD"; echo 80 > src/score.txt', '--label', 'second');
  step(d, 'echo "{}" > "$IMPROVE_RECORD"; echo 70 > src/score.txt', '--label', 'third');
  assert.deepEqual(record(d).map((x) => [x.n, x.label]), [[1, 'first'], [2, 'second'], [3, 'third']]);
  assert.deepEqual([1, 2, 3].map((n) => git(d, 'show', `refs/improve/${n}:src/score.txt`)), ['90', '80', '70'], 'and each change is still under its own ref');
  assert.deepEqual(record(d).map((x) => x.recordPutBack === true), [false, true, true], 'the line says the record was put back');
});

// ------------------------------------------------------------------ --cheaper: the same score for less
test('loop --cheaper: a change that holds the score and lowers the cost is kept', () => {
  const d = toy();
  const r = step(d, 'echo 90 > src/cost.txt', '--cheaper', 'cost');
  assert.equal(r.code, 0); assert.match(r.out, /kept .*score held at 100, cost 100 to 90/); assert.equal(state(d), '100 90');
});
test('loop: without --cheaper the same change is not kept: nothing the loop was asked to raise went up', () => {
  const d = toy();
  assert.equal(step(d, 'echo 90 > src/cost.txt').code, 3); assert.equal(state(d), '100 100');
});
test('loop --cheaper: a change that holds the score and does not lower the cost is not kept', () => {
  const d = toy();
  assert.equal(step(d, 'echo more >> README.md', '--cheaper', 'cost').code, 3); assert.ok(clean(d));
});
test('loop --cheaper: a lower cost does not buy a score that fell', () => {
  const d = toy();
  assert.equal(step(d, trade(-20, -10), '--cheaper', 'cost').code, 1); assert.equal(state(d), '100 100');
});
test('loop --cheaper: with a band on the score, a move inside the band beside a lower cost is kept, and the line says so', () => {
  const d = banded();
  const r = step(d, trade(-5, -10), '--cheaper', 'cost');
  assert.equal(r.code, 0); assert.match(r.out, /score 100 to 95, inside its band, cost 100 to 90/);
});
test('loop --cheaper: a move outside the band is put back, lower cost or not', () => {
  const d = banded();
  assert.equal(step(d, trade(-11, -50), '--cheaper', 'cost').code, 1); assert.equal(state(d), '100 100');
});
test('loop --cheaper: a score gain the cost rule pays for is kept, and the line says it was paid for', () => {
  const d = toy({ cost: { budget: { gain: 'score', base: 0.10, rate: 0.01 } } });   // a gain of 10 allows a 20% rise
  const r = step(d, 'echo 110 > src/score.txt && echo 115 > src/cost.txt', '--cheaper', 'cost');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /score 100 to 110, cost 100 to 115 paid for/); assert.equal(state(d), '110 115');
});
test('loop --cheaper: a cost rise over what the rule allows is put back', () => {
  const d = toy({ cost: { budget: { gain: 'score', base: 0.10, rate: 0.01 } } });
  assert.equal(step(d, 'echo 110 > src/score.txt && echo 150 > src/cost.txt', '--cheaper', 'cost').code, 1); assert.equal(state(d), '100 100');
});

// ------------------------------------------------------------------ --floor: the downhill walk
test('loop: without --floor, small drops inside the band are each kept, and the score walks downhill', () => {
  const d = banded();
  assert.deepEqual(walk(d, 4, trade(-5, -10)), [0, 0, 0, 0]); assert.equal(state(d), '80 60', 'four passes, 20 points gone');
});
test('loop --floor: the same walk stops at the edge of the band', () => {
  const d = banded();
  assert.deepEqual(walk(d, 4, trade(-5, -10), '--floor'), [0, 0, 1, 1]); assert.equal(state(d), '90 80');
  assert.equal(record(d)[2].why, 'score was 100 at its best and is 85 now: under the floor'); assert.ok(clean(d));
});
test('loop --floor: a new best moves the floor up, and a kept change that scores under the best does not become the best', () => {
  const d = banded();
  assert.equal(step(d, 'echo 120 > src/score.txt', '--floor').code, 0);
  const top = head(d);
  assert.deepEqual(bestOf(d), { commit: top, score: 120 });
  assert.deepEqual(walk(d, 3, trade(-8, -10), '--floor'), [0, 1, 1], '112 is inside the band of 120, 104 is not');
  assert.equal(state(d), '112 90'); assert.deepEqual(bestOf(d), { commit: top, score: 120 }, 'the best is still the 120 commit');
});
test('loop --floor: on a target where lower is better, small rises inside the band are stopped the same way', () => {
  const d = toy({ score: { direction: 'down', noise: 10 } });   // read "score" as an error count here
  assert.deepEqual(walk(d, 4, trade(5, -10), '--floor'), [0, 0, 1, 1]); assert.equal(state(d), '110 80');
  assert.equal(record(d)[2].why, 'score was 100 at its best and is 115 now: under the floor');
});
test('loop --floor: a real gain on a lower-is-better target becomes the best', () => {
  const d = toy({ score: { direction: 'down', noise: 10 } });
  assert.equal(step(d, 'echo 70 > src/score.txt', '--floor').code, 0);
  assert.deepEqual(bestOf(d), { commit: head(d), score: 70 });
});
test('loop --floor: an attempt that deletes the floor file does not lower the floor', () => {
  const d = banded();
  assert.deepEqual(walk(d, 4, `${trade(-5, -10)} && rm -f .git/improve/best.json`, '--floor'), [0, 0, 1, 1]); assert.equal(state(d), '90 80');
});
test('loop --floor: an attempt that rewrites the floor file to name its own parent does not lower the floor', () => {
  const d = banded();
  const cheat = `${trade(-5, -10)} && printf '{"commit":"%s","score":0}' "$(git rev-parse HEAD)" > .git/improve/best.json`;
  assert.deepEqual(walk(d, 4, cheat, '--floor'), [0, 0, 1, 1]); assert.equal(state(d), '90 80');
  assert.equal(bestOf(d).score, 100, 'and the file is put back as it was');
});
test('loop --floor: a best commit that is gone stops the step (exit 64) and does not quietly start the floor again', () => {
  const d = banded();
  walk(d, 2, trade(-5, -10), '--floor');
  const base = head(d);
  writeFileSync(join(d, '.git', 'improve', 'best.json'), JSON.stringify({ commit: 'f'.repeat(40), score: 100 }) + '\n');
  const r = step(d, trade(-5, -10), '--cheaper', 'cost', '--floor');
  assert.equal(r.code, 64, r.out + r.err); assert.match(r.err, /best commit .* is gone/);
  assert.equal(head(d), base); assert.equal(state(d), '90 80'); assert.ok(clean(d));
});
test('loop --floor: a floor file that cannot be read stops the step (exit 64)', () => {
  const d = banded();
  walk(d, 2, trade(-5, -10), '--floor');
  const base = head(d);
  writeFileSync(join(d, '.git', 'improve', 'best.json'), 'not json\n');
  const r = step(d, trade(-5, -10), '--cheaper', 'cost', '--floor');
  assert.equal(r.code, 64, r.out + r.err); assert.match(r.err, /floor/);
  assert.equal(head(d), base); assert.equal(state(d), '90 80'); assert.ok(clean(d));
});
test('loop --floor: on the first step, before anything is kept, the parent is the best and the gate is asked once', () => {
  const d = banded();
  assert.equal(step(d, trade(-5, -10), '--cheaper', 'cost', '--floor').code, 0); assert.equal(asks(d), 2);
  assert.deepEqual(bestOf(d), { commit: git(d, 'rev-parse', 'HEAD^'), score: 100 }, 'the start stays the best: 95 is under it');
});
test('loop --floor: a win that also clears the floor is kept and becomes the best', () => {
  const d = banded();
  walk(d, 2, trade(-5, -10), '--floor');   // at 90, best 100
  assert.equal(step(d, 'echo 130 > src/score.txt', '--floor').code, 0);
  assert.deepEqual(bestOf(d), { commit: head(d), score: 130 });
});

// ------------------------------------------------------------------ what a step costs
test('loop: how often the scorer is asked: 2 a step, 2 more for the floor once the parent is not the best, fewer with --base-cache', () => {
  const plain = banded(); walk(plain, 4, trade(-5, -10));
  assert.equal(asks(plain), 8, 'no floor: base and head, four times');
  const floored = banded(); walk(floored, 4, trade(-5, -10), '--floor');
  assert.equal(asks(floored), 14, 'the first step asks once, the next three ask twice');
  const kept = banded(), cache = `${kept}.cache`; walk(kept, 4, trade(-5, -10), '--floor', '--base-cache', cache);
  assert.equal(asks(kept), 10, 'a base that was already measured is not measured again');
  assert.equal(state(kept), '90 80', 'and the answer is the same'); assert.ok(readdirSync(cache).length >= 2);
});
test('loop --base-cache: a folder inside the repo is refused by the gate: exit 64, the attempt put back', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'echo 110 > src/score.txt', '--base-cache', join(d, 'kept'));
  assert.equal(r.code, 64); assert.match(r.err, /outside the repository/);
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('loop --repeat: the count is handed to the gate', () => {
  const d = toy();
  assert.equal(step(d, 'echo 110 > src/score.txt', '--repeat', '3').code, 0); assert.equal(asks(d), 6, 'three readings a side');
});

// ------------------------------------------------------------------ the gate's own goalposts
test('loop: an attempt cannot widen the score\'s band for itself', () => {
  const d = banded(), base = head(d);
  const r = step(d, `node ${CFG} "c.metrics[0].noise = 1000" && ${trade(-50, -10)}`, '--cheaper', 'cost');
  assert.notEqual(r.code, 0, r.out); assert.equal(head(d), base); assert.equal(state(d), '100 100');
  assert.equal(JSON.parse(read(d, 'promptwheel.config.json')).metrics[0].noise, 10); assert.ok(clean(d));
});
test('loop: an attempt cannot switch a guard off for itself', () => {
  const d = toy(), base = head(d);
  const r = step(d, `node ${CFG} "c.metrics[0].guard = false" && ${trade(-50, -10)}`, '--cheaper', 'cost');
  assert.notEqual(r.code, 0, r.out); assert.equal(head(d), base); assert.equal(state(d), '100 100'); assert.ok(clean(d));
});
test('loop: an attempt cannot point the score at an easier command', () => {
  const d = toy(), base = head(d);
  const r = step(d, `node ${CFG} "c.metrics[0].cmd = 'echo 999'"`);
  assert.notEqual(r.code, 0, r.out); assert.equal(head(d), base); assert.ok(clean(d));
  assert.match(JSON.parse(read(d, 'promptwheel.config.json')).metrics[0].cmd, /bonus/);
});
test('loop: an attempt that deletes the gate\'s config is not kept', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'rm promptwheel.config.json && echo 110 > src/score.txt');
  assert.notEqual(r.code, 0, r.out); assert.equal(head(d), base); assert.ok(existsSync(join(d, 'promptwheel.config.json'))); assert.equal(state(d), '100 100');
});

// ------------------------------------------------------------------ what an attempt cannot slip past the gate
// Found on 2026-11-21 by holding the step to a list of attacks. Each of these got through before. The step judged the
// working tree and then committed whatever the tree held a moment later, and it kept its own files where an attempt
// could write them. Now the gate judges one commit and that commit is what is kept, and the loop's own files (the
// record, the floor, the kept refs, the base cache, the gate program and this step) are put back after every attempt.
const SAYS_YES = join(TMP_ROOT, 'says-yes.mjs');     // a gate that passes anything
writeFileSync(SAYS_YES, "console.log(JSON.stringify({ verdict: 'pass', metrics: [{ name: 'score', before: 100, after: 999, status: 'improved', ok: true, guard: true, direction: 'up' }, { name: 'cost', before: 100, after: 100, status: 'unchanged', ok: true, guard: true, direction: 'down' }] }));\n");
const KEEPS_ALL = join(TMP_ROOT, 'keeps-all.mjs');   // a step that keeps anything
writeFileSync(KEEPS_ALL, "import { execSync } from 'node:child_process';\ntry { execSync(process.argv[process.argv.indexOf('--attempt') + 1], { stdio: 'inherit' }); } catch { /* keep going */ }\ntry { execSync('git add -A && git commit -qm kept'); } catch { /* nothing to commit */ }\n");

test('loop: a git hook cannot add to a kept change: the commit holds the tree the gate judged, and no hook runs', () => {
  const d = toy(), hook = join(d, '.git', 'hooks', 'pre-commit');
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho 200 > src/cost.txt\\ngit add src/cost.txt\\n' > ${hook}; chmod +x ${hook}`);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(d, 'show', 'HEAD:src/cost.txt'), '100', 'the cost the gate judged, not the one the hook wrote');
  assert.equal(state(d), '110 100'); assert.ok(clean(d));
});
test('loop: what a process the attempt left running does after the gate looked is not kept: not an edit, not a new file', async () => {
  const d = toy({ cost: { cmd: 'sleep 0.3; cat src/cost.txt' } });   // a gate that takes a moment, as a real one does
  // the process waits for the scorer's second reading: by then the gate holds its own copy of the change
  const late = `( i=0; while [ $i -lt 500 ]; do n=$(cat ${d}.asked 2>/dev/null | wc -l); [ "$n" -ge 2 ] && break; sleep 0.01; i=$((i+1)); done; echo 200 > src/cost.txt; echo late > src/late.txt ) </dev/null >/dev/null 2>&1 &`;
  const r = step(d, `echo 110 > src/score.txt; ${late}`);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(d, 'show', 'HEAD:src/cost.txt'), '100', 'the kept commit holds the cost the gate judged');
  assert.equal(git(d, 'show', '--name-only', '--format=', 'HEAD'), 'src/score.txt');
  assert.equal(state(d), '110 100'); assert.ok(!existsSync(join(d, 'src/late.txt'))); assert.ok(clean(d), 'and the tree is the kept commit, nothing more');
});
test('loop: a file an attempt hides from git is brought back into view and judged (skip-worktree and assume-unchanged)', () => {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    const d = toy(), base = head(d);
    const r = step(d, `git update-index ${flag} src/cost.txt; echo 200 > src/cost.txt`);
    assert.equal(r.code, 1, `${flag}: ${r.out}${r.err}`); assert.match(r.out, / worse .*cost 100 to 200/);
    assert.equal(head(d), base); assert.equal(read(d, 'src/cost.txt'), '100'); assert.ok(clean(d));
    assert.match(git(d, 'ls-files', '-v', 'src/cost.txt'), /^H /, 'the file is no longer hidden');
    assert.equal(step(d, 'echo more >> README.md').code, 3, 'so the next try is not read as a win');
  }
});
test('loop: it refuses to start while an edited file is hidden from git, and says which (exit 64)', () => {
  const d = toy(); git(d, 'update-index', '--skip-worktree', 'src/cost.txt'); writeFileSync(join(d, 'src/cost.txt'), '200\n');
  const r = step(d, 'echo 110 > src/score.txt');
  assert.equal(r.code, 64); assert.match(r.err, /hidden from git[^\n]*src\/cost\.txt/);
  assert.equal(read(d, 'src/score.txt'), '100', 'the attempt did not run'); assert.equal(read(d, 'src/cost.txt'), '200', 'and your file is left alone');
});
test('loop: a hidden file that was not edited does not stop the step, and stays hidden', () => {
  const d = toy(); git(d, 'update-index', '--skip-worktree', 'README.md');
  assert.equal(step(d, 'echo 110 > src/score.txt').code, 0);
  assert.match(git(d, 'ls-files', '-v', 'README.md'), /^S /);
});
test('loop --base-cache: an attempt that edits the kept base number, or plants one, does not move the base', () => {
  const d = toy(), base = head(d), cache = `${d}.cache`;
  step(d, 'echo more >> README.md', '--base-cache', cache);
  const [file] = readdirSync(cache), kept = readFileSync(join(cache, file), 'utf8');
  assert.match(kept, /"score":\[100\]/);
  const r = step(d, `sed -i.bak 's/"score":\\[100\\]/"score":[50]/' ${cache}/*.json; echo planted > ${cache}/extra.json; echo 80 > src/score.txt`, '--base-cache', cache);
  assert.equal(r.code, 1, r.out + r.err); assert.match(r.out, / worse .*score 100 to 80/);
  assert.equal(head(d), base);
  assert.deepEqual(readdirSync(cache), [file], 'what the attempt added to the folder is gone'); assert.equal(readFileSync(join(cache, file), 'utf8'), kept);
  assert.deepEqual(record(d)[1].restored, ['base cache']);
});
test('loop: an attempt that rewrites the gate program is judged by the gate as it was', () => {
  const d = toy(), base = head(d), gate = join(d, 'ignored', 'gate');
  for (const part of ['bin', 'packs', 'package.json']) cpSync(join(ROOT, part), join(gate, part), { recursive: true });
  const engine = readFileSync(join(gate, 'bin', 'promptwheel.mjs'), 'utf8');
  const r = run(d, ['--attempt', `cp ${SAYS_YES} ignored/gate/bin/promptwheel.mjs; echo 120 > src/cost.txt`], { PROMPTWHEEL: `${process.execPath} ignored/gate/bin/promptwheel.mjs` });
  assert.equal(r.code, 1, r.out + r.err); assert.equal(head(d), base); assert.equal(read(d, 'src/cost.txt'), '100');
  assert.equal(readFileSync(join(gate, 'bin', 'promptwheel.mjs'), 'utf8'), engine, 'the gate program is put back');
  assert.deepEqual(record(d)[0].restored, ['gate']);
});
test('loop: an attempt that rewrites the loop step itself (copied into the repo) does not get the next change kept by its own step', () => {
  const d = toy(); put(d, 'tools/improve.mjs', readFileSync(RIG, 'utf8')); chmodSync(join(d, 'tools/improve.mjs'), 0o755); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'the step, copied in');
  const own = (attempt) => spawnSync(process.execPath, ['tools/improve.mjs', '--attempt', attempt], { cwd: d, encoding: 'utf8', env: { ...ENV, PROMPTWHEEL: `${process.execPath} ${join(ROOT, 'bin', 'promptwheel.mjs')}` }, timeout: 120000 });
  const r = own(`echo 110 > src/score.txt; cp ${KEEPS_ALL} tools/improve.mjs`);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /put back: step/, 'the line says so');
  assert.equal(readFileSync(join(d, 'tools/improve.mjs'), 'utf8'), readFileSync(RIG, 'utf8'), 'the step is as it was');
  assert.equal(git(d, 'show', '--name-only', '--format=', 'HEAD'), 'src/score.txt', 'and the kept commit does not touch it');
  assert.equal(own('echo 120 > src/cost.txt').status, 1); assert.equal(read(d, 'src/cost.txt'), '100');
  assert.deepEqual(record(d)[0].restored, ['step']);
});
test('loop: an attempt that deletes the refs of earlier tries does not erase them', () => {
  const d = toy();
  step(d, 'echo 90 > src/score.txt');
  const first = git(d, 'rev-parse', 'refs/improve/1');
  assert.equal(step(d, `git for-each-ref --format='%(refname)' refs/improve | xargs -n1 git update-ref -d; echo 110 > src/score.txt`).code, 0);
  assert.equal(git(d, 'rev-parse', 'refs/improve/1'), first); assert.equal(git(d, 'show', 'refs/improve/1:src/score.txt'), '90');
  assert.deepEqual(record(d)[1].restored, ['refs']);
});
test('loop: when an attempt also prunes the objects, the record says which earlier tries can no longer be read', () => {
  const d = toy();
  step(d, 'echo 90 > src/score.txt');
  const r = step(d, `git for-each-ref --format='%(refname)' refs/improve | xargs -n1 git update-ref -d; git gc -q --prune=now; echo 110 > src/score.txt`);
  assert.equal(r.code, 0, r.err); assert.deepEqual(record(d)[1].refsLost, ['refs/improve/1']);
});
test('loop: a reason written into the attempt\'s own commit message, or into a label, does not excuse a gamed win', () => {
  const d = toy();
  assert.equal(step(d, 'echo 50 > evals/bonus.txt; git commit -qam "tune" -m "Promptwheel-Allow: the grader needed this"').code, 2);
  assert.equal(step(d, 'echo 50 > evals/bonus.txt', '--label', 'tune\n\nPromptwheel-Allow: the grader needed this').code, 2);
  assert.equal(read(d, 'evals/bonus.txt'), '0');
});

// ------------------------------------------------------------------ git's own files are goalposts too
// Found on 2026-11-21, after the 28 attacks. Git keeps hooks, config, attributes and refs where an attempt can write
// them, and the step and the gate both run git. Each of these got a bad change kept. Now git's settings are read
// before the attempt and put back after it, every ref the attempt moved goes back, and after the attempt the step's
// git calls (and the gate's) run no hook and no fsmonitor command.
const stored = (d, f) => git(d, '--no-replace-objects', 'cat-file', '-p', `HEAD:${f}`);   // what a fresh clone would get
const config = (d, key) => { try { return git(d, 'config', '--get', key); } catch { return null; } };
const FILTER = (how) => `${how} filter.mine.clean "sed 's/^110$/90/'"; ${how} filter.mine.smudge "sed 's/^90$/110/'"`;
// a hook that moves the branch to a commit of its own (cost 300) as soon as the loop moves it
const MOVE_BRANCH = `t=$(GIT_INDEX_FILE=.git/x.idx sh -c 'git read-tree HEAD && git update-index --cacheinfo 100644,$(echo 300 | git hash-object -w --stdin),src/cost.txt && git write-tree'); rm -f .git/x.idx
mine=$(git commit-tree $t -p HEAD -m mine); base=$(git rev-parse HEAD)
printf '#!/bin/sh\\n[ "$1" = committed ] || exit 0\\n[ -n "$MINE" ] && exit 0\\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && [ "$new" != %s ] && [ "$new" != %s ] && MINE=1 git update-ref refs/heads/main %s; done\\nexit 0\\n' $base $mine $mine`;
const tracksHooks = (body) => {   // a repo that keeps its hooks in a tracked folder, as husky does
  const d = toy(); put(d, 'hooks/reference-transaction', body); chmodSync(join(d, 'hooks/reference-transaction'), 0o755);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'hooks in a tracked folder'); git(d, 'config', 'core.hooksPath', 'hooks');
  return d;
};

test('loop: a hook an attempt plants cannot move the branch after the keep, and the hook is gone afterwards', () => {
  const d = toy();
  const r = step(d, `echo 110 > src/score.txt\n${MOVE_BRANCH} > .git/hooks/reference-transaction; chmod +x .git/hooks/reference-transaction`, '--label', 'plants a hook');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(d, 'show', 'HEAD:src/cost.txt'), '100', 'the branch holds the commit the gate judged'); assert.equal(state(d), '110 100'); assert.ok(clean(d));
  assert.ok(!existsSync(join(d, '.git/hooks/reference-transaction')), 'the planted hook is removed');
  assert.ok(record(d)[0].restored.includes('git hooks'), 'and the record says the attempt had touched the hooks');
});
test('loop: a hook that was there before the attempt stays, and an edit to it is undone, mode and all', () => {
  const d = toy(), f = join(d, '.git/hooks/pre-push'); put(d, '.git/hooks/pre-push', '#!/bin/sh\nexit 0\n'); chmodSync(f, 0o755);
  const r = step(d, 'echo 110 > src/score.txt; echo "echo mine" >> .git/hooks/pre-push; chmod -x .git/hooks/pre-push');
  assert.equal(r.code, 0, r.err); assert.equal(readFileSync(f, 'utf8'), '#!/bin/sh\nexit 0\n'); assert.ok(statSync(f).mode & 0o100, 'and it can still be run');
});
test('loop: no hook runs inside the step after the attempt, not even one in a hooks folder the repo tracks', () => {
  const d = tracksHooks('#!/bin/sh\nexit 0\n'), ran = `${d}.ran`;
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho x >> ${ran}\\n' > hooks/reference-transaction`, '--label', 'edits a tracked hook');
  assert.equal(r.code, 0, r.err); assert.ok(!existsSync(ran), 'the edited hook never ran, though the step moved refs while it was in the tree');
  const moved = tracksHooks('#!/bin/sh\nexit 0\n');
  const m = step(moved, `echo 110 > src/score.txt\n${MOVE_BRANCH} > hooks/reference-transaction`, '--label', 'a tracked hook that moves the branch');
  assert.equal(m.code, 0, m.err); assert.equal(git(moved, 'show', 'HEAD:src/cost.txt'), '100', 'and one that would move the branch after a keep does not get to');
});
test('loop: a filter set in the repo\'s git config is gone before the change is judged: what is kept is what was measured', () => {
  const d = toy();
  const r = step(d, `${FILTER('git config')}; echo 'src/score.txt filter=mine' >> .git/info/attributes; echo 110 > src/score.txt`);
  assert.equal(r.code, 0, r.err);
  assert.equal(stored(d, 'src/score.txt'), '110', 'the commit holds the 110 the gate measured, not the 90 the filter would have stored');
  assert.equal(config(d, 'filter.mine.clean'), null); assert.ok(!existsSync(join(d, '.git/info/attributes')), 'the attributes file it made is removed');
  assert.deepEqual(record(d)[0].restored, ['git settings']);
});
test('loop: an edit to .git/info/exclude is undone, so a new file cannot be hidden from the change', () => {
  const d = toy(), before = readFileSync(join(d, '.git/info/exclude'), 'utf8');
  const r = step(d, 'echo 110 > src/score.txt; echo "src/extra.txt" >> .git/info/exclude; echo 1 > src/extra.txt');
  assert.equal(r.code, 0, r.err); assert.equal(readFileSync(join(d, '.git/info/exclude'), 'utf8'), before);
  assert.equal(git(d, 'show', 'HEAD:src/extra.txt'), '1', 'the file is in the kept commit, where it can be seen'); assert.ok(clean(d));
});
test('loop: a replace ref an attempt adds is removed before the gate looks, so the worse cost is seen', () => {
  const d = toy();
  const r = step(d, 'echo 110 > src/score.txt; echo 120 > src/cost.txt; git replace $(git hash-object -w src/cost.txt) $(git rev-parse HEAD:src/cost.txt)');
  assert.equal(r.code, 1, r.err); assert.match(r.out, / worse .*cost 100 to 120/);
  assert.equal(git(d, 'for-each-ref', 'refs/replace'), ''); assert.equal(stored(d, 'src/cost.txt'), '100'); assert.ok(record(d)[0].restored.includes('refs'));
});
test('loop: a tag or a branch an attempt makes is removed, and one it moves or deletes is put back', () => {
  const d = toy(); git(d, 'tag', 'v1'); git(d, 'branch', 'keep');
  const v1 = git(d, 'rev-parse', 'v1');
  const r = step(d, 'echo 110 > src/score.txt; git commit -qam mine; git tag -f v1; git tag new; git branch side; git branch -D keep');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(d, 'rev-parse', 'v1'), v1, 'the tag points where it did'); assert.equal(git(d, 'rev-parse', 'keep'), v1);
  assert.equal(git(d, 'for-each-ref', '--format=%(refname)', 'refs/tags/new', 'refs/heads/side'), '');
});
test('loop: a branch the attempt made and left the repo on is not removed: the step refuses, and the branch is there to look at', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'git checkout -q -b elsewhere && echo 110 > src/score.txt && git commit -qam mine; git branch other');
  assert.equal(r.code, 64); assert.match(r.err, /another branch/);
  assert.equal(git(d, 'symbolic-ref', 'HEAD'), 'refs/heads/elsewhere'); assert.equal(git(d, 'show', 'HEAD:src/score.txt'), '110', 'the branch it is on still holds its commit');
  assert.equal(git(d, 'rev-parse', 'main'), base); assert.equal(git(d, 'for-each-ref', '--format=%(refname)', 'refs/heads/other'), '', 'a branch it only made on the side is removed');
});
test('loop: core.fsmonitor set by an attempt never runs its command, in this step or the next', () => {
  const d = toy(), ran = `${d}.ran`;
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho x >> ${ran}\\n' > .git/mine.sh; chmod +x .git/mine.sh; git config core.fsmonitor .git/mine.sh`);
  assert.equal(r.code, 0, r.err); step(d, 'echo more >> README.md');
  assert.ok(!existsSync(ran), 'its command never ran'); assert.equal(config(d, 'core.fsmonitor'), null);
});
test('loop: an fsmonitor command the repo already had, kept as a tracked file, is not run by the step once an attempt has edited it', () => {
  const d = toy(), ran = `${d}.ran`; put(d, 'tools/fsm.sh', '#!/bin/sh\nexit 1\n'); chmodSync(join(d, 'tools/fsm.sh'), 0o755);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'an fsmonitor script'); git(d, 'config', 'core.fsmonitor', 'tools/fsm.sh');
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho x >> ${ran}\\nexit 1\\n' > tools/fsm.sh`, '--label', 'edits the fsmonitor script');
  assert.equal(r.code, 0, r.err); assert.ok(!existsSync(ran), 'the edited script never ran inside the step');
});
test('loop: a filter set in the global git config is undone too, and the line names the file in your home folder', () => {
  const d = toy(); writeFileSync(join(HOME, '.gitconfig'), '[alias]\n\tst = status\n');
  try {
    const r = step(d, `${FILTER('git config --global')}; git config --global core.attributesFile "$HOME/.mine-attributes"; echo 'src/score.txt filter=mine' > "$HOME/.mine-attributes"; mkdir -p "$XDG_CONFIG_HOME/git"; echo 'src/score.txt filter=mine' > "$XDG_CONFIG_HOME/git/attributes"; echo 110 > src/score.txt`, '--label', 'edits the global config');
    assert.equal(r.code, 0, r.err);
    assert.equal(stored(d, 'src/score.txt'), '110', 'the commit holds what the gate measured');
    assert.equal(readFileSync(join(HOME, '.gitconfig'), 'utf8'), '[alias]\n\tst = status\n', 'your global config is as it was');
    assert.ok(!existsSync(join(HOME, '.config/git/attributes')), 'a global attributes file it made is removed');
    assert.ok(r.out.includes(`your git settings (${join(HOME, '.gitconfig')})`), r.out);
  } finally { for (const f of ['.gitconfig', '.mine-attributes']) rmSync(join(HOME, f), { force: true }); }
});
test('loop: a global config that did not exist before the attempt is removed again', () => {
  const d = toy(); assert.ok(!existsSync(join(HOME, '.gitconfig')));
  const r = step(d, 'git config --global core.fsmonitor /bin/true; echo 110 > src/score.txt');
  assert.equal(r.code, 0, r.err); assert.ok(!existsSync(join(HOME, '.gitconfig')));
});
test('loop: a global config that is a link into a dotfiles folder is put back through the link, and stays a link', () => {
  const d = toy(), dot = join(HOME, 'dotfiles'); mkdirSync(dot, { recursive: true });
  writeFileSync(join(dot, 'gitconfig'), '[alias]\n\tst = status\n'); symlinkSync(join(dot, 'gitconfig'), join(HOME, '.gitconfig'));
  try {
    assert.equal(step(d, 'git config --global core.fsmonitor /bin/true; echo 110 > src/score.txt').code, 0);
    assert.ok(lstatSync(join(HOME, '.gitconfig')).isSymbolicLink()); assert.equal(readFileSync(join(dot, 'gitconfig'), 'utf8'), '[alias]\n\tst = status\n');
    // and when the attempt swaps the link for a file of its own, the link comes back
    assert.equal(step(d, `rm "$HOME/.gitconfig"; printf '[core]\\n\\tfsmonitor = /bin/true\\n' > "$HOME/.gitconfig"; echo 120 > src/score.txt`).code, 0);
    assert.equal(readlinkSync(join(HOME, '.gitconfig')), join(dot, 'gitconfig')); assert.equal(readFileSync(join(dot, 'gitconfig'), 'utf8'), '[alias]\n\tst = status\n');
  } finally { rmSync(join(HOME, '.gitconfig'), { force: true }); rmSync(dot, { recursive: true, force: true }); }
});
test('loop: a global config that is not a plain file (/dev/null) is left alone, and the step runs as ever', () => {
  const d = toy(), r = run(d, ['--attempt', 'echo 110 > src/score.txt'], { GIT_CONFIG_GLOBAL: '/dev/null' });
  assert.equal(r.code, 0, r.err); assert.ok(statSync('/dev/null').isCharacterDevice()); assert.equal(record(d)[0].restored, undefined);
});
test('loop: an attempt that touches none of git\'s files leaves no mark in the record', () => {
  const d = toy(); put(d, '.git/hooks/pre-push', '#!/bin/sh\nexit 0\n'); git(d, 'tag', 'v1');
  step(d, 'echo 110 > src/score.txt');
  assert.equal(record(d)[0].restored, undefined); assert.equal(record(d)[0].recordPutBack, undefined);
});

// ------------------------------------------------------------------ the loop as a whole
test('loop: `while improve; do :; done` stops by itself when the proposer runs out of wins', () => {
  const d = toy(), tries = `${d}.tries`, proposer = join(TMP_ROOT, 'three-wins.sh');
  writeFileSync(proposer, `n=$(cat "$1" 2>/dev/null || echo 0); n=$(( n + 1 )); echo $n > "$1"\n[ $n -le 3 ] && sh ${BUMP} src/score.txt 1\ntrue\n`);
  const r = spawnSync('bash', ['-c', `while "${process.execPath}" "${RIG}" --attempt "sh ${proposer} ${tries}"; do :; done`], { cwd: d, encoding: 'utf8', env: ENV, timeout: 120000 });
  assert.equal(r.signal, null, 'the loop ended by itself');
  assert.equal(readFileSync(tries, 'utf8').trim(), '4', 'three wins, and the empty try that ended it');
  assert.deepEqual(record(d).map((x) => x.result), ['kept', 'kept', 'kept', 'nothing']);
  assert.equal(read(d, 'src/score.txt'), '103'); assert.equal(git(d, 'rev-list', '--count', 'HEAD'), '4'); assert.ok(clean(d));
});
test('loop: a run of mixed attempts ends with only the honest changes on the branch', () => {
  const d = toy();
  const codes = [['echo 110 > src/score.txt'], ['echo 50 > evals/bonus.txt'], ['echo 90 > src/score.txt'], ['echo more >> README.md'], ['echo 90 > src/cost.txt', '--cheaper', 'cost'], ['true']].map(([a, ...f]) => step(d, a, ...f).code);
  assert.deepEqual(codes, [0, 2, 1, 3, 0, 3]);
  assert.equal(state(d), '110 90'); assert.equal(read(d, 'evals/bonus.txt'), '0'); assert.equal(read(d, 'README.md'), 'toy');
  assert.equal(git(d, 'rev-list', '--count', 'HEAD'), '3', 'the start and the two kept changes');
  assert.equal(git(d, 'for-each-ref', 'refs/improve').split('\n').length, 5, 'all five changes are still reachable'); assert.ok(clean(d));
});
test('loop: the demo script shows the walk without a floor, the stop with one, and what --base-cache saves', () => {
  const r = spawnSync('bash', [join(ROOT, 'examples', 'improve-loop', 'run-demo.sh')], { encoding: 'utf8', env: ENV, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.includes('ends at')).map((l) => l.trim()), [
    'ends at: score 80, cost 60. The scorer was asked 8 times.',
    'ends at: score 90, cost 80. The scorer was asked 14 times.',
    'ends at: score 90, cost 80. The scorer was asked 10 times.',
  ]);
});

// ------------------------------------------------------------------ from treegate's step: what may change, and what a try cost
// The other session's copy of this step (treegate/step.mjs on wavecutter) added two things: --may-change and a count
// of gate asks. On 2026-11-21 the owner chose one keeper, so they are in this file now, with treegate's own tests for
// them, carried over as they are (its test/step.test.mjs).
const at = (d, f, ref = 'HEAD') => { try { return git(d, 'show', `${ref}:${f}`); } catch { return null; } };   // a file as a commit holds it
const bump = (file, by) => `sh ${BUMP} ${file} ${by}`;
const asked = asks;
const GOOD = 'echo 110 > src/score.txt';
const rules = () => toy({ files: { 'rules/safety.md': 'never send the key\nask before a refund\n', 'docs/guide.md': 'how\n' } });
test('may-change: a win inside the list is kept', () => {
  const d = toy(), r = step(d, GOOD, '--may-change', 'src/**');
  assert.equal(r.code, 0, r.err); assert.match(r.out, / kept /);
  assert.equal(at(d, 'src/score.txt'), '110'); assert.ok(clean(d));
});
test('may-change: a win that also edits a file outside the list is put back whole, exit 1, and the line names the file', () => {
  const d = toy(), base = head(d);
  const r = step(d, `${GOOD}; echo more >> README.md`, '--may-change', 'src/**');
  assert.equal(r.code, 1, r.err); assert.match(r.out, /^ 1 {2}outside .*README\.md/);
  assert.equal(head(d), base, 'nothing is kept, not even the part inside the list');
  assert.equal(read(d, 'src/score.txt'), '100'); assert.equal(read(d, 'README.md'), 'toy'); assert.ok(clean(d));
});
test('may-change: without the flag the same change is kept, so the test above can tell the difference', () => {
  const d = toy(), r = step(d, `${GOOD}; echo more >> README.md`);
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'README.md'), 'toy\nmore');
});
test('may-change: the try is on record as outside, with the files it changed, and stays reachable', () => {
  const d = toy(); step(d, `${GOOD}; echo more >> README.md`, '--may-change', 'src/**');
  const [line] = record(d);
  assert.equal(line.result, 'outside'); assert.deepEqual(line.files, ['README.md', 'src/score.txt']); assert.deepEqual(line.outside, ['README.md']);
  assert.equal(git(d, 'rev-parse', 'refs/improve/1'), line.candidate);
  assert.equal(at(d, 'src/score.txt', 'refs/improve/1'), '110', 'the whole try can still be read');
});
test('may-change: the gate is not asked about a try that is outside the list', () => {
  const d = toy(); step(d, `${GOOD}; echo more >> README.md`, '--may-change', 'src/**');
  assert.equal(asked(d), 0, 'the scorer was never run');
});
test('may-change: a new file outside the list is outside', () => {
  const d = toy(), r = step(d, `${GOOD}; echo x > notes.txt`, '--may-change', 'src/**');
  assert.equal(r.code, 1); assert.match(r.out, /outside .*notes\.txt/); assert.ok(!existsSync(join(d, 'notes.txt'))); assert.ok(clean(d));
});
test('may-change: a deleted file outside the list is outside, and the file is back', () => {
  const d = rules(), r = step(d, `${GOOD}; rm rules/safety.md`, '--may-change', 'src/**');
  assert.equal(r.code, 1); assert.match(r.out, /outside .*rules\/safety\.md/);
  assert.equal(read(d, 'rules/safety.md'), 'never send the key\nask before a refund');
});
test('may-change: a file moved out of a place it may not touch counts at both ends', () => {
  const d = rules(), r = step(d, `${GOOD}; git mv rules/safety.md src/safety.md`, '--may-change', 'src/**');
  assert.equal(r.code, 1); assert.match(r.out, /outside .*rules\/safety\.md/);
  assert.equal(read(d, 'rules/safety.md'), 'never send the key\nask before a refund'); assert.ok(!existsSync(join(d, 'src/safety.md')));
});
test('may-change: a safety rule that a second rule still covers cannot be deleted for a saving when the rules are not in the list', () => {
  // attack 27 of the attack list (masked erosion): the score holds, the cost falls, and no number shows the loss
  const d = rules(), cut = `sed -i.bak '$d' rules/safety.md && rm -f rules/safety.md.bak && ${bump('src/cost.txt', -10)}`;
  const r = step(d, cut, '--cheaper', 'cost', '--may-change', 'src/**');
  assert.equal(r.code, 1, r.err); assert.equal(at(d, 'rules/safety.md'), 'never send the key\nask before a refund');
  const open = rules(); assert.equal(step(open, cut, '--cheaper', 'cost').code, 0, 'and without the list the deletion is kept as a saving');
});
test('may-change: several patterns, with commas between them', () => {
  const d = rules();
  assert.equal(step(d, `${GOOD}; echo more >> docs/guide.md`, '--may-change', 'src/**, docs/*.md').code, 0);
  assert.equal(step(d, 'echo 120 > src/score.txt; echo more >> README.md', '--may-change', 'src/**, docs/*.md').code, 1);
});
test('may-change: patterns read as they do in the gate: a bare name at any depth, * stops at a slash, ** crosses it', () => {
  assert.equal(step(toy(), GOOD, '--may-change', 'score.txt').code, 0, 'a bare name matches that file at any depth');
  assert.equal(step(toy(), GOOD, '--may-change', '*/score.txt').code, 0);
  assert.equal(step(toy({ files: { 'src/deep/a.txt': 'a\n' } }), `${GOOD}; echo b > src/deep/a.txt`, '--may-change', 'src/*').code, 1, '* does not reach into a folder');
  assert.equal(step(toy({ files: { 'src/deep/a.txt': 'a\n' } }), `${GOOD}; echo b > src/deep/a.txt`, '--may-change', 'src/**').code, 0);
  assert.equal(step(toy(), GOOD, '--may-change', 'sr').code, 1, 'half a name matches nothing');
});
test('may-change: an empty list is exit 64, not a list that allows everything', () => {
  const d = toy(), base = head(d);
  for (const list of ['', ' , ']) {
    const r = step(d, GOOD, '--may-change', list);
    assert.equal(r.code, 64); assert.match(r.err, /may-change/);
  }
  assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100', 'the attempt never ran');
});
test('may-change: a gamed win outside the list reads outside, and the grader file is back', () => {
  const d = toy(), r = step(d, 'echo 50 > evals/bonus.txt', '--may-change', 'src/**');
  assert.equal(r.code, 1); assert.match(r.out, /outside .*evals\/bonus\.txt/); assert.equal(read(d, 'evals/bonus.txt'), '0');
});
test('may-change: an attempt that commits its own work is held to the list all the same', () => {
  const d = toy(), base = head(d);
  const r = step(d, `${GOOD}; echo more >> README.md; git commit -qam mine`, '--may-change', 'src/**');
  assert.equal(r.code, 1, r.err); assert.equal(head(d), base); assert.equal(read(d, 'README.md'), 'toy');
});
test('may-change: a file hidden from git is shown again and held to the list', () => {
  const d = toy(), r = step(d, `${GOOD}; git update-index --skip-worktree README.md; echo hidden >> README.md`, '--may-change', 'src/**');
  assert.equal(r.code, 1, r.err); assert.match(r.out, /outside .*README\.md/); assert.equal(read(d, 'README.md'), 'toy'); assert.ok(clean(d));
});
test('may-change: a name with a space or an accent is read as it is, inside the list and outside it', () => {
  const inside = toy(); assert.equal(step(inside, `${GOOD}; echo x > 'src/café notes.txt'`, '--may-change', 'src/**').code, 0);
  assert.equal(at(inside, 'src/café notes.txt'), 'x');
  const out = toy(), r = step(out, `${GOOD}; echo x > 'café notes.txt'`, '--may-change', 'src/**');
  assert.equal(r.code, 1); assert.deepEqual(record(out)[0].outside, ['café notes.txt']);
});
test('may-change: the line names a few files and counts the rest', () => {
  const d = toy(), many = Array.from({ length: 8 }, (_, i) => `echo x > extra${i}.txt`).join('; ');
  const r = step(d, `${GOOD}; ${many}`, '--may-change', 'src/**');
  assert.match(r.out, /outside .*extra0\.txt.* and 5 more/); assert.equal(record(d)[0].outside.length, 8, 'the record holds them all');
});
test('asks: the record says how often the gate was asked in a try: once, or twice when the floor was checked too', () => {
  const d = toy({ score: { noise: 10 } }), trade = `${bump('src/score.txt', -5)} && ${bump('src/cost.txt', -10)}`;
  for (let i = 0; i < 3; i++) step(d, trade, '--cheaper', 'cost', '--floor');
  step(d, 'true', '--floor');
  assert.deepEqual(record(d).map((l) => [l.result, l.asks]), [['kept', 1], ['kept', 2], ['worse', 2], ['nothing', undefined]]);
});
test('asks: a try the gate was never asked about has no count', () => {
  const d = toy(); step(d, `${GOOD}; echo more >> README.md`, '--may-change', 'src/**');
  assert.equal(record(d)[0].asks, undefined);
});

// ------------------------------------------------------------------ one keeper: what moved in from the engine's own command
// On 2026-11-21 the owner chose one keeper: this step. The engine had grown a command of its own the same day
// (`promptwheel improve`, with --turns, the contract rule and a mark for a run that dies). Those parts are here now,
// and `promptwheel improve` runs this file. Each test below was seen failing on the step as it was before they moved.
const open = () => toy({ top: { evaluatorPaths: ['evals/bonus.txt'] } });   // the config itself is not an evaluator path here
const addMeasure = `node ${CFG} "c.metrics.push({ name: 'notes', cmd: 'echo 1', extract: 'number', direction: 'up' })"`;
test('contract: a win that also edits the contract is put back whole, exit 1, and the line says the contract changed', () => {
  const d = open(), base = head(d), before = read(d, 'promptwheel.config.json');
  const r = step(d, `${GOOD}; ${addMeasure}`);
  assert.equal(r.code, 1, r.err); assert.match(r.out, /^ 1 {2}contract .*promptwheel\.config\.json/);
  assert.equal(head(d), base); assert.equal(read(d, 'promptwheel.config.json'), before); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
  assert.equal(record(d)[0].result, 'contract');
  assert.equal(step(open(), GOOD).code, 0, 'the same win without the contract edit is kept, so the test can tell the difference');
});
test('contract: a file inside the repo that the contract extends is the contract too', () => {
  const d = toy({ top: { evaluatorPaths: ['evals/bonus.txt'], extends: './more.json' }, files: { 'more.json': '{}\n' } });
  const r = step(d, `${GOOD}; printf '{ }\\n' > more.json`);
  assert.equal(r.code, 1, r.err); assert.match(r.out, /contract .*more\.json/); assert.equal(read(d, 'more.json'), '{}');
});
test('contract: a change the gate already sends back keeps the gate\'s result', () => {
  const r = step(toy(), `${GOOD}; ${addMeasure}`);   // here the config is an evaluator path: an edit beside a win is gamed
  assert.equal(r.code, 2, r.err); assert.match(r.out, / gamed /);
});
test('mark: a run killed outright leaves its mark, the next run names the commit it started from, and a clean tree clears it', async () => {
  const d = toy(), base = head(d), mark = join(d, '.git', 'improve', 'running.json');
  const child = spawn(process.execPath, [RIG, '--attempt', `echo 110 > src/score.txt; touch ${d}.started; sleep 30`], { cwd: d, env: ENV, stdio: 'ignore' });
  for (let i = 0; i < 200 && !existsSync(`${d}.started`); i++) await new Promise((res) => setTimeout(res, 50));
  child.kill('SIGKILL'); await new Promise((res) => child.on('exit', res));
  assert.ok(existsSync(mark), 'the killed run left its mark');
  let r = step(d, GOOD);
  assert.equal(r.code, 64); assert.match(r.err, new RegExp(`started at ${base.slice(0, 12)} did not finish`)); assert.match(r.err, new RegExp(`git reset --hard ${base}`));
  git(d, 'reset', '-q', '--hard', base); git(d, 'clean', '-qfd');
  r = step(d, GOOD); assert.equal(r.code, 0, r.err); assert.ok(!existsSync(mark), 'once the tree is clean the old mark goes, and a finished run leaves none');
  agree(d);
});
test('mark: a second run in the same repo while the first is going is refused', () => {
  const d = toy(); mkdirSync(join(d, '.git', 'improve'), { recursive: true });
  writeFileSync(join(d, '.git', 'improve', 'running.json'), JSON.stringify({ start: head(d), pid: process.pid, at: new Date().toISOString() }) + '\n');
  const r = step(d, GOOD); assert.equal(r.code, 64); assert.match(r.err, new RegExp(`another run of the loop is going in this repo \\(process ${process.pid}\\)`));
  assert.equal(read(d, 'src/score.txt'), '100', 'the attempt never ran');
});
// an attempt that does something different at each turn: case on PW_TURN
const byTurn = (...cases) => `case "$PW_TURN" in ${cases.map((c, i) => `${i + 1}) ${c};;`).join(' ')} esac`;
test('turns: a change that needs a level step first is kept: each turn goes on from the last, and the whole change is judged against the start', () => {
  const d = toy(), base = head(d);
  const attempt = byTurn('echo helper > src/helper.txt', 'echo 110 > src/score.txt');
  assert.equal(step(toy(), attempt).code, 3, 'judged alone, the level first step is put back');
  const r = step(d, attempt, '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.match(r.out, / kept .*score 100 to 110 \(turn 2 of 3\)/);
  assert.equal(git(d, 'rev-parse', 'HEAD~1'), base); assert.equal(at(d, 'src/helper.txt'), 'helper'); assert.equal(at(d, 'src/score.txt'), '110');
  const lines = record(d);
  assert.deepEqual(lines.map((l) => [l.result, l.turn ?? null, l.standing ?? null]), [['turn', 1, 'flat'], ['turn', 2, 'win'], ['turn', 3, 'same'], ['kept', null, null]]);
  assert.equal(lines[3].best, 2); assert.equal(lines[3].turns, 3); assert.equal(new Set(lines.map((l) => l.episode)).size, 1, 'one run, one episode');
  for (const l of lines.filter((x) => x.result === 'turn' && x.candidate)) assert.equal(git(d, 'rev-parse', `refs/improve/${l.n}`), l.candidate, `turn ${l.turn} is kept as refs/improve/${l.n}`);
  assert.equal(lines.some((l) => l.restored), false, 'the step\'s own refs are not taken for something the attempt touched');
});
test('turns: the best turn is kept, not the last, after it is measured once more', () => {
  const d = toy();
  const r = step(d, byTurn('echo 120 > src/score.txt', 'echo 105 > src/score.txt'), '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '120'); assert.match(r.out, /turn 1 of 3/);
  const run = record(d).at(-1); assert.equal(run.best, 1); assert.equal(run.asks, 3, 'two turns asked once each, and the best was asked once more');
});
test('turns: the next turn is handed the reading of the whole change so far', () => {
  const d = toy(), seen = join(TMP_ROOT, `fb-${Date.now()}`); mkdirSync(seen);
  step(d, `cp "$PW_FEEDBACK" ${seen}/turn-$PW_TURN.txt; ${byTurn('echo 110 > src/score.txt', 'echo 120 > src/score.txt')}`, '--turns', '2');
  assert.match(readFileSync(join(seen, 'turn-1.txt'), 'utf8'), /^Turn 1 of 2\..*\nNothing is measured yet\./s);
  const two = readFileSync(join(seen, 'turn-2.txt'), 'utf8');
  assert.match(two, /After turn 1:\n  score: 100 at the start, 110 now \(better\)/); assert.match(two, /As it stands this would be kept/);
});
test('turns: a gamed turn makes no win at a later one, and the run is put back as gamed', () => {
  const d = toy(), base = head(d);
  const r = step(d, byTurn('echo 50 > evals/bonus.txt', 'echo 110 > src/score.txt'), '--turns', '2');
  assert.equal(r.code, 2, r.err); assert.equal(head(d), base); assert.equal(read(d, 'evals/bonus.txt'), '0'); assert.ok(clean(d));
  assert.deepEqual(record(d).filter((l) => l.result === 'turn').map((l) => l.standing), ['gamed', 'gamed']);
});
test('turns: patience ends the run once there is a best and no new best for that many turns', () => {
  const d = toy();
  const r = step(d, byTurn('echo 110 > src/score.txt', 'echo a > src/a.txt', 'echo b > src/a.txt', 'echo 130 > src/score.txt'), '--turns', '4', '--patience', '2');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110', 'turn 4 never ran'); assert.match(r.out, /2 turns in a row with no new best/);
  assert.equal(record(d).at(-1).turns, 3);
});
test('turns: a turn cut off before it saved anything does not end the run, and the next turn is told', () => {
  const d = toy(), seen = join(TMP_ROOT, `fb-${Date.now()}-cut`); mkdirSync(seen);
  const r = step(d, `cp "$PW_FEEDBACK" ${seen}/turn-$PW_TURN.txt; ${byTurn('exit 124', 'echo 110 > src/score.txt')}`, '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110');
  assert.match(readFileSync(join(seen, 'turn-2.txt'), 'utf8'), /turn 1 ended with code 124 and changed nothing on disk/);
});
test('turns: a contract change at one turn stands against the start, the next turn is told, and a later turn that puts it back can be kept', () => {
  const d = open(), seen = join(TMP_ROOT, `fb-${Date.now()}-con`); mkdirSync(seen);
  const r = step(d, `cp "$PW_FEEDBACK" ${seen}/turn-$PW_TURN.txt; ${byTurn(`${GOOD}; ${addMeasure}`, 'git checkout -q -- promptwheel.config.json')}`, '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110'); assert.doesNotMatch(at(d, 'promptwheel.config.json'), /notes/);
  assert.match(readFileSync(join(seen, 'turn-2.txt'), 'utf8'), /THE CONTRACT WAS CHANGED at turn 1/);
  assert.deepEqual(record(d).filter((l) => l.result === 'turn').map((l) => l.standing).slice(0, 2), ['contract', 'win']);
});
test('turns: --turns and --patience take whole numbers of 1 or more', () => {
  const d = toy();
  for (const bad of [['--turns', '0'], ['--turns', 'x'], ['--turns', '1.5'], ['--patience', '0']]) {
    const r = step(d, GOOD, ...bad); assert.equal(r.code, 64, bad.join(' ')); assert.match(r.err, /whole number/);
  }
  assert.equal(read(d, 'src/score.txt'), '100');
});
test('turns: an interrupt keeps a best turn that had passed its check', async () => {
  const d = toy(), base = head(d);
  const child = spawn(process.execPath, [RIG, '--turns', '5', '--attempt', byTurn(GOOD, `touch ${d}.turn2; sleep 30`)], { cwd: d, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = ''; child.stdout.on('data', (x) => { out += x; });
  for (let i = 0; i < 400 && !existsSync(`${d}.turn2`); i++) await new Promise((res) => setTimeout(res, 50));
  process.kill(-child.pid, 'SIGINT');
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  assert.equal(code, 0, out); assert.equal(git(d, 'rev-parse', 'HEAD~1'), base); assert.equal(at(d, 'src/score.txt'), '110'); assert.ok(clean(d));
  assert.match(out, /stopped at turn 2/);
  agree(d);
});
test('target: a target that counts down is kept when it falls, and the line says so', () => {
  const d = toy(), r = step(d, 'echo 90 > src/cost.txt', '--target', 'cost');
  assert.equal(r.code, 0, r.err); assert.match(r.out, / kept .*cost 100 to 90/); assert.equal(record(d)[0].target, 'cost');
});
test('help: --help prints the step\'s own header, runs nothing, and exits 0; promptwheel improve --help does the same', () => {
  const d = toy();
  const r = step(d, GOOD, '--help');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^The loop's one keeper/); assert.match(r.out, /--turns N judges over a number of turns/);
  assert.doesNotMatch(r.out, /^import |process\.argv/m, 'the header only, not the code under it');
  assert.equal(read(d, 'src/score.txt'), '100', 'the attempt never ran'); assert.ok(!existsSync(join(d, '.git', 'improve')));
  const door = spawnSync(process.execPath, [join(ROOT, 'bin', 'promptwheel.mjs'), 'improve', '--help'], { cwd: d, encoding: 'utf8', env: ENV });
  assert.equal(door.status, 0, door.stderr); assert.match(door.stdout, /^The loop's one keeper/);
});
// Four gaps the break drill found in the tests above (proof-bench/wheel/raw/teeth-keeper-1.txt), each a test now.
test('contract: a file its evaluatorPaths name counts too, where the gate itself lets the win through (a target the source-only re-run skips)', () => {
  const over = { score: { gamingCheck: false }, top: { evaluatorPaths: ['evals/limits.json'] }, files: { 'evals/limits.json': '{}\n' } };
  const r = step(toy(over), `${GOOD}; echo '{ "max": 9 }' > evals/limits.json`);
  assert.equal(r.code, 1, r.err); assert.match(r.out, /contract .*evals\/limits\.json/);
  assert.equal(step(toy(over), GOOD).code, 0, 'the same win without the edit is kept');
});
test('turns: a target that can go no further ends the run at that turn', () => {
  const d = toy();
  const r = step(d, byTurn('echo 0 > src/cost.txt', 'echo 120 > src/score.txt'), '--target', 'cost', '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /the target can go no further/);
  assert.equal(at(d, 'src/cost.txt'), '0'); assert.equal(at(d, 'src/score.txt'), '100', 'turn 2 never ran'); assert.equal(record(d).at(-1).turns, 1);
});
test('turns: a run with no win reads as its last judged turn, not as a turn that changed nothing after it', () => {
  const d = toy(), r = step(d, byTurn('echo helper > src/helper.txt'), '--turns', '3');
  assert.equal(r.code, 3, r.err); assert.match(r.out, / flat .*score did not improve/); assert.equal(record(d).at(-1).result, 'flat');
});
// The second reader's twenty breaks of the same code (proof-bench/wheel/teeth-keeper-extra.json): none was caught at
// first. Each test below makes its break fail.
test('turns: patience is 3 when none is given', () => {
  const d = toy();
  const r = step(d, byTurn(GOOD, 'echo a > src/a.txt', 'echo b > src/a.txt', 'echo c > src/a.txt', 'echo 130 > src/score.txt'), '--turns', '6');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /3 turns in a row with no new best/); assert.equal(record(d).at(-1).turns, 4); assert.equal(at(d, 'src/score.txt'), '110');
});
test('turns: every run has an episode of its own, two runs from one commit included', () => {
  const d = toy();
  step(d, byTurn('echo h > src/h.txt'), '--turns', '2'); step(d, byTurn('echo h > src/h.txt'), '--turns', '2');
  const runs = record(d).filter((l) => l.result !== 'turn'); assert.equal(runs.length, 2); assert.notEqual(runs[0].episode, runs[1].episode);
});
test('turns: a run that changed nothing at all exits 3, so a while loop stops', () => {
  const r = step(toy(), 'true', '--turns', '2'); assert.equal(r.code, 3, r.err); assert.match(r.out, / nothing /);
});
test('turns: a run of two turns is measured once more before it is kept', () => {
  const d = toy(), r = step(d, byTurn(GOOD), '--turns', '2');
  assert.equal(r.code, 0, r.err); assert.equal(record(d).at(-1).asks, 2, 'the winning turn, then the second look');
});
test('turns: a best turn whose win does not show again is put back, exit 3', () => {
  const count = join(TMP_ROOT, `flaky-${Date.now()}`);   // the first two readings are true, every later one says 100
  const d = toy({ score: { cmd: `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}; if [ "$n" -lt 2 ]; then cat src/score.txt; else echo 100; fi` } }), base = head(d);
  const r = step(d, byTurn(GOOD), '--turns', '2');
  assert.equal(r.code, 3, r.err); assert.match(r.out, / flat .*did not show again when it was measured once more/); assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100');
});
test('turns: Ctrl-C ends the run even when the attempt catches it and ends by itself', async () => {
  const d = toy(), base = head(d);
  const child = spawn(process.execPath, [RIG, '--turns', '5', '--attempt', byTurn(GOOD, `trap 'exit 0' INT; touch ${d}.t2; sleep 30 & wait`, 'echo 999 > src/score.txt')], { cwd: d, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = ''; child.stdout.on('data', (x) => { out += x; });
  for (let i = 0; i < 400 && !existsSync(`${d}.t2`); i++) await new Promise((res) => setTimeout(res, 50));
  process.kill(-child.pid, 'SIGINT');
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  assert.equal(code, 0, out); assert.match(out, /stopped at turn 2/); assert.equal(at(d, 'src/score.txt'), '110', 'turn 3 never ran'); assert.equal(git(d, 'rev-parse', 'HEAD~1'), base);
  agree(d);
});
test('turns: a run stopped before any turn won puts the tree back', async () => {
  const d = toy(), base = head(d);
  const child = spawn(process.execPath, [RIG, '--turns', '3', '--attempt', `echo x > src/new.txt; touch ${d}.t1; sleep 30`], { cwd: d, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let err = ''; child.stderr.on('data', (x) => { err += x; });
  for (let i = 0; i < 400 && !existsSync(`${d}.t1`); i++) await new Promise((res) => setTimeout(res, 50));
  process.kill(-child.pid, 'SIGINT');
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  assert.equal(code, 64, err); assert.match(err, /stopped .*at turn 1/); assert.equal(head(d), base); assert.ok(!existsSync(join(d, 'src', 'new.txt'))); assert.ok(clean(d));
  agree(d);
});
test('turns: the next turn is told a measure that got worse is worse', () => {
  const d = toy(), seen = join(TMP_ROOT, `fb-${Date.now()}-worse`); mkdirSync(seen);
  step(d, `cp "$PW_FEEDBACK" ${seen}/turn-$PW_TURN.txt; ${byTurn('echo 120 > src/cost.txt', 'echo 100 > src/cost.txt')}`, '--turns', '2');
  const two = readFileSync(join(seen, 'turn-2.txt'), 'utf8');
  assert.match(two, /cost: 100 at the start, 120 now \(worse\)/); assert.match(two, /WORSE THAN AT THE START: cost 100 to 120/);
});
test('contract: a repo with no config has no contract file to guard, and a win there is kept', () => {
  const d = mkdtempSync(join(TMP_ROOT, 'zc-'));
  git(d, 'init', '-q', '-b', 'main', '.'); git(d, 'config', 'user.email', 't@example.com'); git(d, 'config', 'user.name', 't');
  put(d, 'package.json', '{"name":"zc","scripts":{"test":"node --test"}}\n'); put(d, 'src/add.js', 'exports.add=(a,b)=>a-b\n');
  put(d, 'test/add.test.js', "const t=require('node:test'),a=require('node:assert');t.test('add',()=>a.equal(require('../src/add.js').add(2,2),4))\n");
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  const r = step(d, "sed -i 's/a-b/a+b/' src/add.js", '--target', 'tests_pass');
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, / kept .*tests_pass 0 to 1/);
});
test('mark: a second run while the first is going is refused, by the first run\'s own mark', async () => {
  const d = toy();
  const child = spawn(process.execPath, [RIG, '--attempt', `touch ${d}.going; sleep 30`], { cwd: d, env: ENV, stdio: 'ignore', detached: true });
  for (let i = 0; i < 400 && !existsSync(`${d}.going`); i++) await new Promise((res) => setTimeout(res, 50));
  const r = step(d, GOOD);
  process.kill(-child.pid, 'SIGINT'); await new Promise((res) => child.on('exit', res));
  assert.equal(r.code, 64); assert.match(r.err, new RegExp(`another run of the loop is going in this repo \\(process ${child.pid}\\)`));
  agree(d);
});
test('mark: a run that could not run to its end leaves no mark behind', () => {
  const d = toy(), r = step(d, GOOD, '--target', 'nope');
  assert.equal(r.code, 64); assert.match(r.err, /no metric named "nope"/); assert.ok(!existsSync(join(d, '.git', 'improve', 'running.json')));
});
test('turns: on a target that counts down, the best turn is the one that went lowest', () => {
  const d = toy(), r = step(d, byTurn('echo 90 > src/cost.txt', 'echo 80 > src/cost.txt'), '--target', 'cost', '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/cost.txt'), '80'); assert.equal(record(d).at(-1).best, 2);
});

// ------------------------------------------------------------------ an attempt that could not run is not a try
// Found in the first real run of a loop on this step (2026-11-21): an attempt script crashed before its agent
// started, the step wrote "nothing" for each try, and a plan of tries was used up in two seconds. 64 is how the
// programs here say "could not run". 126 and 127 are the shell saying the command could not be run or was not found.
test('loop: an attempt that says it could not run (exit 64) is not a try: exit 64, no line on record, nothing judged', () => {
  const d = toy(), base = head(d), r = step(d, 'exit 64');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /could not run/); assert.equal(r.out, '');
  assert.deepEqual(record(d), []); assert.equal(asks(d), 0); assert.equal(head(d), base); assert.ok(clean(d));
});
test('loop: a command the shell cannot find (127) or cannot run (126) is not a try either', () => {
  const missing = toy(); assert.equal(step(missing, 'no-such-command-anywhere').code, 64); assert.deepEqual(record(missing), []);
  const d = toy(); put(d, 'tools/agent.sh', '#!/bin/sh\necho 110 > src/score.txt\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'a script that is not marked as a program');
  const r = step(d, './tools/agent.sh');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /exit 126/); assert.deepEqual(record(d), []); assert.ok(clean(d));
});
test('loop: an attempt that fails in any other way and changed no file is still a try, on record as nothing (exit 3)', () => {
  const d = toy(), r = step(d, 'exit 7');
  assert.equal(r.code, 3, r.err); assert.deepEqual(record(d).map((l) => l.result), ['nothing']);
});
test('loop: exit 64 after files were changed puts them back, and nothing is judged or kept', () => {
  const d = toy(), base = head(d), r = step(d, 'echo 110 > src/score.txt; echo junk > new.txt; exit 64');
  assert.equal(r.code, 64, r.err); assert.equal(head(d), base); assert.equal(state(d), '100 100'); assert.equal(existsSync(join(d, 'new.txt')), false); assert.ok(clean(d));
  assert.deepEqual(record(d), []); assert.equal(asks(d), 0, 'the gate is not asked');
});
test('loop: a command that changed files and then ended 127 ran in part, so its change is judged like any other', () => {
  const d = toy(), r = step(d, 'echo 110 > src/score.txt; no-such-command-anywhere');
  assert.equal(r.code, 0, r.err); assert.deepEqual(record(d).map((l) => l.result), ['kept']);
});
test('loop: an attempt that could not run uses up no number: the try after it is try 1', () => {
  const d = toy(); assert.equal(step(d, 'exit 64').code, 64); const r = step(d, 'echo 110 > src/score.txt');
  assert.equal(r.code, 0, r.err); assert.deepEqual(record(d).map((l) => [l.n, l.result]), [[1, 'kept']]);
});

// ------------------------------------------------------------------ a git too old to hold the hooks off
// The step turns hooks off for its own git calls through GIT_CONFIG_COUNT. A git older than 2.31 ignores that and
// says nothing, so the step must not run on one.
const oldGit = (version) => {   // a folder to put first in PATH: a git that says it is this version, and is the real git for the rest
  const bin = join(HOME, `oldgit-${version}`); mkdirSync(bin, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = --version ] && { echo "git version ${version}"; exit 0; }\nexec ${real} "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
};
test('loop: it refuses to run on a git older than 2.31 (exit 64), and the attempt does not run', () => {
  const d = toy(), r = run(d, ['--attempt', 'echo 110 > src/score.txt'], oldGit('2.30.9'));
  assert.equal(r.code, 64, r.err); assert.match(r.err, /2\.31/); assert.equal(state(d), '100 100'); assert.deepEqual(record(d), []);
});
test('loop: git 2.31 itself, and a newer git with a longer version string, are taken', () => {
  for (const version of ['2.31.0', '2.43.0.windows.1', '3.0.0']) {
    const d = toy(), r = run(d, ['--attempt', 'echo 110 > src/score.txt'], oldGit(version));
    assert.equal(r.code, 0, `${version}: ${r.err}`);
  }
});
test('loop: a git version it cannot read is refused too: it does not guess', () => {
  const d = toy(), r = run(d, ['--attempt', 'echo 110 > src/score.txt'], oldGit('unknown'));
  assert.equal(r.code, 64, r.err); assert.deepEqual(record(d), []);
});

// ------------------------------------------------------------------ could not run, in a run over turns
test('turns: a first turn that could not run is not a try: exit 64, nothing on record, the gate not asked', () => {
  const d = toy(), r = step(d, 'exit 64', '--turns', '3');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /could not run/); assert.deepEqual(record(d), []); assert.equal(asks(d), 0); assert.ok(clean(d));
});
test('turns: when a later turn could not run the run ends there, and a turn that had passed its check is kept', () => {
  const d = toy(), r = step(d, byTurn('echo 110 > src/score.txt', 'exit 64'), '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110'); assert.ok(clean(d));
  assert.match(record(d).pop().why, /could not run at turn 2/);
});
test('turns: when a later turn could not run and no turn had passed, all of it is put back and the line says why (exit 64)', () => {
  const d = toy(), base = head(d), r = step(d, byTurn('echo 120 > src/cost.txt', 'exit 64'), '--turns', '3');
  assert.equal(r.code, 64, r.err); assert.equal(head(d), base); assert.equal(state(d), '100 100'); assert.ok(clean(d));
  const last = record(d).pop(); assert.equal(last.result, 'stopped'); assert.match(last.why, /could not run \(exit 64\) at turn 2/);
});
test('turns: a later turn the shell could not find (127) that changed nothing ends the run too', () => {
  const d = toy(), r = step(d, byTurn('echo 110 > src/score.txt', 'no-such-command-anywhere'), '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110'); assert.match(record(d).pop().why, /could not run at turn 2/);
});
// ------------------------------------------------------------------ could not run over turns: what this port adds
// ("No file changed" is the turn's own change: the tree as the last turn left it.)
test('turns: an attempt that could not run at a later turn ends the run there, and a best turn that had passed is kept', () => {
  const d = toy(), r = step(d, byTurn('echo 110 > src/score.txt', 'echo 120 > src/score.txt; exit 64', 'echo 130 > src/score.txt'), '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(state(d), '110 100', 'turn 1 is kept, and what turn 2 did before it said it could not run is not'); assert.ok(clean(d));
  const lines = record(d); assert.deepEqual(lines.map((l) => l.result), ['turn', 'kept'], 'turn 2 is no turn on record');
  assert.equal(lines.at(-1).best, 1); assert.equal(lines.at(-1).turns, 1); assert.match(lines.at(-1).why, /the attempt could not run at turn 2 \(exit 64\)/);
});
test('turns: with no best turn, an attempt that could not run at a later turn puts the run back, and a stopped line closes it (exit 64)', () => {
  const d = toy(), base = head(d), r = step(d, byTurn('echo 90 > src/score.txt', 'exit 64'), '--turns', '3');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /could not run/); assert.equal(head(d), base); assert.equal(state(d), '100 100'); assert.ok(clean(d));
  assert.deepEqual(record(d).map((l) => l.result), ['turn', 'stopped']);
});
test('turns: a later turn the shell could not find, that changed nothing, ends the run; one that changed files and then ended 127 is judged', () => {
  const d = toy(), r = step(d, byTurn('echo 110 > src/score.txt', 'no-such-command-anywhere'), '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(state(d), '110 100'); assert.deepEqual(record(d).map((l) => l.result), ['turn', 'kept']);
  const e = toy(), k = step(e, byTurn('echo 90 > src/score.txt', 'echo 120 > src/score.txt; no-such-command-anywhere'), '--turns', '2');
  assert.equal(k.code, 0, k.err); assert.equal(state(e), '120 100'); assert.deepEqual(record(e).map((l) => l.result), ['turn', 'turn', 'kept']);
});
test('turns: a run that ends on a turn that could not run measures its best turn once more before keeping it, as any run that ends does', () => {
  const steps = (third) => byTurn('echo 90 > src/score.txt', 'echo 110 > src/score.txt', third);
  const a = toy(), r = step(a, steps('exit 64'), '--turns', '4');
  assert.equal(r.code, 0, r.err); assert.equal(state(a), '110 100'); assert.match(record(a).at(-1).why, /\(turn 2 of 2\) \(the run ended after turn 2: the attempt could not run at turn 3 \(exit 64\)\)/);
  const b = toy(); assert.equal(step(b, steps('true'), '--turns', '4').code, 0, 'the same run, ended by a turn that changed nothing');
  assert.equal(asks(a), asks(b), 'the gate is asked as often: both runs measure the best turn once more');
});
