import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

// docs/path-tracks.md: up to 3 tracks, every one leading to the same aim.

async function twoBets() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const today = await svc.today();
  await svc.setGoal({ title: '$1,000 a month from my own projects', metric: 'USD received in one month', baseline: 0, target: 1000, deadline: addDays(today, 68) });
  await svc.setLevers([{ id: 'talk', name: 'customer conversations', kind: 'hard' }, { id: 'code', name: 'building', kind: 'comfortable' }]);
  await svc.setMilestones([
    { id: 'old', title: 'Plate cleared', due: addDays(today, -15) },
    { id: 'sellable', title: 'Pro sellable', due: addDays(today, 21) },
    { id: 'offer', title: 'An offer a company can say yes to', due: addDays(today, 21) },
    { id: 'launch', title: 'December launch', metric: 'yearly plans sold in December', target: 24, due: addDays(today, 67) },
    { id: 'pilot', title: 'First paid pilot', metric: 'USD paid for a pilot', target: 1000, due: addDays(today, 67) },
  ]);
  await svc.editMilestone('old', { status: 'retired' });
  return { store, svc, today };
}

test('set_tracks groups the stages; each track has its own current stage', async () => {
  const { svc } = await twoBets();
  const r = await svc.setTracks([
    { id: 'aimyear', title: 'AimYear', reach: 'about 24 yearly plans sold in December', milestoneIds: ['sellable', 'launch'] },
    { id: 'worklore', title: 'Worklore', reach: 'one company paying for a pilot', milestoneIds: ['offer', 'pilot'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const path = await svc.getPath();
  assert.deepEqual(path.tracks.map(t => [t.id, t.current_milestone_id, t.milestone_ids]), [['aimyear', 'sellable', ['sellable', 'launch']], ['worklore', 'offer', ['offer', 'pilot']]]);
  assert.equal(path.milestones[0].id, 'old', 'the retired stage stays, outside the tracks');
  assert.match(path.speak, /2 tracks to the aim, each able to reach it alone/);
  assert.match(path.speak, /Worklore \(one company paying for a pilot\): now "An offer a company can say yes to"/);
});

test('a stage\'s pace counts from the previous stage of its own track', async () => {
  const { svc, today } = await twoBets();
  await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }, { id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }]);
  const path = await svc.getPath();
  const pilot = path.milestones.find(m => m.id === 'pilot')!;
  // From "offer" (due in 21 days) to its own due in 67: no time has passed yet in this track.
  assert.equal(pilot.time_elapsed_fraction, 0);
  assert.equal(path.milestones.find(m => m.id === 'launch')!.days_left, 67);
  void today;
});

test('next_steps takes candidates from every track in turns, each track in path order', async () => {
  const { svc } = await twoBets();
  await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }, { id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }]);
  await svc.addSteps('sellable', [{ title: 'Write the store listings', leverId: 'talk' }, { title: 'Test a sandbox purchase', leverId: 'code' }, { title: 'Submit to review', leverId: 'talk' }]);
  await svc.addSteps('offer', [{ title: 'Write a one-page offer', leverId: 'talk' }]);
  const r = await svc.nextSteps(3);
  // 2026-10-30: "Submit to review" (hard) used to jump ahead of the undone sandbox test.
  assert.deepEqual(r.steps.map(s => [s.track, s.title]), [['AimYear', 'Write the store listings'], ['Worklore', 'Write a one-page offer'], ['AimYear', 'Test a sandbox purchase']]);
  assert.equal(r.steps[2].after, 'Write the store listings');
  assert.deepEqual(r.milestones.map(m => m.id), ['sellable', 'offer']);
  assert.match(r.speak, /from every track/);
});

test('closing a stage moves only its own track on', async () => {
  const { svc } = await twoBets();
  await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }, { id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }]);
  const r = await svc.editMilestone('offer', { status: 'done' });
  assert.match(r.speak, /Next in Worklore: "First paid pilot"/);
  const path = await svc.getPath();
  assert.deepEqual(path.tracks.map(t => t.current_milestone_id), ['sellable', 'pilot']);
});

test('the rules hold: every open stage needs a track, due dates in order within a track, at most 3 tracks', async () => {
  const { svc, store } = await twoBets();
  const before = JSON.stringify(store.path);
  const loose = await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }]);
  assert.equal(loose.ok, false);
  assert.match(loose.problems!.join(), /every open milestone needs a track: "An offer a company can say yes to", "First paid pilot"/);
  const order = await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['launch', 'sellable'] }, { id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }]);
  assert.match(order.problems!.join(), /"Pro sellable" is due before the previous one in track "AimYear"/);
  const four = await svc.setTracks([1, 2, 3, 4].map(i => ({ title: `Track ${i}` })));
  assert.match(four.problems!.join(), /at most 3 tracks/);
  assert.equal(JSON.stringify(store.path), before, 'a refused change saves nothing');
  const noTracks = await svc.editMilestone('offer', { trackId: 'w' });
  assert.equal(noTracks.ok, false);
});

