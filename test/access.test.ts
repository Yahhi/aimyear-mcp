import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, createApp } from '../src/http.js';
import { TOOLS, METHODS, ROUTES, isPublicBody, renderAccessDoc } from '../src/access.js';
import { FirestoreOAuthProvider } from '../src/oauth.js';

async function listedTools() {
  const server = buildServer(null, 'test', 'desktop');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  await client.close();
  return tools;
}

test('every tool the server lists has an entry in the access table, and every entry is a real tool', async () => {
  const names = (await listedTools()).map(t => t.name).sort();
  assert.deepEqual(names.filter(n => !TOOLS[n]), [], 'tools missing from src/access.ts TOOLS');
  assert.deepEqual(Object.keys(TOOLS).filter(n => !names.includes(n)), [], 'TOOLS lists tools the server does not have');
});

test('every app-level route has an entry in the access table', () => {
  const app = createApp({ tokens: new Map(), baseUrl: new URL('http://localhost:1'), provider: new FirestoreOAuthProvider(new URL('http://localhost:1/mcp'), {} as any) });
  const routes: string[] = [];
  for (const layer of (app as any).router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods).filter(m => m !== '_all').map(m => m.toUpperCase());
    for (const m of methods.length ? methods : ['POST']) routes.push(`${m} ${layer.route.path}`);
  }
  assert.ok(routes.length >= 5, `found routes: ${routes.join(', ')}`);
  assert.deepEqual(routes.filter(r => !ROUTES[r]), [], 'routes missing from src/access.ts ROUTES');
});

test('every tool carries annotations a client can show before approving it', async () => {
  for (const t of await listedTools()) {
    assert.ok(t.annotations?.title, `${t.name}: no title`);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name}: no readOnlyHint`);
    assert.equal(typeof t.annotations?.destructiveHint, 'boolean', `${t.name}: no destructiveHint`);
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
  }
});

test('only describing methods are public; anything else, and any mixed batch, needs a token', () => {
  assert.equal(METHODS['tools/call'].level, 'auth');
  assert.ok(isPublicBody({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.ok(isPublicBody([{ method: 'initialize' }, { method: 'tools/list' }]));
  assert.equal(isPublicBody([{ method: 'initialize' }, { method: 'tools/call' }]), false);
  assert.equal(isPublicBody({ method: 'resources/read' }), false, 'unlisted methods default to auth');
  assert.equal(isPublicBody([]), false);
  assert.equal(isPublicBody(undefined), false);
  assert.equal(isPublicBody('garbage'), false);
  assert.equal(isPublicBody([null]), false);
});

test('docs/ACCESS.md is generated from the table and is up to date', () => {
  assert.equal(readFileSync(new URL('../docs/ACCESS.md', import.meta.url), 'utf8'), renderAccessDoc(), 'run: npm run access-doc');
});
