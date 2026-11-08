import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { MulticastMessage } from 'firebase-admin/messaging';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AimService } from '../src/service.js';
import { SocialService, autoPendingId, type SocialDeps } from '../src/social/service.js';
import { isRealSummary, sameTask, todoText } from '../src/social/auto-rules.js';
import { NetworkError, type FeedPost, type NetworkClient } from '../src/social/clients.js';
import { sessionText } from '../src/review/build.js';
import { tick } from '../src/notifier.js';
import { buildServer, createApp } from '../src/http.js';
import { startOfDay } from '../src/dates.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';
import { FakeNotifications } from './fake-notifications.js';
import type { Multicast } from '../src/push.js';
import type { Network, Session } from '../src/types.js';

// docs/public-posting.md, "Work posts to WIP, automatic with undo" (2026-10-27, built 2026-11-07).

before(() => { process.env.AIMYEAR_SOCIAL_KEY = randomBytes(32).toString('base64'); });
const WIP_KEY = 'wip_test_key_not_real_123456';
const MIN = 60000;

/** WIP in memory: what it was asked to post and the user's own feed. */
class FakeNet implements NetworkClient {
  feed: FeedPost[] = [];
  posted: string[] = [];
  failNext?: 'refused';
  constructor(public network: Network, public handle: string) {}
  async open(secret: Record<string, string>) {
    if (!secret.apiKey && !secret.appPassword) throw new NetworkError(this.network, 401, 'no login');
    return {
      handle: this.handle,
      recent: async () => [...this.feed].reverse(),
      post: async (text: string) => {
        if (this.failNext) { this.failNext = undefined; throw new NetworkError(this.network, 500, 'WIP answered 500.'); }
        const id = `${this.network}-${this.feed.length + 1}`;
        this.feed.push({ id, createdAt: new Date().toISOString(), text });
        this.posted.push(text);
        return { id, url: `https://example.test/${id}` };
      },
      projects: async () => [],
    };
  }
}

function fcm() {
  const sent: MulticastMessage[] = [];
  const fn: Multicast = async m => { sent.push(m); return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) } as any; };
  return { sent, fn };
}

const REAL = 'Wired the evening post to skip projects that already posted on WIP today, with tests';
const REAL2 = 'Moved the post time to ten minutes after the last session and pushed the new text again';

function setup(opts: { pro?: boolean; wip?: boolean; store?: FakeStore } = {}) {
  const store = opts.store ?? new FakeStore();
  let now = new Date();
  const svc = new AimService(store as any, 'c1', 'desktop', async () => 'Claude Code');
  const wip = new FakeNet('wip', 'valentina');
  const bsky = new FakeNet('bluesky', 'valentina.bsky.social');
  const push = fcm();
  const deps: SocialDeps = { clients: { wip, bluesky: bsky }, isPro: async () => opts.pro ?? true, now: () => now, multicast: push.fn, matcher: null };
  const social = new SocialService(store as any, svc, deps);
  store.devices.set('ios-token-0123456789abcdef', { token: 'ios-token-0123456789abcdef', platform: 'ios', lastSeen: '' });
  store.devices.set('mac-token-0123456789abcdef', { token: 'mac-token-0123456789abcdef', platform: 'macos', lastSeen: '' });
  const ctx = { store, svc, social, wip, bsky, push, deps, get now() { return now; }, set now(d: Date) { now = d; } };
  return ctx;
}
type Ctx = ReturnType<typeof setup>;

