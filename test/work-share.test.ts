import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

// A money aim files its work under "money"; the share of work must still count it as work.
test('goal share of work counts aim work in any area and never goes over 100%', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const today = await svc.today();
  await svc.setGoal({ title: '$1,000 a month from my own projects', metric: 'USD received in one month', baseline: 0, target: 1000, deadline: addDays(today, 68), area: 'money' });
  await svc.setLevers([{ id: 'talk', name: 'customer conversations', kind: 'hard' }, { id: 'code', name: 'building', kind: 'comfortable' }]);
  await svc.setProjects([{ id: 'paid', name: 'Paid work', area: 'work' }]);
  await svc.addSession({ task: 'Store listings', leverId: 'talk', area: 'money', minutes: 90, start: '09:00', end: '10:30' });
  await svc.addSession({ task: 'Client app', projectId: 'paid', area: 'work', minutes: 30, start: '11:00', end: '11:30' });
  await svc.addSession({ task: 'Kids', area: 'relations', minutes: 60, start: '18:00', end: '19:00' });
  const day = await svc.daySummary(today);
  assert.equal(day.work_attention_min, 120);
  assert.equal(day.goal_share_of_work, 0.75);
  assert.match(day.speak, /75% of work/);
  const week = await svc.weekSummary(today);
  assert.equal(week.goal_share, 0.75);
  assert.match(week.speak, /goal share 75% of work/);
});
