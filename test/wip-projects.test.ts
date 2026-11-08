import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AimService } from '../src/service.js';
import { SocialService, type SocialDeps } from '../src/social/service.js';
import { NetworkError, wipClient, type FeedPost, type NetworkClient, type WipProject } from '../src/social/clients.js';
import { claudeMatcherFromEnv, matchWipProjects, plainMatch, type MatchEntry, type ProjectMatcher } from '../src/social/wip-match.js';
import { SIGNATURE } from '../src/social/draft.js';
import { addDays, startOfDay } from '../src/dates.js';
import { createApp } from '../src/http.js';
import { FakeStore } from './fake-store.js';
import { rpc, call } from './helpers.js';
import type { Network, Session } from '../src/types.js';

// docs/public-posting.md, 2026-11-07: "WIP posts are about a project" and "Who attaches the hashtags".

before(() => { process.env.AIMYEAR_SOCIAL_KEY = randomBytes(32).toString('base64'); });
const WIP_KEY = 'wip_test_key_not_real_123456';
const BSKY_PW = 'abcd-efgh-ijkl-mnop';

/** A network in memory: what it was asked to post, the user's own feed, and (WIP) their projects. */
class FakeNet implements NetworkClient {
  feed: FeedPost[] = [];
  posted: string[] = [];
  projects: WipProject[] = [];
  projectsFail = false;
  constructor(public network: Network, public handle: string) {}
  async open(secret: Record<string, string>) {
    if (!secret.apiKey && !secret.appPassword) throw new NetworkError(this.network, 401, 'no login');
    return {
      handle: this.handle,
      recent: async () => [...this.feed].reverse(),
      post: async (text: string) => {
        const id = `${this.network}-${this.feed.length + 1}`;
        this.feed.push({ id, createdAt: new Date().toISOString(), text });
        this.posted.push(text);
        return { id, url: `https://example.test/${id}` };
      },
      ...(this.network === 'wip' ? { projects: async () => { if (this.projectsFail) throw new NetworkError('wip', 500, 'WIP answered 500.'); return this.projects; } } : {}),
    };
  }
}

/** The model step, faked: what it was asked, and what it answers. */
class FakeMatcher implements ProjectMatcher {
  asked: { entries: MatchEntry[]; wip: WipProject[] }[] = [];
  constructor(public answer: { id: string; hashtag: string }[] | 'throw' = []) {}
  async match(entries: MatchEntry[], wip: WipProject[]) {
    this.asked.push({ entries, wip });
    if (this.answer === 'throw') throw new Error('model down');
    return this.answer;
  }
}

const wp = (hashtag: string, name: string, extra: Partial<WipProject> = {}): WipProject => ({ id: `w-${hashtag}`, name, hashtag, ...extra });

function setup(opts: { agent?: string; matcher?: ProjectMatcher | null } = {}) {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'c1', 'mobile', async () => opts.agent);
  const wip = new FakeNet('wip', 'valentina');
  const bsky = new FakeNet('bluesky', 'valentina.bsky.social');
  const deps: SocialDeps = { clients: { wip, bluesky: bsky }, isPro: async () => true, matcher: opts.matcher };
  return { store, svc, wip, bsky, deps, social: new SocialService(store as any, svc, deps) };
}

/** Valentina's shape: one aim, two products of her own as projects, paid work as another. */
async function withAim(ctx: ReturnType<typeof setup>) {
  const { svc, store } = ctx;
  const today = await svc.today();
  await svc.setGoal({ title: '$1,000 a month from my own projects', metric: 'dollars a month', baseline: 0, target: 1000, deadline: addDays(today, 200) });
  await svc.setLevers([{ id: 'out', name: 'Outreach and posting', kind: 'hard' }, { id: 'build', name: 'Building', kind: 'comfortable' }]);
  await svc.setProjects([
    { id: 'aimyear', name: 'AimYear', area: 'money', keywords: ['aimyear'], repos: ['Yahhi/aimyear-mcp'] },
    { id: 'worklore', name: 'Worklore', area: 'money', keywords: ['worklore'] },
    { id: 'uar', name: 'UAR mobile app', area: 'work', keywords: ['uar'] },
  ]);
  return { today, at: (date: string, h: number) => new Date(startOfDay(date, store.profile.timezone).getTime() + h * 3600000) };
}

