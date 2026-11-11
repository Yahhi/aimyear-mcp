import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService } from '../src/service.js';
import { FakeStore } from './fake-store.js';

// docs/apps.md "Two timers at once": starting while another runs is a switch to the new one.
test('start_session while another runs: the new one gets 70% from its start, the earlier time keeps its split', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const first = await svc.startSession({ task: 'Paid work: the client app', area: 'relations' });
  const second = await svc.startSession({ task: 'Write to three founders', area: 'relations' });
  assert.deepEqual(second.running_sessions!.map(r => r.share).sort(), [0.3, 0.7]);
  assert.equal(second.running_sessions!.find(r => r.id === second.session!.id)!.share, 0.7);

  const a = store.sessions.get(first.session!.id)!;
  const b = store.sessions.get(second.session!.id)!;
  assert.equal(b.weight, 0.7);
  assert.equal(a.weight, 0.3);
  assert.deepEqual(a.weightHistory, [{ until: b.start, weight: 1 }]);
  assert.equal(b.weightHistory, undefined);
});

test('start_session with an explicit weight keeps it and leaves the others alone', async () => {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'terminal-A');
  const first = await svc.startSession({ task: 'Paid work: the client app', area: 'relations' });
  const second = await svc.startSession({ task: 'Glance at a build', area: 'relations', weight: 0.2 });
  assert.equal(store.sessions.get(first.session!.id)!.weight, 1);
  assert.equal(store.sessions.get(second.session!.id)!.weight, 0.2);
});
