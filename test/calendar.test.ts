/**
 * Google Calendar sync (docs/calendar-sync.md), against a fake Google that answers the
 * real REST endpoints: the client in src/calendar/google.ts runs as it does in
 * production, only fetch is fake. No real Google, Firestore or RevenueCat.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AimService } from '../src/service.js';
import { CalendarService, CALENDAR_MARK, CALENDAR_PRO, BUSY_TTL_MS, eventId, finishGoogleCallback, retryId, type CalendarDeps, type OAuthStates } from '../src/calendar/service.js';
import { googleApi, AUTH_URL, TOKEN_URL, REVOKE_URL, CAL_API, SCOPES, ALL_SCOPES } from '../src/calendar/google.js';
import { focusDay } from '../src/calendar/busy.js';
import { tick } from '../src/notifier.js';
import { createApp } from '../src/http.js';
import { addDays, startOfDay } from '../src/dates.js';
import { FakeStore } from './fake-store.js';
import { FakeNotifications } from './fake-notifications.js';
import { rpc, call } from './helpers.js';

before(() => { process.env.AIMYEAR_SOCIAL_KEY = randomBytes(32).toString('base64'); });

const CFG = { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret-not-real', redirectUri: 'https://mcp.example.test/calendar/google/callback' };
const EMAIL = 'valentina@example.test';
const REFRESH = 'refresh-token-not-real-1';

interface FakeEvent { id: string; body: any }
interface FakeCal { id: string; summary: string; primary?: boolean; accessRole: string; description?: string; byApp: boolean; events: Map<string, FakeEvent>; busy: { start: string; end: string; title: string }[] }

/** Google in memory: OAuth, the calendar list, freeBusy and events, with every call recorded. */
class FakeGoogle {
  cals = new Map<string, FakeCal>();
  codes = new Map<string, { refresh: string; scopes: string[] }>();
  revoked = new Set<string>();
  access = new Set<string>();
  calls: { method: string; url: string; calendar?: string }[] = [];
  failWrites = 0;
  private n = 0;
  constructor() {
    this.cals.set(EMAIL, { id: EMAIL, summary: EMAIL, primary: true, accessRole: 'owner', byApp: false, events: new Map([['mine1', { id: 'mine1', body: { summary: 'Dentist' } }]]), busy: [] });
    this.cals.set('work@group.calendar.google.com', { id: 'work@group.calendar.google.com', summary: 'Work', accessRole: 'owner', byApp: false, events: new Map(), busy: [] });
    this.codes.set('good-code', { refresh: REFRESH, scopes: ALL_SCOPES });
  }
  writes() { return this.calls.filter(c => ['PUT', 'POST', 'DELETE'].includes(c.method) && c.url.includes('/events')); }
  freeBusyCalls() { return this.calls.filter(c => c.url.endsWith('/freeBusy')).length; }
  appCalendars() { return [...this.cals.values()].filter(c => c.byApp); }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const calMatch = /\/calendars\/([^/?]+)/.exec(url);
    this.calls.push({ method, url, calendar: calMatch ? decodeURIComponent(calMatch[1]) : undefined });
    if (url === TOKEN_URL) {
      const f = new URLSearchParams(String(init.body));
      assert.equal(f.get('client_secret'), CFG.clientSecret);
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(f.get('code') ?? '');
        if (!c) return res(400, { error: 'invalid_grant' });
        this.codes.delete(f.get('code')!);
        const at = `access-${++this.n}`; this.access.add(at);
        return res(200, { access_token: at, expires_in: 3600, refresh_token: c.refresh, scope: c.scopes.join(' ') });
      }
      const rt = f.get('refresh_token') ?? '';
      if (this.revoked.has(rt)) return res(400, { error: 'invalid_grant' });
      const at = `access-${++this.n}`; this.access.add(at);
      return res(200, { access_token: at, expires_in: 3600 });
    }
    if (url === REVOKE_URL) { this.revoked.add(new URLSearchParams(String(init.body)).get('token') ?? ''); return res(200, {}); }
    const auth = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    if (!this.access.has(auth)) return res(401, { error: { status: 'UNAUTHENTICATED' } });
    if (url.startsWith(`${CAL_API}/users/me/calendarList`)) {
      return res(200, { items: [...this.cals.values()].map(c => ({ id: c.id, summary: c.summary, primary: c.primary, accessRole: c.accessRole, description: c.description })) });
    }
    if (url === `${CAL_API}/freeBusy`) {
      const b = JSON.parse(String(init.body));
      const calendars: Record<string, unknown> = {};
      for (const { id } of b.items) {
        const c = this.cals.get(id);
        calendars[id] = c ? { busy: c.busy.filter(x => x.end > b.timeMin && x.start < b.timeMax).map(x => ({ start: x.start, end: x.end })) } : { errors: [{ reason: 'notFound' }] };
      }
      return res(200, { kind: 'calendar#freeBusy', calendars });
    }
    if (url === `${CAL_API}/calendars` && method === 'POST') {
      const b = JSON.parse(String(init.body));
      const id = `aimyear-${++this.n}@group.calendar.google.com`;
      this.cals.set(id, { id, summary: b.summary, description: b.description, accessRole: 'owner', byApp: true, events: new Map(), busy: [] });
      return res(200, { id, summary: b.summary });
    }
    const ev = /\/calendars\/([^/]+)\/events(?:\/([^/?]+))?$/.exec(url);
    if (ev) {
      const c = this.cals.get(decodeURIComponent(ev[1]));
      // calendar.app.created: only calendars this app made can be written.
      if (!c || !c.byApp) return res(403, { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } });
      if (method !== 'DELETE' && this.failWrites > 0) { this.failWrites--; return res(503, { error: { status: 'UNAVAILABLE' } }); }
      const id = ev[2] ? decodeURIComponent(ev[2]) : undefined;
      if (method === 'PUT') { if (!c.events.has(id!)) return res(404, { error: { status: 'NOT_FOUND' } }); c.events.set(id!, { id: id!, body: JSON.parse(String(init.body)) }); return res(200, { id }); }
      if (method === 'POST') { const b = JSON.parse(String(init.body)); if (c.events.has(b.id)) return res(409, { error: { status: 'ALREADY_EXISTS' } }); c.events.set(b.id, { id: b.id, body: b }); return res(200, { id: b.id }); }
      if (method === 'DELETE') { if (!c.events.delete(id!)) return res(404, {}); return new Response(null, { status: 204 }); }
    }
    const one = /\/calendars\/([^/?]+)$/.exec(url);
    if (one && method === 'GET') { const c = this.cals.get(decodeURIComponent(one[1])); return c?.byApp ? res(200, { id: c.id }) : res(404, { error: { status: 'NOT_FOUND' } }); }
    return res(404, { error: { status: 'NOT_FOUND' } });
  };
}

