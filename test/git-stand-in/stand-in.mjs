// test/git-stand-in: git, with one thing added. Where PROMPTWHEEL_TEST_GIT_CALLS names a file, every call of a command
// that reads "<revision>... [--] <path>..." and was given a word that could be either, with no `--` to say which, is
// written down there. Then the real git runs, with the same words, and its answer and exit code are passed on.
//
// Why: such a call works until a file of that name exists, and then git refuses it ("ambiguous argument 'HEAD': both
// revision and filename"). Until 0.8.19 a commit that added a file named HEAD, or one named as its base, stopped the
// engine with an error where the pull-request action calls it, for an honest commit too, and a file named as the
// commit an attempt began at stopped the loop from putting the attempt back (proof-bench/no-baseline, 2026-11-23).
// test/git-calls.test.mjs runs the engine and the loop under this stand-in and holds the list empty.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const real = (process.env.PATH || '').split(delimiter).filter((p) => p && p !== here).map((p) => join(p, 'git')).find((p) => existsSync(p));
if (!real) { process.stderr.write('git-stand-in: no git on the path behind this one\n'); process.exit(127); }
const argv = process.argv.slice(2);

// the commands whose words git has to sort into revisions and paths
const GUESSING = new Set(['diff', 'log', 'rev-list', 'show', 'blame', 'shortlog', 'whatchanged', 'diff-tree', 'format-patch', 'reset', 'range-diff', 'describe']);
// options of those commands that take their value as the next word
const TAKES_NEXT = new Set(['-n', '-L', '-S', '-G', '-O', '-U', '--max-count', '--since', '--until', '--author', '--grep', '--format', '--pretty', '--diff-filter', '--unified', '--abbrev']);
const log = process.env.PROMPTWHEEL_TEST_GIT_CALLS;
if (log) {
  let i = 0;
  while (i < argv.length) {   // git's own options, to reach the command
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(argv[i])) i += 2;
    else if (argv[i].startsWith('-')) i += 1;
    else break;
  }
  const cmd = argv[i]; const rest = argv.slice(i + 1);
  if (GUESSING.has(cmd)) {
    let told = false, word = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === '--' || a === '--no-index') { told = true; break; }
      if (TAKES_NEXT.has(a)) { k++; continue; }
      if (a.startsWith('-')) continue;
      if (a.includes(':')) continue;   // <revision>:<path> can be read one way only
      word = true;
    }
    if (word && !told) { try { appendFileSync(log, `${cmd} ${rest.join(' ')}\n`); } catch { /* the list is the test's, not git's */ } }
  }
}
const r = spawnSync(real, argv, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
