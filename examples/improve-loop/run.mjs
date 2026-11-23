#!/usr/bin/env node
// The loop's run. Many tries under one plan, and the plan is a file you committed before the run began.
//
//   node run.mjs [--plan improve.plan.json] [--arm <name>]
//
// The plan is read once, from HEAD, so no try can change the rules of the run it is in. It says what a try is,
// how many there are, when to stop and what a try may touch:
//
//   { "attempt": "sh tools/propose.sh",      the command that changes the repo (your agent)
//     "tries": 20,                           how many tries this plan gets, over every start of the run
//     "mayChange": ["src/**"],               the only paths a try may touch. The plan file itself can never be one.
//     "target": "score",                     the gate metric to raise. Default: score
//     "stopAfterFlat": 5,                    stop early after this many tries in a row with nothing kept
//     "best": 70,                            the best value the target can read. The run stops when there is no room
//                                            left: when no gain could be more than the gate's band for the target
//     "cheaper": "cost", "repeat": 3,        handed to the step as they are
//     "floor": true,                         hold every keep against the best so far. Default: true
//     "baseCache": true,                     measure each base once. Default: true
//     "wall": { "with": ["node_modules"], "minutes": 10, "record": true },
//                                            run each try in a copy of the tree. Default: on. false turns it off.
//     "heldOut": "sh /elsewhere/heldout.sh", a command that prints one number. Run here at the start and the end
//                                            of the run, never shown to a try, and never used to keep or put back.
//                                            If the end number is lost, the next start measures it.
//     "arms": { "blind": { "wall": { "record": false } } } }
//                                            named variants. An arm's keys replace the plan's. One arm a clone.
//
// A key this does not know is an error. So is a plan that is not committed, or one with no list of what may change.
//
// "best" and the band. A gain is kept only when it is more than the band the gate has for the target (its "noise"),
// and the most a try can gain is what is left up to the best value. When that is no more than the band, no try can
// be kept, and the run stops and says so. The band is the gate's own, as the step wrote it into the record line of
// that reading: the band the contract declares, else the spread the gate measured over its repeats. A line written
// before the step wrote bands has none, and then the band the contract declares at HEAD is used, as before. The
// direction is read from promptwheel.config.json as HEAD holds it. With no band, the run stops only at the best
// value itself. The rule reads the gate's last reading of the commit the next try would start from. Where there is none yet, as
// before a plan's first try, nothing is known and the try runs. "best" cannot be used with "cheaper": at the best
// value a change can still be kept for costing less.
//
// Each try is one call of improve.mjs, so every rule of the step holds. This adds a second account of the run beside
// the step's record: .git/improve/runs.jsonl says which plan a run used, where it began, and what each try came
// to as this program saw it. report.mjs reads both and says when they do not agree.
//
// Stop it with Ctrl-C: the try in hand is put back, and the run can be started again later. It goes on from where
// it stopped, and the count of tries carries over.
//
// The gate is PromptWheel. Each try asks the engine this run ships beside (../../bin/promptwheel.mjs, as the step
// does), or the one PROMPTWHEEL names: its command, for example "node /path/to/promptwheel.mjs".
// Exit codes: 0 the run ended by its plan (its tries are used, or one of its stop rules held) · 1 it could not go on (a try could not run, or it was stopped) · 64 it never started.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), NODE = process.execPath;
const die = (message) => { console.error(`run: ${message}`); process.exit(64); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const args = {};
for (let i = 0, argv = process.argv.slice(2); i < argv.length; i++) {
  if (!['--plan', '--arm'].includes(argv[i])) die(`unknown flag ${argv[i]}`);
  if (argv[i + 1] === undefined) die(`${argv[i]} needs a value`);
  args[argv[i]] = argv[++i];
}
const shipped = join(HERE, '..', '..', 'bin', 'promptwheel.mjs');   // with no PROMPTWHEEL, the step asks this one
if (!process.env.PROMPTWHEEL && !existsSync(shipped)) die('no engine ships beside this run: set PROMPTWHEEL to the gate command, for example: PROMPTWHEEL="node /path/to/promptwheel.mjs"');
let root; try { root = git('rev-parse', '--show-toplevel'); } catch { die('not inside a git repository'); }
process.chdir(root);
if (git('status', '--porcelain')) die('the working tree is not clean: commit or stash first. The plan is read from HEAD, and a try needs something to be put back to');

// ---------------------------------------------------------------- the plan, as HEAD holds it
const planPath = args['--plan'] || 'improve.plan.json';
let planBlob, plan;
try { planBlob = git('rev-parse', '--verify', `HEAD:${planPath}`); } catch { die(`there is no committed plan at ${planPath}. Write one and commit it: a run starts from a plan that was fixed before it began`); }
try { plan = JSON.parse(git('cat-file', 'blob', planBlob)); } catch { die(`the plan at ${planPath} is not JSON`); }
const KEYS = { attempt: 'string', tries: 'count', mayChange: 'list', target: 'string', stopAfterFlat: 'count', best: 'number', cheaper: 'string', repeat: 'count', floor: 'boolean', baseCache: 'boolean', wall: 'wall', heldOut: 'string', arms: 'arms' };
const WALL = { with: 'list', minutes: 'minutes', record: 'boolean' };
const is = {
  string: (v) => typeof v === 'string' && v.trim() !== '', boolean: (v) => typeof v === 'boolean', number: (v) => typeof v === 'number' && Number.isFinite(v), count: (v) => Number.isInteger(v) && v > 0, minutes: (v) => typeof v === 'number' && v > 0 && v <= 35000,   // the wall's timer cannot count further
  list: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '' && !x.includes(',')),
  wall: (v) => typeof v === 'boolean' || (v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, x]) => WALL[k] && is[WALL[k]](x))),
  arms: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.values(v).every((a) => a && typeof a === 'object' && !Array.isArray(a)),
};
const check = (object, where) => { for (const [key, value] of Object.entries(object)) { if (!KEYS[key] || (where !== 'the plan' && key === 'arms')) die(`${where} has a key this does not know: "${key}"`); if (!is[KEYS[key]](value)) die(`${where}: "${key}" is not what it should be (${KEYS[key]})`); } };
if (!plan || typeof plan !== 'object' || Array.isArray(plan)) die(`the plan at ${planPath} is not an object`);
check(plan, 'the plan');
const arm = args['--arm'] || null;
if (plan.arms && !arm) die(`this plan has arms (${Object.keys(plan.arms).join(', ')}). Say which one this clone runs: --arm <name>`);
if (arm && !(plan.arms && plan.arms[arm])) die(`the plan has no arm named "${arm}"`);
if (arm) check(plan.arms[arm], `arm "${arm}"`);
const p = { target: 'score', floor: true, baseCache: true, wall: true, ...plan, ...(arm ? plan.arms[arm] : {}) }; delete p.arms;
for (const key of ['attempt', 'tries', 'mayChange']) if (p[key] === undefined) die(`the plan must say "${key}"${key === 'mayChange' ? ': the paths a try may touch. Without it a try could rewrite anything, the plan too' : ''}`);
if (p.best !== undefined && p.cheaper) die('the plan says both "best" and "cheaper". At the best value a change can still be kept for costing less, so the run would have no reason to stop there. Leave one of them out');
// the plan is not something a try may change: a loop that can edit its own plan has no plan
const globToRe = (glob) => {
  const anchored = glob.startsWith('/'), g = anchored ? glob.slice(1) : glob;
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  return new RegExp(`${anchored || glob.includes('/') ? '^' : '(^|/)'}${body}$`);
};
if (p.mayChange.some((g) => globToRe(g.trim()).test(planPath))) die(`"mayChange" lets a try edit the plan itself (${planPath}). Narrow it`);

