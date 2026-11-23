// The wall: an attempt runs in a copy of the tree, and only its files come back.
//
// Each test runs the real wall, alone or as the attempt of the real step, and reads what is left: the files, the
// commits, the processes and the temp folder. Run: node --test  (through check.sh)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agree, at, clean, git, head, put, q, read, record, run, step, toy, walled, ENV, NODE, STEP, TMP_ROOT, WALL } from './improve-loop-helpers.mjs';

const wall = (d, attempt, ...flags) => run(WALL, d, [...flags, '--', attempt]);
const out = (name) => join(TMP_ROOT, `${name}-${Math.random().toString(36).slice(2)}`);   // where an attempt can leave a note for the test
const copies = () => readdirSync(TMP_ROOT).filter((f) => f.startsWith('improve-wall-') || f.startsWith('improve-back-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (d) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: d, encoding: 'utf8' }).trimEnd();   // the first column can be a space

// ------------------------------------------------------------------ what comes back
test('wall: an edit, a new file, a deleted file and a new mode come back as plain working changes', () => {
  const d = toy({ files: { 'src/old.txt': 'old\n', 'src/run.sh': 'echo hi\n' } });
  const r = wall(d, 'echo 110 > src/score.txt; echo new > src/new.txt; rm src/old.txt; chmod +x src/run.sh');
  assert.equal(r.code, 0, r.err);
  assert.equal(status(d), ' D src/old.txt\n M src/run.sh\n M src/score.txt\n?? src/new.txt', 'nothing is staged: it reads as if the attempt had run here');
  assert.equal(read(d, 'src/score.txt'), '110'); assert.equal(read(d, 'src/new.txt'), 'new'); assert.ok(statSync(join(d, 'src/run.sh')).mode & 0o100);
});
test('wall: bytes come back as they were written, and a link comes back as a link that is not followed', () => {
  const d = toy(), sum = out('sum');
  const r = wall(d, `head -c 4096 /dev/urandom > src/blob.bin; sha256sum < src/blob.bin > ${sum}; ln -s /etc/hostname src/link`);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(sum, 'utf8').split(' ')[0], createHash('sha256').update(readFileSync(join(d, 'src/blob.bin'))).digest('hex'));
  assert.ok(lstatSync(join(d, 'src/link')).isSymbolicLink()); assert.equal(readlinkSync(join(d, 'src/link')), '/etc/hostname');
});
test('wall: an attempt that changes nothing leaves the tree clean, and its exit code is the wall\'s', () => {
  const d = toy();
  assert.equal(wall(d, 'true').code, 0); assert.equal(wall(d, 'exit 7').code, 7); assert.ok(clean(d));
});
test('wall: an attempt that fails after editing still has its edits brought back, as the step expects', () => {
  const d = toy(), r = wall(d, 'echo 110 > src/score.txt; exit 7');
  assert.equal(r.code, 7); assert.equal(read(d, 'src/score.txt'), '110');
});
test('wall: a file git ignores that the attempt writes is not brought back', () => {
  const d = toy(), r = wall(d, 'mkdir -p ignored && echo junk > ignored/junk.txt; echo 110 > src/score.txt');
  assert.equal(r.code, 0, r.err); assert.ok(!existsSync(join(d, 'ignored/junk.txt'))); assert.equal(read(d, 'src/score.txt'), '110');
});
test('wall: a tracked file that an ignore rule also matches is in the copy, and an edit to it comes back', () => {
  const d = toy(); put(d, 'ignored/kept.txt', 'kept\n'); git(d, 'add', '-f', 'ignored/kept.txt'); git(d, 'commit', '-qm', 'a tracked file in an ignored folder');
  const note = out('tracked');
  const r = wall(d, `git ls-files ignored > ${note}; cat ignored/kept.txt > /dev/null && echo edited > ignored/kept.txt`);
  assert.equal(r.code, 0, r.err); assert.equal(read(d, 'ignored/kept.txt'), 'edited');
  assert.equal(readFileSync(note, 'utf8'), 'ignored/kept.txt\n', 'and the copy\'s own repo tracks it too, so git in the copy shows an edit to it');
});
test('wall: several words after -- are a program and its arguments, kept as given', () => {
  const d = toy(), r = run(WALL, d, ['--', 'sh', '-c', 'echo "$1" > src/said.txt', 'sh', 'two words; and a quote \'']);
  assert.equal(r.code, 0, r.err); assert.equal(read(d, 'src/said.txt'), 'two words; and a quote \'');
});

// ------------------------------------------------------------------ what the attempt is handed
test('wall: the attempt runs in another folder, named like the repo, that holds the tracked files and a git repo of its own', () => {
  const d = toy({ untracked: { 'ignored/mine.txt': 'mine\n', 'node_modules/dep/x.js': 'x\n' } }), note = out('where');
  const r = wall(d, `{ pwd; ls -a | tr '\\n' ' '; echo; git rev-list --count HEAD; git status --porcelain | wc -l; git config user.email; } > ${note}`);
  assert.equal(r.code, 0, r.err);
  const [where, files, commits, dirty, email] = readFileSync(note, 'utf8').split('\n');
  assert.notEqual(where, d); assert.ok(!where.startsWith(d + '/'), 'the copy is not inside the repo'); assert.ok(where.endsWith('/' + d.split('/').pop()));
  for (const name of ['README.md', 'evals', 'promptwheel.config.json', 'src', '.git']) assert.ok(files.split(' ').includes(name), name);
  assert.doesNotMatch(files, /ignored|node_modules/, 'what git ignores is not copied');
  assert.equal(commits, '1'); assert.equal(dirty.trim(), '0'); assert.equal(email, 't@example.com', 'and it can commit there as you');
});
test('wall --with: a folder git ignores is copied for the attempt, and what it does there never reaches yours', () => {
  const d = toy({ untracked: { 'node_modules/dep/x.js': 'x\n' } }), note = out('dep');
  const r = wall(d, `cat node_modules/dep/x.js > ${note}; echo poisoned > node_modules/dep/x.js; echo new > node_modules/dep/y.js; echo 110 > src/score.txt`, '--with', 'node_modules');
  assert.equal(r.code, 0, r.err); assert.equal(readFileSync(note, 'utf8'), 'x\n');
  assert.equal(read(d, 'node_modules/dep/x.js'), 'x'); assert.ok(!existsSync(join(d, 'node_modules/dep/y.js'))); assert.equal(read(d, 'src/score.txt'), '110');
});
test('wall --with: a path outside the repo, the .git folder, or a path that is not there is refused before anything runs (exit 64)', () => {
  const d = toy(), note = out('ran');
  for (const p of ['../elsewhere', '/etc', '.git', '.git/hooks', '.', 'no-such-folder']) {
    const r = wall(d, `touch ${note}`, '--with', p);
    assert.equal(r.code, 64, p); assert.match(r.err, /--with/);
  }
  assert.ok(!existsSync(note)); assert.deepEqual(copies(), []);
});
test('wall: git commands the attempt runs change the copy\'s repo, never yours: not a commit, a branch, a hook, a ref or a config', () => {
  const d = toy(), base = head(d), refs = git(d, 'for-each-ref'), config = read(d, '.git/config');
  const r = wall(d, `echo 120 > src/cost.txt; git commit -qam mine; git checkout -q -b side; git tag t; git config filter.x.clean cat; printf '#!/bin/sh\\necho 300 > src/cost.txt\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; git update-index --skip-worktree src/score.txt; echo 150 > src/score.txt`);
  assert.equal(r.code, 0, r.err);
  assert.equal(head(d), base); assert.equal(git(d, 'symbolic-ref', 'HEAD'), 'refs/heads/main'); assert.equal(git(d, 'for-each-ref'), refs);
  assert.equal(read(d, '.git/config'), config); assert.ok(!existsSync(join(d, '.git/hooks/pre-commit')));
  assert.equal(status(d), ' M src/cost.txt\n M src/score.txt', 'its files came back, the hidden one too, as plain changes for the step to judge');
});
test('wall: the copy has no way to your .git by a path inside it, even if the attempt swaps its own .git for a link', () => {
  const d = toy(), base = head(d);
  const r = wall(d, `rm -rf .git; ln -s ${d}/.git .git; echo 110 > src/score.txt`);
  assert.equal(r.code, 0, r.err);
  assert.equal(head(d), base); assert.equal(git(d, 'fsck', '--connectivity-only', '--no-dangling'), '', 'and your object store is whole'); assert.equal(status(d), ' M src/score.txt');
});
test('wall: the loop\'s record is handed over as a copy: the attempt can read it, and writing to it changes nothing', () => {
  const d = toy(), note = out('rec');
  step(d, 'echo 90 > src/score.txt');   // one try on record
  const before = readFileSync(join(d, '.git/improve/attempts.jsonl'), 'utf8');
  const r = step(d, walled(`{ echo "$IMPROVE_RECORD"; cat "$IMPROVE_RECORD"; } > ${note}; : > "$IMPROVE_RECORD"; echo 110 > src/score.txt`));
  assert.equal(r.code, 0, r.err);
  const [where, ...lines] = readFileSync(note, 'utf8').split('\n');
  assert.ok(!where.startsWith(d), 'the path it was given is not in your repo'); assert.equal(lines.join('\n'), before);
  assert.equal(record(d).length, 2); assert.equal(record(d)[1].restored, undefined, 'the real record was never touched, so there was nothing to put back');
});
test('wall --no-record: the attempt is handed no record at all', () => {
  const d = toy(), note = out('rec');
  step(d, 'echo 90 > src/score.txt');
  const r = step(d, walled(`echo "[$IMPROVE_RECORD]" > ${note}; ls .. >> ${note}; echo 110 > src/score.txt`, '--no-record'));
  assert.equal(r.code, 0, r.err); assert.equal(readFileSync(note, 'utf8').split('\n')[0], '[]'); assert.doesNotMatch(readFileSync(note, 'utf8'), /record/);
});
test('wall: variables that point git at your repo are not handed to the attempt', () => {
  const d = toy(), base = head(d);
  const r = run(WALL, d, ['--', 'echo 120 > src/cost.txt; git commit -qam mine; git rev-parse --show-toplevel'], { GIT_DIR: join(d, '.git'), GIT_WORK_TREE: d });
  assert.equal(r.code, 0, r.err); assert.equal(head(d), base, 'its commit went to the copy');
  assert.ok(!r.out.trim().startsWith(d + '\n') && r.out.trim() !== d, 'git inside the copy sees the copy');
});

// ------------------------------------------------------------------ behind the step
test('wall + step: an honest win made in the copy is kept, and a worse change is put back', () => {
  const d = toy(), base = head(d);
  assert.equal(step(d, walled('echo 110 > src/score.txt')).code, 0); assert.equal(at(d, 'src/score.txt'), '110'); assert.ok(clean(d));
  assert.equal(step(d, walled('echo 120 > src/cost.txt')).code, 1); assert.equal(at(d, 'src/cost.txt'), '100'); assert.ok(clean(d));
  assert.equal(git(d, 'rev-parse', 'HEAD^'), base); assert.deepEqual(copies(), [], 'and no copy is left behind');
});
test('wall + step: an installed dependency the scorer runs cannot be edited from the copy (attack 25)', () => {
  const lib = 'echo $(( $(cat src/score.txt) + $(cat evals/bonus.txt) ))\n';
  const d = toy({ scorer: 'sh node_modules/scorer/score.sh', top: { linkDirs: ['node_modules'] }, untracked: { 'node_modules/scorer/score.sh': lib } }), base = head(d);
  const poison = `printf 'b=0; [ -f src/marker ] && b=50; echo $(( $(cat src/score.txt) + b ))\\n' > node_modules/scorer/score.sh; touch src/marker`;
  const r = step(d, walled(poison, '--with', 'node_modules'));
  assert.notEqual(r.code, 0); assert.equal(head(d), base); assert.equal(read(d, 'node_modules/scorer/score.sh') + '\n', lib);
  const open = toy({ scorer: 'sh node_modules/scorer/score.sh', top: { linkDirs: ['node_modules'] }, untracked: { 'node_modules/scorer/score.sh': lib } });
  assert.equal(step(open, poison).code, 0, 'with no wall the same attempt is kept as a win of 50');
});

// ------------------------------------------------------------------ what the attempt leaves running, and time
test('wall: a process the attempt leaves running is ended with it, before anything is read from the copy', async () => {
  const d = toy(), pidFile = out('pid');
  const r = wall(d, `echo 110 > src/score.txt; ( echo $$ > /dev/null; sh -c 'echo $$ > ${pidFile}; sleep 30; echo late > src/late.txt' ) </dev/null >/dev/null 2>&1 & sleep 0.3`);
  assert.equal(r.code, 0, r.err);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1); await sleep(100); assert.ok(!alive(pid), 'the process is gone');
  assert.equal(status(d), ' M src/score.txt');
});
test('wall --minutes: an attempt that runs too long is ended, nothing comes back, exit 124', () => {
  const d = toy(), began = Date.now();
  const r = wall(d, 'echo 110 > src/score.txt; sleep 30', '--minutes', '0.01');
  assert.equal(r.code, 124); assert.match(r.err, /out of time/); assert.ok(Date.now() - began < 10000);
  assert.ok(clean(d)); assert.deepEqual(copies(), []);
});
test('wall + step: stopped with Ctrl-C, nothing comes back, the step notes it, and no copy is left', async () => {
  const d = toy(), began = out('began');
  const child = spawn(NODE, [STEP, '--attempt', walled(`echo 120 > src/cost.txt; touch ${began}; sleep 30`)], { cwd: d, env: ENV, detached: true, stdio: 'ignore' });
  const done = new Promise((res) => child.on('exit', (code) => res(code)));
  for (let i = 0; i < 200 && !existsSync(began); i++) await sleep(50);
  process.kill(-child.pid, 'SIGINT');
  assert.equal(await Promise.race([done, sleep(15000).then(() => 'still running')]), 64);
  assert.ok(clean(d)); assert.equal(read(d, 'src/cost.txt'), '100'); assert.equal(record(d)[0].result, 'stopped');
  await sleep(200); assert.deepEqual(copies(), []);
  agree(d);
});

