#!/usr/bin/env node
// PromptWheel supply-chain guard-pack scanner, zero-dep. Counters over the repo's package
// manifests and lockfiles; each is a number the gate holds (it must not rise):
//   lifecycle     install-time script entries across every package.json
//                 (preinstall, install, postinstall, prepare, prepublish, prepublishOnly, postpack)
//   deps          dependency entries across every package.json
//                 (dependencies, devDependencies, optionalDependencies, peerDependencies)
//   lock-sources  lockfile entries resolved from somewhere other than the npm registry (git, ssh,
//                 http, a tarball on another host, file:) plus registry entries with no integrity hash
// These are counts, not findings. A private registry makes the baseline large, not failing: the
// guard only fails when a count rises, and a rise with a reason is recorded with `--allow`.
//
// Usage: node scan.mjs <lifecycle|deps|lock-sources> [path]        prints one integer
//        node scan.mjs <what> [path] --list                          also lists each hit on stderr
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WHAT = positional[0] || '';
const ROOT = positional[1] || '.';
const LIST = process.argv.includes('--list');

const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|vendor|out|target|\.venv|venv|__pycache__)(\/|$)/;
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'postpack'];
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const REGISTRY = /^https:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com)\//;

const hits = [];
const hit = (where, what) => hits.push(`${where}: ${what}`);

function* walk(dir, names) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p, names);
    else if (names.has(basename(p))) yield p;
  }
}
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// --- lifecycle: install-time script entries ---------------------------------------------------
function lifecycle() {
  for (const file of walk(ROOT, new Set(['package.json']))) {
    const pkg = readJson(file);
    if (!isObj(pkg) || !isObj(pkg.scripts)) continue;
    for (const k of LIFECYCLE) if (typeof pkg.scripts[k] === 'string' && pkg.scripts[k].trim()) hit(file, `${k} = ${pkg.scripts[k].slice(0, 120)}`);   // an empty script runs nothing
  }
}

// --- deps: dependency entries -------------------------------------------------------------------
function deps() {
  for (const file of walk(ROOT, new Set(['package.json']))) {
    const pkg = readJson(file);
    if (!isObj(pkg)) continue;
    for (const k of DEP_KEYS) if (isObj(pkg[k])) for (const name of Object.keys(pkg[k])) hit(file, `${k}: ${name}`);
  }
}

