/**
 * Made-up weeks for the weekly review email: the tests and scripts/weekly-review-preview.ts
 * both seed a FakeStore with them. Records are written straight into the store, already
 * classified, so a week looks exactly the same on any day the tests run.
 */
import { addDays, atLocal } from '../src/dates.js';
import { DEFAULT_PROFILE } from '../src/store.js';
import type { Classification, Goal, Move, Session } from '../src/types.js';
import { FakeStore } from './fake-store.js';

export const AIM = '$1,000 a month from AimYear';

export function goal(): Goal {
  return {
    title: AIM, kind: 'count', area: 'money', why: '', metric: '$/month', baseline: 0, target: 1000, deadline: '2027-06-30',
    baselineHistory: [{ value: 0, date: '2026-09-01' }],
    levers: [
      { id: 'outreach', name: 'Outreach and posting', kind: 'hard', examples: [], match: { keywords: [], repos: [] } },
      { id: 'build', name: 'Building the product', kind: 'comfortable', examples: [], match: { keywords: [], repos: [] } },
    ],
    projects: [], createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-01T08:00:00Z',
  };
}

/** A path with one open stage: a count of paying users, 3 of 10 so far. */
function path(today: string) {
  return {
    milestones: [
      { id: 'm1', title: 'A landing page that says what AimYear does', kind: 'steps' as const, metric: 'steps', target: 0, due: addDays(today, -20), status: 'done' as const, createdAt: '2026-09-01T08:00:00Z' },
      { id: 'm2', title: 'First 10 paying users', kind: 'count' as const, metric: 'paying users', target: 10, due: addDays(today, 40), status: 'doing' as const, createdAt: '2026-09-01T08:00:00Z', progress: [{ value: 3, date: addDays(today, -2) }] },
    ],
    steps: [{ id: 's1', milestoneId: 'm1', title: 'Rewrite the hero', estimateMin: 50, order: 1, status: 'done' as const }],
  };
}

let n = 0;
const id = () => `x${++n}`;

export class Seeder {
  constructor(readonly store: FakeStore) {}
  private get tz() { return this.store.profile.timezone; }
  session(date: string, at: string, minutes: number, task: string, cls: Classification, extra: Partial<Session> = {}) {
    const start = atLocal(date, at, this.tz);
    const s: Session = { id: id(), start: start.toISOString(), end: new Date(start.getTime() + minutes * 60000).toISOString(), source: 'agent', weight: 1, workplace: 'desktop', area: cls === 'life' ? 'health' : 'money', task, notes: [], classification: cls, verdictAtStart: 'ok', outcome: 'done', ...extra };
    this.store.sessions.set(s.id, s);
    return s;
  }
  move(date: string, task: string, cls: Classification, leverId?: string) {
    const m: Move = { id: id(), date, at: atLocal(date, '12:00', this.tz).toISOString(), task, area: 'money', classification: cls, leverId, source: 'agent', createdAt: '' };
    this.store.moves.set(m.id, m);
    return m;
  }
  mainStep(date: string, title: string, done: boolean, leverId = 'outreach') {
    const d = this.store.days.get(date) ?? { date, mode: 'full' as const, plan: [], createdAt: '', updatedAt: '' };
    d.plan.push({ id: id(), title, area: 'money', leverId, isMainStep: true, estimateMin: 50, done });
    this.store.days.set(date, d);
  }
  off(date: string) { this.store.days.set(date, { date, mode: 'off', plan: [], createdAt: '', updatedAt: '' }); }
}

/** A store with the aim and the path, the profile in Madrid, nothing recorded yet. */
export function freshStore(today: string, tracking: 'time' | 'quiet' | 'moves' = 'time') {
  const store = new FakeStore();
  store.profile = { ...DEFAULT_PROFILE('Europe/Madrid'), tracking, weeklyTarget: 4 };
  store.goal = goal();
  store.path = path(today);
  return store;
}

/**
 * A good week with time tracking, Monday `week`: six days toward the aim, the target met two
 * weeks running, eleven distinct things moved (one of them twice), one day off.
 */
