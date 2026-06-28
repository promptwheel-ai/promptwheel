// Sample "AI feature": classify a support message into an intent.
// In production this is an LLM call with a prompt; here it's a deterministic
// stand-in so the demo runs with no API key. Editing the rules == editing the prompt.
export const PROMPT_VERSION = 'v1';
export const SYSTEM_PROMPT_TOKENS = 620; // verbose prompt
const has = (t, ...w) => w.some((x) => t.includes(x));
export function classify(text) {
  const t = text.toLowerCase();
  if (has(t, 'charge', 'invoice', 'refund', 'bill')) return 'billing';
  if (has(t, 'crash', 'error', 'bug', 'broken')) return 'bug';
  if (has(t, 'add', 'feature', 'request')) return 'feature';
  return 'other';
}