/** Valentina's shape: AimYear and Worklore are her own products (public when she says so), UAR is paid work. */
async function withAim(ctx: Ctx, opts: { wip?: boolean } = {}) {
  const { svc, store, social } = ctx;
  const today = await svc.today();
  await svc.setGoal({ title: '$1,000 a month from my own projects', metric: 'dollars a month', baseline: 0, target: 1000, deadline: addDays(today, 200) });
  await svc.setLevers([{ id: 'out', name: 'Outreach and posting', kind: 'hard' }, { id: 'build', name: 'Building', kind: 'comfortable' }]);
  await svc.setProjects([
    { id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear', public: true },
    { id: 'worklore', name: 'Worklore', area: 'money', wip_hashtag: 'worklore', public: true },
    { id: 'uar', name: 'UAR mobile app', area: 'work' },
  ]);
  if (opts.wip !== false) await social.connect({ network: 'wip', api_key: WIP_KEY });
  const at = (h: number, m = 0) => new Date(startOfDay(today, store.profile.timezone).getTime() + (h * 60 + m) * MIN);
  return { today, at };
}

let n = 0;
/** A finished session, as stop_session leaves it. */
function session(store: FakeStore, start: Date, minutes: number, s: Partial<Session>): string {
  const id = `s${++n}`;
  store.sessions.set(id, {
    id, start: start.toISOString(), end: new Date(start.getTime() + minutes * MIN).toISOString(), source: 'agent', weight: 1, workplace: 'desktop',
    area: 'money', task: 'post draft', notes: [], classification: 'goal_comfortable', verdictAtStart: 'ok', outcome: 'done', ...s,
  });
  return id;
}

/** Hands the store's pending docs to the reminder store /tick reads, as Firestore would. */
function toNotif(store: FakeStore, notif = new FakeNotifications()) {
  for (const p of store.pendings.values()) notif.pending.set(p.id, structuredClone(p));
  return notif;
}

// ---------- the rules ----------

test('a real summary: 60 characters or more, and more than the task title again', () => {
  assert.equal(isRealSummary(REAL, 'post draft'), true);
  assert.equal(isRealSummary('ready', 'post draft'), false);
  assert.equal(isRealSummary('Closed when the timer stopped.', 'x'), false);
  const task = 'Make the evening post skip projects that posted on WIP';
  assert.equal(isRealSummary(`${task} today. Done.`, task), false, 'the title again with a word or two is not a summary');
  assert.equal(isRealSummary(`${task}: the draft now reads the auto posts of the day first`, task), true);
});

test('the todo text: the user\'s words as sentences, the hashtag once, within WIP\'s limit', () => {
  assert.equal(todoText(['shipped the thing'], 'aimyear'), 'Shipped the thing. #aimyear');
  assert.equal(todoText(['Shipped the thing #aimyear'], 'aimyear'), 'Shipped the thing. #aimyear', 'a trailing hashtag is not doubled');
  assert.equal(todoText(['The #aimyear post draft is done'], 'aimyear'), 'The #aimyear post draft is done.', 'one inside stays where it is');
  assert.equal(todoText(['Shipped it'], null), 'Shipped it.');
  assert.ok(todoText(['x'.repeat(900)], 'aimyear').length <= 500);
  assert.equal(sameTask({ task: 'Post draft' }, { task: 'post  draft' }), true);
  assert.equal(sameTask({ task: 'a', itemId: 'i1' }, { task: 'a', itemId: 'i2' }), false, 'two plan items are two tasks');
});

// ---------- queueing ----------

test('a session on a public project with a real summary is queued for 10 minutes after it ended, with Cancel and Edit on every device', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(12, 1);
  const id = session(ctx.store, at(11), 60, { projectId: 'aimyear', leverId: 'build', summary: REAL });
  const [r] = await ctx.social.afterWork({ sessions: [id] });
  assert.equal(r.status, 'queued');
  if (r.status !== 'queued') return;
  const a = r.auto_post;
  assert.equal(a.text, `${REAL}. #aimyear`);
  assert.equal(a.state, 'queued');
  assert.equal(a.post_at, new Date(at(12, 1).getTime() + 10 * MIN).toISOString(), 'never sooner than 10 minutes from now');
  assert.deepEqual(a.session_ids, [id]);
  assert.match(r.speak, /Cancel on the notification, or delete_auto_post/);
  const p = ctx.store.pendings.get(autoPendingId('fake', a.id))!;
  assert.equal(p.kind, 'auto_post');
  assert.equal(p.dueAt, a.post_at);
  // The push: every device (the Mac too), kind auto_post, the data the app needs for Cancel and Edit.
  const m = ctx.push.sent[0];
  assert.deepEqual(m.tokens.sort(), ['ios-token-0123456789abcdef', 'mac-token-0123456789abcdef']);
  assert.deepEqual(m.data, { kind: 'auto_post', id: a.id, text: a.text, post_at: a.post_at, project: 'AimYear', project_id: 'aimyear', hashtag: 'aimyear', date: a.date });
  assert.equal((m.apns!.payload!.aps as any).category, 'AIMYEAR_AUTO_POST');
  assert.equal(ctx.wip.posted.length, 0, 'nothing goes out before the undo is over');
  // One session, one todo: the same stop again (a replayed op) queues nothing more.
  assert.deepEqual(await ctx.social.afterWork({ sessions: [id] }), []);
  assert.equal(ctx.store.autoPosts.size, 1);
});

