import { classify } from './feature.mjs';
import { readFileSync } from 'node:fs';
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url)));
let ok = 0;
for (const c of golden) if (classify(c.text) === c.intent) ok++;
console.log((ok / golden.length).toFixed(3)); // pass rate
