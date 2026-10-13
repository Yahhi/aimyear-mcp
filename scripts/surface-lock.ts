import { writeFileSync } from 'node:fs';
import { surface } from '../src/surface.js';
const s = await surface();
writeFileSync(new URL('../surface.lock.json', import.meta.url), JSON.stringify(s, null, 2) + '\n');
console.log(`surface.lock.json: ${s.version} ${s.sha256.slice(0, 12)} (${s.tools} tools, ${s.prompts} prompts)`);