test('a short summary on a public project is offered with a Post button instead, and Post posts that todo once', async () => {
  const ctx = setup();
  const { today, at } = await withAim(ctx);
  ctx.now = at(12, 1);
  const id = session(ctx.store, at(11), 60, { projectId: 'aimyear', summary: 'ready' });
  const [r] = await ctx.social.afterWork({ sessions: [id] });
  assert.equal(r.status, 'offered');
  if (r.status !== 'offered') return;
  assert.equal(r.auto_post.text, 'Ready. #aimyear');
  assert.equal(ctx.store.pendings.has(autoPendingId('fake', r.auto_post.id)), false, 'an offer never posts by itself');
  const m = ctx.push.sent[0];
  assert.equal(m.data!.kind, 'post_offer');
  assert.equal(m.data!.networks, 'wip');
  assert.equal((m.apns!.payload!.aps as any).category, 'AIMYEAR_POST_OFFER');
  const todos = JSON.parse(m.data!.wip_todos);
  assert.deepEqual(todos, [{ key: `auto-${r.auto_post.id}`, text: 'Ready. #aimyear' }]);
  // The app's Post action, exactly as for the evening offer.
  const body = { date: m.data!.date, networks: ['wip' as const], wip_todos: [{ key: todos[0].key, text: 'Ready for review: the post draft #aimyear' }] };
  const p = await ctx.social.post(body);
  assert.equal(p.results[0].status, 'posted');
  assert.deepEqual(ctx.wip.posted, ['Ready for review: the post draft #aimyear']);
  assert.equal((await ctx.social.post(body)).results[0].status, 'already_posted', 'a second tap posts nothing');
  assert.equal(ctx.store.autoPosts.get(r.auto_post.id)!.state, 'posted');
  assert.equal(today, r.auto_post.date);
});

test('not public, Free, or WIP not connected: nothing is queued, and wip_text says why it was not used', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(12, 1);
  const paid = session(ctx.store, at(11), 60, { projectId: 'uar', classification: 'other_project', summary: REAL });
  assert.deepEqual(await ctx.social.afterWork({ sessions: [paid] }), [], 'paid work never posts');
  const noProject = session(ctx.store, at(11), 60, { leverId: 'out', classification: 'goal_hard', summary: REAL });
  assert.deepEqual(await ctx.social.afterWork({ sessions: [noProject] }), [], 'a lever without a project never posts');
  const [w] = await ctx.social.afterWork({ sessions: [paid], wipText: 'Shipped UAR 3.2' });
  assert.equal(w.status, 'skipped');
  assert.match(w.speak, /wip_text not used: UAR mobile app is not marked public/);

  // WIP was connected while Pro; Pro has lapsed since.
  const free = setup();
  const f = await withAim(free);
  free.deps.isPro = async () => false;
  free.now = f.at(12, 1);
  const fid = session(free.store, f.at(11), 60, { projectId: 'aimyear', summary: REAL });
  const [fr] = await free.social.afterWork({ sessions: [fid] });
  assert.equal(fr.status, 'skipped');
  assert.equal(fr.status === 'skipped' && fr.reason, 'automatic WIP posts are part of AimYear Pro');

  const nowip = setup();
  const w2 = await withAim(nowip, { wip: false });
  nowip.now = w2.at(12, 1);
  const wid = session(nowip.store, w2.at(11), 60, { projectId: 'aimyear', summary: REAL });
  const [wr] = await nowip.social.afterWork({ sessions: [wid] });
  assert.equal(wr.status === 'skipped' && wr.reason, 'WIP is not connected');
  for (const c of [ctx, free, nowip]) { assert.equal(c.store.autoPosts.size, 0); assert.equal(c.push.sent.length, 0); }
});

test('a move on a public project qualifies too; a server placeholder summary offers nothing', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = new Date();
  const m = await ctx.svc.addMove({ task: 'Fixed the signup button text on the landing page and the paywall copy', projectId: 'aimyear', leverId: 'build' });
  const [r] = await ctx.social.afterWork({ moves: [m.move!.id] });
  assert.equal(r.status, 'queued');
  assert.equal(r.status === 'queued' && r.auto_post.text, 'Fixed the signup button text on the landing page and the paywall copy. #aimyear');
  ctx.now = at(12, 1);
  const quiet = session(ctx.store, at(11), 60, { projectId: 'worklore', task: 'stories', summary: 'Closed when the timer stopped.' });
  assert.deepEqual(await ctx.social.afterWork({ sessions: [quiet] }), [], 'the evening draft covers that work');
});

