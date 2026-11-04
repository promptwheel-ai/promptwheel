#!/usr/bin/env node
// PromptWheel architecture lock, zero-dep and zero-LLM. It reads a repository once and writes the shape
// of it to promptwheel.lock.json: dependencies, install scripts, workflows, modules, import edges between
// modules, routes, public entry points, and the network hosts the source names. The gate then holds that
// shape: anything the lock has not seen is drift.
//   node lock.mjs write [path]            write or refresh promptwheel.lock.json
//   node lock.mjs drift [path] [--list] [--routes]   print how many structural items the tree has that the lock does not
//   node lock.mjs pins [path]             print a fingerprint of the resolved dependency tree (the gate compares base to head)
//                                         (routes are locked and listed, and counted only with --routes)
// The lock lists structure, not content, so ordinary edits never touch it. There is no timestamp in it:
// the same tree always writes the same bytes. JS and TS only for edges, routes and hosts today.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LOCK_FILE = 'promptwheel.lock.json';
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|\.astro|coverage|vendor|out|target|\.venv|venv|__pycache__|\.promptwheel|\.sawbuck)(\/|$)/;
const TESTISH = /(^|\/)(test|tests|__tests__|__mocks__|e2e|spec|fixtures?|examples?|docs?|bench)\/|\.(test|spec|stories)\.[^/]+$/;
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|astro|svelte|vue)$/;
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'postpack']);
const IMPORT = /(?:\bfrom\s+|\brequire\(\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+|@\/[^'"]+)['"]/gm;
const ROUTE_CALL = /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\(\s*['"`](\/[^'"`]*)['"`]/g;
const HOST = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?=[:/'"`\s)]|$)/gi;
const NOT_A_HOST = /(^|\.)(example\.(com|org|net)|localhost|w3\.org|schema\.org|json-schema\.org|npmjs\.(com|org)|github\.com)$|^(127\.|0\.0\.0\.0)/i;
// lockfiles are fingerprinted, binaries hashed: any change to either needs a reason, whatever the name
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/;
const BINARY = /\.(node|wasm)$/;
const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
// the resolved tree a lockfile pins, not its bytes: an npm lock repeats the project's own version, so a
// release would otherwise read as a dependency change. Every package, its version, source and hash stay in.
function resolvedTree(path, text) {
  if (!/(package-lock|npm-shrinkwrap)\.json$/.test(path)) return text;
  let j; try { j = JSON.parse(text); } catch { return text; }
  const rows = [];
  for (const [k, v] of Object.entries(j.packages || {})) if (k && v && !v.link) rows.push([k, v.version, v.resolved, v.integrity].join(' '));
  const walk = (deps, pre) => { for (const [k, v] of Object.entries(deps || {})) { rows.push([pre + k, v.version, v.resolved, v.integrity].join(' ')); walk(v.dependencies, pre + k + '/'); } };
  if (!j.packages) walk(j.dependencies, '');
  return rows.sort().join('\n');
}
// what a module is able to do. First use in a module is structural; this is what catches an IP literal or a
// host assembled at runtime, which no URL pattern can see.
const CAPS = [
  ['exec', /\b(?:from\s+|require\(\s*|import\s*\(\s*)['"](?:node:)?(?:child_process|worker_threads|vm)['"]/],
  ['eval', /(?:^|[^.\w])eval\s*\(|\bnew\s+Function\s*\(/],
  ['net', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\b(?:from\s+|require\(\s*|import\s*\(\s*)['"](?:node:)?(?:net|dgram|http|https|tls|http2|dns)['"]/],
];

// the top-level module a path belongs to: packages/x, apps/x, src/x, lib/x, or the first directory
export function moduleOf(path) {
  const p = path.split('/');
  for (const pre of [['src', 'lib'], ['apps'], ['packages'], ['src'], ['lib']])
    if (p.length > pre.length + 1 && pre.every((s, i) => p[i] === s)) return p.slice(0, pre.length + 1).join('/');   // src/app stays one module: a new page is a route, not a new module
  return p.length > 1 ? p[0] : '.';
}
function routeOf(path) {
  let m = path.match(/(?:^|\/)app\/(.*)\/(?:route|page)\.[jt]sx?$/);
  if (m) return '/' + m[1].split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
  if (/(?:^|\/)app\/(?:route|page)\.[jt]sx?$/.test(path)) return '/';
  m = path.match(/(?:^|\/)pages\/(.+)\.(?:astro|mdx?|[jt]sx?)$/);
  if (m && !/\/_|^_/.test(m[1])) return '/' + m[1].replace(/(^|\/)index$/, '');
  return null;
}
// every structural item one file contributes; pure, so a replay over history uses the same code
export function itemsOf(path, text) {
  const out = new Set();
  if (SKIP.test(path)) return out;
  if (path.startsWith('.github/workflows/')) { out.add(`workflow:${path}`); return out; }
  if (BINARY.test(path)) { out.add(`binary:${path}:${sha(text)}`); return out; }
  if (path === 'package.json' || path.endsWith('/package.json')) {
    let j; try { j = JSON.parse(text); } catch { return out; }
    for (const k of DEP_KEYS) for (const n of Object.keys(j[k] || {})) out.add(`dep:${n}`);
    for (const [s, v] of Object.entries(j.scripts || {})) { if (LIFECYCLE.has(s)) out.add(`script:${path}:${s}`); out.add(`scripthash:${path}:${s}:${sha(String(v))}`); }
    if (path === 'package.json') {
      if (typeof j.bin === 'string') out.add(`entry:bin:${j.name}`); else for (const b of Object.keys(j.bin || {})) out.add(`entry:bin:${b}`);
      if (j.exports && typeof j.exports === 'object') for (const e of Object.keys(j.exports)) if (e.startsWith('.')) out.add(`entry:export:${e}`);
    }
    return out;
  }
  if (!CODE.test(path)) return out;
  const route = routeOf(path);
  if (route) out.add(`route:${route}`);
  if (TESTISH.test(path)) return out;
  const from = moduleOf(path);
  out.add(`module:${from}`);
  for (const m of text.matchAll(IMPORT)) {
    const t = m[1];
    const to = normalize(t.startsWith('@/') ? 'src/' + t.slice(2) : join(dirname(path), t));
    if (to.startsWith('..')) continue;
    const dest = moduleOf(to);
    if (dest !== from) out.add(`edge:${from}>${dest}`);
  }
  for (const m of text.matchAll(ROUTE_CALL)) out.add(`route:${m[1].toUpperCase()} ${m[2]}`);
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of t.matchAll(HOST)) if (!NOT_A_HOST.test(m[1])) out.add(`host:${m[1].toLowerCase()}`);
    for (const [cap, re] of CAPS) if (re.test(t)) out.add(`cap:${from}:${cap}`);
  }
  return out;
}
function tracked(root) {
  try { return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
  catch { return []; }
}
export function shapeOf(root) {
  const all = new Set();
  for (const f of tracked(root)) {
    if (f === LOCK_FILE) continue;
    let text = '';
    const held = LOCKFILE.test(f) || BINARY.test(f);   // never skipped for size: a large lockfile is the one that matters
    try { if (!held && statSync(join(root, f)).size > 2_000_000) continue; text = readFileSync(join(root, f), held && BINARY.test(f) ? 'latin1' : 'utf8'); } catch { continue; }
    for (const i of itemsOf(f, text)) all.add(i);
  }
  return [...all].sort();
}
export function writeLock(root) {
  const items = shapeOf(root);
  writeFileSync(join(root, LOCK_FILE), JSON.stringify({ version: 1, items }, null, 2) + '\n');
  return items.length;
}
// a number that changes whenever the resolved dependency tree does. Compared base to head by the gate, so it
// needs no stored value: the lock stays the same across updates, and an approved update never blinds the next check.
export function pinsOf(root) {
  const rows = [];
  for (const f of tracked(root).filter((p) => LOCKFILE.test(p) && !SKIP.test(p)).sort()) {
    try { rows.push(f + '\n' + resolvedTree(f, readFileSync(join(root, f), 'utf8'))); } catch { /* deleted but still in the index */ }
  }
  return rows.length ? parseInt(sha(rows.join('\n')).slice(0, 12), 16) : 0;
}
export function driftOf(root) {
  const p = join(root, LOCK_FILE);
  if (!existsSync(p)) return null;
  let lock; try { lock = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (!lock || !Array.isArray(lock.items)) return null;
  const known = new Set(lock.items);
  return shapeOf(root).filter((i) => !known.has(i));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const root = args[1] || '.';
  if (args[0] === 'write') { process.stdout.write(`${writeLock(root)} items locked in ${LOCK_FILE}\n`); }
  else if (args[0] === 'drift') {
    const all = driftOf(root);
    // a new route is ordinary feature work, so by default it is reported, not held; --routes holds it too
    const d = all && all.filter((i) => process.argv.includes('--routes') || !i.startsWith('route:'));
    if (d === null) { process.stderr.write(`no readable ${LOCK_FILE}: run promptwheel lock\n`); process.exit(1); }   // unmeasurable, never a clean 0
    if (process.argv.includes('--list')) for (const i of all) process.stderr.write(`  ${i}\n`);
    process.stdout.write(process.argv.includes('--json') ? JSON.stringify(d) + '\n' : `${d.length}\n`);
  } else if (args[0] === 'pins') { process.stdout.write(`${pinsOf(root)}\n`);
  } else { process.stderr.write('usage: node lock.mjs <write|drift|pins> [path] [--list] [--json]\n'); process.exit(64); }
}
