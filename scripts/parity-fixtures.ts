/**
 * docs/app-data.md: the app computes its numbers on the device with the server's
 * formulas. This runs the server's own functions on shared examples and writes their
 * answers to the app's test/fixtures/server_parity.json; the app's test/parity_test.dart
 * must give the same. Rerun after changing src/domain/attention.ts or insights.ts:
 *   npx tsx scripts/parity-fixtures.ts ../aimyear-v2/test/fixtures/server_parity.json
 */
import { writeFileSync } from 'node:fs';
import { computeAttention } from '../src/domain/attention.js';
import { computeComebacks, computeInsights, type InsightRow } from '../src/domain/insights.js';
import type { Session } from '../src/types.js';

const out = process.argv[2] ?? '../aimyear-v2/test/fixtures/server_parity.json';
const S = (id: string, start: string, end: string | undefined, extra: Partial<Session> = {}) => ({ id, start, end, weight: 1, ...extra }) as Session;

const attentionCases = [
  { name: 'two sessions overlap for half an hour', window: ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'], now: '2026-10-20T20:00:00Z',
    sessions: [S('a', '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z'), S('b', '2026-10-20T09:30:00Z', '2026-10-20T11:00:00Z')] },
  { name: 'weights 3:1 and a running session counted up to now', window: ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'], now: '2026-10-20T12:00:00Z',
    sessions: [S('a', '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z', { weight: 3 }), S('b', '2026-10-20T10:00:00Z', undefined)] },
  { name: 'an exclusive session takes all the attention while it runs', window: ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'], now: '2026-10-20T20:00:00Z',
    sessions: [S('a', '2026-10-20T09:00:00Z', '2026-10-20T11:00:00Z'), S('b', '2026-10-20T09:30:00Z', '2026-10-20T10:00:00Z', { exclusive: true }), S('c', '2026-10-20T10:30:00Z', '2026-10-20T12:00:00Z', { weight: 0 })] },
  { name: 'a session across midnight is clipped to the day', window: ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'], now: '2026-10-21T08:00:00Z',
    sessions: [S('a', '2026-10-19T23:00:00Z', '2026-10-20T01:00:00Z'), S('b', '2026-10-20T23:30:00Z', '2026-10-21T02:00:00Z')] },
  { name: 'a switch to 70/30 halfway keeps the equal split before it', window: ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'], now: '2026-10-20T12:00:00Z',
    sessions: [S('a', '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z', { weight: 0.7, weightHistory: [{ until: '2026-10-20T10:30:00Z', weight: 1 }] }),
      S('b', '2026-10-20T10:00:00Z', undefined, { weight: 0.3, weightHistory: [{ until: '2026-10-20T10:30:00Z', weight: 1 }] })] },
].map(c => {
  const r = computeAttention(c.sessions, new Date(c.window[0]), new Date(c.window[1]), new Date(c.now));
  return { ...c, attention: Object.fromEntries(r.attention), wall: Object.fromEntries(r.wall) };
});

const rows: InsightRow[] = [
  { date: '2026-10-05', from: '09:00', wall_min: 40, classification: 'goal_hard', area: 'money', lever_id: 'outreach' },
  { date: '2026-10-14', from: '07:05', wall_min: 42, classification: 'goal_hard', area: 'money', lever_id: 'outreach' },
  { date: '2026-10-15', from: '22:40', wall_min: 95, classification: 'goal_comfortable', area: 'work', lever_id: 'build' },
  { date: '2026-10-16', from: '10:00', wall_min: 5, classification: 'main_step', area: 'money', outcome: 'done' },
  { date: '2026-10-18', from: '11:20', wall_min: 30, classification: 'other_project', area: 'work' },
  { date: '2026-10-19', from: '18:00', wall_min: 60, classification: 'life', area: 'health' },
  { date: '2026-10-20', from: '08:00', wall_min: 24, classification: 'goal_comfortable', area: 'work', lever_id: 'build' },
  { date: '2026-10-20', from: '13:30', wall_min: 50, classification: 'main_step', area: 'money' },
  { date: '2026-10-20', from: '15:00', wall_min: null, classification: 'goal_hard', area: 'money', lever_id: 'outreach' },
  { date: '2026-10-20', from: '16:00', wall_min: 3, classification: 'goal_hard', area: 'money', lever_id: 'nolever' },
];
const kinds: Record<string, 'hard' | 'comfortable'> = { outreach: 'hard', build: 'comfortable' };
const mainStepDays = ['2026-10-16', '2026-10-20'];
const insightsCases = [
  { name: 'week', from: '2026-10-14', to: '2026-10-20' },
  { name: 'month', from: '2026-09-21', to: '2026-10-20' },
].map(c => ({ ...c, result: computeInsights({ from: c.from, to: c.to, rows: rows.filter(r => r.date >= c.from), leverKind: id => (id ? kinds[id] : undefined), mainStepDays: new Set(mainStepDays) }) }));

writeFileSync(out, JSON.stringify({
  note: 'Written by aimyear-mcp scripts/parity-fixtures.ts from the server\'s own functions. Do not edit by hand.',
  attention: attentionCases,
  insights: { rows, lever_kinds: kinds, main_step_days: mainStepDays, cases: insightsCases },
  comebacks: { today: '2026-10-20', result: computeComebacks('2026-10-20', rows) },
}, null, 1) + '\n');
console.log(`wrote ${out}`);
