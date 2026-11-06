/**
 * What the v2 app needs from the server (0.9): the app's Firebase sign-in as Bearer,
 * Pro from RevenueCat, desktop reminders with Break and Snooze, who started a session,
 * connected agents, export and delete, insights and comebacks, Windows devices, and the
 * timer stopping with its last session. Firebase, Firestore and RevenueCat are fakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, looksLikeJwt } from '../src/http.js';
import { AimService } from '../src/service.js';
import { AccountService, agentFromUserAgent, agentName } from '../src/account.js';
import { createPro, entitlementOf, type ProStatus } from '../src/pro.js';
import { pickDevices, pullDesktop, tick } from '../src/notifier.js';
import { computeComebacks, computeInsights, type InsightRow } from '../src/domain/insights.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';
import { FakeNotifications } from './fake-notifications.js';
import { FakeAccountBackend } from './fake-account.js';
import { rpc, call } from './helpers.js';
import type { Block, Device, Goal, Pending, Session } from '../src/types.js';

// Obviously fake JWT-shaped strings: three base64url parts, never a real token.
const JWT_U1 = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ1MSJ9.fake-signature-u1';
const JWT_REVOKED = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJyZXZva2VkIn0.fake-signature-revoked';
const JWT_GUEST = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJndWVzdCJ9.fake-signature-guest';
const OAUTH_U1 = 'oauth-access-token-for-u1-not-real';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();

async function startTestApp(opts: { pro?: ReturnType<typeof createPro>; webhookAuth?: string } = {}) {
  const stores = new Map<string, FakeStore>();
  const storeFor = (uid: string) => { if (!stores.has(uid)) stores.set(uid, new FakeStore()); return stores.get(uid)! as any; };
  const notif = new FakeNotifications();
  const accounts = new FakeAccountBackend();
  const verified: string[] = [];
  const provider = {
    verifyAccessToken: async (t: string) => {
      if (t !== OAUTH_U1) throw new Error('invalid');
      return { token: t, clientId: 'client-claude-code', scopes: ['aimyear'], extra: { uid: 'u1' } };
    },
    clientsStore: { getClient: async (id: string) => ({ client_id: id, client_name: 'Claude Code (aimyear)', redirect_uris: ['http://localhost/cb'] }) },
  };
  const app = createApp({
    tokens: new Map([['static-token-1', 'u1']]), baseUrl: new URL('http://localhost:1'), provider: provider as any,
    storeFor, notifications: () => notif as any, accountBackend: accounts, pro: opts.pro, webhookAuth: opts.webhookAuth,
    socialDeps: { clients: {} as any, isPro: async () => false },
    verifyIdToken: async (t: string) => {
      verified.push(t);
      if (t === JWT_U1) return { uid: 'u1', firebase: { sign_in_provider: 'google.com' } };
      if (t === JWT_GUEST) return { uid: 'guest', firebase: { sign_in_provider: 'anonymous' } };
      throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' });
    },
  });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { url, stores, store: (uid: string) => storeFor(uid) as FakeStore, notif, accounts, verified, close: () => new Promise<void>(r => server.close(() => r())) };
}

const bearer = (t: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${t}`, ...extra });
const toolResult = (r: Awaited<ReturnType<typeof rpc>>) => JSON.parse(r.json.result.content[0].text);
const post = (url: string, body: unknown, headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------- 1. the app's Firebase sign-in as Bearer ----------

test('a Firebase ID token is a Bearer on /mcp: verified with revocation, same uid, sessions say "app"', async () => {
  const a = await startTestApp();
  try {
    assert.ok(looksLikeJwt(JWT_U1));
    assert.equal(looksLikeJwt(OAUTH_U1), false, 'an OAuth token never takes the Firebase path');
    const r = await rpc(`${a.url}/mcp`, call(1, 'tools/call', { name: 'start_session', arguments: { task: 'Write the onboarding copy', area: 'happiness' } }), bearer(JWT_U1, { 'x-aimyear-workplace': 'mobile' }));
    assert.equal(r.status, 200);
    const started = toolResult(r);
    assert.equal(started.session.agent, 'app');
    const s = [...a.store('u1').sessions.values()][0];
    assert.equal(s.agent, 'app');
    assert.equal(s.workplace, 'mobile');
    assert.deepEqual(a.verified, [JWT_U1]);
  } finally { await a.close(); }
});

test('a revoked or guest Firebase token is 401 invalid_token; OAuth and static tokens keep working', async () => {
  const a = await startTestApp();
  try {
    for (const t of [JWT_REVOKED, JWT_GUEST]) {
      const r = await rpc(`${a.url}/mcp`, call(1, 'tools/call', { name: 'get_now', arguments: {} }), bearer(t));
      assert.equal(r.status, 401);
      assert.match(r.headers.get('www-authenticate') ?? '', /invalid_token/);
    }
    const viaOauth = await rpc(`${a.url}/mcp`, call(1, 'tools/call', { name: 'start_session', arguments: { task: 'Reply to three leads', area: 'happiness' } }), bearer(OAUTH_U1));
    assert.equal(viaOauth.status, 200);
    assert.equal(toolResult(viaOauth).session.agent, 'Claude Code', 'the OAuth client name, without the server suffix');
    const viaStatic = await rpc(`${a.url}/mcp`, call(1, 'tools/call', { name: 'get_now', arguments: {} }), bearer('static-token-1', { 'User-Agent': 'claude-code/2.1' }));
    assert.equal(viaStatic.status, 200);
    const now = toolResult(viaStatic);
    assert.deepEqual(now.running_sessions.map((x: { agent: string }) => x.agent), ['Claude Code']);
  } finally { await a.close(); }
});

test('POST /social/post accepts the Firebase token too (and still enforces Pro)', async () => {
  const a = await startTestApp();
  try {
    const r = await post(`${a.url}/social/post`, { date: '2026-10-20' }, bearer(JWT_U1));
    assert.equal(r.status, 402, 'signed in: the refusal is Pro, not the sign-in');
    const body = await r.json();
    assert.equal(body.code, 'pro_required', 'the app keys the paywall on the code, not the wording');
    assert.match(body.speak, /Pro/);
    assert.equal((await post(`${a.url}/social/post`, {}, bearer(JWT_REVOKED))).status, 401);
  } finally { await a.close(); }
});

// ---------- 2. Pro from RevenueCat ----------

function proWith(opts: { key?: boolean; answer?: unknown; status?: number; fail?: boolean; overrides?: string } = {}) {
  const stored = new Map<string, ProStatus>();
  const calls: string[] = [];
  let now = new Date('2026-10-20T12:00:00Z');
  const pro = createPro({
    env: { REVENUECAT_SECRET_KEY: opts.key ? 'sk_test_not_real' : undefined, AIMYEAR_PRO_UIDS: opts.overrides },
    fetch: (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer sk_test_not_real');
      if (opts.fail) throw new Error('network down');
      return { ok: (opts.status ?? 200) === 200, status: opts.status ?? 200, json: async () => opts.answer };
    }) as any,
    now: () => now,
    getStatus: async uid => stored.get(uid) ?? null,
    saveStatus: async (uid, s) => { stored.set(uid, s); },
  });
  return { pro, stored, calls, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const subscriber = (expires: string | null, ent = 'AimYear Pro') => ({ subscriber: { entitlements: { [ent]: { expires_date: expires, product_identifier: 'yearly_pro' } } } });

test('Pro: RevenueCat REST says the "AimYear Pro" entitlement is active; the answer is cached a minute', async () => {
  const p = proWith({ key: true, answer: subscriber('2027-10-20T12:00:00Z') });
  assert.equal(await p.pro.isPro('u1'), true);
  assert.equal(await p.pro.isPro('u1'), true);
  assert.equal(p.calls.length, 1, 'cached');
  assert.equal(p.calls[0], 'https://api.revenuecat.com/v1/subscribers/u1');
  p.advance(61_000);
  await p.pro.isPro('u1');
  assert.equal(p.calls.length, 2, 'asked again after a minute');
  assert.equal(p.pro.entitlement(), 'AimYear Pro');
});

test('Pro: expired or another entitlement is not Pro; a lifetime purchase is', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(entitlementOf(subscriber('2026-10-01T00:00:00Z'), 'AimYear Pro', now).active, false);
  assert.equal(entitlementOf(subscriber('2027-01-01T00:00:00Z', 'other'), 'AimYear Pro', now).active, false);
  assert.equal(entitlementOf(subscriber(null), 'AimYear Pro', now).active, true);
  const grace = { subscriber: { entitlements: { 'AimYear Pro': { expires_date: '2026-10-19T00:00:00Z', grace_period_expires_date: '2026-10-25T00:00:00Z' } } } };
  assert.equal(entitlementOf(grace, 'AimYear Pro', now).active, true, 'billing grace period still counts');
});

test('Pro: RevenueCat unreachable falls back to the webhook-fed status; nothing at all is not Pro', async () => {
  const p = proWith({ key: true, fail: true });
  assert.equal(await p.pro.isPro('u1'), false);
  p.stored.set('u2', { active: true, expiresAt: '2027-01-01T00:00:00Z', entitlement: 'AimYear Pro', source: 'revenuecat_webhook', updatedAt: '' });
  assert.equal(await p.pro.isPro('u2'), true);
  const o = proWith({ overrides: 'u9' });
  assert.equal(await o.pro.isPro('u9'), true, 'AIMYEAR_PRO_UIDS still wins');
  assert.equal(o.calls.length, 0);
});

test('Pro webhook without a REST key: purchase, renewal and expiration set the status; old events and anonymous ids are ignored', async () => {
  const p = proWith();
  const ev = (type: string, at: number, extra: Record<string, unknown> = {}) => ({ api_version: '1.0', event: { type, app_user_id: 'u1', entitlement_ids: ['AimYear Pro'], event_timestamp_ms: at, expiration_at_ms: Date.parse('2027-10-20T12:00:00Z'), ...extra } });
  assert.deepEqual(await p.pro.applyWebhook(ev('INITIAL_PURCHASE', 1000)), ['u1']);
  assert.equal(await p.pro.isPro('u1'), true);
  await p.pro.applyWebhook(ev('EXPIRATION', 3000));
  assert.equal(p.stored.get('u1')!.active, false);
  assert.equal(await p.pro.isPro('u1'), false, 'the webhook drops the cached answer');
  assert.deepEqual(await p.pro.applyWebhook(ev('RENEWAL', 2000)), [], 'an older event never overwrites a newer one');
  assert.deepEqual(await p.pro.applyWebhook(ev('INITIAL_PURCHASE', 4000, { app_user_id: '$RCAnonymousID:abc', original_app_user_id: '$RCAnonymousID:abc' })), []);
  assert.deepEqual(await p.pro.applyWebhook(ev('INITIAL_PURCHASE', 5000, { entitlement_ids: ['something else'] })), []);
  assert.deepEqual(await p.pro.applyWebhook({ event: { type: 'TEST', app_user_id: 'u1' } }), []);
});

test('Pro webhook with the REST key reads RevenueCat fresh, and the route checks the Authorization header', async () => {
  const p = proWith({ key: true, answer: subscriber('2027-10-20T12:00:00Z') });
  const a = await startTestApp({ pro: p.pro, webhookAuth: 'Bearer webhook-secret-for-tests' });
  try {
    const body = { event: { type: 'RENEWAL', app_user_id: 'u1', entitlement_ids: ['AimYear Pro'], event_timestamp_ms: 1 } };
    assert.equal((await post(`${a.url}/revenuecat/webhook`, body, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(`${a.url}/revenuecat/webhook`, body, {})).status, 401);
    const ok = await post(`${a.url}/revenuecat/webhook`, body, { Authorization: 'Bearer webhook-secret-for-tests' });
    assert.equal(ok.status, 200);
    assert.equal(p.stored.get('u1')!.source, 'revenuecat_api');
    assert.equal(p.stored.get('u1')!.active, true);
  } finally { await a.close(); }
  const noSecret = await startTestApp({ pro: p.pro, webhookAuth: '' });
  try { assert.equal((await post(`${noSecret.url}/revenuecat/webhook`, {}, { Authorization: '' })).status, 401, 'no secret configured: refused'); } finally { await noSecret.close(); }
});

// ---------- 3. desktop reminders ----------

const standup = (over: Partial<Pending> = {}): Pending => ({ id: 'b1-standup-0', uid: 'u1', blockId: 'b1', dueAt: minutesAgo(1), kind: 'standup', workplace: 'desktop', minutes: 50, breakMin: 5, elapsedMin: 50, ...over });

test('tick turns a due desktop stand-up into a desktop reminder with Break and Snooze, and keeps the cadence', async () => {
  const notif = new FakeNotifications();
  notif.pending.set('b1-standup-0', standup());
  const r = await tick(notif as any);
  assert.equal(r.processed, 1);
  const inbox = [...notif.inbox.values()];
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, 'Stand up');
  assert.match(inbox[0].body, /50 minutes sitting/);
  assert.deepEqual(inbox[0].actions, ['break', 'snooze']);
  assert.equal(notif.requeued.length, 1, 'the next stand-up is queued on the same block');
  // Nobody polled for an hour: the stand-up is not said late, but the cadence goes on.
  notif.inbox.clear();
  notif.pending.set('b2-standup-0', standup({ id: 'b2-standup-0', blockId: 'b2', dueAt: minutesAgo(60) }));
  await tick(notif as any);
  assert.equal(notif.inbox.size, 0);
  assert.equal(notif.requeued.at(-1)!.blockId, 'b2');
  // A forgotten timer still closes itself without a desktop app open.
  notif.pending.set('b3-standup-9', standup({ id: 'b3-standup-9', blockId: 'b3', final: true, elapsedMin: 250 }));
  await tick(notif as any);
  assert.deepEqual(notif.autoClosed, ['b3']);
  assert.deepEqual([...notif.inbox.values()].find(r => r.blockId === 'b3')!.actions, [], 'the final notice has no buttons');
  // Reminders nobody pulls do not pile up.
  notif.inbox.set('old', { ...[...notif.inbox.values()][0], id: 'old', dueAt: minutesAgo(45) });
  await tick(notif as any);
  assert.equal(notif.inbox.has('old'), false);
});

test('the desktop pull hands each reminder out once, claiming due ones tick has not reached', async () => {
  const notif = new FakeNotifications();
  notif.pending.set('b1-standup-0', standup());
  const first = await pullDesktop('u1', notif as any);
  assert.equal(first.reminders.length, 1);
  assert.equal((await pullDesktop('u1', notif as any)).reminders.length, 0);
  assert.equal((await pullDesktop('u2', notif as any)).reminders.length, 0, 'never another person\'s');
});

test('POST /desktop/reminders and /desktop/reminders/action with the app\'s Bearer: pull, snooze, break', async () => {
  const a = await startTestApp({ pro: { isPro: async (uid: string) => uid === 'u1' } as any });
  try {
    assert.equal((await post(`${a.url}/desktop/reminders`, {}, {})).status, 401);
    a.notif.pending.set('b1-standup-0', standup());
    const pulled = await (await post(`${a.url}/desktop/reminders`, {}, bearer(JWT_U1))).json();
    assert.equal(pulled.reminders.length, 1);
    assert.deepEqual(Object.keys(pulled.reminders[0]).sort(), ['actions', 'block_id', 'body', 'due_at', 'id', 'kind', 'title']);
    assert.equal(pulled.poll_after_seconds, 60);

    const store = a.store('u1');
    const block: Block = { id: 'b1', start: minutesAgo(50), direction: 'up', kind: 'work', minutes: 50, workplace: 'desktop', ended: false, cancelled: false };
    store.blocks.set('b1', block);
    store.pendings.set('b1-standup-1', standup({ id: 'b1-standup-1', dueAt: new Date(Date.now() + 50 * 60000).toISOString() }));
    store.sessions.set('s1', { id: 's1', start: minutesAgo(50), source: 'agent', clientSessionId: 'x', weight: 1, workplace: 'desktop', area: 'work', task: 'Write the launch post', notes: [], classification: 'other_project', verdictAtStart: 'ok' });

    const snooze = await (await post(`${a.url}/desktop/reminders/action`, { action: 'snooze', minutes: 10 }, bearer(JWT_U1))).json();
    assert.equal(snooze.ok, true);
    const next = [...store.pendings.values()];
    assert.equal(next.length, 1, 'the old stand-up is replaced');
    assert.ok(Math.abs(Date.parse(next[0].dueAt) - (Date.now() + 10 * 60000)) < 5000);
    assert.equal(store.blocks.get('b1')!.ended, false, 'snooze keeps the timer running');

    const brk = await (await post(`${a.url}/desktop/reminders/action`, { action: 'break' }, bearer(JWT_U1))).json();
    assert.equal(brk.ok, true);
    assert.equal(brk.break_min, 5);
    assert.deepEqual(brk.paused.map((p: { task: string }) => p.task), ['Write the launch post']);
    assert.equal(store.blocks.get('b1')!.ended, true);
    assert.ok(store.sessions.get('s1')!.end);
    const after = [...store.pendings.values()];
    assert.deepEqual(after.map(p => p.kind), ['break_end'], 'only the break-over reminder is left');
    assert.equal(after[0].workplace, 'desktop');

    const bad = await post(`${a.url}/desktop/reminders/action`, { action: 'nap' }, bearer(JWT_U1));
    assert.equal(bad.status, 400);
    const none = await post(`${a.url}/desktop/reminders/action`, { action: 'snooze' }, bearer(JWT_U1));
    assert.equal(none.status, 400, 'no timer, nothing to snooze');
  } finally { await a.close(); }
});

// ---------- 4. who started a session ----------

test('the agent that started or logged a session is recorded and returned by get_now and list_sessions', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn-1', 'desktop', async () => 'ChatGPT');
  const started = await svc.startSession({ task: 'Draft the pricing page', area: 'happiness' });
  assert.equal(started.session!.agent, 'ChatGPT');
  const now = await svc.getNow();
  assert.equal(now.running_sessions[0].agent, 'ChatGPT');
  assert.match(now.speak, /started by ChatGPT/);
  await svc.addSession({ task: 'Call with a customer', minutes: 20, area: 'happiness' });
  const list = await svc.history();
  assert.deepEqual(list.sessions.map(s => s.agent).sort(), ['ChatGPT', 'ChatGPT']);
  // Older sessions have no agent: null, not missing.
  store.sessions.set('old', { id: 'old', start: minutesAgo(300), end: minutesAgo(280), source: 'agent', weight: 1, workplace: 'desktop', area: 'work', task: 'old', notes: [], classification: 'other_project', verdictAtStart: 'ok' });
  assert.ok((await svc.history()).sessions.some(s => s.id === 'old' && s.agent === null));
});

test('agent names: OAuth client names and user agents become readable names; the AimYear app is "app"', () => {
  assert.equal(agentName('Claude Code (aimyear)'), 'Claude Code');
  assert.equal(agentName('AimYear app'), 'app');
  assert.equal(agentName(''), undefined);
  assert.equal(agentFromUserAgent('claude-code/2.0.1 (external, cli)'), 'Claude Code');
  assert.equal(agentFromUserAgent('openai-mcp/1.0'), 'ChatGPT');
  assert.equal(agentFromUserAgent('Dart/3.5 (dart:io)'), 'app');
  assert.equal(agentFromUserAgent(undefined), undefined);
});

// ---------- 5. connected agents ----------

function accountsFixture() {
  const b = new FakeAccountBackend();
  b.clients.set('c-claude', { client_id: 'c-claude', client_name: 'Claude' });
  b.clients.set('c-shared', { client_id: 'c-shared', client_name: 'ChatGPT' });
  b.addToken('u1', 'c-claude', '2026-10-01T10:00:00Z');
  b.addToken('u1', 'c-claude', '2026-10-19T10:00:00Z', 'access');
  b.addToken('u1', 'c-shared', '2026-10-10T10:00:00Z');
  b.addToken('someone-else', 'c-shared', '2026-10-10T10:00:00Z');
  return b;
}

test('list_agents shows each connected agent once; delete_agent removes only this person\'s sign-in', async () => {
  const b = accountsFixture();
  const acc = new AccountService(b, 'u1', 'c-claude');
  const list = await acc.listAgents();
  assert.deepEqual(list.agents.map(x => [x.name, x.current]), [['Claude', true], ['ChatGPT', false]]);
  assert.equal(list.agents[0].connected_at, '2026-10-01T10:00:00Z');
  assert.equal(list.agents[0].last_active_at, '2026-10-19T10:00:00Z');
  const r = await acc.disconnectAgent('c-shared');
  assert.equal(r.ok, true);
  assert.ok(b.clients.has('c-shared'), 'a client someone else uses stays registered');
  assert.equal((await b.tokensOf('someone-else')).length, 1);
  await acc.disconnectAgent('c-claude');
  assert.equal(b.clients.has('c-claude'), false, 'a client only this person used is removed');
  assert.equal((await acc.disconnectAgent('nope')).ok, false);
});

test('GET /account/agents and DELETE /account/agents/:clientId with a Bearer', async () => {
  const a = await startTestApp();
  try {
    a.accounts.clients.set('c-claude', { client_id: 'c-claude', client_name: 'Claude' });
    a.accounts.addToken('u1', 'c-claude', '2026-10-19T10:00:00Z');
    const list = await (await fetch(`${a.url}/account/agents`, { headers: bearer(JWT_U1) })).json();
    assert.deepEqual(list.agents.map((x: { client_id: string }) => x.client_id), ['c-claude']);
    const del = await fetch(`${a.url}/account/agents/c-claude`, { method: 'DELETE', headers: bearer(JWT_U1) });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${a.url}/account/agents/c-claude`, { method: 'DELETE', headers: bearer(JWT_U1) })).status, 404);
    assert.equal((await fetch(`${a.url}/account/agents`)).status, 401);
  } finally { await a.close(); }
});

// ---------- 6. export and delete ----------

function fullAccount(b: FakeAccountBackend) {
  b.trees.set('u1', {
    'aim/goal': { title: 'Launch v2' },
    'sessions/s1': { id: 's1', task: 'Write' },
    'social/wip': { network: 'wip', handle: 'valentina', secret: { v: 1, iv: 'x', tag: 'y', data: 'sealed' } },
    'aim/pro': { active: true },
  });
  b.topLevel.set('u1', { pending_notifications: [{ id: 'p1', uid: 'u1' }], desktop_reminders: [{ id: 'r1', uid: 'u1' }] });
  b.codes.set('code1', { uid: 'u1' });
  b.authUsers.add('u1');
}

test('export has every record and the connected agents, never a saved login', async () => {
  const b = accountsFixture(); fullAccount(b);
  const out = await new AccountService(b, 'u1').export();
  assert.equal(out.format, 'aimyear-export');
  assert.deepEqual(Object.keys(out.data).sort(), ['aim/goal', 'aim/pro', 'sessions/s1', 'social/wip']);
  assert.deepEqual(out.data['social/wip'], { network: 'wip', handle: 'valentina' });
  assert.doesNotMatch(JSON.stringify(out), /sealed/);
  assert.equal(out.agents.length, 2);
  assert.equal(out.server_rows.pending_notifications.length, 1);
});

test('delete removes data, reminders, sign-ins, own OAuth clients and the Firebase user; it says subscriptions continue', async () => {
  const b = accountsFixture(); fullAccount(b);
  const r = await new AccountService(b, 'u1').deleteEverything();
  assert.equal(r.ok, true);
  assert.equal(b.trees.has('u1'), false);
  assert.equal(b.topLevel.has('u1'), false);
  assert.equal((await b.tokensOf('u1')).length, 0);
  assert.equal(b.codes.size, 0);
  assert.equal(b.clients.has('c-claude'), false);
  assert.ok(b.clients.has('c-shared'), 'a client another person uses stays');
  assert.equal((await b.tokensOf('someone-else')).length, 1, 'nobody else is signed out');
  assert.equal(b.authUsers.has('u1'), false);
  assert.equal(r.subscriptions_cancelled, false);
  assert.match(r.speak, /does not cancel a Pro subscription/);
  assert.equal(r.deleted.oauth_clients, 1);
});

test('POST /account/delete: only the app\'s Firebase sign-in, only with confirm; GET /account/export for any sign-in', async () => {
  const a = await startTestApp();
  try {
    fullAccount(a.accounts);
    const exp = await fetch(`${a.url}/account/export`, { headers: bearer(OAUTH_U1) });
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition') ?? '', /aimyear-export-\d{4}-\d{2}-\d{2}\.json/);
    assert.equal((await post(`${a.url}/account/delete`, { confirm: true }, bearer(OAUTH_U1))).status, 403, 'an agent cannot delete the account');
    assert.equal((await post(`${a.url}/account/delete`, { confirm: true }, bearer('static-token-1'))).status, 403);
    assert.equal((await post(`${a.url}/account/delete`, {}, bearer(JWT_U1))).status, 400, 'confirm is required');
    const del = await post(`${a.url}/account/delete`, { confirm: true }, bearer(JWT_U1));
    assert.equal(del.status, 200);
    assert.match((await del.json()).speak, /App Store, Google Play, or aimyear\.com/);
    assert.equal(a.accounts.trees.has('u1'), false);
  } finally { await a.close(); }
});

// ---------- 7. insights and comebacks ----------

const row = (date: string, from: string, wall: number | null, classification: string, extra: Partial<InsightRow> = {}): InsightRow => ({ date, from, wall_min: wall, classification, area: 'work', ...extra });

test('insights: aim/other/life per day, hard share by lever then class, heatmap from the start hour, main-step days', () => {
  const kinds = new Map([['lev-hard', 'hard' as const], ['lev-easy', 'comfortable' as const]]);
  const ins = computeInsights({
    from: '2026-10-14', to: '2026-10-20', mainStepDays: new Set(['2026-10-20']), leverKind: id => (id ? kinds.get(id) : undefined),
    rows: [
      row('2026-10-20', '09:30', 90, 'goal_comfortable', { lever_id: 'lev-hard' }), // lever says hard
      row('2026-10-20', '14:00', 30, 'goal_hard', { lever_id: 'lev-easy' }),        // lever says comfortable
      row('2026-10-19', '10:00', 20, 'main_step'),                                     // no lever: main_step is hard
      row('2026-10-19', '11:00', 40, 'other_project'),
      row('2026-10-19', '18:00', 60, 'life', { area: 'relations' }),
      row('2026-10-18', '23:30', 90, 'goal_hard'),                                     // stops at midnight
      row('2026-10-18', '05:00', 30, 'goal_hard'),                                     // before 6:00: not on the map
      row('2026-10-17', '12:00', null, 'goal_hard'),                                   // running: not counted
      row('2026-10-10', '12:00', 60, 'goal_hard'),                                     // out of range
    ],
  });
  assert.equal(ins.days.length, 7);
  const mon = ins.days.find(d => d.date === '2026-10-19')!;
  assert.deepEqual([mon.aim_min, mon.other_min, mon.life_min, mon.total_min], [20, 40, 60, 120]);
  assert.equal(ins.totals.aim_min, 90 + 30 + 20 + 90 + 30);
  assert.equal(ins.hard_min, 90 + 20 + 90 + 30);
  assert.equal(ins.comfortable_min, 30);
  assert.equal(ins.hard_share, Math.round((230 / 260) * 100) / 100);
  assert.equal(ins.main_step_days, 1);
  assert.equal(ins.by_area.relations, 60);
  // Tuesday 2026-10-20 09:30 for 90 min: 30 in the 9:00 cell, 60 in the 10:00 cell.
  assert.equal(ins.heatmap.goal_min[1][9 - 6], 30);
  assert.equal(ins.heatmap.goal_min[1][10 - 6], 60);
  // Sunday 23:30 for 90 min: 30 in the 23:00 cell, nothing after midnight.
  assert.equal(ins.heatmap.goal_min[6][23 - 6], 30);
  assert.equal(ins.heatmap.goal_min[0].reduce((s, x) => s + x, 0), 20, 'Monday has only the main step');
  assert.deepEqual(ins.peak_hard, { weekday: 2, hour: 10, minutes: 60 });
});

test('comebacks: an active day (10+ aim minutes or a main step done) after 2+ days away', () => {
  const today = '2026-10-20';
  const cb = computeComebacks(today, [
    row('2026-10-01', '10:00', 30, 'goal_hard'),
    row('2026-10-02', '10:00', 15, 'goal_comfortable'),
    row('2026-10-06', '10:00', 5, 'main_step', { outcome: 'done' }), // 3 days away, active by a done main step
    row('2026-10-08', '10:00', 9, 'goal_hard'),                      // 9 min: not active
    row('2026-10-08', '12:00', 60, 'other_project'),                 // other work never counts
    row('2026-10-09', '10:00', 10, 'goal_hard'),                     // 2 days away: a comeback
    row(today, '10:00', 25, 'goal_hard'),                            // 10 days away
  ]);
  assert.deepEqual(cb.days, ['2026-10-06', '2026-10-09', today]);
  assert.equal(cb.count, 3);
  assert.equal(cb.away_before_latest, 10);
  assert.equal(cb.active_today, true);
  assert.deepEqual(cb.last7, [false, false, false, false, false, false, true]);
});

test('get_insights reads the record through the service: week and month ranges end today', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn');
  const today = await svc.today();
  store.goal = { title: 'g', area: 'money', levers: [{ id: 'out', name: 'outreach', kind: 'hard', examples: [], match: { repos: [], keywords: [] } }], projects: [] } as unknown as Goal;
  const add = (id: string, daysAgo: number, min: number, s: Partial<Session>) => {
    const start = new Date(Date.now() - daysAgo * 86400000 - 3 * 3600000);
    store.sessions.set(id, { id, start: start.toISOString(), end: new Date(start.getTime() + min * 60000).toISOString(), source: 'agent', weight: 1, workplace: 'desktop', area: 'work', task: id, notes: [], classification: 'goal_hard', verdictAtStart: 'ok', ...s });
  };
  add('a', 0, 30, { leverId: 'out' });
  add('b', 12, 40, { classification: 'goal_comfortable' });
  add('c', 20, 40, { classification: 'life', area: 'relations' });
  const week = await svc.getInsights('week');
  assert.equal(week.from, addDays(today, -6));
  assert.equal(week.to, today);
  assert.equal(week.totals.aim_min, 30);
  assert.equal(week.hard_share, 1);
  assert.equal(week.comebacks.count, 1, 'today, 11 days after the last active day');
  const month = await svc.getInsights('month');
  assert.equal(month.days.length, 30);
  assert.equal(month.totals.aim_min, 70);
  assert.equal(month.totals.life_min, 40);
  assert.ok(month.speak.length > 20);
});

// ---------- 8. Windows devices ----------

test('add_device takes windows and macos; desktop reminders pick them', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'c');
  const r = await svc.addDevice('windows-token-0123456789abcdef', 'windows', 'PC');
  assert.equal(r.devices[0].platform, 'windows');
  await svc.addDevice('macos-token-0123456789abcdef', 'macos');
  const dev = (platform: Device['platform']): Device => ({ token: `${platform}-t`, platform, lastSeen: '' });
  assert.deepEqual(pickDevices([dev('ios'), dev('windows'), dev('macos')], 'desktop').map(d => d.platform), ['windows', 'macos']);
});

// ---------- 9. the timer stops with its last session ----------

test('stop_session on the last running session stops the timer; with another one running, it keeps going', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn');
  const a = await svc.startSession({ task: 'Write the newsletter', area: 'happiness' });
  const b = await svc.startSession({ task: 'Reply to support', area: 'happiness' });
  const blockId = a.block!.id!;
  assert.equal(b.block!.id, blockId, 'the second session joins the timer');
  assert.ok([...store.pendings.values()].some(p => p.blockId === blockId), 'a stand-up is queued');

  const first = await svc.stopSession('half done', 'partial', a.session!.id);
  assert.equal(first.timer_stopped, false);
  assert.equal(store.blocks.get(blockId)!.ended, false, 'one session still runs');
  assert.match(first.speak, /Timer still running/);

  const last = await svc.stopSession('answered all', 'done', b.session!.id);
  assert.equal(last.timer_stopped, true);
  assert.equal(last.block, null);
  assert.equal(store.blocks.get(blockId)!.ended, true);
  assert.equal([...store.pendings.values()].filter(p => p.blockId === blockId).length, 0, 'its reminders are gone');
  assert.match(last.speak, /timer stopped/);
  assert.equal((await svc.getCurrent()).block, null);
});

test('a replayed stop of the last session does not end a timer that a newer session started', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn', 'mobile');
  const s1 = await svc.startSession({ task: 'Morning outreach', area: 'happiness' });
  await svc.stopSession('sent 5', 'partial', s1.session!.id, undefined, { opId: 'op-stop-replay-1', endAt: new Date().toISOString() });
  const s2 = await svc.startSession({ task: 'Afternoon outreach', area: 'happiness' });
  await svc.stopSession('sent 5', 'partial', s1.session!.id, undefined, { opId: 'op-stop-replay-1', endAt: new Date().toISOString() });
  assert.equal(store.blocks.get(s2.block!.id!)!.ended, false);
});

test('desktop reminders are Pro: a Free account gets 402 pro_required, never the reminders', async () => {
  const a = await startTestApp({ pro: { isPro: async () => false } as any });
  try {
    a.notif.pending.set('b1-standup-0', standup());
    for (const path of ['/desktop/reminders', '/desktop/reminders/action']) {
      const r = await post(`${a.url}${path}`, { action: 'snooze' }, bearer(JWT_U1));
      assert.equal(r.status, 402, path);
      assert.equal((await r.json()).code, 'pro_required', path);
    }
    assert.ok(a.notif.pending.has('b1-standup-0'), 'the refused pull handed nothing out');
  } finally { await a.close(); }
});

test('delete_session on the last running session stops the timer; with another one running, it keeps going', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn');
  const a = await svc.startSession({ task: 'Write the newsletter', area: 'happiness' });
  const b = await svc.startSession({ task: 'Reply to support', area: 'happiness' });
  const blockId = a.block!.id!;

  const first = await svc.deleteSession(a.session!.id);
  assert.equal(first.timer_stopped, false);
  assert.equal(store.blocks.get(blockId)!.ended, false, 'one session still runs');

  const last = await svc.deleteSession(b.session!.id);
  assert.equal(last.timer_stopped, true);
  assert.equal(store.blocks.get(blockId)!.ended, true, 'no session is left, so no timer');
  assert.equal([...store.pendings.values()].filter(p => p.blockId === blockId).length, 0, 'its reminders are gone');
  assert.match(last.speak, /timer stopped/);
});

// ---- docs/app-data.md: the app reads Firestore, so the server completes the day first ----

test('openDay: today gets its routines on the first open, and a second open changes nothing', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn', 'mobile');
  await svc.setRoutines([{ title: 'Talk with one person on Reddit', area: 'money' }]);
  const today = await svc.today();
  store.days.delete(today);
  const first = await svc.openDay();
  assert.equal(first.date, today);
  assert.deepEqual(store.days.get(today)!.plan.map(p => p.title), ['Talk with one person on Reddit']);
  const second = await svc.openDay();
  assert.equal(second.plan_items, 1, 'the routine is not added twice');
});

test('POST /account/open-day: signed in only; writes the plan and mirrors Pro to aim/pro', async () => {
  const p = proWith({ overrides: 'u1' });
  const a = await startTestApp({ pro: p.pro });
  try {
    assert.equal((await post(`${a.url}/account/open-day`, {}, {})).status, 401);
    await new AimService(a.store('u1') as any, 'conn').setRoutines([{ title: 'Post a progress update', area: 'money' }]);
    const r = await post(`${a.url}/account/open-day`, {}, bearer(JWT_U1));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.pro, true);
    assert.equal(p.stored.get('u1')!.source, 'manual', 'AIMYEAR_PRO_UIDS is readable by the app now');
    assert.equal([...a.store('u1').days.values()][0].plan[0].title, 'Post a progress update');
  } finally { await a.close(); }
});

test('pro.sync: saves RevenueCat\'s answer once, and keeps the stored status when RevenueCat is down', async () => {
  const ok = proWith({ key: true, answer: subscriber('2027-01-01T00:00:00Z') });
  assert.equal(await ok.pro.sync('u1'), true);
  const saved = ok.stored.get('u1')!;
  assert.equal(saved.active, true);
  assert.equal(await ok.pro.sync('u1'), true);
  assert.equal(ok.stored.get('u1'), saved, 'no change, no write');

  const down = proWith({ key: true, fail: true });
  down.stored.set('u2', { active: true, expiresAt: '2027-01-01T00:00:00Z', entitlement: 'AimYear Pro', source: 'revenuecat_webhook', updatedAt: '' });
  assert.equal(await down.pro.sync('u2'), true);
  assert.equal(down.stored.get('u2')!.source, 'revenuecat_webhook', 'left alone');
  assert.equal(await down.pro.sync('nobody'), false);
  assert.equal(down.stored.has('nobody'), false);
});

test('streak: reads past the first two weeks only when the streak reaches that far', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn');
  const today = await svc.today();
  for (let i = 1; i <= 20; i++) {
    const d = addDays(today, -i);
    store.days.set(d, { date: d, mode: 'full', plan: [{ id: `m${i}`, title: 'Main', area: 'money', isMainStep: true, estimateMin: 25, done: true }], createdAt: '', updatedAt: '' });
  }
  assert.equal((await svc.streak()).streak_days, 20);
  store.days.delete(addDays(today, -5));
  assert.equal((await svc.streak()).streak_days, 4);
});
