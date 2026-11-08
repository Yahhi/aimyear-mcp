/**
 * Google Calendar sync, both ways (docs/calendar-sync.md). Pro (docs/pricing.md).
 *
 * - Connect: the server's own OAuth web flow with Google (not the MCP sign-in in
 *   src/oauth.ts). The consent URL carries a one-time state bound to the signed-in uid;
 *   the callback exchanges the code, seals the refresh token (src/social/crypto.ts) and
 *   makes the "AimYear" calendar if the account has none from AimYear yet.
 * - Read: busy start and end from the calendars the user picked (freeBusy), cached per
 *   day in users/{uid}/calendar_busy for a few minutes. Never a title, attendee or
 *   description: freeBusy does not even return them.
 * - Write: finished sessions and the day's main step, into the AimYear calendar only.
 *   Every write names that calendar's id; nothing here can write anywhere else. Event ids
 *   are derived from the session or the date, so a retry replaces instead of duplicating.
 *   A write that fails is queued (users/{uid}/calendar_outbox) and tried again from /tick;
 *   it never fails the session stop or the plan that caused it.
 * - Disconnect: revokes the token at Google and deletes everything stored here. The
 *   AimYear calendar and its events stay in the user's Google account, like posts stay.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../store.js';
import { AimError, ProRequiredError } from '../service.js';
import { addDays, endOfDay, startOfDay } from '../dates.js';
import { isPro } from '../pro.js';
import { initFirestore } from '../store.js';
import { open, seal, SealError } from '../social/crypto.js';
import { GoogleError, SCOPES, googleApi, googleConfigFromEnv, type EventBody, type GoogleApi, type Interval } from './google.js';
import { clip, merge, toIso, toSpans } from './busy.js';
import type { BusyDay, CalendarLink, CalendarOutboxItem, Session } from '../types.js';

export const CALENDAR_PRO = 'Google Calendar sync is part of AimYear Pro. Get Pro on aimyear.com or in the app.';
export const AIMYEAR_CALENDAR = 'AimYear';
/** Written into the calendar's description: how a reconnect finds the calendar AimYear made before. */
export const CALENDAR_MARK = 'Made by AimYear (aimyear.com): your finished focus sessions and each day\'s main step.';
export const STATE_TTL_MS = 10 * 60000;
/** Busy times read less than this long ago are used as they are. */
export const BUSY_TTL_MS = 10 * 60000;
const MAX_ATTEMPTS = 8;
export const retryId = (uid: string) => `calendar-retry-${uid}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Google event ids are base32hex (0-9, a-v): hex is a subset. */
export const eventId = (kind: 'session' | 'main', ref: string) => sha(`aimyear:${kind}:${ref}`).slice(0, 40);

/** One-time OAuth states, top level (the callback does not know the uid yet). Stored as hashes. */
export interface OAuthStates {
  put(hash: string, row: { uid: string; expires: number }): Promise<void>;
  /** Reads and deletes in one step: a state works once. */
  take(hash: string): Promise<{ uid: string; expires: number } | null>;
}
export const STATES = 'calendar_oauth_states';
export function firestoreStates(): OAuthStates {
  const col = () => initFirestore().collection(STATES);
  return {
    async put(hash, row) { await col().doc(hash).set(row); },
    async take(hash) {
      const db = initFirestore(), ref = col().doc(hash);
      return db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists) return null;
        tx.delete(ref);
        return s.data() as { uid: string; expires: number };
      });
    },
  };
}

export interface CalendarDeps {
  /** null: GOOGLE_OAUTH_CLIENT_ID / _SECRET are not set, so connecting refuses. */
  google: GoogleApi | null;
  isPro: (uid: string) => Promise<boolean>;
  states: OAuthStates;
  now?: () => Date;
}
let realDeps: CalendarDeps | null = null;
export function realCalendarDeps(): CalendarDeps {
  if (realDeps) return realDeps;
  const cfg = googleConfigFromEnv();
  realDeps = { google: cfg ? googleApi(cfg) : null, isPro, states: firestoreStates() };
  return realDeps;
}

/** Access tokens live an hour; one per process and refresh token is plenty. */
const accessCache = new Map<string, { token: string; until: number }>();

/** Only messages we wrote ourselves pass through: they never contain a token. */
function safe(e: unknown): string {
  if (e instanceof GoogleError || e instanceof SealError || e instanceof AimError) return e.message;
  return 'Something went wrong on the way to Google.';
}

export type CalendarStore = Pick<Store, 'uid' | 'getProfile' | 'getCalendarLink' | 'saveCalendarLink' | 'deleteCalendarData' | 'getBusyDays' | 'saveBusyDay'
  | 'getCalendarOutbox' | 'saveCalendarOutbox' | 'removeCalendarOutbox' | 'getSession' | 'getDay' | 'getGoal' | 'savePending' | 'removePending'>;

export class CalendarService {
  constructor(private store: CalendarStore, private deps: CalendarDeps = realCalendarDeps()) {}

  private now() { return this.deps.now?.() ?? new Date(); }
  private get uid() { return this.store.uid; }
  private async requirePro() { if (!(await this.deps.isPro(this.uid))) throw new ProRequiredError(CALENDAR_PRO); }
  private google(): GoogleApi {
    if (!this.deps.google) throw new AimError('Google Calendar is not set up on this server yet. Nothing was changed.');
    return this.deps.google;
  }

  // ---------- connecting ----------
  /** The Google consent URL for the signed-in user. The state in it works once, for 10 minutes. */
  async connectUrl() {
    await this.requirePro();
    const g = this.google();
    seal({ check: '1' }, this.uid, 'google_calendar'); // no key, no connect: the token would have nowhere safe to go
    const state = randomBytes(32).toString('base64url');
    await this.deps.states.put(sha(state), { uid: this.uid, expires: this.now().getTime() + STATE_TTL_MS });
    return {
      url: g.authUrl(state), expires_in_min: STATE_TTL_MS / 60000,
      speak: 'Open this link to connect Google Calendar (it works once, for 10 minutes). AimYear reads only busy times from the calendars you pick, and writes only to its own "AimYear" calendar.',
    };
  }

  /**
   * After Google's consent: saves the sealed refresh token and makes the AimYear calendar
   * when the user granted it. Called by the callback route with the uid from the state.
   */
  async finishConnect(code: string) {
    const g = this.google();
    const t = await g.exchangeCode(code);
    if (!t.refreshToken) throw new AimError('Google sent no lasting access. Try connecting again.');
    const granted = new Set(t.scopes);
    const secret = seal({ refreshToken: t.refreshToken }, this.uid, 'google_calendar');
    const prior = await this.store.getCalendarLink();
    const tz = (await this.store.getProfile()).timezone;
    const list = granted.has(SCOPES.list) ? await g.listCalendars(t.accessToken) : [];
    const primary = list.find(c => c.primary);
    let aimyear: string | undefined;
    if (granted.has(SCOPES.appCreated)) {
      // A reconnect finds the calendar AimYear made before instead of making a second one.
      const candidates = [prior?.aimyearCalendarId, ...list.filter(c => c.summary === AIMYEAR_CALENDAR && c.accessRole === 'owner' && c.description === CALENDAR_MARK).map(c => c.id)].filter((x): x is string => !!x);
      for (const id of new Set(candidates)) if (await g.calendarExists(t.accessToken, id)) { aimyear = id; break; }
      aimyear ??= await g.createCalendar(t.accessToken, AIMYEAR_CALENDAR, CALENDAR_MARK, tz);
    }
    const readable = new Set(list.map(c => c.id));
    const kept = (prior?.readCalendars ?? []).filter(id => id !== aimyear && (!list.length || readable.has(id)));
    const link: CalendarLink = {
      email: primary?.id ?? prior?.email ?? '', connectedAt: this.now().toISOString(), scopes: [...granted],
      readCalendars: kept.length ? kept : primary ? [primary.id] : [], aimyearCalendarId: aimyear, status: 'ok', secret,
    };
    await this.store.saveCalendarLink(link);
    accessCache.set(this.cacheKey(link), { token: t.accessToken, until: this.now().getTime() + (t.expiresIn - 120) * 1000 });
    return { ok: true, email: link.email, missing: this.missing(link) };
  }

  private missing(l: CalendarLink): string[] {
    const out: string[] = [];
    if (!l.scopes.includes(SCOPES.freebusy)) out.push('reading busy times');
    if (!l.scopes.includes(SCOPES.list)) out.push('the list of your calendars');
    if (!l.scopes.includes(SCOPES.appCreated)) out.push('writing to the AimYear calendar');
    return out;
  }

  private cacheKey(l: CalendarLink) { return `${this.uid}:${l.secret.data.slice(0, 32)}`; }

  /** A fresh access token from the sealed refresh token. A revoked one marks the link. */
  private async access(l: CalendarLink): Promise<string> {
    const key = this.cacheKey(l);
    const hit = accessCache.get(key);
    if (hit && hit.until > this.now().getTime()) return hit.token;
    const { refreshToken } = open(l.secret, this.uid, 'google_calendar');
    try {
      const t = await this.google().refresh(refreshToken);
      accessCache.set(key, { token: t.accessToken, until: this.now().getTime() + (t.expiresIn - 120) * 1000 });
      return t.accessToken;
    } catch (e) {
      if (e instanceof GoogleError && e.revoked) await this.store.saveCalendarLink({ ...l, status: 'revoked' });
      throw e;
    }
  }

  /** Runs fn with an access token; a 401 (token expired early, or revoked) gets one fresh token and a second try. */
  private async withAccess<T>(l: CalendarLink, fn: (access: string) => Promise<T>): Promise<T> {
    try { return await fn(await this.access(l)); }
    catch (e) {
      if (!(e instanceof GoogleError) || e.status !== 401) throw e;
      accessCache.delete(this.cacheKey(l));
      return fn(await this.access(l));
    }
  }

  // ---------- status, choice, disconnect ----------
  async status() {
    const pro = await this.deps.isPro(this.uid);
    const l = await this.store.getCalendarLink();
    if (!l) {
      return {
        connected: false, pro, configured: !!this.deps.google, calendars: [], read_calendars: [], aimyear_calendar: false,
        speak: `Google Calendar is not connected.${pro ? ' Connect it (add_calendar) so busy times count in planning and finished sessions land in an "AimYear" calendar.' : ` ${CALENDAR_PRO}`}`,
      };
    }
    let calendars: { id: string; name: string; primary: boolean; read: boolean }[] = [];
    let error: string | undefined;
    if (l.status === 'ok' && l.scopes.includes(SCOPES.list) && this.deps.google) {
      try {
        calendars = (await this.withAccess(l, a => this.google().listCalendars(a)))
          .filter(c => c.id !== l.aimyearCalendarId)
          .map(c => ({ id: c.id, name: c.summary, primary: c.primary, read: l.readCalendars.includes(c.id) }));
      } catch (e) { error = safe(e); }
    }
    const fresh = (await this.store.getCalendarLink()) ?? l;
    const missing = this.missing(fresh);
    const active = pro && fresh.status === 'ok';
    const speak = fresh.status === 'revoked' ? `Google no longer accepts AimYear's access to ${fresh.email || 'that account'}. Connect Google Calendar again, or disconnect it.`
      : `Google Calendar connected (${fresh.email || 'your account'}). Busy times are read from ${fresh.readCalendars.length} calendar(s)${calendars.length ? `: ${calendars.filter(c => c.read).map(c => c.name).join(', ') || 'none'}` : ''}. ${fresh.aimyearCalendarId ? 'Finished sessions and the main step go to the "AimYear" calendar, nowhere else.' : 'Nothing is written: writing to an AimYear calendar was not allowed.'}${missing.length ? ` Not allowed on Google's consent screen: ${missing.join(', ')}.` : ''}${error ? ` The calendar list could not be read: ${error}` : ''}${active ? '' : pro ? '' : ` Sync is paused: ${CALENDAR_PRO}`}`;
    return {
      connected: true, status: fresh.status, pro, active, email: fresh.email, connected_at: fresh.connectedAt,
      calendars, read_calendars: fresh.readCalendars, aimyear_calendar: !!fresh.aimyearCalendarId, missing_permissions: missing, error, speak,
    };
  }

  /** Which calendars' busy times count. The AimYear calendar itself never does. */
  async setCalendars(ids: string[]) {
    await this.requirePro();
    const l = await this.store.getCalendarLink();
    if (!l) throw new AimError('Google Calendar is not connected. Connect it first (add_calendar).');
    if (l.status !== 'ok') throw new AimError('Google no longer accepts AimYear\'s access. Connect Google Calendar again first.');
    const want = [...new Set(ids.map(s => s.trim()).filter(Boolean))];
    if (l.aimyearCalendarId && want.includes(l.aimyearCalendarId)) throw new AimError('The AimYear calendar holds AimYear\'s own sessions: its time is never counted as busy.');
    if (l.scopes.includes(SCOPES.list)) {
      const known = new Set((await this.withAccess(l, a => this.google().listCalendars(a))).map(c => c.id));
      const unknown = want.filter(id => !known.has(id));
      if (unknown.length) throw new AimError(`Not in your calendar list: ${unknown.join(', ')}. get_calendar lists the ids.`);
    }
    await this.store.saveCalendarLink({ ...l, readCalendars: want });
    const s = await this.status();
    return { ok: true, ...s, speak: `Saved. ${s.speak}` };
  }

  /** Not Pro-gated: anyone can always take AimYear's access away. */
  async disconnect() {
    const l = await this.store.getCalendarLink();
    if (!l) return { ok: true, revoked: false, speak: 'Google Calendar was not connected.' };
    let revoked = false, note = '';
    try {
      const { refreshToken } = open(l.secret, this.uid, 'google_calendar');
      await this.google().revoke(refreshToken);
      revoked = true;
    } catch (e) { note = ` Google could not be reached to revoke the access (${safe(e)}); remove AimYear at myaccount.google.com/permissions to be sure.`; }
    accessCache.delete(this.cacheKey(l));
    await this.store.deleteCalendarData();
    await this.store.removePending(retryId(this.uid));
    return {
      ok: true, revoked,
      speak: `Google Calendar disconnected: AimYear no longer reads busy times or writes events, and its saved access is deleted.${note} The "AimYear" calendar and the events already in it stay in your Google account; delete that calendar in Google Calendar if you don't want it.`,
    };
  }

  // ---------- read: busy times ----------
  /** The link when sync runs for this user: Pro, connected, and Google configured. */
  private async activeLink(): Promise<CalendarLink | null> {
    if (!this.deps.google) return null;
    const l = await this.store.getCalendarLink();
    if (!l || l.status !== 'ok') return null;
    if (!(await this.deps.isPro(this.uid))) return null;
    return l;
  }

  /**
   * Busy intervals per local day from from to to (YYYY-MM-DD, inclusive), or null when sync
   * is off for this user. Cached days younger than BUSY_TTL_MS are used as they are; the
   * rest come from one freeBusy call. When Google fails, an older cached day is used and
   * error says so.
   */
  async busy(from: string, to: string, tz: string): Promise<{ days: Map<string, Interval[]>; error?: string } | null> {
    const l = await this.activeLink();
    if (!l || !l.scopes.includes(SCOPES.freebusy)) return null;
    const ids = l.readCalendars.filter(id => id !== l.aimyearCalendarId);
    const key = [...ids].sort().join('\n');
    const dates: string[] = [];
    for (let d = from; d <= to && dates.length < 62; d = addDays(d, 1)) dates.push(d);
    const days = new Map<string, Interval[]>();
    if (!ids.length) { for (const d of dates) days.set(d, []); return { days }; }
    const cached = new Map((await this.store.getBusyDays(from, to)).filter(b => [...b.calendars].sort().join('\n') === key).map(b => [b.date, b]));
    const now = this.now().getTime();
    const stale = dates.filter(d => { const c = cached.get(d); return !c || now - Date.parse(c.fetchedAt) > BUSY_TTL_MS; });
    let error: string | undefined;
    if (stale.length) {
      try {
        const lo = startOfDay(stale[0], tz), hi = endOfDay(stale[stale.length - 1], tz);
        const r = await this.withAccess(l, a => this.google().freeBusy(a, ids, lo.toISOString(), hi.toISOString(), tz));
        if (r.failed.length) error = `${r.failed.length} calendar(s) could not be read`;
        const all = merge(toSpans(r.busy));
        const fetchedAt = new Date(now).toISOString();
        for (const d of stale) {
          const b: BusyDay = { date: d, intervals: toIso(clip(all, startOfDay(d, tz).getTime(), endOfDay(d, tz).getTime())), calendars: ids, fetchedAt };
          await this.store.saveBusyDay(b);
          cached.set(d, b);
        }
      } catch (e) {
        error = safe(e);
        console.error('[calendar] busy read failed', error);
      }
    }
    for (const d of dates) days.set(d, cached.get(d)?.intervals ?? []);
    const unread = stale.filter(d => !cached.has(d));
    if (error && unread.length === dates.length) return { days: new Map(), error };
    return { days, error };
  }

  // ---------- write: the AimYear calendar only ----------
  /** A session ended (or was fixed): write it. Never throws. */
  sessionEnded(sessionId: string) { return this.write('session', sessionId); }
  /** A session was deleted: take it out of the AimYear calendar. Never throws. */
  sessionDeleted(sessionId: string) { return this.write('session_delete', sessionId); }
  /** The day's plan was set: write, move or remove its main step. Never throws. */
  mainStepChanged(date: string) { return this.write('main_step', date); }

  private async write(kind: CalendarOutboxItem['kind'], ref: string): Promise<'written' | 'skipped' | 'queued'> {
    try {
      const l = await this.activeLink();
      if (!l?.aimyearCalendarId) return 'skipped';
      await this.withAccess(l, a => this.perform(l, a, kind, ref));
      // A later write for the same thing supersedes a queued one.
      await this.store.removeCalendarOutbox(`${kind === 'session_delete' ? 'session' : kind}_${ref}`).catch(() => {});
      return 'written';
    } catch (e) {
      const msg = safe(e);
      console.error(`[calendar] ${kind} write failed, queued`, msg);
      try { await this.enqueue(kind, ref, msg); } catch (e2) { console.error('[calendar] queueing failed', (e2 as Error).message); }
      return 'queued';
    }
  }

  private async perform(l: CalendarLink, access: string, kind: CalendarOutboxItem['kind'], ref: string) {
    const cal = l.aimyearCalendarId!;
    const g = this.google();
    if (kind === 'session_delete') { await g.deleteEvent(access, cal, eventId('session', ref)); return; }
    if (kind === 'session') {
      const s = await this.store.getSession(ref);
      if (!s) { await g.deleteEvent(access, cal, eventId('session', ref)); return; }
      const body = sessionEvent(s);
      if (body) await g.putEvent(access, cal, eventId('session', ref), body);
      return;
    }
    const day = await this.store.getDay(ref);
    const main = day && day.mode !== 'off' ? day.plan.find(p => p.isMainStep) : undefined;
    if (!main) { await g.deleteEvent(access, cal, eventId('main', ref)); return; }
    const goal = await this.store.getGoal();
    await g.putEvent(access, cal, eventId('main', ref), {
      summary: `Main step: ${main.title}`,
      description: goal ? `Today's step toward "${goal.title}". Set in AimYear.` : 'Set in AimYear.',
      start: { date: ref }, end: { date: addDays(ref, 1) },
      // It marks the day; it must not make the person look busy to anyone.
      transparency: 'transparent',
      extendedProperties: { private: { aimyear: `main:${ref}` } },
    });
  }

  private async enqueue(kind: CalendarOutboxItem['kind'], ref: string, err: string) {
    const key = `${kind === 'session_delete' ? 'session' : kind}_${ref}`;
    const prior = (await this.store.getCalendarOutbox()).find(i => i.key === key);
    await this.store.saveCalendarOutbox({ key, kind, ref, attempts: prior && prior.kind === kind ? prior.attempts : 0, lastError: err, at: this.now().toISOString() });
    await this.arm(prior?.attempts ?? 0);
  }

  private async arm(attempts: number) {
    const delayMin = Math.min(240, 5 * 2 ** attempts);
    await this.store.savePending({ id: retryId(this.uid), uid: this.uid, blockId: '', kind: 'calendar_retry', dueAt: new Date(this.now().getTime() + delayMin * 60000).toISOString(), workplace: 'mobile', minutes: 0, breakMin: 0 });
  }

  /** The /tick retry: tries every queued write again. Returns how many are still waiting. */
  async flush(): Promise<{ written: number; waiting: number; dropped: number }> {
    const items = await this.store.getCalendarOutbox();
    if (!items.length) return { written: 0, waiting: 0, dropped: 0 };
    const l = await this.activeLink().catch(() => null);
    if (!l?.aimyearCalendarId) {
      // Not Pro or not connected any more: nothing may be written, so nothing waits.
      for (const i of items) await this.store.removeCalendarOutbox(i.key);
      return { written: 0, waiting: 0, dropped: items.length };
    }
    let written = 0, dropped = 0, most = 0;
    for (const i of items) {
      try { await this.withAccess(l, a => this.perform(l, a, i.kind, i.ref)); await this.store.removeCalendarOutbox(i.key); written++; }
      catch (e) {
        const attempts = i.attempts + 1;
        if (attempts >= MAX_ATTEMPTS || (e instanceof GoogleError && e.revoked)) { await this.store.removeCalendarOutbox(i.key); dropped++; continue; }
        await this.store.saveCalendarOutbox({ ...i, attempts, lastError: safe(e), at: this.now().toISOString() });
        most = Math.max(most, attempts);
      }
    }
    const waiting = items.length - written - dropped;
    if (waiting) await this.arm(most);
    return { written, waiting, dropped };
  }
}

