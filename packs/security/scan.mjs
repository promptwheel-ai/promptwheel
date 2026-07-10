#!/usr/bin/env node
// PromptWheel security guard-pack scanner — zero-dep.
// Decanted from securitychecks' "recommended" tier (the regex-portable subset).
// Emits the count of security-invariant violations to stdout (the metric value).
// The full AST+dataflow engine (the other 75 recommended patterns) is the follow-up.
//
// Usage: node scan.mjs [path]            → prints the finding count (for `promptwheel` metrics)
//        node scan.mjs [path] --list     → prints each finding (file:line — id — message)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.';
const LIST = process.argv.includes('--list');
const PACK = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'patterns.json'), 'utf8'));

const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|vendor)(\/|$)/;
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const CONFIG_FILES = /(^|\/)\.npmrc$/;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (CODE.has(extname(p)) || CONFIG_FILES.test(p)) yield p;
  }
}

const findings = [];
for (const file of walk(ROOT)) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (const pat of PACK.patterns) {
    let re;
    try { re = new RegExp(pat.match, 'i'); } catch { continue; }
    const excludes = (pat.exclude || []).map((x) => { try { return new RegExp(x, 'i'); } catch { return null; } }).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) continue;
      if (excludes.some((ex) => ex.test(line))) continue;       // pattern's own false-positive guards
      findings.push({ file, line: i + 1, id: pat.id, sev: pat.severity, msg: pat.message });
    }
  }
}

if (LIST) {
  for (const f of findings) console.error(`  [${f.sev}] ${f.file}:${f.line} — ${f.id} — ${f.msg}`);
  console.error(`\n${findings.length} security-invariant violation(s)`);
}
// the metric value: lower is better, 0 is clean
process.stdout.write(String(findings.length) + '\n');
