// A run under a committed plan, and the report made from what it left behind.
//
// The proposer in these tests is a script that does one listed thing per try. It sits outside every repo.
// Run: node --test  (through check.sh)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV, NODE, REPORT, RUN, TMP_ROOT, asked, at, bump, clean, git, head, lines, put, read, record, run, step, toy } from './improve-loop-helpers.mjs';

let made = 0;
// a proposer: try k runs line k of `acts`. Returns the attempt command for a plan.
const proposer = (acts) => {
  const base = join(TMP_ROOT, `proposer-${++made}`);
  writeFileSync(`${base}.acts`, acts.join('\n') + '\n');
  writeFileSync(`${base}.sh`, `n=$(cat ${base}.n 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${base}.n\nsh -c "$(sed -n "\${n}p" ${base}.acts)"\n`);
  return `sh ${base}.sh`;
};
const planned = (acts, plan = {}, over = {}) => {
  const d = toy(over);
  put(d, 'improve.plan.json', JSON.stringify({ attempt: proposer(acts), tries: acts.length, mayChange: ['src/**'], ...plan }, null, 2) + '\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'the plan');
  return d;
};
const go = (d, args = [], env = {}) => run(RUN, d, args, env);
const report = (d, ...flags) => run(REPORT, d, flags);
const runs = (d) => lines(join(d, '.git/improve/runs.jsonl'));
const results = (d) => record(d).map((l) => l.result);
const WIN = 'echo 110 > src/score.txt', WIN2 = 'echo 115 > src/score.txt', WORSE = 'echo 120 > src/cost.txt', OUTSIDE = 'echo 120 > src/score.txt; echo more >> README.md', NOTHING = 'true';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dropLine = (d, n) => { const f = join(d, '.git/improve/attempts.jsonl'); writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).n !== n).join('\n') + '\n'); };

