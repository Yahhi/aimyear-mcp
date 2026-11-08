/**
 * Busy calendar time against a day's focus windows (docs/calendar-sync.md: busy events
 * count as time already spoken for). Pure functions over instants, no I/O.
 *
 * For one local day:
 *  1. busy intervals from the chosen calendars, merged and clipped to the day;
 *  2. minus the day's timed commitments and overhead: those are spoken for already, and
 *     a school run that is also in the calendar must not be taken twice;
 *  3. what falls inside a timed focus window comes off that window;
 *  4. the rest comes off the windows without a start time, up to their size: AimYear
 *     can't tell where in the day those fall, so it leans toward less free time.
 */
import { localTime, startOfDay, endOfDay } from '../dates.js';
import type { Commitment } from '../types.js';

export interface Span { start: number; end: number }
export interface IsoSpan { start: string; end: string }

export function merge(spans: Span[]): Span[] {
  const s = spans.filter(x => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

export function clip(spans: Span[], from: number, to: number): Span[] {
  return merge(spans.map(x => ({ start: Math.max(x.start, from), end: Math.min(x.end, to) })));
}

/** a minus b, both merged. */
export function subtract(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of merge(a)) {
    let parts = [x];
    for (const y of merge(b)) {
      parts = parts.flatMap(p => (y.end <= p.start || y.start >= p.end) ? [p] : [
        ...(y.start > p.start ? [{ start: p.start, end: y.start }] : []),
        ...(y.end < p.end ? [{ start: y.end, end: p.end }] : []),
      ]);
    }
    out.push(...parts);
  }
  return out;
}

export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of merge(a)) for (const y of merge(b)) {
    const s = Math.max(x.start, y.start), e = Math.min(x.end, y.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return merge(out);
}

export const minutes = (spans: Span[]) => Math.round(spans.reduce((n, x) => n + (x.end - x.start), 0) / 60000);

export const toSpans = (iso: IsoSpan[]): Span[] => iso.map(x => ({ start: Date.parse(x.start), end: Date.parse(x.end) })).filter(x => Number.isFinite(x.start) && Number.isFinite(x.end));
export const toIso = (spans: Span[]): IsoSpan[] => spans.map(x => ({ start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() }));

const isoWeekday = (date: string) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; };
const at = (date: string, hhmm: string, tz: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return startOfDay(date, tz).getTime() + (h * 60 + m) * 60000;
};
const timed = (c: Commitment) => !!c.start && /^\d{1,2}:\d{2}$/.test(c.start);

export interface FocusDay {
  /** Window minutes as declared for the weekday, net of commitments carved out of them. */
  declared_min: number;
  /** All busy minutes of the day from the chosen calendars. */
  busy_min: number;
  /** Busy minutes that came off the focus windows. */
  calendar_min: number;
  /** What is left for focus work: declared minus calendar. */
  net_min: number;
  /** Busy times of the day as local HH:MM, merged. Never a title. */
  busy: { start: string; end: string }[];
}

export function focusDay(date: string, tz: string, commitments: Commitment[], busyIso: IsoSpan[]): FocusDay {
  const dow = isoWeekday(date);
  const on = commitments.filter(c => c.days.includes(dow));
  const gross = on.filter(c => c.kind === 'window').reduce((s, c) => s + c.minutes, 0);
  const carved = on.filter(c => c.kind === 'commitment' && c.insideWindowId).reduce((s, c) => s + c.minutes, 0);
  const declared = Math.max(0, gross - carved);
  const from = startOfDay(date, tz).getTime(), to = endOfDay(date, tz).getTime();
  const busy = clip(toSpans(busyIso), from, to);
  const spoken = on.filter(c => c.kind !== 'window' && timed(c)).map(c => ({ start: at(date, c.start!, tz), end: at(date, c.start!, tz) + c.minutes * 60000 }));
  const free = subtract(busy, spoken);
  const windows = on.filter(c => c.kind === 'window' && timed(c)).map(c => ({ start: at(date, c.start!, tz), end: at(date, c.start!, tz) + c.minutes * 60000 }));
  const inTimed = minutes(intersect(free, windows));
  const untimed = on.filter(c => c.kind === 'window' && !timed(c)).reduce((s, c) => s + c.minutes, 0);
  const fromUntimed = Math.min(untimed, Math.max(0, minutes(free) - inTimed));
  const calendar = Math.min(declared, inTimed + fromUntimed);
  return {
    declared_min: declared, busy_min: minutes(busy), calendar_min: calendar, net_min: Math.max(0, declared - calendar),
    busy: busy.map(x => ({ start: localTime(new Date(x.start), tz), end: x.end >= to ? '24:00' : localTime(new Date(x.end), tz) })),
  };
}
