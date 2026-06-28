import { SYSTEM_PROMPT_TOKENS } from './feature.mjs';
// est. $/run = (system prompt + avg input + avg output) tokens * price/token (~$2/1M)
console.log(((SYSTEM_PROMPT_TOKENS + 80 + 20) * 0.000002).toFixed(5));