function memStates(): OAuthStates & { rows: Map<string, { uid: string; expires: number }> } {
  const rows = new Map<string, { uid: string; expires: number }>();
  return { rows, put: async (h, r) => { rows.set(h, r); }, take: async h => { const r = rows.get(h) ?? null; rows.delete(h); return r; } };
}

function setup(opts: { pro?: boolean; now?: () => Date } = {}) {
  const google = new FakeGoogle();
  const store = new FakeStore();
  const states = memStates();
  const pro = { on: opts.pro ?? true };
  const deps: CalendarDeps = { google: googleApi(CFG, google.fetch), isPro: async () => pro.on, states, now: opts.now };
  const cal = new CalendarService(store as any, deps);
  const svc = new AimService(store as any, 'terminal-A', 'desktop', undefined, cal);
  return { google, store, states, deps, cal, svc, pro };
}

/** Runs the whole browser round trip: the consent URL, then Google's redirect with a code. */
async function connect(ctx: ReturnType<typeof setup>, code = 'good-code') {
  const { url } = await ctx.cal.connectUrl();
  const state = new URL(url).searchParams.get('state')!;
  return finishGoogleCallback({ code, state }, ctx.deps, () => ctx.store as any);
}

/** A local time on date in the store's timezone (Europe/Madrid), as ISO. */
const at = (store: FakeStore, date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(startOfDay(date, store.profile.timezone).getTime() + (h * 60 + m) * 60000).toISOString();
};
/** The next Monday after today (a weekday with a focus window below). */
function nextMonday() {
  let d = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 8; i++) { d = addDays(d, 1); if (new Date(`${d}T12:00:00Z`).getUTCDay() === 1) return d; }
  return d;
}

// ---------- connect, callback, disconnect ----------

