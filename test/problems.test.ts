import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as problems from '../src/problems.js';
import { instrument } from '../src/calllog.js';
import { registerTools } from '../src/tools.js';
import { TOOLS } from '../src/access.js';

const KEY = 'pb_pub_' + 'a'.repeat(48);
const GOOD = { task: 'Plan my day', kind: 'confusing', impact: 'friction', description: 'set_plan refused two main steps but did not say which one to keep.', tool_name: 'set_plan' };

class MemOutbox implements problems.Outbox {
  rows = new Map<string, problems.Queued>();
  n = 0; slow = false; failing = false;
  async add(item: problems.OutboxItem) {
    if (this.failing) throw new Error('firestore down');
    if (this.slow) await new Promise(r => setTimeout(r, 2000));
    const id = `q${this.n++}`; this.rows.set(id, { id, item, attempts: 0, createdAt: Date.now() });
  }
  async oldest(n: number) { return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, n); }
  async remove(ids: string[]) { ids.forEach(i => this.rows.delete(i)); }
  async retryLater(ids: string[]) { ids.forEach(i => { const r = this.rows.get(i); if (r) r.attempts++; }); }
  items() { return [...this.rows.values()].map(r => r.item); }
}

let box: MemOutbox;
const saved = { ...process.env };
beforeEach(() => { box = new MemOutbox(); problems.useOutbox(box); problems.resetFeedbackLimits(); process.env.PROBLEMS_PUBLIC_KEY = KEY; delete process.env.PROBLEMS_REPORTING; delete process.env.DO_NOT_TRACK; });
afterEach(() => { problems.useOutbox(null); process.env = { ...saved }; });

// ---------------------------------------------------------------- tool-call events

test('off without a key, or with an opt-out: nothing is queued', async () => {
  for (const env of [{ PROBLEMS_PUBLIC_KEY: '' }, { PROBLEMS_PUBLIC_KEY: 'pb_pub_short' }, { PROBLEMS_REPORTING: 'off' }, { DO_NOT_TRACK: '1' }]) {
    Object.assign(process.env, env);
    await problems.recordCall('get_goal', true, null);
    process.env.PROBLEMS_PUBLIC_KEY = KEY; delete process.env.PROBLEMS_REPORTING; delete process.env.DO_NOT_TRACK;
  }
  assert.equal(box.rows.size, 0);
});

test('a success carries only the tool name and the outcome', async () => {
  await problems.recordCall('get_goal', true, null);
  const [it] = box.items() as { kind: 'event'; event: problems.CallEvent }[];
  assert.deepEqual(Object.keys(it.event).sort(), ['id', 'operation', 'outcome', 'surface', 'timestamp']);
  assert.equal(it.event.operation, 'get_goal');
  assert.equal(it.event.outcome, 'success');
});

test('an error carries its fixed class, never text; an unknown class becomes tool_error', async () => {
  await problems.recordCall('set_plan', false, 'invalid_arguments');
  await problems.recordCall('set_plan', false, 'Goal "Quit my job by June" not found');
  await problems.recordCall('set_plan', false, 'rpc_-32602');
  const msgs = (box.items() as { event: problems.CallEvent }[]).map(i => i.event.error?.message);
  assert.deepEqual(msgs, ['invalid_arguments', 'tool_error', 'rpc_-32602']);
});

test('an unknown tool name goes as "unknown"; send_feedback is not usage', async () => {
  await problems.recordCall('my_private_tool_jane', false, 'rpc_-32602');
  await problems.recordCall(problems.FEEDBACK_TOOL, true, null);
  const events = box.items() as { event: problems.CallEvent }[];
  assert.equal(events.length, 1);
  assert.equal(events[0].event.operation, 'unknown');
  assert.doesNotMatch(JSON.stringify(events), /jane/);
});

test('a slow or failing outbox never holds or fails the call', async () => {
  box.slow = true;
  const t0 = Date.now();
  await problems.recordCall('get_goal', true, null);
  assert.ok(Date.now() - t0 < 1000, `waited ${Date.now() - t0} ms`);
  box.slow = false; box.failing = true;
  await problems.recordCall('get_goal', true, null); // no throw
});

test('the call log queues the event before the answer leaves, with the error class only', async () => {
  const order: string[] = [];
  const realAdd = box.add.bind(box);
  box.add = async (item) => { await realAdd(item); order.push('queued'); };
  const transport = { send: async () => { order.push('sent'); } } as any;
  instrument(transport, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_plan', arguments: { date: '2025-01-02' } } }, { user: 'uid-1', client: 'ua', req: '', auth: 'oauth' });
  await transport.send({ jsonrpc: '2.0', id: 7, result: { isError: true, content: [{ type: 'text', text: '{"error":"My aim: Quit my job"}' }] } });
  assert.deepEqual(order, ['queued', 'sent']);
  const s = JSON.stringify(box.items());
  assert.doesNotMatch(s, /Quit my job|uid-1|2025-01-02/);
  assert.match(s, /"message":"tool_error"/);
});

// ---------------------------------------------------------------- the drain

function fakeFetch(status: number) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return new Response(null, { status }); }) as unknown as typeof fetch;
  return { f, calls };
}

