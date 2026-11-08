/**
 * The weekly review email (docs/weekly-review.md): the builder (a normal, a quiet and an
 * empty week), the schedule (Sunday 19:00 local only, once a week, Pro only, not when the
 * setting is off) and the one-click unsubscribe. SES, Firebase Auth and RevenueCat are fakes:
 * no test sends an email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AimService, daysTowardAim } from '../src/service.js';
import { addDays, localDate, weekStart } from '../src/dates.js';
import { gatherReview, renderReview, MOVED_CAP } from '../src/review/build.js';
import { composeReview, deliverWeeklyReview, type EmailMessage, type ReviewDeps } from '../src/review/deliver.js';
import { nextReviewDue, reviewPendingId, reviewWindow } from '../src/review/schedule.js';
import { unsubscribeKey, unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from '../src/review/unsubscribe.js';
import { tick } from '../src/notifier.js';
import { createApp } from '../src/http.js';
import { FirestoreOAuthProvider } from '../src/oauth.js';
import { AIM, freshStore, seedGoodWeek, seedQuietWeek } from './review-fixtures.js';
import { FakeNotifications } from './fake-notifications.js';
import type { FakeStore } from './fake-store.js';
import type { Pending } from '../src/types.js';

const TZ = 'Europe/Madrid';
const today = localDate(new Date(), TZ);
const lastWeek = addDays(weekStart(today), -7);
const KEY = Buffer.alloc(32, 9);
const BASE = new URL('https://mcp.example.test');
const svcOf = (store: FakeStore) => new AimService(store as any, 'test', 'mobile');
/** What a reader sees in the HTML: no tags, no style block, entities decoded. */
const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const NUMBERS_OF_TIME = /\d+\s*(min|h\b|hours?|minutes?)|%/;

// ---------------------------------------------------------------- the builder

test('a normal week: days against the target, weeks in a row, what moved deduplicated and capped, main steps, path, last week', async () => {
  const store = freshStore(today);
  seedGoodWeek(store, lastWeek);
  const f = await gatherReview(svcOf(store), lastWeek);
  assert.equal(f.days, 6);
  assert.equal(f.target, 4);
  assert.equal(f.met, true);
  assert.equal(f.weeksInARow, 2, 'last week met too, the one before did not');
  assert.deepEqual(f.dayMarks.map(d => d.toward ? 'x' : d.off ? '-' : '.').join(''), 'xxxxxx-');
  assert.equal(f.moved.length, MOVED_CAP);
  assert.equal(f.movedMore, 4, '12 distinct items: the paywall line twice in different case counts once');
  assert.equal(f.moved.filter(m => /paywall/i.test(m.text)).length, 1);
  assert.ok(f.moved.slice(0, 3).every(m => m.main && m.hard), 'main steps on the hard lever come first');
  assert.ok(f.moved.slice(3, 5).every(m => m.hard && !m.main), 'then the hard part');
  assert.equal(f.moved.some(m => /gym/i.test(m.text)), false, 'life is not toward the aim');
  assert.deepEqual(f.mainSteps, ['Post the pricing change on WIP', 'Write to 5 Reddit commenters', 'Send the pilot offer to 3 studios']);
  assert.equal(f.mainStepPlanned, 4);
  assert.deepEqual(f.stages.map(s => [s.title, s.progress]), [['First 10 paying users', '3 of 10 paying users']]);
  assert.equal(f.prev.days, 4);
  assert.equal(f.prev.met, true);

  const r = renderReview(f, { unsubscribeUrl: 'https://u.example/x' });
  assert.equal(r.subject, `Your week toward ${AIM}: 6 days, target of 4 met`);
  assert.match(r.text, /^6 days toward the aim, target of 4 met\.$/m);
  assert.match(r.text, /Days toward the aim \(target 4\): 6 \(last week 4\)/);
  assert.match(r.text, /2 weeks in a row at the target\./);
  assert.match(r.text, /Last week: 4 days toward the aim, target of 4 met\./);
  assert.match(r.text, /And 4 more items\./);
  assert.match(r.text, /Time on the aim: 7 h 40 min/, 'time tracking shows minutes');
  assert.match(r.text, /Hard share of aim time: \d+%/);
  assert.match(r.text, /3 of 10 paying users, on pace/);
  assert.equal(/!/.test(r.text), false, 'no cheering');
  // User text is escaped in the HTML, and the link is there.
  assert.match(r.html, /Fixed the &lt;title&gt; tag &amp; meta description/);
  assert.equal(r.html.includes('<title> tag'), false);
  assert.match(r.html, /href="https:\/\/u\.example\/x"/);
});