let n = 0;
function session(store: FakeStore, start: Date, minutes: number, s: Partial<Session>) {
  const id = `s${++n}`;
  store.sessions.set(id, {
    id, start: start.toISOString(), end: new Date(start.getTime() + minutes * 60000).toISOString(), source: 'agent', weight: 1, workplace: 'desktop',
    area: 'work', task: 'work', notes: [], classification: 'goal_comfortable', verdictAtStart: 'ok', ...s,
  });
}

// ---------- hashtags on projects and levers ----------

test('set_projects and set_levers take a WIP hashtag, keep it when a later call leaves it out, and refuse a bad one', async () => {
  const ctx = setup();
  const { svc, store } = ctx;
  await withAim(ctx);
  const r = await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: '#aimyear' }, { id: 'uar', name: 'UAR mobile app', area: 'work' }]);
  assert.deepEqual(r.projects.map(p => [p.id, p.wipHashtag, p.wipHashtagBy]), [['aimyear', 'aimyear', 'user'], ['uar', undefined, undefined]]);
  assert.match(r.speak, /AimYear \[money\] #aimyear/);
  assert.equal(store.goal!.projects[0].wipHashtag, 'aimyear', 'stored on the goal document with the project');

  // An agent that never heard of hashtags replaces the list: the hashtag stays.
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', keywords: ['aimyear'] }]);
  assert.equal(store.goal!.projects[0].wipHashtag, 'aimyear');
  // null removes it.
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: null }]);
  assert.equal(store.goal!.projects[0].wipHashtag, undefined);
  await assert.rejects(svc.setProjects([{ name: 'X', area: 'work', wip_hashtag: 'two words' }]), /not a WIP hashtag/);

  const l = await svc.setLevers([{ id: 'out', name: 'Outreach', kind: 'hard' }, { id: 'wl', name: 'Worklore stories', kind: 'comfortable', wip_hashtag: 'worklore' }]);
  assert.equal(l.levers!.find(x => x.id === 'wl')!.wipHashtag, 'worklore');
  assert.equal((await svc.getGoal()).goal!.levers.find(x => x.id === 'wl')!.wipHashtag, 'worklore', 'get_goal returns it');
});

// ---------- the WIP draft: one todo per project ----------

