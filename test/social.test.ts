import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AimService } from '../src/service.js';
import { SocialService, PRO_ONLY, offerId, type SocialDeps } from '../src/social/service.js';
import { buildDraft, SIGNATURE } from '../src/social/draft.js';
import { NetworkError, blueskyClient, graphemes, linkFacets, wipClient, type FeedPost, type NetworkClient } from '../src/social/clients.js';
import { isPro, createPro } from '../src/pro.js';
import { addDays, startOfDay } from '../src/dates.js';
import { FakeStore } from './fake-store.js';
import { startApp } from './helpers.js';
import type { Network, Session } from '../src/types.js';

// A throwaway key per run: no key lives in the repo.
before(() => { process.env.AIMYEAR_SOCIAL_KEY = randomBytes(32).toString('base64'); });

// Test-only credentials: obviously fake values that look like the real formats.
const WIP_KEY = 'wip_test_key_not_real_123456';
const BSKY_PW = 'abcd-efgh-ijkl-mnop';

/** A network in memory: what it was asked to post, and the user's own feed. */
class FakeNet implements NetworkClient {
  feed: FeedPost[] = [];
  posted: string[] = [];
  opened = 0;
  /** 'landed': the network takes the post, then the answer is lost (a timeout). */
  failNext?: 'landed' | 'refused';
  constructor(public network: Network, public handle: string) {}
  async open(secret: Record<string, string>) {
    this.opened++;
    if (!secret.apiKey && !secret.appPassword) throw new NetworkError(this.network, 401, 'no login');
    return {
      handle: this.handle,
      recent: async () => [...this.feed].reverse(),
      post: async (text: string) => {
        const f = this.failNext; this.failNext = undefined;
        if (f === 'refused') throw new NetworkError(this.network, 500, `${this.network} answered 500.`);
        const id = `${this.network}-${this.feed.length + 1}`;
        this.feed.push({ id, createdAt: new Date().toISOString(), text });
        if (f === 'landed') throw new NetworkError(this.network, 0, `${this.network} did not answer. Try again later.`);
        this.posted.push(text);
        return { id, url: `https://example.test/${id}` };
      },
    };
  }
}

function setup(opts: { pro?: boolean; now?: () => Date } = {}) {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const wip = new FakeNet('wip', 'valentina');
  const bsky = new FakeNet('bluesky', 'valentina.bsky.social');
  const deps: SocialDeps = { clients: { wip, bluesky: bsky }, isPro: async () => opts.pro ?? true, now: opts.now };
  const social = new SocialService(store as any, svc, deps);
  return { store, svc, social, wip, bsky, deps };
}

let n = 0;
function session(store: FakeStore, start: Date, minutes: number, s: Partial<Session>) {
  const id = `s${++n}`;
  store.sessions.set(id, {
    id, start: start.toISOString(), end: new Date(start.getTime() + minutes * 60000).toISOString(), source: 'agent', weight: 1, workplace: 'desktop',
    area: 'work', task: 'work', notes: [], classification: 'goal_comfortable', verdictAtStart: 'ok', ...s,
  });
}

async function withAim(ctx: ReturnType<typeof setup>) {
  const { svc, store } = ctx;
  const today = await svc.today();
  await svc.setGoal({ title: '15 paying customers', metric: 'paying customers', baseline: 2, target: 15, deadline: addDays(today, 120) });
  await svc.recordProgress(4);
  await svc.setLevers([{ id: 'out', name: 'outreach', kind: 'hard' }, { id: 'code', name: 'coding', kind: 'comfortable' }]);
  return { today, at: (date: string, h: number) => new Date(startOfDay(date, store.profile.timezone).getTime() + h * 3600000) };
}

async function connectBoth(social: SocialService) {
  await social.connect({ network: 'wip', api_key: WIP_KEY });
  await social.connect({ network: 'bluesky', handle: '@valentina.bsky.social', app_password: BSKY_PW });
}

// ---------- the draft ----------

