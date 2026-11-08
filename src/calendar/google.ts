/**
 * Google's OAuth and Calendar REST endpoints, with plain fetch, behind one small
 * interface so tests never reach Google. Error messages are built from the status code
 * and Google's error NAME only: they never echo a request, so they never carry a token.
 *
 * Scopes (docs/calendar-sync.md), the narrowest that do the job:
 *  - calendar.calendarlist.readonly: the list of calendars, so the user can pick which to read;
 *  - calendar.freebusy: busy start/end on the chosen calendars, never titles or attendees;
 *  - calendar.app.created: AimYear's own "AimYear" calendar and its events, nothing else.
 */
import type { Fetch } from '../social/clients.js';

export const SCOPES = {
  list: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  freebusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  appCreated: 'https://www.googleapis.com/auth/calendar.app.created',
} as const;
export const ALL_SCOPES = [SCOPES.list, SCOPES.freebusy, SCOPES.appCreated];

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CAL_API = 'https://www.googleapis.com/calendar/v3';

export class GoogleError extends Error {
  /** revoked: the refresh token no longer works (the user removed AimYear's access). */
  constructor(public status: number, message: string, public revoked = false) { super(message); }
}

export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }

/** From env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI (default <base>/calendar/google/callback). */
export function googleConfigFromEnv(env: Record<string, string | undefined> = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const base = env.AIMYEAR_BASE_URL ?? `http://localhost:${env.PORT ?? 8787}`;
  return { clientId, clientSecret, redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || new URL('/calendar/google/callback', base).href };
}

export interface CalendarEntry { id: string; summary: string; primary: boolean; accessRole: string; description?: string }
export interface Interval { start: string; end: string }
export interface Tokens { accessToken: string; expiresIn: number; refreshToken?: string; scopes: string[] }

/** An event in the AimYear calendar: timed (dateTime) or all-day (date, end exclusive). */
export interface EventBody {
  summary: string;
  description?: string;
  start: { dateTime: string } | { date: string };
  end: { dateTime: string } | { date: string };
  transparency?: 'opaque' | 'transparent';
  extendedProperties?: { private: Record<string, string> };
}

export interface GoogleApi {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  revoke(token: string): Promise<void>;
  listCalendars(access: string): Promise<CalendarEntry[]>;
  calendarExists(access: string, calendarId: string): Promise<boolean>;
  createCalendar(access: string, summary: string, description: string, timeZone: string): Promise<string>;
  freeBusy(access: string, calendarIds: string[], timeMin: string, timeMax: string, timeZone: string): Promise<{ busy: Interval[]; failed: string[] }>;
  /** Creates or replaces one event with our own id: a retry never makes a second one. */
  putEvent(access: string, calendarId: string, eventId: string, body: EventBody): Promise<void>;
  deleteEvent(access: string, calendarId: string, eventId: string): Promise<void>;
}

const NAME_ONLY = /^[A-Za-z_]{3,40}$/;

async function call(f: Fetch, url: string, init: RequestInit, what: string): Promise<{ status: number; body: any }> {
  let r: Response;
  try { r = await f(url, { ...init, signal: AbortSignal.timeout(10000) }); }
  catch { throw new GoogleError(0, `Google did not answer (${what}). Try again later.`); }
  const text = await r.text().catch(() => '');
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, body };
}

function fail(status: number, body: any, what: string): never {
  // Token endpoint: { error: "invalid_grant" }. Calendar API: { error: { status: "NOT_FOUND", errors: [{ reason }] } }.
  const raw = typeof body?.error === 'string' ? body.error : String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '');
  const why = NAME_ONLY.test(raw) ? raw : '';
  if (why === 'invalid_grant') throw new GoogleError(status, 'Google no longer accepts AimYear\'s access to this calendar. Connect Google Calendar again.', true);
  const msg = status === 401 || status === 403 ? `Google refused ${what} (${status}${why ? ` ${why}` : ''}).`
    : status === 429 ? 'Google says too many requests. Try again later.'
      : `Google answered ${status} to ${what}${why ? ` (${why})` : ''}.`;
  throw new GoogleError(status, msg);
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

