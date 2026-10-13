import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { surface } from '../src/surface.js';

test('the MCP surface matches surface.lock.json: a changed surface needs a new version', async () => {
  const lock = JSON.parse(readFileSync(new URL('../surface.lock.json', import.meta.url), 'utf8'));
  const now = await surface();
  if (now.sha256 !== lock.sha256) {
    assert.notEqual(now.version, lock.version, 'the tools, prompts or instructions changed: bump VERSION in src/version.ts, then run npm run surface-lock');
    assert.fail(`version is now ${now.version}: run npm run surface-lock to record the new surface`);
  }
  assert.equal(now.version, lock.version, 'version changed without a surface change: run npm run surface-lock');
});
