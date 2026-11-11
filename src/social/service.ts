/**
 * Posting the day's progress in public (docs/public-posting.md).
 *
 * - The user connects WIP and Bluesky once; credentials are sealed (crypto.ts) and never
 *   leave this file in any result.
 * - The draft is written from the day's record (draft.ts): one post for Bluesky, and one
 *   WIP todo per project worked on, with that project's #hashtag.
 * - WIP connected from the app (no agent there): the user's WIP projects are matched to
 *   their AimYear projects and levers once (wip-match.ts).
 * - The day's post goes out only when the user explicitly asks (add_post, or the Post action
 *   of the evening offer). The one exception is work on a project the user marked public
 *   (Pro, WIP connected): a session that ends with a real summary, or a move, is queued as a
 *   WIP todo and posted 10 minutes later unless the user taps Cancel (or Edit, which posts
 *   their text at once). See "automatic WIP todos" below.
 * - Before posting on a network it reads the user's own feed: a post from that local day
 *   that AimYear did not make means the user already posted there, so it skips it.
 * - One post per day and network (and per project on WIP): users/{uid}/posts/{date}_{network}
 *   (WIP: {date}_wip_{key}) is claimed in a transaction before the network call, so a retry
 *   or a second device posts nothing twice.
 * - All of it is Pro (pricing.md), checked at the one Pro check point (src/pro.ts).
 */
import type { Store } from '../store.js';
import { AimError, ProRequiredError, parseLocal, type AimService } from '../service.js';
import { addDays, isValidDate, localDate, localTime } from '../dates.js';
import { isGoalWork } from '../domain/classify.js';
import { isPro } from '../pro.js';
import { open, seal, SealError } from './crypto.js';
import { APP_PASSWORD, BLUESKY_MAX, NetworkError, blueskyClient, graphemes, wipClient, type Connection, type FeedPost, type NetworkClient } from './clients.js';
import { buildDraft, buildWipTodos, nothingToPost, type DayFacts, type WipGroup, type WipTodo } from './draft.js';
import { claudeMatcherFromEnv, matchWipProjects, type MatchEntry, type ProjectMatcher } from './wip-match.js';
import { JOIN_MS, MAX_ATTEMPTS, RETRY_MS, UNDO_MS, isPlaceholder, isRealSummary, sameTask, todoBody, todoText } from './auto-rules.js';
import { newId } from '../store.js';
import { pushTo, type Multicast } from '../push.js';
import { NETWORKS, type AutoPost, type Goal, type Network, type PostRecord, type Profile, type SocialAccount } from '../types.js';

export interface SocialDeps {
  clients: Record<Network, NetworkClient>;
  isPro: (uid: string) => Promise<boolean>;
  now?: () => Date;
  /** The model step of the connect-time WIP matching; null or absent skips it. */
  matcher?: ProjectMatcher | null;
  /** FCM, for the push that comes with an automatic WIP todo; tests pass a fake. */
  multicast?: Multicast;
}
export const realSocialDeps = (): SocialDeps => ({ clients: { wip: wipClient(), bluesky: blueskyClient() }, isPro, matcher: claudeMatcherFromEnv() });

export const PRO_ONLY = 'Posting your progress to WIP and Bluesky is part of AimYear Pro. Get Pro on aimyear.com or in the app.';
/** A claim younger than this is another attempt still under way: wait for it rather than post again. */
const STALE_MS = 5 * 60000;
const NAME: Record<Network, string> = { wip: 'WIP', bluesky: 'Bluesky' };
export const offerId = (uid: string) => `post-offer-${uid}`;
/** A day with nothing recorded toward the aim has no post: the user records what they did first (docs/public-posting.md). */
export const nothingText = (date: string, today: string) => `Nothing recorded toward the aim ${date === today ? 'today' : `on ${date}`} yet, so there is no post to offer. Ask the user what they did toward the aim and record it first (add_move, or a session with a real summary), then draft again.`;
/** The record of one post: per day and network, and per todo key on WIP. */
const recordId = (date: string, n: Network, key?: string) => key ? `${date}_${n}_${key}` : `${date}_${n}`;
/** A todo key from outside (an edited draft) is kept to letters, digits, '-' and '_'. */
const cleanKey = (k: string | undefined, i: number) => (k ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60) || `todo${i + 1}`;
/** What goes out on one network: one text on Bluesky, one todo per project on WIP. */
interface Item { key?: string; label?: string; text: string }
const label = (t: WipTodo) => t.hashtag ? `#${t.hashtag}` : t.project ?? undefined;

/** An automatic todo that is not there (an old id, another account's). Routes answer 404. */
export class NotFoundError extends AimError { readonly code = 'not_found'; }
/** An automatic todo past the point of this change (already posted, or posting). Routes answer 409. */
export class ConflictError extends AimError { readonly code = 'conflict'; }
/** The pending doc that brings a queued automatic todo to /tick when its undo is over. */
export const autoPendingId = (uid: string, id: string) => `auto-post-${uid}-${id}`;
/** Its post record: one per automatic todo, like one per project for the day's WIP todos. */
const autoKey = (id: string) => `auto-${id}`;
/** States in which an automatic todo is (or is about to be) the project's todo for the day. */
const LIVE: AutoPost['state'][] = ['queued', 'posting', 'posted'];

/** What the tools and the app routes show of an automatic todo. */
export function autoPostView(a: AutoPost) {
  return {
    id: a.id, date: a.date, project_id: a.projectId, project: a.project, hashtag: a.hashtag, text: a.text, state: a.state,
    post_at: a.postAt, ended_at: a.endedAt, session_ids: a.sessionIds, move_ids: a.moveIds, text_by: a.textBy,
    url: a.url ?? null, posted_at: a.postedAt ?? null, error: a.error ?? null,
  };
}
export type AutoPostView = ReturnType<typeof autoPostView>;

/** What one session or move did about WIP once it ended (absent: nothing to do with WIP). */
export type AutoOutcome =
  | { status: 'queued' | 'joined' | 'already_posted' | 'offered'; auto_post: AutoPostView; speak: string }
  | { status: 'skipped'; reason: string; project: string | null; speak: string };

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

type PostOutcome =
  | { status: 'posted'; url?: string }
  | { status: 'already_posted'; url?: string }
  | { status: 'skipped_you_posted' }
  | { status: 'in_progress' }
  | { status: 'too_long'; graphemes: number; max: number }
  | { status: 'failed'; error: string };
