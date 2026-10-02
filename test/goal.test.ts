import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGoal, checkStepTitle } from '../src/domain/goal.js';

test('abstract titles and far deadlines are rejected, concrete goals pass', () => {
  assert.ok(checkGoal({ title: 'Get better at marketing' }, 'UTC').problems.length > 0);
  assert.ok(checkGoal({ title: '20 paying customers', metric: 'customers', baseline: 2, target: 20, deadline: '2030-01-01' }, 'UTC').problems.some(p => p.includes('12 months')));
  const ok = checkGoal({ title: '20 paying customers', metric: 'customers', baseline: 2, target: 20, deadline: '2027-03-01' }, 'UTC', new Date('2026-09-21T12:00:00Z'));
  assert.equal(ok.problems.length, 0);
  assert.ok(ok.pace_per_week! > 0);
});

test('vague steps are rejected, concrete steps pass', () => {
  assert.ok(checkStepTitle('do marketing'));
  assert.ok(checkStepTitle('work on the app'));
  assert.ok(checkStepTitle('improve onboarding'));
  assert.equal(checkStepTitle('Email 10 people from the waitlist'), null);
  assert.equal(checkStepTitle('Publish the landing page rewrite'), null);
});

import { classify } from '../src/domain/classify.js';
import type { Goal } from '../src/types.js';

const goal = {
  title: 'g', area: 'money', why: '', metric: 'customers', baseline: 0, target: 15,
  deadline: '2026-12-31', baselineHistory: [], createdAt: '', updatedAt: '',
  levers: [
    { id: 'posting-publicly', name: 'posting publicly', kind: 'hard' as const, examples: [], match: { keywords: ['habr', 'post'], repos: [] } },
    { id: 'building', name: 'building', kind: 'comfortable' as const, examples: [], match: { keywords: ['refactor'], repos: [] } },
  ],
  projects: [{ id: 'worklore', name: 'worklore', area: 'money' as const, match: { keywords: ['worklore'], repos: [] } }],
} as unknown as Goal;

test('naming a project does not stop a hard lever from matching the task text', () => {
  const r = classify({ area: 'work', task: 'Russian Habr version of the article', projectId: 'worklore' }, goal, null);
  assert.equal(r.classification, 'goal_hard');
  assert.equal(r.leverId, 'posting-publicly');
  assert.equal(r.projectId, 'worklore');
});

test('a project with no lever match still classifies by its area', () => {
  const r = classify({ area: 'work', task: 'tidy the backlog', projectId: 'worklore' }, goal, null);
  assert.equal(r.classification, 'goal_comfortable');
});