test('connect: Pro only; the consent URL asks for the three narrow scopes, offline, with a one-time state bound to the uid', async () => {
  const free = setup({ pro: false });
  await assert.rejects(free.cal.connectUrl(), (e: Error) => e.message === CALENDAR_PRO && (e as any).code === 'pro_required');
  assert.equal(free.states.rows.size, 0);

  const ctx = setup();
  const { url } = await ctx.cal.connectUrl();
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, AUTH_URL);
  assert.equal(u.searchParams.get('client_id'), CFG.clientId);
  assert.equal(u.searchParams.get('redirect_uri'), CFG.redirectUri);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
  assert.deepEqual(u.searchParams.get('scope')!.split(' ').sort(), [SCOPES.appCreated, SCOPES.list, SCOPES.freebusy].sort());
  assert.ok(!u.searchParams.get('scope')!.split(' ').includes('https://www.googleapis.com/auth/calendar'), 'never the full calendar scope');
  const state = u.searchParams.get('state')!;
  assert.ok(state.length >= 40);
  const [row] = [...ctx.states.rows.values()];
  assert.equal(row.uid, 'fake');
  assert.ok(![...ctx.states.rows.keys()].includes(state), 'only a hash of the state is stored');
});

test('callback: stores the refresh token sealed, makes the AimYear calendar once, reads the primary calendar; the state works once', async () => {
  const ctx = setup();
  const { url } = await ctx.cal.connectUrl();
  const state = new URL(url).searchParams.get('state')!;
  const r = await finishGoogleCallback({ code: 'good-code', state }, ctx.deps, () => ctx.store as any);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /connected \(valentina@example\.test\)/);
  const link = ctx.store.calendar!;
  assert.equal(link.email, EMAIL);
  assert.deepEqual(link.readCalendars, [EMAIL]);
  assert.equal(link.status, 'ok');
  assert.ok(!JSON.stringify(link).includes(REFRESH), 'the refresh token is never stored in the clear');
  const made = ctx.google.appCalendars();
  assert.equal(made.length, 1);
  assert.equal(made[0].summary, 'AimYear');
  assert.equal(made[0].description, CALENDAR_MARK);
  assert.equal(link.aimyearCalendarId, made[0].id);

  const again = await finishGoogleCallback({ code: 'good-code', state }, ctx.deps, () => ctx.store as any);
  assert.equal(again.ok, false, 'a used state does not work again');
  const forged = await finishGoogleCallback({ code: 'good-code', state: 'made-up-state' }, ctx.deps, () => ctx.store as any);
  assert.equal(forged.ok, false);
  const denied = await (async () => { const { url } = await ctx.cal.connectUrl(); return finishGoogleCallback({ error: 'access_denied', state: new URL(url).searchParams.get('state')! }, ctx.deps, () => ctx.store as any); })();
  assert.equal(denied.ok, false);
  assert.match(denied.message, /not allowed/);
});

test('callback: an expired state is refused; a reconnect finds the AimYear calendar it made before', async () => {
  let now = new Date();
  const ctx = setup({ now: () => now });
  const { url } = await ctx.cal.connectUrl();
  now = new Date(now.getTime() + 11 * 60000);
  const late = await finishGoogleCallback({ code: 'good-code', state: new URL(url).searchParams.get('state')! }, ctx.deps, () => ctx.store as any, now);
  assert.equal(late.ok, false);
  assert.match(late.message, /expired/);

  const fresh = setup();
  assert.equal((await connect(fresh)).ok, true);
  const first = fresh.store.calendar!.aimyearCalendarId;
  await fresh.cal.disconnect();
  fresh.google.codes.set('code-2', { refresh: 'refresh-token-not-real-2', scopes: ALL_SCOPES });
  assert.equal((await connect(fresh, 'code-2')).ok, true);
  assert.equal(fresh.store.calendar!.aimyearCalendarId, first, 'the same calendar, found by its mark');
  assert.equal(fresh.google.appCalendars().length, 1, 'no second AimYear calendar');
});

test('callback: scopes left unticked on the consent screen are reported, and without app.created nothing is written', async () => {
  const ctx = setup();
  ctx.google.codes.set('partial', { refresh: REFRESH, scopes: [SCOPES.list, SCOPES.freebusy] });
  const r = await connect(ctx, 'partial');
  assert.equal(r.ok, true);
  assert.match(r.message, /writing to the AimYear calendar/);
  assert.equal(ctx.store.calendar!.aimyearCalendarId, undefined);
  assert.equal(ctx.google.appCalendars().length, 0);
  const s = await ctx.svc.addSession({ task: 'Email five leads', minutes: 30 });
  assert.equal(s.ok, true);
  assert.equal(ctx.google.writes().length, 0);
  const st = await ctx.cal.status();
  assert.deepEqual(st.missing_permissions, ['writing to the AimYear calendar']);
});

