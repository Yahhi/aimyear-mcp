/**
 * The day's progress post, written from the record and nothing else (docs/public-posting.md).
 * It leads with what moved toward the aim, in the user's words: the summaries of the day's
 * sessions toward the aim and the day's moves. The numbers come after, if there is room.
 * A day with nothing recorded toward the aim has no post (nothingToPost). A bad day reads
 * as a bad day: a main step not done says so. Nothing is invented, and nothing is left out
 * to make the day look better.
 */
import { amount } from '../domain/numbers.js';
import { BLUESKY_MAX, graphemes } from './clients.js';
import { daysTowardAim } from '../service.js';

export interface DayFacts {
  aim: { title: string; kind: 'count' | 'done'; current?: number; target?: number; stagesDone?: number; stagesTotal?: number; reached?: boolean };
  mainStep: { planned: boolean; done: boolean; title: string | null };
  /** What moved toward the aim, in the user's words and the order it happened: session summaries (else the task) and moves. */
  done?: string[];
  /** Attention minutes on the aim, and the part of it on hard levers. */
  goalMin: number;
  hardMin: number;
  routines: { full: number; minimum: number; missed: number };
  /** The main step is done after this many missed working days. */
  backAfterDays?: number;
  /** Moves toward the aim that day, and how many were on the hard part (docs/moves.md). */
  moves?: { aim: number; hard: number };
  /** Tracking moves or quiet: the post never mentions minutes. */
  quiet?: boolean;
  /** Days toward the aim this week so far, against the weekly target. */
  week?: { days: number; target: number };
  /** The day's work for WIP, one group per project (see WipGroup). */
  wip?: WipGroup[];
  /** Projects left out of the WIP part: they already got their automatic todo that day. */
  wipLeftOut?: string[];
}

/**
 * One project's work that day, for its own WIP todo (docs/public-posting.md, "WIP posts are
 * about a project"): work toward the aim, and work on any project the user gave a WIP
 * hashtag. key names the todo for "one post per day, network and project".
 */
export interface WipGroup { key: string; project: string | null; hashtag: string | null; done: string[] }
export interface WipTodo { key: string; project: string | null; hashtag: string | null; text: string }
/** A WIP todo stays short: it says what was done on one project. */
export const WIP_MAX = 500;

export const SIGNATURE = 'Tracked with aimyear.com';

/** Nothing recorded toward the aim (no session, no move, main step not done): ask the user to record what they did first. */
export const nothingToPost = (f: DayFacts) => !f.done?.length && !f.mainStep.done;

export function minutesText(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60), m = n % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** At most n graphemes, ending on a whole word when one ends near the limit. */
function cut(s: string, n: number): string {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
  if (parts.length <= n) return s;
  const head = parts.slice(0, Math.max(1, n - 1)).join('');
  const sp = head.lastIndexOf(' ');
  return (sp >= head.length * 0.6 ? head.slice(0, sp) : head).trimEnd().replace(/[,;:–-]+$/, '') + '…';
}

const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…]+$/, '').trim();
/** One line of the post: the user's words, with a capital (not on "iOS" or "wip.co") and an end mark. */
const sentence = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  const c = /^[a-z]+(\s|$)/.test(t) ? t[0].toUpperCase() + t.slice(1) : t;
  return /[.!?…]$/.test(c) ? c : `${c}.`;
};

/** The same thing said twice (a session and the move it became, a summary repeated) is said once. */
export function uniqueDone(xs: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const x of xs) { const k = key(x); if (k && !seen.has(k)) { seen.add(k); out.push(sentence(x)); } }
  return out;
}

/** Said the same way as weekProgress and the weekly review email (daysTowardAim). */
const weekText = (w: { days: number; target: number }) => `This week: ${daysTowardAim(w.days, w.target)}.`;

/**
 * The draft, within max graphemes (Bluesky's 300). What moved and the main step always go
 * in, shortened if they must be; the aim and the numbers follow in order of weight while
 * they fit. The aimyear.com line always ends it.
 */