test('the draft tells the day from the record: aim, main step, minutes, routines, comeback, and ends with aimyear.com', async () => {
  const ctx = setup();
  const { store, social } = ctx;
  const { today, at } = await withAim(ctx);
  // Two days before: main step planned and done; yesterday and the day before: not done.
  store.days.set(addDays(today, -3), { date: addDays(today, -3), mode: 'full', plan: [{ id: 'a', title: 'old', area: 'work', isMainStep: true, estimateMin: 30, done: true }], createdAt: '', updatedAt: '' });
  for (const d of [addDays(today, -2), addDays(today, -1)]) store.days.set(d, { date: d, mode: 'full', plan: [{ id: 'b', title: 'x', area: 'work', isMainStep: true, estimateMin: 30, done: false }], createdAt: '', updatedAt: '' });
  store.days.set(today, {
    date: today, mode: 'full', createdAt: '', updatedAt: '', plan: [
      { id: 'm', title: 'Email 10 people from the waitlist', area: 'work', leverId: 'out', isMainStep: true, estimateMin: 50, done: true },
      { id: 'r1', title: 'Talk to one person on Reddit', area: 'work', routineId: 'rt1', isMainStep: false, estimateMin: 15, done: true },
      { id: 'r2', title: 'Post on WIP', area: 'work', routineId: 'rt2', isMainStep: false, estimateMin: 10, done: true, level: 'minimum' },
      { id: 'r3', title: 'Read one thread', area: 'work', routineId: 'rt3', isMainStep: false, estimateMin: 10, done: false },
    ],
  });
  session(store, at(today, 9), 50, { classification: 'main_step', leverId: 'out', itemId: 'm' });
  session(store, at(today, 11), 40, { classification: 'goal_comfortable', leverId: 'code' });

  const d = await social.draft();
  assert.ok(d.text);
  const t = d.text!;
  assert.match(t, /^Aim: 15 paying customers \(4 of 15\)\./);
  assert.match(t, /Back after 2 missed days\./);
  assert.match(t, /Main step done: Email 10 people from the waitlist/);
  assert.match(t, /1 h 30 min on the aim, 50 min of it on the hard part\./);
  assert.match(t, /Routines: 1 done, 1 at the minimum, 1 missed\./);
  assert.ok(t.endsWith(SIGNATURE) && SIGNATURE.includes('aimyear.com'));
  assert.ok(graphemes(t) <= 300);
});

test('a bad day reads as a bad day: nothing invented', async () => {
  const ctx = setup();
  const { store, social } = ctx;
  const { today } = await withAim(ctx);
  store.days.set(today, { date: today, mode: 'full', createdAt: '', updatedAt: '', plan: [{ id: 'm', title: 'Call 3 leads', area: 'work', leverId: 'out', isMainStep: true, estimateMin: 50, done: false }] });
  const t = (await social.draft()).text!;
  assert.match(t, /Main step not done: Call 3 leads/);
  assert.match(t, /No time on the aim today\./);
  assert.doesNotMatch(t, /Back after|Routines|Main step done/);

  // Comfortable work only: the hard part is said to be zero.
  session(store, new Date(startOfDay(today, store.profile.timezone).getTime() + 10 * 3600000), 30, { classification: 'goal_comfortable', leverId: 'code' });
  assert.match((await social.draft()).text!, /30 min on the aim, none on the hard part\./);
});

test('no aim or tracking off: there is nothing honest to post', async () => {
  const ctx = setup();
  assert.equal((await ctx.social.draft()).text, null);
  const { today } = await withAim(ctx);
  ctx.store.days.set(today, { date: today, mode: 'off', plan: [], createdAt: '', updatedAt: '' });
  const d = await ctx.social.draft();
  assert.equal(d.text, null);
  assert.match(d.speak!, /Tracking was off/);
});

test('long titles are shortened to fit Bluesky; the facts stay', () => {
  const t = buildDraft({
    aim: { title: 'A'.repeat(200), kind: 'count', current: 3, target: 10 },
    mainStep: { planned: true, done: true, title: 'B'.repeat(250) },
    goalMin: 125, hardMin: 60, routines: { full: 2, minimum: 0, missed: 1 }, backAfterDays: 1,
  });
  assert.ok(graphemes(t) <= 300, `got ${graphemes(t)}`);
  for (const must of ['(3 of 10)', 'Back after a missed day.', 'Main step done:', '2 h 5 min on the aim', 'Routines: 2 done, 1 missed.', SIGNATURE]) assert.ok(t.includes(must), must);
});