test('status and set_calendar: lists calendars without the AimYear one; unknown ids and the AimYear calendar are refused', async () => {
  const ctx = setup();
  await connect(ctx);
  const st = await ctx.cal.status();
  assert.equal(st.connected, true);
  assert.deepEqual(st.calendars!.map(c => c.id).sort(), [EMAIL, 'work@group.calendar.google.com'].sort());
  assert.ok(!JSON.stringify(st).includes(REFRESH));
  const set = await ctx.cal.setCalendars([EMAIL, 'work@group.calendar.google.com']);
  assert.deepEqual(set.read_calendars, [EMAIL, 'work@group.calendar.google.com']);
  await assert.rejects(ctx.cal.setCalendars(['nope@example.test']), /Not in your calendar list/);
  await assert.rejects(ctx.cal.setCalendars([ctx.store.calendar!.aimyearCalendarId!]), /never counted as busy/);
  ctx.pro.on = false;
  await assert.rejects(ctx.cal.setCalendars([EMAIL]), (e: Error) => (e as any).code === 'pro_required');
});

test('disconnect: revokes the token at Google and deletes the link, the busy cache and the retry queue; it works without Pro', async () => {
  const ctx = setup();
  await connect(ctx);
  ctx.store.busy.set('2026-11-09', { date: '2026-11-09', intervals: [], calendars: [EMAIL], fetchedAt: new Date().toISOString() });
  ctx.store.outbox.set('session_x', { key: 'session_x', kind: 'session', ref: 'x', attempts: 1, lastError: 'e', at: '' });
  ctx.store.pendings.set(retryId('fake'), { id: retryId('fake'), uid: 'fake', blockId: '', kind: 'calendar_retry', dueAt: '', workplace: 'mobile', minutes: 0, breakMin: 0 });
  ctx.pro.on = false;
  const r = await ctx.cal.disconnect();
  assert.equal(r.revoked, true);
  assert.ok(ctx.google.revoked.has(REFRESH));
  assert.equal(ctx.store.calendar, null);
  assert.equal(ctx.store.busy.size, 0);
  assert.equal(ctx.store.outbox.size, 0);
  assert.equal(ctx.store.pendings.has(retryId('fake')), false);
  assert.match(r.speak, /stay in your Google account/);
  ctx.pro.on = true;
  await ctx.svc.addSession({ task: 'Email five leads', minutes: 30 });
  assert.equal(ctx.google.writes().length, 0, 'nothing is written after a disconnect');
  assert.equal((await ctx.cal.status()).connected, false);
});

test('a refresh token Google no longer accepts marks the link revoked; nothing is retried', async () => {
  const ctx = setup();
  await connect(ctx);
  ctx.google.revoked.add(REFRESH);
  ctx.google.access.clear();
  await ctx.svc.addSession({ task: 'Email five leads', minutes: 30 });
  assert.equal(ctx.store.calendar!.status, 'revoked');
  const st = await ctx.cal.status();
  assert.match(st.speak, /no longer accepts/);
  const f = await ctx.cal.flush();
  assert.equal(f.waiting, 0);
});

// ---------- read: busy time is time already spoken for ----------