export function buildDraft(f: DayFacts, max = BLUESKY_MAX): string {
  let items = uniqueDone(f.done ?? []);
  let dropped = 0;
  let stepT = f.mainStep.title?.trim() || null;
  const stepSaid = stepT !== null && items.some(x => key(x) === key(stepT!));
  const stepLine = () => !f.mainStep.planned ? null
    : stepSaid ? `Main step ${f.mainStep.done ? 'done' : 'not done'}.`
      : `Main step ${f.mainStep.done ? 'done' : 'not done'}: ${stepT}`;
  // Lines in the order they read; `null` is not in the post.
  const head = () => [...items, ...(dropped ? [`And ${dropped} more.`] : []), stepLine()];
  const join = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).join('\n');

  const a = f.aim;
  const progress = a.kind === 'done'
    ? (a.reached ? 'done' : `${a.stagesDone ?? 0} of ${a.stagesTotal ?? 0} stages done`)
    : `${amount(a.current)} of ${amount(a.target)}`;
  const aimLine = (t: string) => `Aim: ${t} (${progress}).`;
  const aimT = a.title.trim();

  // 1. What moved, the main step and the signature, made to fit with room left for the
  // aim: the longest text is shortened first, then the last items give way to "And N more.".
  const room = max - graphemes(aimLine(cut(aimT, 30))) - 1;
  for (let i = 0; i < 100 && graphemes(join([...head(), SIGNATURE])) > room; i++) {
    const over = graphemes(join([...head(), SIGNATURE])) - room;
    const s = stepT && !stepSaid && f.mainStep.planned ? graphemes(stepT) : 0;
    const li = items.reduce((b, x, j) => graphemes(x) > graphemes(items[b]) ? j : b, 0);
    const l = items.length ? graphemes(items[li]) : 0;
    if (s >= l && s > 24) stepT = cut(stepT!, Math.max(24, s - over - 1));
    else if (l > 60) items[li] = cut(items[li], Math.max(60, l - over - 1));
    else if (items.length > 1) { items = items.slice(0, -1); dropped++; }
    else if (l > 12) items[li] = cut(items[li], Math.max(12, l - over - 1));
    else if (s > 12) stepT = cut(stepT!, Math.max(12, s - over - 1));
    else break;
  }

  // 2. The rest, most telling first (the week against the target is the number AimYear
  // leads with, docs/moves.md), each only if it still fits.
  const mv = f.moves ?? { aim: 0, hard: 0 };
  const r = f.routines;
  const rParts = [r.full && `${r.full} done`, r.minimum && `${r.minimum} at the minimum`, r.missed && `${r.missed} missed`].filter(Boolean);
  const nothing = !items.length && !f.mainStep.done;
  const slots: Record<string, string | null> = { aim: null, back: null, minutes: null, moves: null, routines: null, week: null, noStep: null };
  const order = ['noStep', 'aim', 'back', 'minutes', 'moves', 'routines', 'week'] as const;
  const text = () => join([...head(), ...order.map(k => slots[k]), SIGNATURE]);
  const offer = (k: keyof typeof slots, line: string | null) => { if (!line) return; slots[k] = line; if (graphemes(text()) > max) slots[k] = null; };

  slots.aim = aimLine(aimT);
  const over = graphemes(text()) - max;
  if (over > 0) slots.aim = graphemes(aimT) - over - 1 >= 12 ? aimLine(cut(aimT, graphemes(aimT) - over - 1)) : null;
  offer('back', f.backAfterDays ? (f.backAfterDays === 1 ? 'Back after a missed day.' : `Back after ${f.backAfterDays} missed days.`) : null);
  offer('week', f.week ? weekText(f.week) : null);
  if (!f.quiet) offer('minutes', f.goalMin > 0
    ? `${minutesText(f.goalMin)} on the aim${f.hardMin > 0 ? `, ${minutesText(f.hardMin)} of it on the hard part` : ', none on the hard part'}.`
    : nothing ? 'No time on the aim today.' : null);
  offer('moves', mv.aim ? `${mv.aim} ${mv.aim === 1 ? 'move' : 'moves'} toward the aim${mv.hard ? `, ${mv.hard} on the hard part` : ''}.`
    : f.quiet && nothing ? 'No moves toward the aim today.' : null);
  offer('routines', rParts.length ? `Routines: ${rParts.join(', ')}.` : null);
  offer('noStep', f.mainStep.planned ? null : 'No main step planned today.');
  return text();
}

/** One WIP todo per project: what was done on it, in the user's words, then its #hashtag. */
export function buildWipTodos(groups: WipGroup[], max = WIP_MAX): WipTodo[] {
  return groups.flatMap(g => {
    const items = uniqueDone(g.done);
    if (!items.length) return [];
    const tag = g.hashtag ? ` #${g.hashtag}` : '';
    const body = items.join(' ');
    return [{ key: g.key, project: g.project, hashtag: g.hashtag, text: (graphemes(body) + graphemes(tag) > max ? cut(body, max - graphemes(tag)) : body) + tag }];
  });
}