// ------------------------------------------------------------------ what it refuses, and what it says
test('wall: it refuses a tree that is not clean, and nothing runs (exit 64)', () => {
  const d = toy(), note = out('ran'); writeFileSync(join(d, 'README.md'), 'toy\nmine\n');
  const r = wall(d, `touch ${note}`);
  assert.equal(r.code, 64); assert.match(r.err, /not clean/); assert.ok(!existsSync(note)); assert.equal(read(d, 'README.md'), 'toy\nmine');
});
test('wall: it refuses a tree with an edited file that is hidden from git, where git status reads clean (exit 64)', () => {
  const d = toy(), note = out('ran'); git(d, 'update-index', '--skip-worktree', 'src/score.txt'); writeFileSync(join(d, 'src/score.txt'), '150\n');
  assert.ok(clean(d), 'git status says the tree is clean');
  const r = wall(d, `touch ${note}`);
  assert.equal(r.code, 64); assert.match(r.err, /hidden from git: src\/score\.txt/); assert.ok(!existsSync(note)); assert.equal(read(d, 'src/score.txt'), '150');
});
test('wall: a flag it does not know, a flag with no value, no command, and a folder that is no repo are all exit 64', () => {
  const d = toy();
  assert.equal(run(WALL, d, ['--minute', '5', '--', 'true']).code, 64); assert.equal(run(WALL, d, ['--minutes', '--', 'true']).code, 64);
  assert.equal(run(WALL, d, ['--minutes', '0', '--', 'true']).code, 64); assert.equal(run(WALL, d, ['true']).code, 64); assert.equal(run(WALL, d, ['--']).code, 64);
  assert.equal(run(WALL, TMP_ROOT, ['--', 'true']).code, 64);
});
test('wall: when the real tree changes while the attempt is in the copy, it says so, and both changes are there to be judged', () => {
  const d = toy();
  const r = wall(d, `echo 120 > ${d}/src/cost.txt; echo 110 > src/score.txt`);
  assert.equal(r.code, 0, r.err); assert.match(r.err, /your real tree changed .*src\/cost\.txt/);
  assert.equal(status(d), ' M src/cost.txt\n M src/score.txt');
});
test('wall: when the same file was changed in the real tree and in the copy, nothing is handed back and it says so (exit 65)', () => {
  const d = toy();
  const r = wall(d, `echo 120 > ${d}/src/score.txt; echo 110 > src/score.txt`);
  assert.equal(r.code, 65); assert.match(r.err, /could not hand the files back/); assert.equal(read(d, 'src/score.txt'), '120');
});
test('wall: when the real repo moves to another commit while the attempt is in the copy, nothing is handed back (exit 65)', () => {
  const d = toy();
  const r = wall(d, `git -C ${d} commit -q --allow-empty -m moved; echo 110 > src/score.txt`);
  assert.equal(r.code, 65); assert.match(r.err, /moved to another commit/); assert.ok(clean(d));
});
test('wall: it runs from a folder inside the repo, and the attempt starts at the top of the copy', () => {
  const d = toy(), r = run(WALL, join(d, 'src'), ['--', 'echo 110 > src/score.txt']);
  assert.equal(r.code, 0, r.err); assert.equal(read(d, 'src/score.txt'), '110');
});
test('wall: no copy is left in the temp folder, whether the attempt worked, failed or was refused', () => {
  const d = toy(); wall(d, 'echo 110 > src/score.txt'); git(d, 'checkout', '-q', '.'); wall(d, 'exit 3'); wall(d, 'true', '--with', 'nope');
  assert.deepEqual(copies(), []);
});
test('wall: a change to a file that is hidden from git in your repo cannot be handed back, and it says so (exit 65)', () => {
  const d = toy(); git(d, 'update-index', '--skip-worktree', 'src/score.txt');
  const r = wall(d, 'echo 110 > src/score.txt; echo 90 > src/cost.txt');
  assert.equal(r.code, 65); assert.match(r.err, /hidden from git .*src\/score\.txt/); assert.equal(read(d, 'src/score.txt'), '100'); assert.equal(read(d, 'src/cost.txt'), '100', 'nothing at all came back');
});
test('wall: its own git calls in your repo run none of your hooks', () => {
  const d = toy(), ran = out('hook');
  put(d, '.git/hooks/post-index-change', `#!/bin/sh\necho x >> ${ran}\n`); chmodSync(join(d, '.git/hooks/post-index-change'), 0o755);
  const r = wall(d, 'echo 110 > src/score.txt');
  assert.equal(r.code, 0, r.err); assert.equal(read(d, 'src/score.txt'), '110'); assert.ok(!existsSync(ran), 'the hook never ran');
});
test('wall: stopped by a signal, it ends by that signal, so whatever ran it sees a stopped attempt', async () => {
  const d = toy(), began = out('began');
  // the attempt catches the signal and ends with a plain 0: a stopped attempt is still not handed back
  const child = spawn(NODE, [WALL, '--', `trap 'exit 0' TERM; echo 110 > src/score.txt; touch ${began}; sleep 30 & wait`], { cwd: d, env: ENV, stdio: 'ignore' });
  const done = new Promise((res) => child.on('exit', (code, signal) => res(signal || code)));
  for (let i = 0; i < 200 && !existsSync(began); i++) await sleep(50);
  child.kill('SIGTERM');
  assert.equal(await Promise.race([done, sleep(15000).then(() => 'still running')]), 'SIGTERM');
  assert.ok(clean(d), 'and nothing came back'); await sleep(200); assert.deepEqual(copies(), []);
});

