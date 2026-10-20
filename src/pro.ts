/**
 * THE Pro check point. Everything that docs/pricing.md puts in Pro and that the server
 * enforces asks here, and only here.
 *
 * Pro is one subscription status per account, kept by RevenueCat (docs/pricing.md, "Where
 * Pro is bought"): the app logs in to RevenueCat with the Firebase uid, and aimyear.com
 * must buy under the same id, so the RevenueCat app user id IS the uid. The answer, in order:
 *
 *  1. AIMYEAR_PRO_UIDS (comma-separated uids): Pro by hand, always wins.
 *  2. With REVENUECAT_SECRET_KEY: RevenueCat's REST API, GET /v1/subscribers/{uid}, the
 *     entitlement REVENUECAT_ENTITLEMENT (default "AimYear Pro", the app's id), cached
 *     for a minute per uid. If RevenueCat cannot be reached, the stored status below.
 *  3. The stored status at users/{uid}/aim/pro, written by the RevenueCat webhook
 *     (POST /revenuecat/webhook): active, and not past its expiry.
 *
 * Anything missing or failing is "not Pro": the check fails closed.
 */
import { initFirestore } from './store.js';

export const DEFAULT_ENTITLEMENT = 'AimYear Pro';
const CACHE_MS = 60_000;
const RC_API = 'https://api.revenuecat.com/v1';

/** users/{uid}/aim/pro. A doc of its own: the profile is saved whole and would overwrite it. */
export interface ProStatus {
  active: boolean;
  /** ISO; null for a purchase that does not expire. */
  expiresAt: string | null;
  entitlement: string;
  source: 'revenuecat_api' | 'revenuecat_webhook';
  /** The RevenueCat event time (ms) this status came from, so an older event never overwrites a newer one. */
  eventAt?: number;
  /** The webhook event type that set it, e.g. RENEWAL, EXPIRATION. */
  event?: string;
  updatedAt: string;
}

export interface ProDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  getStatus: (uid: string) => Promise<ProStatus | null>;
  saveStatus: (uid: string, s: ProStatus) => Promise<void>;
}

/** A RevenueCat app user id we can store under: a Firebase uid, never an anonymous RevenueCat id. */
export const usableUid = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

const stillActive = (s: { active: boolean; expiresAt: string | null }, now: Date) =>
  s.active && (s.expiresAt === null || Date.parse(s.expiresAt) > now.getTime());

/** Reads one entitlement out of a /v1/subscribers answer. */
export function entitlementOf(body: unknown, entitlement: string, now: Date): { active: boolean; expiresAt: string | null } {
  const e = (body as { subscriber?: { entitlements?: Record<string, { expires_date?: string | null; grace_period_expires_date?: string | null }> } })
    ?.subscriber?.entitlements?.[entitlement];
  if (!e) return { active: false, expiresAt: null };
  const ends = [e.expires_date, e.grace_period_expires_date].filter((x): x is string => typeof x === 'string');
  if (e.expires_date === null || e.expires_date === undefined) return { active: true, expiresAt: null };
  const last = ends.map(Date.parse).filter(n => !Number.isNaN(n)).sort((a, b) => b - a)[0];
  if (last === undefined) return { active: false, expiresAt: null };
  return { active: last > now.getTime(), expiresAt: new Date(last).toISOString() };
}