export function googleApi(cfg: GoogleConfig, f: Fetch = fetch): GoogleApi {
  const tokens = (b: any): Tokens => ({
    accessToken: String(b?.access_token ?? ''), expiresIn: Number(b?.expires_in ?? 3600),
    refreshToken: typeof b?.refresh_token === 'string' ? b.refresh_token : undefined,
    scopes: String(b?.scope ?? '').split(/\s+/).filter(Boolean),
  });
  const auth = (access: string) => ({ Authorization: `Bearer ${access}`, Accept: 'application/json' });
  const json = (access: string) => ({ ...auth(access), 'Content-Type': 'application/json' });
  const cal = (id: string) => `${CAL_API}/calendars/${encodeURIComponent(id)}`;

  return {
    authUrl(state) {
      const q = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: ALL_SCOPES.join(' '),
        // offline: a refresh token, so sync runs without the user present; consent: Google sends
        // the refresh token again on a reconnect; include_granted_scopes: incremental authorization.
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      });
      return `${AUTH_URL}?${q}`;
    },
    async exchangeCode(code) {
      const r = await call(f, TOKEN_URL, { method: 'POST', headers: FORM, body: form({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }) }, 'the sign-in');
      if (r.status !== 200 || !r.body?.access_token) fail(r.status, r.body, 'the sign-in');
      return tokens(r.body);
    },
    async refresh(refreshToken) {
      const r = await call(f, TOKEN_URL, { method: 'POST', headers: FORM, body: form({ refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' }) }, 'the saved access');
      if (r.status !== 200 || !r.body?.access_token) fail(r.status, r.body, 'the saved access');
      return tokens(r.body);
    },
    async revoke(token) {
      const r = await call(f, REVOKE_URL, { method: 'POST', headers: FORM, body: form({ token }) }, 'the disconnect');
      // 400 invalid_token: already revoked or expired, which is what we wanted.
      if (r.status !== 200 && r.status !== 400) fail(r.status, r.body, 'the disconnect');
    },
    async listCalendars(access) {
      const out: CalendarEntry[] = [];
      let page: string | undefined;
      for (let i = 0; i < 10; i++) {
        const q = new URLSearchParams({ maxResults: '250', minAccessRole: 'freeBusyReader', ...(page ? { pageToken: page } : {}) });
        const r = await call(f, `${CAL_API}/users/me/calendarList?${q}`, { headers: auth(access) }, 'the calendar list');
        if (r.status !== 200) fail(r.status, r.body, 'the calendar list');
        for (const c of (r.body?.items ?? []) as any[]) {
          out.push({ id: String(c.id), summary: String(c.summaryOverride ?? c.summary ?? c.id), primary: c.primary === true, accessRole: String(c.accessRole ?? ''), description: typeof c.description === 'string' ? c.description : undefined });
        }
        page = r.body?.nextPageToken;
        if (!page) break;
      }
      return out;
    },
    async calendarExists(access, calendarId) {
      const r = await call(f, cal(calendarId), { headers: auth(access) }, 'the AimYear calendar');
      if (r.status === 200) return true;
      if (r.status === 404 || r.status === 403 || r.status === 410) return false;
      fail(r.status, r.body, 'the AimYear calendar');
    },
    async createCalendar(access, summary, description, timeZone) {
      const r = await call(f, `${CAL_API}/calendars`, { method: 'POST', headers: json(access), body: JSON.stringify({ summary, description, timeZone }) }, 'making the AimYear calendar');
      if (r.status !== 200 || !r.body?.id) fail(r.status, r.body, 'making the AimYear calendar');
      return String(r.body.id);
    },
    async freeBusy(access, calendarIds, timeMin, timeMax, timeZone) {
      const r = await call(f, `${CAL_API}/freeBusy`, { method: 'POST', headers: json(access), body: JSON.stringify({ timeMin, timeMax, timeZone, items: calendarIds.map(id => ({ id })) }) }, 'reading busy times');
      if (r.status !== 200) fail(r.status, r.body, 'reading busy times');
      const busy: Interval[] = [], failed: string[] = [];
      for (const id of calendarIds) {
        const c = r.body?.calendars?.[id];
        if (!c || (Array.isArray(c.errors) && c.errors.length)) { failed.push(id); continue; }
        for (const b of (c.busy ?? []) as any[]) if (typeof b?.start === 'string' && typeof b?.end === 'string') busy.push({ start: b.start, end: b.end });
      }
      return { busy, failed };
    },
    async putEvent(access, calendarId, eventId, body) {
      const url = `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`;
      // status confirmed: an event deleted earlier (Google keeps it as cancelled) comes back.
      const upd = await call(f, url, { method: 'PUT', headers: json(access), body: JSON.stringify({ ...body, status: 'confirmed' }) }, 'writing to the AimYear calendar');
      if (upd.status === 200) return;
      if (upd.status !== 404) fail(upd.status, upd.body, 'writing to the AimYear calendar');
      const ins = await call(f, `${cal(calendarId)}/events`, { method: 'POST', headers: json(access), body: JSON.stringify({ ...body, id: eventId }) }, 'writing to the AimYear calendar');
      if (ins.status === 200) return;
      // 409: another attempt made it a moment ago; replace it with this one.
      if (ins.status === 409) {
        const again = await call(f, url, { method: 'PUT', headers: json(access), body: JSON.stringify({ ...body, status: 'confirmed' }) }, 'writing to the AimYear calendar');
        if (again.status === 200) return;
        fail(again.status, again.body, 'writing to the AimYear calendar');
      }
      fail(ins.status, ins.body, 'writing to the AimYear calendar');
    },
    async deleteEvent(access, calendarId, eventId) {
      const r = await call(f, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers: auth(access) }, 'removing an event from the AimYear calendar');
      if (r.status === 204 || r.status === 200 || r.status === 404 || r.status === 410) return;
      fail(r.status, r.body, 'removing an event from the AimYear calendar');
    },
  };
}
