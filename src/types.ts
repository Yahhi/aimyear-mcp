export const AREAS = ['health', 'relations', 'work', 'money', 'happiness'] as const;
export type Area = (typeof AREAS)[number];

export type LeverKind = 'hard' | 'comfortable';
export interface MatchHints { repos: string[]; keywords: string[] }
export interface Lever { id: string; name: string; kind: LeverKind; examples: string[]; match: MatchHints }
export interface Project { id: string; name: string; area: Area; match: MatchHints }

export interface Goal {
  title: string;
  area: Area;
  why: string;
  metric: string;
  baseline: number;
  target: number;
  deadline: string; // YYYY-MM-DD
  baselineHistory: { value: number; date: string }[];
  levers: Lever[];
  projects: Project[];
  createdAt: string;
  updatedAt: string;
}

export type ItemStatus = 'todo' | 'doing' | 'done';
/** retired: dropped without finishing; it no longer counts as the current milestone. */
export type MilestoneStatus = ItemStatus | 'retired';
export interface Milestone { id: string; title: string; metric: string; target: number; due: string; status: MilestoneStatus; createdAt: string; doneAt?: string }
export interface Step { id: string; milestoneId: string; title: string; leverId?: string; estimateMin: number; order: number; status: ItemStatus; doneAt?: string }
export interface Path { milestones: Milestone[]; steps: Step[] }

/** A recurring weekly commitment: fixed time that is already spoken for. */
export type CommitmentKind =
  | 'commitment'  // unavailable, and it belongs to one of the five areas
  | 'overhead'    // unavailable, belongs to no area: sleep, meals, hygiene, moving between places
  | 'window';     // available for focus work: the positive space in the week

export interface Commitment {
  id: string;
  title: string;
  kind: CommitmentKind;
  /** Ignored for kind 'overhead' and 'window'. */
  area?: Area;
  /** ISO weekdays 1=Mon..7=Sun. Empty when the commitment has no fixed days. */
  days: number[];
  /** Used instead of `days` when it happens N times a week without fixed days. */
  timesPerWeek?: number;
  start?: string;      // HH:MM, optional
  minutes: number;     // per occurrence
  /** Kept for compatibility: a commitment that is nonetheless workable. Prefer kind 'window'. */
  usableForWork?: boolean;
  /** Set when the number is Claude's inference rather than something the user stated. */
  assumed?: boolean;
  /** Id of a kind:'window' commitment this one is carved out of, so the window is not counted twice. */
  insideWindowId?: string;
  projectId?: string;
  note?: string;
}

export type Mode = 'full' | 'focus' | 'off';
export type Workplace = 'desktop' | 'mobile';

/**
 * A small step that repeats on fixed weekdays, e.g. "talk with one person on Reddit".
 * The server adds it to each matching day's plan, so every device and agent sees the
 * same checks without anyone planning them again.
 */
export interface Routine {
  id: string; title: string; area: Area; projectId?: string; leverId?: string;
  /** ISO weekdays 1=Mon..7=Sun. */
  days: number[];
  estimateMin: number;
  /** First day it applies (YYYY-MM-DD); earlier days are history and stay as they were. */
  since: string;
}

export interface PlanItem {
  id: string; title: string; area: Area; projectId?: string; leverId?: string; stepId?: string;
  /** Set when the item came from a routine. */
  routineId?: string;
  isMainStep: boolean; estimateMin: number; done: boolean; doneAt?: string;
}
export interface Day {
  date: string; mode: Mode; plan: PlanItem[]; stopIssuedAt?: string; createdAt: string; updatedAt: string;
  /** Routines removed from this day on purpose, so they are not added back. */
  skippedRoutines?: string[];
}

export interface Profile {
  timezone: string;
  pomodoro: { workMin: number; breakMin: number; longBreakEvery: number; longBreakMin: number; standup: boolean };
  defaultMode: Mode;
  defaultWorkplace: Workplace;
}

export type Direction = 'up' | 'down';
/**
 * An `up` timer runs until she stops it and has no endsAt: pomodoro solves
 * starting boring work, and that is not her problem. `down` stays for a break
 * or a deliberate timebox.
 */
export interface Block {
  id: string; start: string; endsAt?: string; direction: Direction;
  kind: 'work' | 'break'; minutes: number; workplace: Workplace;
  ended: boolean; cancelled: boolean;
}

export type Classification = 'main_step' | 'goal_hard' | 'goal_comfortable' | 'other_project' | 'life';
export type Source = 'agent' | 'manual' | 'app';

export interface Session {
  id: string;
  start: string;
  end?: string;
  source: Source;
  clientSessionId?: string;
  weight: number;
  exclusive?: boolean;
  workplace: Workplace;
  area: Area;
  projectId?: string;
  leverId?: string;
  stepId?: string;
  itemId?: string;
  task: string;
  notes: string[];
  classification: Classification;
  unclassified?: boolean;
  verdictAtStart: string;
  override?: boolean;
  outcome?: 'done' | 'partial' | 'abandoned';
  summary?: string;
  attentionShareOverride?: number;
  /** Closed by the server because the timer was forgotten, not by the user. */
  autoClosed?: boolean;
}

export type Verdict = 'ok' | 'stop' | 'plan_first';

export interface Device {
  token: string;
  platform: 'ios' | 'android' | 'macos' | 'web';
  lastSeen: string;
  foregroundAt?: string;
  label?: string;
}

/** A reminder the server owes a user at a point in time. Polled by /tick. */
export interface Pending {
  id: string;
  uid: string;
  blockId: string;
  dueAt: string;
  kind: 'block_end' | 'break_end' | 'standup';
  workplace: Workplace;
  minutes: number;
  breakMin: number;
  /** Minutes the timer had been running when this reminder was queued. */
  elapsedMin?: number;
  /** The last reminder this timer will send: it looks forgotten. */
  final?: boolean;
}