test('a quiet-numbers week with little done: said plainly, no minutes and no percentages anywhere', async () => {
  const store = freshStore(today, 'quiet');
  seedQuietWeek(store, lastWeek);
  const f = await gatherReview(svcOf(store), lastWeek);
  assert.equal(f.quiet, true);
  assert.equal(f.days, 1);
  assert.equal(f.met, false);
  assert.equal(f.mainStepDays, 0);
  assert.equal(f.mainStepPlanned, 3);
  const r = renderReview(f, { unsubscribeUrl: 'https://u.example/x' });
  assert.equal(r.subject, `Your week toward ${AIM}: 1 of 4 days`);
  assert.match(r.text, /1 of 4 days toward the aim\. Target not met\./);
  assert.match(r.text, /Last week: 4 days toward the aim, target of 4 met\./);
  assert.match(r.text, /This ends a run of 1 week at the target\./);
  assert.match(r.text, /0 of 3 planned days\./);
  assert.match(r.text, /Days on the hard part: 0 \(last week 4\)/);
  assert.doesNotMatch(r.text, NUMBERS_OF_TIME);
  assert.doesNotMatch(visible(r.html), NUMBERS_OF_TIME);
  assert.doesNotMatch(r.subject + r.preheader, NUMBERS_OF_TIME);
  assert.equal(/!/.test(r.text), false);

  // moves tracking speaks the same way.
  store.profile.tracking = 'moves';
  const m = renderReview(await gatherReview(svcOf(store), lastWeek), { unsubscribeUrl: 'https://u.example/x' });
  assert.doesNotMatch(m.text, NUMBERS_OF_TIME);
});

test('an empty week: one honest line, still the path and last week', async () => {
  const store = freshStore(today);
  const f = await gatherReview(svcOf(store), lastWeek);
  assert.equal(f.empty, true);
  assert.equal(f.days, 0);
  const r = renderReview(f, { unsubscribeUrl: 'https://u.example/x' });
  assert.equal(r.subject, `Your week toward ${AIM}: 0 of 4 days`);
  assert.match(r.text, /No days toward the aim this week\./);
  assert.match(r.text, /Nothing toward the aim is in the record this week/);
  assert.match(r.text, /No main step was planned this week\./);
  assert.match(r.text, /First 10 paying users/);
  assert.match(r.text, /Last week: 0 of 4 days toward the aim\./);
});

test('never "N of T" with N above T: subject, text and HTML of every week say the target the server\'s way', async () => {
  const overTarget = (s: string) => [...s.matchAll(/(\d+) of (\d+)/g)].filter(m => Number(m[1]) > Number(m[2])).map(m => m[0]);
  const weeks: [string, 'time' | 'quiet', ((st: FakeStore, w: string) => void) | null, number][] = [
    ['good', 'time', seedGoodWeek, 4], ['good, target 1', 'time', seedGoodWeek, 1], ['good, target 6', 'time', seedGoodWeek, 6], ['quiet', 'quiet', seedQuietWeek, 4], ['quiet, target 1', 'quiet', seedQuietWeek, 1], ['empty', 'time', null, 4],
  ];
  for (const [name, tracking, seed, target] of weeks) {
    const store = freshStore(today, tracking);
    store.profile.weeklyTarget = target;
    seed?.(store, lastWeek);
    // A count stage past its target says "reached", not "12 of 10".
    if (name === 'good, target 1') store.path.milestones[1].progress = [{ value: 12, date: addDays(today, -1) }];
    const r = renderReview(await gatherReview(svcOf(store), lastWeek), { unsubscribeUrl: 'https://u.example/x' });
    for (const [part, text] of [['subject', r.subject], ['preheader', r.preheader], ['text', r.text], ['html', visible(r.html)]]) assert.deepEqual(overTarget(text), [], `${name}: ${part}`);
  }
  // The server's own weekly speak uses the same helper.
  assert.equal(daysTowardAim(6, 4), '6 days toward the aim, target of 4 met');
  assert.equal(daysTowardAim(1, 1), '1 day toward the aim, target of 1 met');
  assert.equal(daysTowardAim(3, 4), '3 of 4 days toward the aim');
  assert.equal(daysTowardAim(6, 4, ''), '6 days, target of 4 met');
});

// ---------------------------------------------------------------- the schedule

