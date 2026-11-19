/**
 * Remote mode (Cloud Run): one Express app, stateless, every MCP request builds a fresh
 * server. Who may call what is decided in src/access.ts; this file only enforces it.
 *
 * Auth on /mcp and every Bearer route, in order:
 *  1. a static per-person token from AIMYEAR_TOKENS (Claude Code, scripts, the menu bar app);
 *  2. a Firebase ID token (a JWT: the AimYear app's own sign-in), verified with
 *     firebase-admin, revocation checked; its uid is the same uid the OAuth flow uses;
 *  3. an OAuth 2.1 access token (Claude, ChatGPT and other connector clients);
 *  4. none: only the public JSON-RPC methods answer (initialize, tools/list, …); anything
 *     else gets 401 with a WWW-Authenticate header that points to the OAuth discovery.
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { Store, Notifications } from './store.js';
import { AimService, AimError, ProRequiredError } from './service.js';
import { registerTools, INSTRUCTIONS } from './tools.js';
import { getAuth } from 'firebase-admin/auth';
import { timingSafeEqual, createHash } from 'node:crypto';
import { tick, pullDesktop } from './notifier.js';
import { reportLive, syncLive, type SendLive } from './live.js';
import { isPublicBody } from './access.js';
import { FirestoreOAuthProvider, SCOPE } from './oauth.js';
import { instrument, logRefused, type CallContext } from './calllog.js';
import { VERSION } from './version.js';
import { ConflictError, NotFoundError, SocialService, type SocialDeps } from './social/service.js';
import { NETWORKS, type Network } from './types.js';
import type { Workplace } from './types.js';
import { AccountService, agentFromUserAgent, agentName, firestoreAccountBackend, type AccountBackend } from './account.js';
import { pro as realPro, type createPro } from './pro.js';
import { initFirestore } from './store.js';
import { realReviewDeps, type ReviewDeps } from './review/deliver.js';
import { unsubscribeKey, unsubscribePage, verifyUnsubscribeToken } from './review/unsubscribe.js';

/** Who is calling, for the record: the agent's name on sessions, and the OAuth client id. */
export interface Caller { agent?: () => Promise<string | undefined>; clientId?: string; accountBackend?: AccountBackend; storeFor?: (uid: string) => Store; sendLive?: SendLive }

export function buildServer(uid: string | null, clientSessionId: string, workplace: Workplace, socialDeps?: SocialDeps, caller: Caller = {}) {
  const server = new McpServer({ name: 'aimyear', version: VERSION }, { instructions: INSTRUCTIONS });
  if (!uid) { registerTools(server, null, null, null); return server; }
  const store = caller.storeFor ? caller.storeFor(uid) : new Store(uid);
  const svc = new AimService(store, clientSessionId, workplace, caller.agent);
  registerTools(server, svc, new SocialService(store, svc, socialDeps), new AccountService(caller.accountBackend ?? firestoreAccountBackend(), uid, caller.clientId), () => syncLive(store, { send: caller.sendLive }));
  return server;
}

/** A Firebase ID token is a JWT; OAuth and static tokens never contain a dot. */
export const looksLikeJwt = (t: string) => /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(t);

export type VerifyIdToken = (token: string) => Promise<{ uid: string; firebase?: { sign_in_provider?: string } }>;
const realVerify: VerifyIdToken = t => { initFirestore(); return getAuth().verifyIdToken(t, true); };

const sameSecret = (a: string, b: string) => {
  const h = (x: string) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(a), h(b));
};

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
  /** Tests pass fake networks and a fake Pro check; production uses the real ones. */
  socialDeps?: SocialDeps;
  /** Tests pass a fake Firebase ID token check; production uses firebase-admin. */
  verifyIdToken?: VerifyIdToken;
  /** Tests pass an in-memory account backend; production uses Firestore. */
  accountBackend?: AccountBackend;
  /** Tests pass a Pro checker with fake RevenueCat; production uses src/pro.ts. */
  pro?: ReturnType<typeof createPro>;
  /** Tests pass a fake reminder store; production uses Firestore. */
  notifications?: () => Notifications;
  /** REVENUECAT_WEBHOOK_AUTH; tests pass their own. */
  webhookAuth?: string;
  /** Tests pass an in-memory store; production uses Firestore. */
  storeFor?: (uid: string) => Store;
  /** The weekly review email: tests pass a fake sender, Pro check and email lookup; production uses SES. */
  reviews?: () => ReviewDeps;
  /** The unsubscribe link's HMAC key; tests pass their own, production reads it from the env. */
  unsubscribeKey?: Buffer | null;
  /** Tests capture the Live Activity pushes; production sends them through FCM. */
  sendLive?: SendLive;
}

