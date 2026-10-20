/**
 * Week and month insights, computed the way the AimYear app computed them on the device
 * (aimyear-v2 lib/domain/insights.dart and comebacks.dart), so moving the numbers to the
 * server changes nothing the user sees:
 *  - minutes are wall minutes of finished sessions, counted on the local date the session
 *    started (as list_sessions reports them); the attention split is not used;
 *  - aim = main_step, goal_hard, goal_comfortable; life = life; everything else is other;
 *  - a goal minute is hard when its lever is hard; without a known lever, when it is
 *    main_step or goal_hard;
 *  - the heatmap has weekdays Mon..Sun and hours 6:00..23:00; a session's minutes fill
 *    the hours from its start and stop at midnight;
 *  - an active day has 10+ goal minutes or a main_step session finished as done; a
 *    comeback is an active day after 2 or more days away.
 */
import { addDays, daysBetween } from '../dates.js';
import type { Area, LeverKind } from '../types.js';

export interface InsightRow {
  date: string;
  /** HH:MM local start. */
  from: string;
  wall_min: number | null;
  classification: string;
  area: Area;
  lever_id?: string;
  outcome?: string;
}

export const FIRST_HOUR = 6;
export const HOURS = 18;
export const COMEBACK_MIN_GOAL_MIN = 10;
export const COMEBACK_MIN_GAP = 2;
export const COMEBACK_HISTORY_DAYS = 90;

const isGoal = (c: string) => c === 'main_step' || c === 'goal_hard' || c === 'goal_comfortable';
/** ISO weekday 1..7 of a YYYY-MM-DD. */
const weekdayOf = (date: string) => { const [y, m, d] = date.split('-').map(Number); return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1; };

export function isHard(r: InsightRow, leverKind: (id: string | undefined) => LeverKind | undefined): boolean {
  const k = leverKind(r.lever_id);
  if (k) return k === 'hard';
  return r.classification === 'goal_hard' || r.classification === 'main_step';
}

export function computeInsights(input: { from: string; to: string; rows: InsightRow[]; leverKind: (id: string | undefined) => LeverKind | undefined; mainStepDays: Set<string> }) {
  const { from, to, rows, leverKind, mainStepDays } = input;
  const days = new Map<string, { date: string; aim_min: number; other_min: number; life_min: number; total_min: number; main_step_done: boolean }>();
  for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { date: d, aim_min: 0, other_min: 0, life_min: 0, total_min: 0, main_step_done: mainStepDays.has(d) });
  let hard = 0, comfortable = 0;
  const byArea: Partial<Record<Area, number>> = {};
  const goal = Array.from({ length: 7 }, () => new Array<number>(HOURS).fill(0));
  const goalHard = Array.from({ length: 7 }, () => new Array<number>(HOURS).fill(0));
  for (const r of rows) {
    const day = days.get(r.date);
    const m = r.wall_min ?? 0;
    if (!day || m <= 0) continue;
    if (isGoal(r.classification)) {
      day.aim_min += m;
      const h = isHard(r, leverKind);
      if (h) hard += m; else comfortable += m;
      spread(goal, goalHard, r, m, h);
    } else if (r.classification === 'life') day.life_min += m;
    else day.other_min += m;
    day.total_min += m;
    byArea[r.area] = (byArea[r.area] ?? 0) + m;
  }
  let peak: { weekday: number; hour: number; minutes: number } | null = null;
  for (let d = 0; d < 7; d++) for (let h = 0; h < HOURS; h++) if (goalHard[d][h] > (peak?.minutes ?? 0)) peak = { weekday: d + 1, hour: h + FIRST_HOUR, minutes: goalHard[d][h] };
  const list = [...days.values()];
  const sum = (k: 'aim_min' | 'other_min' | 'life_min' | 'total_min') => list.reduce((s, d) => s + d[k], 0);
  return {
    days: list,
    totals: { aim_min: sum('aim_min'), other_min: sum('other_min'), life_min: sum('life_min'), total_min: sum('total_min') },
    hard_min: hard, comfortable_min: comfortable,
    hard_share: hard + comfortable ? Math.round((hard / (hard + comfortable)) * 100) / 100 : 0,
    by_area: byArea,
    main_step_days: list.filter(d => d.main_step_done).length,
    heatmap: { first_hour: FIRST_HOUR, hours: HOURS, weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], goal_min: goal, hard_min: goalHard },
    peak_hard: peak,
  };
}

function spread(goal: number[][], goalHard: number[][], r: InsightRow, minutes: number, hard: boolean) {
  const wd = weekdayOf(r.date) - 1;
  const [hh, mm] = r.from.split(':').map(Number);
  let start = (hh || 0) * 60 + (mm || 0);
  let left = minutes;
  while (left > 0) {
    const hour = Math.floor(start / 60);
    const inHour = Math.min(left, 60 - (start % 60));
    const idx = hour - FIRST_HOUR;
    if (idx >= 0 && idx < HOURS) { goal[wd][idx] += inHour; if (hard) goalHard[wd][idx] += inHour; }
    left -= inHour; start += inHour;
    if (start >= 24 * 60) break;
  }
}

/** Comebacks, not streaks: active days, and the active days that came after time away. */
export function computeComebacks(today: string, rows: InsightRow[], minGap = COMEBACK_MIN_GAP) {
  const goalMin = new Map<string, number>();
  const active = new Set<string>();
  for (const r of rows) {
    if (!isGoal(r.classification)) continue;
    goalMin.set(r.date, (goalMin.get(r.date) ?? 0) + (r.wall_min ?? 0));
    if (r.classification === 'main_step' && r.outcome === 'done') active.add(r.date);
  }
  for (const [d, m] of goalMin) if (m >= COMEBACK_MIN_GOAL_MIN) active.add(d);
  const sorted = [...active].filter(d => d <= today).sort();
  const comebackDays: string[] = [];
  for (let i = 1; i < sorted.length; i++) if (daysBetween(sorted[i - 1], sorted[i]) - 1 >= minGap) comebackDays.push(sorted[i]);
  const last7 = Array.from({ length: 7 }, (_, i) => active.has(addDays(today, i - 6)));
  return {
    count: comebackDays.length,
    days: comebackDays,
    active_days: sorted,
    last7,
    active_in_last7: last7.filter(Boolean).length,
    away_before_latest: sorted.length < 2 ? 0 : daysBetween(sorted[sorted.length - 2], sorted[sorted.length - 1]) - 1,
    active_today: active.has(today),
    min_gap_days: minGap,
  };
}
