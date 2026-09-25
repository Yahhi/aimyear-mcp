#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Store, Notifications } from './store.js';
import { AimService } from './service.js';
import { registerTools } from './tools.js';
import { tick } from './notifier.js';
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

/**
 * Phase-1 HTTP mode, stateless (safe on Cloud Run): every request builds a fresh server.
 * Auth, until OAuth lands:
 *   - Authorization: Bearer <token>   → POST /mcp            (Claude Code, scripts)
 *   - secret path segment              → POST /c/<token>/mcp  (claude.ai custom connector, which cannot send headers)
 * AIMYEAR_TOKENS="token=uid,token2=uid2".
 */
async function http() {
  const port = Number(process.env.PORT ?? 8787);
  const tokens = new Map((process.env.AIMYEAR_TOKENS ?? '').split(',').filter(Boolean).map(p => p.split('=') as [string, string]));
  if (tokens.size === 0) { console.error('AIMYEAR_TOKENS is required in http mode'); process.exit(2); }
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => { res.json({ ok: true, version: VERSION }); });

  // Cloud Scheduler polls this every minute. The secret lives in the path, as with /c/:token/mcp.
  app.post('/tick/:token', async (req, res) => {
    if (!tokens.has(String(req.params.token))) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = await tick(new Notifications());
      if (result.processed) console.error('[tick]', JSON.stringify(result));
      res.json(result);
    } catch (e) { console.error('[tick] failed', e); res.status(500).json({ error: (e as Error).message }); }
  });

  const handle = async (req: express.Request, res: express.Response, token: string) => {
    const uid = tokens.get(token);
    if (!uid) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.method === 'GET' || req.method === 'DELETE') { res.status(405).set('Allow', 'POST').json({ error: 'stateless server: POST only' }); return; }
    const workplace = (req.header('x-aimyear-workplace') as Workplace) ?? 'mobile';
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(uid, `remote:${token.slice(0, 6)}`, workplace);
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.all('/mcp', (req, res) => handle(req, res, (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')).catch(e => { console.error(e); if (!res.headersSent) res.status(500).end(); }));
  app.all('/c/:token/mcp', (req, res) => handle(req, res, String(req.params.token)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).end(); }));
  app.listen(port, () => console.error(`aimyear-mcp http on :${port}`));
}

if (process.argv.includes('--http')) http().catch(e => { console.error(e); process.exit(1); });
else stdio().catch(e => { console.error(e); process.exit(1); });
