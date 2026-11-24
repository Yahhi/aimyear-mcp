/**
 * Tool-call outcomes and agent feedback to problems.dev (error monitoring for MCP servers),
 * in the wire format of @problemsdev/sdk 0.0.5 (buffer.ts, feedback.ts). The facts are in
 * ~/projects/aimyear/docs/server-error-reports.md: what is sent, what never is, the switch.
 *
 * Why not the SDK itself: it buffers in memory and sends from a timer, and this service runs
 * on Cloud Run with CPU only during requests and scale to zero, so a buffered event would sit
 * until the next request or be lost with the instance. Instead each event goes into a
 * Firestore outbox before the answer leaves (one write next to the database, bounded by a
 * timeout so a slow write never holds a tool call), and the minute tick (POST /tick, Cloud
 * Scheduler) sends the outbox to problems.dev. Nothing waits on problems.dev, and nothing is
 * lost when an instance freezes or stops.
 *
 * What leaves, per tools/call: a random event id, the time, the tool name (only a name in the
 * access table, else "unknown"), success or error, and for an error only its fixed class from
 * the call log (tool_error, invalid_arguments, not_signed_in, rpc_<code>), never its text:
 * AimYear's errors can quote the person's own goals, plans and notes. Per send_feedback: the
 * task, kind, impact, description and tool the agent wrote, masked for secrets and email
 * addresses. Never arguments, results, the person's uid, token, IP or client.
 *
 * Off unless PROBLEMS_PUBLIC_KEY is set (a Secret Manager secret on the service).
 * PROBLEMS_REPORTING=off or DO_NOT_TRACK=1 turn it off, as in the SDK.
 */
import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { TOOLS } from './access.js';

export const SDK_VERSION = '0.0.5';
export const ENDPOINT = 'https://api.problems.dev/v1/events';
export const FEEDBACK_ENDPOINT = 'https://api.problems.dev/v1/feedback';
const KEY_RX = /^pb_pub_[a-f0-9]{48}$/;
export const FEEDBACK_TOOL = 'send_feedback';
export const OUTBOX = 'problems_outbox';
const WRITE_TIMEOUT_MS = 500;
const MAX_BATCH = 50;
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 60 * 60_000;

export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(off|false|0)$/i.test(env.PROBLEMS_REPORTING ?? '') || /^(1|true|yes)$/i.test(env.DO_NOT_TRACK ?? '')) return false;
  return KEY_RX.test((env.PROBLEMS_PUBLIC_KEY ?? '').trim());
}
const key = (env: NodeJS.ProcessEnv = process.env) => (env.PROBLEMS_PUBLIC_KEY ?? '').trim();

export interface CallEvent { id: string; timestamp: string; surface: 'mcp'; operation: string; outcome: 'success' | 'error'; error?: { message: string } }
export interface Feedback { task: string; kind: string; impact: string; description: string; operation?: string; surface: 'mcp' }
export type OutboxItem = { kind: 'event'; event: CallEvent } | { kind: 'feedback'; id: string; feedback: Feedback };
export interface Queued { id: string; item: OutboxItem; attempts: number; createdAt: number }

/** Where items wait for the tick. Firestore in production, a Map in tests. */
export interface Outbox {
  add(item: OutboxItem): Promise<void>;
  oldest(n: number): Promise<Queued[]>;
  remove(ids: string[]): Promise<void>;
  retryLater(ids: string[]): Promise<void>;
}

export function firestoreOutbox(db: () => Firestore): Outbox {
  const col = () => db().collection(OUTBOX);
  return {
    async add(item) { await col().doc(randomUUID()).set({ item, attempts: 0, created_at: Date.now() }); },
    async oldest(n) {
      const snap = await col().orderBy('created_at').limit(n).get();
      return snap.docs.map(d => ({ id: d.id, item: d.get('item') as OutboxItem, attempts: Number(d.get('attempts') ?? 0), createdAt: Number(d.get('created_at') ?? 0) }));
    },
    async remove(ids) {
      if (!ids.length) return;
      const b = db().batch();
      for (const id of ids) b.delete(col().doc(id));
      await b.commit();
    },
    async retryLater(ids) {
      if (!ids.length) return;
      const { FieldValue } = await import('firebase-admin/firestore');
      const b = db().batch();
      for (const id of ids) b.update(col().doc(id), { attempts: FieldValue.increment(1) });
      await b.commit();
    },
  };
}

let outbox: Outbox | null = null;
/** Set once at startup (http.ts) or by a test. Without one, nothing is recorded. */
export function useOutbox(o: Outbox | null) { outbox = o; }

const KNOWN = new Set(Object.keys(TOOLS));