// ---------------------------------------------------------------- the two accounts: the step's record, and this program's
const dir = join(git('rev-parse', '--absolute-git-dir'), 'improve'), recordFile = join(dir, 'attempts.jsonl'), runsFile = join(dir, 'runs.jsonl');
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : []);
if (read(runsFile).includes(null)) die(`${runsFile} has a line that cannot be read. Look at it before starting another run`);
const record = () => read(recordFile).filter(Boolean);
const runs = read(runsFile), ours = runs.filter((r) => r.planBlob === planBlob);
const other = ours.find((r) => r.begin && (r.arm || null) !== arm);
if (other) die(`this clone already ran arm "${other.arm || 'none'}" of this plan. One arm a clone: the branch and the floor carry over from try to try`);
// A run that began and never ended was killed. Close it from the step's record, and say that is where it came from.
const open = runs.filter((r) => r.begin).find((b) => !runs.some((r) => r.end && r.run === b.run));
mkdirSync(dir, { recursive: true });
let mine = existsSync(runsFile) ? readFileSync(runsFile, 'utf8') : '';   // what this program wrote, kept to see that no try edits it
const write = (line) => { mine += JSON.stringify(line) + '\n'; writeFileSync(runsFile, mine); };
if (open) { const seen = record().filter((l) => l.n >= open.from); write({ run: open.run, end: true, at: new Date().toISOString(), to: open.from + seen.length - 1, ended: 'lost', results: seen.map((l) => l.result), fromRecord: true }); }
// every earlier start of this plan here: which tries were its own
const spans = ours.filter((b) => b.begin).map((b) => [b.from, (read(runsFile).find((r) => r.end && r.run === b.run) || { to: b.from - 1 }).to]);
const done = spans.reduce((n, [a, b]) => n + (b - a + 1), 0);
const heldOut = () => {   // one number from a command the tries never see. null when it cannot be read.
  if (!p.heldOut) return undefined;
  const r = spawnSync(p.heldOut, { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }), v = Number((r.stdout || '').trim());
  return r.status === 0 && (r.stdout || '').trim() !== '' && Number.isFinite(v) ? v : null;
};
// No room left: null while a try could still be kept, or while nothing says. Else the sentence that says why not.
// The reading is the last one the gate made of the commit the next try would start from. A reading of any other
// commit says nothing about this one.
const noRoom = () => {
  if (p.best === undefined) return null;
  const here = git('rev-parse', 'HEAD'), read1 = (l) => (l.metrics || []).find((m) => m.name === p.target && typeof m.before === 'number');
  const last = record().filter(read1).pop();
  if (!last || (last.result === 'kept' ? last.commit : last.base) !== here) return null;
  const m = read1(last), now = last.result === 'kept' && typeof m.after === 'number' ? m.after : m.before;
  let band = typeof m.noise === 'number' && m.noise >= 0 ? m.noise : null, down = false;   // the band the gate held that reading to
  try { const g = JSON.parse(git('cat-file', 'blob', git('rev-parse', '--verify', 'HEAD:promptwheel.config.json'))).metrics.find((x) => x.name === p.target); down = g.direction === 'down'; if (band === null && typeof g.noise === 'number' && g.noise >= 0) band = g.noise; } catch { /* nothing more can be read: the run stops only at the best value itself */ }
  if (band === null) band = 0;
  return (down ? now - p.best : p.best - now) <= band ? `no room left. ${p.target} stands at ${now}, the best it can read is ${p.best}, and a gain has to be more than ${band} to be kept` : null;
};
// A run that ended by its plan and lost its last held-out number (it was stopped while that was measured, or the
// command failed) gets the number measured now, once, written beside the run it belongs to.
const lateHeldOut = () => {
  const all = read(runsFile), last = all.filter((r) => r.end && ours.some((b) => b.begin && b.run === r.run)).pop();
  if (p.heldOut && last && last.heldOut == null && !all.some((r) => r.run === last.run && r.heldOutLate !== undefined)) {
    const late = heldOut();
    if (late != null) { write({ run: last.run, heldOutLate: late, at: new Date().toISOString(), head: git('rev-parse', 'HEAD') }); console.log(`run: the held-out number at the end of run ${last.run} was missing. Measured now: ${late}`); }
    else console.log(`run: the held-out number at the end of run ${last.run} is missing, and it could not be read now either`);
  }
};
if (done >= p.tries) { lateHeldOut(); console.log(`run: this plan's ${p.tries} tries are used up here. The report: node ${join(HERE, 'report.mjs')}`); process.exit(0); }
{ // the last run of this plan stopped for no room, and there is still none: nothing is started
  const lastEnd = read(runsFile).filter((r) => r.end && ours.some((b) => b.begin && b.run === r.run)).pop(), none = lastEnd && lastEnd.ended === 'no room' ? noRoom() : null;
  if (none) { lateHeldOut(); console.log(`run: ${none}. Nothing was started. The report: node ${join(HERE, 'report.mjs')}`); process.exit(0); }
}
const from = record().length + 1, run = runs.filter((r) => r.begin).length + 1, base = git('rev-parse', 'HEAD');
const cache = p.baseCache ? mkdtempSync(join(tmpdir(), 'improve-cache-')) : null;
process.on('exit', () => { if (cache) rmSync(cache, { recursive: true, force: true }); });
write({ run, begin: true, at: new Date().toISOString(), planPath, planBlob, plan: p, ...(arm ? { arm } : {}), base, from, ...(done ? { triesBefore: done } : {}), ...(p.heldOut && !done ? { heldOut: heldOut() } : {}) });

