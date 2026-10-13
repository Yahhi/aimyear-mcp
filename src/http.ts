/**
 * Remote mode (Cloud Run): one Express app, stateless, every MCP request builds a fresh
 * server. Who may call what is decided in src/access.ts; this file only enforces it.
 *
 * Auth on /mcp, in order:
 *  1. OAuth 2.1 access token (Claude, ChatGPT and other connector clients);
 *  2. a static per-person token from AIMYEAR_TOKENS (Claude Code, scripts, the menu bar app);
 *  3. none: only the public JSON-RPC methods answer (initialize, tools/list, …); anything
 *     else gets 401 with a WWW-Authenticate header that points to the OAuth discovery.
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { Store, Notifications } from './store.js';
import { AimService } from './service.js';
import { registerTools, INSTRUCTIONS } from './tools.js';
import { tick, textFor, queueNextStandup } from './notifier.js';
import { localDate } from './dates.js';
import { isPublicBody } from './access.js';
import { FirestoreOAuthProvider, SCOPE } from './oauth.js';
import { instrument, logRefused, type CallContext } from './calllog.js';
import { VERSION } from './version.js';
import type { Workplace } from './types.js';

export function buildServer(uid: string | null, clientSessionId: string, workplace: Workplace) {
  const server = new McpServer({ name: 'aimyear', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, uid ? new AimService(new Store(uid), clientSessionId, workplace) : null);
  return server;
}

/** Browsers that may call /mcp. Native clients and server-side connectors send no Origin. */
export function originAllowed(origin: string | undefined, base: URL, extra: string[] = []): boolean {
  if (!origin) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (['localhost', '127.0.0.1', '[::1]'].includes(o.hostname)) return true;
  const allowed = new Set([base.origin, 'https://claude.ai', 'https://chatgpt.com', 'https://chat.openai.com', ...extra]);
  return allowed.has(o.origin);
}

export interface AppOptions {
  tokens: Map<string, string>;
  baseUrl: URL;
  provider?: FirestoreOAuthProvider;
  extraOrigins?: string[];
}