// ------------------------------------------------------------------ a run
test('run: it starts from a committed plan, makes every try through the step, and ends when the tries are used', () => {
  const d = planned([WIN, WORSE, OUTSIDE, WIN2]), base = head(d);
  const r = go(d);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(results(d), ['kept', 'worse', 'outside', 'kept']); assert.deepEqual(record(d).map((l) => l.label), ['try 1 of 4', 'try 2 of 4', 'try 3 of 4', 'try 4 of 4']);
  assert.equal(git(d, 'rev-list', '--count', `${base}..HEAD`), '2'); assert.equal(at(d, 'src/score.txt'), '115'); assert.equal(at(d, 'README.md'), 'toy'); assert.ok(clean(d));
  const [begin, end] = runs(d);
  assert.equal(begin.base, base); assert.equal(begin.from, 1); assert.equal(begin.planBlob, git(d, 'rev-parse', `${base}:improve.plan.json`)); assert.equal(begin.plan.tries, 4);
  assert.equal(end.ended, 'tries'); assert.equal(end.to, 4); assert.deepEqual(end.results, results(d)); assert.equal(end.head, head(d));
  assert.match(r.out, / 1 {2}kept .*\n {2}2 {2}worse .*\n {2}3 {2}outside .*\n {2}4 {2}kept .*\nrun: 4 tries, 2 kept\. Every try in the plan is used\./);
});
test('run: a plan that is not committed is refused, and no try runs (exit 64)', () => {
  const none = toy(); assert.equal(go(none).code, 64); assert.match(go(none).err, /no committed plan/);
  const loose = toy(); put(loose, 'improve.plan.json', JSON.stringify({ attempt: WIN, tries: 1, mayChange: ['src/**'] }));
  assert.equal(go(loose).code, 64); assert.match(go(loose).err, /not clean/);
  const edited = planned([WIN]); put(edited, 'improve.plan.json', JSON.stringify({ attempt: WIN, tries: 9, mayChange: ['**'] }));
  assert.equal(go(edited).code, 64); assert.deepEqual(record(edited), []);
});
test('run: the plan is read once, from HEAD: a try that rewrites the plan changes nothing about its run, and is put back', () => {
  const d = planned([`${WIN}; echo '{"attempt":"true","tries":99,"mayChange":["**"]}' > improve.plan.json`, WIN]), plan = at(d, 'improve.plan.json');
  const r = go(d);
  assert.equal(r.code, 0, r.err); assert.deepEqual(results(d), ['outside', 'kept']); assert.equal(at(d, 'improve.plan.json'), plan);
});
test('run: a plan must say what may change, and the list may not let a try edit the plan', () => {
  const open = toy(); put(open, 'improve.plan.json', JSON.stringify({ attempt: WIN, tries: 1 })); git(open, 'add', '-A'); git(open, 'commit', '-qm', 'plan');
  assert.equal(go(open).code, 64); assert.match(go(open).err, /must say "mayChange"/);
  for (const list of [['**'], ['*.json'], ['src/**', 'improve.plan.json'], ['/improve.plan.json']]) {
    const d = planned([WIN], { mayChange: list }), r = go(d);
    assert.equal(r.code, 64, JSON.stringify(list)); assert.match(r.err, /edit the plan itself/); assert.deepEqual(record(d), []);
  }
});
test('run: a key it does not know, a value of the wrong kind, or a missing attempt is exit 64 before any try', () => {
  for (const plan of [{ trys: 3 }, { tries: 0 }, { tries: '3' }, { mayChange: [] }, { mayChange: 'src/**' }, { mayChange: ['a,b'] }, { floor: 'yes' }, { wall: { minute: 5 } }, { wall: { with: 'node_modules' } }, { stopAfterFlat: -1 }, { arms: {} }, { attempt: '' }, { heldOut: 7 }]) {
    const d = planned([WIN], plan), r = go(d, plan.arms ? ['--arm', 'x'] : []);
    assert.equal(r.code, 64, JSON.stringify(plan)); assert.deepEqual(record(d), [], JSON.stringify(plan));
  }
  const d = planned([WIN]); assert.equal(go(d, ['--plans', 'x']).code, 64); assert.equal(go(d, ['--plan']).code, 64); assert.equal(go(d, ['--plan', 'other.json']).code, 64);
});
test('run: without the gate named in PROMPTWHEEL it never starts (exit 64)', () => {
  const d = planned([WIN]), r = go(d, [], { PROMPTWHEEL: '' });
  assert.equal(r.code, 64); assert.match(r.err, /PROMPTWHEEL/); assert.deepEqual(runs(d), []);
});
test('run: stopAfterFlat ends the run early when tries in a row keep nothing', () => {
  const d = planned([WIN, WORSE, NOTHING, WIN2, WIN2], { stopAfterFlat: 2 }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.deepEqual(results(d), ['kept', 'worse', 'nothing']); assert.equal(runs(d)[1].ended, 'flat');
  assert.match(r.out, /Stopped: 2 tries in a row kept nothing/);
});
test('run: started again after its tries are used, it makes no more', () => {
  const d = planned([WIN, WORSE]); go(d);
  const r = go(d);
  assert.equal(r.code, 0); assert.match(r.out, /used up/); assert.equal(record(d).length, 2); assert.equal(runs(d).length, 2);
});
test('run: a try that could not run ends the run (exit 1), and the next start goes on with the tries that are left', () => {
  const d = planned([WIN, WIN2, WORSE]);
  const r = go(d, [], { PROMPTWHEEL: `${NODE} /no/such/gate.mjs` });
  assert.equal(r.code, 1); assert.match(r.out, /could not run/); assert.equal(runs(d)[1].ended, 'could not run'); assert.ok(clean(d));
  const again = go(d);
  assert.equal(again.code, 0, again.err); assert.equal(runs(d).length, 4); assert.equal(runs(d)[3].ended, 'tries');
});
test('run: a plan whose time limit is too long for the timer is refused before any try (exit 64)', () => {
  const d = planned([WIN], { wall: { minutes: 40000 } });
  const r = go(d);
  assert.equal(r.code, 64, r.err); assert.match(r.err, /wall/); assert.deepEqual(record(d), []); assert.deepEqual(runs(d), []);
});
test('run: an attempt that cannot run stops the run at once, and none of the plan\'s tries is used up', () => {
  const d = planned(['exit 64', WIN, WIN2]);   // the attempt's first call says it could not run. The two after it are real tries
  const r = go(d);
  assert.equal(r.code, 1); assert.match(r.out, /0 tries, 0 kept\. A try could not run/); assert.deepEqual(record(d), []);
  assert.equal(runs(d)[1].ended, 'could not run'); assert.deepEqual(runs(d)[1].results, []); assert.ok(clean(d));
  const again = go(d);
  assert.equal(again.code, 0, again.err); assert.deepEqual(record(d).map((l) => l.label), ['try 1 of 3', 'try 2 of 3', 'try 3 of 3'], 'all three tries were still there');
  assert.deepEqual(results(d), ['kept', 'kept', 'nothing']);
});
test('run: stopped with Ctrl-C, the try in hand is put back, and the next start goes on from there with the count carried over', async () => {
  const began = join(TMP_ROOT, `began-${++made}`);
  const d = planned([WIN, `echo 120 > src/cost.txt; touch ${began}; sleep 30`, WIN2, WORSE]);
  const child = spawn(NODE, [RUN], { cwd: d, env: ENV, detached: true, stdio: 'ignore' });
  const done = new Promise((res) => child.on('exit', (code) => res(code)));
  for (let i = 0; i < 300 && !existsSync(began); i++) await sleep(50);
  process.kill(-child.pid, 'SIGINT');
  assert.equal(await Promise.race([done, sleep(20000).then(() => 'still running')]), 1);
  assert.deepEqual(results(d), ['kept', 'stopped']); assert.ok(clean(d)); assert.equal(read(d, 'src/cost.txt'), '100');
  assert.equal(runs(d)[1].ended, 'stopped'); assert.deepEqual(runs(d)[1].results, ['kept', 'stopped']);
  const again = go(d);
  assert.equal(again.code, 0, again.err); assert.deepEqual(record(d).map((l) => l.label), ['try 1 of 4', 'try 2 of 4', 'try 3 of 4', 'try 4 of 4']);
  assert.deepEqual(results(d), ['kept', 'stopped', 'kept', 'worse']); assert.equal(runs(d)[2].triesBefore, 2); assert.equal(runs(d)[2].from, 3);
  assert.equal(report(d).code, 0, 'and the report reads the two starts as whole');
});
test('run: a run that was killed is closed from the record at the next start, and marked as such', () => {
  const d = planned([WIN, WORSE]); go(d);
  const f = join(d, '.git/improve/runs.jsonl'); writeFileSync(f, readFileSync(f, 'utf8').split('\n')[0] + '\n');   // as if it died before its end line
  assert.equal(report(d).code, 1, 'until then the report says the run has no end');
  const r = go(d);
  assert.equal(r.code, 0, r.err); assert.equal(runs(d)[1].ended, 'lost'); assert.equal(runs(d)[1].fromRecord, true); assert.deepEqual(runs(d)[1].results, ['kept', 'worse']);
  assert.equal(report(d).code, 0);
});

// ------------------------------------------------------------------ what the plan turns on
test('run: the wall is on unless the plan turns it off', () => {
  const where = join(TMP_ROOT, `where-${++made}`);
  const on = planned([`pwd > ${where}; ${WIN}`]); go(on);
  assert.notEqual(readFileSync(where, 'utf8').trim(), on); assert.equal(results(on)[0], 'kept');
  const off = planned([`pwd > ${where}; ${WIN}`], { wall: false }); go(off);
  assert.equal(readFileSync(where, 'utf8').trim(), off);
});
test('run: the plan\'s wall settings reach the wall: with, minutes and record', () => {
  const note = join(TMP_ROOT, `note-${++made}`);
  const d = planned([`{ ls node_modules/dep; echo "[$IMPROVE_RECORD]"; } > ${note} 2>&1; ${WIN}`, 'sleep 30'], { wall: { with: ['node_modules'], minutes: 0.02, record: false } }, { untracked: { 'node_modules/dep/x.js': 'x\n' } });
  const began = Date.now(), r = go(d);
  assert.equal(r.code, 0, r.err); assert.equal(readFileSync(note, 'utf8'), 'x.js\n[]\n');
  assert.deepEqual(results(d), ['kept', 'nothing'], 'the second try ran out of time, so nothing came back'); assert.ok(Date.now() - began < 20000);
});
test('run: the floor is on unless the plan turns it off', () => {
  const trade = `${bump('src/score.txt', -5)} && ${bump('src/cost.txt', -10)}`, band = { score: { noise: 10 } };
  const held = planned([trade, trade, trade, trade], { cheaper: 'cost' }, band); go(held);
  assert.deepEqual(results(held), ['kept', 'kept', 'worse', 'worse']); assert.equal(at(held, 'src/score.txt'), '90');
  const open = planned([trade, trade, trade, trade], { cheaper: 'cost', floor: false }, band); go(open);
  assert.deepEqual(results(open), ['kept', 'kept', 'kept', 'kept']); assert.equal(at(open, 'src/score.txt'), '80');
});
test('run: the base is measured once for tries that share it, unless the plan turns the cache off', () => {
  const cached = planned([WORSE, WORSE, WORSE]); go(cached);
  const plain = planned([WORSE, WORSE, WORSE], { baseCache: false }); go(plain);
  assert.equal(asked(cached), 4, 'the base once, and each try once'); assert.equal(asked(plain), 6);
});
test('run: arms. A plan with arms needs one named, its keys replace the plan\'s, and a clone runs one arm only', () => {
  const d = planned([WIN, WIN2], { arms: { short: { tries: 1 }, long: {} } });
  assert.equal(go(d).code, 64); assert.match(go(d).err, /--arm/); assert.equal(go(d, ['--arm', 'nope']).code, 64);
  const r = go(d, ['--arm', 'short']);
  assert.equal(r.code, 0, r.err); assert.deepEqual(record(d).map((l) => l.label), ['short: try 1 of 1']); assert.equal(runs(d)[0].arm, 'short');
  const other = go(d, ['--arm', 'long']);
  assert.equal(other.code, 64); assert.match(other.err, /One arm a clone/); assert.equal(record(d).length, 1);
  const bad = planned([WIN], { arms: { x: { arms: { y: {} } } } }); assert.equal(go(bad, ['--arm', 'x']).code, 64);
});
test('run: held-out is measured at the start and at the end only, and no try is shown it', () => {
  const count = join(TMP_ROOT, `held-${++made}`), seen = join(TMP_ROOT, `seen-${++made}`);
  const d = planned([`cat "$IMPROVE_RECORD" > ${seen} 2>/dev/null; env >> ${seen}; ${WIN}`, WORSE, `cat "$IMPROVE_RECORD" >> ${seen}; ${WIN2}`], { heldOut: `echo x >> ${count}; echo $(( $(cat src/score.txt) * 2 ))` });
  const r = go(d);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 2, 'two readings for three tries');
  assert.equal(runs(d)[0].heldOut, 200); assert.equal(runs(d)[1].heldOut, 230);
  assert.doesNotMatch(readFileSync(seen, 'utf8'), /heldOut|held-out|\b200\b|\b230\b/, 'nothing a try was handed names it or holds its numbers');
  assert.match(report(d).out, /held-out: 200 at the start, 230 at the end/);
});
test('run: a last held-out number that could not be read is measured on the next start, once, and the report then shows it', () => {
  const count = join(TMP_ROOT, `held-late-${++made}`);
  // the command works at the start, fails at the end of the run, and works from then on
  const d = planned([WIN], { heldOut: `n=$(cat ${count} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${count}; [ $n = 2 ] && exit 1; echo $(( $(cat src/score.txt) * 2 ))` });
  assert.equal(go(d).code, 0); assert.equal(runs(d)[0].heldOut, 200); assert.equal(runs(d)[1].heldOut, null);
  assert.match(report(d).out, /held-out: 200 at the start, could not be read at the end/);
  const again = go(d);
  assert.equal(again.code, 0, again.err); assert.match(again.out, /used up/); assert.match(again.out, /220/);
  assert.equal(runs(d).length, 3); assert.deepEqual([runs(d)[2].run, runs(d)[2].heldOutLate], [1, 220]);
  assert.match(report(d).out, /held-out: 200 at the start, 220 at the end/); assert.equal(report(d).code, 0, 'and the accounts still agree');
  go(d); assert.equal(readFileSync(count, 'utf8').trim(), '3', 'once the number is there, the command is not asked again');
  assert.deepEqual(results(d), ['kept'], 'and no try was made on the way');
});
test('run: a last held-out number that was read is not measured again on a later start', () => {
  const count = join(TMP_ROOT, `held-once-${++made}`);
  const d = planned([WIN], { heldOut: `echo x >> ${count}; echo 7` });
  go(d); go(d); go(d);
  assert.equal(readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 2, 'the start and the end, and never again'); assert.equal(runs(d).length, 2);
});
test('run: a held-out command that fails or prints no number is on record as not read, and the run goes on', () => {
  const d = planned([WIN], { heldOut: 'echo not-a-number' }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.equal(runs(d)[0].heldOut, null); assert.match(report(d).out, /held-out: could not be read at the start/);
  for (const cmd of ['echo 7; exit 1', 'true']) {   // a number from a command that failed, and no output at all
    const x = planned([WIN], { heldOut: cmd }); go(x);
    assert.equal(runs(x)[0].heldOut, null, cmd); assert.equal(runs(x)[1].heldOut, null, cmd);
  }
});
test('run: a try that edits the run\'s own account has it put back, and the end line says so', () => {
  const note = join(TMP_ROOT, `account-${++made}`);
  const d = planned([`: > .git/improve/runs.jsonl; ${WIN}`, `cat .git/improve/runs.jsonl > ${note}; ${WORSE}`], { wall: false }), r = go(d);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(note, 'utf8'), /"begin":true/, 'it was back in place before the next try began, not only at the end');
  assert.equal(runs(d).length, 2); assert.equal(runs(d)[0].begin, true); assert.equal(runs(d)[1].runsPutBack, true); assert.equal(report(d).code, 0);
});

