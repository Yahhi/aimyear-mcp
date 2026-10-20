/**
 * Posting the day's progress in public (docs/public-posting.md).
 *
 * - The user connects WIP and Bluesky once; credentials are sealed (crypto.ts) and never
 *   leave this file in any result.
 * - The draft is written from the day's record (draft.ts).
 * - AimYear posts only when the user explicitly asks (add_post, or the Post action of the
 *   evening offer). Never on its own.
 * - Before posting on a network it reads the user's own feed: a post from that local day
 *   that AimYear did not make means the user already posted there, so it skips it.
 * - One post per day and network: users/{uid}/posts/{date}_{network} is claimed in a
 *   transaction before the network call, so a retry or a second device posts nothing twice.
 * - All of it is Pro (pricing.md), checked at the one Pro check point (src/pro.ts).
 */
import type { Store } from '../store.js';
import { AimError, parseLocal, type AimService } from '../service.js';
import { addDays, isValidDate, localDate } from '../dates.js';
import { isPro } from '../pro.js';
import { open, seal, SealError } from './crypto.js';
import { APP_PASSWORD, BLUESKY_MAX, NetworkError, blueskyClient, graphemes, wipClient, type Connection, type NetworkClient } from './clients.js';
import { buildDraft, type DayFacts } from './draft.js';
import { NETWORKS, type Network, type PostRecord, type Profile, type SocialAccount } from '../types.js';

export interface SocialDeps {
  clients: Record<Network, NetworkClient>;
  isPro: (uid: string) => Promise<boolean>;
  now?: () => Date;
}
export const realSocialDeps = (): SocialDeps => ({ clients: { wip: wipClient(), bluesky: blueskyClient() }, isPro });

export const PRO_ONLY = 'Posting your progress to WIP and Bluesky is part of AimYear Pro. Get Pro on aimyear.com or in the app.';
/** A claim younger than this is another attempt still under way: wait for it rather than post again. */
const STALE_MS = 5 * 60000;
const NAME: Record<Network, string> = { wip: 'WIP', bluesky: 'Bluesky' };
export const offerId = (uid: string) => `post-offer-${uid}`;
const recordId = (date: string, n: Network) => `${date}_${n}`;

/** Only messages we wrote ourselves pass through: they never contain a credential. */
function safe(e: unknown): string {
  if (e instanceof NetworkError || e instanceof SealError || e instanceof AimError) return e.message;
  return 'Something went wrong on the way to the network.';
}

export type NetworkCheck =
  | { network: Network; status: 'ready' }
  | { network: Network; status: 'posted_by_aimyear'; url?: string }
  | { network: Network; status: 'you_posted' }
  | { network: Network; status: 'too_long'; graphemes: number; max: number }
  | { network: Network; status: 'error'; error: string };

export type PostResult =
  | { network: Network; status: 'posted'; url?: string }
  | { network: Network; status: 'already_posted'; url?: string }
  | { network: Network; status: 'skipped_you_posted' }
  | { network: Network; status: 'in_progress' }
  | { network: Network; status: 'too_long'; graphemes: number; max: number }
  | { network: Network; status: 'failed'; error: string };

export class SocialService {
  constructor(private store: Store, private aim: AimService, private deps: SocialDeps = realSocialDeps()) {}

  private now() { return this.deps.now?.() ?? new Date(); }
  private get uid() { return this.store.uid; }
  private async tz() { return (await this.store.getProfile()).timezone; }
  private async requirePro() { if (!(await this.deps.isPro(this.uid))) throw new AimError(PRO_ONLY); }

  private async dateArg(date: string | undefined, postOnly: boolean): Promise<string> {
    const today = localDate(this.now(), await this.tz());
    const d = date ?? today;
    if (!isValidDate(d)) throw new AimError(`date must be YYYY-MM-DD, got "${d}"`);
    if (d > today) throw new AimError(`${d} hasn't happened yet: there is no record to post from.`);
    if (postOnly && d < addDays(today, -1)) throw new AimError('AimYear posts about today or yesterday only.');
    return d;
  }

