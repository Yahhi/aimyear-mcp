/**
 * How AimYear turns minutes and counts into the numbers people see (docs/metrics.md).
 * The app has the same functions in lib/domain/numbers.dart, and the parity test checks
 * that both give the same answers.
 *
 *  1. Compute from exact sums, round once, at the end: never from already-rounded parts.
 *  2. Multiply before dividing: 100 * 23 / 40 is exactly 57.5, 23 / 40 * 100 is 57.49999.
 *  3. Halves round away from zero, also below zero: 12.5 -> 13, -12.5 -> -13 (Math.round
 *     gives -12, Dart's round() gives -13, so neither is used directly).
 *  4. Pool minutes across days, never average shares.
 */

/** Rounds half away from zero to `decimals` places, after clearing float noise (0.285 * 100 = 28.499999999999996). */
export function roundHalf(x: number, decimals = 0): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** decimals;
  const scaled = Number((Math.abs(x) * f).toPrecision(12));
  const r = Math.floor(scaled + 0.5) / f;
  return x < 0 && r !== 0 ? -r : r;
}

/** part / whole as a fraction with 2 decimals (0.29 for 29%); 0 when whole is 0. */
export function share(part: number, whole: number): number {
  return whole ? roundHalf((100 * part) / whole) / 100 : 0;
}

/** part / whole as a whole percent (29); 0 when whole is 0. */
export function percent(part: number, whole: number): number {
  return whole ? roundHalf((100 * part) / whole) : 0;
}

/** Minutes for display: whole minutes, rounded once from the exact sum. */
export const minutes = (m: number) => roundHalf(m);

/** Hours with one decimal from minutes. */
export const hours = (m: number) => roundHalf(m / 60, 1);

/** An aim or stage value: whole numbers as they are, else one decimal (2.25 -> "2.3"). */
export function amount(v: number | null | undefined): string {
  const x = v ?? 0;
  return Number.isInteger(x) ? String(x) : String(roundHalf(x, 1));
}

/**
 * Is this aim work on the hard part? The lever decides when it is known; without a known
 * lever, main_step and goal_hard are hard. The one definition for every hard number:
 * summaries, insights, the weekly email, the post draft, the app.
 */
export function isHardWork(x: { classification: string; lever_id?: string | null }, leverKind: (id: string | undefined) => string | undefined): boolean {
  const k = leverKind(x.lever_id ?? undefined);
  if (k) return k === 'hard';
  return x.classification === 'goal_hard' || x.classification === 'main_step';
}

export const GOAL_CLASSES = ['main_step', 'goal_hard', 'goal_comfortable'];
export const isGoalClass = (c: string) => GOAL_CLASSES.includes(c);
