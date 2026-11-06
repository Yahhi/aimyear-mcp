import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/http.js';

// A client without the /aim skill installed still gets the method: as a prompt and as a resource.
test('the /aim skill is served as the "aim" prompt and the aimyear://skill/aim resource, without sign-in', async () => {
  const file = readFileSync(new URL('../skills/aim/SKILL.md', import.meta.url), 'utf8');
  const server = buildServer(null, 'skill-test', 'desktop');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'skill-test', version: '1' });
  await client.connect(b);

  assert.match(client.getInstructions() ?? '', /prompt "aim", also the resource aimyear:\/\/skill\/aim/);
  assert.ok((await client.listPrompts()).prompts.some(p => p.name === 'aim'));
  const prompt = (await client.getPrompt({ name: 'aim' })).messages[0].content as { text: string };
  assert.match(prompt.text, /^Use this method/);
  assert.match(prompt.text, /# \/aim — one big aim/);
  assert.doesNotMatch(prompt.text, /^name: aim$/m, 'the frontmatter is left out of the prompt');

  assert.deepEqual((await client.listResources()).resources.map(r => r.uri), ['aimyear://skill/aim']);
  const res = await client.readResource({ uri: 'aimyear://skill/aim' });
  assert.equal((res.contents[0] as { text: string }).text, file, 'the resource is the skill file as it is');
  await client.close();
});