// ------------------------------------------------------------------ the report
test('report: every try of a run is listed, kept or put back, with the counts, the score\'s path and what the gate cost', () => {
  const d = planned([WIN, WORSE, OUTSIDE, WIN2]); go(d);
  const r = report(d);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^run 1: plan improve\.plan\.json \([0-9a-f]{12}\), began .* at [0-9a-f]{12}\n {2}4 of 4 tries\. Ended: every try in the plan was used\. May change: src\/\*\*\. Wall: on\./);
  assert.match(r.out, /kept 2 of 4 \(50%\) · worse 1 · outside 1/); assert.match(r.out, /score: 100 at the start, 115 now/); assert.match(r.out, /the gate was asked 3 times/);
  for (const [n, word] of [[1, 'kept'], [2, 'worse'], [3, 'outside'], [4, 'kept']]) assert.match(r.out, new RegExp(`\\n {4}${n} {2}${word} `));
  assert.match(r.out, /whole: yes/);
  const j = JSON.parse(report(d, '--json').out);
  assert.equal(j.whole, true); assert.equal(j.runs[0].kept, 2); assert.deepEqual(j.runs[0].list.map((t) => t.result), ['kept', 'worse', 'outside', 'kept']); assert.equal(j.runs[0].list[1].change, 'refs/improve/2');
});
test('report: a try that was put back cannot be left out. Delete its line and the report says the record is not whole (exit 1)', () => {
  const d = planned([WIN, WORSE, WIN2]); go(d);
  dropLine(d, 2);
  const r = report(d);
  assert.equal(r.code, 1); assert.match(r.out, /whole: no/);
  assert.match(r.out, /a try is missing/); assert.match(r.out, /refs\/improve\/2 holds a change, and the record has no line for it/); assert.match(r.out, /run 1 saw 3 tries \(kept, worse, kept\), and the record holds 2/);
  assert.equal(JSON.parse(report(d, '--json').out).whole, false); assert.equal(report(d, '--json').code, 1);
});
test('report: the last try of a run, one that changed nothing and so left no ref, cannot be dropped either: the run\'s account names it', () => {
  const d = planned([WIN, NOTHING]); go(d);
  dropLine(d, 2);
  const r = report(d);
  assert.equal(r.code, 1); assert.match(r.out, /run 1 saw 2 tries \(kept, nothing\), and the record holds 1 for it \(kept\)/);
});
test('report: a kept change that is no longer in the branch, and a put-back change that can no longer be read, are both named', () => {
  const d = planned([WIN, WORSE]); go(d);
  git(d, 'update-ref', '-d', 'refs/improve/2'); git(d, 'reset', '-q', '--hard', 'HEAD~1');
  const r = report(d);
  assert.equal(r.code, 1); assert.match(r.out, /try 1 was kept, and its commit is not in the branch now/); assert.match(r.out, /try 2: the change it made can no longer be read/);
});
test('report: tries made by hand, outside any run, are listed apart', () => {
  const d = planned([WIN]); step(d, WORSE); go(d);
  const r = report(d);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /run 1: [\s\S]* 2 {2}kept [\s\S]*tries made outside a run[\s\S]* 1 {2}worse /);
});
test('report: it says which tries touched the loop\'s own files', () => {
  const d = planned([`git tag sneaky; ${WIN}`], { wall: false }); go(d);
  assert.match(report(d).out, /try 1 touched the loop's own files, which were put back: refs/);
});
test('report: with no record at all it is exit 64, and a flag it does not know is too', () => {
  const d = toy(); assert.equal(report(d).code, 64); assert.equal(run(REPORT, TMP_ROOT, []).code, 64);
  const ran = planned([WIN]); go(ran); assert.equal(report(ran).code, 0); assert.equal(report(ran, '--jsn').code, 64);
});
test('report: a line of the record that cannot be read is named, and the report is not whole', () => {
  const d = planned([WIN]); go(d);
  const f = join(d, '.git/improve/attempts.jsonl'); writeFileSync(f, readFileSync(f, 'utf8') + '{"n": 2, "result": \n');
  const r = report(d);
  assert.equal(r.code, 1); assert.match(r.out, /the record: line 2 cannot be read/);
});

// ------------------------------------------------------------------ no room left ("best" in the plan)
// Found in the first real run (2026-11-21): one arm stood at 68 of 70 after try 4. The band was 3, so no change
// could be kept any more, and 16 more tries ran.
test('run: best: the run stops when the target has reached its best value, and the tries left are not used', () => {
  const d = planned([WIN, WIN2, WIN2], { best: 110 }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.deepEqual(results(d), ['kept']); assert.equal(runs(d)[1].ended, 'no room');
  assert.match(r.out, /no room left/); assert.match(r.out, /score stands at 110/);
});
test('run: best: with a band on the target, it stops as soon as what is left to gain is no more than the band', () => {
  const d = planned(['echo 103 > src/score.txt', WIN, WIN], { best: 104 }, { score: { noise: 5 } }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.equal(record(d).length, 1); assert.notEqual(results(d)[0], 'kept'); assert.equal(runs(d)[1].ended, 'no room');
  assert.match(r.out, /more than 5 /);
});
test('run: best: while more than the band is left to gain, the run goes on', () => {
  const d = planned(['echo 103 > src/score.txt', 'echo 104 > src/score.txt', 'echo 102 > src/score.txt'], { best: 106 }, { score: { noise: 5 } }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.equal(record(d).length, 3); assert.equal(runs(d)[1].ended, 'tries');
});
test('run: best: exactly the band left is no room, and one more than the band is room', () => {
  const none = planned(['echo 101 > src/score.txt', WIN], { best: 105 }, { score: { noise: 5 } }); go(none);
  assert.equal(record(none).length, 1); assert.equal(runs(none)[1].ended, 'no room');
  const some = planned(['echo 101 > src/score.txt', 'echo 106 > src/score.txt'], { best: 106 }, { score: { noise: 5 } }); go(some);
  assert.equal(record(some).length, 2); assert.deepEqual(results(some).slice(-1), ['kept']);
});
test('run: best: a target that counts down has its best at the low end', () => {
  const d = planned(['echo 90 > src/cost.txt', 'echo 85 > src/cost.txt', 'echo 80 > src/cost.txt'], { target: 'cost', best: 85 }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.deepEqual(results(d), ['kept', 'kept']); assert.equal(runs(d)[1].ended, 'no room'); assert.match(r.out, /cost stands at 85/);
});
test('run: best: a try that measured nothing says nothing about room, and the next reading does', () => {
  const d = planned([NOTHING, 'echo 99 > src/score.txt', WIN], { best: 100 }), r = go(d);
  assert.equal(r.code, 0, r.err); assert.deepEqual(results(d), ['nothing', 'worse']); assert.equal(runs(d)[1].ended, 'no room');
});
test('run: best: the held-out number is measured at the end of a run that stopped for no room', () => {
  const d = planned([WIN, WIN2], { best: 110, heldOut: 'echo $(( $(cat src/score.txt) * 2 ))' }); go(d);
  assert.equal(runs(d)[0].heldOut, 200); assert.equal(runs(d)[1].ended, 'no room'); assert.equal(runs(d)[1].heldOut, 220);
});
test('run: best: started again when there is no room left, it starts nothing and measures nothing', () => {
  const count = join(TMP_ROOT, `held-${++made}`);
  const d = planned([WIN, WIN2, WIN2], { best: 110, heldOut: `echo x >> ${count}; echo 1` }); go(d);
  const r = go(d);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /no room left/); assert.equal(record(d).length, 1); assert.equal(runs(d).length, 2, 'no new run was begun');
  assert.equal(readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 2, 'the held-out command was not run again');
});
test('run: best: a held-out number lost at the end of a run that stopped for no room is measured at the next start', () => {
  const count = join(TMP_ROOT, `held-${++made}`);
  const d = planned([WIN, WIN2], { best: 110, heldOut: `n=$(cat ${count} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${count}; [ $n = 2 ] && exit 1; echo $(( $(cat src/score.txt) * 2 ))` });
  assert.equal(go(d).code, 0); assert.equal(runs(d)[1].ended, 'no room'); assert.equal(runs(d)[1].heldOut, null);
  assert.match(report(d).out, /could not be read at the end/, 'the run did finish: its number is missing, not unmeasured');
  const r = go(d); assert.equal(r.code, 0, r.err); assert.equal(runs(d).pop().heldOutLate, 220);
});
test('run: best: a reading taken at another commit says nothing about this one', () => {
  const d = planned([WIN, WIN2, 'echo 108 > src/score.txt'], { best: 110 }); go(d);
  assert.equal(record(d).length, 1);
  put(d, 'src/score.txt', '90\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'by hand: the score falls');
  const r = go(d); assert.equal(r.code, 0, r.err); assert.equal(record(d).length, 2, 'a try was made: the last reading was of another commit');
});
test('run: best: the plan may not also say cheaper, and best must be a number (exit 64 before any try)', () => {
  for (const plan of [{ best: 110, cheaper: 'cost' }, { best: '110' }, { best: null }]) {
    const d = planned([WIN], plan), r = go(d);
    assert.equal(r.code, 64, JSON.stringify(plan)); assert.deepEqual(record(d), [], JSON.stringify(plan));
  }
  const d = planned([WIN], { best: 110, cheaper: 'cost' }); assert.match(go(d).err, /"best" and "cheaper"/);
});
test('run: best: the report says the run stopped because no room was left, and shows the held-out number at the end', () => {
  const d = planned([WIN, WIN2], { best: 110, heldOut: 'echo $(( $(cat src/score.txt) * 2 ))' }); go(d);
  const r = report(d); assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /no room was left/); assert.match(r.out, /220 at the end/);
});

// A program that prints and then ends with process.exit() loses what a pipe has not taken yet. The report did that:
// piped (into a pager, a file through tee, another program), a report longer than 64 KB arrived cut, and its last line,
// the one that says whether the record is whole, was gone. The exit code was right. Seen on 2026-11-22.
test('report: a report longer than a pipe holds arrives whole, as words and as JSON', () => {
  const d = toy(), dir = join(d, '.git', 'improve'); mkdirSync(dir, { recursive: true });
  const line = (i) => JSON.stringify({ n: i + 1, result: 'worse', why: `nothing improved. ${'A long reason. '.repeat(15)}`, label: `try ${i + 1}` });
  writeFileSync(join(dir, 'attempts.jsonl'), Array.from({ length: 400 }, (_, i) => line(i)).join('\n') + '\n');
  for (const flag of ['', '--json']) {
    const file = join(TMP_ROOT, `report-whole${flag}.txt`);
    const direct = spawnSync('sh', ['-c', `${NODE} ${REPORT} ${flag} > ${file}`], { cwd: d, env: ENV, encoding: 'utf8' });
    const piped = spawnSync('sh', ['-c', `${NODE} ${REPORT} ${flag} | (sleep 1; cat)`], { cwd: d, env: ENV, encoding: 'utf8', maxBuffer: 1 << 26 });
    const whole = readFileSync(file, 'utf8');
    assert.equal(direct.status, 0, direct.stderr); assert.ok(whole.length > 100000, `the report is ${whole.length} bytes, too short to test this`);
    assert.equal(piped.stdout.length, whole.length, `through a pipe ${piped.stdout.length} of ${whole.length} bytes arrived (${flag || 'words'})`);
    assert.equal(piped.stdout, whole);
    if (flag) assert.equal(JSON.parse(piped.stdout).runs[0].list.length, 400); else assert.match(piped.stdout, /whole: yes\./);
  }
});
