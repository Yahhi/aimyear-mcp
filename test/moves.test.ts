import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays, weekStart } from '../src/dates.js';
import { buildDraft } from '../src/social/draft.js';
import { FakeStore } from './fake-store.js';

/** Valentina's case on 2026-11-05: small changes described to the agent away from the desk, and people who don't want hours. */
async function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const today = await svc.today();
  await svc.setGoal({ title: '15 paying customers', metric: 'customers', baseline: 0, target: 15, deadline: addDays(today, 200) });
  await svc.setLevers([
    { id: 'publish', name: 'Posting and outreach', kind: 'hard', keywords: ['post', 'outreach', 'wip'] },
    { id: 'build', name: 'Building the product', kind: 'comfortable', keywords: ['fix', 'landing'] },
  ]);
  return { store, svc, today };
}

test('add_move records a step toward the aim with no duration, and the day review counts it', async () => {
  const { store, svc, today } = await setup();
  const r = await svc.addMove({ task: 'Posted the search-visibility update on WIP', leverId: 'publish' });
  assert.equal(r.ok, true);
  assert.equal(r.move!.toward_aim, true);
  assert.equal(r.move!.hard, true);
  assert.equal(store.moves.size, 1);
  assert.equal(store.sessions.size, 0, 'a move is not a session: no minutes are stored');
  assert.match(r.speak!, /Move recorded for today: "Posted the search-visibility update on WIP", toward the aim, on the hard part/);

  const day = await svc.daySummary(today);
  assert.equal(day.aim_moves, 1);
  assert.equal(day.hard_moves, 1);
  assert.equal(day.hard_lever_touched, true, 'a hard move touches the hard lever');
  assert.match(day.speak, /1 move\(s\) toward the aim/);
});

test('a move classifies from its text like a session, and a past day is fine', async () => {
  const { svc, today } = await setup();
  const r = await svc.addMove({ task: 'fix the signup button text on the landing page', date: addDays(today, -2) });
  assert.equal(r.move!.classification, 'goal_comfortable');
  assert.equal(r.move!.date, addDays(today, -2));
  await assert.rejects(() => svc.addMove({ task: 'tomorrow', date: addDays(today, 1) }), /in the future/);
  await assert.rejects(() => svc.addMove({ task: '  ' }), /say what changed/);
});

test('completes_item ticks the main step, so a move can finish the day\'s first step', async () => {
  const { store, svc, today } = await setup();
  await svc.setPlan(today, [{ title: 'Post one progress update', area: 'money', leverId: 'publish', isMainStep: true }]);
  const item = store.days.get(today)!.plan[0];
  const r = await svc.addMove({ task: 'Posted the update from the phone', itemId: item.id, completesItem: true });
  assert.equal(r.move!.classification, 'main_step');
  assert.equal(store.days.get(today)!.plan[0].done, true);
  assert.equal((await svc.streak()).today_done, true);
  await assert.rejects(() => svc.addMove({ task: 'x', completesItem: true }), /completes_item needs item_id/);
});

test('list_moves and delete_move', async () => {
  const { svc } = await setup();
  const a = await svc.addMove({ task: 'post on WIP' });
  await svc.addMove({ task: 'called mum', area: 'relations' });
  const l = await svc.listMoves();
  assert.equal(l.count, 2);
  assert.equal(l.toward_aim, 1);
  await svc.deleteMove(a.move!.id);
  assert.equal((await svc.listMoves()).count, 1);
  await assert.rejects(() => svc.deleteMove('nope'), /not found/);
});

test('a day switched off stores no move', async () => {
  const { store, svc, today } = await setup();
  await svc.setDayMode(today, 'off');
  const r = await svc.addMove({ task: 'post on WIP' });
  assert.equal(r.ok, false);
  assert.equal(store.moves.size, 0);
});

test('tracking moves: no timer and no minutes, start_session and add_session point to add_move', async () => {
  const { store, svc } = await setup();
  const s = await svc.setSettings({ tracking: 'moves' });
  assert.equal(s.tracking, 'moves');
  await assert.rejects(() => svc.startSession({ task: 'write the post' }), /You record moves, not time/);
  await assert.rejects(() => svc.addSession({ task: 'write the post', minutes: 30 }), /add_move/);
  assert.equal(store.sessions.size, 0);
  assert.equal((await svc.addMove({ task: 'post on WIP' })).ok, true);
});

