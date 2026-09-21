import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAttention, findGaps } from '../src/domain/attention.js';
import type { Session } from '../src/types.js';

const base = (id: string, start: string, end: string | undefined, extra: Partial<Session> = {}): Session => ({
  id, start, end, source: 'agent', weight: 1, workplace: 'desktop', area: 'work', task: id, notes: [], classification: 'other_project', verdictAtStart: 'ok', ...extra,
});
const W0 = new Date('2026-09-21T00:00:00Z'), W1 = new Date('2026-09-22T00:00:00Z');

test('two equal sessions over the same hour get 30 attention minutes each, 60 wall each', () => {
  const r = computeAttention([base('a', '2026-09-21T10:00:00Z', '2026-09-21T11:00:00Z'), base('b', '2026-09-21T10:00:00Z', '2026-09-21T11:00:00Z')], W0, W1);
  assert.equal(Math.round(r.attention.get('a')!), 30);
  assert.equal(Math.round(r.attention.get('b')!), 30);
  assert.equal(Math.round(r.wall.get('a')!), 60);
});

test('weights split proportionally, partial overlap keeps full attention outside the overlap', () => {
  const r = computeAttention([
    base('a', '2026-09-21T10:00:00Z', '2026-09-21T12:00:00Z', { weight: 3 }),
    base('b', '2026-09-21T11:00:00Z', '2026-09-21T12:00:00Z', { weight: 1 }),
  ], W0, W1);
  assert.equal(Math.round(r.attention.get('a')!), 60 + 45);
  assert.equal(Math.round(r.attention.get('b')!), 15);
  const total = [...r.attention.values()].reduce((s, v) => s + v, 0);
  assert.equal(Math.round(total), 120);
});

test('exclusive session takes all attention while it runs', () => {
  const r = computeAttention([
    base('a', '2026-09-21T10:00:00Z', '2026-09-21T12:00:00Z'),
    base('call', '2026-09-21T10:30:00Z', '2026-09-21T11:00:00Z', { exclusive: true }),
  ], W0, W1);
  assert.equal(Math.round(r.attention.get('call')!), 30);
  assert.equal(Math.round(r.attention.get('a')!), 90);
});

test('running session is clipped at now; three-way overlap is reported', () => {
  const now = new Date('2026-09-21T10:30:00Z');
  const r = computeAttention([
    base('a', '2026-09-21T10:00:00Z', undefined), base('b', '2026-09-21T10:00:00Z', undefined), base('c', '2026-09-21T10:10:00Z', undefined),
  ], W0, W1, now);
  assert.equal(Math.round(r.wall.get('a')!), 30);
  assert.equal(r.overlaps.length, 1);
  assert.equal(r.overlaps[0].count, 3);
});

test('gaps between sessions of at least 20 minutes are found', () => {
  const g = findGaps([base('a', '2026-09-21T09:00:00Z', '2026-09-21T10:00:00Z'), base('b', '2026-09-21T10:05:00Z', '2026-09-21T10:30:00Z'), base('c', '2026-09-21T12:00:00Z', '2026-09-21T13:00:00Z')], W0, W1);
  assert.equal(g.length, 1);
  assert.equal(g[0].minutes, 90);
});
