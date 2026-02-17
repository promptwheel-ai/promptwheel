/**
 * Trigger configuration loader.
 *
 * Loads user-defined trigger rules from .promptwheel/triggers.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TriggerRule } from '@promptwheel/core/trace/shared';

/**
 * Load trigger rules from .promptwheel/triggers.json if it exists.
 * Returns empty array if file doesn't exist or is invalid.
 */
export function loadTriggerRules(repoRoot: string): TriggerRule[] {
  try {
    const filePath = path.join(repoRoot, '.promptwheel', 'triggers.json');
    if (!fs.existsSync(filePath)) return [];

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data || !Array.isArray(data.rules)) return [];

    // Basic validation: each rule needs id, name, condition, action
    return data.rules.filter((r: unknown) => {
      if (typeof r !== 'object' || r === null) return false;
      const rule = r as Record<string, unknown>;
      return (
        typeof rule.id === 'string' &&
        typeof rule.name === 'string' &&
        typeof rule.condition === 'object' &&
        rule.condition !== null &&
        typeof rule.action === 'string' &&
        ['warn', 'abort', 'log'].includes(rule.action as string)
      );
    }) as TriggerRule[];
  } catch {
    return [];
  }
}