test('the review is due on Sunday at 19:00 local, right across a DST change', () => {
  // Wednesday 2026-11-04 in Madrid (CET, UTC+1) → Sunday 2026-11-08 19:00 = 18:00Z.
  assert.deepEqual(nextReviewDue(TZ, new Date('2026-11-04T10:00:00Z')), { week: '2026-11-02', sunday: '2026-11-08', dueAt: '2026-11-08T18:00:00.000Z' });
  // Sunday at 19:30 local: next week.
  assert.equal(nextReviewDue(TZ, new Date('2026-11-08T18:30:00Z')).dueAt, '2026-11-15T18:00:00.000Z');
  // 2026-03-29: clocks go forward in Madrid that Sunday, 19:00 CEST = 17:00Z.
  assert.equal(nextReviewDue(TZ, new Date('2026-03-27T12:00:00Z')).dueAt, '2026-03-29T17:00:00.000Z');
  assert.equal(nextReviewDue('America/New_York', new Date('2026-11-04T10:00:00Z')).dueAt, '2026-11-09T00:00:00.000Z');
  assert.equal(reviewWindow(TZ, new Date('2026-11-08T17:59:00Z')).open, false, '18:59 local');
  assert.deepEqual(reviewWindow(TZ, new Date('2026-11-08T18:00:00Z')), { open: true, week: '2026-11-02' });
  assert.equal(reviewWindow(TZ, new Date('2026-11-08T22:30:00Z')).open, true, 'late the same Sunday evening still sends');
  assert.equal(reviewWindow(TZ, new Date('2026-11-09T05:00:00Z')).open, false, 'Monday does not');
});

/** A Pro user with an aim and an email, and a fake SES that records what it was given. */
function deliverySetup(opts: { pro?: boolean; email?: string | null; fail?: number } = {}) {
  const store = freshStore(today);
  const sent: EmailMessage[] = [];
  let failures = opts.fail ?? 0;
  const deps: ReviewDeps = {
    storeFor: () => store as any, isPro: async () => opts.pro ?? true, emailOf: async () => (opts.email === undefined ? 'v@example.test' : opts.email),
    sender: { send: async m => { if (failures > 0) { failures--; throw Object.assign(new Error('Throttling'), { name: 'TooManyRequestsException' }); } sent.push(m); return { messageId: `msg-${sent.length}` }; } },
    baseUrl: BASE, key: KEY, from: 'AimYear <review@aimyear.com>',
  };
  const pending = (dueAt: string): Pending => ({ id: reviewPendingId('fake'), uid: 'fake', blockId: '', kind: 'weekly_review', date: '2026-11-02', dueAt, workplace: 'mobile', minutes: 0, breakMin: 0 });
  return { store, deps, sent, pending };
}
const SUNDAY_19 = new Date('2026-11-08T18:00:30Z'); // 19:00:30 in Madrid

test('Sunday 19:00 local: a Pro user gets one email with one-click unsubscribe headers; a retried tick sends nothing twice', async () => {
  const { store, deps, sent, pending } = deliverySetup();
  const notif = new FakeNotifications();
  notif.pending.set(pending('2026-11-08T18:00:00.000Z').id, pending('2026-11-08T18:00:00.000Z'));
  const r1 = await tick(notif as any, SUNDAY_19, undefined, () => deps);
  assert.equal(r1.processed, 1);
  assert.equal(r1.results[0].sent, 1);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'v@example.test');
  assert.equal(m.from, 'AimYear <review@aimyear.com>');
  assert.match(m.subject, /^Your week toward \$1,000 a month from AimYear: (\d of 4 days|\d days?, target of 4 met)$/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/mcp\.example\.test\/email\/unsubscribe\?t=fake\.[\w-]+>$/);
  assert.ok(m.html.includes(m.headers['List-Unsubscribe'].slice(1, -1).replace(/&/g, '&amp;')), 'the same link is in the body');
  assert.equal(store.weeklyReviews.get('2026-11-02')?.status, 'sent');
  assert.equal(store.weeklyReviews.get('2026-11-02')?.messageId, 'msg-1');
  assert.equal(store.pendings.get(reviewPendingId('fake'))?.dueAt, '2026-11-15T18:00:00.000Z', 'the next Sunday is queued');

  // A retry of the same tick, or the pending put back by an overlapping arm: nothing is sent again.
  notif.pending.set(pending('2026-11-08T18:00:00.000Z').id, pending('2026-11-08T18:00:00.000Z'));
  const r2 = await tick(notif as any, new Date('2026-11-08T18:05:00Z'), undefined, () => deps);
  assert.equal(r2.results[0].sent, 0);
  assert.match(r2.results[0].reason!, /already sent/);
  assert.equal(sent.length, 1);
  // A tick with nothing due does nothing at all.
  assert.equal((await tick(notif as any, new Date('2026-11-08T18:06:00Z'), undefined, () => deps)).processed, 0);
});

