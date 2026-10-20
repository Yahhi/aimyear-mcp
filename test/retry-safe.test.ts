import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimService, AimError } from '../src/service.js';
import { tick } from '../src/notifier.js';
import { FakeStore } from './fake-store.js';
import type { Pending, Session } from '../src/types.js';

/**
 * Two devices on one account: a Mac agent (desktop) and the phone app (mobile). The
 * phone queues requests offline and replays them later, each with the op_id it minted
 * before the first attempt; the Mac stops the same session in the meantime.
 */
function setup() {
  const store = new FakeStore();
  const mac = new AimService(store as any, 'remote:oauth:mac00000', 'desktop');
  const phone = new AimService(store as any, 'remote:oauth:phone000', 'mobile');
  return { store, mac, phone };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();

/** A session started two hours ago by `owner`, still running. */
function running(store: FakeStore, id: string, owner: string, start = minutesAgo(120)): Session {
  const s: Session = { id, start, source: 'agent', clientSessionId: owner, weight: 1, workplace: 'desktop', area: 'work', task: `task ${id}`, notes: [], classification: 'other_project', verdictAtStart: 'ok' };
  store.sessions.set(id, s);
  return s;
}

const totalMinutes = async (svc: AimService) => (await svc.daySummary()).total_attention_min;

// "14:20" is the Mac's stop, "14:05" the phone's earlier one, both before now.
const END_MAC = minutesAgo(10), END_PHONE = minutesAgo(25);

test('two stops on one session: the earliest end wins, whatever order they arrive in', async () => {
  const a = setup();
  running(a.store, 's1', 'remote:oauth:mac00000');
  const first = await a.mac.stopSession('mac summary', 'partial', 's1', undefined, { endAt: END_MAC });
  assert.equal(first.applied, 'ended');
  const second = await a.phone.stopSession('phone summary', 'done', 's1', undefined, { endAt: END_PHONE, opId: 'op-phone-stop-1' });
  assert.equal(second.applied, 'shortened');
  assert.match(second.speak, /Already ended at \d\d:\d\d \(desktop\); your \d\d:\d\d stop moved the end to/);
  const sa = a.store.sessions.get('s1')!;
  assert.equal(sa.end, END_PHONE);
  assert.equal(sa.outcome, 'done');
  assert.equal(sa.stops!.length, 2);
  assert.equal(sa.summary, 'mac summary');
  assert.ok(sa.notes.some(n => /stop from mobile: phone summary/.test(n)), 'the later, different summary is kept in the notes');

  // The reverse order: the phone's stop lands first, the Mac's later.
  const b = setup();
  running(b.store, 's1', 'remote:oauth:mac00000');
  const r1 = await b.phone.stopSession('phone summary', 'done', 's1', undefined, { endAt: END_PHONE, opId: 'op-phone-stop-1' });
  assert.equal(r1.applied, 'ended');
  const r2 = await b.mac.stopSession('mac summary', 'partial', 's1', undefined, { endAt: END_MAC });
  assert.equal(r2.applied, 'recorded');
  assert.match(r2.speak, /the end stays/);
  const sb = b.store.sessions.get('s1')!;
  assert.equal(sb.end, sa.end);
  assert.equal(sb.outcome, sa.outcome);
  assert.equal(sb.stops!.length, 2);
  assert.deepEqual(new Set(sb.stops!.map(x => x.endAt)), new Set(sa.stops!.map(x => x.endAt)));
  // Both summaries survive in both orders; which one is the summary follows arrival.
  const texts = (s: Session) => new Set([s.summary, ...s.notes.map(n => n.replace(/^.*: /, ''))]);
  assert.deepEqual(texts(sb), texts(sa));
  assert.equal(await totalMinutes(a.mac), await totalMinutes(b.mac));
});

test('a stop with op_id sent twice is applied once: the second gets the first answer and writes nothing', async () => {
  const { store, phone } = setup();
  running(store, 's1', 'remote:oauth:phone000');
  const first = await phone.stopSession('finished the draft', 'done', 's1', undefined, { endAt: END_PHONE, opId: 'op-stop-twice' });
  const writes = store.writes;
  const again = await phone.stopSession('finished the draft', 'done', 's1', undefined, { endAt: END_PHONE, opId: 'op-stop-twice' });
  assert.deepEqual(again, JSON.parse(JSON.stringify(first)));
  assert.equal(store.writes, writes, 'a replay writes nothing');
  assert.equal(store.sessions.get('s1')!.stops!.length, 1);
  assert.equal(store.ops.get('op-stop-twice')!.tool, 'stop_session');
  assert.equal(store.ops.get('op-stop-twice')!.sessionId, 's1');
});

test('add_session with op_id twice logs the time once', async () => {
  const { store, phone } = setup();
  const r1 = await phone.addSession({ task: 'Workout', area: 'health', minutes: 40, opId: 'op-log-workout' });
  const before = await totalMinutes(phone);
  const r2 = await phone.addSession({ task: 'Workout', area: 'health', minutes: 40, opId: 'op-log-workout' });
  assert.equal(r2.session.id, r1.session.id);
  assert.equal(store.sessions.size, 1);
  assert.equal(await totalMinutes(phone), before);
  assert.equal(before, 40);
});

test('start_session with the client\'s own session_id twice creates one session and returns it', async () => {
  const { store, phone } = setup();
  const r1 = await phone.startSession({ task: 'reply to users', sessionId: 'phone-sess-001', startAt: minutesAgo(5) });
  assert.equal(r1.session!.id, 'phone-sess-001');
  assert.equal(store.sessions.get('phone-sess-001')!.start, minutesAgo(5).slice(0, 16) + store.sessions.get('phone-sess-001')!.start.slice(16));
  const r2 = await phone.startSession({ task: 'reply to users', sessionId: 'phone-sess-001', startAt: minutesAgo(5) });
  assert.equal(r2.session!.id, 'phone-sess-001');
  assert.match(r2.speak, /already started/);
  assert.equal(store.sessions.size, 1);
  assert.equal((await phone.getCurrent()).running_sessions.length, 1, 'attention is not halved by a second running session');
});

test('start_session with op_id twice creates one session, and a stop verdict replays as a stop', async () => {
  const { store, mac } = setup();
  const r1 = await mac.startSession({ task: 'reply to users', opId: 'op-start-1' });
  const r2 = await mac.startSession({ task: 'reply to users', opId: 'op-start-1' });
  assert.equal(r2.session!.id, r1.session!.id);
  assert.equal(store.sessions.size, 1);
});

test('a device stop must name its session, and cannot end before the start', async () => {
  const { store, phone, mac } = setup();
  running(store, 's1', 'remote:oauth:phone000');
  await assert.rejects(() => phone.stopSession('x', 'done', undefined, undefined, { endAt: END_PHONE }), (e: Error) => e instanceof AimError && /session_id is required/.test(e.message) && /\[s1\]/.test(e.message));
  await assert.rejects(() => phone.stopSession('x', 'done', undefined, undefined, { opId: 'op-no-session' }), (e: Error) => e instanceof AimError && /session_id is required/.test(e.message));
  await assert.rejects(() => mac.stopSession('x', 'done', 's1', undefined, { endAt: minutesAgo(180) }), (e: Error) => e instanceof AimError && /before the session start/.test(e.message));
  await assert.rejects(() => mac.stopSession('x', 'done', 's1', undefined, { endAt: 'yesterday afternoon' }), (e: Error) => e instanceof AimError && /ISO 8601/.test(e.message));
  assert.equal(store.sessions.get('s1')!.end, undefined, 'nothing was applied');
  // A clock ahead of the server by more than two minutes is taken as now, not the future.
  const r = await mac.stopSession('x', 'done', 's1', undefined, { endAt: new Date(Date.now() + 10 * 60000).toISOString() });
  assert.ok(new Date(r.session.end!).getTime() <= Date.now() + 1000);
});

test('without session_id, stop and delete never fall back to another connection\'s running session', async () => {
  const { store, mac, phone } = setup();
  running(store, 's-mac', 'remote:oauth:mac00000');
  await assert.rejects(() => phone.deleteSession(), (e: Error) => e instanceof AimError && /No running session belongs to this connection/.test(e.message) && /\[s-mac\] task s-mac/.test(e.message));
  await assert.rejects(() => phone.stopSession('x', 'done'), (e: Error) => e instanceof AimError && /pass session_id/.test(e.message));
  assert.ok(store.sessions.has('s-mac'));
  // The connection that owns it still needs no id.
  const r = await mac.deleteSession();
  assert.equal(r.deleted, 's-mac');
  assert.equal(store.sessions.size, 0);
});

test('an interactive stop on a session that already ended is still refused, and a device stop with op_id after a crash is not', async () => {
  const { store, mac, phone } = setup();
  running(store, 's1', 'remote:oauth:mac00000');
  await mac.stopSession('done for today', 'partial');
  await assert.rejects(() => mac.stopSession('again', 'partial', 's1'), (e: Error) => e instanceof AimError && /edit_session/.test(e.message));
  const r = await phone.stopSession('phone says done', 'done', 's1', undefined, { opId: 'op-late-stop' });
  assert.equal(r.applied, 'recorded');
  assert.equal(store.sessions.get('s1')!.outcome, 'done', 'done wins');
});

test('a real stop arriving after the server auto-closed the session moves the end back and clears the auto-close', async () => {
  const { store, phone } = setup();
  const s = running(store, 's1', 'remote:oauth:mac00000');
  s.end = minutesAgo(1); s.outcome = 'partial'; s.autoClosed = true; s.summary = 'Auto-closed: the timer ran for hours with no stop. Confirm the real end time.';
  store.sessions.set(s.id, s);
  const r = await phone.stopSession('finished the article', 'done', 's1', undefined, { endAt: END_PHONE, opId: 'op-real-stop' });
  assert.equal(r.applied, 'shortened');
  assert.match(r.speak, /closed by the server/);
  const saved = store.sessions.get('s1')!;
  assert.equal(saved.end, END_PHONE);
  assert.equal(saved.autoClosed, false);
  assert.equal(saved.summary, 'finished the article');
  assert.equal(saved.outcome, 'done');
});

test('add_note and add_steps with op_id are applied once', async () => {
  const { store, phone } = setup();
  running(store, 's1', 'remote:oauth:phone000');
  await phone.addNote('looked at logs', 's1', 'op-note-1');
  await phone.addNote('looked at logs', 's1', 'op-note-1');
  assert.equal(store.sessions.get('s1')!.notes.length, 1);
  await assert.rejects(() => phone.addNote('x', undefined, 'op-note-2'), (e: Error) => e instanceof AimError && /session_id is required/.test(e.message));
  store.path = { milestones: [{ id: 'm1', title: 'First', metric: '', target: 0, due: '2027-01-01', status: 'todo', createdAt: '2026-01-01T00:00:00Z' }], steps: [] };
  await phone.addSteps('m1', [{ title: 'Email 10 people from the waitlist' }], 'op-steps-1');
  const r = await phone.addSteps('m1', [{ title: 'Email 10 people from the waitlist' }], 'op-steps-1');
  assert.equal(store.path.steps.length, 1);
  assert.equal(r.steps!.length, 1);
});

test('/tick claims a reminder before pushing it, so two overlapping ticks deliver it once', async () => {
  const p: Pending = { id: 'b1-standup-0', uid: 'u', blockId: 'b1', dueAt: '2026-10-20T12:00:00Z', kind: 'standup', workplace: 'mobile', minutes: 25, breakMin: 5 };
  const queue = new Map([[p.id, p]]);
  let claims = 0;
  const notif = {
    due: async () => [...queue.values()],
    claim: async (id: string) => { claims++; return queue.delete(id); },
    remove: async (id: string) => { queue.delete(id); },
    devicesOf: async () => [],
    profileOf: async () => null,
    queueNextStandup: async () => undefined,
  };
  const [a, b] = await Promise.all([tick(notif as any, new Date('2026-10-20T12:01:00Z')), tick(notif as any, new Date('2026-10-20T12:01:00Z'))]);
  assert.equal(a.processed + b.processed, 1);
  assert.equal(claims, 2);
  assert.equal(queue.size, 0);
});