export function createApp({ tokens, baseUrl, provider, extraOrigins = [], socialDeps, verifyIdToken = realVerify, accountBackend, pro, notifications = () => new Notifications(), webhookAuth = process.env.REVENUECAT_WEBHOOK_AUTH, storeFor = (uid: string) => new Store(uid), reviews, unsubscribeKey: unsubKey = unsubscribeKey(), sendLive }: AppOptions) {
  const accounts = () => accountBackend ?? firestoreAccountBackend();
  let realReviews: ReviewDeps | null = null;
  const reviewDeps = reviews ?? (() => (realReviews ??= realReviewDeps(baseUrl)));
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
      const svc = new AimService(storeFor(uid), 'now', 'desktop');
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
      const { reminders, continued } = await pullDesktop(uid, notifications());
      res.json({ reminders: reminders.map(r => ({ kind: r.kind, title: r.title, body: r.body })), continued_block: continued ?? null });
    } catch (e) { console.error('[pull] failed', e); res.status(500).json({ error: (e as Error).message }); }
  });

  // Cloud Scheduler polls this every minute. The secret lives in the path.
  app.post('/tick/:token', async (req, res) => {
    if (!tokens.has(String(req.params.token))) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = await tick(notifications(), new Date(), undefined, { reviews: reviewDeps });
      if (result.processed) console.error('[tick]', JSON.stringify(result));
      res.json(result);
    } catch (e) { console.error('[tick] failed', e); res.status(500).json({ error: (e as Error).message }); }
  });

  // ---- the weekly review email's unsubscribe link (docs/weekly-review.md, RFC 8058) ----
  // GET shows a confirm button (a link scanner that opens it changes nothing); POST turns
  // the email off: the button, and mail clients' one-click (body List-Unsubscribe=One-Click).
  const unsubToken = (req: express.Request) => String((req.query.t ?? (req.body as { t?: unknown } | undefined)?.t) ?? '');
  const unsubPage = (res: express.Response, status: number, html: string) => { res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).send(html); };
  app.get('/email/unsubscribe', (req, res) => {
    const t = unsubToken(req);
    if (!unsubKey || !verifyUnsubscribeToken(unsubKey, t)) { unsubPage(res, 400, unsubscribePage('invalid')); return; }
    unsubPage(res, 200, unsubscribePage('confirm', t));
  });
  app.post('/email/unsubscribe', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const uid = unsubKey ? verifyUnsubscribeToken(unsubKey, unsubToken(req)) : null;
    if (!uid) { unsubPage(res, 400, unsubscribePage('invalid')); return; }
    try {
      await new AimService(storeFor(uid), 'unsubscribe', 'mobile').setSettings({ weekly_review_email: false });
      unsubPage(res, 200, unsubscribePage('done'));
    } catch (e) { console.error('[unsubscribe] failed', (e as Error).message); unsubPage(res, 500, unsubscribePage('invalid')); }
  });

  // ---- MCP ----
  type Who = { uid: string; via: 'oauth' | 'token' | 'firebase'; client: string; clientId?: string; agent: () => Promise<string | undefined> } | null | 'invalid';
  const identify = async (token: string, userAgent?: string): Promise<Who> => {
    if (!token) return null;
    const ua = async () => agentFromUserAgent(userAgent);
    const uid = tokens.get(token);
    if (uid) return { uid, via: 'token', client: `token:${token.slice(0, 6)}`, agent: ua };
    if (looksLikeJwt(token)) {
      try {
        const d = await verifyIdToken(token);
        // Same rule as the consent page: a guest account has no AimYear record to act on.
        if (!d?.uid || d.firebase?.sign_in_provider === 'anonymous') return 'invalid';
        return { uid: d.uid, via: 'firebase', client: 'app', agent: async () => 'app' };
      } catch { return 'invalid'; }
    }
    try {
      const info = await oauth.verifyAccessToken(token);
      const clientId = info.clientId;
      return {
        uid: String(info.extra?.uid), via: 'oauth', client: `oauth:${clientId.slice(0, 8)}`, clientId,
        agent: async () => { let name: string | undefined; try { name = (await oauth.clientsStore.getClient(clientId))?.client_name; } catch { /* lookup failed: fall back to the user agent */ } return agentName(name) ?? (await ua()); },
      };
    } catch { return 'invalid'; }
  };

  const handle = async (req: express.Request, res: express.Response, token: string) => {
    if (!originAllowed(req.header('origin'), baseUrl, extraOrigins)) { res.status(403).json({ error: 'origin not allowed' }); return; }
    const who = await identify(token, req.header('user-agent'));
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
    const server = buildServer(signedIn?.uid ?? null, signedIn ? `remote:${signedIn.client}` : 'anonymous', workplace, socialDeps, signedIn ? { agent: signedIn.agent, clientId: signedIn.clientId, accountBackend: accounts(), storeFor, sendLive } : {});
    instrument(transport, req.body, ctx);
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const bearer = (req: express.Request) => (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  // The Post action of the evening offer (the phone app, a notification button). Same
  // sign-in as /mcp: an OAuth access token or a static token, as a Bearer header.
  // Body: { date, text?, networks?, wip_todos? }. Safe to retry: a day goes to each network
  // (on WIP, each project) once.
  app.post('/social/post', async (req, res) => {
    try {
      if (!originAllowed(req.header('origin'), baseUrl, extraOrigins)) { res.status(403).json({ error: 'origin not allowed' }); return; }
      const who = await identify(bearer(req), req.header('user-agent'));
      if (!who || who === 'invalid') { res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"`).json({ error: 'sign in required' }); return; }
      const b = (req.body ?? {}) as { date?: unknown; text?: unknown; networks?: unknown; wip_todos?: unknown };
      const date = typeof b.date === 'string' ? b.date : undefined;
      const text = typeof b.text === 'string' ? b.text : undefined;
      const networks = Array.isArray(b.networks) ? b.networks.filter((n): n is Network => (NETWORKS as readonly string[]).includes(n as string)) : undefined;
      // The WIP todos as shown (one per project): [{key, text}], at most 20.
      const wip_todos = Array.isArray(b.wip_todos)
        ? b.wip_todos.slice(0, 20).flatMap(t => t && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string'
          ? [{ key: typeof (t as { key?: unknown }).key === 'string' ? (t as { key: string }).key : undefined, text: (t as { text: string }).text }] : [])
        : undefined;
      const store = storeFor(who.uid);
      const social = new SocialService(store, new AimService(store, 'social-post', 'mobile', who.agent), socialDeps);
      res.json(await social.post({ date, text, networks, wip_todos }));
    } catch (e) {
      const msg = e instanceof AimError ? e.message : 'Something went wrong. Try again: a retry never posts the same day twice.';
      if (!(e instanceof AimError)) console.error('[social/post] failed', (e as Error).name);
      if (e instanceof ProRequiredError) { res.status(402).json({ error: msg, code: e.code, speak: msg }); return; }
      res.status(e instanceof AimError ? 400 : 500).json({ error: msg, speak: msg });
    }
  });

  // ---- Bearer routes for the apps: the same sign-in as /mcp ----
  type Signed = Exclude<Who, null | 'invalid'>;
  const signed = (fn: (req: express.Request, res: express.Response, who: Signed) => Promise<void>) => async (req: express.Request, res: express.Response) => {
    try {
      if (!originAllowed(req.header('origin'), baseUrl, extraOrigins)) { res.status(403).json({ error: 'origin not allowed' }); return; }
      const who = await identify(bearer(req), req.header('user-agent'));
      if (!who || who === 'invalid') { res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"${who === 'invalid' ? ', error="invalid_token"' : ''}`).json({ error: 'sign in required', speak: 'Sign in to AimYear again.' }); return; }
      await fn(req, res, who);
    } catch (e) {
      const msg = e instanceof AimError ? e.message : 'Something went wrong. Try again.';
      if (!(e instanceof AimError)) console.error(`[${req.path}] failed`, (e as Error).message);
      if (e instanceof ProRequiredError) { if (!res.headersSent) res.status(402).json({ error: msg, code: e.code, speak: msg }); return; }
      if (e instanceof NotFoundError || e instanceof ConflictError) { if (!res.headersSent) res.status(e instanceof NotFoundError ? 404 : 409).json({ error: msg, code: e.code, speak: msg }); return; }
      if (!res.headersSent) res.status(e instanceof AimError ? 400 : 500).json({ error: msg, speak: msg });
    }
  };
  const workplaceOf = (req: express.Request): Workplace => (req.header('x-aimyear-workplace') === 'mobile' ? 'mobile' : 'desktop');
  const svcFor = (who: Signed, req: express.Request, label: string) => new AimService(storeFor(who.uid), `remote:${who.client}:${label}`, workplaceOf(req), who.agent);

  // A desktop app (macOS, Windows) polls this about every minute. Each reminder comes once.
  // pricing.md: reminders are Pro. A Free desktop app gets a refusal it can show as the paywall.
  const REMINDERS_PRO = 'Stand-up reminders are part of AimYear Pro. Get Pro on aimyear.com or in the app.';
  const LIVE_PRO = 'The running timer on the Lock Screen is part of AimYear Pro. Get Pro on aimyear.com or in the app.';
  const requirePro = async (uid: string, why = REMINDERS_PRO) => { if (!(await (pro ?? realPro()).isPro(uid))) throw new ProRequiredError(why); };
  app.post('/desktop/reminders', signed(async (_req, res, who) => {
    await requirePro(who.uid);
    const { reminders } = await pullDesktop(who.uid, notifications());
    res.json({
      reminders: reminders.map(r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, block_id: r.blockId || null, due_at: r.dueAt, actions: r.actions })),
      poll_after_seconds: 60,
    });
  }));
  // The stand-up's buttons. Body: { action: 'break' | 'snooze', minutes?, reminder_id? }.
  app.post('/desktop/reminders/action', signed(async (req, res, who) => {
    await requirePro(who.uid);
    const b = (req.body ?? {}) as { action?: unknown; minutes?: unknown };
    const minutes = typeof b.minutes === 'number' && Number.isFinite(b.minutes) ? b.minutes : undefined;
    const svc = svcFor(who, req, 'reminder');
    if (b.action === 'break') { const r = await svc.takeBreak(minutes); await syncLive(storeFor(who.uid), { send: sendLive }); res.json(r); return; }
    if (b.action === 'snooze') { res.json(await svc.snoozeStandup(minutes)); return; }
    throw new AimError('action must be "break" or "snooze"');
  }));

  // ---- automatic WIP todos (docs/public-posting.md, "Work posts to WIP, automatic with undo") ----
  // The push (data.kind auto_post) carries Cancel and Edit. Cancel: POST .../cancel, no body.
  // Edit: the app shows data.text; saving POSTs { text } to .../edit, which posts at once.
  // Both answer { ok, auto_post, speak }; 404 for an unknown id, 409 when it is too late
  // (already posted or posting). GET lists a day's (?date=YYYY-MM-DD, default today).
  const socialFor = (who: Signed, req: express.Request, label: string) => { const store = storeFor(who.uid); return new SocialService(store, new AimService(store, `remote:${who.client}:${label}`, workplaceOf(req), who.agent), socialDeps); };
  app.get('/social/auto-posts', signed(async (req, res, who) => {
    res.set('Cache-Control', 'no-store').json(await socialFor(who, req, 'auto-post').listAutoPosts(typeof req.query.date === 'string' ? req.query.date : undefined));
  }));
  app.post('/social/auto-posts/:id/cancel', signed(async (req, res, who) => {
    res.json(await socialFor(who, req, 'auto-post').cancelAutoPost(String(req.params.id)));
  }));
  app.post('/social/auto-posts/:id/edit', signed(async (req, res, who) => {
    const text = (req.body ?? {}).text;
    if (typeof text !== 'string') throw new AimError('Send the todo as { "text": "…" }.');
    res.json(await socialFor(who, req, 'auto-post').editAutoPost(String(req.params.id), text));
  }));

  // ---- the running timer on the iPhone: a Live Activity (src/live.ts, docs/notifications.md) ----
  // The app reports its tokens here, Pro only like the rest of notifications. Body:
  // { token: the device's FCM token (registered with add_device), start_token?: ActivityKit's
  //   push-to-start token (iOS 17.2+), activity_token?: the push token of the activity it
  //   shows now, ended?: true when that activity is gone }. null clears a token.
  app.post('/devices/live-activity', signed(async (req, res, who) => {
    await requirePro(who.uid, LIVE_PRO);
    const b = (req.body ?? {}) as { token?: unknown; start_token?: unknown; activity_token?: unknown; ended?: unknown };
    const tok = (v: unknown, name: string) => {
      if (v === undefined || v === null) return v as undefined | null;
      if (typeof v !== 'string' || !/^[0-9a-fA-F]{16,512}$/.test(v)) throw new AimError(`${name} must be the hex token ActivityKit gave the app`);
      return v;
    };
    if (typeof b.token !== 'string' || b.token.length < 20) throw new AimError('token: the device\'s FCM token, as registered with add_device');
    const r = await reportLive(storeFor(who.uid), b.token, { startToken: tok(b.start_token, 'start_token'), activityToken: tok(b.activity_token, 'activity_token'), ended: b.ended === true }, sendLive);
    res.status(r.ok ? 200 : 404).json(r.ok ? r : { ...r, error: 'Register this device first (add_device), then send its Live Activity tokens.' });
  }));

  // ---- the app's day: docs/app-data.md ----
  // The app reads Firestore and writes through the server. Opening the day completes what
  // it will read: today's plan with its routines, and the Pro status at aim/pro.
  app.post('/account/open-day', signed(async (req, res, who) => {
    const day = await svcFor(who, req, 'open-day').openDay();
    const isPro = await (pro ?? realPro()).sync(who.uid).catch(() => null);
    res.set('Cache-Control', 'no-store').json({ ...day, pro: isPro });
  }));

  // ---- the account: connected agents, export, delete ----
  app.get('/account/agents', signed(async (_req, res, who) => {
    res.json(await new AccountService(accounts(), who.uid, who.clientId).listAgents());
  }));
  app.delete('/account/agents/:clientId', signed(async (req, res, who) => {
    const r = await new AccountService(accounts(), who.uid, who.clientId).disconnectAgent(String(req.params.clientId));
    res.status(r.ok ? 200 : 404).json(r);
  }));
  app.get('/account/export', signed(async (_req, res, who) => {
    const out = await new AccountService(accounts(), who.uid, who.clientId).export();
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="aimyear-export-${out.exported_at.slice(0, 10)}.json"` }).json(out);
  }));
  // Only the app's own Firebase sign-in may delete the account: never an agent's token.
  app.post('/account/delete', signed(async (req, res, who) => {
    if (who.via !== 'firebase') { res.status(403).json({ error: 'Delete the account from the AimYear app.', speak: 'Deleting the account is done in the AimYear app, signed in as you.' }); return; }
    if ((req.body ?? {}).confirm !== true) throw new AimError('Pass {"confirm": true} to delete the account and all its data.');
    res.set('Cache-Control', 'no-store').json(await new AccountService(accounts(), who.uid).deleteEverything());
  }));

  // ---- RevenueCat: subscription events keep users/{uid}/aim/pro current ----
  app.post('/revenuecat/webhook', async (req, res) => {
    const got = req.header('authorization') ?? '';
    if (!webhookAuth || !got || !sameSecret(got, webhookAuth)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const updated = await (pro ?? realPro()).applyWebhook(req.body);
      // Someone who bought Pro on aimyear.com may never open the app: queue their Sunday review here.
      for (const uid of updated) await new AimService(storeFor(uid), 'revenuecat', 'mobile').armWeeklyReview().catch(e => console.error('[revenuecat] weekly review arm failed', (e as Error).message));
      res.json({ ok: true, updated: updated.length });
    } catch (e) { console.error('[revenuecat] failed', (e as Error).message); res.status(500).json({ error: 'try again' }); }
  });

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