test('drain: one events batch in the SDK wire format, with the key; sent items leave the outbox', async () => {
  await problems.recordCall('get_goal', true, null);
  await problems.recordCall('get_plan', true, null);
  const { f, calls } = fakeFetch(202);
  const r = await problems.drain(f);
  assert.deepEqual(r, { sent: 2, dropped: 0, kept: 0, statuses: [202] });
  assert.equal(calls[0].url, 'https://api.problems.dev/v1/events');
  assert.equal(calls[0].headers['x-problems-key'], KEY);
  assert.equal(calls[0].body.version, 1);
  assert.equal(calls[0].body.sdkVersion, '0.0.5');
  assert.equal(calls[0].body.events.length, 2);
  assert.equal(box.rows.size, 0);
});

test('drain: 429 and 5xx are kept for the next tick, up to 3 attempts; other 4xx are dropped', async () => {
  await problems.recordCall('get_goal', true, null);
  for (let i = 0; i < 3; i++) assert.equal((await problems.drain(fakeFetch(503).f))!.kept, 1);
  assert.equal((await problems.drain(fakeFetch(503).f))!.kept, 0, 'third attempt was the last');
  assert.equal(box.rows.size, 0);
  await problems.recordCall('get_goal', true, null);
  assert.equal((await problems.drain(fakeFetch(400).f))!.dropped, 1);
  assert.equal(box.rows.size, 0);
});

test('drain: nothing to do without a key', async () => {
  await problems.recordCall('get_goal', true, null);
  process.env.PROBLEMS_PUBLIC_KEY = '';
  const { f, calls } = fakeFetch(202);
  assert.equal(await problems.drain(f), null);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- send_feedback

test('send_feedback queues masked feedback and returns an id; the drain posts it with its idempotency key', async () => {
  const r = await problems.sendFeedback({ ...GOOD, description: 'Failed for jane@example.com with token=abcdefghijklmnop123, see set_plan.' }, 'uid-1');
  assert.match(r.feedback_id, /^fbk_[0-9a-f]{32}$/);
  const [it] = box.items() as { kind: 'feedback'; id: string; feedback: problems.Feedback }[];
  assert.equal(it.kind, 'feedback');
  assert.equal(r.feedback_id, `fbk_${it.id.replaceAll('-', '')}`);
  assert.doesNotMatch(it.feedback.description, /jane@example\.com|abcdefghijklmnop123/);
  assert.deepEqual({ ...it.feedback, description: '' }, { task: GOOD.task, kind: 'confusing', impact: 'friction', description: '', operation: 'set_plan', surface: 'mcp' });
  assert.doesNotMatch(JSON.stringify(it), /uid-1/);
  const { f, calls } = fakeFetch(202);
  await problems.drain(f);
  assert.equal(calls[0].url, 'https://api.problems.dev/v1/feedback');
  assert.equal(calls[0].headers['idempotency-key'], it.id);
});

test('send_feedback: the SDK checks and messages, before anything is queued', async () => {
  for (const bad of [{ ...GOOD, description: 'todo!!!!!!' }, { ...GOOD, kind: 'angry' }, { ...GOOD, task: '' }, { ...GOOD, description: 'short' }]) {
    await assert.rejects(problems.sendFeedback(bad, 'u'), (e: Error) => e instanceof problems.FeedbackRefused && e.message.startsWith('Invalid feedback'));
  }
  assert.equal(box.rows.size, 0);
});

test('send_feedback: three a day per person, then a polite refusal', async () => {
  for (let i = 0; i < 3; i++) await problems.sendFeedback(GOOD, 'u');
  await assert.rejects(problems.sendFeedback(GOOD, 'u'), /already been sent/);
  await problems.sendFeedback(GOOD, 'someone-else');
  assert.equal(box.rows.size, 4);
});

test('send_feedback off says so', async () => {
  process.env.PROBLEMS_PUBLIC_KEY = '';
  await assert.rejects(problems.sendFeedback(GOOD, 'u'), /Feedback is turned off here\./);
});

// ---------------------------------------------------------------- the tool on the server

async function connect(svc: any) {
  const server = new McpServer({ name: 't', version: '1' });
  registerTools(server, svc, null, null, undefined, undefined, 'uid-1');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('the tool is listed with the SDK fields, says where the text goes, and is in the access table', async () => {
  const client = await connect(null);
  const tool = (await client.listTools()).tools.find(t => t.name === 'send_feedback')!;
  assert.deepEqual(Object.keys((tool.inputSchema as any).properties).sort(), ['description', 'impact', 'kind', 'task', 'tool_name']);
  assert.deepEqual([...(tool.inputSchema as any).required].sort(), ['description', 'impact', 'kind', 'task']);
  assert.equal(tool.title, 'Send feedback to the AimYear team');
  assert.match(tool.description!, /problems\.dev/);
  assert.match(tool.description!, /masked/);
  assert.equal(tool.annotations?.openWorldHint, true);
  assert.ok(TOOLS.send_feedback);
});

test('signed in, the tool answers with a feedback_id', async () => {
  const client = await connect({});
  const r: any = await client.callTool({ name: 'send_feedback', arguments: GOOD });
  assert.notEqual(r.isError, true);
  assert.match(JSON.parse(r.content[0].text).feedback_id, /^fbk_/);
});

test('an unexpected error points to send_feedback only when reporting is on; AimYear refusals never do', async () => {
  const boom = { getGoal: async () => { throw new Error('boom'); } };
  let r: any = await (await connect(boom)).callTool({ name: 'get_goal', arguments: {} });
  assert.equal(r.content.length, 2);
  assert.equal(r.content[1].text, problems.NUDGE);
  process.env.PROBLEMS_PUBLIC_KEY = '';
  r = await (await connect(boom)).callTool({ name: 'get_goal', arguments: {} });
  assert.equal(r.content.length, 1);
});
