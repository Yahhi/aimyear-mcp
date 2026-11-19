/**
 * The rules of automatic WIP todos (docs/public-posting.md, "Work posts to WIP, automatic
 * with undo"), kept apart from the service so each one reads on its own. No AI model: the
 * todo is the user's (or their agent's) own words, trimmed.
 */
import { buildWipTodos, WIP_MAX } from './draft.js';
import { graphemes } from './clients.js';

/** The undo: a todo posts this long after the work ended, and never sooner than this after it was queued. */
export const UNDO_MS = 10 * 60000;
/** Work on the same project and task within this long of a queued or posted todo joins it. */
export const JOIN_MS = 2 * 3600000;
/** A summary this long (graphemes) is a real summary, worth a todo by itself. */
export const REAL_SUMMARY_MIN = 60;
/** What the summary must say beyond the task title, so "<task> done." is not a real summary. */
const BEYOND_TASK_MIN = 20;
/** A failed send is tried again this much later, this many times in all. */
export const RETRY_MS = 5 * 60000;
export const MAX_ATTEMPTS = 3;

/** Summaries the server writes itself, not the person: "Closed when the timer stopped.", "Stood up for a break.", the auto-close note. */
export const PLACEHOLDER = /^(auto-closed:|closed when the timer stopped\.?$|stood up for a break\.?$)/i;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A real summary: at least REAL_SUMMARY_MIN graphemes, and more than the task title again
 * (what is left once the title's words are taken out is at least BEYOND_TASK_MIN long).
 */
export function isRealSummary(summary: string | undefined, task: string): boolean {
  const s = summary?.trim() ?? '';
  if (!s || PLACEHOLDER.test(s) || graphemes(s) < REAL_SUMMARY_MIN) return false;
  const t = norm(task);
  const rest = t ? norm(s).replace(t, ' ').replace(/\s+/g, ' ').trim() : norm(s);
  return rest.length >= BEYOND_TASK_MIN;
}

/** A summary that says nothing (empty, or one the server wrote): such work never posts or offers anything by itself. */
export const isPlaceholder = (summary: string | undefined) => !summary?.trim() || PLACEHOLDER.test(summary.trim());

/** Which task a piece of work was on: the same plan item, else the same path step, else the same task title. */
export function sameTask(a: { task: string; itemId?: string; stepId?: string }, b: { task: string; itemId?: string; stepId?: string }): boolean {
  if (a.itemId && b.itemId) return a.itemId === b.itemId;
  if (a.stepId && b.stepId) return a.stepId === b.stepId;
  return norm(a.task) !== '' && norm(a.task) === norm(b.task);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The todo: the parts in the user's words, one sentence each and said once, then the
 * project's #hashtag, within WIP_MAX. A hashtag the text already ends with is not added
 * twice; one it carries inside is left where it is.
 */
export function todoText(parts: string[], hashtag: string | null): string {
  const tail = hashtag ? new RegExp(`\\s*#${escape(hashtag)}[\\s.!?…]*$`, 'i') : null;
  const clean = parts.map(p => (tail ? p.replace(tail, '') : p).trim()).filter(Boolean);
  const inside = hashtag ? clean.some(p => new RegExp(`(^|\\s)#${escape(hashtag)}(?![A-Za-z0-9_])`, 'i').test(p)) : false;
  return buildWipTodos([{ key: 'auto', project: null, hashtag: inside ? null : hashtag, done: clean }], WIP_MAX)[0]?.text ?? '';
}

/** The parts of a queued todo's text, without its trailing hashtag, to extend it with more. */
export function todoBody(text: string, hashtag: string | null): string {
  return hashtag ? text.replace(new RegExp(`\\s*#${escape(hashtag)}\\s*$`, 'i'), '').trim() : text.trim();
}
