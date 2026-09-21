import type { Session } from '../types.js';

export interface AttentionResult {
  /** session id → attention minutes within the window */
  attention: Map<string, number>;
  /** session id → wall-clock minutes within the window */
  wall: Map<string, number>;
  /** stretches where more than `overlapThreshold` sessions ran at once */
  overlaps: { start: string; end: string; count: number }[];
}

/**
 * Splits attention among overlapping sessions.
 * At every instant, the running sessions share attention in proportion to their weights,
 * so a day never exceeds 24h of attention while each session keeps its wall-clock time.
 * If any running session is `exclusive`, only exclusive sessions share attention at that instant.
 */
export function computeAttention(sessions: Session[], windowStart: Date, windowEnd: Date, now: Date = new Date(), overlapThreshold = 2): AttentionResult {
  const attention = new Map<string, number>();
  const wall = new Map<string, number>();
  const overlaps: AttentionResult['overlaps'] = [];

  const clipped = sessions
    .map(s => {
      const start = Math.max(new Date(s.start).getTime(), windowStart.getTime());
      const end = Math.min(s.end ? new Date(s.end).getTime() : now.getTime(), windowEnd.getTime());
      return { s, start, end };
    })
    .filter(x => x.end > x.start);

  for (const { s, start, end } of clipped) wall.set(s.id, (end - start) / 60000);

  const bounds = Array.from(new Set(clipped.flatMap(x => [x.start, x.end]))).sort((a, b) => a - b);
  let overlapRun: { start: number; end: number; count: number } | null = null;

  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b <= a) continue;
    let active = clipped.filter(x => x.start <= a && x.end >= b);
    if (active.length === 0) continue;
    const exclusive = active.filter(x => x.s.exclusive);
    if (exclusive.length > 0) active = exclusive;
    const total = active.reduce((sum, x) => sum + Math.max(0, x.s.weight || 1), 0) || active.length;
    const minutes = (b - a) / 60000;
    for (const x of active) {
      const w = total > 0 ? Math.max(0, x.s.weight || 1) / total : 1 / active.length;
      attention.set(x.s.id, (attention.get(x.s.id) ?? 0) + minutes * w);
    }
    if (active.length > overlapThreshold) {
      if (overlapRun && overlapRun.end === a) { overlapRun.end = b; overlapRun.count = Math.max(overlapRun.count, active.length); }
      else { if (overlapRun) overlaps.push(fmtRun(overlapRun)); overlapRun = { start: a, end: b, count: active.length }; }
    } else if (overlapRun) { overlaps.push(fmtRun(overlapRun)); overlapRun = null; }
  }
  if (overlapRun) overlaps.push(fmtRun(overlapRun));
  return { attention, wall, overlaps };
}

function fmtRun(r: { start: number; end: number; count: number }) {
  return { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), count: r.count };
}

/** Gaps of at least `minGapMin` minutes between the first session start and the last session end. */
export function findGaps(sessions: Session[], windowStart: Date, windowEnd: Date, now: Date = new Date(), minGapMin = 20): { start: string; end: string; minutes: number }[] {
  const iv = sessions
    .map(s => ({ start: Math.max(new Date(s.start).getTime(), windowStart.getTime()), end: Math.min(s.end ? new Date(s.end).getTime() : now.getTime(), windowEnd.getTime()) }))
    .filter(x => x.end > x.start)
    .sort((a, b) => a.start - b.start);
  const gaps: { start: string; end: string; minutes: number }[] = [];
  let cursor = iv[0]?.end ?? 0;
  for (let i = 1; i < iv.length; i++) {
    if (iv[i].start > cursor) {
      const minutes = (iv[i].start - cursor) / 60000;
      if (minutes >= minGapMin) gaps.push({ start: new Date(cursor).toISOString(), end: new Date(iv[i].start).toISOString(), minutes: Math.round(minutes) });
    }
    cursor = Math.max(cursor, iv[i].end);
  }
  return gaps;
}