test('a done-or-not aim shows its stages', () => {
  const t = buildDraft({ aim: { title: 'Launch v2', kind: 'done', stagesDone: 1, stagesTotal: 4 }, mainStep: { planned: false, done: false, title: null }, goalMin: 0, hardMin: 0, routines: { full: 0, minimum: 0, missed: 0 } });
  assert.match(t, /Aim: Launch v2 \(1 of 4 stages done\)\.\nNo main step planned today\./);
});

// ---------- Pro ----------

test('the whole feature is Pro: connecting, the draft and posting; listing and disconnecting stay open', async () => {
  const ctx = setup({ pro: false });
  await withAim(ctx);
  await assert.rejects(ctx.social.connect({ network: 'wip', api_key: WIP_KEY }), new RegExp(PRO_ONLY.slice(0, 30)));
  await assert.rejects(ctx.social.draft(), /AimYear Pro/);
  await assert.rejects(ctx.social.post({}), /AimYear Pro/);
  assert.equal(ctx.wip.opened, 0);
  const l = await ctx.social.listAccounts();
  assert.equal(l.pro, false);
  assert.match(l.speak, /AimYear Pro/);
  assert.equal((await ctx.social.disconnect('wip')).ok, true);
  assert.deepEqual(await ctx.social.eveningOffer(await ctx.svc.today()), { send: false, reason: 'not Pro' });
});

test('the Pro check point reads AIMYEAR_PRO_UIDS and fails closed', async () => {
  // No RevenueCat key and nothing stored: not Pro. The override list always wins.
  const env: Record<string, string | undefined> = {};
  const pro = createPro({ env, fetch: (async () => { throw new Error('no network in tests'); }) as any, now: () => new Date(), getStatus: async () => null, saveStatus: async () => {} });
  assert.equal(await pro.isPro('u1'), false);
  env.AIMYEAR_PRO_UIDS = 'u0, u1';
  assert.equal(await pro.isPro('u1'), true);
  assert.equal(await pro.isPro(''), false);
  assert.equal(typeof isPro, 'function', 'the one check point keeps its signature');
});

// ---------- credentials ----------