/** Bounded: a slow or failed write never holds the answer, and never fails it. */
async function put(item: OutboxItem): Promise<boolean> {
  if (!outbox) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), WRITE_TIMEOUT_MS); });
    return await Promise.race([outbox.add(item).then(() => true), timeout]);
  } catch (e) {
    console.error('[problems] outbox write failed', (e as Error).message);
    return false;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * One tools/call outcome, from the call log (calllog.ts), which already reduced an error to a
 * fixed class. send_feedback is not usage (as in the SDK), so it is not recorded.
 */
export async function recordCall(tool: string | null, ok: boolean, errClass: string | null): Promise<void> {
  try {
    if (!enabled() || tool === FEEDBACK_TOOL) return;
    const operation = tool && KNOWN.has(tool) ? tool : 'unknown';
    const event: CallEvent = { id: randomUUID(), timestamp: new Date().toISOString(), surface: 'mcp', operation, outcome: ok ? 'success' : 'error' };
    if (!ok) event.error = { message: /^(tool_error|invalid_arguments|not_signed_in|rpc_-?\d+)$/.test(errClass ?? '') ? errClass! : 'tool_error' };
    await put({ kind: 'event', event });
  } catch { /* reporting never affects a call */ }
}

// ------------------------------------------------------------------ the drain (POST /tick)

type Fetch = typeof fetch;
type Outcome = { r: 'sent' | 'drop' | 'retry'; status: number };
async function post(f: Fetch, url: string, body: unknown, headers: Record<string, string>): Promise<Outcome> {
  try {
    const r = await f(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-problems-key': key(), 'user-agent': `aimyear-mcp (problems.dev wire format ${SDK_VERSION})`, ...headers },
      body: JSON.stringify(body) });
    void r.body?.cancel().catch(() => {});
    if (r.status === 202) return { r: 'sent', status: 202 };
    if (r.status === 429 || r.status >= 500) return { r: 'retry', status: r.status };
    return { r: 'drop', status: r.status }; // any other 4xx is permanent, as in the SDK
  } catch { return { r: 'retry', status: 0 }; }
}

/**
 * Send what waits in the outbox: events in one batch of up to 50, each feedback item on its
 * own with its idempotency key. Sent and permanently refused items are removed; a retryable
 * failure is kept for the next tick, up to 3 attempts and 24 hours (the SDK's limits).
 */
export async function drain(f: Fetch = fetch, now = Date.now()): Promise<{ sent: number; dropped: number; kept: number; statuses: number[] } | null> {
  if (!enabled() || !outbox) return null;
  const queued = await outbox.oldest(MAX_BATCH * 2);
  if (!queued.length) return null;
  const stale = queued.filter(q => q.attempts >= MAX_ATTEMPTS || now - q.createdAt > MAX_AGE_MS);
  const live = queued.filter(q => !stale.includes(q));
  const done: string[] = stale.map(q => q.id), again: string[] = [];
  let sent = 0;
  const statuses: number[] = [];
  const events = live.filter(q => q.item?.kind === 'event').slice(0, MAX_BATCH);
  if (events.length) {
    const { r, status } = await post(f, ENDPOINT, { version: 1, sdkVersion: SDK_VERSION, events: events.map(q => (q.item as { event: CallEvent }).event) }, {});
    statuses.push(status);
    (r === 'retry' ? again : done).push(...events.map(q => q.id));
    if (r === 'sent') sent += events.length;
  }
  for (const q of live.filter(q => q.item?.kind === 'feedback')) {
    const it = q.item as { id: string; feedback: Feedback };
    const { r, status } = await post(f, FEEDBACK_ENDPOINT, it.feedback, { 'idempotency-key': it.id });
    statuses.push(status);
    (r === 'retry' ? again : done).push(q.id);
    if (r === 'sent') sent++;
  }
  // Anything else in the outbox is not ours to send.
  done.push(...live.filter(q => q.item?.kind !== 'event' && q.item?.kind !== 'feedback').map(q => q.id));
  await outbox.remove(done);
  await outbox.retryLater(again);
  return { sent, dropped: done.length - sent, kept: again.length, statuses };
}

// ------------------------------------------------------------------ send_feedback
// Ported from @problemsdev/sdk 0.0.5 feedback.ts: the same name, title, description, fields,
// checks and messages. One hint is added (the owner asked for it): where the text goes.