  private view(a: SocialAccount, prof: Profile, connected: Network[]) {
    return { network: a.network, handle: a.handle, connected_at: a.connectedAt, gets_posts: this.targets(prof, connected).includes(a.network) };
  }

  /** The networks a post goes to: the requested ones, else the app's choice, else every connected one. */
  private targets(prof: Profile, connected: Network[], requested?: Network[]): Network[] {
    const chosen = requested?.length ? requested : (prof.postTo ?? connected);
    return NETWORKS.filter(n => chosen.includes(n) && connected.includes(n));
  }

  private async openConn(acc: SocialAccount): Promise<Connection> {
    return this.deps.clients[acc.network].open(open(acc.secret, this.uid, acc.network));
  }

  // ---------- connections ----------
  async connect(input: { network: Network; api_key?: string; handle?: string; app_password?: string }) {
    await this.requirePro();
    const network = input.network;
    let secret: Record<string, string>;
    if (network === 'wip') {
      const k = input.api_key?.trim();
      if (!k) throw new AimError('WIP needs your API key (wip.co → your settings → API).');
      secret = { apiKey: k };
    } else {
      const id = input.handle?.trim().replace(/^@/, '');
      const pw = input.app_password?.trim().toLowerCase();
      if (!id || !pw) throw new AimError('Bluesky needs your handle and an app password.');
      if (!APP_PASSWORD.test(pw)) throw new AimError('That is not a Bluesky app password (it looks like xxxx-xxxx-xxxx-xxxx). Make one in Bluesky → Settings → Privacy and security → App passwords. Never give AimYear your account password.');
      secret = { identifier: id, appPassword: pw };
    }
    let sealed, conn;
    try {
      sealed = seal(secret, this.uid, network); // first, so nothing is checked without a way to store it safely
      conn = await this.deps.clients[network].open(secret);
    } catch (e) { throw new AimError(`${NAME[network]} not connected: ${safe(e)}`); }
    const acc: SocialAccount = { network, handle: conn.handle, connectedAt: this.now().toISOString(), secret: sealed };
    await this.store.saveSocialAccount(acc);
    const prof = await this.store.getProfile();
    // Connecting a network means wanting the posts there, unless the app already chose otherwise for it.
    if (prof.postTo && !prof.postTo.includes(network)) { prof.postTo = [...prof.postTo, network]; await this.store.saveProfile(prof); this.aim.forgetProfile(); }
    const connected = (await this.store.getSocialAccounts()).map(a => a.network);
    const offer = await this.armOffer();
    return {
      ok: true, account: this.view(acc, prof, connected), evening_offer: offer,
      speak: `${NAME[network]} connected as ${acc.handle}. AimYear posts there only when you say Post.${offer ? ` The day's draft will come at ${offer.local_time}, after your last focus window.` : ' Add focus windows with a start time (set_commitments) to get the draft each evening.'}`,
    };
  }

  async listAccounts() {
    const accounts = await this.store.getSocialAccounts();
    const prof = await this.store.getProfile();
    const connected = accounts.map(a => a.network);
    const pro = await this.deps.isPro(this.uid);
    return {
      accounts: accounts.map(a => this.view(a, prof, connected)), post_to: this.targets(prof, connected), pro,
      speak: accounts.length
        ? `Connected: ${accounts.map(a => `${NAME[a.network]} (${a.handle})`).join(', ')}. Posts go to: ${this.targets(prof, connected).map(n => NAME[n]).join(', ') || 'none'}.${pro ? '' : ` ${PRO_ONLY}`}`
        : `No network connected.${pro ? ' Connect WIP or Bluesky to post your progress.' : ` ${PRO_ONLY}`}`,
    };
  }

  /** Not Pro-gated: anyone can always remove their saved credentials. */
  async disconnect(network: Network) {
    await this.store.deleteSocialAccount(network);
    const prof = await this.store.getProfile();
    if (prof.postTo?.includes(network)) { prof.postTo = prof.postTo.filter(n => n !== network); await this.store.saveProfile(prof); this.aim.forgetProfile(); }
    if (!(await this.store.getSocialAccounts()).length) await this.store.removePending(offerId(this.uid));
    return { ok: true, network, speak: `${NAME[network]} disconnected; its saved login is deleted. Posts already made stay on ${NAME[network]}.` };
  }

