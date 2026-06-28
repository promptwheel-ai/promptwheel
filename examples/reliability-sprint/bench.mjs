import { classify } from './feature.mjs';
import { readFileSync } from 'node:fs';
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url)));
const t0 = performance.now();
for (let i = 0; i < 50000; i++) for (const c of golden) classify(c.text);
console.log((performance.now() - t0).toFixed(1)); // ms — real + a little noisy
