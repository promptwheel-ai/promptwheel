# Break the loop in one small way at a time, on a scratch copy of this checkout's loop, tests and engine, and see
# whether its tests notice. From the loop's first home (the framework session's folder), moved here with it.
#
#   python3 -I test/improve-loop-breaks.py /path/to/an/empty/scratch/folder
#
# This list covers the step where these tests hold it (the list of what may change, the count of gate asks,
# git's own files, the attempt that could not run, alone and over turns), and all of the wall, the run and the
# report. The step is the one keeper, the same file as PromptWheel's loop step. The older list of breaks for it
# is run against its own tests by check.sh (experiments/improve-loop/break-test.py).
# A break that no test notices is printed as MISSED. That is a test to write, or code that does nothing.
import json, os, pathlib, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
HERE = pathlib.Path(__file__).resolve().parent.parent; OUT = pathlib.Path(sys.argv[1])
TESTS = ["test/improve-loop-step.test.mjs", "test/improve-loop-wall.test.mjs", "test/improve-loop-run.test.mjs"]
L = "examples/improve-loop/"; S, W, R, P = L + "improve.mjs", L + "wall.mjs", L + "run.mjs", L + "report.mjs"
M = [  # (file, what the break does, text to find, text to put there, which occurrence)
 # ---- the step: what may change
 (S, "takes an empty list of what may change", "if (may && !may.length) die(", "if (false) die(", 1),
 (S, "lets every path through the list", "const outside = changedSince(candidate).filter((f) => !may.some((re) => re.test(f)));", "const outside = [];", 1),
 (S, "judges a try that is outside the list", "if (outside.length) return { standing: 'outside',", "if (false) return { standing: 'outside',", 1),
 (S, "does not put back a try that was not kept, one outside the list among them", "if (j.standing !== 'win') { putBack(); finish(", "if (j.standing !== 'win') { finish(", 1),
 (S, "counts a moved file at its new place only", "['diff', '--name-only', '--no-renames', '-z', base, candidate]", "['diff', '--name-only', '-M', '-z', base, candidate]", 1),
 (S, "reads file names the way git quotes them", "'--no-renames', '-z', base, candidate], { encoding: 'utf8' }).split('\\0')", "'--no-renames', base, candidate], { encoding: 'utf8' }).split('\\n')", 1),
 (S, "matches a bare name at the top of the repo only", "'^' : '(^|/)'}${body}$`);\n};\nconst may", "'^' : '^'}${body}$`);\n};\nconst may", 1),
 (S, "lets * reach into a folder", ".replace(/\\*/g, '[^/]*').replace(/\\?/g, '[^/]').replace(/\\x00/g, '.*');\n  return new RegExp(`${anchored || glob.includes('/') ? '^' : '(^|/)'}${body}$`);\n};\nconst may", ".replace(/\\*/g, '.*').replace(/\\?/g, '[^/]').replace(/\\x00/g, '.*');\n  return new RegExp(`${anchored || glob.includes('/') ? '^' : '(^|/)'}${body}$`);\n};\nconst may", 1),
 (S, "matches half a name", "${body}$`);\n};\nconst may", "${body}`);\n};\nconst may", 1),
 (S, "exits 0 for a try that is outside the list", "flat: 3, outside: 1,", "flat: 3, outside: 0,", 1),
 (S, "leaves the outside files out of the record", "extra: { candidate, files, outside } };", "extra: { candidate, files } };", 1),
 (S, "names every outside file in the line", "outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` and ${outside.length - 3} more` : ''}", "outside.join(', ')}", 1),
 (S, "reads one pattern where commas give several", "args['--may-change'].split(',')", "[args['--may-change']]", 1),
 # ---- the step: what a try cost
 (S, "does not count how often the gate was asked", "\n  asks++;\n", "\n", 1),
 (S, "leaves the count of gate asks out of the record", "...(asks ? { asks } : {}), ", "", 1),
 # ---- the step: git's own files
 (S, "does not put git's config back", "...settings.map((f) => [f, f.startsWith(`${common}/`) ? 'git settings' : `your git settings (${f})`]), ", "", 1),
 (S, "holds a config path that is not a plain file, like /dev/null", "].filter((f) => !existsSync(f) || isFile(f));", "];", 1),
 (S, "does not watch the global git config", "process.env.GIT_CONFIG_GLOBAL || join(home, '.gitconfig'),", "", 1),
 (S, "does not watch the global attributes file", "join(xdg, 'git', 'attributes'), ", "", 1),
 (S, "leaves a hook or an attributes file the attempt made", "  for (const [file, what] of inGitDirs()) if (!own.some((x) => x.file === file)) { restored.add(what); rmSync(file, { force: true }); }   // a hook or an attributes file the attempt made\n", "", 1),
 (S, "does not watch the hooks folder", "const gitDirs = [[join(common, 'hooks'), 'git hooks'], ", "const gitDirs = [", 1),
 (S, "does not watch the info folder", ", [join(common, 'info'), 'git settings']];", "];", 1),
 (S, "leaves a ref the attempt made", "  for (const ref of Object.keys(refsNow)) if (!(ref in refsAtStart) && ref !== here) { git('update-ref', '-d', ref); restored.add('refs'); }", "", 1),
 (S, "removes the branch the attempt left the repo on", "if (!(ref in refsAtStart) && ref !== here) {", "if (!(ref in refsAtStart)) {", 1),
 (S, "replaces a link to your dotfiles with a plain file", "if (link == null || linkOf(file) !== link) { rmSync(file, { recursive: true, force: true }); if (link != null) symlinkSync(link, file); }", "rmSync(file, { recursive: true, force: true });", 1),
 (S, "does not bring back a link the attempt swapped for a file", "{ rmSync(file, { recursive: true, force: true }); if (link != null) symlinkSync(link, file); }", "{ rmSync(file, { recursive: true, force: true }); }", 1),
 (S, "does not name the file in your home folder that was put back", "f.startsWith(`${common}/`) ? 'git settings' : `your git settings (${f})`", "'git settings'", 1),
 (S, "watches the refs of earlier tries only", "git('for-each-ref', '--format=%(refname) %(objectname)').split", "git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/improve').split", 1),
 (S, "puts back a branch, and not a tag", "if (holds('cat-file', '-e', sha)) {", "if (holds('cat-file', '-e', sha) && !ref.startsWith('refs/tags/')) {", 1),
 (S, "lets hooks run in the step's own git calls", "[`GIT_CONFIG_KEY_${k}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${k}`]: '/dev/null'", "[`GIT_CONFIG_KEY_${k}`]: 'core.abbrev', [`GIT_CONFIG_VALUE_${k}`]: '12'", 1),
 (S, "lets an fsmonitor command run in the step's own git calls", "[`GIT_CONFIG_KEY_${k + 1}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${k + 1}`]: 'false'", "[`GIT_CONFIG_KEY_${k + 1}`]: 'core.abbrev', [`GIT_CONFIG_VALUE_${k + 1}`]: '12'", 1),
 # ---- the step: an attempt that could not run is not a try
 (S, "counts an attempt that said it could not run (64) as a try", "=> tried.status === 64 || (!changedSomething", "=> false || (!changedSomething", 1),
 (S, "counts a command the shell could not find (127) as a try", "(tried.status === 126 || tried.status === 127)", "(tried.status === 126)", 1),
 (S, "counts a command the shell could not run (126) as a try", "(tried.status === 126 || tried.status === 127)", "(tried.status === 127)", 1),
 (S, "throws away a change from a command that ran in part and ended 127", "(!changedSomething && (tried.status === 126 || tried.status === 127))", "(tried.status === 126 || tried.status === 127)", 1),
 (S, "leaves the files of an attempt that could not run", "if (couldNotRun(tried, changedSomething)) { putBack(); die(notATry(tried)); }", "if (couldNotRun(tried, changedSomething)) { die(notATry(tried)); }", 1),
 (S, "writes a line for an attempt that could not run", "if (couldNotRun(tried, changedSomething)) { putBack(); die(notATry(tried)); }", "if (couldNotRun(tried, changedSomething)) { putBack(); note('nothing', 'could not run'); die(notATry(tried)); }", 1),
 (S, "calls any attempt that changed nothing one that could not run", "tried.status === 64 || (!changedSomething && (tried.status === 126 || tried.status === 127));", "tried.status === 64 || !changedSomething;", 1),
 (S, "counts a first turn that could not run as a turn", "if (t === 1) { putBack(); die(notATry(tried)); }", "if (false) { putBack(); die(notATry(tried)); }", 1),
 (S, "goes on to the next turn after one that could not run", "if (couldNotRun(tried, treeNow !== prevTree)) {", "if (false) {", 1),
 (S, "throws away a turn that had passed when a later turn could not run", "couldNot = { t, status: tried.status }; ended =", "lead = null; couldNot = { t, status: tried.status }; ended =", 1),
 (S, "leaves the files of a run over turns that kept nothing", "  putBack();\n  // a run that ended on an attempt that could not run, with no best turn", "  // a run that ended on an attempt that could not run, with no best turn", 1),
 (S, "ends a run on a turn that could not run as if that turn had been judged", "if (couldNot) { const why = ", "if (false) { const why = ", 1),
 (S, "runs on a git older than 2.31", "(Number(v[1]) === 2 && Number(v[2]) < 31)) die(", "(Number(v[1]) === 2 && Number(v[2]) < 0)) die(", 1),
 (S, "takes a git version it cannot read as new enough", ".exec(said);\n  if (!v ||", ".exec(said) || ['', '9', '9'];\n  if (!v ||", 1),
 # ---- the wall
 (W, "runs on a tree that is not clean", "if (git(['status', '--porcelain'])) die('the tree is not clean", "if (false) die('the tree is not clean", 1),
 (W, "takes a --with path outside the repo or in .git", "n.split(sep)[0] === '.git') die(", "n.split(sep)[0] === '.git') void (", 1),
 (W, "does not check that a --with path is there", "if (!existsSync(n)) die(", "if (false) die(", 1),
 (W, "drops a flag it does not know", "else if (argv[i] !== '--with' && argv[i] !== '--minutes') die(`unknown flag ${argv[i]}`);", "else if (argv[i] !== '--with' && argv[i] !== '--minutes') void 0;", 1),
 (W, "takes --minutes 0", "if (!(minutes > 0)) die(", "if (false) die(", 1),
 (W, "runs with no command", "if (cut < 0 || cut === argv.length - 1) die(", "if (cut < 0) die(", 1),
 (W, "joins several words without keeping them apart", "argv.slice(cut + 1).map(q).join(' ')", "argv.slice(cut + 1).join(' ')", 1),
 (W, "hands the attempt the variables that point git at your repo", "for (const key of ['GIT_DIR', 'GIT_WORK_TREE',", "for (const key of ['GIT_PREFIX',", 1),
 (W, "names the copy's folder something else", "tree = join(W, basename(root));", "tree = join(W, 'tree');", 1),
 (W, "gives the copy no commit", "'commit', '-q', '--allow-empty', '-m', `the tree at ${head.slice(0, 12)}`]);", "'status']);", 1),
 (W, "does not carry your git name into the copy", "for (const key of ['user.name', 'user.email']) {", "for (const key of []) {", 1),
 (W, "leaves tracked files that an ignore rule matches out of the copy's commit", "inCopy(['add', '-A', '-f']);", "inCopy(['add', '-A']);", 1),
 (W, "does not copy the --with folders", "for (const p of withPaths) cpSync(", "for (const p of []) cpSync(", 1),
 (W, "hands the attempt the real record", "const from = env.IMPROVE_RECORD; delete env.IMPROVE_RECORD;", "const from = env.IMPROVE_RECORD; return;", 1),
 (W, "ignores --no-record", "if (argv[i] === '--no-record') handRecord = false;", "if (argv[i] === '--no-record') handRecord = true;", 1),
 (W, "hands over an empty record", "if (existsSync(from)) copyFileSync(from, env.IMPROVE_RECORD);", "", 1),
 (W, "does not end what the attempt left running", "for (let i = 0; i < 100 && end('SIGKILL'); i++) await sleep(10);", "", 1),
 (W, "has no time limit", "const timer = minutes ? setTimeout(", "const timer = false ? setTimeout(", 1),
 (W, "hands the files back after the time ran out", "else if (late) leave(", "else if (false) leave(", 1),
 (W, "exits 0 when the time ran out", "Nothing is handed back`, 124);", "Nothing is handed back`, 0);", 1),
 (W, "hands the files back after it was stopped", "if (stopped) leave(", "if (false) leave(", 1),
 (W, "ends with a plain exit code when it was stopped", "if (stopped) { process.removeAllListeners(stopped); process.kill(process.pid, stopped); setTimeout(() => process.exit(130), 500); } else process.exit(exit);", "process.exit(exit || 0);", 1),
 (W, "leaves the copy in the temp folder", "const tidy = () => rmSync(W, { recursive: true, force: true });", "const tidy = () => {};", 1),
 (W, "hands back when your repo moved to another commit", "if (git(['rev-parse', 'HEAD']) !== head || branch() !== on) leave(", "if (false) leave(", 1),
 (W, "does not say that your real tree changed", "if (reached.length) console.error(", "if (false) console.error(", 1),
 (W, "brings back files that git ignores", "'--work-tree', tree, 'add', '-A']", "'--work-tree', tree, 'add', '-A', '-f']", 1),
 (W, "leaves the changes staged", "      git(['reset', '-q']);", "      ;", 1),
 (W, "hands back a change to a file hidden in your repo", "if (unseen.length) leave(", "if (false) leave(", 1),
 (W, "exits 0 whatever the attempt's exit code", "  process.exit(code ?? 1);", "  process.exit(0);", 1),
 (W, "lets your hooks run in its own git calls", "['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]", "[...args]", 1),
 (W, "starts on a tree with an edited file hidden from git", "if (edited.length) die(", "if (false) die(", 1),
 (W, "takes a time limit the timer cannot count", "if (minutes > 35000) die(", "if (false) die(", 1),
 # ---- the run
 (R, "runs on a tree that is not clean", "if (git('status', '--porcelain')) die('the working tree is not clean", "if (false) die('the working tree is not clean", 1),
 (R, "takes a plan with no list of what may change", "for (const key of ['attempt', 'tries', 'mayChange']) if (p[key] === undefined) die(", "for (const key of ['attempt', 'tries']) if (p[key] === undefined) die(", 1),
 (R, "lets the list cover the plan itself", "if (p.mayChange.some((g) => globToRe(g.trim()).test(planPath))) die(", "if (false) die(", 1),
 (R, "does not check what kind a plan's values are", "if (!is[KEYS[key]](value)) die(", "if (false) die(", 1),
 (R, "lets an arm carry arms of its own", "if (!KEYS[key] || (where !== 'the plan' && key === 'arms')) die(", "if (!KEYS[key]) die(", 1),
 (R, "has the floor off unless the plan asks", "{ target: 'score', floor: true,", "{ target: 'score', floor: false,", 1),
 (R, "has the base cache off unless the plan asks", "baseCache: true, wall: true, ...plan,", "baseCache: false, wall: true, ...plan,", 1),
 (R, "has the wall off unless the plan asks", "baseCache: true, wall: true, ...plan,", "baseCache: true, wall: false, ...plan,", 1),
 (R, "runs a second arm in the same clone", "if (other) die(", "if (false) die(", 1),
 (R, "runs a plan with arms when none is named", "if (plan.arms && !arm) die(", "if (false) die(", 1),
 (R, "takes an arm the plan does not have", "if (arm && !(plan.arms && plan.arms[arm])) die(", "if (false) die(", 1),
 (R, "ignores an arm's own keys", "...plan, ...(arm ? plan.arms[arm] : {}) };", "...plan };", 1),
 (R, "ignores stopAfterFlat", "if (p.stopAfterFlat && flat >= p.stopAfterFlat && i < p.tries) {", "if (false) {", 1),
 (R, "starts the count of tries again on every start", "for (let i = done + 1; i <= p.tries; i++) {", "for (let i = 1; i <= p.tries; i++) {", 1),
 (R, "makes more tries when the plan's tries are used", "if (done >= p.tries) {", "if (false) {", 1),
 (R, "does not hand the step the list of what may change", "'--may-change', p.mayChange.join(','), ", "", 1),
 (R, "does not hand the step --cheaper", "...(p.cheaper ? ['--cheaper', p.cheaper] : []), ", "", 1),
 (R, "does not measure held-out at the start", "...(p.heldOut && !done ? { heldOut: heldOut() } : {}) });", "});", 1),
 (R, "does not measure held-out at the end", "...(p.heldOut && finished ? { heldOut: heldOut() } : {}) });", "});", 1),
 (R, "takes any output of the held-out command as a number", "r.status === 0 && (r.stdout || '').trim() !== '' && Number.isFinite(v) ? v : null;", "v;", 1),
 (R, "does not put its own account back when a try edits it", "{ touched = true; writeFileSync(runsFile, mine); }", "{ touched = true; }", 1),
 (R, "does not say that a try edited its account", "...(touched ? { runsPutBack: true } : {}), ", "", 1),
 (R, "goes on after a try that could not run", "if (code === 64 || code === null || stopped || !line) {", "if (false) {", 1),
 (R, "exits 0 when it was stopped or could not go on", "process.exit(finished ? 0 : 1);", "process.exit(0);", 1),
 (R, "does not close a run that was killed", "if (open) {", "if (false) {", 1),
 (R, "does not note a try the step stopped", "if (!line) { const last = record().pop();", "if (false) { const last = record().pop();", 1),
 (R, "does not pass --no-record to the wall", "${w.record === false ? ' --no-record' : ''}", "", 1),
 (R, "does not pass the time limit to the wall", "${w.minutes ? ` --minutes ${w.minutes}` : ''}", "", 1),
 (R, "takes a plan with a time limit the timer cannot count", "v > 0 && v <= 35000,", "v > 0,", 1),
 (R, "does not measure a lost end number on the next start", "if (p.heldOut && last && last.heldOut == null &&", "if (false &&", 1),
 (R, "measures the end number again when it is already there", "last.heldOut == null && !all.some(", "!all.some(", 1),
 (R, "measures a late end number again on every start", " && !all.some((r) => r.run === last.run && r.heldOutLate !== undefined)) {", ") {", 1),
 (R, "does not write the late end number down", "if (late != null) { write({ run: last.run, heldOutLate: late,", "if (late != null) { void ({ run: last.run, heldOutLate: late,", 1),
 (P, "leaves a late end number out of the report", "?? (runs.find((r) => r.run === run.run && r.heldOutLate !== undefined) || {}).heldOutLate ?? null", "?? null", 1),
 (R, "does not pass the extra folders to the wall", "${(w.with || []).map((x) => ` --with ${q(x)}`).join('')}", "", 1),
 (R, "writes no results in its end line", "ended, results, head:", "ended, results: [], head:", 1),
 (R, "leaves the arm out of the label", "`${arm ? `${arm}: ` : ''}try ${i} of ${p.tries}`", "`try ${i} of ${p.tries}`", 1),
 (R, "starts with no gate named and none shipped beside it", "if (!process.env.PROMPTWHEEL && !existsSync(shipped)) die(", "if (false) die(", 1),
 (R, "needs PROMPTWHEEL even with an engine shipped beside it", "if (!process.env.PROMPTWHEEL && !existsSync(shipped)) die(", "if (!process.env.PROMPTWHEEL) die(", 1),
 (R, "drops a flag it does not know", "if (!['--plan', '--arm'].includes(argv[i])) die(`unknown flag ${argv[i]}`);", "if (!['--plan', '--arm'].includes(argv[i])) continue;", 1),
 # ---- the report
 (P, "does not check that the tries are numbered in order", "if (t.n !== i + 1) wrong.push(", "if (false) wrong.push(", 1),
 (P, "does not check that a try's change can still be read", "if (t.candidate && refs[`refs/improve/${t.n}`] !== t.candidate) wrong.push(", "if (false) wrong.push(", 1),
 (P, "does not check that a kept change is in the branch", "if (t.result === 'kept' && !(t.commit && holds('merge-base', '--is-ancestor', t.commit, 'HEAD'))) wrong.push(", "if (false) wrong.push(", 1),
 (P, "does not look for a change with no line", "for (const ref of Object.keys(refs)) if (!tries.some(", "for (const ref of []) if (!tries.some(", 1),
 (P, "does not hold the record against the run's own account", "if (JSON.stringify(seen) !== JSON.stringify(b.done.results)) wrong.push(", "if (false) wrong.push(", 1),
 (P, "does not say that a run has no end", "if (!b.done) { wrong.push(", "if (!b.done) { void (", 1),
 (P, "does not name a line it cannot read", "wrong.push(`${what}: line ${i + 1} cannot be read`); return null;", "return null;", 1),
 (P, "exits 0 when the record is not whole", "process.exitCode = report.whole ? 0 : 1;", "process.exitCode = 0;", 1),
 (P, "ends at once, so a long report is cut in a pipe", "process.exitCode = report.whole ? 0 : 1;", "process.exit(report.whole ? 0 : 1);", 1),
 (P, "prints the words after the JSON too", "; else words();", "; words();", 1),
 (P, "always says the record is whole", "console.log(report.whole ? 'whole: yes.", "console.log(true ? 'whole: yes.", 1),
 (P, "lists the kept tries only", "  for (const t of r.list) console.log(", "  for (const t of r.list.filter((x) => x.result === 'kept')) console.log(", 1),
 (P, "leaves the put-back tries out of --json", "list: list.map((t) => ({ n: t.n,", "list: list.filter((t) => t.result === 'kept').map((t) => ({ n: t.n,", 1),
 (P, "does not say which tries touched the loop's own files", "for (const t of r.touched) console.log(", "for (const t of []) console.log(", 1),
 (P, "does not add up the gate asks", "asks: list.reduce((n, t) => n + (t.asks || 0), 0),", "asks: 0,", 1),
 (P, "reads the score now from the first kept try", "metric(kept[kept.length - 1], target).after", "metric(kept[0], target).after", 1),
 (P, "does not list tries made outside a run", "{ run: null, list: tries.filter((t) => !inRun(t)) }", "{ run: null, list: [] }", 1),
 (P, "leaves held-out out of the report", "if (r.heldOut) console.log(", "if (false) console.log(", 1),
 (P, "counts every try as kept", "kept = list.filter((t) => t.result === 'kept');", "kept = list;", 1),
 (P, "drops a flag it does not know", "for (const f of flags) if (f !== '--json') die(`unknown flag ${f}`);", "", 1),
 # ---- the run's stop rule for "no room left" (the plan's "best")
 (R, "never stops for no room", "  if ((none = noRoom())) { ended = 'no room'; break; }\n", "", 1),
 (R, "reads exactly the band left as room", "(down ? now - p.best : p.best - now) <= band ?", "(down ? now - p.best : p.best - now) < band ?", 1),
 (R, "ignores the gate's band", " if (typeof g.noise === 'number' && g.noise >= 0) band = g.noise;", "", 1),
 (R, "reads a target that counts down as one that counts up", "down = g.direction === 'down';", "", 1),
 (R, "reads a kept try's score as it was before the keep", "now = last.result === 'kept' && typeof m.after === 'number' ? m.after : m.before;", "now = m.before;", 1),
 (R, "reads a put-back try's score as if the try were kept", "now = last.result === 'kept' && typeof m.after === 'number' ? m.after : m.before;", "now = typeof m.after === 'number' ? m.after : m.before;", 1),
 (R, "trusts a reading of another commit", "(last.result === 'kept' ? last.commit : last.base) !== here", "false", 1),
 (R, "reads another metric than the target", "(m) => m.name === p.target && typeof m.before === 'number'", "(m) => m.name === 'score' && typeof m.before === 'number'", 1),
 (R, "ends a run that stopped for no room as if it had not finished", "ended === 'tries' || ended === 'flat' || ended === 'no room';", "ended === 'tries' || ended === 'flat';", 1),
 (R, "begins a new run when there is still no room", "none = lastEnd && lastEnd.ended === 'no room' ? noRoom() : null;", "none = null;", 1),
 (R, "does not look for a lost held-out number when it starts nothing", "if (none) { lateHeldOut(); console.log(", "if (none) { console.log(", 1),
 (R, "lets a plan say best and cheaper", "if (p.best !== undefined && p.cheaper) die(", "if (false) die(", 1),
 (R, "takes a best that is not a number", "number: (v) => typeof v === 'number' && Number.isFinite(v),", "number: (v) => true,", 1),
 (R, "does not say why it stopped for no room", " 'no room': `Stopped: ${none}.`,", "", 1),
 (P, "does not say a run stopped for no room", " 'no room': 'stopped early: no room was left for a gain that could be kept',", "", 1),
 (P, "says the last held-out number was not measured after a run that stopped for no room", "['tries', 'flat', 'no room'].includes(r.ended)", "['tries', 'flat'].includes(r.ended)", 1),
 # ---- since the move (2026-11-22): the band in the record, the room to read, the shipped engine
 (S, "leaves the gate's band out of the record line", "...(typeof noise === 'number' ? { noise } : {}), ", "", 1),
 (R, "reads the band from the contract only, never from the record", "let band = typeof m.noise === 'number' && m.noise >= 0 ? m.noise : null,", "let band = null,", 1),
 (S, "reads git with Node's own 1 MB", "stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: READ_MAX }).trim();", "stdio: ['ignore', 'pipe', 'pipe'] }).trim();", 1),
 (S, "lists the changed files with Node's own 1 MB", "'-z', base, candidate], { encoding: 'utf8', maxBuffer: READ_MAX })", "'-z', base, candidate], { encoding: 'utf8' })", 1),
 (S, "reads the gate's report with Node's own 1 MB", "{ encoding: 'utf8', maxBuffer: READ_MAX });\n  if (run.error", "{ encoding: 'utf8' });\n  if (run.error", 1),
 (S, "takes no room from IMPROVE_READ_MAX", "Number(process.env.IMPROVE_READ_MAX) > 0 ? Number(process.env.IMPROVE_READ_MAX) : 256 * 1024 * 1024", "256 * 1024 * 1024", 1),
 (S, "says could not run, with no line, for a change too wide to read", "if (e && e.code === 'ENOBUFS') {", "if (false) {", 1),
 (S, "keeps a change too wide to read off the record", "    finish('nothing', `the change is too wide to read:", "    putBack(); die(`the change is too wide to read:", 1),
]
src = {f: (HERE / f).read_text() for f in (S, W, R, P)}
for f, what, find, put, nth in M:   # every break must fit the file as it stands, or nothing is run
    assert src[f].count(find) >= nth, f"the break list does not fit {f}: {what!r}"
    assert find != put