test('busy time from the chosen calendars reduces the focus window in planning context, as start and end only', async () => {
  const ctx = setup();
  await connect(ctx);
  const day = nextMonday();
  const primary = ctx.google.cals.get(EMAIL)!, work = ctx.google.cals.get('work@group.calendar.google.com')!;
  primary.busy.push({ start: at(ctx.store, day, '10:00'), end: at(ctx.store, day, '11:00'), title: 'Investor call' });
  primary.busy.push({ start: at(ctx.store, day, '20:00'), end: at(ctx.store, day, '21:00'), title: 'Dinner with Ana' });
  work.busy.push({ start: at(ctx.store, day, '11:30'), end: at(ctx.store, day, '12:00'), title: 'Standup' });
  await ctx.svc.setCommitments([{ title: 'Morning focus', kind: 'window', days: [1, 2, 3, 4, 5], start: '09:00', minutes: 180 }]);

  const before = (await setup({ pro: true }).svc.getPlanningContext(day)).focus_window_minutes;
  const p = await ctx.svc.getPlanningContext(day);
  assert.equal(p.focus_window_minutes, 120, 'the 10:00–11:00 call comes off the 09:00–12:00 window; the work calendar is not chosen');
  assert.notEqual(before, p.focus_window_minutes);
  assert.deepEqual(p.calendar!.busy, [{ start: '10:00', end: '11:00' }, { start: '20:00', end: '21:00' }]);
  assert.equal(p.calendar!.taken_from_focus_windows_minutes, 60);
  assert.equal(p.calendar!.declared_focus_window_minutes, 180);
  assert.match(p.speak, /10:00–11:00/);
  for (const title of ['Investor call', 'Dinner with Ana', 'Standup']) assert.ok(!JSON.stringify(p).includes(title), `no title: ${title}`);
  const stored = ctx.store.busy.get(day)!;
  assert.deepEqual(Object.keys(stored).sort(), ['calendars', 'date', 'fetchedAt', 'intervals']);
  assert.deepEqual(Object.keys(stored.intervals[0]).sort(), ['end', 'start'], 'only start and end are stored');

  await ctx.cal.setCalendars([EMAIL, 'work@group.calendar.google.com']);
  const p2 = await ctx.svc.getPlanningContext(day);
  assert.equal(p2.focus_window_minutes, 90, 'a new choice reads again: the work standup counts now');
});

test('busy times are cached per day for a few minutes; capacity shows the coming week', async () => {
  let now = new Date();
  const ctx = setup({ now: () => now });
  await connect(ctx);
  const day = addDays(nextMonday(), 7); // beyond the week that capacity (inside set_commitments) already read
  await ctx.svc.setCommitments([{ title: 'Morning focus', kind: 'window', days: [1, 2, 3, 4, 5], start: '09:00', minutes: 180 }]);
  const calls0 = ctx.google.freeBusyCalls();
  await ctx.svc.getPlanningContext(day);
  await ctx.svc.getPlanningContext(day);
  assert.equal(ctx.google.freeBusyCalls() - calls0, 1, 'the second read comes from the cache');
  const first = ctx.store.busy.get(day)!.fetchedAt;
  now = new Date(now.getTime() + BUSY_TTL_MS + 1000);
  await ctx.svc.getPlanningContext(day);
  assert.ok(ctx.google.freeBusyCalls() - calls0 > 1, 'after the TTL it reads Google again');
  assert.notEqual(ctx.store.busy.get(day)!.fetchedAt, first);
  const cap = await ctx.svc.capacity();
  assert.equal(cap.calendar_next_7_days!.length, 7);
  assert.ok(cap.calendar_next_7_days!.every(d => typeof d.focus_window_min === 'number'));
});

test('Free or not connected: planning reads no calendar and the focus window stays as declared', async () => {
  const ctx = setup({ pro: false });
  await ctx.svc.setCommitments([{ title: 'Morning focus', kind: 'window', days: [1, 2, 3, 4, 5], start: '09:00', minutes: 180 }]);
  const day = nextMonday();
  ctx.store.calendar = null;
  const p = await ctx.svc.getPlanningContext(day);
  assert.equal(p.focus_window_minutes, 180);
  assert.equal(p.calendar, null);
  assert.equal(ctx.google.freeBusyCalls(), 0);
});

test('focusDay: commitments are not taken twice; windows without a start lose busy time outside timed windows, up to their size', () => {
  const tz = 'Europe/Madrid', date = '2026-11-09'; // a Monday
  const t = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return new Date(startOfDay(date, tz).getTime() + (h * 60 + m) * 60000).toISOString(); };
  const items = [
    { id: 'w', title: 'Focus', kind: 'window' as const, days: [1], start: '09:00', minutes: 120 },
    { id: 'u', title: 'Evening', kind: 'window' as const, days: [1], minutes: 60 },
    { id: 's', title: 'School run', kind: 'commitment' as const, area: 'relations' as const, days: [1], start: '08:00', minutes: 30 },
  ];
  const f = focusDay(date, tz, items, [
    { start: t('08:00'), end: t('08:30') }, // the school run, also in the calendar: already spoken for
    { start: t('09:30'), end: t('10:00') }, // inside the timed window
    { start: t('15:00'), end: t('17:00') }, // outside: comes off the untimed window, at most 60
  ]);
  assert.equal(f.declared_min, 180);
  assert.equal(f.busy_min, 180);
  assert.equal(f.calendar_min, 30 + 60);
  assert.equal(f.net_min, 90);
});