test('the WIP draft is one todo per project worked on, with its hashtag; Bluesky keeps one post for the day', async () => {
  const ctx = setup();
  const { svc, store, social } = ctx;
  const { today, at } = await withAim(ctx);
  await svc.setProjects([
    { id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear' },
    { id: 'worklore', name: 'Worklore', area: 'money', wip_hashtag: 'worklore' },
    { id: 'uar', name: 'UAR mobile app', area: 'work' },
  ]);
  session(store, at(today, 9), 50, { classification: 'goal_comfortable', projectId: 'aimyear', leverId: 'build', task: 'post draft', summary: 'The progress post now leads with what was done' });
  session(store, at(today, 11), 120, { classification: 'other_project', projectId: 'uar', task: 'UAR release 3.2' });
  session(store, at(today, 14), 30, { classification: 'goal_hard', projectId: 'worklore', leverId: 'out', task: 'Published a story about OAuth on Cloud Run' });
  await svc.addMove({ task: 'Fixed the signup button text', time: '15:00', projectId: 'aimyear', leverId: 'build' });
  await svc.addMove({ task: 'Replied to 2 people on Reddit', time: '16:00', leverId: 'out' });

  const d = await social.draft();
  assert.deepEqual(d.wip_todos.map(t => [t.key, t.hashtag, t.text]), [
    ['tag-aimyear', 'aimyear', 'The progress post now leads with what was done. Fixed the signup button text. #aimyear'],
    ['tag-worklore', 'worklore', 'Published a story about OAuth on Cloud Run. #worklore'],
    ['aim', null, 'Replied to 2 people on Reddit.'],
  ]);
  assert.ok(!JSON.stringify(d.wip_todos).includes('UAR'), 'paid work without a hashtag never reaches WIP');
  assert.ok(d.text!.endsWith(SIGNATURE));
  assert.doesNotMatch(d.text!, /#aimyear/, 'the Bluesky post has no WIP hashtags');
  assert.match(d.speak!, /WIP todos, one per project:\n- The progress post/);

  // Work not toward the aim on a project the user tagged for WIP goes to WIP too.
  await svc.setProjects([{ id: 'uar', name: 'UAR mobile app', area: 'work', wip_hashtag: 'uar' }, { id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear' }, { id: 'worklore', name: 'Worklore', area: 'money', wip_hashtag: 'worklore' }]);
  assert.ok((await social.draft()).wip_todos.some(t => t.text === 'UAR release 3.2. #uar'));
});

test('the main step done with nothing else on record is its own WIP todo, under its project', async () => {
  const ctx = setup();
  const { store, social, svc } = ctx;
  const { today } = await withAim(ctx);
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear' }]);
  store.days.set(today, { date: today, mode: 'full', createdAt: '', updatedAt: '', plan: [{ id: 'm', title: 'Send the beta invite to 10 people', area: 'money', projectId: 'aimyear', leverId: 'out', isMainStep: true, estimateMin: 30, done: true }] });
  assert.deepEqual((await social.draft()).wip_todos.map(t => t.text), ['Send the beta invite to 10 people. #aimyear']);
  // A session on the main step already says what was done: the step is not a second todo.
  session(store, new Date(startOfDay(today, store.profile.timezone).getTime() + 9 * 3600000), 30, { classification: 'main_step', itemId: 'm', projectId: 'aimyear', task: 'Send the beta invite to 10 people', summary: 'Invited 10 people to the beta, 4 signed up' });
  assert.deepEqual((await social.draft()).wip_todos.map(t => t.text), ['Invited 10 people to the beta, 4 signed up. #aimyear']);
});

test('posting: one WIP todo per project, each once; Bluesky once; the user\'s edits go out as written', async () => {
  const ctx = setup();
  const { svc, store, social, wip, bsky } = ctx;
  const { today, at } = await withAim(ctx);
  await social.connect({ network: 'wip', api_key: WIP_KEY });
  await social.connect({ network: 'bluesky', handle: 'valentina.bsky.social', app_password: BSKY_PW });
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear' }, { id: 'worklore', name: 'Worklore', area: 'money', wip_hashtag: 'worklore' }]);
  session(store, at(today, 9), 40, { classification: 'goal_comfortable', projectId: 'aimyear', task: 'Shipped the WIP todos per project' });
  await svc.addMove({ task: 'Wrote the Cloud Run story', time: '12:00', projectId: 'worklore', leverId: 'out' });

  const d = await social.draft();
  assert.deepEqual(d.networks.map(c => [c.network, c.status]), [['wip', 'ready'], ['bluesky', 'ready']]);
  const edited = d.wip_todos.map(t => ({ key: t.key, text: t.key === 'tag-worklore' ? 'Wrote and published the Cloud Run story #worklore' : t.text }));
  const r = await social.post({ wip_todos: edited });
  assert.deepEqual(r.results.map(x => [x.network, x.label ?? null, x.status]), [['wip', '#aimyear', 'posted'], ['wip', '#worklore', 'posted'], ['bluesky', null, 'posted']]);
  assert.deepEqual(wip.posted, ['Shipped the WIP todos per project. #aimyear', 'Wrote and published the Cloud Run story #worklore']);
  assert.equal(bsky.posted.length, 1);
  assert.ok(bsky.posted[0].endsWith(SIGNATURE), 'Bluesky got the day\'s post from the draft');
  assert.match(r.speak, /WIP \(#aimyear\): posted/);

  // A retry, or a second device: nothing twice, and the draft says so.
  const again = await social.post({});
  assert.deepEqual(again.results.map(x => x.status), ['already_posted', 'already_posted', 'already_posted']);
  assert.equal(wip.posted.length, 2);
  assert.deepEqual((await social.draft()).networks.map(c => c.status), ['posted_by_aimyear', 'posted_by_aimyear']);
  // AimYear's own todos are not taken for the user's own WIP posts.
  assert.equal((await social.draft()).networks[0].status, 'posted_by_aimyear');
});

test('an older app sends one text: WIP gets it as one todo, and the per-project todos are not posted on top', async () => {
  const ctx = setup();
  const { svc, social, wip } = ctx;
  await withAim(ctx);
  await social.connect({ network: 'wip', api_key: WIP_KEY });
  await svc.addMove({ task: 'Fixed the paywall', projectId: 'aimyear' });
  assert.equal((await social.post({ text: 'Fixed the paywall today. aimyear.com' })).results[0].status, 'posted');
  assert.deepEqual(wip.posted, ['Fixed the paywall today. aimyear.com']);
  assert.equal((await social.post({})).results[0].status, 'already_posted');
  assert.equal(wip.posted.length, 1);
});

test('the evening offer carries the WIP todos as shown, so its Post action posts exactly them', async () => {
  const ctx = setup();
  const { svc, social } = ctx;
  const { today } = await withAim(ctx);
  await social.connect({ network: 'wip', api_key: WIP_KEY });
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear' }]);
  await svc.addMove({ task: 'Fixed the paywall', projectId: 'aimyear' });
  const offer = await social.eveningOffer(today);
  assert.equal(offer.send, true);
  if (offer.send) {
    assert.equal(offer.body, 'Fixed the paywall. #aimyear');
    assert.deepEqual(JSON.parse(offer.data.wip_todos), [{ key: 'tag-aimyear', text: 'Fixed the paywall. #aimyear' }]);
  }
});

// ---------- the user's WIP projects ----------

test('list_wip_projects reads the user\'s WIP projects and says which AimYear project carries each hashtag', async () => {
  const ctx = setup();
  const { svc, social, wip } = ctx;
  await withAim(ctx);
  assert.match((await social.listWipProjects()).speak, /WIP is not connected/);
  await social.connect({ network: 'wip', api_key: WIP_KEY });
  wip.projects = [wp('aimyear', 'AimYear'), wp('worklore', 'Worklore'), { id: 'w-x', name: 'No tag', hashtag: null }];
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'AimYear' }, { id: 'worklore', name: 'Worklore', area: 'money' }]);
  const l = await social.listWipProjects();
  assert.deepEqual(l.projects.map(p => [p.hashtag, p.attached_to.map(a => a.id)]), [['aimyear', ['aimyear']], ['worklore', []]]);
  assert.ok(l.aimyear_without_hashtag.some(x => x.id === 'worklore'));
  assert.match(l.speak, /#worklore \(Worklore\), not attached/);
  assert.match(l.speak, /ask the user when unsure/);
});

test('the WIP client lists the user\'s projects from GET /v1/users/me/projects, page by page', async () => {
  const urls: string[] = [];
  const pages = [
    { data: [{ id: '1', name: 'AimYear', hashtag: 'aimyear', github_url: 'https://github.com/Yahhi/aimyear-mcp', archived: false }], has_more: true, after: 'c1' },
    { data: [{ id: '2', name: 'Old', hashtag: '#old', archived: true }], has_more: false, after: null },
  ];
  const f = (async (url: string) => {
    urls.push(url);
    const body = url.endsWith('/users/me') ? { username: 'valentina' } : pages.shift();
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  const conn = await wipClient(f).open({ apiKey: WIP_KEY });
  const list = await conn.projects!();
  assert.deepEqual(list.map(p => [p.hashtag, p.archived, p.githubUrl ?? null]), [['aimyear', false, 'https://github.com/Yahhi/aimyear-mcp'], ['old', true, null]]);
  assert.deepEqual(urls.slice(1), ['https://api.wip.co/v1/users/me/projects?limit=100', 'https://api.wip.co/v1/users/me/projects?limit=100&starting_after=c1']);
});

// ---------- connect-time matching (the app, where no agent is present) ----------

test('plain matching: names, hashtags, keywords and repos, one to one; anything ambiguous is left over', () => {
  const entries: MatchEntry[] = [
    { id: 'project:aimyear', kind: 'project', name: 'AimYear', keywords: [], repos: [] },
    { id: 'project:wl', kind: 'project', name: 'Stories site', keywords: [], repos: ['Yahhi/worklore'] },
    { id: 'project:dog', kind: 'project', name: 'Dog app', keywords: ['pawly'], repos: [] },
    { id: 'lever:out', kind: 'lever', name: 'Outreach', keywords: [], repos: [] },
    { id: 'project:a', kind: 'project', name: 'Twin', keywords: ['twin'], repos: [] },
  ];
  const wip = [
    wp('aimyear', 'AimYear'), wp('wl', 'Worklore', { githubUrl: 'https://github.com/Yahhi/worklore' }), wp('pawly', 'Pawly'),
    wp('twin1', 'Twin'), wp('twin2', 'Twin'), wp('gone', 'Gone', { archived: true }),
  ];
  const r = plainMatch(entries, wip);
  assert.deepEqual(r.matches.map(m => [m.id, m.hashtag, m.by]), [['project:aimyear', 'aimyear', 'name'], ['project:wl', 'wl', 'name'], ['project:dog', 'pawly', 'name']]);
  assert.deepEqual(r.entries.map(e => e.id), ['lever:out', 'project:a'], 'no match, and two WIP projects named Twin');
  assert.deepEqual(r.wip.map(p => p.hashtag), ['twin1', 'twin2'], 'archived projects are never offered');
});

test('the model gets only the leftovers; its answer is checked, and a failing model attaches nothing more', async () => {
  const entries: MatchEntry[] = [
    { id: 'project:aimyear', kind: 'project', name: 'AimYear', keywords: [], repos: [] },
    { id: 'lever:wl', kind: 'lever', name: 'Writing developer stories', keywords: [], repos: [] },
    { id: 'lever:out', kind: 'lever', name: 'Outreach', keywords: [], repos: [] },
  ];
  const wip = [wp('aimyear', 'AimYear'), wp('worklore', 'Worklore', { pitch: 'Honest developer stories' }), wp('other', 'Other')];
  const m = new FakeMatcher([{ id: 'lever:wl', hashtag: '#Worklore' }, { id: 'lever:out', hashtag: 'aimyear' }, { id: 'project:nope', hashtag: 'other' }, { id: 'lever:out', hashtag: 'invented' }]);
  const r = await matchWipProjects(entries, wip, m);
  assert.deepEqual(m.asked[0].entries.map(e => e.id), ['lever:wl', 'lever:out']);
  assert.deepEqual(m.asked[0].wip.map(p => p.hashtag), ['worklore', 'other']);
  assert.deepEqual(r.map(x => [x.id, x.hashtag, x.by]), [['project:aimyear', 'aimyear', 'name'], ['lever:wl', 'worklore', 'ai']], 'taken, unknown and invented answers are dropped');
  assert.deepEqual((await matchWipProjects(entries, wip, new FakeMatcher('throw'))).map(x => x.id), ['project:aimyear']);
  assert.deepEqual((await matchWipProjects(entries, wip, null)).map(x => x.id), ['project:aimyear']);
});

test('connecting WIP from the app attaches the hashtags once, says so, and never replaces one the user set', async () => {
  const matcher = new FakeMatcher([{ id: 'lever:build', hashtag: 'dogapp' }]);
  const ctx = setup({ agent: 'app', matcher });
  const { svc, store, social, wip } = ctx;
  await withAim(ctx);
  await svc.setProjects([
    { id: 'aimyear', name: 'AimYear', area: 'money', keywords: ['aimyear'] },
    { id: 'worklore', name: 'Worklore', area: 'money', wip_hashtag: 'my_worklore' },
    { id: 'uar', name: 'UAR mobile app', area: 'work' },
  ]);
  wip.projects = [wp('aimyear', 'AimYear'), wp('worklore', 'Worklore'), wp('dogapp', 'Dog grooming bookings')];
  const c = await social.connect({ network: 'wip', api_key: WIP_KEY });
  assert.deepEqual(c.wip_hashtags!.map(t => [t.kind, t.id, t.hashtag, t.by]), [['project', 'aimyear', 'aimyear', 'name'], ['lever', 'build', 'dogapp', 'ai']]);
  assert.match(c.speak, /WIP projects attached: AimYear → #aimyear, Building → #dogapp/);
  const goal = store.goal!;
  assert.equal(goal.projects.find(p => p.id === 'aimyear')!.wipHashtagBy, 'auto');
  assert.equal(goal.projects.find(p => p.id === 'worklore')!.wipHashtag, 'my_worklore', 'the user\'s own hashtag stays');
  assert.equal(goal.projects.find(p => p.id === 'uar')!.wipHashtag, undefined);
  assert.ok(!matcher.asked[0].entries.some(e => e.id === 'project:worklore'), 'a project with a hashtag is not offered to the model');
  // The user changes one afterwards: theirs from then on.
  await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money', wip_hashtag: 'aimyear_app' }]);
  assert.deepEqual([store.goal!.projects[0].wipHashtag, store.goal!.projects[0].wipHashtagBy], ['aimyear_app', 'user']);
});

test('connecting WIP from an agent matches nothing (the agent attaches them, per the skill); a WIP error attaches nothing', async () => {
  const agent = setup({ agent: 'Claude Code', matcher: new FakeMatcher() });
  await withAim(agent);
  agent.wip.projects = [wp('aimyear', 'AimYear')];
  const c = await agent.social.connect({ network: 'wip', api_key: WIP_KEY });
  assert.equal('wip_hashtags' in c, false);
  assert.equal(agent.store.goal!.projects[0].wipHashtag, undefined);

  const app = setup({ agent: 'app' });
  await withAim(app);
  app.wip.projectsFail = true;
  const c2 = await app.social.connect({ network: 'wip', api_key: WIP_KEY });
  assert.deepEqual(c2.wip_hashtags, []);
  assert.match(c2.speak, /No WIP project matched/);
});

test('the Claude matcher needs Workload Identity Federation set up; without it the step is skipped, and no API key is read', () => {
  assert.equal(claudeMatcherFromEnv({}), null);
  assert.equal(claudeMatcherFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-not-real' }), null, 'an API key alone does nothing');
  assert.equal(claudeMatcherFromEnv({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x' }), null);
  // Configured: a matcher exists, and building it makes no call (the client is made on first use).
  assert.equal(typeof claudeMatcherFromEnv({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x', ANTHROPIC_ORGANIZATION_ID: 'org_x' })?.match, 'function');
});

// ---------- the app's route and tools ----------

test('the app: POST /social/post takes wip_todos, and add_social_account over /mcp with the app\'s sign-in matches the hashtags', async () => {
  const stores = new Map<string, FakeStore>();
  const storeFor = (uid: string) => { if (!stores.has(uid)) stores.set(uid, new FakeStore()); return stores.get(uid)! as any; };
  const wip = new FakeNet('wip', 'valentina');
  wip.projects = [wp('aimyear', 'AimYear')];
  const app = createApp({
    tokens: new Map(), baseUrl: new URL('http://localhost:1'), provider: { verifyAccessToken: async () => { throw new Error('no'); }, clientsStore: {} } as any,
    storeFor, socialDeps: { clients: { wip, bluesky: new FakeNet('bluesky', 'x') }, isPro: async () => true, matcher: null },
    verifyIdToken: async () => ({ uid: 'u1', firebase: { sign_in_provider: 'google.com' } }),
  });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ1MSJ9.fake-signature-u1';
  const auth = { Authorization: `Bearer ${JWT}` };
  try {
    const svc = new AimService(storeFor('u1'), 'setup');
    const today = await svc.today();
    await svc.setGoal({ title: '$1,000 a month', metric: 'dollars', baseline: 0, target: 1000, deadline: addDays(today, 200) });
    await svc.setLevers([{ id: 'out', name: 'Outreach', kind: 'hard' }]);
    await svc.setProjects([{ id: 'aimyear', name: 'AimYear', area: 'money' }]);
    const r = await rpc(`${url}/mcp`, call(1, 'tools/call', { name: 'add_social_account', arguments: { network: 'wip', api_key: WIP_KEY } }), auth);
    const res = JSON.parse(r.json.result.content[0].text);
    assert.deepEqual(res.wip_hashtags.map((t: { hashtag: string }) => t.hashtag), ['aimyear']);
    assert.equal(stores.get('u1')!.goal!.projects[0].wipHashtag, 'aimyear');

    await svc.addMove({ task: 'Fixed the paywall', projectId: 'aimyear' });
    const p = await fetch(`${url}/social/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ date: today, wip_todos: [{ key: 'tag-aimyear', text: 'Fixed the paywall, finally #aimyear' }, { text: 7 }] }) });
    assert.equal(p.status, 200);
    assert.deepEqual(wip.posted, ['Fixed the paywall, finally #aimyear']);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