/** key and label: which WIP todo (project) a result is about. */
export type PostResult = { network: Network; key?: string; label?: string } & PostOutcome;

export class SocialService {
  constructor(private store: Store, private aim: AimService, private deps: SocialDeps = realSocialDeps()) {}

  private now() { return this.deps.now?.() ?? new Date(); }
  private get uid() { return this.store.uid; }
  private async tz() { return (await this.store.getProfile()).timezone; }
  private async requirePro() { if (!(await this.deps.isPro(this.uid))) throw new ProRequiredError(PRO_ONLY); }

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
    // From the app no agent is there to attach the WIP hashtags, so AimYear matches them once.
    const tags = network === 'wip' && (await this.aim.callerAgent()) === 'app' ? await this.autoMatch(conn) : null;
    const tagText = tags === null ? '' : tags.length
      ? ` WIP projects attached: ${tags.map(t => `${t.name} → #${t.hashtag}`).join(', ')}. Each WIP todo about that work carries its hashtag; change one any time.`
      : ' No WIP project matched an AimYear project by itself; attach hashtags with your agent (set_projects).';
    return {
      ok: true, account: this.view(acc, prof, connected), evening_offer: offer, ...(tags !== null ? { wip_hashtags: tags } : {}),
      speak: `${NAME[network]} connected as ${acc.handle}. AimYear posts there only when you say Post.${offer ? ` The day's draft will come at ${offer.local_time}, after your last focus window.` : ' Add focus windows with a start time (set_commitments) to get the draft each evening.'}${tagText}`,
    };
  }

  /**
   * Connect-time matching (docs/public-posting.md, "Who attaches the hashtags"): the user's
   * WIP projects onto AimYear projects and levers that have no hashtag yet. A hashtag already
   * set, by the user or before, is never replaced. A failure attaches nothing.
   */
  private async autoMatch(conn: Connection): Promise<{ kind: 'project' | 'lever'; id: string; name: string; hashtag: string; by: 'name' | 'ai' }[]> {
    const goal = await this.store.getGoal();
    if (!goal || !conn.projects) return [];
    const has = new Set([...goal.projects, ...goal.levers].flatMap(x => x.wipHashtag ? [x.wipHashtag.toLowerCase()] : []));
    const entries: MatchEntry[] = [
      ...goal.projects.filter(p => !p.wipHashtag).map(p => ({ id: `project:${p.id}`, kind: 'project' as const, name: p.name, keywords: p.match.keywords, repos: p.match.repos })),
      ...goal.levers.filter(l => !l.wipHashtag).map(l => ({ id: `lever:${l.id}`, kind: 'lever' as const, name: l.name, keywords: l.match.keywords, repos: l.match.repos })),
    ];
    if (!entries.length) return [];
    let wip;
    try { wip = (await conn.projects()).filter(p => p.hashtag && !has.has(p.hashtag.toLowerCase())); } catch { return []; }
    const matches = await matchWipProjects(entries, wip, this.deps.matcher ?? null);
    if (!matches.length) return [];
    // Read again: the user may have set one meanwhile, and theirs wins.
    const fresh = await this.store.getGoal();
    if (!fresh) return [];
    const out: { kind: 'project' | 'lever'; id: string; name: string; hashtag: string; by: 'name' | 'ai' }[] = [];
    for (const m of matches) {
      const [kind, id] = [m.kind, m.id.slice(m.kind.length + 1)];
      const x = kind === 'project' ? fresh.projects.find(p => p.id === id) : fresh.levers.find(l => l.id === id);
      if (!x || x.wipHashtag) continue;
      x.wipHashtag = m.hashtag; x.wipHashtagBy = 'auto';
      out.push({ kind, id, name: x.name, hashtag: m.hashtag, by: m.by });
    }
    if (out.length) { fresh.updatedAt = this.now().toISOString(); await this.store.saveGoal(fresh); }
    return out;
  }

  /** The user's WIP projects, and which AimYear project or lever carries each hashtag. Reads WIP; posts nothing. */
  async listWipProjects() {
    await this.requirePro();
    const acc = (await this.store.getSocialAccounts()).find(a => a.network === 'wip');
    if (!acc) return { projects: [], speak: 'WIP is not connected yet: connect it first (add_social_account, network "wip").' };
    let list;
    try { list = await (await this.openConn(acc)).projects?.() ?? []; } catch (e) { throw new AimError(`Couldn't read your WIP projects: ${safe(e)}`); }
    const goal = await this.store.getGoal();
    const holders = [...(goal?.projects ?? []).map(p => ({ kind: 'project' as const, x: p })), ...(goal?.levers ?? []).map(l => ({ kind: 'lever' as const, x: l }))];
    const projects = list.filter(p => p.hashtag).map(p => ({
      hashtag: p.hashtag!, name: p.name, pitch: p.pitch ?? null, url: p.url ?? null, archived: !!p.archived,
      attached_to: holders.filter(h => h.x.wipHashtag?.toLowerCase() === p.hashtag!.toLowerCase()).map(h => ({ kind: h.kind, id: h.x.id, name: h.x.name, by: h.x.wipHashtagBy ?? 'user' })),
    }));
    const without = holders.filter(h => !h.x.wipHashtag).map(h => ({ kind: h.kind, id: h.x.id, name: h.x.name }));
    return {
      projects, aimyear_without_hashtag: without,
      speak: projects.length
        ? `Your WIP projects: ${projects.map(p => `#${p.hashtag} (${p.name})${p.attached_to.length ? ` on ${p.attached_to.map(a => a.name).join(', ')}` : ', not attached'}`).join('; ')}.${without.length ? ` AimYear projects and levers without a hashtag: ${without.map(w => w.name).join(', ')}. Attach the clear matches with set_projects / set_levers (wip_hashtag); ask the user when unsure. Levers that are a kind of work, not one product, stay without.` : ''}`
        : 'No WIP projects with a hashtag on this account.',
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
    // docs/metrics.md: the day summary's hard minutes, the same rule and rounding as everywhere.
    const hardMin = s.hard_attention_min;
    const r = s.routines;
    // What moved, in the user's words and in the order it happened: the summary of each
    // session toward the aim (else its task), and each move toward the aim.
    const tz = await this.tz();
    const at = new Map((await this.store.getMovesInRange(date, date)).map(m => [m.id, localTime(new Date(m.at), tz)]));
    const main = (await this.store.getDay(date))?.plan.find(p => p.isMainStep);
    const work = [
      ...s.sessions.filter(x => x.wall_min > 0).map(x => ({ at: x.from, text: x.summary?.trim() || x.task, aim: isGoalWork(x.classification), onMain: x.classification === 'main_step', projectId: x.project_id, leverId: x.lever_id })),
      ...s.moves.map(m => ({ at: at.get(m.id) ?? '', text: m.task, aim: m.toward_aim, onMain: m.classification === 'main_step' || (!!main && m.item_id === main.id), projectId: m.project_id ?? undefined, leverId: m.lever_id ?? undefined })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const done = work.filter(x => x.aim).map(x => x.text);
    // A project that already got its automatic WIP todo that day is left out of the WIP part.
    const autoDone = new Set((await this.store.getAutoPostsOn(date)).filter(a => LIVE.includes(a.state)).map(a => a.projectId));
    const notAuto = <T extends { projectId?: string }>(x: T) => !x.projectId || !autoDone.has(x.projectId);
    const mainWork = main?.done ? { text: main.title, aim: true, projectId: main.projectId, leverId: main.leverId } : null;
    const wip = wipGroups(g.goal, work.filter(notAuto), mainWork && notAuto(mainWork) ? mainWork : null);
    const wipLeftOut = g.goal.projects.filter(p => autoDone.has(p.id)).map(p => p.name);
    const kind = (g as { kind?: 'count' | 'done' }).kind ?? 'count';
    const stages = (g as { stages?: { done: number; total: number } }).stages;
    return {
      aim: kind === 'done'
        ? { title: g.goal.title, kind, stagesDone: stages?.done, stagesTotal: stages?.total, reached: (g as { current_value?: number }).current_value! >= 1 }
        : { title: g.goal.title, kind, current: (g as { current_value?: number }).current_value, target: g.goal.target },
      mainStep: { planned: s.main_step.planned, done: s.main_step.done, title: s.main_step.title }, done,
      goalMin: s.goal_attention_min, hardMin: Math.min(hardMin, s.goal_attention_min),
      routines: { full: r.full, minimum: r.minimum, missed: r.skipped + (r.total - r.done) },
      backAfterDays: s.main_step.done ? await this.backAfter(date) : undefined,
      moves: { aim: s.aim_moves, hard: s.hard_moves }, quiet: s.quiet_numbers,
      week: await this.aim.weekProgress(date).then(w => ({ days: w.days, target: w.target })), wip, wipLeftOut,
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
  private async seen(conn: Connection, n: Network, date: string, recs: PostRecord[]) {
    const tz = await this.tz();
    const ours = new Set<string>();
    // An automatic todo still on its way has no id yet: its text tells it apart from the user's own.
    const autoTexts = new Set<string>();
    for (const x of [addDays(date, -1), date, addDays(date, 1)]) {
      for (const r of await this.store.getPostRecordsOn(x)) {
        if (r.network === n && r.postId) ours.add(r.postId);
        else if (r.network === n && r.auto && !recs.some(q => q.id === r.id)) autoTexts.add(r.text.trim());
      }
    }
    const sameDay = (await conn.recent()).filter(p => !ours.has(p.id) && !autoTexts.has(p.text.trim()) && p.createdAt && !Number.isNaN(Date.parse(p.createdAt)) && localDate(new Date(p.createdAt), tz) === date);
    const adopted = new Map<string, FeedPost>();
    for (const rec of recs) {
      if (rec.status === 'posted') continue;
      const p = sameDay.find(p => ![...adopted.values()].includes(p) && p.text.trim() === rec.text.trim() && Date.parse(p.createdAt) >= Date.parse(rec.attemptAt) - 60000);
      if (p) adopted.set(rec.id, p);
    }
    const taken = new Set([...adopted.values()].map(p => p.id));
    return { adopted, userPosted: sameDay.some(p => !taken.has(p.id)) };
  }

  /**
   * WIP's day went out either as one text (the record without a key: an older app, or the
   * user's own text) or as todos per project. Whichever went first, the other form is not
   * posted on top of it.
   */
  private async otherFormPosted(n: Network, date: string, key: string | undefined) {
    if (n !== 'wip') return null;
    // Automatic todos are about one project's work, not the day: neither form.
    const recs = (await this.store.getPostRecordsOn(date)).filter(r => r.network === 'wip' && r.status === 'posted' && !r.auto);
    return recs.find(r => key ? r.id === recordId(date, 'wip') : r.id !== recordId(date, 'wip')) ?? null;
  }

  private async check(acc: SocialAccount, date: string, items: Item[]): Promise<NetworkCheck> {
    const n = acc.network;
    const recs = await Promise.all(items.map(i => this.store.getPostRecord(recordId(date, n, i.key))));
    if (recs.every(r => r?.status === 'posted')) return { network: n, status: 'posted_by_aimyear', url: recs[0]?.url };
    const other = await this.otherFormPosted(n, date, items[0]?.key);
    if (other) return { network: n, status: 'posted_by_aimyear', url: other.url };
    try {
      const seen = await this.seen(await this.openConn(acc), n, date, recs.filter((r): r is PostRecord => !!r));
      if (recs.every(r => r?.status === 'posted' || (r && seen.adopted.has(r.id)))) return { network: n, status: 'posted_by_aimyear' };
      if (seen.userPosted) return { network: n, status: 'you_posted' };
    } catch (e) { return { network: n, status: 'error', error: safe(e) }; }
    if (n === 'bluesky' && graphemes(items[0].text) > BLUESKY_MAX) return { network: n, status: 'too_long', graphemes: graphemes(items[0].text), max: BLUESKY_MAX };
    return { network: n, status: 'ready' };
  }

  /** The day's draft: the post for Bluesky and the WIP todos, or why there is none. */
  private async drafted(date: string): Promise<{ text: string; wip: WipTodo[]; wipLeftOut: string[] } | { reason: string; nothing: boolean }> {
    const f = await this.facts(date);
    if ('reason' in f) return { reason: f.reason, nothing: false };
    if (nothingToPost(f)) return { reason: nothingText(date, localDate(this.now(), await this.tz())), nothing: true };
    return { text: buildDraft(f), wip: buildWipTodos(f.wip ?? []), wipLeftOut: f.wipLeftOut ?? [] };
  }

  /** WIP gets the todos per project; when every project worked on already got its automatic todo, nothing. */
  private itemsFor(n: Network, d: { text: string; wip: WipTodo[]; wipLeftOut?: string[] }): Item[] {
    if (n !== 'wip') return [{ text: d.text }];
    return d.wip.length ? d.wip.map(t => ({ key: t.key, label: label(t), text: t.text })) : d.wipLeftOut?.length ? [] : [{ text: d.text }];
  }

  private async draftWithChecks(date: string) {
    const d = await this.drafted(date);
    if ('reason' in d) return { text: null, wip: [] as WipTodo[], wipLeftOut: [] as string[], reason: d.reason, nothing: d.nothing, networks: [] as NetworkCheck[] };
    const accounts = await this.store.getSocialAccounts();
    const targets = this.targets(await this.store.getProfile(), accounts.map(a => a.network));
    const networks: NetworkCheck[] = [];
    for (const n of targets) networks.push(await this.check(accounts.find(a => a.network === n)!, date, this.itemsFor(n, d)));
    return { text: d.text, wip: d.wip, wipLeftOut: d.wipLeftOut, reason: null, nothing: false, networks };
  }

  async draft(date?: string) {
    await this.requirePro();
    const d = await this.dateArg(date, false);
    const r = await this.draftWithChecks(d);
    if (!r.text) return { date: d, text: null, wip_todos: [], nothing_to_post: r.nothing, networks: [], speak: r.reason };
    const line = (c: NetworkCheck) => `${NAME[c.network]}: ${c.status === 'ready' ? 'ready' : c.status === 'posted_by_aimyear' ? 'already posted by AimYear' : c.status === 'you_posted' ? 'you already posted there today, so AimYear will not' : c.status === 'too_long' ? `too long (${c.graphemes}/${c.max})` : `can't check (${c.error})`}`;
    const wipText = (r.wip.length ? `\nWIP todos, one per project:\n${r.wip.map(t => `- ${t.text}`).join('\n')}` : '')
      + (r.wipLeftOut.length ? `\nLeft out of WIP: ${r.wipLeftOut.join(', ')}, already posted there automatically today.` : '');
    return {
      date: d, text: r.text, wip_todos: r.wip, wip_left_out: r.wipLeftOut, nothing_to_post: false, graphemes: graphemes(r.text), networks: r.networks,
      speak: `Draft for ${d}:\n${r.text}${wipText}\n${r.networks.length ? r.networks.map(line).join('. ') + '.' : 'No network connected or chosen yet.'} Show it to the user; post only when they say so (add_post, with their edits: text for Bluesky, wip_todos for WIP).`,
    };
  }

  // ---------- posting ----------
  /**
   * Posts what the user approved. text is the day's post (Bluesky); wip_todos the WIP todos,
   * one per project. Without wip_todos, WIP gets text as one todo when given (what the
   * user wrote), else the draft's todos. Nothing the user did not write or see is invented:
   * a day with nothing recorded toward the aim has no default text.
   */
  async post(input: { date?: string; text?: string; networks?: Network[]; wip_todos?: { key?: string; text: string }[] }) {
    await this.requirePro();
    const d = await this.dateArg(input.date, true);
    const text = input.text?.trim() || undefined;
    const todos: Item[] = (input.wip_todos ?? []).map((t, i) => {
      const body = String(t.text ?? '').trim(), tag = body.match(/#[A-Za-z0-9_]+(?=\W*$)/)?.[0];
      return { key: cleanKey(t.key, i), text: body, ...(tag ? { label: tag } : {}) };
    }).filter(t => t.text);
    for (const t of [text ?? '', ...todos.map(x => x.text)]) if (t.length > 4000) throw new AimError('The post is too long.');
    const accounts = await this.store.getSocialAccounts();
    const targets = this.targets(await this.store.getProfile(), accounts.map(a => a.network), input.networks);
    if (!targets.length) {
      return { ok: false, date: d, text: text ?? null, results: [] as PostResult[], speak: accounts.length ? 'None of the chosen networks is connected, so nothing was posted.' : 'No network connected yet, so nothing was posted. Connect WIP or Bluesky first (add_social_account).' };
    }
    // The draft only when something has no text from the user.
    const made: { draft?: { text: string; wip: WipTodo[] } } = {};
    const theDraft = async () => {
      if (made.draft) return made.draft;
      const r = await this.drafted(d);
      if ('reason' in r) throw new AimError(r.reason);
      return (made.draft = r);
    };
    const results: PostResult[] = [];
    for (const n of targets) {
      const items: Item[] = n === 'wip'
        ? todos.length ? todos : text ? [{ text }] : this.itemsFor('wip', await theDraft())
        : [{ text: text ?? (await theDraft()).text }];
      results.push(...await this.postNetwork(accounts.find(a => a.network === n)!, d, items));
    }
    const line = (r: PostResult) => `${NAME[r.network]}${r.label ? ` (${r.label})` : ''}: ${r.status === 'posted' ? `posted${r.url ? ` (${r.url})` : ''}`
      : r.status === 'already_posted' ? 'already posted for this day, not again'
        : r.status === 'skipped_you_posted' ? 'skipped, you already posted there today'
          : r.status === 'in_progress' ? 'another attempt is posting it right now'
            : r.status === 'too_long' ? `not posted, too long (${r.graphemes}/${r.max})` : `not posted (${r.error})`}`;
    return { ok: results.some(r => r.status === 'posted' || r.status === 'already_posted'), date: d, text: text ?? made.draft?.text ?? null, results, speak: `${results.map(line).join('. ')}.` };
  }

  /** One network's posts for the day: one sign-in, then each item once. */
  private async postNetwork(acc: SocialAccount, date: string, items: Item[]): Promise<PostResult[]> {
    const n = acc.network;
    let conn: Connection;
    try { conn = await this.openConn(acc); } catch (e) { return items.map(i => ({ network: n, key: i.key, label: i.label, status: 'failed' as const, error: safe(e) })); }
    const out: PostResult[] = [];
    for (const i of items) out.push({ network: n, ...(i.key ? { key: i.key } : {}), ...(i.label ? { label: i.label } : {}), ...await this.postOne(conn, n, date, i) } as PostResult);
    return out;
  }

  private async postOne(conn: Connection, n: Network, date: string, item: Item): Promise<PostOutcome> {
    // The Post button of a short summary's offer: that automatic todo, with the text as shown.
    if (n === 'wip' && item.key?.startsWith('auto-')) {
      const r = await this.sendAuto(item.key.slice(5), { text: item.text, by: 'user', from: ['offered', 'queued', 'failed', 'cancelled', 'skipped'], conn });
      return r.status === 'posted' ? { status: 'posted', url: r.auto_post.url ?? undefined }
        : r.status === 'already_posted' ? { status: 'already_posted', url: r.auto_post?.url ?? undefined }
          : r.status === 'busy' ? { status: 'in_progress' } : r.status === 'skipped' ? { status: 'skipped_you_posted' } : { status: 'failed', error: r.error };
    }
    const id = recordId(date, n, item.key), text = item.text;
    const rec = await this.store.getPostRecord(id);
    if (rec?.status === 'posted') return { status: 'already_posted', url: rec.url };
    const other = await this.otherFormPosted(n, date, item.key);
    if (other) return { status: 'already_posted', url: other.url };
    if (n === 'bluesky' && graphemes(text) > BLUESKY_MAX) return { status: 'too_long', graphemes: graphemes(text), max: BLUESKY_MAX };
    let seen: Awaited<ReturnType<SocialService['seen']>>;
    // No check, no post: without the user's feed AimYear can't know they didn't post already.
    try { seen = await this.seen(conn, n, date, rec ? [rec] : []); } catch (e) { return { status: 'failed', error: `couldn't check whether you already posted today: ${safe(e)}` }; }
    const adopted = rec ? seen.adopted.get(rec.id) : undefined;
    if (adopted && rec) {
      await this.store.savePostRecord({ ...rec, status: 'posted', postId: adopted.id, postedAt: adopted.createdAt, error: undefined });
      return { status: 'already_posted' };
    }
    if (seen.userPosted) return { status: 'skipped_you_posted' };
    const claim: PostRecord = { id, date, network: n, status: 'posting', text, attemptAt: this.now().toISOString() };
    const c = await this.store.claimPost(claim, STALE_MS);
    if (!c.claimed) return c.existing.status === 'posted' ? { status: 'already_posted', url: c.existing.url } : { status: 'in_progress' };
    try {
      const p = await conn.post(text);
      await this.store.savePostRecord({ ...claim, status: 'posted', postId: p.id, url: p.url, postedAt: this.now().toISOString() });
      return { status: 'posted', url: p.url };
    } catch (e) {
      // It may still have landed (a timeout after the network took it): the record keeps
      // the text, and the next attempt finds that post in the feed instead of posting again.
      await this.store.savePostRecord({ ...claim, status: 'failed', error: safe(e) });
      return { status: 'failed', error: safe(e) };
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

  /**
   * The notification for the evening offer, or why none goes out. Never posts anything.
   * data.text is the day's post (Bluesky), data.wip_todos the WIP todos as JSON
   * [{key, text}], both as shown, so the Post action posts exactly that.
   */
  async eveningOffer(date: string): Promise<{ send: false; reason: string } | { send: true; title: string; body: string; data: Record<string, string> }> {
    if (!(await this.deps.isPro(this.uid))) return { send: false, reason: 'not Pro' };
    const r = await this.draftWithChecks(date);
    // A day with nothing recorded toward the aim gets no offer at all.
    if (!r.text) return { send: false, reason: r.nothing ? 'nothing recorded toward the aim' : r.reason! };
    const ready = r.networks.filter(c => c.status === 'ready').map(c => c.network);
    if (!ready.length) return { send: false, reason: r.networks.length ? `nothing to offer: ${r.networks.map(c => `${c.network} ${c.status}`).join(', ')}` : 'no network chosen' };
    const wip = ready.includes('wip') ? r.wip.map(t => ({ key: t.key, text: t.text })) : [];
    const body = ready.includes('bluesky') || !wip.length ? r.text : wip.map(t => t.text).join('\n');
    return {
      send: true, title: `Post today's progress to ${ready.map(n => NAME[n]).join(' and ')}?`, body,
      data: { kind: 'post_offer', action: 'post', date, networks: ready.join(','), text: r.text, ...(wip.length ? { wip_todos: JSON.stringify(wip) } : {}) },
    };
  }
  // ---------- automatic WIP todos (docs/public-posting.md, "Work posts to WIP, automatic with undo") ----------
  /**
   * After sessions ended or a move was recorded: work on a project the user marked public
   * becomes a WIP todo (Pro, WIP connected). It never throws: the stop or the move stands
   * whatever happens here. Work on other projects gives no outcome at all.
   *
   *  - A real summary (auto-rules.ts isRealSummary), or the agent's wip_text: queued, posted
   *    UNDO_MS after the work ended (and never sooner than UNDO_MS from now), with a push to
   *    every device carrying Cancel and Edit.
   *  - A short one: the push offers the todo with a Post button instead (the evening offer's
   *    mechanism, for this one project). A summary the server wrote ("Closed when the timer
   *    stopped.") offers nothing: that work waits for the evening draft.
   *  - Joining: work on the same project and task (auto-rules.ts sameTask) that started within
   *    JOIN_MS of a todo's last work joins it. A queued todo takes the new text and moves its
   *    post_at to the new end + 10 minutes, with a fresh push, so the undo always covers the
   *    text that will go out. A posted one posts nothing new. Either way the session or move
   *    is recorded on it: one piece of work is in at most one todo.
   */
  async afterWork(input: { sessions?: string[]; moves?: string[]; wipText?: string }): Promise<AutoOutcome[]> {
    const out: AutoOutcome[] = [];
    for (const [kind, ids] of [['session', input.sessions ?? []], ['move', input.moves ?? []]] as const) {
      for (const id of ids) {
        try { const r = await this.autoOne(kind, id, input.wipText); if (r) out.push(r); }
        catch (e) { console.error('[auto-post] failed', kind, (e as Error).message); }
      }
    }
    return out;
  }

  private async autoOne(kind: 'session' | 'move', id: string, wipText?: string): Promise<AutoOutcome | null> {
    const goal = await this.store.getGoal();
    let work: { task: string; text: string; start: string; end: string; projectId?: string; itemId?: string; stepId?: string; real: boolean; quiet: boolean };
    if (kind === 'session') {
      const s = await this.store.getSession(id);
      if (!s?.end) return null;
      const summary = s.summary?.trim() ?? '';
      work = { task: s.task, text: summary || s.task, start: s.start, end: s.end, projectId: s.projectId, itemId: s.itemId, stepId: s.stepId, real: isRealSummary(summary, s.task), quiet: isPlaceholder(summary) };
    } else {
      const m = await this.store.getMove(id);
      if (!m) return null;
      work = { task: m.task, text: m.task, start: m.at, end: m.at, projectId: m.projectId, itemId: m.itemId, stepId: m.stepId, real: isRealSummary(m.task, ''), quiet: false };
    }
    const agentText = wipText?.trim() || undefined;
    const project = goal?.projects.find(p => p.id === work.projectId);
    const skip = (reason: string): AutoOutcome => ({ status: 'skipped', reason, project: project?.name ?? null, speak: agentText ? `wip_text not used: ${reason}.` : '' });
    if (!project?.public) return agentText ? skip(project ? `${project.name} is not marked public` : 'this work is on no AimYear project marked public') : null;
    // A summary the server wrote says nothing: that work waits for the evening draft.
    if (!agentText && work.quiet) return null;
    if (await this.store.findAutoPostFor(kind, id)) return null;
    if (!(await this.deps.isPro(this.uid))) return skip('automatic WIP posts are part of AimYear Pro');
    if (!(await this.store.getSocialAccount('wip'))) return skip('WIP is not connected');
    const tz = await this.tz();
    const now = this.now();
    const date = localDate(new Date(work.end), tz);
    if (date < addDays(localDate(now, tz), -1)) return skip('the work is older than yesterday');
    const piece = agentText ?? (work.real ? work.text : null);
    const by: AutoPost['textBy'] = agentText ? 'agent' : 'summary';

    // Joining a todo of the same project and task, today or yesterday.
    const near = [...await this.store.getAutoPostsOn(date), ...(await this.store.getAutoPostsOn(addDays(date, -1)))]
      .filter(a => a.projectId === project.id && a.state !== 'cancelled' && a.state !== 'failed' && (piece ? a.state !== 'offered' : true)
        && sameTask(a, work) && Date.parse(work.start) - Date.parse(a.endedAt) <= JOIN_MS)
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    if (near[0]) return this.join(near[0], kind, id, work.end, piece, by, tz);

    const postAt = new Date(Math.max(Date.parse(work.end), now.getTime()) + UNDO_MS).toISOString();
    const a: AutoPost = {
      id: newId(), date, projectId: project.id, project: project.name, hashtag: project.wipHashtag ?? null,
      text: todoText([piece ?? work.text], project.wipHashtag ?? null), task: work.task, ...(work.itemId ? { itemId: work.itemId } : {}), ...(work.stepId ? { stepId: work.stepId } : {}),
      sessionIds: kind === 'session' ? [id] : [], moveIds: kind === 'move' ? [id] : [], endedAt: work.end, postAt,
      state: piece ? 'queued' : 'offered', textBy: by, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.store.saveAutoPost(a);
    if (a.state === 'queued') {
      await this.armAuto(a);
      await this.pushAuto(a);
      return { status: 'queued', auto_post: autoPostView(a), speak: this.queuedText(a, tz) };
    }
    await this.pushOffer(a);
    return { status: 'offered', auto_post: autoPostView(a), speak: `The summary is short, so it doesn't go to WIP by itself: the phone offers "${a.text}" with a Post button. If the user wants it posted, edit_auto_post (id ${a.id}) with their text posts it now.` };
  }

  private async join(target: AutoPost, kind: 'session' | 'move', id: string, end: string, piece: string | null, by: AutoPost['textBy'], tz: string): Promise<AutoOutcome> {
    const now = this.now();
    const add = (a: AutoPost) => { if (kind === 'session') a.sessionIds = [...new Set([...a.sessionIds, id])]; else a.moveIds = [...new Set([...a.moveIds, id])]; };
    const r = await this.store.updateAutoPost(target.id, cur => {
      add(cur);
      if (end > cur.endedAt) cur.endedAt = end;
      if (cur.state === 'queued' && piece) {
        cur.text = todoText([todoBody(cur.text, cur.hashtag), piece], cur.hashtag);
        cur.postAt = new Date(Math.max(Date.parse(cur.endedAt), now.getTime()) + UNDO_MS).toISOString();
        if (cur.textBy === 'summary' && by === 'agent') cur.textBy = 'agent';
      }
      cur.updatedAt = now.toISOString();
      return cur;
    });
    const a = r.current!;
    if (a.state === 'queued' && piece) {
      await this.armAuto(a);
      await this.pushAuto(a);
      return { status: 'joined', auto_post: autoPostView(a), speak: `Added to the ${a.project} todo waiting for WIP: "${a.text}". It now posts at ${localTime(new Date(a.postAt), tz)} unless cancelled.` };
    }
    if (a.state === 'posted' || a.state === 'posting') return { status: 'already_posted', auto_post: autoPostView(a), speak: `Part of the ${a.project} todo already on WIP${a.url ? ` (${a.url})` : ''}; nothing new is posted.` };
    return { status: 'joined', auto_post: autoPostView(a), speak: a.state === 'queued' ? `Counted in the ${a.project} todo waiting for WIP (posts at ${localTime(new Date(a.postAt), tz)}).` : `Counted with the ${a.project} todo offered on the phone.` };
  }

  private queuedText(a: AutoPost, tz: string) {
    return `This goes to WIP as a todo on ${a.project} at ${localTime(new Date(a.postAt), tz)}: "${a.text}". To stop it: Cancel on the notification, or delete_auto_post (id ${a.id}); to change the words: Edit on the notification, or edit_auto_post, which posts the new text at once.`;
  }

  /** The tick picks a queued todo up at post_at. One pending doc per todo: re-arming moves it. */
  private async armAuto(a: AutoPost) {
    await this.store.savePending({ id: autoPendingId(this.uid, a.id), uid: this.uid, blockId: '', kind: 'auto_post', autoPostId: a.id, date: a.date, dueAt: a.postAt, workplace: 'mobile', minutes: 0, breakMin: 0 });
  }

  /** One push to every device; dead tokens are dropped. A push that fails never stops the todo. */
  private async pushAll(message: Parameters<typeof pushTo>[1]) {
    try { return await pushTo(await this.store.getDevices(), message, t => this.store.removeDevice(t), this.deps.multicast); }
    catch (e) { console.error('[auto-post] push failed', (e as Error).message); return { sent: 0, failed: 0, reason: 'push failed' }; }
  }

  /**
   * The undo (docs/public-posting.md): every device, category AIMYEAR_AUTO_POST with Cancel
   * (POST /social/auto-posts/:id/cancel) and Edit (open the text; saving it is POST
   * /social/auto-posts/:id/edit, which posts at once). A join pushes again under the same
   * collapse id, so the phone shows the newest text once.
   */
  private async pushAuto(a: AutoPost) {
    const tz = await this.tz();
    return this.pushAll({
      notification: { title: `To WIP at ${localTime(new Date(a.postAt), tz)}: ${a.project}`, body: a.text },
      data: { kind: 'auto_post', id: a.id, text: a.text, post_at: a.postAt, project: a.project, project_id: a.projectId, hashtag: a.hashtag ?? '', date: a.date },
      apns: { headers: { 'apns-collapse-id': autoKey(a.id) }, payload: { aps: { sound: 'default', category: 'AIMYEAR_AUTO_POST', 'interruption-level': 'active', 'thread-id': 'aimyear-auto-post' } } },
      android: { priority: 'normal', collapseKey: autoKey(a.id), notification: { channelId: 'aimyear_posts', clickAction: 'AIMYEAR_AUTO_POST', tag: autoKey(a.id) } },
    });
  }

  /**
   * A short summary: the evening offer's push (category AIMYEAR_POST_OFFER, data.action post),
   * for this one todo. Its Post action sends data.date, data.networks and data.wip_todos to
   * POST /social/post as for the evening offer; the key auto-<id> posts this todo.
   */
  private async pushOffer(a: AutoPost) {
    return this.pushAll({
      notification: { title: `Post to WIP? ${a.project}`, body: a.text },
      data: { kind: 'post_offer', action: 'post', date: a.date, networks: 'wip', text: a.text, wip_todos: JSON.stringify([{ key: autoKey(a.id), text: a.text }]), auto_post_id: a.id, project: a.project },
      apns: { headers: { 'apns-collapse-id': autoKey(a.id) }, payload: { aps: { sound: 'default', category: 'AIMYEAR_POST_OFFER', 'interruption-level': 'active' } } },
      android: { priority: 'normal', collapseKey: autoKey(a.id), notification: { channelId: 'aimyear_posts', clickAction: 'AIMYEAR_POST_OFFER', tag: autoKey(a.id) } },
    });
  }

  /**
   * Sends one automatic todo, once. The todo is claimed first (its state moves to posting
   * in a transaction, from one of `from`), then its post record (auto-<id>) as for any WIP
   * todo, so neither two ticks nor a tick and an Edit post it twice. A record left by an
   * attempt whose answer was lost is found in the user's feed and adopted, not posted again.
   * "No double posts" holds here too: a WIP todo the user wrote on the site that day
   * (not AimYear's own, automatic or not) means AimYear does not post there: skipped.
   */
  private async sendAuto(id: string, opts: { text?: string; by?: 'user'; from: AutoPost['state'][]; conn?: Connection; retry?: boolean }):
    Promise<{ status: 'posted'; auto_post: AutoPostView } | { status: 'already_posted' | 'busy' | 'not_sendable' | 'skipped'; auto_post: AutoPostView | null; error: string } | { status: 'failed'; auto_post: AutoPostView | null; error: string }> {
    const now = this.now();
    const claimed = await this.store.updateAutoPost(id, cur => opts.from.includes(cur.state)
      ? { ...cur, state: 'posting', ...(opts.text !== undefined ? { text: opts.text, textBy: opts.by ?? cur.textBy } : {}), attempts: (cur.attempts ?? 0) + 1, updatedAt: now.toISOString() } : null);
    const cur = claimed.current;
    if (!cur) throw new NotFoundError(`No automatic WIP todo "${id}"; list_auto_posts shows the day's.`);
    if (!claimed.applied) {
      const v = autoPostView(cur);
      return cur.state === 'posted' ? { status: 'already_posted', auto_post: v, error: `already posted${cur.url ? ` (${cur.url})` : ''}` }
        : cur.state === 'posting' ? { status: 'busy', auto_post: v, error: 'it is being posted right now' }
          : { status: 'not_sendable', auto_post: v, error: `it is ${cur.state}` };
    }
    const settle = async (patch: Partial<AutoPost>) => (await this.store.updateAutoPost(id, a => ({ ...a, ...patch, updatedAt: this.now().toISOString() }))).current!;
    const fail = async (error: string) => {
      // A tick tries again a few times; an Edit says so and the user may tap again.
      if (opts.retry && (cur.attempts ?? 1) < MAX_ATTEMPTS) {
        const a = await settle({ state: 'queued', error, postAt: new Date(this.now().getTime() + RETRY_MS).toISOString() });
        await this.armAuto(a);
        return { status: 'failed' as const, auto_post: autoPostView(a), error };
      }
      return { status: 'failed' as const, auto_post: autoPostView(await settle({ state: 'failed', error })), error };
    };
    const acc = await this.store.getSocialAccount('wip');
    if (!acc) return fail('WIP is not connected');
    let conn: Connection;
    try { conn = opts.conn ?? await this.openConn(acc); } catch (e) { return fail(safe(e)); }
    const rid = recordId(cur.date, 'wip', autoKey(id));
    const posted = async (rec: { postId?: string; url?: string; postedAt?: string }) =>
      ({ status: 'posted' as const, auto_post: autoPostView(await settle({ state: 'posted', postId: rec.postId, url: rec.url, postedAt: rec.postedAt ?? this.now().toISOString(), error: undefined })) });
    const prior = await this.store.getPostRecord(rid);
    if (prior?.status === 'posted') return posted(prior);
    // No check, no post: without the user's feed AimYear can't know they didn't post already.
    let seen: Awaited<ReturnType<SocialService['seen']>>;
    try { seen = await this.seen(conn, 'wip', cur.date, prior ? [prior] : []); } catch (e) { return fail(`couldn't check whether you already posted today: ${safe(e)}`); }
    const adopted = prior ? seen.adopted.get(prior.id) : undefined;
    if (adopted && prior) { await this.store.savePostRecord({ ...prior, status: 'posted', postId: adopted.id, postedAt: adopted.createdAt, error: undefined }); return posted({ postId: adopted.id, postedAt: adopted.createdAt }); }
    if (seen.userPosted) {
      const why = 'you already posted on WIP that day yourself, so AimYear did not';
      await this.store.removePending(autoPendingId(this.uid, id));
      return { status: 'skipped' as const, auto_post: autoPostView(await settle({ state: 'skipped', error: why })), error: why };
    }
    const claim: PostRecord = { id: rid, date: cur.date, network: 'wip', status: 'posting', text: cur.text, attemptAt: this.now().toISOString(), auto: true, projectId: cur.projectId };
    const c = await this.store.claimPost(claim, STALE_MS);
    if (!c.claimed) return c.existing.status === 'posted' ? posted(c.existing) : fail('another attempt is posting it');
    try {
      const p = await conn.post(cur.text);
      const done = { ...claim, status: 'posted' as const, postId: p.id, url: p.url, postedAt: this.now().toISOString() };
      await this.store.savePostRecord(done);
      await this.store.removePending(autoPendingId(this.uid, id));
      return posted(done);
    } catch (e) {
      await this.store.savePostRecord({ ...claim, status: 'failed', error: safe(e) });
      return fail(safe(e));
    }
  }

  /** /tick: a queued todo whose undo is over. Never throws for a todo that is gone or changed. */
  async sendAutoPost(id: string, now = this.now()): Promise<{ sent: number; failed: number; reason?: string }> {
    const a = await this.store.getAutoPost(id);
    if (!a) return { sent: 0, failed: 0, reason: 'gone' };
    if (a.state !== 'queued') return { sent: 0, failed: 0, reason: a.state };
    // A join moved post_at while this pending doc was on its way: wait for the new time.
    if (Date.parse(a.postAt) > now.getTime() + 30000) { await this.armAuto(a); return { sent: 0, failed: 0, reason: `moved to ${a.postAt}` }; }
    if (!(await this.deps.isPro(this.uid))) {
      await this.store.updateAutoPost(id, x => x.state === 'queued' ? { ...x, state: 'failed', error: 'not Pro', updatedAt: now.toISOString() } : null);
      return { sent: 0, failed: 0, reason: 'not Pro' };
    }
    const r = await this.sendAuto(id, { from: ['queued'], retry: true });
    return r.status === 'posted' ? { sent: 1, failed: 0 } : { sent: 0, failed: r.status === 'failed' ? 1 : 0, reason: r.error };
  }

  /** The automatic todos of a day (default today): queued, posted, cancelled, offered or failed. Not Pro-gated: it only reads. */
  async listAutoPosts(date?: string) {
    const d = await this.dateArg(date, false);
    const tz = await this.tz();
    const list = (await this.store.getAutoPostsOn(d)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(autoPostView);
    const line = (a: AutoPostView) => `[${a.id}] ${a.project}: "${a.text}" — ${a.state === 'queued' ? `posts at ${localTime(new Date(a.post_at), tz)}` : a.state === 'posted' ? `posted${a.url ? ` (${a.url})` : ''}` : a.state === 'offered' ? 'offered with a Post button, not posted' : a.state === 'failed' ? `failed (${a.error})` : a.state === 'skipped' ? `not posted: ${a.error}` : a.state}`;
    return { date: d, auto_posts: list, speak: list.length ? `Automatic WIP todos for ${d}: ${list.map(line).join('; ')}.` : `No automatic WIP todos for ${d}. They come from sessions and moves on projects marked public (set_projects public).` };
  }

  /** Cancel: the todo does not go out. Never Pro-gated, like disconnecting: stopping a post is always possible. */
  async cancelAutoPost(id: string) {
    const now = this.now().toISOString();
    const r = await this.store.updateAutoPost(id, a => ['queued', 'offered', 'failed', 'skipped'].includes(a.state) ? { ...a, state: 'cancelled', cancelledAt: now, updatedAt: now } : null);
    if (!r.current) throw new NotFoundError(`No automatic WIP todo "${id}"; list_auto_posts shows the day's.`);
    const a = r.current;
    if (a.state === 'posted' || a.state === 'posting') throw new ConflictError(`Too late to cancel: the ${a.project} todo is ${a.state === 'posted' ? `already on WIP${a.url ? ` (${a.url})` : ''}; delete it there` : 'being posted right now'}.`);
    await this.store.removePending(autoPendingId(this.uid, id));
    return { ok: true, auto_post: autoPostView(a), speak: `Cancelled: the ${a.project} todo "${a.text}" will not go to WIP.` };
  }

  /** Edit: the user's own words for the todo, posted at once (also an offered, failed or cancelled one, on their say). Pro. */
  async editAutoPost(id: string, text: string) {
    await this.requirePro();
    const t = String(text ?? '').trim();
    if (!t) throw new AimError('The todo needs some text.');
    if (t.length > 4000) throw new AimError('The todo is too long.');
    const r = await this.sendAuto(id, { text: t, by: 'user', from: ['queued', 'offered', 'failed', 'cancelled', 'skipped'] });
    await this.store.removePending(autoPendingId(this.uid, id));
    if (r.status === 'posted') return { ok: true, auto_post: r.auto_post, speak: `Posted to WIP: "${r.auto_post.text}"${r.auto_post.url ? ` (${r.auto_post.url})` : ''}.` };
    if (r.status === 'already_posted' || r.status === 'busy') throw new ConflictError(`Not changed: the ${r.auto_post?.project} todo is ${r.error}.`);
    if (r.status === 'not_sendable') throw new ConflictError(`Not posted: ${r.error}.`);
    if (r.status === 'skipped') return { ok: false, auto_post: r.auto_post, error: r.error, speak: `Not posted: ${r.error}.` };
    return { ok: false, auto_post: r.auto_post, error: r.error, speak: `Not posted: ${r.error}. Editing again tries again; it never posts twice.` };
  }
}

/**
 * The day's work for WIP, one group per project (docs/public-posting.md): a project's or
 * lever's hashtag names the group; work toward the aim without one goes in one group
 * without a hashtag. Other work only counts when the user gave its project a hashtag, so
 * paid work, family and the like never reach WIP.
 */
export function wipGroups(goal: Goal, work: { text: string; aim: boolean; onMain?: boolean; projectId?: string; leverId?: string }[], mainDone: { text: string; aim: boolean; projectId?: string; leverId?: string } | null): WipGroup[] {
  const groups = new Map<string, WipGroup>();
  // The main step done is its own todo only when no session or move on it already says what was done.
  const said = work.some(w => w.onMain || w.text.trim().toLowerCase() === mainDone?.text.trim().toLowerCase());
  const all = mainDone && !said ? [mainDone, ...work] : work;
  for (const w of all) {
    const p = w.projectId ? goal.projects.find(x => x.id === w.projectId) : undefined;
    const l = w.leverId ? goal.levers.find(x => x.id === w.leverId) : undefined;
    const hashtag = p?.wipHashtag ?? l?.wipHashtag ?? null;
    if (!w.aim && !hashtag) continue;
    const key = hashtag ? `tag-${hashtag.toLowerCase()}` : p ? `project-${p.id}` : 'aim';
    const g = groups.get(key) ?? { key, project: p?.name ?? (hashtag ? l?.name ?? null : null), hashtag, done: [] };
    g.done.push(w.text);
    groups.set(key, g);
  }
  return [...groups.values()];
}