test('credentials are stored sealed and never come back from any tool', async () => {
  const ctx = setup();
  const { today } = await withAim(ctx);
  const outs: unknown[] = [];
  outs.push(await ctx.social.connect({ network: 'wip', api_key: WIP_KEY }));
  outs.push(await ctx.social.connect({ network: 'bluesky', handle: 'valentina.bsky.social', app_password: BSKY_PW }));
  outs.push(await ctx.social.listAccounts(), await ctx.social.draft(), await ctx.social.post({}), await ctx.svc.getSettings());
  const all = JSON.stringify(outs);
  for (const secret of [WIP_KEY, BSKY_PW, 'apiKey', 'appPassword']) assert.ok(!all.includes(secret), `a result contains ${secret}`);
  // Stored: only the sealed blob, bound to this user and network.
  const stored = JSON.stringify([...ctx.store.social.values()]);
  assert.ok(!stored.includes(WIP_KEY) && !stored.includes(BSKY_PW));
  assert.equal(ctx.store.social.get('wip')!.handle, 'valentina');
  // A sealed blob moved to another network (or user) does not open.
  ctx.store.social.set('wip', { ...ctx.store.social.get('wip')!, secret: ctx.store.social.get('bluesky')!.secret });
  const r = await ctx.social.post({ date: addDays(today, -1), text: 'hello', networks: ['wip'] });
  assert.equal(r.results[0].status, 'failed');
  assert.match((r.results[0] as { error: string }).error, /can't be read/);
});

test('Bluesky takes an app password only, never the account password', async () => {
  const ctx = setup();
  await assert.rejects(ctx.social.connect({ network: 'bluesky', handle: 'me.bsky.social', app_password: 'my real password' }), /not a Bluesky app password/);
  assert.equal(ctx.bsky.opened, 0);
  assert.equal(ctx.store.social.size, 0);
});

test('without the encryption key nothing is checked or stored', async () => {
  const ctx = setup();
  const key = process.env.AIMYEAR_SOCIAL_KEY;
  delete process.env.AIMYEAR_SOCIAL_KEY;
  try {
    await assert.rejects(ctx.social.connect({ network: 'wip', api_key: WIP_KEY }), /not set up on this server/);
    assert.equal(ctx.wip.opened, 0);
    assert.equal(ctx.store.social.size, 0);
  } finally { process.env.AIMYEAR_SOCIAL_KEY = key; }
});

// ---------- posting ----------

test('posts go only where chosen in settings, and connecting adds a network to the choice', async () => {
  const ctx = setup();
  await withAim(ctx);
  await ctx.svc.setSettings({ post_to: ['bluesky'] });
  await connectBoth(ctx.social);
  assert.deepEqual((await ctx.svc.getSettings()).post_to, ['bluesky', 'wip']);
  await ctx.svc.setSettings({ post_to: ['wip'] });
  const r = await ctx.social.post({ text: 'Shipped the paywall. aimyear.com' });
  assert.deepEqual(r.results.map(x => [x.network, x.status]), [['wip', 'posted']]);
  assert.equal(ctx.bsky.posted.length, 0);
});

test('a network where the user already posted today themselves is skipped, and the draft says so', async () => {
  const ctx = setup();
  await withAim(ctx);
  await connectBoth(ctx.social);
  ctx.wip.feed.push({ id: 'mine-1', createdAt: new Date().toISOString(), text: 'wrote this on wip.co myself' });
  // A post from two days ago does not count as today.
  ctx.bsky.feed.push({ id: 'old', createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), text: 'old post' });

  const d = await ctx.social.draft();
  assert.deepEqual(d.networks.map(c => [c.network, c.status]), [['wip', 'you_posted'], ['bluesky', 'ready']]);
  const r = await ctx.social.post({});
  assert.deepEqual(r.results.map(x => [x.network, x.status]), [['wip', 'skipped_you_posted'], ['bluesky', 'posted']]);
  assert.equal(ctx.wip.posted.length, 0);
  assert.equal(ctx.bsky.posted.length, 1);
  assert.match(r.speak, /WIP: skipped, you already posted there today/);
});

test('a retry never posts twice, and AimYear\'s own post is not taken for the user\'s', async () => {
  const ctx = setup();
  await withAim(ctx);
  await connectBoth(ctx.social);
  const first = await ctx.social.post({ text: 'Day 1. aimyear.com' });
  assert.deepEqual(first.results.map(x => x.status), ['posted', 'posted']);
  const again = await ctx.social.post({ text: 'Day 1, edited. aimyear.com' });
  assert.deepEqual(again.results.map(x => x.status), ['already_posted', 'already_posted']);
  assert.equal(ctx.wip.posted.length, 1);
  assert.equal(ctx.bsky.posted.length, 1);
  const d = await ctx.social.draft();
  assert.deepEqual(d.networks.map(c => c.status), ['posted_by_aimyear', 'posted_by_aimyear']);
});

test('two taps at once post once', async () => {
  const ctx = setup();
  await withAim(ctx);
  await ctx.social.connect({ network: 'wip', api_key: WIP_KEY });
  const [a, b] = await Promise.all([ctx.social.post({ text: 'same day' }), ctx.social.post({ text: 'same day' })]);
  const statuses = [a.results[0].status, b.results[0].status].sort();
  assert.ok(statuses[1] === 'posted' && ['in_progress', 'already_posted'].includes(statuses[0]), statuses.join(','));
  assert.equal(ctx.wip.feed.length, 1);
});

test('a post that landed while the answer was lost is found on retry, not posted again', async () => {
  const ctx = setup();
  await withAim(ctx);
  await ctx.social.connect({ network: 'wip', api_key: WIP_KEY });
  ctx.wip.failNext = 'landed';
  const first = await ctx.social.post({ text: 'Main step done. aimyear.com' });
  assert.equal(first.results[0].status, 'failed');
  assert.equal(ctx.wip.feed.length, 1);
  const retry = await ctx.social.post({ text: 'Main step done. aimyear.com' });
  assert.equal(retry.results[0].status, 'already_posted');
  assert.equal(ctx.wip.feed.length, 1, 'nothing posted a second time');
  assert.equal(ctx.store.posts.get(`${await ctx.svc.today()}_wip`)!.status, 'posted');
});

