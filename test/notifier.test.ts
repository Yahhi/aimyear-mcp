import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDevices, textFor } from '../src/notifier.js';
import type { Device, Pending } from '../src/types.js';

const dev = (platform: Device['platform'], token = platform + '-tok'): Device => ({ token, platform, lastSeen: '2026-09-25T00:00:00Z' });
const pend = (kind: Pending['kind']): Pending => ({ id: 'p', uid: 'u', blockId: 'b', dueAt: '2026-09-25T13:00:00Z', kind, workplace: 'mobile', minutes: 25, breakMin: 5 });

test('workplace picks the matching devices, and falls back to all rather than silence', () => {
  const all = [dev('ios'), dev('macos'), dev('android')];
  assert.deepEqual(pickDevices(all, 'mobile').map(d => d.platform), ['ios', 'android']);
  assert.deepEqual(pickDevices(all, 'desktop').map(d => d.platform), ['macos']);
  assert.deepEqual(pickDevices([dev('ios')], 'desktop').map(d => d.platform), ['ios']);
});

test('the stand-up reminder names the minutes and the walk, not a streak', () => {
  const t = textFor(pend('block_end'), null);
  assert.equal(t.title, 'Stand up');
  assert.match(t.body, /25 minutes done/);
  assert.match(t.body, /Walk for 5/);
});

test('break-over text reflects whether the main step is still open', () => {
  assert.match(textFor(pend('break_end'), { title: 'Email 10 people', done: false }).body, /Main step still open: Email 10 people/);
  assert.match(textFor(pend('break_end'), { title: 'Email 10 people', done: true }).body, /done today/);
  assert.match(textFor(pend('break_end'), null).body, /Back to it/);
});