/** A finished session as an event: task as the title, summary as the description, real start and end. */
export function sessionEvent(s: Session): EventBody | null {
  // A forgotten timer closed by the server is not a real end: wait for the user's fix (edit_session).
  if (!s.end || s.autoClosed) return null;
  return {
    summary: s.task, description: s.summary?.trim() || undefined,
    start: { dateTime: s.start }, end: { dateTime: s.end },
    extendedProperties: { private: { aimyear: `session:${s.id}` } },
  };
}

/** The callback: the state names the user; the code becomes their sealed token. Returns a sentence for the page. */
export async function finishGoogleCallback(q: { code?: string; state?: string; error?: string }, deps: CalendarDeps, storeFor: (uid: string) => CalendarStore, now = new Date()): Promise<{ ok: boolean; message: string }> {
  if (!q.state) return { ok: false, message: 'This link is missing its sign-in state. Start again from AimYear.' };
  const row = await deps.states.take(sha(q.state));
  if (!row || row.expires < now.getTime()) return { ok: false, message: 'This connect link has expired or was used already. Start again from AimYear.' };
  if (q.error || !q.code) return { ok: false, message: q.error === 'access_denied' ? 'Google Calendar was not connected: access was not allowed.' : 'Google Calendar was not connected. Try again from AimYear.' };
  try {
    const r = await new CalendarService(storeFor(row.uid), deps).finishConnect(q.code);
    return { ok: true, message: `Google Calendar connected${r.email ? ` (${r.email})` : ''}.${r.missing.length ? ` Not allowed: ${r.missing.join(', ')}; connect again to allow it.` : ''} You can go back to AimYear now.` };
  } catch (e) {
    console.error('[calendar] connect failed', safe(e));
    return { ok: false, message: `Google Calendar was not connected: ${safe(e)}` };
  }
}

