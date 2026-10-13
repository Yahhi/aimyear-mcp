/**
 * The MCP surface fingerprint: what a client sees before calling anything
 * (initialize without serverInfo.version, tools/list, prompts/list), normalised and
 * hashed. surface.lock.json holds it with the version; test/surface.test.ts fails when
 * the surface changes and the version does not, so a listing never describes a server
 * that no longer exists.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './http.js';

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortKeys((v as any)[k])]))
      : v;

export async function surface() {
  const server = buildServer(null, 'surface', 'desktop');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'surface', version: '1' });
  await client.connect(b);
  const info = client.getServerVersion();
  const doc = {
    initialize: { capabilities: client.getServerCapabilities(), serverInfo: { name: info?.name }, instructions: client.getInstructions() },
    tools: (await client.listTools()).tools.sort((x, y) => x.name.localeCompare(y.name)),
    prompts: (await client.listPrompts()).prompts.sort((x, y) => x.name.localeCompare(y.name)),
  };
  await client.close();
  const sha256 = createHash('sha256').update(JSON.stringify(sortKeys(doc))).digest('hex');
  return { version: info?.version ?? '', sha256, tools: doc.tools.length, prompts: doc.prompts.length };
}