test('only Sunday from 19:00 local: earlier is re-queued for 19:00, a Monday tick sends nothing and waits for the next Sunday', async () => {
  const early = deliverySetup();
  const r = await deliverWeeklyReview(early.pending('2026-11-08T17:00:00.000Z'), early.deps, new Date('2026-11-08T17:30:00Z'));
  assert.equal(r.sent, 0);
  assert.match(r.reason!, /before 19:00/);
  assert.equal(r.continued, '2026-11-08T18:00:00.000Z');
  const late = deliverySetup();
  const m = await deliverWeeklyReview(late.pending('2026-11-08T18:00:00.000Z'), late.deps, new Date('2026-11-09T07:00:00Z'));
  assert.equal(m.sent, 0);
  assert.match(m.reason!, /not Sunday/);
  assert.equal(m.continued, '2026-11-15T18:00:00.000Z');
  assert.equal(early.sent.length + late.sent.length, 0);
});

test('Free gets none, and is not re-queued; no email address or no aim sends nothing', async () => {
  const free = deliverySetup({ pro: false });
  const r = await deliverWeeklyReview(free.pending(''), free.deps, SUNDAY_19);
  assert.deepEqual([r.sent, r.reason], [0, 'not Pro']);
  assert.equal(free.store.pendings.size, 0);
  assert.equal(free.store.weeklyReviews.size, 0);
  const noMail = deliverySetup({ email: null });
  assert.match((await deliverWeeklyReview(noMail.pending(''), noMail.deps, SUNDAY_19)).reason!, /no email/);
  const noAim = deliverySetup();
  noAim.store.goal = null;
  assert.match((await deliverWeeklyReview(noAim.pending(''), noAim.deps, SUNDAY_19)).reason!, /no aim/);
  assert.equal(free.sent.length + noMail.sent.length + noAim.sent.length, 0);
});

test('the setting: on by default, off sends nothing and removes the queued review, on again queues it', async () => {
  const { store, deps, sent, pending } = deliverySetup();
  const svc = svcOf(store);
  assert.equal((await svc.getSettings()).weekly_review_email, true, 'on by default');
  await svc.setSettings({ weekly_target: 4 });
  assert.ok(store.pendings.has(reviewPendingId('fake')), 'saving settings queues the next Sunday');
  const off = await svc.setSettings({ weekly_review_email: false });
  assert.equal(off.weekly_review_email, false);
  assert.match(off.speak, /Weekly review email on Sunday evening \(Pro\): off/);
  assert.equal(store.pendings.has(reviewPendingId('fake')), false);
  const r = await deliverWeeklyReview(pending(''), deps, SUNDAY_19);
  assert.match(r.reason!, /off/);
  assert.equal(sent.length, 0);
  await svc.setSettings({ weekly_review_email: true });
  const p = store.pendings.get(reviewPendingId('fake'))!;
  assert.equal(p.kind, 'weekly_review');
  assert.equal(p.dueAt, nextReviewDue(TZ, new Date()).dueAt);
});

test('arming never skips a review that is due and not yet sent', async () => {
  const { store } = deliverySetup();
  const due = { id: reviewPendingId('fake'), uid: 'fake', blockId: '', kind: 'weekly_review' as const, date: '2026-11-02', dueAt: '2026-11-08T18:00:00.000Z', workplace: 'mobile' as const, minutes: 0, breakMin: 0 };
  store.pendings.set(due.id, due);
  await svcOf(store).armWeeklyReview(new Date('2026-11-08T18:00:20Z'));
  assert.equal(store.pendings.get(due.id)?.dueAt, due.dueAt);
  await svcOf(store).openDay();
  assert.ok(store.pendings.has(due.id));
});

