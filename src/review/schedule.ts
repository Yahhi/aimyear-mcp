/**
 * When the weekly review email goes out (docs/weekly-review.md): Sunday at 19:00 in the
 * person's timezone. Pure helpers; the pending doc and the sending live in deliver.ts and
 * AimService.armWeeklyReview.
 */
import { addDays, atLocal, isoWeekday, localDate, localTime, weekStart } from '../dates.js';

export const REVIEW_HOUR = '19:00';
/** One pending doc per person, overwritten on each arm. */
export const reviewPendingId = (uid: string) => `weekly-review-${uid}`;

/** The next Sunday 19:00 local strictly after `now`, and the Monday of the week it reviews. */
export function nextReviewDue(tz: string, now: Date): { week: string; sunday: string; dueAt: string } {
  const today = localDate(now, tz);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    if (isoWeekday(date) !== 7) continue;
    const due = atLocal(date, REVIEW_HOUR, tz);
    if (due.getTime() <= now.getTime()) continue;
    return { week: weekStart(date), sunday: date, dueAt: due.toISOString() };
  }
  throw new Error('unreachable: a Sunday comes within 8 days');
}

/**
 * Is `now` the Sunday evening a review may go out (Sunday, 19:00 or later, local)? A tick
 * that comes late the same evening still sends; one that comes on Monday does not.
 */
export function reviewWindow(tz: string, now: Date): { open: true; week: string } | { open: false; reason: string } {
  const date = localDate(now, tz);
  if (isoWeekday(date) !== 7) return { open: false, reason: `not Sunday in ${tz} (${date})` };
  if (localTime(now, tz) < REVIEW_HOUR) return { open: false, reason: `before ${REVIEW_HOUR} in ${tz}` };
  return { open: true, week: weekStart(date) };
}
