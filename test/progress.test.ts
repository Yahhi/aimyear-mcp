import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays, weekStart } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  return { store, svc };
}

// ---------- done-or-not goals ----------

test('a done-or-not goal needs no metric, and its progress is the share of stages done', async () => {
  const { svc } = setup();
  const today = await svc.today();
  const check = await svc.checkGoalDraft({ kind: 'done', title: 'Launch AimYear v2 in the App Store', deadline: addDays(today, 60) });
  assert.deepEqual(check.problems, []);
  const r = await svc.setGoal({ kind: 'done', title: 'Launch AimYear v2 in the App Store', deadline: addDays(today, 60) });
  assert.equal(r.ok, true);
  assert.match(r.speak, /done or not by/);

  await svc.setMilestones([
    { id: 'm1', title: 'Implement the onboarding flow', due: addDays(today, 20) },
    { id: 'm2', title: 'Pass App Store review', due: addDays(today, 50) },
  ]);
  await svc.editMilestone('m1', { status: 'done' });
  const g = await svc.getGoal();
  assert.equal(g.kind, 'done');
  assert.deepEqual(g.stages, { done: 1, total: 2 });
  assert.equal(g.progress_fraction, 0.5);
  assert.match(g.speak, /not done yet, 1 of 2 stages done/);

  const done = await svc.recordProgress(1);
  assert.equal(done.goal_reached, true);
  assert.match(done.speak, /marked done/);
  assert.equal((await svc.getGoal()).progress_fraction, 1);
});

test('a done-or-not goal must still be checkable', async () => {
  const { svc } = setup();
  const today = await svc.today();
  const check = await svc.checkGoalDraft({ kind: 'done', title: 'Become a better parent', deadline: addDays(today, 60) });
  assert.ok(check.problems.some(p => /abstract/.test(p)));
  assert.match(check.next_question!, /yes or no/);
});

test('a count goal still needs its number', async () => {
  const { svc } = setup();
  const today = await svc.today();
  const r = await svc.setGoal({ title: '15 paying customers', deadline: addDays(today, 60) });
  assert.equal(r.ok, false);
  assert.ok(r.problems!.includes('metric missing'));
});

// ---------- countable and steps milestones ----------

async function withGoal() {
  const s = setup();
  const today = await s.svc.today();
  await s.svc.setGoal({ title: '15 paying customers', metric: 'paying customers', baseline: 0, target: 15, deadline: addDays(today, 70) });
  return { ...s, today };
}

test('a countable milestone shows its recorded value and closes at the target', async () => {
  const { svc, today } = await withGoal();
  await svc.setMilestones([
    { id: 'talk', title: 'Talk to 20 target users', metric: 'people talked to', target: 20, due: addDays(today, 20) },
    { id: 'onboarding', title: 'Implement the onboarding flow', due: addDays(today, 40) },
  ]);
  let path = await svc.getPath();
  assert.equal(path.milestones[0].kind, 'count');
  assert.equal(path.milestones[0].current, 0);
  assert.equal(path.milestones[1].kind, 'steps');
  assert.equal(path.milestones[1].pace, 'no_steps');

  const r = await svc.recordProgress(7, undefined, 'talk');
  assert.equal(r.ok, true);
  assert.match(r.speak, /7 of 20/);
  path = await svc.getPath();
  assert.equal(path.milestones[0].current, 7);
  assert.equal(path.milestones[0].progress_fraction, 0.35);
  assert.match(path.speak, /7\/20 people talked to/);
  // The goal's own number is untouched.
  assert.equal((await svc.getGoal()).current_value, 0);

  const closed = await svc.recordProgress(20, undefined, 'talk');
  assert.equal(closed.milestone_reached, true);
  assert.match(closed.speak, /Current milestone is now "Implement the onboarding flow"/);
});

test('a steps milestone takes no value; its steps are its progress', async () => {
  const { svc, today } = await withGoal();
  await svc.setMilestones([
    { id: 'onboarding', title: 'Implement the onboarding flow', kind: 'steps', due: addDays(today, 20) },
    { id: 'talk', title: 'Talk to 20 target users', metric: 'people', target: 20, due: addDays(today, 40) },
  ]);
  const r = await svc.recordProgress(3, undefined, 'onboarding');
  assert.equal(r.ok, false);
  const [a, b] = (await svc.addSteps('onboarding', [{ title: 'Build the welcome screen with 3 slides' }, { title: 'Write the agent instructions screen' }])).steps!;
  await svc.editStep(a.id, { status: 'done' });
  let path = await svc.getPath();
  assert.equal(path.milestones[0].progress_fraction, 0.5);
  assert.match(path.speak, /1\/2 steps done/);
  await svc.editStep(b.id, { status: 'done' });
  path = await svc.getPath();
  assert.equal(path.milestones[0].status, 'done', 'all steps done closes a steps milestone');
});

