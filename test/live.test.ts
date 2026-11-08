/**
 * The running timer on the iPhone (docs/notifications.md, 2026-11-07): Live Activity
 * pushes through FCM HTTP v1, and reminders that reach every device whichever device
 * started the timer. FCM, Firestore and RevenueCat are fakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Message, MulticastMessage } from 'firebase-admin/messaging';
import { createApp } from '../src/http.js';
import { liveContent, liveMessage, reportLive, syncLive, ATTRIBUTES_TYPE } from '../src/live.js';
import { pullDesktop, tick, type Multicast } from '../src/notifier.js';
import { FakeStore } from './fake-store.js';
import { FakeNotifications } from './fake-notifications.js';
import { FakeAccountBackend } from './fake-account.js';
import { rpc, call } from './helpers.js';
import type { Device, Goal, Pending, Session } from '../src/types.js';

// firebase-admin's own message check (it also renames liveActivityToken to live_activity_token).
const internal = createRequire(import.meta.url)(fileURLToPath(new URL('../node_modules/firebase-admin/lib/messaging/messaging-internal.js', import.meta.url))) as { validateMessage: (m: unknown) => void };

const FCM = 'fcm-token-of-the-iphone-0123456789';
const START = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6';
const ACT = 'ffeeddccbbaa99887766554433221100';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();
const session = (over: Partial<Session> = {}): Session => ({ id: 's1', start: minutesAgo(12), source: 'agent', weight: 1, workplace: 'desktop', area: 'work', task: 'Email 10 salons', notes: [], classification: 'main_step', verdictAtStart: 'ok', agent: 'Claude Code', ...over });
const goal = { title: '30 salons paying' } as Goal;
const iphone = (over: Partial<Device> = {}): Device => ({ token: FCM, platform: 'ios', lastSeen: '', ...over });

function capture() {
  const sent: Message[] = [];
  return { sent, send: async (m: Message) => { sent.push(structuredClone(m)); return 'projects/x/messages/1'; } };
}
const aps = (m: Message) => (m.apns!.payload!.aps as Record<string, any>);

// ---------- payloads ----------

test('the start push: push-to-start token, liveactivity push type, the Swift attributes type, the content the phone counts from', () => {
  const content = liveContent([session()], goal)!;
  assert.deepEqual(content, { sessionId: 's1', task: 'Email 10 salons', startedAt: Math.floor(Date.parse(session().start) / 1000), detail: 'Main step · 30 salons paying', count: 1 });
  const now = new Date('2026-11-07T15:00:00Z');
  const m = liveMessage('start', FCM, START, content, now) as Message & { token: string };
  assert.equal(m.token, FCM, 'FCM addresses the app by its registration token');
  assert.equal(m.apns!.liveActivityToken, START);
  assert.deepEqual(m.apns!.headers, { 'apns-push-type': 'liveactivity', 'apns-priority': '10' });
  const a = aps(m);
  assert.equal(a.event, 'start');
  assert.equal(a.timestamp, now.getTime() / 1000);
  assert.equal(a['attributes-type'], ATTRIBUTES_TYPE);
  assert.equal(ATTRIBUTES_TYPE, 'AimTimerAttributes', 'the struct name in ios/LiveTimer/AimTimerAttributes.swift');
  assert.deepEqual(a.attributes, {});
  assert.deepEqual(a['content-state'], content);
  assert.equal(a.alert.title, 'Email 10 salons');
  assert.equal(a.sound, undefined, 'a timer started on the Mac does not ring the phone');
  assert.equal(a['stale-date'], content.startedAt + 4 * 3600);
  // The Admin SDK accepts it and sends the HTTP v1 field name.
  const wire = structuredClone(m) as any;
  internal.validateMessage(wire);
  assert.equal(wire.apns.live_activity_token, START);
});

test('update and end pushes go to the activity\'s own token; end dismisses at once; neither carries attributes', () => {
  const content = liveContent([session(), session({ id: 's2', task: 'Reply to support', start: minutesAgo(3), classification: 'other_project' })], goal)!;
  assert.equal(content.sessionId, 's2', 'the newest session, as on the app\'s timer screen');
  assert.equal(content.detail, '30 salons paying');
  assert.equal(content.count, 2);
  const now = new Date('2026-11-07T15:00:00Z');
  const up = liveMessage('update', FCM, ACT, content, now);
  assert.equal(up.apns!.liveActivityToken, ACT);
  assert.equal(aps(up).event, 'update');
  assert.equal(aps(up)['attributes-type'], undefined);
  assert.equal(aps(up).alert, undefined, 'an update is silent');
  const end = liveMessage('end', FCM, ACT, null, now);
  assert.equal(aps(end).event, 'end');
  assert.equal(aps(end)['dismissal-date'], now.getTime() / 1000);
  assert.deepEqual(Object.keys(aps(end)['content-state']).sort(), ['count', 'detail', 'sessionId', 'startedAt', 'task'], 'a full ContentState, or the phone cannot decode it');
  for (const m of [up, end]) internal.validateMessage(structuredClone(m));
  // A session started in an AimYear app wins over a newer agent one, like the app's timer screen.
  assert.equal(liveContent([session({ id: 'a', agent: 'app', start: minutesAgo(20) }), session({ id: 'b', start: minutesAgo(1) })], null)!.sessionId, 'a');
});

// ---------- syncLive ----------

test('syncLive starts the activity once per timer run, updates it once the phone reports its token, and ends it when nothing runs', async () => {
  const store = new FakeStore();
  store.goal = goal;
  store.devices.set(FCM, iphone({ liveStartToken: START }));
  store.devices.set('android-token-0123456789', { token: 'android-token-0123456789', platform: 'android', lastSeen: '' });
  const fcm = capture();

  assert.deepEqual(await syncLive(store as any, { send: fcm.send }), [], 'nothing runs, no activity: nothing sent');
  store.sessions.set('s1', session());
  await syncLive(store as any, { send: fcm.send });
  assert.equal(fcm.sent.length, 1);
  assert.equal(aps(fcm.sent[0]).event, 'start');
  assert.ok(store.devices.get(FCM)!.liveStartedAt);

  await syncLive(store as any, { send: fcm.send });
  assert.equal(fcm.sent.length, 1, 'no second activity for the same run while the phone has not reported the first one');

  // The phone reports the new activity's token: it gets the current state at once.
  const r = await reportLive(store as any, FCM, { activityToken: ACT }, fcm.send);
  assert.equal(r.ok, true);
  assert.equal(fcm.sent.length, 2);
  assert.equal(aps(fcm.sent[1]).event, 'update');
  assert.equal(fcm.sent[1].apns!.liveActivityToken, ACT);

  store.sessions.set('s1', { ...session(), end: new Date().toISOString() });
  await syncLive(store as any, { send: fcm.send });
  assert.equal(aps(fcm.sent[2]).event, 'end');
  const d = store.devices.get(FCM)!;
  assert.equal(d.liveToken, null);
  assert.equal(d.liveStartedAt, null, 'the next timer run starts a new activity');
  assert.equal(d.liveStartToken, START, 'the push-to-start token stays');

  store.sessions.set('s3', session({ id: 's3', start: minutesAgo(0) }));
  await syncLive(store as any, { send: fcm.send });
  assert.equal(aps(fcm.sent[3]).event, 'start');
  assert.ok(fcm.sent.every(m => (m as { token: string }).token === FCM), 'only the iPhone, never Android');
});

test('syncLive never throws, forgets a token FCM says is gone, and respects an activity swiped away', async () => {
  const store = new FakeStore();
  store.sessions.set('s1', session());
  store.devices.set(FCM, iphone({ liveStartToken: START, liveToken: ACT }));
  const failing = async () => { throw Object.assign(new Error('Requested entity was not found.'), { code: 'messaging/registration-token-not-registered' }); };
  const r = await syncLive(store as any, { send: failing as any });
  assert.equal(r[0].ok, false);
  assert.equal(store.devices.get(FCM)!.liveToken, null);

  // Swiped away while the timer runs: the server does not start it again for this run.
  const fcm = capture();
  store.devices.set(FCM, iphone({ liveStartToken: START, liveToken: ACT }));
  await reportLive(store as any, FCM, { ended: true, activityToken: 'a0a0a0a0a0a0a0a0a0a0' }, fcm.send);
  assert.equal(store.devices.get(FCM)!.liveToken, ACT, 'another (older) activity ending leaves the one that shows');
  await reportLive(store as any, FCM, { ended: true, activityToken: ACT }, fcm.send);
  assert.equal(store.devices.get(FCM)!.liveToken, null);
  await syncLive(store as any, { send: fcm.send });
  assert.equal(fcm.sent.length, 0);
  // The Live Activity switch turned off: the server forgets both tokens.
  await reportLive(store as any, FCM, { startToken: null, activityToken: null });
  assert.equal(store.devices.get(FCM)!.liveStartToken, null);
  assert.deepEqual(await reportLive(store as any, 'unknown-token-0123456789', { startToken: START }), { ok: false, reason: 'device not registered' });
});

// ---------- every device ----------

function multicast() {
  const sent: MulticastMessage[] = [];
  const fn: Multicast = async m => { sent.push(m); return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) } as any; };
  return { sent, fn };
}
const reminder = (over: Partial<Pending> = {}): Pending => ({ id: 'b1-standup-0', uid: 'u1', blockId: 'b1', dueAt: minutesAgo(1), kind: 'standup', workplace: 'desktop', minutes: 50, breakMin: 5, elapsedMin: 50, ...over });
const devices = (): Device[] => [iphone(), { token: 'android-token-0123456789', platform: 'android', lastSeen: '' }, { token: 'mac-token-0123456789abc', platform: 'macos', lastSeen: '' }];

test('a stand-up from a timer started on the Mac reaches the phones by push and the desktop apps through their inbox', async () => {
  for (const workplace of ['desktop', 'mobile'] as const) {
    const notif = new FakeNotifications();
    notif.devices = devices();
    notif.pending.set('b1-standup-0', reminder({ workplace }));
    const fcm = multicast();
    const r = await tick(notif as any, new Date(), undefined, { multicast: fcm.fn });
    assert.equal(r.results[0].sent, 2, workplace);
    assert.deepEqual(fcm.sent[0].tokens, [FCM, 'android-token-0123456789'], `${workplace}: the phones, the Mac gets it from the inbox`);
    assert.equal(fcm.sent[0].notification!.title, 'Stand up');
    assert.equal(notif.inbox.size, 1, `${workplace}: the desktop apps get it too`);
    assert.equal(notif.requeued.length, 1, 'the cadence goes on once');
  }
});

test('the desktop pull claims a phone timer\'s stand-up too, and still pushes it to the phones', async () => {
  const notif = new FakeNotifications();
  notif.devices = devices();
  notif.pending.set('b1-standup-0', reminder({ workplace: 'mobile' }));
  const fcm = multicast();
  const pulled = await pullDesktop('u1', notif as any, new Date(), { multicast: fcm.fn });
  assert.equal(pulled.reminders.length, 1);
  assert.deepEqual(fcm.sent[0].tokens, [FCM, 'android-token-0123456789']);
  assert.equal(notif.pending.has('b1-standup-0'), false);
  assert.equal((await tick(notif as any, new Date(), undefined, { multicast: fcm.fn })).results.filter(x => x.id === 'b1-standup-0').length, 0, 'never twice');
});

test('the evening post offer is pushed to every device, the Mac included', async () => {
  const notif = new FakeNotifications();
  notif.devices = devices();
  notif.pending.set('u1-offer', reminder({ id: 'u1-offer', kind: 'post_offer', blockId: '', date: '2026-11-07', workplace: 'mobile' }));
  const fcm = multicast();
  const socialFor = () => ({ eveningOffer: async () => ({ send: true, title: 'Post today?', body: 'Draft', data: { kind: 'post_offer' } }), armOffer: async () => null }) as any;
  await tick(notif as any, new Date(), socialFor, { multicast: fcm.fn });
  assert.deepEqual(fcm.sent[0].tokens, [FCM, 'android-token-0123456789', 'mac-token-0123456789abc']);
});

// ---------- over HTTP: the app's report and the session tools ----------

const JWT_U1 = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ1MSJ9.fake-signature-u1';
const JWT_FREE = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJmcmVlIn0.fake-signature-free';

async function startTestApp() {
  const stores = new Map<string, FakeStore>();
  const storeFor = (uid: string) => { if (!stores.has(uid)) stores.set(uid, new FakeStore()); return stores.get(uid)! as any; };
  const fcm = capture();
  const app = createApp({
    tokens: new Map([['static-token-1', 'u1']]), baseUrl: new URL('http://localhost:1'),
    provider: { verifyAccessToken: async () => { throw new Error('invalid'); }, clientsStore: { getClient: async () => undefined } } as any,
    storeFor, notifications: () => new FakeNotifications() as any, accountBackend: new FakeAccountBackend(), sendLive: fcm.send,
    pro: { isPro: async (uid: string) => uid === 'u1', sync: async () => true } as any,
    socialDeps: { clients: {} as any, isPro: async () => false },
    verifyIdToken: async (t: string) => {
      if (t === JWT_U1) return { uid: 'u1', firebase: { sign_in_provider: 'apple.com' } };
      if (t === JWT_FREE) return { uid: 'free', firebase: { sign_in_provider: 'apple.com' } };
      throw new Error('invalid');
    },
  });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { url, fcm, store: (uid: string) => storeFor(uid) as FakeStore, close: () => new Promise<void>(r => server.close(() => r())) };
}
const post = (url: string, body: unknown, token: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const tool = (r: Awaited<ReturnType<typeof rpc>>) => JSON.parse(r.json.result.content[0].text);

test('POST /devices/live-activity: Pro only, a registered device, hex tokens; then start_session and stop_session over /mcp drive the activity', async () => {
  const a = await startTestApp();
  try {
    const free = await post(`${a.url}/devices/live-activity`, { token: FCM, start_token: START }, JWT_FREE);
    assert.equal(free.status, 402);
    assert.equal((await free.json()).code, 'pro_required');
    assert.equal((await post(`${a.url}/devices/live-activity`, { token: FCM, start_token: START }, JWT_U1)).status, 404, 'add_device first');
    a.store('u1').devices.set(FCM, iphone());
    assert.equal((await post(`${a.url}/devices/live-activity`, { token: FCM, start_token: 'not a token' }, JWT_U1)).status, 400);
    const ok = await post(`${a.url}/devices/live-activity`, { token: FCM, start_token: START }, JWT_U1);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, start_token: true, activity: false, sent: [] });

    // The timer starts from the Mac (an agent): the phone's activity starts by push.
    const started = tool(await rpc(`${a.url}/mcp`, call(1, 'tools/call', { name: 'start_session', arguments: { task: 'Email 10 salons', area: 'work' } }), { Authorization: 'Bearer static-token-1', 'x-aimyear-workplace': 'desktop' }));
    assert.equal(started.verdict, 'ok');
    assert.equal(a.fcm.sent.length, 1);
    assert.equal(aps(a.fcm.sent[0]).event, 'start');
    assert.equal(aps(a.fcm.sent[0])['content-state'].task, 'Email 10 salons');

    // The phone reports the activity's token and gets the state at once.
    const rep = await (await post(`${a.url}/devices/live-activity`, { token: FCM, activity_token: ACT }, JWT_U1)).json();
    assert.equal(rep.activity, true);
    assert.equal(aps(a.fcm.sent[1]).event, 'update');

    const stopped = tool(await rpc(`${a.url}/mcp`, call(2, 'tools/call', { name: 'stop_session', arguments: { summary: 'Sent 10.', outcome: 'done', session_id: started.session.id } }), { Authorization: 'Bearer static-token-1' }));
    assert.equal(stopped.ok, true);
    assert.equal(aps(a.fcm.sent[2]).event, 'end');
    assert.equal(a.fcm.sent[2].apns!.liveActivityToken, ACT);
    assert.equal(a.fcm.sent.length, 3);
  } finally { await a.close(); }
});
