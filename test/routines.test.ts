import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  return { store, svc };
}

/** The three daily checks Valentina set on 2026-10-16. */
const CHECKS = [
  { title: 'Talk with one person on Reddit', area: 'money' as const, leverId: 'customer-conversations' },
  { title: 'Talk with one person on WIP', area: 'money' as const, leverId: 'customer-conversations' },
  { title: 'Post a progress update', area: 'money' as const, leverId: 'posting-publicly' },
];

const isoWeekday = (date: string) => { const [y, m, d] = date.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; };

test('set_routines puts the checks in today\'s plan and get_now lists the open ones', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  const r = await svc.setRoutines(CHECKS);
  assert.equal(r.ok, true);
  const plan = store.days.get(today)!.plan;
  assert.deepEqual(plan.map(p => p.title), CHECKS.map(c => c.title));
  assert.ok(plan.every(p => p.routineId && !p.isMainStep && p.estimateMin === 15));

  const now = await svc.getNow();
  assert.equal(now.today.routines.total, 3);
  assert.match(now.speak, /Routines still open today: "Talk with one person on Reddit"/);

  for (const p of plan) await svc.editPlanItem(p.id, undefined, { done: true });
  const after = await svc.getNow();
  assert.equal(after.today.routines.done, 3);
  assert.match(after.speak, /Routines all done today/);
});

test('set_plan keeps routine items the agent leaves out, and links one it names again', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  await svc.setRoutines(CHECKS);
  const wip = store.days.get(today)!.plan.find(p => p.title === 'Talk with one person on WIP')!;
  await svc.editPlanItem(wip.id, undefined, { done: true });

  // The agent re-plans and names only one of the checks, in its own words of case.
  await svc.setPlan(undefined, [
    { title: 'Prepare AimYear views for the MCP widget', area: 'money', isMainStep: true },
    { title: 'post a progress update', area: 'money' },
  ]);
  const plan = store.days.get(today)!.plan;
  assert.equal(plan.length, 4, 'main step + 3 checks, no duplicates');
  assert.equal(plan.filter(p => p.routineId).length, 3);
  assert.equal(plan.find(p => p.title === 'Talk with one person on WIP')!.done, true, 'a ticked check stays ticked');
});

test('delete_plan_item skips a routine for that day only', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  await svc.setRoutines(CHECKS);
  const reddit = store.days.get(today)!.plan.find(p => p.title.includes('Reddit'))!;
  const r = await svc.deletePlanItem(reddit.id);
  assert.match(r.speak, /skipped for this day only/);
  const plan = (await svc.getPlan()).plan;
  assert.equal(plan.length, 2);
  assert.ok(!plan.some(p => p.title.includes('Reddit')));
  // Tomorrow it is back.
  const tomorrow = (await svc.getPlan(addDays(today, 1))).plan;
  assert.equal(tomorrow.length, 3);
});

test('routines leave past days alone and respect their weekdays', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  const yesterday = addDays(today, -1);
  store.days.set(yesterday, { date: yesterday, mode: 'full', plan: [], createdAt: '', updatedAt: '' });
  const other = ((isoWeekday(today) % 7) + 1); // tomorrow's weekday, never today's
  await svc.setRoutines([{ ...CHECKS[0], days: [isoWeekday(today)] }, { ...CHECKS[1], days: [other] }]);
  assert.deepEqual((await svc.getPlan(yesterday)).plan, []);
  assert.deepEqual((await svc.getPlan()).plan.map(p => p.title), [CHECKS[0].title]);
  assert.deepEqual((await svc.getPlan(addDays(today, 1))).plan.map(p => p.title), [CHECKS[1].title]);
});

test('removing a routine drops today\'s unticked item but keeps a ticked one', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  await svc.setRoutines(CHECKS);
  const post = store.days.get(today)!.plan.find(p => p.title === 'Post a progress update')!;
  await svc.editPlanItem(post.id, undefined, { done: true });
  const kept = (await svc.getRoutines()).routines.filter(r => r.title.includes('WIP'));
  await svc.setRoutines(kept);
  const titles = store.days.get(today)!.plan.map(p => p.title).sort();
  assert.deepEqual(titles, ['Post a progress update', 'Talk with one person on WIP']);
});

test('a day with tracking off gets no routines', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  await svc.setDayMode(addDays(today, 1), 'off');
  await svc.setRoutines(CHECKS);
  assert.deepEqual((await svc.getPlan(addDays(today, 1))).plan, []);
  assert.equal(store.days.get(today)!.plan.length, 3);
});

test('summarize_week counts the checks', async () => {
  const { store, svc } = setup();
  const today = await svc.today();
  await svc.setRoutines(CHECKS);
  const plan = store.days.get(today)!.plan;
  await svc.editPlanItem(plan[0].id, undefined, { done: true });
  const w = await svc.weekSummary();
  assert.equal(w.routines.done, 1);
  assert.equal(w.routines.total, 3);
  assert.equal(w.routines.days_all_done, 0);
  assert.match(w.speak, /Routines all done on 0\/1 days \(1\/3 checks\)/);
});
