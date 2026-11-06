/**
 * The day's progress post, written from the record and nothing else. A bad day reads as a
 * bad day: no time on the aim says so, a main step not done says so. Nothing is invented,
 * and nothing is left out to make the day look better.
 */
import { BLUESKY_MAX, graphemes } from './clients.js';

export interface DayFacts {
  aim: { title: string; kind: 'count' | 'done'; current?: number; target?: number; stagesDone?: number; stagesTotal?: number; reached?: boolean };
  mainStep: { planned: boolean; done: boolean; title: string | null };
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
}

export const SIGNATURE = 'Tracked with aimyear.com';

export function minutesText(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60), m = n % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function cut(s: string, n: number): string {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
  return parts.length <= n ? s : parts.slice(0, Math.max(1, n - 1)).join('').trimEnd() + '…';
}

function render(f: DayFacts, aimTitle: string, stepTitle: string | null): string {
  const lines: string[] = [];
  const a = f.aim;
  const progress = a.kind === 'done'
    ? (a.reached ? 'done' : `${a.stagesDone ?? 0} of ${a.stagesTotal ?? 0} stages done`)
    : `${a.current ?? 0} of ${a.target ?? 0}`;
  lines.push(`Aim: ${aimTitle} (${progress}).`);
  if (f.backAfterDays) lines.push(f.backAfterDays === 1 ? 'Back after a missed day.' : `Back after ${f.backAfterDays} missed days.`);
  if (!f.mainStep.planned) lines.push('No main step planned today.');
  else lines.push(`Main step ${f.mainStep.done ? 'done' : 'not done'}: ${stepTitle}`);
  const mv = f.moves ?? { aim: 0, hard: 0 };
  const movesLine = mv.aim ? `${mv.aim} ${mv.aim === 1 ? 'move' : 'moves'} toward the aim${mv.hard ? `, ${mv.hard} on the hard part` : ''}.` : '';
  if (f.quiet) lines.push(movesLine || 'No moves toward the aim today.');
  else {
    lines.push(f.goalMin > 0
      ? `${minutesText(f.goalMin)} on the aim${f.hardMin > 0 ? `, ${minutesText(f.hardMin)} of it on the hard part` : ', none on the hard part'}.`
      : mv.aim ? 'No focused time on the aim today.' : 'No time on the aim today.');
    if (movesLine) lines.push(movesLine);
  }
  const r = f.routines;
  const rParts = [r.full && `${r.full} done`, r.minimum && `${r.minimum} at the minimum`, r.missed && `${r.missed} missed`].filter(Boolean);
  if (rParts.length) lines.push(`Routines: ${rParts.join(', ')}.`);
  if (f.week) lines.push(`This week: ${f.week.days} of ${f.week.target} days toward the aim.`);
  lines.push(SIGNATURE);
  return lines.join('\n');
}

/** The draft, within max graphemes (Bluesky's 300): long titles are shortened, never the facts. */
export function buildDraft(f: DayFacts, max = BLUESKY_MAX): string {
  let aimT = f.aim.title.trim(), stepT = f.mainStep.title?.trim() ?? null;
  let text = render(f, aimT, stepT);
  for (let i = 0; i < 50 && graphemes(text) > max; i++) {
    const over = graphemes(text) - max;
    const a = graphemes(aimT), s = stepT ? graphemes(stepT) : 0;
    if (stepT && s >= a && s > 12) stepT = cut(stepT, Math.max(12, s - over - 1));
    else if (a > 12) aimT = cut(aimT, Math.max(12, a - over - 1));
    else break;
    text = render(f, aimT, stepT);
  }
  return text;
}