test('switching to moves waits until no session is running', async () => {
  const { svc } = await setup();
  await svc.startSession({ task: 'write the post' });
  await assert.rejects(() => svc.setSettings({ tracking: 'moves' }), /A session is running/);
});

test('quiet numbers: the record is kept, but the reviews say no minutes and no percentages', async () => {
  const { svc, today } = await setup();
  await svc.addSession({ task: 'outreach on WIP', minutes: 40 });
  await svc.addMove({ task: 'post on WIP' });
  await svc.setSettings({ tracking: 'quiet' });
  const day = await svc.daySummary(today);
  assert.equal(day.quiet_numbers, true);
  assert.ok(day.goal_attention_min >= 40, 'the minutes are still in the record');
  for (const speak of [day.speak, (await svc.weekSummary(today)).speak, (await svc.getInsights('week')).speak, (await svc.getNow()).speak]) {
    assert.doesNotMatch(speak, /\bmin\b|%|minutes/, speak);
  }
  assert.match(day.speak, /1 move\(s\) toward the aim, 1 on the hard part, and focused time on the aim/);
});

test('the weekly target counts days toward the aim, and weeks in a row', async () => {
  const { store, svc, today } = await setup();
  await svc.setSettings({ weekly_target: 2 });
  const monday = weekStart(today);
  const lastMonday = addDays(monday, -7);
  // Last week: two days with a move toward the aim, one day with only life.
  for (const d of [lastMonday, addDays(lastMonday, 2)]) await svc.addMove({ task: 'post on WIP', date: d });
  await svc.addMove({ task: 'called mum', area: 'relations', date: addDays(lastMonday, 3) });
  // This week: today only.
  await svc.addMove({ task: 'post on WIP' });
  await svc.addMove({ task: 'outreach on Reddit' });
  const w = await svc.weekProgress(today);
  assert.equal(w.target, 2);
  assert.equal(w.days, 1, 'two moves on one day are one day');
  assert.equal(w.met, false);
  assert.equal(w.weeks_in_a_row, 1, 'last week met the target');
  assert.match(w.speak, /This week: 1 of 2 days toward the aim/);
  await svc.setSettings({ weekly_target: 1 });
  assert.match((await svc.weekProgress(today)).speak, /This week: 1 day toward the aim, target of 1 met\./, 'never "5 of 4 days" once the target is passed');
  await svc.setSettings({ weekly_target: 2 });

  // A day switched off never counts, even with the main step done.
  const prev = addDays(today, -1);
  if (prev >= monday) {
    store.days.set(prev, { date: prev, mode: 'off', plan: [{ id: 'x', title: 't', area: 'money', isMainStep: true, estimateMin: 15, done: true }], createdAt: '', updatedAt: '' });
    assert.equal((await svc.weekProgress(today)).days, 1);
  }
  await assert.rejects(() => svc.setSettings({ weekly_target: 9 }), /1 to 7/);
  assert.equal((await svc.getSettings()).weekly_target, 2);
});

test('ten minutes of sessions on the aim make a day count; the default target is 4', async () => {
  const { svc, today } = await setup();
  await svc.addSession({ task: 'outreach on WIP', minutes: 12 });
  const w = await svc.weekProgress(today);
  assert.equal(w.target, 4);
  assert.equal(w.days, 1);
  const now = await svc.getNow();
  assert.equal(now.week.days, 1);
  assert.match(now.speak, /This week: 1 of 4 days toward the aim/);
});

test('the progress post: moves and the week in time mode, no minutes in quiet mode', () => {
  const base = { aim: { title: '15 paying customers', kind: 'count' as const, current: 2, target: 15 }, mainStep: { planned: true, done: true, title: 'Post one update' }, routines: { full: 0, minimum: 0, missed: 0 }, week: { days: 3, target: 4 } };
  const time = buildDraft({ ...base, goalMin: 50, hardMin: 20, moves: { aim: 2, hard: 1 } });
  assert.match(time, /50 min on the aim/);
  assert.match(time, /2 moves toward the aim, 1 on the hard part\./);
  assert.match(time, /This week: 3 of 4 days toward the aim\./);
  const quiet = buildDraft({ ...base, goalMin: 50, hardMin: 20, moves: { aim: 1, hard: 0 }, quiet: true });
  assert.doesNotMatch(quiet, /\bmin\b/);
  assert.match(quiet, /1 move toward the aim\./);
  const none = buildDraft({ ...base, goalMin: 0, hardMin: 0, quiet: true });
  assert.match(none, /No moves toward the aim today\./);
});
