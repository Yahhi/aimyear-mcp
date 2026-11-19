import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

/**
 * Production, 2026-11-06: start_session with the item id of a non-main plan item answered
 * other_project / "nothing matched", though the item carried leverId "building". Work linked
 * to a plan item takes the item's own lever, project, step and area unless the caller names its own.
 */
async function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const today = await svc.today();
  await svc.setGoal({ title: '15 paying customers', metric: 'customers', baseline: 0, target: 15, deadline: addDays(today, 200) });
  await svc.setLevers([
    { id: 'publish', name: 'Posting and outreach', kind: 'hard', keywords: ['outreach'] },
    { id: 'building', name: 'Building the product', kind: 'comfortable', keywords: ['refactor'] },
  ]);
  await svc.setProjects([{ id: 'worklore', name: 'worklore', area: 'money' }, { id: 'uar', name: 'UAR app', area: 'work' }]);
  await svc.setPlan(today, [
    { title: 'Reply to three people on Reddit', area: 'money', leverId: 'publish', isMainStep: true },
    { title: 'Pollar agent test: build the test app and grader', area: 'money', projectId: 'worklore', leverId: 'building' },
    { title: 'Write the cold email', area: 'money', leverId: 'publish' },
    { title: 'Pollar agent test: project only', area: 'money', projectId: 'worklore' },
    { title: 'Morning run', area: 'health' },
  ]);
  // The main step is done, so comfortable work is not stopped and the classification is what we read.
  const plan = store.days.get(today)!.plan;
  const [main, building, hard, projectOnly, run] = plan;
  await svc.editPlanItem(main.id, today, { done: true });
  return { store, svc, today, main, building, hard, projectOnly, run };
}

test('start_session with a non-main plan item classifies by the item\'s lever', async () => {
  const { svc, building } = await setup();
  const r: any = await svc.startSession({ task: 'Pollar agent test: build the test app and grader', itemId: building.id, workplace: 'desktop' });
  assert.equal(r.classification, 'goal_comfortable');
  assert.equal(r.unclassified, false);
  assert.match(r.matched_by, /plan item/);
  assert.equal(r.session.lever_id, 'building');
  assert.equal(r.session.project_id, 'worklore');
  assert.equal(r.session.item_id, building.id);
  assert.equal(r.session.area, 'money', 'the item\'s area, since the caller gave none');
});

test('a hard-lever plan item makes the session goal_hard', async () => {
  const { svc, hard } = await setup();
  const r: any = await svc.startSession({ task: 'Write the cold email', itemId: hard.id });
  assert.equal(r.classification, 'goal_hard');
  assert.match(r.matched_by, /plan item/);
});

test('an explicit lever, project or area wins over the item\'s own', async () => {
  const { svc, building, run } = await setup();
  const a: any = await svc.startSession({ task: 'Pollar agent test', itemId: building.id, leverId: 'publish' });
  assert.equal(a.classification, 'goal_hard');
  assert.equal(a.session.lever_id, 'publish');
  assert.equal(a.session.project_id, 'worklore', 'what the caller left out still comes from the item');
  const b: any = await svc.addSession({ task: 'Pollar agent test', itemId: run.id, area: 'work', projectId: 'uar', minutes: 20 });
  assert.equal(b.classification, 'other_project');
  assert.equal(b.session.area, 'work');
});

test('an item with only a project or only an area classifies by those', async () => {
  const { svc, projectOnly, run } = await setup();
  const a: any = await svc.addSession({ task: 'Pollar agent test', itemId: projectOnly.id, minutes: 30 });
  assert.equal(a.classification, 'goal_comfortable');
  assert.match(a.matched_by, /plan item/);
  assert.equal(a.session.project_id, 'worklore');
  const b: any = await svc.addSession({ task: 'Ran 5 km', itemId: run.id, minutes: 30 });
  assert.equal(b.classification, 'life');
  assert.match(b.matched_by, /plan item/);
});

test('add_session and add_move with a non-main item id classify from the item', async () => {
  const { svc, building, hard } = await setup();
  const s: any = await svc.addSession({ task: 'Pollar agent test: build the test app and grader', itemId: building.id, minutes: 45 });
  assert.equal(s.classification, 'goal_comfortable');
  assert.match(s.matched_by, /plan item/);
  assert.equal(s.session.lever_id, 'building');
  const m: any = await svc.addMove({ task: 'Sent the cold email', itemId: hard.id });
  assert.equal(m.classification, 'goal_hard');
  assert.match(m.matched_by, /plan item/);
  assert.equal(m.move.lever_id, 'publish');
  assert.equal(m.move.hard, true);
  assert.equal(m.move.area, 'money');
});

test('edit_session with only an item id reclassifies from the item', async () => {
  const { svc, building } = await setup();
  const s: any = await svc.addSession({ task: 'Pollar agent test: build the test app and grader', minutes: 45 });
  assert.equal(s.classification, 'other_project');
  const r: any = await svc.editSession(s.session.id, { itemId: building.id });
  assert.equal(r.session.classification, 'goal_comfortable');
  assert.equal(r.session.lever_id, 'building');
  assert.equal(r.session.project_id, 'worklore');
  assert.equal(r.session.area, 'money');
});

test('the main-step item still classifies as main_step', async () => {
  const { svc, main } = await setup();
  const r: any = await svc.startSession({ task: 'Reddit replies', itemId: main.id });
  assert.equal(r.classification, 'main_step');
  assert.equal(r.matched_by, 'plan item');
  assert.equal(r.session.lever_id, 'publish');
  assert.equal(r.session.area, 'work', 'the main step keeps its rule: area defaults to work');
});
