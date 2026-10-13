/**
 * Talks to the server the way a client does, through the real HTTP entry point:
 * initialize → tools/list WITHOUT a token (keep those schemas) → call every tool with a
 * token → check every response survives serialisation, parses, and is not an error.
 *
 * In-process (default): a throwaway user in the REAL Firestore, so values come back with
 * production's types, not a kind fake's. Calls all 40 tools, writes included, then deletes
 * everything it made.
 *
 * Deployed: CONFORMANCE_URL=https://.../mcp and a token in CONFORMANCE_TOKEN_FILE
 * (default ~/.aimyear/remote-token). Calls only the read-only tools; changes nothing.
 *
 *   npx tsx test/conformance.ts
 *   CONFORMANCE_URL=https://mcp.aimyear.com/mcp npx tsx test/conformance.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { startApp, rpc, call, INIT } from './helpers.js';
import { initFirestore, PENDING } from '../src/store.js';
import { FirestoreOAuthProvider } from '../src/oauth.js';
import { addDays } from '../src/dates.js';

const remote = process.env.CONFORMANCE_URL;
const uid = 'conformance-' + Date.now();
const token = remote ? readFileSync(process.env.CONFORMANCE_TOKEN_FILE ?? `${homedir()}/.aimyear/remote-token`, 'utf8').trim() : 'conf-' + Math.random().toString(36).slice(2);
const app = remote ? null : await startApp({ tokens: new Map([[token, uid]]), provider: new FirestoreOAuthProvider(new URL('http://localhost:1/mcp')) });
const url = remote ?? `${app!.url}/mcp`;

const failures: string[] = [];
const fail = (m: string) => { failures.push(m); console.log('  ✖', m); };
let id = 0;

// 1–2. initialize and tools/list with no credentials.
const init = await rpc(url, call(++id, 'initialize', INIT));
if (init.status !== 200) fail(`initialize without a token: HTTP ${init.status}`);
const listed = await rpc(url, call(++id, 'tools/list'));
if (listed.status !== 200) { fail(`tools/list without a token: HTTP ${listed.status}; nobody outside the repo can inspect this server`); }
const tools: any[] = listed.json?.result?.tools ?? [];
const published = new Map(tools.map(t => [t.name, t]));
console.log(`server ${init.json?.result?.serverInfo?.version}: ${tools.length} tools listed anonymously`);

// 3–6. Call tools through the same door, with a token.
const called = new Set<string>();
async function use(name: string, args: Record<string, unknown> = {}, opts: { allowError?: boolean } = {}) {
  called.add(name);
  const t = published.get(name);
  if (!t) { fail(`${name}: not in the published tools/list`); return null; }
  for (const req of t.inputSchema?.required ?? []) if (!(req in args)) fail(`${name}: test omits required "${req}" from the published schema`);
  const r = await rpc(url, call(++id, 'tools/call', { name, arguments: args }), { Authorization: `Bearer ${token}` });
  if (r.status !== 200) { fail(`${name}: HTTP ${r.status}`); return null; }
  if (r.json?.error) { fail(`${name}: JSON-RPC error ${r.json.error.code} ${r.json.error.message}`); return null; }
  const res = r.json?.result;
  try { JSON.parse(JSON.stringify(r.json)); } catch (e) { fail(`${name}: response does not survive serialisation: ${(e as Error).message}`); }
  if (/not serializable|\[object Object\]/i.test(r.raw)) fail(`${name}: a value leaked through unserialised`);
  const text = res?.content?.[0]?.text ?? '';
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { fail(`${name}: content text is not JSON: ${text.slice(0, 80)}`); }
  if (res?.isError && !opts.allowError) fail(`${name}: happy-path call returned isError: ${text.slice(0, 160)}`);
  if (t.outputSchema && !res?.structuredContent) fail(`${name}: declares outputSchema but returned no structuredContent`);
  if (parsed && typeof parsed.speak !== 'string' && !res?.isError) fail(`${name}: result has no "speak" field`);
  return parsed;
}

const READ_ONLY = tools.filter(t => t.annotations?.readOnlyHint).map(t => t.name);
try {
  if (remote) {
    const today = new Date().toISOString().slice(0, 10);
    for (const name of READ_ONLY) {
      const args: Record<string, unknown> = name === 'validate_goal' ? { title: 'Run 10 km under 60 minutes' } : name === 'history' ? { from: today, to: today } : {};
      await use(name, args);
    }
  } else {
    const today = new Date().toISOString().slice(0, 10);
    await use('get_goal');
    await use('validate_goal', { title: 'Get better at marketing' });
    await use('set_goal', { title: '15 paying customers', metric: 'paying customers', baseline: 0, target: 15, deadline: addDays(today, 200), area: 'money' });
    await use('update_baseline', { value: 1 });
    await use('set_levers', { levers: [{ name: 'outreach', kind: 'hard', keywords: ['email'] }, { name: 'building', kind: 'comfortable', keywords: ['feature'] }] });
    await use('add_project', { name: 'Client work', area: 'work', keywords: ['client'] });
    await use('set_pomodoro', { workMin: 45, breakMin: 5 });
    await use('set_workplace', { workplace: 'desktop' });
    await use('register_device', { token: 'conformance-device-token-0123456789', platform: 'web', label: 'conformance' });
    await use('list_devices');
    await use('forget_device', { token: 'conformance-device-token-0123456789' });
    await use('set_commitments', { commitments: [{ title: 'School run', area: 'relations', days: [1, 2, 3, 4, 5], start: '08:00', minutes: 40 }] });
    await use('get_commitments');
    await use('capacity');
    await use('set_milestones', { milestones: [{ title: 'Offer ready', metric: 'paywalls live', target: 1, due: addDays(today, 30) }, { title: 'First buyers', metric: 'paying customers', target: 5, due: addDays(today, 120) }] });
    const path = await use('get_path');
    const milestoneId = path?.milestones?.[0]?.id;
    await use('add_steps', { milestoneId, steps: [{ title: 'Email 10 people from the waitlist', leverId: 'outreach', estimateMin: 50 }] });
    const next = await use('next_steps');
    const stepId = next?.steps?.[0]?.id;
    await use('update_step', { stepId, estimateMin: 45 });
    await use('get_planning_context', { date: today });
    await use('set_plan', { date: today, items: [{ title: 'Email 10 people from the waitlist', area: 'work', stepId, isMainStep: true }, { title: 'Workout', area: 'health' }] });
    const plan = await use('get_plan', { date: today });
    const itemId = plan?.plan?.[0]?.id;
    await use('set_mode', { mode: 'full' });
    const started = await use('start_focus', { task: 'email the waitlist', itemId });
    await use('get_current');
    await use('split_attention', { shares: { [started?.session?.id ?? 'x']: 1 } });
    await use('heartbeat', { note: 'halfway' });
    await use('end_block');
    await use('end_focus', { summary: 'sent 10 emails', outcome: 'partial' });
    await use('start_focus', { task: 'email the waitlist again', itemId });
    await use('cancel_focus');
    await use('cancel_block', {}, { allowError: true }); // no block left is a fair refusal
    await use('log_session', { task: 'Workout', area: 'health', minutes: 30 });
    await use('complete_item', { itemId, date: today });
    await use('get_gaps', { date: today });
    await use('status');
    await use('day_summary', { date: today });
    await use('week_summary');
    await use('leaks');
    await use('streak');
    await use('history', { from: today, to: today });
  }
  const expected = remote ? READ_ONLY : tools.map(t => t.name);
  const missed = expected.filter(n => !called.has(n));
  if (missed.length) fail(`tools never called: ${missed.join(', ')}`);
} finally {
  if (!remote) {
    const db = initFirestore();
    await db.recursiveDelete(db.collection('users').doc(uid));
    const pend = await db.collection(PENDING).where('uid', '==', uid).get();
    await Promise.all(pend.docs.map(d => d.ref.delete()));
    await app!.close();
  }
}

console.log(failures.length ? `\nFAIL: ${failures.length} problem(s)` : `\nPASS: ${called.size} tools called, every response parsed, no errors`);
process.exit(failures.length ? 1 : 0);