  // ---------- the draft ----------
  /** The facts of the day for the draft, or why there is nothing honest to post. */
  async facts(date: string): Promise<DayFacts | { reason: string }> {
    const g = await this.aim.getGoal();
    if (!g.goal) return { reason: 'No aim set yet, so there is no progress to post.' };
    const s = await this.aim.daySummary(date);
    if (s.mode === 'off') return { reason: `Tracking was off on ${date}, so there is no record to post from.` };
    const levers = g.goal.levers;
    const isHard = (x: { classification: string; lever_id?: string }) =>
      x.classification === 'goal_hard' || (x.classification === 'main_step' && levers.find(l => l.id === x.lever_id)?.kind === 'hard');
    const hardMin = Math.round(s.sessions.filter(isHard).reduce((n, x) => n + x.attention_min, 0));
    const r = s.routines;
    const kind = (g as { kind?: 'count' | 'done' }).kind ?? 'count';
    const stages = (g as { stages?: { done: number; total: number } }).stages;
    return {
      aim: kind === 'done'
        ? { title: g.goal.title, kind, stagesDone: stages?.done, stagesTotal: stages?.total, reached: (g as { current_value?: number }).current_value! >= 1 }
        : { title: g.goal.title, kind, current: (g as { current_value?: number }).current_value, target: g.goal.target },
      mainStep: { planned: s.main_step.planned, done: s.main_step.done, title: s.main_step.title },
      goalMin: s.goal_attention_min, hardMin: Math.min(hardMin, s.goal_attention_min),
      routines: { full: r.full, minimum: r.minimum, missed: r.skipped + (r.total - r.done) },
      backAfterDays: s.main_step.done ? await this.backAfter(date) : undefined,
    };
  }

  /**
   * A comeback: the main step is done after missed working days. Days with tracking off,
   * and days without a focus window (when the week has windows), expected nothing.
   */
  private async backAfter(date: string): Promise<number | undefined> {
    const days = new Map((await this.store.getDaysInRange(addDays(date, -30), addDays(date, -1))).map(d => [d.date, d]));
    const hasWindows = (await this.store.getCommitments()).some(c => c.kind === 'window');
    let missed = 0;
    for (let i = 1; i <= 30; i++) {
      const x = addDays(date, -i);
      const d = days.get(x);
      if (d?.plan.some(p => p.isMainStep && p.done)) return missed || undefined;
      if (d?.mode === 'off') continue;
      if (hasWindows && (await this.aim.windowMinutesFor(x)) === 0) continue;
      missed++;
    }
    return undefined;
  }

  /**
   * What the user's own feed says about the day: did they post there themselves, and is
   * there a post of ours whose record never got its id (a crash or timeout after the
   * network took it)? That one is found by its text and adopted, not posted again.
   */
  private async seen(conn: Connection, n: Network, date: string, rec: PostRecord | null) {
    const tz = await this.tz();
    const ours = new Set<string>();
    for (const x of [addDays(date, -1), date, addDays(date, 1)]) {
      const r = await this.store.getPostRecord(recordId(x, n));
      if (r?.postId) ours.add(r.postId);
    }
    const sameDay = (await conn.recent()).filter(p => !ours.has(p.id) && p.createdAt && !Number.isNaN(Date.parse(p.createdAt)) && localDate(new Date(p.createdAt), tz) === date);
    const adopted = rec && rec.status !== 'posted'
      ? sameDay.find(p => p.text.trim() === rec.text.trim() && Date.parse(p.createdAt) >= Date.parse(rec.attemptAt) - 60000)
      : undefined;
    return { adopted, userPosted: sameDay.some(p => p.id !== adopted?.id) };
  }

  private async check(acc: SocialAccount, date: string, text: string): Promise<NetworkCheck> {
    const n = acc.network;
    const rec = await this.store.getPostRecord(recordId(date, n));
    if (rec?.status === 'posted') return { network: n, status: 'posted_by_aimyear', url: rec.url };
    try {
      const seen = await this.seen(await this.openConn(acc), n, date, rec);
      if (seen.adopted) return { network: n, status: 'posted_by_aimyear' };
      if (seen.userPosted) return { network: n, status: 'you_posted' };
    } catch (e) { return { network: n, status: 'error', error: safe(e) }; }
    if (n === 'bluesky' && graphemes(text) > BLUESKY_MAX) return { network: n, status: 'too_long', graphemes: graphemes(text), max: BLUESKY_MAX };
    return { network: n, status: 'ready' };
  }

