// A revision is followed by `--`, in every git call that names one (0.8.19). Without it git has to guess whether a
// word is a revision or a path, and refuses as soon as a file of that name exists ("ambiguous argument 'HEAD': both
// revision and filename"). Found 2026-11-23 while a second reader's cases for Sawbuck's hooks were being typed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'bin', 'promptwheel.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'pw-git-calls-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
const ENV = { ...process.env, TMPDIR: TMP, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
delete ENV.PROMPTWHEEL_NO_ALLOW_TRAILER;
const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (d, f, c) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); };
const save = (d, msg) => { git(d, 'add', '-A'); git(d, 'commit', '-qm', msg); };
const pw = (d, args, env = ENV) => { const r = spawnSync(process.execPath, [ENGINE, ...args], { cwd: d, encoding: 'utf8', env }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const report = (r) => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)); } catch { return null; } };
// a project with one test (red: add subtracts) and one protected path
const project = () => {
  const d = mkdtempSync(join(TMP, 'r-')); git(d, 'init', '-q', '-b', 'main');
  put(d, 'package.json', '{"name":"r","scripts":{"test":"node --test"}}\n'); put(d, 'src/add.js', 'exports.add = (a, b) => a - b;\n');
  put(d, 'test/add.test.js', "const assert = require('node:assert');\nconst { test } = require('node:test');\ntest('add', () => { assert.equal(require('../src/add.js').add(2, 2), 4); });\n");
  put(d, 'ci.yml', 'on: push\n'); put(d, '.gitignore', '.promptwheel/\n');
  put(d, 'promptwheel.config.json', JSON.stringify({ linkNodeModules: false, metrics: [{ name: 'tests_pass', cmd: 'node --test', extract: 'exit', direction: 'up' }], mandates: [{ name: 'ci-frozen', paths: ['ci.yml'], reason: 'ci changes with a reason' }] }, null, 2) + '\n');
  save(d, 'base'); git(d, 'branch', 'base-ref');
  return d;
};
const asTheActionCallsIt = (d, base) => pw(d, ['run', '--base', base, '--head', 'HEAD', '--repeat', '1', '--json', '--no-record']);

test('a commit that adds a file named HEAD, or one named as its base, is read like any other: a protected edit fails with its rule named, an honest fix passes', () => {
  for (const [what, name, base] of [['a file named HEAD', () => 'HEAD', (sha) => sha], ['a file named as the base commit', (sha) => sha, (sha) => sha], ['a file named as the base branch', () => 'base-ref', () => 'base-ref']]) {
    let d = project(); let sha = git(d, 'rev-parse', 'HEAD');
    put(d, name(sha), ''); put(d, 'ci.yml', 'on: push\n# more\n'); save(d, 'the change');
    let r = asTheActionCallsIt(d, base(sha)); let rep = report(r);
    assert.ok(rep, `${what}, a protected edit: a report, not an error: ${r.err.slice(0, 300)}`);
    assert.equal(r.code, 1, what); assert.equal(rep.verdict, 'fail', what); assert.match(JSON.stringify(rep), /ci-frozen/, `${what}: the rule is named`);
    d = project(); sha = git(d, 'rev-parse', 'HEAD');
    put(d, name(sha), ''); put(d, 'src/add.js', 'exports.add = (a, b) => a + b;\n'); save(d, 'the fix');
    r = asTheActionCallsIt(d, base(sha)); rep = report(r);
    assert.ok(rep, `${what}, an honest fix: a report, not an error: ${r.err.slice(0, 300)}`);
    assert.equal(r.code, 0, what); assert.equal(rep.verdict, 'pass', what);
  }
});

test('the loop puts a thrown-away attempt back beside a file named as the commit it began at, and keeps a good one', () => {
  let d = project(); let sha = git(d, 'rev-parse', 'HEAD');
  // an attempt that makes that file and changes nothing that counts: not kept, and the tree is as it was
  let r = pw(d, ['improve', '--attempt', `: > ${sha} && echo '// a note' >> src/add.js`]);
  assert.notEqual(r.code, 0, r.out + r.err); assert.doesNotMatch(r.out + r.err, /ambiguous argument|Command failed/, 'the attempt is judged, not an error from git');
  assert.equal(git(d, 'status', '--porcelain'), '', 'put back'); assert.equal(git(d, 'rev-parse', 'HEAD'), sha);
  d = project(); sha = git(d, 'rev-parse', 'HEAD');
  r = pw(d, ['improve', '--attempt', `: > ${sha} && node -e "const fs=require('fs');fs.writeFileSync('src/add.js',fs.readFileSync('src/add.js','utf8').replace('a - b','a + b'))"`]);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, / kept .*tests_pass 0 to 1/);
  assert.match(pw(d, ['improve', '--report']).out, /whole: yes/);
});

test('no git call that names a revision leaves git to guess what is a path: under a stand-in that writes down each such call, a run, the loop and a reading of history leave nothing written', { skip: process.platform === 'win32' && 'the stand-in is a shell file' }, () => {
  const calls = join(mkdtempSync(join(TMP, 'calls-')), 'calls.txt'); writeFileSync(calls, '');
  const env = { ...ENV, PATH: `${join(HERE, 'git-stand-in')}${delimiter}${ENV.PATH}`, PROMPTWHEEL_TEST_GIT_CALLS: calls };
  const d = project();
  spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: d, env, encoding: 'utf8' });
  assert.match(readFileSync(calls, 'utf8'), /^diff --name-only HEAD$/m, 'the stand-in writes down a call with no `--`'); writeFileSync(calls, '');
  put(d, 'ci.yml', 'on: push\n# more\n'); put(d, 'src/add.js', 'exports.add = (a, b) => a + b;\n'); save(d, 'a change with a reason\n\nPromptwheel-Allow: ci needed it');
  for (const a of [['run', '--base', 'HEAD~1', '--head', 'HEAD', '--repeat', '1', '--json', '--no-record'], ['run', '--base', 'base-ref', '--head', 'HEAD', '--detect-gaming', '--no-record'],
    ['run'], ['backfill', '-n', '5'], ['improve', '--attempt', "echo '// a note' >> src/add.js"], ['improve', '--attempt', "echo '// TODO' >> src/add.js", '--turns', '2'], ['improve', '--report'], ['status'], ['insights']]) pw(d, a, env);
  assert.equal(readFileSync(calls, 'utf8'), '', 'every call that names a revision ends its revisions with `--`');
});