// ---------------------------------------------------------------- the tries
const w = p.wall === true ? {} : p.wall;
const attempt = w ? `${NODE} ${join(HERE, 'wall.mjs')}${(w.with || []).map((x) => ` --with ${q(x)}`).join('')}${w.minutes ? ` --minutes ${w.minutes}` : ''}${w.record === false ? ' --no-record' : ''} -- ${q(p.attempt)}` : p.attempt;
const flags = ['--target', p.target, '--may-change', p.mayChange.join(','), ...(p.cheaper ? ['--cheaper', p.cheaper] : []), ...(p.floor ? ['--floor'] : []), ...(p.repeat ? ['--repeat', String(p.repeat)] : []), ...(cache ? ['--base-cache', cache] : [])];
let stopped = false; for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; });   // the step puts its try back; this lives to write the end line
const results = []; let ended = 'tries', touched = false, none = null;
// tries in a row with nothing kept, counted over every earlier start of this plan too
let flat = 0; { const kept = record().filter((l) => spans.some(([a, b]) => l.n >= a && l.n <= b)).map((l) => l.result === 'kept'); flat = kept.length - 1 - kept.lastIndexOf(true); }
for (let i = done + 1; i <= p.tries; i++) {
  if ((none = noRoom())) { ended = 'no room'; break; }
  const child = spawn(NODE, [join(HERE, 'improve.mjs'), '--attempt', attempt, '--label', `${arm ? `${arm}: ` : ''}try ${i} of ${p.tries}`, ...flags, '--json'], { stdio: ['inherit', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', (c) => r(c)));
  if (existsSync(runsFile) ? readFileSync(runsFile, 'utf8') !== mine : true) { touched = true; writeFileSync(runsFile, mine); }   // a try edited this program's account: it is put back
  let line = null; try { line = JSON.parse(out.trim().split('\n').pop()); } catch { /* the step said nothing this can read */ }
  if (line) { results.push(line.result); console.log(`${String(line.n).padStart(3)}  ${line.result.padEnd(8)} ${line.why}`); }
  // a try that could not run prints no line, but the step may have noted it (stopped, or the branch was moved)
  if (!line) { const last = record().pop(); if (last && last.n === from + results.length) results.push(last.result); }
  if (code === 64 || code === null || stopped || !line) { ended = stopped ? 'stopped' : 'could not run'; break; }
  flat = line.result === 'kept' ? 0 : flat + 1;
  if (p.stopAfterFlat && flat >= p.stopAfterFlat && i < p.tries) { ended = 'flat'; break; }
}
const finished = ended === 'tries' || ended === 'flat' || ended === 'no room';
write({ run, end: true, at: new Date().toISOString(), to: from + results.length - 1, ended, results, head: git('rev-parse', 'HEAD'), ...(touched ? { runsPutBack: true } : {}), ...(p.heldOut && finished ? { heldOut: heldOut() } : {}) });
const kept = results.filter((r) => r === 'kept').length;
console.log(`run: ${results.length} ${results.length === 1 ? 'try' : 'tries'}, ${kept} kept. ${{ tries: 'Every try in the plan is used.', flat: `Stopped: ${p.stopAfterFlat} tries in a row kept nothing.`, 'no room': `Stopped: ${none}.`, stopped: 'Stopped by you. Run it again to go on.', 'could not run': 'A try could not run. Read the line above, fix it, and run it again to go on.' }[ended]} The report: node ${join(HERE, 'report.mjs')}`);
process.exit(finished ? 0 : 1);