test('steps do not close a countable milestone', async () => {
  const { svc, today } = await withGoal();
  await svc.setMilestones([
    { id: 'talk', title: 'Talk to 20 target users', metric: 'people', target: 20, due: addDays(today, 20) },
    { id: 'later', title: 'Implement the onboarding flow', due: addDays(today, 40) },
  ]);
  const [s] = (await svc.addSteps('talk', [{ title: 'Write to 10 people from the WIP timeline' }])).steps!;
  await svc.editStep(s.id, { status: 'done' });
  assert.equal((await svc.getPath()).milestones[0].status, 'todo');
});

test('milestones saved before 0.5 keep working as steps milestones', async () => {
  const { store, svc, today } = await withGoal();
  store.path = { milestones: [{ id: 'old', title: 'AimYear Pro sellable', metric: 'launch-ready items done', target: 6, due: addDays(today, 20), status: 'todo', createdAt: new Date().toISOString() }], steps: [] } as any;
  const path = await svc.getPath();
  assert.equal(path.milestones[0].kind, 'steps');
  // Re-saving without a kind keeps it as it was.
  await svc.setMilestones([{ id: 'old', title: 'AimYear Pro sellable', metric: 'launch-ready items done', target: 6, due: addDays(today, 20) }, { id: 'n', title: 'First five', metric: 'paying customers', target: 5, due: addDays(today, 40) }]);
  const after = await svc.getPath();
  assert.equal(after.milestones[0].kind, 'steps');
  assert.equal(after.milestones[1].kind, 'count');
  // And it can be switched on purpose.
  const e = await svc.editMilestone('old', { kind: 'count' });
  assert.equal(e.ok, true);
  assert.equal((await svc.getPath()).milestones[0].kind, 'count');
});

test('a countable milestone needs a metric and a target', async () => {
  const { svc, today } = await withGoal();
  const r = await svc.setMilestones([{ title: 'Talk to people', kind: 'count', due: addDays(today, 20) }, { title: 'Ship the paywall', due: addDays(today, 40) }]);
  assert.equal(r.ok, false);
  assert.match(r.speak, /countable: it needs a metric and a target/);
});

// ---------- weekly routines ----------

const TALK = { title: 'Talk to 5 people', area: 'money' as const, leverId: 'customer-conversations', perWeek: 5 };

test('a weekly routine counts ticks and leaves the plan once the week is met', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  await svc.setRoutines([TALK]);
  // A future week, so its Monday and Tuesday can be written as already done.
  const mon = weekStart(addDays(today, 7));
  const routineId = store.routines[0].id;
  store.days.set(mon, { date: mon, mode: 'full', createdAt: '', updatedAt: '', plan: [{ id: 'a', title: TALK.title, area: 'money', routineId, isMainStep: false, estimateMin: 15, done: true, count: 3 }] });
  const tue = addDays(mon, 1);
  store.days.set(tue, { date: tue, mode: 'full', createdAt: '', updatedAt: '', plan: [{ id: 'b', title: TALK.title, area: 'money', routineId, isMainStep: false, estimateMin: 15, done: true }] });

  // 4 of 5 by Wednesday: still in the plan.
  const wed = addDays(mon, 2);
  const wedPlan = await svc.getPlan(wed);
  const item = wedPlan.plan.find(p => p.routineId === routineId)!;
  assert.ok(item, '4/5 keeps it in the plan');
  const tick = await svc.editPlanItem(item.id, wed, { count: 1 });
  assert.match(tick.speak, /5\/5 this week: the week's count is reached/);

  // Thursday: the week is met, so it is not added.
  const thu = await svc.getPlan(addDays(mon, 3));
  assert.equal(thu.plan.filter(p => p.routineId === routineId).length, 0);
  // Next Monday it comes back.
  const next = await svc.getPlan(addDays(mon, 7));
  assert.equal(next.plan.filter(p => p.routineId === routineId).length, 1);
});

test('get_now and the week summary show the weekly count', async () => {
  const { store, svc } = setup();
  await svc.setRoutines([TALK]);
  const today = await svc.today();
  const item = store.days.get(today)!.plan[0];
  await svc.editPlanItem(item.id, undefined, { count: 2 });
  const now = await svc.getNow();
  assert.equal(now.today.weekly_routines[0].done_this_week, 2);
  assert.match(now.speak, /This week: "Talk to 5 people" 2\/5/);
  const week = await svc.weekSummary();
  assert.equal(week.routines.weekly[0].per_week, 5);
  assert.match(week.speak, /Weekly counts: "Talk to 5 people" 2\/5/);
  assert.match((await svc.getRoutines()).speak, /5 a week, any day/);
});

test('count 0 unticks a weekly routine item', async () => {
  const { store, svc } = setup();
  await svc.setRoutines([TALK]);
  const today = await svc.today();
  const item = store.days.get(today)!.plan[0];
  await svc.editPlanItem(item.id, undefined, { count: 2 });
  await svc.editPlanItem(item.id, undefined, { count: 0 });
  const after = store.days.get(today)!.plan[0];
  assert.equal(after.done, false);
  assert.equal(after.count, undefined);
});
