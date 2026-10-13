import { writeFileSync } from 'node:fs';
import { renderAccessDoc } from '../src/access.js';
writeFileSync(new URL('../docs/ACCESS.md', import.meta.url), renderAccessDoc());
console.log('docs/ACCESS.md written');
