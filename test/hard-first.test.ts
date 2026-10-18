import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

/** The ChatGPT test account on 2026-10-17: a job-switch aim whose path and Monday plan were all preparation. */
async function jobSwitch() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const today = await svc.today();
  store.commitments = [{ id: 'w', title: 'Focus window', kind: 'window', days: [1, 2, 3, 4, 5, 6, 7], minutes: 120 } as any];
  await svc.setGoal({ title: '$5,000/month from a better-paid job', metric: 'USD/month', baseline: 3900, target: 5000, deadline: addDays(today, 70) });
  await svc.setMilestones([{ id: 'm1', title: 'Send the first 10 applications', metric: 'applications sent', target: 10, due: addDays(today, 14) }, { id: 'm2', title: 'Get 3 interviews', metric: 'interviews', target: 3, due: addDays(today, 40) }]);
  return { store, svc, today };
}
const LEVERS = [
  { id: 'apply', name: 'Direct applications and outreach', kind: 'hard' as const, keywords: ['apply', 'application', 'recruiter'] },
  { id: 'assets', name: 'Career assets', kind: 'comfortable' as const, keywords: ['CV', 'LinkedIn', 'portfolio'] },
];

test('set_levers warns when the current stage starts with preparation', async () => {
  const { svc } = await jobSwitch();
  await svc.addSteps('m1', [
    { title: 'Update the CV headline and 3 achievement bullets', estimateMin: 75 },
    { title: 'Update the LinkedIn profile with 2 Flutter projects', estimateMin: 90 },
    { title: 'Send applications to the first 5 roles', estimateMin: 120 },
  ]);
  const r = await svc.setLevers(LEVERS);
  assert.equal(r.ok, true);
  assert.match(r.speak, /starts with 2 preparation step\(s\) before the first hard-lever step \("Send applications/);
});

test('add_steps is quiet when a hard step comes first', async () => {
  const { svc } = await jobSwitch();
  await svc.setLevers(LEVERS);
  const r = await svc.addSteps('m1', [
    { title: 'Apply to 2 senior Flutter roles with the current CV', leverId: 'apply', estimateMin: 45 },
    { title: 'Fix the CV headline using words from those ads', estimateMin: 40 },
  ]);
  assert.deepEqual(r.warnings, []);
});

test('set_plan warns when nothing in the day is on a hard lever, and is quiet once one is', async () => {
  const { svc, today } = await jobSwitch();
  await svc.setLevers(LEVERS);
  const prep = await svc.setPlan(today, [
    { title: 'Audit the current income sources', area: 'money', isMainStep: true, estimateMin: 30 },
    { title: 'Update the CV headline', area: 'money', estimateMin: 75 },
  ]);
  assert.equal(prep.ok, true);
  assert.match(prep.speak, /Nothing in this plan is on a hard lever \(Direct applications and outreach\)/);

  const fixed = await svc.setPlan(today, [
    { title: 'Apply to 2 roles with the current CV', area: 'money', isMainStep: true, estimateMin: 45 },
    { title: 'Update the CV headline', area: 'money', estimateMin: 40 },
  ]);
  assert.ok(!fixed.warnings!.some(w => /hard lever/.test(w)));
});