// ---------- write: the AimYear calendar only ----------

test('a finished session is written to the AimYear calendar: task as title, summary as description, real start and end', async () => {
  const ctx = setup();
  await connect(ctx);
  const started = await ctx.svc.startSession({ task: 'Email five leads from the waitlist', override: true });
  const id = (started as any).session.id;
  const stop = await ctx.svc.stopSession('Sent 5, two replied', 'done', id);
  assert.equal(stop.ok, true);
  const cal = ctx.google.cals.get(ctx.store.calendar!.aimyearCalendarId!)!;
  const ev = cal.events.get(eventId('session', id))!;
  assert.ok(ev, 'the event exists under the session\'s own id');
  const s = ctx.store.sessions.get(id)!;
  assert.equal(ev.body.summary, 'Email five leads from the waitlist');
  assert.equal(ev.body.description, 'Sent 5, two replied');
  assert.equal(ev.body.start.dateTime, s.start);
  assert.equal(ev.body.end.dateTime, s.end);
  // Other calendars untouched: every write named the AimYear calendar, and the user's own events are as they were.
  assert.ok(ctx.google.writes().every(w => w.calendar === cal.id), JSON.stringify(ctx.google.writes()));
  assert.deepEqual([...ctx.google.cals.get(EMAIL)!.events.keys()], ['mine1']);
  assert.equal(ctx.google.cals.get('work@group.calendar.google.com')!.events.size, 0);

  // Fixing the session updates the same event; deleting it removes it.
  await ctx.svc.editSession(id, { task: 'Emailed five leads' });
  assert.equal(cal.events.size, 1);
  assert.equal(cal.events.get(eventId('session', id))!.body.summary, 'Emailed five leads');
  await ctx.svc.deleteSession(id);
  assert.equal(cal.events.size, 0);
});

test('add_session and stop_timer write their sessions too; nothing is written for Free', async () => {
  const ctx = setup();
  await connect(ctx);
  const logged = await ctx.svc.addSession({ task: 'Call with a customer', minutes: 25 });
  const cal = ctx.google.cals.get(ctx.store.calendar!.aimyearCalendarId!)!;
  assert.ok(cal.events.has(eventId('session', (logged as any).session.id)));
  await ctx.svc.startSession({ task: 'Landing copy', override: true });
  await ctx.svc.stopTimer('Hero section rewritten', 'partial');
  assert.equal(cal.events.size, 2);

  const free = setup();
  await connect(free);
  free.pro.on = false;
  const writesBefore = free.google.writes().length;
  await free.svc.addSession({ task: 'Call with a customer', minutes: 25 });
  await free.svc.setPlan(nextMonday(), [{ title: 'Email five leads', area: 'money', isMainStep: true }]);
  assert.equal(free.google.writes().length, writesBefore, 'Free: no write at all');
});

test('set_plan writes the main step as an all-day event that does not mark the day busy; a new main step replaces it', async () => {
  const ctx = setup();
  await connect(ctx);
  const day = nextMonday();
  await ctx.svc.setPlan(day, [{ title: 'Email five leads', area: 'money', isMainStep: true }, { title: 'Paid work', area: 'money' }]);
  const cal = ctx.google.cals.get(ctx.store.calendar!.aimyearCalendarId!)!;
  const ev = cal.events.get(eventId('main', day))!;
  assert.equal(ev.body.summary, 'Main step: Email five leads');
  assert.deepEqual(ev.body.start, { date: day });
  assert.deepEqual(ev.body.end, { date: addDays(day, 1) });
  assert.equal(ev.body.transparency, 'transparent');
  await ctx.svc.setPlan(day, [{ title: 'Post in two communities', area: 'money', isMainStep: true }]);
  assert.equal(cal.events.size, 1);
  assert.equal(cal.events.get(eventId('main', day))!.body.summary, 'Main step: Post in two communities');
  assert.ok(ctx.google.writes().every(w => w.calendar === cal.id));
});

