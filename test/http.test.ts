import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, rpc, call, INIT } from './helpers.js';
import { TOOLS } from '../src/access.js';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });
const mcp = () => `${app.url}/mcp`;

test('without a token: initialize and tools/list answer, with the real server info and every tool', async () => {
  const init = await rpc(mcp(), call(1, 'initialize', INIT));
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'aimyear');
  assert.ok(init.json.result.instructions?.length > 50, 'initialize carries instructions');
  const list = await rpc(mcp(), call(2, 'tools/list'));
  assert.equal(list.status, 200);
  assert.equal(list.json.result.tools.length, Object.keys(TOOLS).length);
  const prompts = await rpc(mcp(), call(3, 'prompts/list'));
  assert.equal(prompts.status, 200);
});

test('without a token: tools/call is 401 with a WWW-Authenticate header that points to OAuth discovery', async () => {
  const r = await rpc(mcp(), call(1, 'tools/call', { name: 'get_goal', arguments: {} }));
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="http:\/\/localhost:1\/\.well-known\/oauth-protected-resource\/mcp"$/);
});

test('a batch that smuggles tools/call behind initialize is refused as a whole', async () => {
  const r = await rpc(mcp(), [call(1, 'initialize', INIT), call(2, 'tools/call', { name: 'get_goal', arguments: {} })]);
  assert.equal(r.status, 401);
});

test('an unknown or bad token is 401 with error="invalid_token", never anonymous access', async () => {
  const stubProvider = await rpc(mcp(), call(1, 'tools/call', { name: 'get_goal', arguments: {} }), { Authorization: 'Bearer nope' });
  // The stub provider has no database, so verification fails closed.
  assert.equal(stubProvider.status, 401);
  assert.match(stubProvider.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
});

test('empty or unparseable bodies are not public', async () => {
  assert.equal((await rpc(mcp(), '')).status, 401);
  assert.equal((await rpc(mcp(), '{nope')).status, 400); // express rejects malformed JSON before the gate
});

test('version negotiation answers a version the server implements, never an echo', async () => {
  const r = await rpc(mcp(), call(1, 'initialize', { ...INIT, protocolVersion: 'banana' }));
  assert.equal(r.status, 200);
  assert.notEqual(r.json.result.protocolVersion, 'banana');
});

test('Origin: none and known clients are allowed; a random site is refused', async () => {
  assert.equal((await rpc(mcp(), call(1, 'initialize', INIT))).status, 200);
  assert.equal((await rpc(mcp(), call(1, 'initialize', INIT), { Origin: 'https://claude.ai' })).status, 200);
  assert.equal((await rpc(mcp(), call(1, 'initialize', INIT), { Origin: 'https://example.com' })).status, 403);
});

test('OAuth discovery documents answer without a token', async () => {
  const as = await (await fetch(`${app.url}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, 'http://localhost:1/');
  assert.ok(as.registration_endpoint && as.token_endpoint && as.authorization_endpoint);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const pr = await (await fetch(`${app.url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(pr.resource, 'http://localhost:1/mcp');
});

test('the legacy menu bar endpoints still refuse a wrong token', async () => {
  assert.equal((await fetch(`${app.url}/now/wrong`)).status, 401);
  assert.equal((await fetch(`${app.url}/tick/wrong`, { method: 'POST' })).status, 401);
});
