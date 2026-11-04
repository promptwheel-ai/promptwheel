#!/usr/bin/env node
// PromptWheel architecture lock, zero-dep and zero-LLM. It reads a repository once and writes the shape
// of it to promptwheel.lock.json: dependencies, install scripts, workflows, modules, import edges between
// modules, routes, public entry points, and the network hosts the source names. The gate then holds that
// shape: anything the lock has not seen is drift.
//   node lock.mjs write [path]            write or refresh promptwheel.lock.json
//   node lock.mjs drift [path] [--list] [--routes]   print how many items the tree has that the lock does not
//                                         (routes are locked and listed, and counted only with --routes)
// The lock lists structure, not content, so ordinary edits never touch it. There is no timestamp in it:
// the same tree always writes the same bytes. JS and TS only for edges, routes and hosts today.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LOCK_FILE = 'promptwheel.lock.json';
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|\.astro|coverage|vendor|out|target|\.venv|venv|__pycache__|\.promptwheel|\.sawbuck)(\/|$)/;
const TESTISH = /(^|\/)(test|tests|__tests__|__mocks__|e2e|spec|fixtures?|examples?|docs?|bench)\/|\.(test|spec|stories)\.[^/]+$/;
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|astro|svelte|vue)$/;
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'postpack']);
const IMPORT = /(?:\bfrom\s+|\brequire\(\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+|@\/[^'"]+)['"]/gm;
const ROUTE_CALL = /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\(\s*['"`](\/[^'"`]*)['"`]/g;
const HOST = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[:/'"`\s)]|$)/gi;
const NOT_A_HOST = /(^|\.)(example\.(com|org|net)|localhost|w3\.org|schema\.org|json-schema\.org|npmjs\.(com|org)|github\.com)$/i;

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
  if (path === 'package.json' || path.endsWith('/package.json')) {
    let j; try { j = JSON.parse(text); } catch { return out; }
    for (const k of DEP_KEYS) for (const n of Object.keys(j[k] || {})) out.add(`dep:${n}`);
    for (const s of Object.keys(j.scripts || {})) if (LIFECYCLE.has(s)) out.add(`script:${path}:${s}`);
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
    try { if (statSync(join(root, f)).size > 2_000_000) continue; text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    for (const i of itemsOf(f, text)) all.add(i);
  }
  return [...all].sort();
}
export function writeLock(root) {
  const items = shapeOf(root);
  writeFileSync(join(root, LOCK_FILE), JSON.stringify({ version: 1, items }, null, 2) + '\n');
  return items.length;
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
    const d = all && (process.argv.includes('--routes') ? all : all.filter((i) => !i.startsWith('route:')));
    if (d === null) { process.stderr.write(`no readable ${LOCK_FILE}: run promptwheel lock\n`); process.exit(1); }   // unmeasurable, never a clean 0
    if (process.argv.includes('--list')) for (const i of all) process.stderr.write(`  ${i}\n`);
    process.stdout.write(`${d.length}\n`);
  } else { process.stderr.write('usage: node lock.mjs <write|drift> [path] [--list]\n'); process.exit(64); }
}