export function seedGoodWeek(store: FakeStore, week: string) {
  const s = new Seeder(store);
  const d = (i: number) => addDays(week, i);
  // The week before: 4 days, met. The one before that: 1 day, not met.
  for (const i of [0, 1, 3, 4]) s.move(addDays(week, -7 + i), `Last week's small change ${i}`, 'goal_comfortable', 'build');
  s.mainStep(addDays(week, -7), 'Email 5 people from the waitlist', true);
  s.session(addDays(week, -6), '10:00', 70, 'Fix onboarding copy', 'goal_comfortable', { leverId: 'build', summary: 'Shorter onboarding copy' });
  s.move(addDays(week, -14), 'One change two weeks ago', 'goal_comfortable', 'build');

  s.mainStep(d(0), 'Post the pricing change on WIP', true);
  s.session(d(0), '09:30', 40, 'Post the pricing change on WIP', 'main_step', { leverId: 'outreach', summary: 'Posted the pricing change on WIP, 3 replies' });
  s.session(d(0), '11:00', 95, 'Landing page', 'goal_comfortable', { leverId: 'build', summary: 'Fixed the <title> tag & meta description on the landing page' });
  s.session(d(0), '18:00', 60, 'Gym', 'life');
  s.mainStep(d(1), 'Write to 5 Reddit commenters', true);
  s.session(d(1), '10:00', 50, 'Reddit replies', 'main_step', { leverId: 'outreach', summary: 'Wrote to 5 people who commented on the r/productivity thread' });
  s.move(d(1), 'Answered two emails from the waitlist', 'goal_hard', 'outreach');
  s.mainStep(d(2), 'Call Marta about the pilot', false);
  s.session(d(2), '15:00', 30, 'Paywall', 'goal_comfortable', { leverId: 'build', summary: 'Paywall shows the yearly plan first' });
  s.session(d(2), '16:00', 25, 'Paywall', 'goal_comfortable', { leverId: 'build', summary: 'paywall shows the yearly plan first.' });
  s.mainStep(d(3), 'Send the pilot offer to 3 studios', true);
  s.session(d(3), '09:00', 45, 'Pilot offer', 'main_step', { leverId: 'outreach', summary: 'Sent the pilot offer to 3 design studios' });
  s.move(d(3), 'Updated the App Store screenshots', 'goal_comfortable', 'build');
  s.session(d(4), '10:00', 120, 'Weekly review email', 'goal_comfortable', { leverId: 'build', summary: 'Weekly review email: builder and preview' });
  s.move(d(4), 'Posted the weekly progress on Bluesky', 'goal_hard', 'outreach');
  s.session(d(5), '11:00', 35, 'Analytics', 'goal_comfortable', { leverId: 'build', summary: 'Read the signup funnel in GA4' });
  s.move(d(5), 'Replied to a user about the Windows app', 'goal_comfortable', 'build');
  s.session(d(5), '17:00', 20, 'Fix', 'goal_comfortable', { leverId: 'build', summary: 'Fixed a crash on the Insights screen' });
  s.off(d(6));
}

/**
 * A quiet-numbers week with little done: one move toward the aim on Wednesday, three main
 * steps planned and none done. The week before met the target, the one before that did not.
 */
export function seedQuietWeek(store: FakeStore, week: string) {
  const s = new Seeder(store);
  for (const i of [0, 2, 3, 5]) s.move(addDays(week, -7 + i), `Last week's move ${i}`, 'goal_hard', 'outreach');
  s.mainStep(addDays(week, 0), 'Ask 3 friends who freelance about their invoicing', false);
  s.mainStep(addDays(week, 1), 'Ask 3 friends who freelance about their invoicing', false);
  s.move(addDays(week, 2), 'Drafted the message to friends who freelance', 'goal_comfortable', 'build');
  s.session(addDays(week, 2), '20:00', 90, 'Reading about invoicing tools', 'goal_comfortable', { leverId: 'build', summary: 'Read about three invoicing tools' });
  s.mainStep(addDays(week, 3), 'Ask 3 friends who freelance about their invoicing', false);
  s.session(addDays(week, 4), '18:00', 60, 'Walk', 'life');
}
