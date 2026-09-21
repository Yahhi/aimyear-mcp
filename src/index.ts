#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Store } from './store.js';
import { AimService } from './service.js';
import { registerTools } from './tools.js';
import type { Workplace } from './types.js';

const VERSION = '0.1.0';

function buildServer(uid: string, clientSessionId: string, workplace: Workplace) {
  const server = new McpServer({ name: 'aimyear', version: VERSION });
  registerTools(server, new AimService(new Store(uid), clientSessionId, workplace));
  return server;
}

async function stdio() {
  const uid = process.env.AIMYEAR_UID;
  if (!uid) { console.error('AIMYEAR_UID is required in stdio mode'); process.exit(2); }
  const workplace = (process.env.AIMYEAR_WORKPLACE as Workplace) ?? 'desktop';
  const server = buildServer(uid, randomUUID(), workplace);
  await server.connect(new StdioServerTransport());
}

/** Phase-1 HTTP mode: bearer tokens from AIMYEAR_TOKENS="token=uid,token2=uid2". OAuth comes later. */
async function http() {
  const port = Number(process.env.PORT ?? 8787);
  const tokens = new Map((process.env.AIMYEAR_TOKENS ?? '').split(',').filter(Boolean).map(p => p.split('=') as [string, string]));
  if (tokens.size === 0) { console.error('AIMYEAR_TOKENS is required in http mode'); process.exit(2); }
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get('/health', (_req, res) => { res.json({ ok: true, version: VERSION }); });
  app.all('/mcp', async (req, res) => {
    const auth = req.header('authorization') ?? '';
    const uid = tokens.get(auth.replace(/^Bearer\s+/i, ''));
    if (!uid) { res.status(401).json({ error: 'unauthorized' }); return; }
    const sid = req.header('mcp-session-id');
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      if (req.method !== 'POST') { res.status(400).json({ error: 'no session' }); return; }
      const workplace = (req.header('x-aimyear-workplace') as Workplace) ?? 'mobile';
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => { transports.set(id, transport!); } });
      transport.onclose = () => { if (transport?.sessionId) transports.delete(transport.sessionId); };
      const server = buildServer(uid, randomUUID(), workplace);
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });
  app.listen(port, () => console.error(`aimyear-mcp http on :${port}`));
}

if (process.argv.includes('--http')) http().catch(e => { console.error(e); process.exit(1); });
else stdio().catch(e => { console.error(e); process.exit(1); });