test('a failed write never breaks the stop: it waits in the queue and /tick writes it later', async () => {
  const ctx = setup();
  await connect(ctx);
  ctx.google.failWrites = 5;
  const started = await ctx.svc.startSession({ task: 'Email five leads', override: true });
  const id = (started as any).session.id;
  const stop = await ctx.svc.stopSession('Sent 5', 'done', id);
  assert.equal(stop.ok, true, 'the session stopped anyway');
  assert.ok(ctx.store.sessions.get(id)!.end);
  assert.deepEqual([...ctx.store.outbox.keys()], [`session_${id}`]);
  const pending = ctx.store.pendings.get(retryId('fake'))!;
  assert.equal(pending.kind, 'calendar_retry');
  assert.ok(!JSON.stringify(ctx.store.outbox.get(`session_${id}`)).includes('Sent 5'), 'the queue names the session, not its content');

  ctx.google.failWrites = 0;
  const notif = new FakeNotifications();
  (notif as any).pendings = (notif as any).pendings ?? new Map();
  const r = await tick({ due: async () => [pending], claim: async () => true, dropStaleDesktopReminders: async () => 0 } as any, new Date(), undefined, () => ctx.cal);
  assert.equal(r.processed, 1);
  assert.match(r.results[0].reason!, /1 written, 0 waiting/);
  assert.equal(ctx.store.outbox.size, 0);
  const cal = ctx.google.cals.get(ctx.store.calendar!.aimyearCalendarId!)!;
  assert.ok(cal.events.has(eventId('session', id)));
});

// ---------- the HTTP side ----------

test('GET /calendar/google/callback is public and answers with a plain page; the four tools are listed', async () => {
  const google = new FakeGoogle();
  const stores = new Map<string, FakeStore>();
  const storeFor = (uid: string) => { if (!stores.has(uid)) { const s = new FakeStore(); (s as any).uid = uid; stores.set(uid, s); } return stores.get(uid)! as any; };
  const states = memStates();
  const deps: CalendarDeps = { google: googleApi(CFG, google.fetch), isPro: async () => true, states };
  const app = createApp({ tokens: new Map([['static-token-1', 'u1']]), baseUrl: new URL('http://localhost:1'), provider: { verifyAccessToken: async () => { throw new Error('no'); }, clientsStore: {} } as any, storeFor, calendarDeps: deps, socialDeps: { clients: {} as any, isPro: async () => false } });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const bad = await fetch(`${url}/calendar/google/callback?code=x&state=nope`);
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type') ?? '', /html/);
    assert.equal(bad.headers.get('referrer-policy'), 'no-referrer');

    const add = await rpc(`${url}/mcp`, call(1, 'tools/call', { name: 'add_calendar', arguments: {} }), { Authorization: 'Bearer static-token-1' });
    const link = JSON.parse(add.json.result.content[0].text);
    const state = new URL(link.url).searchParams.get('state')!;
    const ok = await fetch(`${url}/calendar/google/callback?code=good-code&state=${encodeURIComponent(state)}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Google Calendar connected/);
    assert.equal(stores.get('u1')!.calendar!.email, EMAIL);

    const got = await rpc(`${url}/mcp`, call(2, 'tools/call', { name: 'get_calendar', arguments: {} }), { Authorization: 'Bearer static-token-1' });
    const st = JSON.parse(got.json.result.content[0].text);
    assert.equal(st.connected, true);
    assert.ok(st.speak);
    const list = await rpc(`${url}/mcp`, call(3, 'tools/list'), {});
    const names = list.json.result.tools.map((t: { name: string }) => t.name);
    for (const n of ['get_calendar', 'add_calendar', 'set_calendar', 'delete_calendar']) assert.ok(names.includes(n), n);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('the account export leaves the sealed Google token out', async () => {
  const { AccountService } = await import('../src/account.js');
  const tree = { 'calendar/google': { email: EMAIL, readCalendars: [EMAIL], secret: { v: 1, iv: 'x', tag: 'y', data: 'z' } }, 'calendar_busy/2026-11-09': { date: '2026-11-09', intervals: [] } };
  const backend = { userTree: async () => structuredClone(tree), authUser: async () => null, topLevelOf: async () => ({}), tokensOf: async () => [] } as any;
  const out = await new AccountService(backend, 'u1').export();
  assert.deepEqual(Object.keys(out.data['calendar/google'] as object).sort(), ['email', 'readCalendars']);
});
