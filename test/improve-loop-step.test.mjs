// What the loop's first home added to the step's tests: a list of what may change, and a count of gate asks.
//
// The step itself is PromptWheel's examples/improve-loop/improve.mjs with those two things added. Its own 83 tests
// are not copied here: check.sh runs them, as they are, against this step. Run: node --test  (through check.sh)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { HOME, STEP, asked, at, bump, clean, git, head, put, read, record, run, step, toy } from './improve-loop-helpers.mjs';

const GOOD = 'echo 110 > src/score.txt';
const rules = () => toy({ files: { 'rules/safety.md': 'never send the key\nask before a refund\n', 'docs/guide.md': 'how\n' } });

// ------------------------------------------------------------------ --may-change: what an attempt may touch
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

// ------------------------------------------------------------------ what a step cost: how often the gate was asked
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

// ------------------------------------------------------------------ git's own files are goalposts too
// Found on 2026-11-21 while the wall was being built. Git keeps hooks, config, attributes and refs where an attempt
// can write them, and the step and the gate both run git. Each of these got a bad change kept on the step as it
// stood. Now git's settings are read before the attempt and put back after it, every ref the attempt moved goes
// back, and after the attempt the step's git calls (and the gate's) run no hook and no fsmonitor command.
const stored = (d, f) => git(d, '--no-replace-objects', 'cat-file', '-p', `HEAD:${f}`);   // what a fresh clone would get
const hook = (d, name, body) => { put(d, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`); chmodSync(join(d, '.git/hooks', name), 0o755); return join(d, '.git/hooks', name); };
const config = (d, key) => { try { return git(d, 'config', '--get', key); } catch { return null; } };
const FILTER = (how) => `${how} filter.mine.clean "sed 's/^110$/90/'"; ${how} filter.mine.smudge "sed 's/^90$/110/'"`;
// a hook that moves the branch to a commit of its own (cost 300) as soon as the loop moves it
const MOVE_BRANCH = `t=$(GIT_INDEX_FILE=.git/x.idx sh -c 'git read-tree HEAD && git update-index --cacheinfo 100644,$(echo 300 | git hash-object -w --stdin),src/cost.txt && git write-tree'); rm -f .git/x.idx
mine=$(git commit-tree $t -p HEAD -m mine); base=$(git rev-parse HEAD)
printf '#!/bin/sh\\n[ "$1" = committed ] || exit 0\\n[ -n "$MINE" ] && exit 0\\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && [ "$new" != %s ] && [ "$new" != %s ] && MINE=1 git update-ref refs/heads/main %s; done\\nexit 0\\n' $base $mine $mine`;

test('git files: a hook an attempt plants cannot move the branch after the keep, and the hook is gone afterwards', () => {
  const d = toy();
  const r = step(d, `echo 110 > src/score.txt\n${MOVE_BRANCH} > .git/hooks/reference-transaction; chmod +x .git/hooks/reference-transaction`);
  assert.equal(r.code, 0, r.err);
  assert.equal(at(d, 'src/cost.txt'), '100', 'the branch holds the commit the gate judged'); assert.equal(at(d, 'src/score.txt'), '110'); assert.ok(clean(d));
  assert.ok(!existsSync(join(d, '.git/hooks/reference-transaction')), 'the planted hook is removed');
  assert.ok(record(d)[0].restored.includes('git hooks'), 'and the record says the attempt had touched the hooks');
});
test('git files: a hook that was there before the attempt stays, and an edit to it is undone, mode and all', () => {
  const d = toy(), f = hook(d, 'pre-push', 'exit 0');
  const r = step(d, 'echo 110 > src/score.txt; echo "echo mine" >> .git/hooks/pre-push; chmod -x .git/hooks/pre-push');
  assert.equal(r.code, 0, r.err); assert.equal(readFileSync(f, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.ok(statSync(f).mode & 0o100, 'and it can still be run');
});
test('git files: no hook runs inside the step after the attempt, not even one in a hooks folder the repo tracks', () => {
  // husky and others keep hooks in a tracked folder and point core.hooksPath at it. An attempt can edit a file there
  // like any other, and the step's own git calls would then run it.
  const d = toy({ files: { 'hooks/reference-transaction': '#!/bin/sh\nexit 0\n' } }), ran = `${d}.ran`;
  chmodSync(join(d, 'hooks/reference-transaction'), 0o755); git(d, 'update-index', '--chmod=+x', 'hooks/reference-transaction'); git(d, 'commit', '-qm', 'the hook can be run');
  git(d, 'config', 'core.hooksPath', 'hooks');
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho x >> ${ran}\\n' > hooks/reference-transaction`, '--label', 'edits a tracked hook', '--may-change', 'src/**');
  assert.equal(r.code, 1, r.err); assert.match(r.out, /outside .*hooks\/reference-transaction/);
  assert.ok(!existsSync(ran), 'the edited hook never ran, though the step moved refs while it was in the tree');
  const kept = toy({ files: { 'hooks/reference-transaction': '#!/bin/sh\nexit 0\n' } });
  chmodSync(join(kept, 'hooks/reference-transaction'), 0o755); git(kept, 'update-index', '--chmod=+x', 'hooks/reference-transaction'); git(kept, 'commit', '-qm', 'the hook can be run'); git(kept, 'config', 'core.hooksPath', 'hooks');
  const k = step(kept, `echo 110 > src/score.txt\n${MOVE_BRANCH} > hooks/reference-transaction`, '--label', 'a tracked hook that moves the branch');
  assert.equal(k.code, 0, k.err); assert.equal(at(kept, 'src/cost.txt'), '100', 'and one that would move the branch after a keep does not get to');
});
test('git files: a filter set in the repo\'s git config is gone before the change is judged: what is kept is what was measured', () => {
  const d = toy();
  const r = step(d, `${FILTER('git config')}; echo 'src/score.txt filter=mine' >> .git/info/attributes; echo 110 > src/score.txt`);
  assert.equal(r.code, 0, r.err);
  assert.equal(stored(d, 'src/score.txt'), '110', 'the commit holds the 110 the gate measured, not the 90 the filter would have stored');
  assert.equal(config(d, 'filter.mine.clean'), null); assert.equal(read(d, '.git/info/attributes'), null, 'the attributes file it made is removed');
  assert.deepEqual(record(d)[0].restored.sort(), ['git settings']);
});
test('git files: an edit to .git/info/exclude is undone, so a new file cannot be hidden from the change', () => {
  const d = toy(), before = read(d, '.git/info/exclude');
  const r = step(d, 'echo 110 > src/score.txt; echo "src/extra.txt" >> .git/info/exclude; echo 1 > src/extra.txt');
  assert.equal(r.code, 0, r.err); assert.equal(read(d, '.git/info/exclude'), before);
  assert.equal(at(d, 'src/extra.txt'), '1', 'the file is in the kept commit, where it can be seen'); assert.ok(clean(d));
});
test('git files: a replace ref an attempt adds is removed before the gate looks, so the worse cost is seen', () => {
  const d = toy();
  const r = step(d, 'echo 110 > src/score.txt; echo 120 > src/cost.txt; git replace $(git hash-object -w src/cost.txt) $(git rev-parse HEAD:src/cost.txt)');
  assert.equal(r.code, 1, r.err); assert.match(r.out, / worse .*cost 100 to 120/);
  assert.equal(git(d, 'for-each-ref', 'refs/replace'), ''); assert.equal(stored(d, 'src/cost.txt'), '100');
  assert.ok(record(d)[0].restored.includes('refs'));
});
test('git files: a tag or a branch an attempt makes is removed, and one it moves or deletes is put back', () => {
  const d = toy(); git(d, 'tag', 'v1'); git(d, 'branch', 'keep');
  const v1 = git(d, 'rev-parse', 'v1');
  const r = step(d, 'echo 110 > src/score.txt; git commit -qam mine; git tag -f v1; git tag new; git branch side; git branch -D keep');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(d, 'rev-parse', 'v1'), v1, 'the tag points where it did'); assert.equal(git(d, 'rev-parse', 'keep'), v1);
  assert.equal(git(d, 'for-each-ref', '--format=%(refname)', 'refs/tags/new', 'refs/heads/side'), '');
});
test('git files: core.fsmonitor set by an attempt never runs its command, in this step or the next', () => {
  const d = toy(), ran = `${d}.ran`;
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho x >> ${ran}\\n' > .git/mine.sh; chmod +x .git/mine.sh; git config core.fsmonitor .git/mine.sh`);
  assert.equal(r.code, 0, r.err); step(d, 'echo more >> README.md');
  assert.ok(!existsSync(ran), 'its command never ran'); assert.equal(config(d, 'core.fsmonitor'), null);
});
test('git files: a filter set in the global git config is undone too, and a file the attempt made there is removed', () => {
  const d = toy(); writeFileSync(join(HOME, '.gitconfig'), '[alias]\n\tst = status\n');
  try {
    const r = step(d, `${FILTER('git config --global')}; git config --global core.attributesFile "$HOME/.mine-attributes"; echo 'src/score.txt filter=mine' > "$HOME/.mine-attributes"; mkdir -p "$XDG_CONFIG_HOME/git"; echo 'src/score.txt filter=mine' > "$XDG_CONFIG_HOME/git/attributes"; echo 110 > src/score.txt`);
    assert.equal(r.code, 0, r.err);
    assert.equal(stored(d, 'src/score.txt'), '110', 'the commit holds what the gate measured');
    assert.equal(readFileSync(join(HOME, '.gitconfig'), 'utf8'), '[alias]\n\tst = status\n', 'your global config is as it was');
    assert.ok(!existsSync(join(HOME, '.config/git/attributes')), 'a global attributes file it made is removed');
    assert.match(r.out, new RegExp(`your git settings \\(${join(HOME, '.gitconfig').replace(/[.]/g, '\\.')}\\)`), 'and the line names the file in your home folder');
  } finally { for (const f of ['.gitconfig', '.mine-attributes']) rmSync(join(HOME, f), { force: true }); }
});
test('git files: a global config that did not exist before the attempt is removed again', () => {
  const d = toy(); assert.ok(!existsSync(join(HOME, '.gitconfig')));
  const r = step(d, 'git config --global core.fsmonitor /bin/true; echo 110 > src/score.txt');
  assert.equal(r.code, 0, r.err); assert.ok(!existsSync(join(HOME, '.gitconfig')));
});
test('git files: an attempt that touches none of them leaves no mark in the record', () => {
  const d = toy(); hook(d, 'pre-push', 'exit 0'); git(d, 'tag', 'v1');
  step(d, 'echo 110 > src/score.txt');
  assert.equal(record(d)[0].restored, undefined); assert.equal(record(d)[0].recordPutBack, undefined);
});
test('git files: an fsmonitor command the repo already had, kept as a tracked file, is not run by the step once an attempt has edited it', () => {
  const d = toy({ files: { 'tools/fsm.sh': '#!/bin/sh\nexit 1\n' } }), ran = `${d}.ran`;
  chmodSync(join(d, 'tools/fsm.sh'), 0o755); git(d, 'update-index', '--chmod=+x', 'tools/fsm.sh'); git(d, 'commit', '-qm', 'the script can be run'); git(d, 'config', 'core.fsmonitor', 'tools/fsm.sh');
  const r = step(d, `echo 110 > src/score.txt; printf '#!/bin/sh\\necho x >> ${ran}\\nexit 1\\n' > tools/fsm.sh`, '--label', 'edits the fsmonitor script', '--may-change', 'src/**');
  assert.equal(r.code, 1, r.err); assert.ok(!existsSync(ran), 'the edited script never ran'); assert.equal(config(d, 'core.fsmonitor'), 'tools/fsm.sh', 'and your own setting is as it was');
});
test('git files: a global config that is a link into a dotfiles folder is put back through the link, and stays a link', () => {
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
test('git files: a branch the attempt made and left the repo on is not removed: the step refuses, and the branch is there to look at', () => {
  const d = toy(), base = head(d);
  const r = step(d, 'git checkout -q -b elsewhere && echo 110 > src/score.txt && git commit -qam mine; git branch other');
  assert.equal(r.code, 64); assert.match(r.err, /another branch/);
  assert.equal(git(d, 'symbolic-ref', 'HEAD'), 'refs/heads/elsewhere'); assert.equal(at(d, 'src/score.txt'), '110', 'the branch it is on still holds its commit');
  assert.equal(git(d, 'rev-parse', 'main'), base); assert.equal(git(d, 'for-each-ref', '--format=%(refname)', 'refs/heads/other'), '', 'a branch it only made on the side is removed');
});
test('git files: a global config that is not a plain file (/dev/null) is left alone, and the step runs as ever', () => {
  const d = toy(), r = run(STEP, d, ['--attempt', 'echo 110 > src/score.txt'], { GIT_CONFIG_GLOBAL: '/dev/null' });
  assert.equal(r.code, 0, r.err); assert.ok(statSync('/dev/null').isCharacterDevice()); assert.equal(record(d)[0].restored, undefined);
});

// ------------------------------------------------------------------ an attempt that could not run is not a try
// Found in the first real run (2026-11-21): an attempt script crashed before its agent started, the step wrote
// "nothing" for each try, and a whole plan was used up in two seconds. 64 is how the programs here say "could not
// run" (the wall does). 126 and 127 are the shell saying the command could not be run or was not found.
test('could not run: an attempt that says it could not run (exit 64) is not a try: exit 64, no line on record, nothing judged', () => {
  const d = toy(), base = head(d), r = step(d, 'exit 64');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /could not run/); assert.equal(r.out, '');
  assert.deepEqual(record(d), []); assert.equal(asked(d), 0); assert.equal(head(d), base); assert.ok(clean(d));
});
test('could not run: a command the shell cannot find (127) or cannot run (126) is not a try either', () => {
  const missing = toy(); assert.equal(step(missing, 'no-such-command-anywhere').code, 64); assert.deepEqual(record(missing), []);
  const d = toy({ files: { 'tools/agent.sh': '#!/bin/sh\necho 110 > src/score.txt\n' } });   // tracked, and not marked as a program
  const r = step(d, './tools/agent.sh');
  assert.equal(r.code, 64, r.err); assert.match(r.err, /exit 126/); assert.deepEqual(record(d), []); assert.ok(clean(d));
});
test('could not run: an attempt that fails in any other way and changed no file is still a try, on record as nothing (exit 3)', () => {
  const d = toy(), r = step(d, 'exit 7');
  assert.equal(r.code, 3, r.err); assert.deepEqual(record(d).map((l) => l.result), ['nothing']);
});
test('could not run: exit 64 after files were changed puts them back, and nothing is judged or kept', () => {
  const d = toy(), base = head(d), r = step(d, `${GOOD}; echo junk > new.txt; exit 64`);
  assert.equal(r.code, 64, r.err); assert.equal(head(d), base); assert.equal(read(d, 'src/score.txt'), '100'); assert.equal(existsSync(join(d, 'new.txt')), false); assert.ok(clean(d));
  assert.deepEqual(record(d), []); assert.equal(asked(d), 0, 'the gate is not asked');
});
test('could not run: a command that changed files and then ended 127 ran in part, so its change is judged like any other', () => {
  const d = toy(), r = step(d, `${GOOD}; no-such-command-anywhere`);
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110'); assert.deepEqual(record(d).map((l) => l.result), ['kept']);
});
test('could not run: it uses up no number: the try after it is try 1', () => {
  const d = toy(); assert.equal(step(d, 'exit 64').code, 64); const r = step(d, GOOD);
  assert.equal(r.code, 0, r.err); assert.deepEqual(record(d).map((l) => [l.n, l.result]), [[1, 'kept']]);
});
test('could not run: the loop\'s own files are still put back when the attempt wrote them and then said it could not run', () => {
  const d = toy(); step(d, GOOD);   // try 1 is on record
  const before = readFileSync(join(d, '.git/improve/attempts.jsonl'), 'utf8');
  const r = step(d, 'echo forged >> "$IMPROVE_RECORD"; exit 64');
  assert.equal(r.code, 64, r.err); assert.equal(readFileSync(join(d, '.git/improve/attempts.jsonl'), 'utf8'), before);
});

// ------------------------------------------------------------------ could not run, in a run over turns
test('could not run, over turns: a first turn that could not run is not a try: exit 64 and nothing on record', () => {
  const d = toy(), r = step(d, 'exit 64', '--turns', '3');
  assert.equal(r.code, 64, r.err); assert.deepEqual(record(d), []); assert.ok(clean(d));
});
test('could not run, over turns: at a later turn the run ends there, and a turn that had passed its check is kept', () => {
  const d = toy(), r = step(d, 'if [ "$PW_TURN" = 1 ]; then echo 110 > src/score.txt; else exit 64; fi', '--turns', '3');
  assert.equal(r.code, 0, r.err); assert.equal(at(d, 'src/score.txt'), '110'); assert.ok(clean(d));
  assert.match(record(d).pop().why, /could not run at turn 2/);
});
test('could not run, over turns: at a later turn with nothing ahead, all of it is put back and the line says why (exit 64)', () => {
  const d = toy(), base = head(d), r = step(d, 'if [ "$PW_TURN" = 1 ]; then echo 120 > src/cost.txt; else exit 64; fi', '--turns', '3');
  assert.equal(r.code, 64, r.err); assert.equal(head(d), base); assert.equal(read(d, 'src/cost.txt'), '100'); assert.ok(clean(d));
  const last = record(d).pop(); assert.equal(last.result, 'stopped'); assert.match(last.why, /could not run \(exit 64\) at turn 2/);
});

// ------------------------------------------------------------------ a git too old to hold the hooks off
// The step turns hooks off for its own git calls through GIT_CONFIG_COUNT. A git older than 2.31 ignores that and
// says nothing, so the step must not run on one.
const oldGit = (version) => {   // a folder to put first in PATH: git that says it is an old version, and is the real git for the rest
  const bin = join(HOME, `oldgit-${version}`); mkdirSync(bin, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = --version ] && { echo "git version ${version}"; exit 0; }\nexec ${real} "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
};
test('old git: the step refuses to run on a git older than 2.31 (exit 64), and the attempt does not run', () => {
  const d = toy(), r = run(STEP, d, ['--attempt', GOOD], oldGit('2.30.9'));
  assert.equal(r.code, 64, r.err); assert.match(r.err, /2\.31/); assert.equal(read(d, 'src/score.txt'), '100'); assert.deepEqual(record(d), []);
});
test('old git: 2.31 itself, and a newer git with a longer version string, are taken', () => {
  for (const version of ['2.31.0', '2.43.0.windows.1', '3.0.0']) {
    const d = toy(), r = run(STEP, d, ['--attempt', GOOD], oldGit(version));
    assert.equal(r.code, 0, `${version}: ${r.err}`);
  }
});
test('old git: a version it cannot read is refused too: it does not guess', () => {
  const d = toy(), r = run(STEP, d, ['--attempt', GOOD], oldGit('unknown'));
  assert.equal(r.code, 64, r.err); assert.deepEqual(record(d), []);
});

// The step reads the gate's report through a pipe. A report longer than a pipe holds (64 KB) arrived cut from a gate
// that ended with process.exit(), so the step could not read it: the change was put back, no line was written, and
// the step said "could not run". PromptWheel's gate ends by itself since 0.8.16. Seen with real runs on 2026-11-22.
test('step: a change so wide that the gate\'s report is longer than a pipe holds is still judged, and kept when it is a gain', () => {
  const d = toy(), before = head(d);
  const r = step(d, 'mkdir -p test && i=0 && while [ $i -lt 3000 ]; do echo "// $i" > test/case-$i-a-test-file-with-a-long-name.test.mjs; i=$((i+1)); done && echo 101 > src/score.txt');
  assert.equal(r.code, 0, r.out + r.err); assert.notEqual(head(d), before); assert.ok(clean(d));
  assert.equal(record(d).length, 1); assert.equal(record(d)[0].result, 'kept');
});

// Node holds 1 MB from one read of a program it runs. Git's list of a change of some 20,000 files is more than that,
// and so is the gate's report on it: the step ended with ENOBUFS, put the change back, wrote no line, and said "could
// not run", so the try was on no record (the framework session's runs, 2026-11-22). The step now reads with room.
const LONG = 'a-test-file-with-a-name-long-enough-that-ten-thousand-of-them-hold-more-than-one-megabyte';
test('step: a change whose file list and gate report are each more than 1 MB is judged like any other, and kept when it is a gain', () => {
  const d = toy(), before = head(d);
  const r = step(d, `mkdir -p test && i=0 && while [ $i -lt 10000 ]; do echo "// $i" > test/case-$i-${LONG}.test.mjs; i=$((i+1)); done && echo 101 > src/score.txt`);
  assert.equal(r.code, 0, r.out + r.err); assert.notEqual(head(d), before); assert.ok(clean(d));
  assert.equal(record(d).length, 1); assert.equal(record(d)[0].result, 'kept');
});
// The other way to be too wide: the change itself is small and was stored, and it is the check's answer that is wider
// than the step reads. That try is on record too, and what it changed stays readable under its number, named by its
// line (the step's own header says every attempt's does). Before 2026-11-22 the line named no change while the ref
// held one, so the report read "not whole"; the first rule for refs written that night then took the ref away, and a
// second reader found that. Seen failing on both.
test('step: a change whose check is too wide to read is on record, and what it changed can still be read back under its number', () => {
  const d = toy(), before = head(d);
  const r = run(STEP, d, ['--attempt', 'echo 110 > src/score.txt'], { IMPROVE_READ_MAX: '600' });
  assert.equal(r.code, 3, r.out + r.err); assert.equal(head(d), before); assert.ok(clean(d), 'the change is put back');
  const line = record(d)[0];
  assert.equal(line.result, 'nothing'); assert.match(line.why, /too wide to read/);
  assert.ok(line.candidate, 'the line names the change'); assert.equal(git(d, 'rev-parse', '--verify', '-q', 'refs/improve/1'), line.candidate);
  assert.equal(git(d, 'show', `${line.candidate}:src/score.txt`), '110', 'and it is the change the attempt made');
});
test('step: a change too wide for the step to read is put back and on record as one that could not be measured, never left off', () => {
  const d = toy(), before = head(d);
  const r = run(STEP, d, ['--attempt', `i=0 && while [ $i -lt 100 ]; do echo "// $i" > src/case-$i-${LONG}.txt; i=$((i+1)); done && echo 101 > src/score.txt`], { IMPROVE_READ_MAX: '2000' });
  assert.equal(r.code, 3, r.out + r.err); assert.equal(head(d), before); assert.ok(clean(d), 'the change is put back');
  assert.equal(record(d).length, 1, 'the try is on record'); assert.equal(record(d)[0].result, 'nothing'); assert.match(record(d)[0].why, /too wide to read/);
  // here the change is too wide even to list, so no copy of it was ever stored: the line names none and no ref is left
  assert.equal(record(d)[0].candidate, undefined); assert.equal(git(d, 'for-each-ref', '--format=%(refname)', 'refs/improve'), '');
});