export function createApp({ tokens, baseUrl, provider, extraOrigins = [] }: AppOptions) {
  const resourceUrl = new URL('/mcp', baseUrl);
  const oauth = provider ?? new FirestoreOAuthProvider(resourceUrl);
  const resourceMetadata = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const app = express();
  app.set('trust proxy', 1); // Cloud Run: one Google front end in front of us
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => { res.json({ ok: true, version: VERSION }); });

  // ---- OAuth: the consent page's decision, then the SDK router for the protocol ----
  app.post('/authorize/approve', express.json({ limit: '16kb' }), (req, res) => {
    oauth.approve(req, res).catch(e => { console.error('[approve]', e); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' }); });
  });
  app.use(mcpAuthRouter({
    provider: oauth, issuerUrl: baseUrl, resourceServerUrl: resourceUrl, scopesSupported: [SCOPE],
    resourceName: 'AimYear', serviceDocumentationUrl: new URL('https://aimyear.com'),
  }));

  app.use(express.json({ limit: '1mb' }));

  // ---- the menu bar app and the scheduler (static tokens) ----
  app.get('/now/:token', async (req, res) => {
    const uid = tokens.get(String(req.params.token));
    if (!uid) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const svc = new AimService(new Store(uid), 'now', 'desktop');
      const cur = await svc.getCurrent();
      const b = cur.block;
      res.json({
        running: !!b,
        direction: b?.direction ?? null,
        started_at: b?.started_at ?? null,
        elapsed_seconds: b ? Math.max(0, Math.round((Date.now() - new Date(b.started_at).getTime()) / 1000)) : 0,
        ends_at: b?.ends_at ?? null,
        seconds_left: b?.ends_at ? Math.max(0, Math.round((new Date(b.ends_at).getTime() - Date.now()) / 1000)) : null,
        kind: b?.kind ?? null,
        sessions: cur.running_sessions.map(s => s.task),
        main_step: cur.main_step,
      });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // The Mac agent polls this every minute: reminders it claims are spoken locally.
  app.post('/pull/:token', async (req, res) => {
    const uid = tokens.get(String(req.params.token));
    if (!uid) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const notif = new Notifications();
      const rows = await notif.claimDesktop(uid, new Date().toISOString());
      const profile = await notif.profileOf(uid);
      const out = [];
      let continued: string | undefined;
      for (const p of rows) {
        const main = await notif.mainStepOf(uid, localDate(new Date(p.dueAt), profile?.timezone ?? 'UTC'));
        out.push({ kind: p.kind, ...textFor(p, main) });
        // The push path keeps the cadence going in tick(); the desktop path has
        // to do it here, or the timer stops after exactly one block and one break.
        try { continued = (await queueNextStandup(p, notif)) ?? continued; } catch (e) { console.error('[pull] standup re-arm failed', e); }
      }
      res.json({ reminders: out, continued_block: continued ?? null });
    } catch (e) { console.error('[pull] failed', e); res.status(500).json({ error: (e as Error).message }); }
  });

  // Cloud Scheduler polls this every minute. The secret lives in the path.
  app.post('/tick/:token', async (req, res) => {
    if (!tokens.has(String(req.params.token))) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = await tick(new Notifications());
      if (result.processed) console.error('[tick]', JSON.stringify(result));
      res.json(result);
    } catch (e) { console.error('[tick] failed', e); res.status(500).json({ error: (e as Error).message }); }
  });

  // ---- MCP ----
  type Who = { uid: string; via: 'oauth' | 'token'; client: string } | null | 'invalid';
  const identify = async (token: string): Promise<Who> => {
    if (!token) return null;
    const uid = tokens.get(token);
    if (uid) return { uid, via: 'token', client: `token:${token.slice(0, 6)}` };
    try {
      const info = await oauth.verifyAccessToken(token);
      return { uid: String(info.extra?.uid), via: 'oauth', client: `oauth:${info.clientId.slice(0, 8)}` };
    } catch { return 'invalid'; }
  };

  const handle = async (req: express.Request, res: express.Response, token: string) => {
    if (!originAllowed(req.header('origin'), baseUrl, extraOrigins)) { res.status(403).json({ error: 'origin not allowed' }); return; }
    const who = await identify(token);
    const ctx: CallContext = {
      user: who && who !== 'invalid' ? who.uid : '',
      client: String(req.header('user-agent') ?? '').slice(0, 80),
      req: String(req.header('x-cloud-trace-context') ?? '').split('/')[0],
      auth: who && who !== 'invalid' ? who.via : 'none',
    };
    const signedIn = who && who !== 'invalid' ? who : null;
    if (!signedIn && !isPublicBody(req.body)) {
      logRefused(req.body, ctx, 401);
      res.status(401)
        .set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"${who === 'invalid' ? ', error="invalid_token"' : ''}`)
        .json({ error: who === 'invalid' ? 'invalid or expired token' : 'sign in required', resource_metadata: resourceMetadata });
      return;
    }
    const workplace = (req.header('x-aimyear-workplace') as Workplace) ?? 'mobile';
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(signedIn?.uid ?? null, signedIn ? `remote:${signedIn.client}` : 'anonymous', workplace);
    instrument(transport, req.body, ctx);
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const bearer = (req: express.Request) => (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const postOnly = (_req: express.Request, res: express.Response) => { res.status(405).set('Allow', 'POST').json({ error: 'stateless server: POST only' }); };
  for (const path of ['/mcp', '/c/:token/mcp']) { app.get(path, postOnly); app.delete(path, postOnly); }
  app.post('/mcp', (req, res) => handle(req, res, bearer(req)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).end(); }));
  app.post('/c/:token/mcp', (req, res) => handle(req, res, String(req.params.token)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).end(); }));
  // A malformed JSON body is a JSON-RPC parse error, not an HTML stack trace.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === 'entity.parse.failed') { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    next(err);
  });
  return app;
}