// ------------------------------------------------------------------ behind the step: could not run, and out of time
test('wall and step: a wall that cannot run (a --with folder that is not there) is not a try: exit 64 and nothing on record', () => {
  const d = toy(), r = step(d, walled('echo 110 > src/score.txt', '--with', 'no-such-folder'));
  assert.equal(r.code, 64, r.err); assert.deepEqual(record(d), []); assert.ok(clean(d));
});
test('wall and step: an attempt behind the wall that says it could not run (exit 64) is not a try, and what it wrote in the copy is not kept', () => {
  const d = toy(), base = head(d), r = step(d, walled('echo 110 > src/score.txt; exit 64'));
  assert.equal(r.code, 64, r.err); assert.deepEqual(record(d), []); assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.ok(clean(d));
});
test('wall and step: an attempt that ran out of time is a try, on record as nothing (exit 3). It ran, and it was too slow', () => {
  const d = toy(), r = step(d, walled('echo 110 > src/score.txt; sleep 30', '--minutes', '0.01'));
  assert.equal(r.code, 3, r.err); assert.deepEqual(record(d).map((l) => l.result), ['nothing']); assert.ok(clean(d));
});

// ------------------------------------------------------------------ a time limit the timer cannot count
// Node's timer cannot count past 2,147,483,647 ms, about 35,791 minutes. Asked for more, it fires at once, so the
// wall used to end such an attempt in its first millisecond and call it out of time.
test('wall --minutes: a limit too long for the timer is refused (exit 64), and the attempt does not run', () => {
  const d = toy(), ran = out('ran');
  const r = wall(d, `touch ${ran}; echo 110 > src/score.txt`, '--minutes', '40000');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /35,?000/); assert.equal(existsSync(ran), false); assert.ok(clean(d));
});
test('wall --minutes: the longest limit it takes does run the attempt', () => {
  const d = toy(), r = wall(d, 'echo 110 > src/score.txt', '--minutes', '35000');
  assert.equal(r.code, 0, r.err); assert.equal(read(d, 'src/score.txt'), '110');
});