  private async draftWithChecks(date: string) {
    const f = await this.facts(date);
    if ('reason' in f) return { text: null, reason: f.reason, networks: [] as NetworkCheck[] };
    const text = buildDraft(f);
    const accounts = await this.store.getSocialAccounts();
    const targets = this.targets(await this.store.getProfile(), accounts.map(a => a.network));
    const networks: NetworkCheck[] = [];
    for (const n of targets) networks.push(await this.check(accounts.find(a => a.network === n)!, date, text));
    return { text, reason: null, networks };
  }

  async draft(date?: string) {
    await this.requirePro();
    const d = await this.dateArg(date, false);
    const r = await this.draftWithChecks(d);
    if (!r.text) return { date: d, text: null, networks: [], speak: r.reason };
    const line = (c: NetworkCheck) => `${NAME[c.network]}: ${c.status === 'ready' ? 'ready' : c.status === 'posted_by_aimyear' ? 'already posted by AimYear' : c.status === 'you_posted' ? 'you already posted there today, so AimYear will not' : c.status === 'too_long' ? `too long (${c.graphemes}/${c.max})` : `can't check (${c.error})`}`;
    return {
      date: d, text: r.text, graphemes: graphemes(r.text), networks: r.networks,
      speak: `Draft for ${d}:\n${r.text}\n${r.networks.length ? r.networks.map(line).join('. ') + '.' : 'No network connected or chosen yet.'} Show it to the user; post only when they say so (add_post, with their edits).`,
    };
  }

  // ---------- posting ----------
  async post(input: { date?: string; text?: string; networks?: Network[] }) {
    await this.requirePro();
    const d = await this.dateArg(input.date, true);
    let text = input.text?.trim();
    if (!text) {
      const f = await this.facts(d);
      if ('reason' in f) throw new AimError(f.reason);
      text = buildDraft(f);
    }
    if (text.length > 4000) throw new AimError('The post is too long.');
    const accounts = await this.store.getSocialAccounts();
    const targets = this.targets(await this.store.getProfile(), accounts.map(a => a.network), input.networks);
    if (!targets.length) {
      return { ok: false, date: d, text, results: [] as PostResult[], speak: accounts.length ? 'None of the chosen networks is connected, so nothing was posted.' : 'No network connected yet, so nothing was posted. Connect WIP or Bluesky first (add_social_account).' };
    }
    const results: PostResult[] = [];
    for (const n of targets) results.push(await this.postOne(accounts.find(a => a.network === n)!, d, text));
    const line = (r: PostResult) => `${NAME[r.network]}: ${r.status === 'posted' ? `posted${r.url ? ` (${r.url})` : ''}`
      : r.status === 'already_posted' ? 'already posted for this day, not again'
        : r.status === 'skipped_you_posted' ? 'skipped, you already posted there today'
          : r.status === 'in_progress' ? 'another attempt is posting it right now'
            : r.status === 'too_long' ? `not posted, too long (${r.graphemes}/${r.max})` : `not posted (${r.error})`}`;
    return { ok: results.some(r => r.status === 'posted' || r.status === 'already_posted'), date: d, text, results, speak: `${results.map(line).join('. ')}.` };
  }

