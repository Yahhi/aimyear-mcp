/**
 * Calendar events read by the user's own agent (docs/calendar-sync.md): add_session and
 * set_commitments carry the event's calendar_event_id, and the server never logs the same
 * event twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AimService } from '../src/service.js';
import { buildServer } from '../src/http.js';
import { addDays } from '../src/dates.js';
import { FakeStore } from './fake-store.js';

async function setup() {
  const store = new FakeStore();
  const svc = new AimService(store as any, 'calendar-test');
  const today = await svc.today();
  await svc.setGoal({ title: 'A job as a mobile developer', metric: 'offers', baseline: 0, target: 1, deadline: addDays(today, 200) });
  await svc.setLevers([{ id: 'applying', name: 'applying and interviews', kind: 'hard', keywords: ['interview'] }]);
  return { store, svc, today };
}

const SCHOOL = { title: 'Children to their classes', area: 'relations' as const, days: [2, 4], start: '16:30', minutes: 90 };

test('add_session keeps the calendar event id and refuses the same event a second time', async () => {
  const { store, svc, today } = await setup();
  const first = await svc.addSession({ task: 'Interview with Acme', start: '10:00', end: '11:00', date: today, leverId: 'applying', calendarEventId: 'evt-acme-1' }) as any;
  assert.equal(first.ok, true);
  assert.equal(store.sessions.get(first.session.id)!.calendarEventId, 'evt-acme-1');
  assert.equal(first.session.calendar_event_id, 'evt-acme-1');

  const writes = store.sessions.size;
  const again = await svc.addSession({ task: 'Acme interview', minutes: 60, calendarEventId: 'evt-acme-1' }) as any;
  assert.equal(again.ok, false);
  assert.equal(again.speak, `This calendar event is already logged: Interview with Acme on ${today}. Use edit_session to change it.`);
  assert.deepEqual(again.already_logged, { session_id: first.session.id, task: 'Interview with Acme', date: today });
  assert.equal(store.sessions.size, writes, 'nothing stored');

  // Another event, or time with no event, is logged as usual.
  assert.equal(((await svc.addSession({ task: 'Interview with Beta', minutes: 45, calendarEventId: 'evt-beta-1' })) as any).ok, true);
  assert.equal(((await svc.addSession({ task: 'Applications', minutes: 30 })) as any).ok, true);
  // Once the session is deleted, the event can be logged again.
  await svc.deleteSession(first.session.id);
  assert.equal(((await svc.addSession({ task: 'Interview with Acme', minutes: 60, calendarEventId: 'evt-acme-1' })) as any).ok, true);
});

test('add_session replayed with the same op_id gets its first answer, not the duplicate refusal', async () => {
  const { svc } = await setup();
  const a = await svc.addSession({ task: 'Interview with Acme', minutes: 60, calendarEventId: 'evt-acme-2', opId: 'op-calendar-0001' }) as any;
  const b = await svc.addSession({ task: 'Interview with Acme', minutes: 60, calendarEventId: 'evt-acme-2', opId: 'op-calendar-0001' }) as any;
  assert.equal(a.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), 'what the client sees is the same');
});

test('set_commitments keeps calendar_event_id on the entry and refuses two entries with the same id', async () => {
  const { store, svc } = await setup();
  const r = await svc.setCommitments([{ ...SCHOOL, calendarEventId: 'series-classes' }]) as any;
  assert.equal(r.ok, true);
  assert.equal(store.commitments[0].calendarEventId, 'series-classes');
  assert.equal(r.commitments[0].calendar_event_id, 'series-classes');
  assert.equal(((await svc.getCommitments()).commitments[0] as any).calendar_event_id, 'series-classes');

  // Passing the list again without the field keeps it; null removes it.
  await svc.setCommitments([{ ...SCHOOL, id: store.commitments[0].id }]);
  assert.equal(store.commitments[0].calendarEventId, 'series-classes');
  await svc.setCommitments([{ ...SCHOOL, id: store.commitments[0].id, calendarEventId: null }]);
  assert.equal(store.commitments[0].calendarEventId, undefined);

  const before = structuredClone(store.commitments);
  const dup = await svc.setCommitments([
    { ...SCHOOL, calendarEventId: 'series-classes' },
    { ...SCHOOL, title: 'Swimming', calendarEventId: 'series-classes' },
  ]) as any;
  assert.equal(dup.ok, false);
  assert.match(dup.speak, /"Children to their classes" and "Swimming" have the same calendar_event_id "series-classes"/);
  assert.deepEqual(store.commitments, before, 'nothing saved');
});

test('the tools take calendar_event_id and give it back under the same name', async () => {
  const { store } = await setup();
  const server = buildServer('u-cal', 'calendar-tools', 'desktop', undefined, { storeFor: () => store as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'calendar-tools', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);

  assert.equal((await call('set_commitments', { commitments: [{ ...SCHOOL, calendar_event_id: 'series-classes' }] })).ok, true);
  const listed = await call('get_commitments', {});
  assert.equal(listed.commitments[0].calendar_event_id, 'series-classes');
  // What get_commitments gives can be passed back as it is.
  await call('set_commitments', { commitments: listed.commitments });
  assert.equal(store.commitments[0].calendarEventId, 'series-classes');

  assert.equal((await call('add_session', { task: 'Interview with Acme', minutes: 60, calendar_event_id: 'evt-acme-3' })).ok, true);
  const twice = await call('add_session', { task: 'Interview with Acme', minutes: 60, calendar_event_id: 'evt-acme-3' });
  assert.equal(twice.ok, false);
  assert.match(twice.speak, /^This calendar event is already logged: Interview with Acme on \d{4}-\d{2}-\d{2}\. Use edit_session to change it\.$/);
  await client.close();
});