export function createPro(deps: ProDeps) {
  const cache = new Map<string, { pro: boolean; at: number }>();
  const entitlement = () => deps.env.REVENUECAT_ENTITLEMENT?.trim() || DEFAULT_ENTITLEMENT;
  const overrides = () => (deps.env.AIMYEAR_PRO_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);

  /** Asks RevenueCat. Throws when it cannot answer; the caller falls back. */
  async function fromApi(uid: string): Promise<ProStatus> {
    const key = deps.env.REVENUECAT_SECRET_KEY;
    if (!key) throw new Error('no RevenueCat key');
    const r = await deps.fetch(`${RC_API}/subscribers/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error(`RevenueCat answered ${r.status}`);
    const now = deps.now();
    const e = entitlementOf(await r.json(), entitlement(), now);
    return { ...e, entitlement: entitlement(), source: 'revenuecat_api', updatedAt: now.toISOString() };
  }

  async function isPro(uid: string): Promise<boolean> {
    if (!usableUid(uid)) return false;
    if (overrides().includes(uid)) return true;
    const now = deps.now();
    const hit = cache.get(uid);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.pro;
    let pro: boolean;
    try {
      pro = stillActive(await fromApi(uid), now);
    } catch {
      const stored = await deps.getStatus(uid).catch(() => null);
      pro = !!stored && stillActive(stored, now);
    }
    cache.set(uid, { pro, at: now.getTime() });
    return pro;
  }

  /**
   * One RevenueCat webhook event. With the REST key, the event is only a signal: the
   * status is read fresh from RevenueCat (the source of truth, also for transfers).
   * Without it, the status comes from the event itself. Returns the uids it updated.
   */
  async function applyWebhook(body: unknown): Promise<string[]> {
    const ev = (body as { event?: Record<string, unknown> })?.event;
    if (!ev || typeof ev.type !== 'string' || ev.type === 'TEST') return [];
    const ent = entitlement();
    const ids = (x: unknown) => (Array.isArray(x) ? x : [x]).filter(usableUid);
    const owners = [...new Set([...ids(ev.app_user_id), ...ids(ev.original_app_user_id), ...ids(ev.aliases)])];
    const from = ev.type === 'TRANSFER' ? ids(ev.transferred_from) : [];
    const to = ev.type === 'TRANSFER' ? ids(ev.transferred_to) : [];
    const uids = [...new Set([...owners, ...from, ...to])];
    const eventAt = typeof ev.event_timestamp_ms === 'number' ? ev.event_timestamp_ms : deps.now().getTime();
    const entIds = [...(Array.isArray(ev.entitlement_ids) ? ev.entitlement_ids : []), ...(typeof ev.entitlement_id === 'string' ? [ev.entitlement_id] : [])];
    const updated: string[] = [];
    for (const uid of uids) {
      cache.delete(uid);
      let status: ProStatus | null = null;
      try { status = await fromApi(uid); status = { ...status, eventAt, event: ev.type, source: 'revenuecat_api' }; } catch { /* derive from the event */ }
      if (!status) {
        let active: boolean;
        if (from.includes(uid)) active = false;
        else if (!entIds.includes(ent)) continue; // an event about another entitlement says nothing about Pro
        else active = ev.type !== 'EXPIRATION';
        const exp = typeof ev.expiration_at_ms === 'number' ? new Date(ev.expiration_at_ms).toISOString() : null;
        status = { active, expiresAt: active ? exp : null, entitlement: ent, source: 'revenuecat_webhook', eventAt, event: ev.type, updatedAt: deps.now().toISOString() };
      }
      const prior = await deps.getStatus(uid).catch(() => null);
      // Webhooks can arrive out of order: an older event never overwrites a newer status.
      if (status.source === 'revenuecat_webhook' && prior?.eventAt !== undefined && prior.eventAt > eventAt) continue;
      await deps.saveStatus(uid, status);
      updated.push(uid);
    }
    return updated;
  }

  return { isPro, applyWebhook, entitlement, forget: (uid: string) => cache.delete(uid) };
}

const proDoc = (uid: string) => initFirestore().collection('users').doc(uid).collection('aim').doc('pro');
let real: ReturnType<typeof createPro> | null = null;
/** The production checker: process.env, global fetch, Firestore. */
export function pro() {
  real ??= createPro({
    env: process.env, fetch: (...a) => fetch(...a), now: () => new Date(),
    getStatus: async uid => { const s = await proDoc(uid).get(); return s.exists ? (s.data() as ProStatus) : null; },
    saveStatus: async (uid, s) => { await proDoc(uid).set(s); },
  });
  return real;
}

export async function isPro(uid: string): Promise<boolean> {
  return pro().isPro(uid);
}