// ---------- joining ----------

test('sessions on the same project and task within 2 hours join the queued todo; after it posted, nothing new goes out', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(11, 1);
  const s1 = session(ctx.store, at(10), 60, { projectId: 'aimyear', task: 'auto WIP posts', summary: REAL });
  const [q] = await ctx.social.afterWork({ sessions: [s1] });
  assert.equal(q.status, 'queued');
  const id = q.status === 'queued' ? q.auto_post.id : '';
  // Back at it 30 minutes later, same task: the queued todo takes the new text and waits 10 minutes more.
  ctx.now = at(12, 31);
  const s2 = session(ctx.store, at(11, 30), 60, { projectId: 'aimyear', task: 'Auto WIP posts', summary: REAL2 });
  const [j] = await ctx.social.afterWork({ sessions: [s2] });
  assert.equal(j.status, 'joined');
  if (j.status !== 'joined') return;
  assert.equal(j.auto_post.id, id);
  assert.equal(j.auto_post.text, `${REAL}. ${REAL2}. #aimyear`);
  assert.equal(j.auto_post.post_at, new Date(at(12, 31).getTime() + 10 * MIN).toISOString(), 'post_at moves to the new end + 10 minutes');
  assert.deepEqual(j.auto_post.session_ids, [s1, s2]);
  assert.equal(ctx.store.pendings.get(autoPendingId('fake', id))!.dueAt, j.auto_post.post_at, 'the tick waits for the new time');
  assert.equal(ctx.push.sent.length, 2, 'the phone gets the new text');
  assert.equal(ctx.store.autoPosts.size, 1);

  // It posts; a third session on the same task joins it and posts nothing.
  ctx.now = at(12, 42);
  await tick(toNotif(ctx.store) as any, ctx.now, () => ctx.social);
  assert.equal(ctx.wip.posted.length, 1);
  ctx.now = at(14, 1);
  const s3 = session(ctx.store, at(13), 60, { projectId: 'aimyear', task: 'auto WIP posts', summary: REAL });
  const [d] = await ctx.social.afterWork({ sessions: [s3] });
  assert.equal(d.status, 'already_posted');
  assert.equal(ctx.wip.posted.length, 1);

  // Another task, or the same one more than 2 hours after the todo's last work, is a todo of its own.
  ctx.now = at(17, 1);
  const s4 = session(ctx.store, at(16, 30), 30, { projectId: 'aimyear', task: 'auto WIP posts', summary: REAL2 });
  assert.equal((await ctx.social.afterWork({ sessions: [s4] }))[0].status, 'queued');
  assert.equal(ctx.store.autoPosts.size, 2);
});

// ---------- sending, cancel, edit ----------

test('the tick sends a due todo once, retries a refused one, and never posts it twice', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(12, 1);
  const id = session(ctx.store, at(11), 60, { projectId: 'aimyear', summary: REAL });
  const [r] = await ctx.social.afterWork({ sessions: [id] });
  const aid = r.status === 'queued' ? r.auto_post.id : '';
  // Not yet due: the tick does not see it.
  let notif = toNotif(ctx.store);
  assert.equal((await tick(notif as any, at(12, 5), () => ctx.social)).processed, 0);
  // Due, and WIP refuses once: queued again 5 minutes later.
  ctx.wip.failNext = 'refused';
  ctx.now = at(12, 12);
  const r1 = await tick(notif as any, ctx.now, () => ctx.social);
  assert.equal(r1.results[0].kind, 'auto_post');
  assert.equal(ctx.store.autoPosts.get(aid)!.state, 'queued');
  assert.equal(ctx.wip.posted.length, 0);
  // The retry posts it.
  notif = toNotif(ctx.store);
  ctx.now = at(12, 18);
  const r2 = await tick(notif as any, ctx.now, () => ctx.social);
  assert.equal(r2.results[0].sent, 1);
  assert.deepEqual(ctx.wip.posted, [`${REAL}. #aimyear`]);
  const a = ctx.store.autoPosts.get(aid)!;
  assert.equal(a.state, 'posted');
  assert.equal(a.url, 'https://example.test/wip-1');
  const rec = [...ctx.store.posts.values()].find(p => p.auto)!;
  assert.equal(rec.projectId, 'aimyear');
  // A retried tick with the same pending doc, and two senders at once: still one post.
  notif.pending.set(autoPendingId('fake', aid), { ...ctx.store.pendings.get(autoPendingId('fake', aid)) ?? { id: autoPendingId('fake', aid), uid: 'fake', blockId: '', kind: 'auto_post', autoPostId: aid, dueAt: ctx.now.toISOString(), workplace: 'mobile', minutes: 0, breakMin: 0 } });
  await tick(notif as any, ctx.now, () => ctx.social);
  assert.equal(ctx.wip.posted.length, 1);
  // Two senders on one queued todo at once (overlapping ticks): one claim wins.
  const [w] = await ctx.social.afterWork({ sessions: [session(ctx.store, at(12), 15, { projectId: 'worklore', task: 'stories', summary: REAL2 })] });
  const wid = w.status === 'queued' ? w.auto_post.id : '';
  const later = new Date(Date.parse(ctx.store.autoPosts.get(wid)!.postAt) + MIN);
  const both = await Promise.all([ctx.social.sendAutoPost(wid, later), ctx.social.sendAutoPost(wid, later)]);
  assert.deepEqual(both.map(x => x.sent).sort(), [0, 1]);
  assert.equal(ctx.wip.posted.length, 2);
});