test('a refused post can be retried and then posts once', async () => {
  const ctx = setup();
  await withAim(ctx);
  await ctx.social.connect({ network: 'wip', api_key: WIP_KEY });
  ctx.wip.failNext = 'refused';
  assert.equal((await ctx.social.post({ text: 'x' })).results[0].status, 'failed');
  assert.equal((await ctx.social.post({ text: 'x' })).results[0].status, 'posted');
  assert.equal(ctx.wip.feed.length, 1);
});

test('posting is for today or yesterday, and Bluesky gets 300 graphemes at most', async () => {
  const ctx = setup();
  const { today } = await withAim(ctx);
  await connectBoth(ctx.social);
  await assert.rejects(ctx.social.post({ date: addDays(today, -2), text: 'x' }), /today or yesterday/);
  await assert.rejects(ctx.social.post({ date: addDays(today, 1), text: 'x' }), /hasn't happened yet/);
  const r = await ctx.social.post({ text: 'é'.repeat(301) });
  assert.deepEqual(r.results.map(x => [x.network, x.status]), [['wip', 'posted'], ['bluesky', 'too_long']]);
});

test('no network connected: nothing is posted and the user is told how to connect', async () => {
  const ctx = setup();
  await withAim(ctx);
  const r = await ctx.social.post({ text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /Connect WIP or Bluesky first/);
});

// ---------- the evening offer ----------

test('the offer is queued at the end of the last focus window, and only for networks still to post', async () => {
  let now = new Date();
  const ctx = setup({ now: () => now });
  const { today, at } = await withAim(ctx);
  now = at(today, 10);
  await ctx.svc.setCommitments([
    { title: 'Morning focus', kind: 'window', days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', minutes: 120 },
    { title: 'Afternoon focus', kind: 'window', days: [1, 2, 3, 4, 5, 6, 7], start: '14:00', minutes: 180 },
  ]);
  const c = await ctx.social.connect({ network: 'wip', api_key: WIP_KEY });
  assert.equal(c.evening_offer?.date, today);
  assert.equal(c.evening_offer?.due_at, at(today, 17).toISOString());
  const p = ctx.store.pendings.get(offerId('fake'))!;
  assert.equal(p.kind, 'post_offer');
  assert.equal(p.date, today);

  // After 17:00 the next one is tomorrow's.
  now = at(today, 18);
  assert.equal((await ctx.social.armOffer())?.date, addDays(today, 1));

  const offer = await ctx.social.eveningOffer(today);
  assert.equal(offer.send, true);
  if (offer.send) {
    assert.equal(offer.data.networks, 'wip');
    assert.equal(offer.data.date, today);
    assert.ok(offer.body.endsWith(SIGNATURE));
    assert.ok(!JSON.stringify(offer).includes(WIP_KEY));
  }
  // The user posted on WIP themselves: no offer at all.
  ctx.wip.feed.push({ id: 'mine', createdAt: now.toISOString(), text: 'did it by hand' });
  assert.equal((await ctx.social.eveningOffer(today)).send, false);
  assert.equal(ctx.wip.posted.length, 0, 'an offer never posts');

  // Disconnecting the last network removes the queued offer.
  await ctx.social.disconnect('wip');
  assert.equal(ctx.store.pendings.has(offerId('fake')), false);
});

test('without timed focus windows there is no evening hook, so nothing is queued', async () => {
  const ctx = setup();
  await withAim(ctx);
  const c = await ctx.social.connect({ network: 'wip', api_key: WIP_KEY });
  assert.equal(c.evening_offer, null);
  assert.match(c.speak, /focus windows with a start time/);
  assert.equal(ctx.store.pendings.size, 0);
});

// ---------- the network clients, against a fake fetch ----------

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: ((c: Call) => { status?: number; body: unknown })[]) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    const c = { url, init }; calls.push(c);
    const a = answers[calls.length - 1](c);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { f, calls };
}

test('WIP client: checks the key on /users/me, reads own todos, posts a completed todo', async () => {
  const { f, calls } = fakeFetch([
    () => ({ body: { id: 7, username: 'val' } }),
    () => ({ body: { data: [{ id: 1, body: 'hi', created_at: '2026-10-20T10:00:00Z' }] } }),
    () => ({ body: { id: 99, url: 'https://wip.co/todos/99' } }),
  ]);
  const c = await wipClient(f).open({ apiKey: WIP_KEY });
  assert.equal(c.handle, 'val');
  assert.deepEqual(await c.recent(), [{ id: '1', createdAt: '2026-10-20T10:00:00Z', text: 'hi' }]);
  assert.deepEqual(await c.post('Day done'), { id: '99', url: 'https://wip.co/todos/99' });
  assert.equal(calls[0].url, 'https://api.wip.co/v1/users/me');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${WIP_KEY}`);
  assert.equal(calls[1].url, 'https://api.wip.co/v1/users/me/todos?limit=20');
  assert.equal(calls[2].url, 'https://api.wip.co/v1/todos');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { body: 'Day done', completed: true });
});

test('a refused key gives a message without the key', async () => {
  const { f } = fakeFetch([() => ({ status: 401, body: { error: `bad token ${WIP_KEY}` } })]);
  const e = await wipClient(f).open({ apiKey: WIP_KEY }).catch(x => x as Error);
  assert.ok(e instanceof NetworkError);
  assert.match(e.message, /refused the saved login \(401/);
  assert.ok(!e.message.includes(WIP_KEY.slice(0, 12)));
});

test('Bluesky client: app-password session, own posts only, a post with a clickable link', async () => {
  const did = 'did:plc:abc';
  const { f, calls } = fakeFetch([
    () => ({ body: { accessJwt: 'jwt', did, handle: 'val.bsky.social' } }),
    () => ({ body: { feed: [
      { post: { uri: 'at://x/1', author: { did }, record: { text: 'mine', createdAt: '2026-10-20T09:00:00Z' } } },
      { post: { uri: 'at://y/2', author: { did: 'did:plc:other' }, record: { text: 'reposted', createdAt: '2026-10-20T09:00:00Z' } }, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } },
    ] } }),
    () => ({ body: { uri: `at://${did}/app.bsky.feed.post/3kxyz`, cid: 'c' } }),
  ]);
  const c = await blueskyClient(f).open({ identifier: 'val.bsky.social', appPassword: BSKY_PW });
  assert.deepEqual((await c.recent()).map(p => p.id), ['at://x/1']);
  const p = await c.post('Done. Tracked with aimyear.com');
  assert.equal(p.url, 'https://bsky.app/profile/val.bsky.social/post/3kxyz');
  assert.equal(calls[0].url, 'https://bsky.social/xrpc/com.atproto.server.createSession');
  assert.match(calls[1].url, /app\.bsky\.feed\.getAuthorFeed\?actor=did%3Aplc%3Aabc.*filter=posts_no_replies/);
  const body = JSON.parse(String(calls[2].init.body));
  assert.equal(body.repo, did);
  assert.equal(body.collection, 'app.bsky.feed.post');
  assert.equal(body.record.$type, 'app.bsky.feed.post');
  assert.deepEqual(body.record.facets[0].features[0], { $type: 'app.bsky.richtext.facet#link', uri: 'https://aimyear.com' });
  assert.equal((calls[2].init.headers as Record<string, string>).Authorization, 'Bearer jwt');
});

test('link facets use UTF-8 byte offsets and skip trailing punctuation', () => {
  const text = 'Готово 🚀 see https://wip.co/@val. Tracked with aimyear.com';
  const f = linkFacets(text);
  const bytes = new TextEncoder().encode(text);
  const slice = (i: { byteStart: number; byteEnd: number }) => new TextDecoder().decode(bytes.slice(i.byteStart, i.byteEnd));
  assert.deepEqual(f.map(x => slice(x.index)), ['https://wip.co/@val', 'aimyear.com']);
  assert.deepEqual(linkFacets('use node.js and e.g. v2.0, mail me@aimyear.com'), []);
});

// ---------- the Post action endpoint ----------

test('POST /social/post needs a sign-in', async () => {
  const app = await startApp();
  try {
    const r = await fetch(`${app.url}/social/post`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    const bad = await fetch(`${app.url}/social/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(bad.status, 401);
  } finally { await app.close(); }
});