  private async postOne(acc: SocialAccount, date: string, text: string): Promise<PostResult> {
    const n = acc.network, id = recordId(date, n);
    const rec = await this.store.getPostRecord(id);
    if (rec?.status === 'posted') return { network: n, status: 'already_posted', url: rec.url };
    if (n === 'bluesky' && graphemes(text) > BLUESKY_MAX) return { network: n, status: 'too_long', graphemes: graphemes(text), max: BLUESKY_MAX };
    let conn: Connection, seen: Awaited<ReturnType<SocialService['seen']>>;
    try { conn = await this.openConn(acc); } catch (e) { return { network: n, status: 'failed', error: safe(e) }; }
    // No check, no post: without the user's feed AimYear can't know they didn't post already.
    try { seen = await this.seen(conn, n, date, rec); } catch (e) { return { network: n, status: 'failed', error: `couldn't check whether you already posted today: ${safe(e)}` }; }
    if (seen.adopted && rec) {
      await this.store.savePostRecord({ ...rec, status: 'posted', postId: seen.adopted.id, postedAt: seen.adopted.createdAt, error: undefined });
      return { network: n, status: 'already_posted' };
    }
    if (seen.userPosted) return { network: n, status: 'skipped_you_posted' };
    const claim: PostRecord = { id, date, network: n, status: 'posting', text, attemptAt: this.now().toISOString() };
    const c = await this.store.claimPost(claim, STALE_MS);
    if (!c.claimed) return c.existing.status === 'posted' ? { network: n, status: 'already_posted', url: c.existing.url } : { network: n, status: 'in_progress' };
    try {
      const p = await conn.post(text);
      await this.store.savePostRecord({ ...claim, status: 'posted', postId: p.id, url: p.url, postedAt: this.now().toISOString() });
      return { network: n, status: 'posted', url: p.url };
    } catch (e) {
      // It may still have landed (a timeout after the network took it): the record keeps
      // the text, and the next attempt finds that post in the feed instead of posting again.
      await this.store.savePostRecord({ ...claim, status: 'failed', error: safe(e) });
      return { network: n, status: 'failed', error: safe(e) };
    }
  }

  // ---------- the evening offer ----------
  /**
   * Queues the day's draft for the end of the working day: the end of the last focus
   * window (a window commitment with a start time) still ahead, today or on the next day
   * that has one. One pending doc per user, overwritten on each arm. Without a connected
   * network, or without timed windows, nothing is queued.
   */
  async armOffer(): Promise<{ date: string; due_at: string; local_time: string } | null> {
    if (!(await this.store.getSocialAccounts()).length) { await this.store.removePending(offerId(this.uid)); return null; }
    const tz = await this.tz();
    const windows = (await this.store.getCommitments()).filter(c => c.kind === 'window' && c.start && /^\d{1,2}:\d{2}$/.test(c.start));
    const now = this.now();
    const today = localDate(now, tz);
    for (let i = 0; i < 8; i++) {
      const date = addDays(today, i);
      const dow = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
      const ends = windows.filter(w => w.days.includes(dow)).map(w => parseLocal(date, w.start!, tz).getTime() + w.minutes * 60000);
      if (!ends.length) continue;
      const end = Math.max(...ends);
      if (end <= now.getTime() + 60000) continue;
      const dueAt = new Date(end).toISOString();
      // The window may run past midnight: the post is about the day it started.
      await this.store.savePending({ id: offerId(this.uid), uid: this.uid, blockId: '', kind: 'post_offer', date, dueAt, workplace: 'mobile', minutes: 0, breakMin: 0 });
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(end));
      return { date, due_at: dueAt, local_time: i === 0 ? local : `${local} on ${date}` };
    }
    await this.store.removePending(offerId(this.uid));
    return null;
  }

  /** The notification for the evening offer, or why none goes out. Never posts anything. */
  async eveningOffer(date: string): Promise<{ send: false; reason: string } | { send: true; title: string; body: string; data: Record<string, string> }> {
    if (!(await this.deps.isPro(this.uid))) return { send: false, reason: 'not Pro' };
    const r = await this.draftWithChecks(date);
    if (!r.text) return { send: false, reason: r.reason! };
    const ready = r.networks.filter(c => c.status === 'ready').map(c => c.network);
    if (!ready.length) return { send: false, reason: r.networks.length ? `nothing to offer: ${r.networks.map(c => `${c.network} ${c.status}`).join(', ')}` : 'no network chosen' };
    return {
      send: true, title: `Post today's progress to ${ready.map(n => NAME[n]).join(' and ')}?`, body: r.text,
      data: { kind: 'post_offer', action: 'post', date, networks: ready.join(','), text: r.text },
    };
  }
}