test('no double posts: a WIP todo the user wrote on the site that day means the automatic one is skipped', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(12, 1);
  const [r] = await ctx.social.afterWork({ sessions: [session(ctx.store, at(11), 60, { projectId: 'aimyear', summary: REAL })] });
  const aid = r.status === 'queued' ? r.auto_post.id : '';
  ctx.wip.feed.push({ id: 'mine', createdAt: at(12, 5).toISOString(), text: 'wrote this one by hand' });
  ctx.now = at(12, 12);
  const t = await tick(toNotif(ctx.store) as any, ctx.now, () => ctx.social);
  assert.match(t.results[0].reason ?? '', /already posted on WIP that day yourself/);
  assert.equal(ctx.store.autoPosts.get(aid)!.state, 'skipped');
  assert.equal(ctx.wip.posted.length, 0);
});

test('cancel stops the todo; edit posts the user\'s text at once; neither works once it is posted', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(12, 1);
  const [c] = await ctx.social.afterWork({ sessions: [session(ctx.store, at(11), 60, { projectId: 'aimyear', task: 'one', summary: REAL })] });
  const [e] = await ctx.social.afterWork({ sessions: [session(ctx.store, at(11), 60, { projectId: 'worklore', task: 'two', summary: REAL2 })] });
  const cid = c.status === 'queued' ? c.auto_post.id : '', eid = e.status === 'queued' ? e.auto_post.id : '';

  const x = await ctx.social.cancelAutoPost(cid);
  assert.equal(x.auto_post.state, 'cancelled');
  assert.equal(ctx.store.pendings.has(autoPendingId('fake', cid)), false);
  assert.equal((await ctx.social.cancelAutoPost(cid)).auto_post.state, 'cancelled', 'cancelling twice is fine');

  const ed = await ctx.social.editAutoPost(eid, 'Wrote the Cloud Run OAuth story, finally #worklore');
  assert.equal(ed.ok, true);
  assert.deepEqual(ctx.wip.posted, ['Wrote the Cloud Run OAuth story, finally #worklore'], 'posted at once, in the user\'s words');
  assert.equal(ctx.store.autoPosts.get(eid)!.textBy, 'user');
  assert.equal(ctx.store.pendings.has(autoPendingId('fake', eid)), false);

  // The undo is over for both: the tick sends nothing.
  ctx.now = at(12, 20);
  await tick(toNotif(ctx.store) as any, ctx.now, () => ctx.social);
  await ctx.social.sendAutoPost(cid, ctx.now);
  assert.equal(ctx.wip.posted.length, 1);
  await assert.rejects(ctx.social.cancelAutoPost(eid), (err: any) => err.code === 'conflict' && /already on WIP \(https:\/\/example.test\/wip-1\)/.test(err.message));
  await assert.rejects(ctx.social.editAutoPost(eid, 'again'), (err: any) => err.code === 'conflict');
  await assert.rejects(ctx.social.cancelAutoPost('nope'), (err: any) => err.code === 'not_found');
  assert.equal((await ctx.social.listAutoPosts()).auto_posts.map(a => a.state).join(','), 'cancelled,posted');
});

