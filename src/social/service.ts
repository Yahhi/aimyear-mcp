/**
 * Posting the day's progress in public (docs/public-posting.md).
 *
 * - The user connects WIP and Bluesky once; credentials are sealed (crypto.ts) and never
 *   leave this file in any result.
 * - The draft is written from the day's record (draft.ts): one post for Bluesky, and one
 *   WIP todo per project worked on, with that project's #hashtag.
 * - WIP connected from the app (no agent there): the user's WIP projects are matched to
 *   their AimYear projects and levers once (wip-match.ts).
 * - AimYear posts only when the user explicitly asks (add_post, or the Post action of the
 *   evening offer). Never on its own.
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
import { NETWORKS, type Goal, type Network, type PostRecord, type Profile, type SocialAccount } from '../types.js';

export interface SocialDeps {
  clients: Record<Network, NetworkClient>;
  isPro: (uid: string) => Promise<boolean>;
  now?: () => Date;
  /** The model step of the connect-time WIP matching; null or absent skips it. */
  matcher?: ProjectMatcher | null;
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
    const levers = g.goal.levers;
    const isHard = (x: { classification: string; lever_id?: string }) =>
      x.classification === 'goal_hard' || (x.classification === 'main_step' && levers.find(l => l.id === x.lever_id)?.kind === 'hard');
    const hardMin = Math.round(s.sessions.filter(isHard).reduce((n, x) => n + x.attention_min, 0));
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
    const wip = wipGroups(g.goal, work, main?.done ? { text: main.title, aim: true, projectId: main.projectId, leverId: main.leverId } : null);
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
      week: await this.aim.weekProgress(date).then(w => ({ days: w.days, target: w.target })), wip,
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
    for (const x of [addDays(date, -1), date, addDays(date, 1)]) {
      for (const r of await this.store.getPostRecordsOn(x)) if (r.network === n && r.postId) ours.add(r.postId);
    }
    const sameDay = (await conn.recent()).filter(p => !ours.has(p.id) && p.createdAt && !Number.isNaN(Date.parse(p.createdAt)) && localDate(new Date(p.createdAt), tz) === date);
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
    const recs = (await this.store.getPostRecordsOn(date)).filter(r => r.network === 'wip' && r.status === 'posted');
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
  private async drafted(date: string): Promise<{ text: string; wip: WipTodo[] } | { reason: string; nothing: boolean }> {
    const f = await this.facts(date);
    if ('reason' in f) return { reason: f.reason, nothing: false };
    if (nothingToPost(f)) return { reason: nothingText(date, localDate(this.now(), await this.tz())), nothing: true };
    return { text: buildDraft(f), wip: buildWipTodos(f.wip ?? []) };
  }

  private itemsFor(n: Network, d: { text: string; wip: WipTodo[] }): Item[] {
    return n === 'wip' && d.wip.length ? d.wip.map(t => ({ key: t.key, label: label(t), text: t.text })) : [{ text: d.text }];
  }

  private async draftWithChecks(date: string) {
    const d = await this.drafted(date);
    if ('reason' in d) return { text: null, wip: [] as WipTodo[], reason: d.reason, nothing: d.nothing, networks: [] as NetworkCheck[] };
    const accounts = await this.store.getSocialAccounts();
    const targets = this.targets(await this.store.getProfile(), accounts.map(a => a.network));
    const networks: NetworkCheck[] = [];
    for (const n of targets) networks.push(await this.check(accounts.find(a => a.network === n)!, date, this.itemsFor(n, d)));
    return { text: d.text, wip: d.wip, reason: null, nothing: false, networks };
  }

  async draft(date?: string) {
    await this.requirePro();
    const d = await this.dateArg(date, false);
    const r = await this.draftWithChecks(d);
    if (!r.text) return { date: d, text: null, wip_todos: [], nothing_to_post: r.nothing, networks: [], speak: r.reason };
    const line = (c: NetworkCheck) => `${NAME[c.network]}: ${c.status === 'ready' ? 'ready' : c.status === 'posted_by_aimyear' ? 'already posted by AimYear' : c.status === 'you_posted' ? 'you already posted there today, so AimYear will not' : c.status === 'too_long' ? `too long (${c.graphemes}/${c.max})` : `can't check (${c.error})`}`;
    const wipText = r.wip.length ? `\nWIP todos, one per project:\n${r.wip.map(t => `- ${t.text}`).join('\n')}` : '';
    return {
      date: d, text: r.text, wip_todos: r.wip, nothing_to_post: false, graphemes: graphemes(r.text), networks: r.networks,
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
