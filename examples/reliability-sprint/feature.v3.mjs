export const PROMPT_VERSION = 'v3';
export const SYSTEM_PROMPT_TOKENS = 240;
const has = (t, ...w) => w.some((x) => t.includes(x));
export function classify(text) {
  const t = text.toLowerCase();
  // tried to "catch more bugs" — over-broad, now swallows other intents
  if (has(t, 'not', 'will not', 'cannot', 'issue', 'problem', 'higher', 'change')) return 'bug';
  if (has(t, 'charge', 'invoice', 'refund', 'bill', 'payment', 'card', 'balance')) return 'billing';
  if (has(t, 'crash', 'error', 'bug', 'broken', 'freez', 'frozen', 'hang', 'stuck')) return 'bug';
  if (has(t, 'add', 'feature', 'request', 'support', 'dark mode', 'export', 'wish')) return 'feature';
  return 'other';
}