test('SES refuses: the week is marked failed and tried again later that evening, then sent once', async () => {
  const { store, deps, sent, pending } = deliverySetup({ fail: 1 });
  const r = await deliverWeeklyReview(pending('2026-11-08T18:00:00.000Z'), deps, SUNDAY_19);
  assert.deepEqual([r.sent, r.failed], [0, 1]);
  assert.equal(store.weeklyReviews.get('2026-11-02')?.status, 'failed');
  const retry = store.pendings.get(reviewPendingId('fake'))!;
  assert.equal(retry.dueAt, new Date(SUNDAY_19.getTime() + 15 * 60000).toISOString());
  const again = await deliverWeeklyReview(retry, deps, new Date(retry.dueAt));
  assert.equal(again.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(store.weeklyReviews.get('2026-11-02')?.status, 'sent');
});

// ---------------------------------------------------------------- unsubscribe

test('unsubscribe tokens: made from the uid with the server key, and nothing else passes', () => {
  const t = unsubscribeToken(KEY, 'u_123-abc');
  assert.equal(verifyUnsubscribeToken(KEY, t), 'u_123-abc');
  assert.equal(verifyUnsubscribeToken(Buffer.alloc(32, 1), t), null, 'another key');
  assert.equal(verifyUnsubscribeToken(KEY, t.replace('u_123', 'u_124')), null, 'another uid');
  assert.equal(verifyUnsubscribeToken(KEY, `${t}x`), null);
  for (const bad of ['', 'nodot', '.sig', undefined, 42, 'a/b.c']) assert.equal(verifyUnsubscribeToken(KEY, bad), null);
  assert.match(unsubscribeUrl(BASE, KEY, 'u1'), /^https:\/\/mcp\.example\.test\/email\/unsubscribe\?t=u1\.[\w-]{43}$/);
  // The key: its own env var, else derived from the social key, else none (and no email goes out).
  const social = Buffer.alloc(32, 3).toString('base64');
  const derived = unsubscribeKey({ AIMYEAR_SOCIAL_KEY: social });
  assert.equal(derived?.length, 32);
  assert.notDeepEqual(derived, Buffer.alloc(32, 3), 'never the social key itself');
  assert.deepEqual(unsubscribeKey({ AIMYEAR_SOCIAL_KEY: social }), derived, 'stable');
  assert.equal(unsubscribeKey({}), null);
  assert.equal(unsubscribeKey({ AIMYEAR_UNSUBSCRIBE_KEY: 'short' }), null);
  assert.deepEqual(unsubscribeKey({ AIMYEAR_UNSUBSCRIBE_KEY: 'k'.repeat(40), AIMYEAR_SOCIAL_KEY: social }), Buffer.from('k'.repeat(40)));
});

test('GET shows a confirm page and changes nothing; POST (one-click or the button) turns the email off', async () => {
  const store = freshStore(today);
  await svcOf(store).armWeeklyReview();
  const app = createApp({ tokens: new Map(), baseUrl: BASE, provider: new FirestoreOAuthProvider(new URL('http://localhost:1/mcp'), {} as any), storeFor: () => store as any, unsubscribeKey: KEY });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(KEY, 'fake'))}`;
  try {
    const get = await fetch(url);
    assert.equal(get.status, 200);
    assert.match(get.headers.get('content-type')!, /text\/html/);
    const page = await get.text();
    assert.match(page, /Stop the weekly review email\?/);
    assert.match(page, /<form method="post">/);
    assert.notEqual(store.profile.weeklyReviewEmail, false, 'opening the link alone changes nothing');

    const one = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(one.status, 200);
    assert.match(await one.text(), /No more weekly review emails/);
    assert.equal(store.profile.weeklyReviewEmail, false);
    assert.equal(store.pendings.has(reviewPendingId('fake')), false, 'the queued review is gone');
    // Again (a mail client retries): still fine.
    assert.equal((await fetch(url, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 200);

    const forged = url.replace(/t=fake/, 't=other');
    assert.equal((await fetch(forged)).status, 400);
    assert.equal((await fetch(forged, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
    assert.equal((await fetch(url.split('?')[0])).status, 400);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('the email it composes carries the account\'s own unsubscribe link', async () => {
  const store = freshStore(today);
  seedGoodWeek(store, lastWeek);
  const mail = await composeReview(svcOf(store), 'u9', lastWeek, { baseUrl: BASE, key: KEY });
  assert.equal(verifyUnsubscribeToken(KEY, new URL(mail.link).searchParams.get('t')), 'u9');
  assert.ok(mail.text.includes(mail.link));
  await assert.rejects(() => composeReview(svcOf(store), 'u9', lastWeek, { baseUrl: BASE, key: null }), /no unsubscribe key/);
});