// --- lock-sources: where lockfile entries come from ---------------------------------------------
// npm: lockfileVersion 2/3 carry a `packages` map; 1 carries nested `dependencies`. A workspace
// link (`link: true`) is a path inside the repo, not a source. Bundled entries carry no `resolved`
// and are skipped. Any entry with a `resolved` that is not the registry counts once; a registry
// entry with no `integrity` counts once.
function npmLock(file) {
  const lock = readJson(file);
  if (!isObj(lock)) return;
  const judge = (entry, label) => {
    if (!isObj(entry) || entry.link === true) return;
    const r = entry.resolved;
    if (typeof r !== 'string' || !r) return;
    if (!REGISTRY.test(r)) hit(`${file} ${label}`, r.slice(0, 160));
    else if (typeof entry.integrity !== 'string' || !entry.integrity) hit(`${file} ${label}`, 'no integrity');
  };
  if (isObj(lock.packages)) {
    for (const [k, v] of Object.entries(lock.packages)) { if (k === '') continue; judge(v, k); }
  } else if (isObj(lock.dependencies)) {
    const rec = (d, prefix) => { for (const [k, v] of Object.entries(d)) { judge(v, prefix + k); if (isObj(v) && isObj(v.dependencies)) rec(v.dependencies, prefix + k + '>'); } };
    rec(lock.dependencies, '');
  }
}
// pnpm: a tolerant line scan of `resolution:` lines (no YAML parser). A registry resolution is
// `{integrity: ...}`; a tarball on another host, a git commit, or a tarball with no integrity counts.
// `directory:` resolutions are links inside the repo. Lines of a shape this scanner does not know
// count nothing.
function pnpmLock(file) {
  const text = readText(file);
  if (!text) return;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*resolution:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1];
    const tb = /\btarball:\s*['"]?([^'",}\s]+)/.exec(rest);
    if (tb) {
      if (!REGISTRY.test(tb[1])) hit(`${file}:${i + 1}`, tb[1].slice(0, 160));
      else if (!/\bintegrity:/.test(rest)) hit(`${file}:${i + 1}`, 'no integrity');
    } else if (/\b(commit|repo):/.test(rest) || /\btype:\s*git\b/.test(rest)) {
      hit(`${file}:${i + 1}`, rest.slice(0, 160));
    }
  }
}
// yarn classic: blank-line separated blocks with `resolved "<url>#<hash>"` and an `integrity` line;
// a non-registry host counts, a registry entry with no integrity counts. yarn berry (`__metadata:`):
// `resolution: "<name>@<protocol>:..."`; anything but npm:, workspace:, patch:, link:, portal:
// (a git url, an https tarball, file:, exec:) counts. Berry always writes a checksum for npm
// resolutions, so no integrity check is applied there.
function yarnLock(file) {
  const text = readText(file);
  if (!text) return;
  if (/^__metadata:/m.test(text)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*resolution:\s*"?([^"]+)"?\s*$/.exec(lines[i]);
      if (!m) continue;
      const res = m[1];
      const at = res.startsWith('@') ? res.indexOf('@', 1) : res.indexOf('@');
      if (at < 0) continue;
      const desc = res.slice(at + 1);
      const proto = (/^([a-z][a-z0-9+]*):/i.exec(desc) || [])[1];
      if (proto && ['npm', 'workspace', 'patch', 'link', 'portal'].includes(proto.toLowerCase())) continue;
      if (REGISTRY.test(desc)) continue;
      hit(`${file}:${i + 1}`, res.slice(0, 160));
    }
    return;
  }
  for (const block of text.split(/\n\s*\n/)) {
    const r = /^\s*resolved\s+"?([^"\s]+)"?/m.exec(block);
    if (!r) continue;
    const url = r[1].replace(/#.*$/, '');
    const label = (block.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').trim().slice(0, 80);
    if (!REGISTRY.test(url)) hit(`${file} ${label}`, url.slice(0, 160));
    else if (!/^\s*integrity\s/m.test(block)) hit(`${file} ${label}`, 'no integrity');
  }
}
function lockSources() {
  for (const file of walk(ROOT, new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']))) {
    const name = basename(file);
    try {
      if (name === 'package-lock.json') npmLock(file);
      else if (name === 'pnpm-lock.yaml') pnpmLock(file);
      else yarnLock(file);
    } catch { /* an unknown shape counts nothing, it never throws */ }
  }
}

// --- unpinned: code that runs from a floating reference ----------------------------------------
// The step a worm needs is a reference that moves. Counted wherever a repo executes something it
// did not pin: a GitHub Action not pinned to a full commit SHA, npx/dlx with no exact version, a
// global install with no exact version, and a remote script piped into a shell. Local actions
// (./path) are not counted, and in package.json scripts neither is a tool the manifest declares,
// because the lockfile already pins that one.
const EXACT = /@\d+\.\d+\.\d+([-+][\w.-]+)?$/;
const pkgToken = (t) => t.replace(/^['"]|['"]$/g, '');
function execLines(text, where, declared) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const u = line.match(/^(?:-\s*)?uses:\s*['"]?([^'"\s#]+)/);
    if (u) {
      const ref = u[1];
      if (ref.startsWith('./') || ref.startsWith('../')) continue;
      if (ref.startsWith('docker://') ? !/@sha256:[0-9a-f]{64}$/.test(ref) : !/@[0-9a-f]{40}$/.test(ref)) hit(where, `action not pinned by SHA: ${ref}`);
      continue;
    }
    for (const m of line.matchAll(/\b(?:npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx)\s+((?:-{1,2}[\w-]+\s+)*)([^\s;&|)]+)/g)) {
      const t = pkgToken(m[2]);
      if (t.startsWith('-') || t.startsWith('$') || t.startsWith('.') || t.startsWith('/')) continue;
      const name = t.replace(/@[^@/]*$/, '') || t;
      if (declared && (declared.has(name) || declared.has(t))) continue;
      if (!EXACT.test(t)) hit(where, `no exact version: ${m[0].trim()}`);
    }
    for (const m of line.matchAll(/\bnpm\s+(?:i|install)\s+(?:-g|--global)\s+((?:[^\s;&|)]+\s*)+)/g)) {
      for (const t of m[1].trim().split(/\s+/).map(pkgToken)) if (t && !t.startsWith('-') && !t.startsWith('.') && !EXACT.test(t)) hit(where, `no exact version: npm install -g ${t}`);
    }
    if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(line)) hit(where, `remote script piped to a shell: ${line.slice(0, 80)}`);
  }
}
function unpinned() {
  const yml = /\.ya?ml$/;
  for (const dir of [join(ROOT, '.github', 'workflows')]) {
    let names = []; try { names = readdirSync(dir); } catch { /* no workflows */ }
    for (const n of names) if (yml.test(n)) execLines(readText(join(dir, n)), join(dir, n));
  }
  for (const f of walk(ROOT, new Set(['action.yml', 'action.yaml']))) execLines(readText(f), f);
  for (const f of walk(ROOT, new Set(['package.json']))) {
    const j = readJson(f); if (!isObj(j) || !isObj(j.scripts)) continue;
    const declared = new Set(DEP_KEYS.flatMap((k) => (isObj(j[k]) ? Object.keys(j[k]) : [])));
    for (const [k, v] of Object.entries(j.scripts)) if (typeof v === 'string') execLines(v, `${f} scripts.${k}`, declared);
  }
  for (const n of (() => { try { return readdirSync(join(ROOT, 'scripts')); } catch { return []; } })()) if (n.endsWith('.sh')) execLines(readText(join(ROOT, 'scripts', n)), join(ROOT, 'scripts', n));
  for (const n of (() => { try { return readdirSync(ROOT); } catch { return []; } })()) if (/^Dockerfile/.test(n)) execLines(readText(join(ROOT, n)), join(ROOT, n));
}