export const KINDS = ['missing', 'broken', 'confusing', 'idea'] as const;
export const IMPACTS = ['blocked', 'worked_around', 'friction'] as const;
const PLACEHOLDERS = new Set(['', 'na', 'none', 'noop', 'null', 'placeholder', 'tbd', 'test', 'todo', 'undefined']);
const PRODUCT = 'AimYear';
export const MAX_PER_SESSION = 3;
export const NUDGE = `If this error doesn't tell you how to fix the call, report it with ${FEEDBACK_TOOL}.`;
export const INSTRUCTIONS = `When a ${PRODUCT} tool is missing, broken or confusing, tell its maintainers with ${FEEDBACK_TOOL}, at most once per task, after you finish or give up.`;
export const TITLE = `Send feedback to the ${PRODUCT} team`;
export const DESCRIPTION = [
  `Send feedback about the ${PRODUCT} tools to their maintainers, when a tool was missing, broken or confusing, or to suggest an improvement.`,
  '',
  '<hints>',
  '- Use it at most once per task, after you finish or give up.',
  "- Skip it if the task went fine. Don't use it to log progress or to test it.",
  `- It goes to the ${PRODUCT} maintainers, not to the user's account.`,
  "- Don't include secrets, credentials or personal data.",
  `- The text is sent to problems.dev, the error-monitoring service the ${PRODUCT} maintainers read it in, after secrets and email addresses are masked. It is not tied to the user's account, so don't quote the user's goals, plans or notes in it.`,
  '</hints>',
  '',
  '<example>',
  `${FEEDBACK_TOOL}(task="Find slow endpoints", kind="missing", impact="blocked", description="No tool returns p95 latency per endpoint, so I couldn't rank them.")`,
  '</example>',
].join('\n');
export const ANNOTATIONS = { title: TITLE, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// The SDK's client-side secret patterns (redact.ts), then email addresses (feedback.ts).
const SECRETS: RegExp[] = [
  /\b[Bb]earer\s+[A-Za-z0-9._-]+/g,
  /\bpvk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  /\bsk-ant-[A-Za-z0-9-]{16,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN (?<kind>[A-Z0-9 ]{0,40})PRIVATE KEY-----[A-Za-z0-9+/=\s]*(?:-----END \k<kind>PRIVATE KEY-----)?/g,
  /\b(?<keep>[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/]{1,256}:)[^\s@/]{1,256}(?=@)/gi,
  /(?<![A-Za-z0-9])(?<keep>(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|private[_-]?key)(?:[_-][A-Za-z0-9]+){0,3}["']?\s*[:=]\s*["']?)[^\s"',;&]{8,}/gi,
];
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}(?![\p{L}\p{N}-])/gu;
export function scrub(text: string): string {
  let t = text;
  for (const rx of SECRETS) t = t.replace(rx, (...args: unknown[]) => {
    const groups = args.at(-1);
    const keep = groups && typeof groups === 'object' ? (groups as { keep?: string }).keep : undefined;
    return `${keep ?? ''}[REDACTED]`;
  });
  return t.replace(EMAIL, '[REDACTED]');
}

const line = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The SDK's normalize(): the same rules problems.dev applies, so the agent hears now. */
export function normalize(input: Record<string, unknown> | null | undefined): Feedback | string {
  if (!input || typeof input !== 'object') return 'Invalid feedback';
  const problems: string[] = [];
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task || task.length > 200) problems.push('task: a short phrase, up to 200 characters');
  if (!(KINDS as readonly unknown[]).includes(input.kind)) problems.push(`kind: one of ${KINDS.join(', ')}`);
  if (!(IMPACTS as readonly unknown[]).includes(input.impact)) problems.push(`impact: one of ${IMPACTS.join(', ')}`);
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length < 10 || description.length > 4096) problems.push('description: 10 to 4,096 characters');
  else if (PLACEHOLDERS.has(description.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))) problems.push('description: say what you tried and what went wrong, or skip feedback');
  if (problems.length) return `Invalid feedback: ${problems.join('; ')}`;
  const operation = line(input.tool_name, 100);
  return { task, kind: input.kind as string, impact: input.impact as string, description, ...(operation ? { operation } : {}), surface: 'mcp' };
}

const sent = new Map<string, number>();
/** Thrown with a message for the agent; tools.ts turns it into an isError result. */
export class FeedbackRefused extends Error {}

/**
 * The tool. `who` keys the per-session limit: the SDK counts per MCP session; this server is
 * stateless (no MCP session id), so it counts per person per day, in this instance's memory.
 */
export async function sendFeedback(input: Record<string, unknown>, who: string, today = new Date().toISOString().slice(0, 10)) {
  if (!enabled() || !outbox) throw new FeedbackRefused('Feedback is turned off here.');
  const slot = `${who}|${today}`;
  const used = sent.get(slot) ?? 0;
  if (used >= MAX_PER_SESSION) throw new FeedbackRefused('Feedback for this session has already been sent. Thanks, carry on.');
  const fb = normalize(input);
  if (typeof fb === 'string') throw new FeedbackRefused(fb);
  const clean: Feedback = { ...fb, task: scrub(fb.task).slice(0, 200), description: scrub(fb.description).slice(0, 4096), ...(fb.operation ? { operation: scrub(fb.operation).slice(0, 100) } : {}) };
  const id = randomUUID();
  if (!await put({ kind: 'feedback', id, feedback: clean })) throw new FeedbackRefused("Feedback couldn't be sent. Carry on with the task.");
  if (sent.size >= 1000 && !sent.has(slot)) sent.delete(sent.keys().next().value!);
  sent.set(slot, used + 1);
  return { feedback_id: `fbk_${id.replaceAll('-', '')}`, speak: `Sent to the ${PRODUCT} team. Thanks.` };
}
/** For tests. */
export function resetFeedbackLimits() { sent.clear(); }