def run(i):   # i is None for the code as it stands
    f, what, find, put, nth = M[i] if i is not None else (S, "the code as it stands", "", "", 0)
    d = OUT / (f"m{i:03d}" if i is not None else "base"); shutil.rmtree(d, ignore_errors=True); (d / "test").mkdir(parents=True); (d / L).mkdir(parents=True)
    for name in (S, W, R, P): shutil.copy(HERE / name, d / name)
    for t in list(TESTS) + ["test/improve-loop-helpers.mjs"]: shutil.copy(HERE / t, d / t)
    shutil.copytree(HERE / "bin", d / "bin"); shutil.copytree(HERE / "packs", d / "packs"); shutil.copy(HERE / "package.json", d / "package.json")   # the gate the tests use
    at = -1
    for _ in range(nth): at = src[f].index(find, at + 1)
    (d / f).write_text(src[f][:at] + put + src[f][at + len(find):])
    tmp = OUT / (f"t{i:03d}" if i is not None else "tbase"); tmp.mkdir(exist_ok=True)
    try:
        r = subprocess.run(["node", "--test", *TESTS], cwd=d, capture_output=True, text=True, timeout=600, env={**os.environ, "TMPDIR": str(tmp)})
        failed = sorted({l[2:].rsplit(" (", 1)[0] for l in r.stdout.splitlines() if l.startswith("✖ ") and "failing tests" not in l})
        if i is None: res = {"failed": failed, "ran": "ℹ tests " in r.stdout}
        else: new = [t for t in failed if t not in BASE]; res = {"i": i, "file": f, "what": what, "caught": bool(new), "failed": len(new), "first": new[:2]}
    except subprocess.TimeoutExpired:
        res = {"failed": [], "ran": False} if i is None else {"i": i, "file": f, "what": what, "caught": True, "failed": -1, "first": ["the suite timed out"]}
    shutil.rmtree(d, ignore_errors=True); shutil.rmtree(tmp, ignore_errors=True)
    return res
# A test that fails before anything is broken catches nothing: the code is run once as it stands, and only a
# test that passed then counts.
base = run(None)
if not base["ran"]: sys.exit("Error: the loop's tests did not run on the code as it stands, so no break was made")
BASE = set(base["failed"])
with ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "6"))) as ex: results = list(ex.map(run, range(len(M))))
(OUT / "results.json").write_text(json.dumps(results, indent=1))
caught = sum(r["caught"] for r in results)
print(f"breaks made: {len(results)}. caught by the loop's tests: {caught}. missed: {len(results) - caught}.")
if BASE: print(f"  not counted, failing before anything was broken: {'; '.join(sorted(BASE))[:300]}")
for r in results:
    print(f"  {'caught' if r['caught'] else 'MISSED'}  {r['file'].removeprefix(L):<10} {r['what']}" + (f"  [{r['failed']} tests failed]" if r["caught"] else ""))
