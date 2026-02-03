/**
 * File cooldown tracking for pending PRs.
 * Prevents scheduling overlapping work on files that already have open PRs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface CooldownEntry {
  filePath: string;
  prUrl: string;
  createdAt: number;
}

const COOLDOWN_FILE = 'file-cooldown.json';
const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function cooldownPath(repoRoot: string): string {
  return path.join(repoRoot, '.blockspool', COOLDOWN_FILE);
}

function readEntries(repoRoot: string): CooldownEntry[] {
  const fp = cooldownPath(repoRoot);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(repoRoot: string, entries: CooldownEntry[]): void {
  const fp = cooldownPath(repoRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

function prune(entries: CooldownEntry[]): CooldownEntry[] {
  const cutoff = Date.now() - TTL_MS;
  return entries.filter(e => e.createdAt > cutoff);
}

export function recordPrFiles(repoRoot: string, prUrl: string, files: string[]): void {
  const entries = prune(readEntries(repoRoot));
  const now = Date.now();
  for (const filePath of files) {
    entries.push({ filePath, prUrl, createdAt: now });
  }
  writeEntries(repoRoot, entries);
}

export function getCooledFiles(repoRoot: string): Map<string, string> {
  const entries = prune(readEntries(repoRoot));
  // Write back pruned entries
  writeEntries(repoRoot, entries);
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(e.filePath, e.prUrl);
  }
  return map;
}

export function removePrEntries(repoRoot: string, prUrls: string[]): void {
  if (prUrls.length === 0) return;
  const urlSet = new Set(prUrls);
  const entries = readEntries(repoRoot).filter(e => !urlSet.has(e.prUrl));
  writeEntries(repoRoot, prune(entries));
}

export function computeCooldownOverlap(files: string[], cooledFiles: Map<string, string>): number {
  if (files.length === 0 || cooledFiles.size === 0) return 0;
  let overlap = 0;
  for (const f of files) {
    if (cooledFiles.has(f)) overlap++;
  }
  return overlap / files.length;
}
