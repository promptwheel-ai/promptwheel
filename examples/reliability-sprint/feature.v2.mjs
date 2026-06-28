export const PROMPT_VERSION = 'v2';
export const SYSTEM_PROMPT_TOKENS = 240; // tightened prompt
const has = (t, ...w) => w.some((x) => t.includes(x));
export function classify(text) {
  const t = text.toLowerCase();
  if (has(t, 'charge', 'invoice', 'refund', 'bill', 'payment', 'card', 'balance')) return 'billing';
  if (has(t, 'crash', 'error', 'bug', 'broken', 'freez', 'frozen', 'hang', 'not load', 'will not load', 'stuck')) return 'bug';
  if (has(t, 'add', 'feature', 'request', 'support', 'would be nice', 'dark mode', 'export', 'wish')) return 'feature';
  return 'other';
}
