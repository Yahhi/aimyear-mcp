import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService, AimError } from '../src/service.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';
import type { Session } from '../src/types.js';

function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  return { store, svc };
}

async function withGoal(svc: AimService) {
  const today = await svc.today();
  await svc.setGoal({ title: '15 paying customers', metric: 'paying customers', baseline: 0, target: 15, deadline: addDays(today, 200) });
  await svc.setLevers([{ id: 'posting', name: 'posting publicly', kind: 'hard', keywords: ['habr'] }, { id: 'building', name: 'building', kind: 'comfortable', keywords: ['refactor'] }]);
  return today;
}

/** A session the server auto-closed hours after the work stopped, like the forgotten timer on 2026-10-14. */
function forgotten(store: FakeStore): Session {
  const s: Session = {
    id: 'sess-1', start: '2026-10-14T14:05:00.000Z', end: '2026-10-14T18:19:00.000Z', source: 'agent', weight: 1, workplace: 'desktop',
    area: 'work', task: 'Write an article for worklore', notes: [], classification: 'goal_hard', leverId: 'posting', verdictAtStart: 'ok',
    outcome: 'partial', autoClosed: true, summary: 'Auto-closed: the timer ran for hours with no stop. Confirm the real end time.',
  };
  store.sessions.set(s.id, s);
  return s;
}

test('stop_session refuses a session that already ended instead of stretching it to now', async () => {
  const { store, svc } = setup();
  const s = forgotten(store);
  await assert.rejects(() => svc.stopSession('done at 17:05', 'partial', s.id), (e: Error) => e instanceof AimError && /edit_session/.test(e.message));
  assert.equal(store.sessions.get(s.id)!.end, s.end);
});

test('edit_session moves the end of a forgotten session and clears the auto-closed note', async () => {
  const { store, svc } = setup();
  await withGoal(svc);
  const s = forgotten(store);
  const r = await svc.editSession(s.id, { end: '17:05' });
  const saved = store.sessions.get(s.id)!;
  assert.equal(saved.end, '2026-10-14T15:05:00.000Z'); // 17:05 in Madrid (UTC+2)
  assert.equal(saved.autoClosed, false);
  assert.equal(saved.summary, undefined);
  assert.equal(r.session.wall_min, 60);
  assert.equal(saved.classification, 'goal_hard');
});

test('edit_session past midnight, moved date, and relabel reclassify', async () => {
  const { store, svc } = setup();
  await withGoal(svc);
  const s = forgotten(store);
  await svc.editSession(s.id, { start: '23:00', end: '00:30' });
  let saved = store.sessions.get(s.id)!;
  assert.equal(saved.start, '2026-10-14T21:00:00.000Z');
  assert.equal(saved.end, '2026-10-14T22:30:00.000Z');
  await svc.editSession(s.id, { date: '2026-10-13' });
  saved = store.sessions.get(s.id)!;
  assert.equal(saved.start, '2026-10-13T21:00:00.000Z');
  assert.equal(saved.end, '2026-10-13T22:30:00.000Z');
  await svc.editSession(s.id, { task: 'refactor the server', leverId: '' });
  assert.equal(store.sessions.get(s.id)!.classification, 'goal_comfortable');
  await assert.rejects(() => svc.editSession(s.id, {}), /nothing to change/);
  await assert.rejects(() => svc.editSession('nope', { end: '10:00' }), /not found/);
});

test('delete_session removes a finished session by id', async () => {
  const { store, svc } = setup();
  const s = forgotten(store);
  await svc.deleteSession(s.id);
  assert.equal(store.sessions.has(s.id), false);
});

test('record_progress keeps one value per date and says when the target is reached', async () => {
  const { store, svc } = setup();
  const today = await withGoal(svc);
  await svc.recordProgress(4);
  await svc.recordProgress(5);
  assert.deepEqual(store.goal!.baselineHistory.filter(h => h.date === today).map(h => h.value), [5]);
  const r = await svc.recordProgress(15);
  assert.equal(r.goal_reached, true);
});

test('edit_plan_item marks done and undone, and moves the main step', async () => {
  const { store, svc } = setup();
  const today = await withGoal(svc);
  await svc.setPlan(today, [{ title: 'Publish the Habr article', area: 'work', isMainStep: true }, { title: 'Workout', area: 'health' }]);
  const [main, other] = store.days.get(today)!.plan;
  await svc.editPlanItem(main.id, today, { done: true });
  assert.equal(store.days.get(today)!.plan[0].done, true);
  await svc.editPlanItem(main.id, today, { done: false });
  assert.equal(store.days.get(today)!.plan[0].done, false);
  await svc.editPlanItem(other.id, today, { isMainStep: true });
  assert.deepEqual(store.days.get(today)!.plan.map(p => p.isMainStep), [false, true]);
  await svc.deletePlanItem(main.id, today);
  assert.equal(store.days.get(today)!.plan.length, 1);
});

test('edit_milestone retired moves the path on and keeps the steps; delete_step removes one', async () => {
  const { store, svc } = setup();
  const today = await withGoal(svc);
  await svc.setMilestones([{ title: 'Plate cleared', metric: 'projects closed', target: 1, due: addDays(today, 10) }, { title: 'First buyers', metric: 'paying customers', target: 5, due: addDays(today, 60) }]);
  const [m1, m2] = store.path.milestones;
  await svc.addSteps(m1.id, [{ title: 'Email 10 people from the waitlist' }]);
  await svc.editMilestone(m1.id, { status: 'retired' });
  assert.equal((await svc.getPath()).current_milestone_id, m2.id);
  assert.equal(store.path.steps.length, 1);
  await svc.deleteStep(store.path.steps[0].id);
  assert.equal(store.path.steps.length, 0);
});

test('stop_timer saves a real summary on the sessions it closes', async () => {
  const { store, svc } = setup();
  await withGoal(svc);
  await svc.startSession({ task: 'Habr article', leverId: 'posting', override: true });
  const r = await svc.stopTimer('Published the article', 'done');
  const s = store.sessions.get(r.closed_sessions[0])!;
  assert.equal(s.summary, 'Published the article');
  assert.equal(s.outcome, 'done');
  assert.ok(s.end);
});

test('set_settings validates the timezone and keeps the other values', async () => {
  const { store, svc } = setup();
  await assert.rejects(() => svc.setSettings({ timezone: 'Mars/Olympus' }), /unknown timezone/);
  await svc.setSettings({ timezone: 'America/Argentina/Buenos_Aires', workMin: 50 });
  assert.equal(store.profile.timezone, 'America/Argentina/Buenos_Aires');
  assert.equal(store.profile.pomodoro.workMin, 50);
  assert.equal(store.profile.pomodoro.breakMin, 5);
});

test('summarize_week for a past week counts all seven days', async () => {
  const { svc } = setup();
  const today = await svc.today();
  const r = await svc.weekSummary(addDays(today, -14));
  assert.equal(r.days_counted, 7);
});