test('set_milestones keeps a stage\'s track; an empty set_tracks makes the path one list again', async () => {
  const { svc, today } = await twoBets();
  await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }, { id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }]);
  const path = await svc.getPath();
  const r = await svc.setMilestones(path.milestones.map(m => ({ id: m.id, title: m.title, due: m.due, metric: m.metric, target: m.target })));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.speak, /Now add concrete steps for "Pro sellable" and "An offer a company can say yes to"/);
  assert.deepEqual((await svc.getPath()).tracks.map(t => t.milestone_ids.length), [2, 2]);
  const added = await svc.setMilestones([...path.milestones.map(m => ({ id: m.id, title: m.title, due: m.due, metric: m.metric, target: m.target })), { title: 'Second pilot', due: addDays(today, 60) }]);
  assert.equal(added.ok, false, 'a new open stage needs a track');
  const off = await svc.setTracks([]);
  assert.equal(off.ok, true);
  assert.deepEqual((await svc.getPath()).tracks, []);
  assert.equal((await svc.getPath()).current_milestone_id, 'sellable');
});

test('without tracks the path works as before, and the speak names the first open stage', async () => {
  const { svc, today } = await twoBets();
  const r = await svc.setMilestones([{ id: 'old', title: 'Plate cleared', due: addDays(today, -15) }, { id: 'sellable', title: 'Pro sellable', due: addDays(today, 21) }]);
  assert.match(r.speak, /Now add concrete steps for "Pro sellable"/, 'not the retired one');
  const late = await svc.setMilestones([{ title: 'B', due: addDays(today, 30) }, { title: 'A', due: addDays(today, 10) }]);
  assert.match(late.problems!.join(), /"A" is due before the previous one/);
});

test('the track whose next step is hard goes first', async () => {
  const { svc } = await twoBets();
  await svc.setTracks([{ id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }, { id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }]);
  await svc.addSteps('sellable', [{ title: 'Deploy the server', leverId: 'code' }]);
  await svc.addSteps('offer', [{ title: 'Write a one-page offer', leverId: 'talk' }]);
  const r = await svc.nextSteps(2);
  assert.deepEqual(r.steps.map(s => s.title), ['Write a one-page offer', 'Deploy the server']);
});

// 2026-10-30: the plan moved on to "Email 10 of them" while "List 20 companies" and the day before's main step were undone.
async function worklorePath() {
  const { svc, store, today } = await twoBets();
  store.commitments = [{ id: 'w', title: 'Focus window', kind: 'window', days: [1, 2, 3, 4, 5, 6, 7], minutes: 120 } as any];
  await svc.setTracks([{ id: 'w', title: 'Worklore', milestoneIds: ['offer', 'pilot'] }, { id: 'a', title: 'AimYear', milestoneIds: ['sellable', 'launch'] }]);
  const added = await svc.addSteps('offer', [{ title: 'Write a one-page offer', leverId: 'talk' }, { title: 'Send the offer to 3 founders', leverId: 'talk' }]);
  const later = await svc.addSteps('pilot', [{ title: 'Email 10 companies', leverId: 'talk' }]);
  const [write, send] = added.steps!.map(s => s.id);
  return { svc, today, write, send, email: later.steps![0].id };
}

test('set_plan warns when the main step skips an undone earlier step or a stage', async () => {
  const { svc, today, write, send, email } = await worklorePath();
  const skip = await svc.setPlan(today, [{ title: 'Send the offer to 3 founders', area: 'money', stepId: send, isMainStep: true }]);
  assert.equal(skip.ok, true);
  assert.match(skip.speak, /comes after 1 undone step\(s\) of its stage: "Write a one-page offer"/);
  const stage = await svc.setPlan(today, [{ title: 'Email 10 companies', area: 'money', stepId: email, isMainStep: true }]);
  assert.match(stage.speak, /is in stage "First paid pilot", but the current stage of its track is "An offer a company can say yes to"/);
  const fine = await svc.setPlan(today, [{ title: 'Write a one-page offer', area: 'money', stepId: write, isMainStep: true }]);
  assert.ok(!fine.warnings!.some(w => /undone step|current stage/.test(w)), JSON.stringify(fine.warnings));
});

test('an undone main step is offered again the next day', async () => {
  const { svc, today, write } = await worklorePath();
  await svc.setPlan(today, [{ title: 'Write a one-page offer', area: 'money', stepId: write, isMainStep: true }]);
  const ctx = await svc.getPlanningContext(addDays(today, 1));
  assert.equal(ctx.carry_over?.title, 'Write a one-page offer');
  assert.match(ctx.speak, /is not done: "Write a one-page offer"\. Plan it again as the main step/);
  const day = await svc.getPlan(today);
  await svc.editPlanItem(day.plan[0].id, today, { done: true });
  assert.equal((await svc.getPlanningContext(addDays(today, 1))).carry_over, null);
});
