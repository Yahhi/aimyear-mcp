/**
 * docs/metrics.md: the same number is the same everywhere. These tests build one day of
 * record and read it through every place that shows it: summarize_day, summarize_week,
 * get_insights, the weekly email's numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService, RAW } from '../src/service.js';
import { FakeStore } from './fake-store.js';
import type { Goal, Session } from '../src/types.js';

const GOAL = { title: 'g', area: 'money', levers: [
  { id: 'out', name: 'outreach', kind: 'hard', examples: [], match: { repos: [], keywords: [] } },
  { id: 'build', name: 'build', kind: 'comfortable', examples: [], match: { repos: [], keywords: [] } },
], projects: [] } as unknown as Goal;

function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'conn');
  store.goal = GOAL;
  const add = (id: string, start: string, min: number, s: Partial<Session>) => {
    const t = new Date(start);
    store.sessions.set(id, { id, start: t.toISOString(), end: new Date(t.getTime() + min * 60000).toISOString(), source: 'agent', weight: 1, workplace: 'desktop', area: 'work', task: id, notes: [], classification: 'goal_hard', verdictAtStart: 'ok', ...s });
  };
  return { store, svc, add };
}

test('insights count attention minutes: two aim sessions at once are 60 minutes, as in summarize_day', async () => {
  const { svc, add } = setup();
  add('a', '2026-10-14T12:00:00Z', 60, { classification: 'goal_comfortable', leverId: 'build' });
  add('b', '2026-10-14T12:00:00Z', 60, { classification: 'goal_hard', leverId: 'out' });
  const date = (await svc.history('2026-10-13', '2026-10-15')).sessions[0].date;
  const day = await svc.daySummary(date);
  const ins = await svc.getInsights('week', date);
  assert.equal(day.goal_attention_min, 60);
  assert.equal(ins.totals.aim_min, 60, 'wall minutes would say 120');
  assert.equal(ins.hard_share, day.hard_share_of_goal);
  assert.equal(ins.hard_share, 0.5);
});

test('one rule for hard: a main step on a comfortable lever is not hard, anywhere', async () => {
  const { svc, add } = setup();
  add('m', '2026-10-14T10:00:00Z', 60, { classification: 'main_step', leverId: 'build' });
  add('h', '2026-10-14T12:00:00Z', 30, { classification: 'goal_hard' }); // no lever: the classification decides
  const date = (await svc.history('2026-10-13', '2026-10-15')).sessions[0].date;
  const day = await svc.daySummary(date);
  const week = await svc.weekSummary(date);
  const ins = await svc.getInsights('week', date);
  assert.equal(day.hard_attention_min, 30);
  assert.equal(day.hard_share_of_goal, 0.33);
  assert.equal(ins.hard_share, 0.33);
  assert.equal(week.hard_share, 0.33);
});

test('the week pools exact minutes: 49 hard of 171 stays 49, not 50 rebuilt from a rounded share', async () => {
  const { svc, add } = setup();
  add('h', '2026-10-14T08:00:00Z', 49, { classification: 'goal_hard' });
  add('c', '2026-10-14T10:00:00Z', 122, { classification: 'goal_comfortable' });
  const date = (await svc.history('2026-10-13', '2026-10-15')).sessions[0].date;
  const day = await svc.daySummary(date);
  assert.equal(day.hard_share_of_goal, 0.29);
  assert.equal(Math.round(day.goal_attention_min * day.hard_share_of_goal), 50, 'the old weekly rebuild');
  const week = await svc.weekSummary(date);
  assert.equal(week.hard_attention_min, 49);
  assert.equal(week.hard_share, 0.29);
  assert.equal(day[RAW].hard, 49);
  assert.ok(!JSON.stringify(day).includes('"byArea"'), 'the exact sums stay out of tool results');
});