// ---------- the evening post ----------

test('the evening draft leaves out projects that already got their automatic todo, and AimYear\'s own todos are not taken for the user\'s', async () => {
  const ctx = setup();
  const { at } = await withAim(ctx);
  ctx.now = at(12, 1);
  session(ctx.store, at(9), 60, { projectId: 'worklore', task: 'stories', summary: 'Drafted the story' });
  const id = session(ctx.store, at(11), 60, { projectId: 'aimyear', summary: REAL });
  await ctx.social.afterWork({ sessions: [id] });
  ctx.now = at(12, 12);
  await tick(toNotif(ctx.store) as any, ctx.now, () => ctx.social);
  assert.equal(ctx.wip.posted.length, 1);

  const d = await ctx.social.draft();
  assert.deepEqual(d.wip_todos.map(t => t.key), ['tag-worklore'], 'AimYear already posted its todo today');
  assert.deepEqual(d.wip_left_out, ['AimYear']);
  assert.match(d.text!, /Wired the evening post/, 'Bluesky keeps the whole day');
  const w = d.networks.find(c => c.network === 'wip')!;
  assert.equal(w.status, 'ready', 'the automatic todo in the feed is AimYear\'s own, not the user\'s');

  // The evening offer posts the rest; the automatic todo is not posted again.
  const r = await ctx.social.post({ networks: ['wip'] });
  assert.deepEqual(r.results.map(x => [x.key, x.status]), [['tag-worklore', 'posted']]);
  assert.equal(ctx.wip.posted.length, 2);

  // A day whose only WIP work already went out automatically: WIP has nothing more to offer.
  const solo = setup();
  const s = await withAim(solo);
  solo.now = s.at(12, 1);
  await solo.social.afterWork({ sessions: [session(solo.store, s.at(11), 60, { projectId: 'aimyear', summary: REAL })] });
  const d2 = await solo.social.draft();
  assert.deepEqual(d2.wip_todos, []);
  assert.equal(d2.networks.find(c => c.network === 'wip')!.status, 'posted_by_aimyear');
  assert.equal((await solo.social.post({ networks: ['wip'] })).results.length, 0, 'never the day\'s text as a WIP todo on top');
});

// ---------- the surfaces ----------

test('set_projects keeps public when a later call leaves it out; get_goal says false for projects without it', async () => {
  const ctx = setup();
  await withAim(ctx);
  await ctx.svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money' }, { id: 'uar', name: 'UAR mobile app', area: 'work' }]);
  assert.deepEqual(ctx.store.goal!.projects.map(p => [p.id, p.public, p.wipHashtag]), [['aimyear', true, 'aimyear'], ['uar', false, undefined]]);
  delete (ctx.store.goal!.projects[1] as any).public; // saved before 0.13
  assert.deepEqual((await ctx.svc.getGoal()).goal!.projects.map(p => p.public), [true, false]);
  const r = await ctx.svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', public: false }]);
  assert.equal(r.projects[0].public, false);
  assert.doesNotMatch(r.speak, /Public:/);
});

test('over MCP: stop_session with wip_text queues the agent\'s todo, list_auto_posts shows it, delete_auto_post cancels it', async () => {
  const store = new FakeStore();
  const push = fcm();
  const wip = new FakeNet('wip', 'valentina');
  const deps: SocialDeps = { clients: { wip, bluesky: new FakeNet('bluesky', 'x') }, isPro: async () => true, multicast: push.fn, matcher: null };
  const setupSvc = new AimService(store as any, 'setup');
  const ctx = { store, svc: setupSvc, social: new SocialService(store as any, setupSvc, deps) } as unknown as Ctx;
  await withAim(ctx);
  const server = buildServer('fake', 'agent-1', 'desktop', deps, { storeFor: () => store as any, agent: async () => 'Claude Code', sendLive: async () => 'ok' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  const callTool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as any)[0].text);
  try {
    const started = await callTool('start_session', { task: 'auto WIP posts', projectId: 'aimyear' });
    const stopped = await callTool('stop_session', { summary: 'done', outcome: 'done', session_id: started.session.id, wip_text: 'AimYear now posts my work to WIP by itself, with ten minutes to cancel' });
    assert.equal(stopped.auto_posts[0].status, 'queued');
    assert.equal(stopped.auto_posts[0].auto_post.text, 'AimYear now posts my work to WIP by itself, with ten minutes to cancel. #aimyear');
    assert.equal(stopped.auto_posts[0].auto_post.text_by, 'agent');
    assert.match(stopped.speak, /Ended .* This goes to WIP as a todo on AimYear/);
    const listed = await callTool('list_auto_posts', {});
    assert.equal(listed.auto_posts.length, 1);
    const cancelled = await callTool('delete_auto_post', { id: listed.auto_posts[0].id });
    assert.equal(cancelled.auto_post.state, 'cancelled');
    // A plain stop on a project that is not public says nothing about WIP.
    const s2 = await callTool('start_session', { task: 'UAR release', projectId: 'uar' });
    const r2 = await callTool('stop_session', { summary: REAL, outcome: 'done', session_id: s2.session.id });
    assert.equal(r2.auto_posts, undefined);
    assert.equal(wip.posted.length, 0);
  } finally { await client.close(); }
});