// --- policy: install protections the repo declares ----------------------------------------------
// Two gaps, counted at the repo root. Release age itself stays with the package manager: a registry
// lookup here would make the verdict depend on the clock.
function policy() {
  if (!readJson(join(ROOT, 'package.json'))) return;
  const text = ['.npmrc', 'pnpm-workspace.yaml', '.yarnrc.yml'].map((f) => readText(join(ROOT, f))).join('\n');
  if (!/^\s*ignore-scripts\s*=\s*true/m.test(text) && !/^\s*(strictDepBuilds|enableScripts)\s*:\s*(true|false)/m.test(text)) hit('.npmrc', 'install scripts are not disabled (ignore-scripts=true)');
  if (!/^\s*min-release-age\s*=\s*[1-9]/m.test(text) && !/^\s*minimumReleaseAge\s*:\s*[1-9]/m.test(text) && !/^\s*npmMinimalAgeGate\s*:\s*[1-9"']/m.test(text)) hit('.npmrc', 'no release-age cooldown (min-release-age)');
}

const COUNTERS = { lifecycle, deps, 'lock-sources': lockSources, unpinned, policy };
if (!COUNTERS[WHAT]) {
  process.stderr.write('usage: node scan.mjs <lifecycle|deps|lock-sources|unpinned|policy> [path] [--list]\n');
  process.exit(64);   // a typo in the config must read as unmeasurable, never as a clean 0
}
COUNTERS[WHAT]();
if (LIST) {
  for (const h of hits) process.stderr.write(`  ${h}\n`);
  process.stderr.write(`\n${hits.length} ${WHAT} entr${hits.length === 1 ? 'y' : 'ies'}\n`);
}
// the metric value: lower is better; the gate holds the count, it does not require 0
process.stdout.write(String(hits.length) + '\n');