test('the app: Cancel and Edit routes, with 404 for an unknown todo and 409 when it is too late', async () => {
  const store = new FakeStore();
  const push = fcm();
  const wip = new FakeNet('wip', 'valentina');
  const deps: SocialDeps = { clients: { wip, bluesky: new FakeNet('bluesky', 'x') }, isPro: async () => true, multicast: push.fn, matcher: null };
  const ctx = setup({ store });
  ctx.deps.clients.wip = wip;
  const { at } = await withAim(ctx);
  ctx.now = new Date();
  const [q1] = await ctx.social.afterWork({ sessions: [session(store, at(0, 1), 1, { projectId: 'aimyear', task: 'a', summary: REAL })] });
  const [q2] = await ctx.social.afterWork({ sessions: [session(store, at(0, 1), 1, { projectId: 'worklore', task: 'b', summary: REAL2 })] });
  const id1 = q1.status === 'queued' ? q1.auto_post.id : '', id2 = q2.status === 'queued' ? q2.auto_post.id : '';
  const app = createApp({
    tokens: new Map(), baseUrl: new URL('http://localhost:1'), provider: { verifyAccessToken: async () => { throw new Error('no'); }, clientsStore: {} } as any,
    storeFor: () => store as any, socialDeps: deps, verifyIdToken: async () => ({ uid: 'fake', firebase: { sign_in_provider: 'apple.com' } }),
  });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJmYWtlIn0.fake-signature', 'Content-Type': 'application/json' };
  const post = (path: string, body?: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const list = await (await fetch(`${url}/social/auto-posts`, { headers: auth })).json() as any;
    assert.equal(list.auto_posts.length, 2);
    const c = await post(`/social/auto-posts/${id1}/cancel`);
    assert.equal(c.status, 200);
    assert.equal((await c.json() as any).auto_post.state, 'cancelled');
    const e = await post(`/social/auto-posts/${id2}/edit`, { text: 'Edited on the phone #worklore' });
    assert.equal(e.status, 200);
    const eb = await e.json() as any;
    assert.equal(eb.ok, true);
    assert.equal(eb.auto_post.state, 'posted');
    assert.deepEqual(wip.posted, ['Edited on the phone #worklore']);
    assert.equal((await post(`/social/auto-posts/${id2}/cancel`)).status, 409);
    assert.equal((await post(`/social/auto-posts/${id2}/edit`, { text: 'again' })).status, 409);
    assert.equal((await post('/social/auto-posts/nope/cancel')).status, 404);
    assert.equal((await post(`/social/auto-posts/${id1}/edit`, {})).status, 400);
    assert.equal((await fetch(`${url}/social/auto-posts/${id1}/cancel`, { method: 'POST' })).status, 401);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

// ---------- the weekly review email ----------

test('the email\'s "what moved": a thin summary gives way to the task title; when both are thin, the longer one', () => {
  assert.equal(sessionText('ready', 'Record the demo video for the launch'), 'Record the demo video for the launch');
  assert.equal(sessionText('posted some replies', 'Reddit outreach in r/SaaS threads'), 'Reddit outreach in r/SaaS threads');
  assert.equal(sessionText('Three people replied, one wants a demo', 'outreach'), 'Three people replied, one wants a demo');
  assert.equal(sessionText('ready', 'demo'), 'ready');
  assert.equal(sessionText('ok', 'demo video'), 'demo video', 'both thin: the longer');
  assert.equal(sessionText('Stood up for a break.', 'demo video'), 'demo video');
  assert.equal(sessionText(undefined, 'demo video'), 'demo video');
});
