export const AREAS = ['health', 'relations', 'work', 'money', 'happiness'] as const;
export type Area = (typeof AREAS)[number];

export type LeverKind = 'hard' | 'comfortable';
export interface MatchHints { repos: string[]; keywords: string[] }
/**
 * The user's WIP (wip.co) project hashtag, without '#', on a project or on a lever whose
 * work belongs to one product (docs/public-posting.md): WIP todos about that work carry
 * it. wipHashtagBy says who set it: the user or their agent ('user'), or AimYear's
 * matching at connect time ('auto'), which never replaces one set by the user.
 */
export interface WipTag { wipHashtag?: string; wipHashtagBy?: 'user' | 'auto' }
export interface Lever extends WipTag { id: string; name: string; kind: LeverKind; examples: string[]; match: MatchHints }
export interface Project extends WipTag { id: string; name: string; area: Area; match: MatchHints }

/**
 * count: a number moves from baseline to target ("15 paying customers").
 * done: a one-time result that is either done or not ("launch v2 in the stores");
 * its progress is the share of stages done. A goal without kind is count.
 */
export type GoalKind = 'count' | 'done';

export interface Goal {
  title: string;
  kind?: GoalKind;
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
/**
 * count: progress is a recorded value against target ("speak with 20 people").
 * steps: progress is steps done of steps total ("implement the onboarding flow").
 * A milestone without kind is steps, which is how every milestone worked before 0.5.
 */
export type MilestoneKind = 'count' | 'steps';
export interface Milestone {
  id: string; title: string; kind?: MilestoneKind; metric: string; target: number; due: string; status: MilestoneStatus; createdAt: string; doneAt?: string;
  /** count milestones: recorded values, one per date, oldest first. */
  progress?: { value: number; date: string }[];
  /** The track this stage belongs to (docs/path-tracks.md); none on a path without tracks. */
  trackId?: string;
}
/** One way to reach the aim. Every track leads to the same aim; reach says how this one alone would get there. */
export interface Track { id: string; title: string; reach: string }
export interface Step { id: string; milestoneId: string; title: string; leverId?: string; estimateMin: number; order: number; status: ItemStatus; doneAt?: string }
export interface Path { milestones: Milestone[]; steps: Step[]; tracks?: Track[] }

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
  /**
   * Weekly count, e.g. 5 for "talk to 5 people a week". Each tick adds its count
   * (default 1); once the week reaches it, the routine leaves the plan until Monday.
   */
  perWeek?: number;
  /**
   * The small version for a bad day, e.g. "read one thread" for "talk to one person".
   * Doing it ticks the day as minimum: it counts, but not as the full routine.
   */
  minimum?: string;
  /** First day it applies (YYYY-MM-DD); earlier days are history and stay as they were. */
  since: string;
}

export interface PlanItem {
  id: string; title: string; area: Area; projectId?: string; leverId?: string; stepId?: string;
  /** Set when the item came from a routine. */
  routineId?: string;
  isMainStep: boolean; estimateMin: number; done: boolean; doneAt?: string;
  /** How many units this tick did, for a routine with perWeek (e.g. 2 people today). Default 1. */
  count?: number;
  /** Set when only the routine's minimum version was done. Absent on a full tick. */
  level?: 'minimum';
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
  /**
   * Which connected networks get the day's progress post, chosen in the app. Unset means
   * every connected network. A network that is not connected is ignored.
   */
  postTo?: Network[];
  /**
   * How much time this person records and hears about (docs/moves.md). time: sessions with
   * minutes, plus moves. moves: no timer, no minutes stored. quiet: the record is kept, but
   * what AimYear says uses words and days, never minutes or percentages. Unset is time.
   */
  tracking?: Tracking;
  /** Days a week this person wants to move toward the aim, 1 to 7. Unset is 4. */
  weeklyTarget?: number;
  /**
   * The weekly review email on Sunday at 19:00 local (docs/weekly-review.md, Pro). Unset
   * is on; the one-click unsubscribe link sets it to false.
   */
  weeklyReviewEmail?: boolean;
}

export const TRACKINGS = ['time', 'moves', 'quiet'] as const;
export type Tracking = (typeof TRACKINGS)[number];

/**
 * One action toward the aim with no duration ("fixed the signup button text"), at
 * users/{uid}/moves/{id}. Classified like a session; `date` is the local day it counts for.
 */
export interface Move {
  id: string;
  date: string;
  /** When it was recorded, or the time the user gave for a past move. */
  at: string;
  /** What changed, in the user's words. */
  task: string;
  area: Area;
  projectId?: string;
  leverId?: string;
  stepId?: string;
  itemId?: string;
  classification: Classification;
  unclassified?: boolean;
  source: Source;
  agent?: string;
  createdAt: string;
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
  /**
   * Who started or logged it: "app" for the AimYear app, else the agent's name (the OAuth
   * client name, e.g. "Claude Code", "ChatGPT", or one read from the user agent). Absent
   * on sessions recorded before 0.9.
   */
  agent?: string;
  /**
   * Every stop that reached the server for this session, in arrival order. Two devices
   * can stop the same session (a phone offline at 14:05, a Mac at 14:20): the earliest
   * end wins, done wins over any other outcome, the first summary stays.
   */
  stops?: Stop[];
}

/** One stop request as it arrived: what the device said and when the server heard it. */
export interface Stop {
  /** The client's operation id, when the request carried one. */
  opId?: string;
  clientSessionId?: string;
  workplace?: Workplace;
  /** When the device says the work ended (ISO), or the server's receive time without end_at. */
  endAt: string;
  summary: string;
  outcome: 'done' | 'partial' | 'abandoned';
  receivedAt: string;
}

/**
 * A device-originated write that was applied, keyed by the client's op_id under
 * users/{uid}/ops. A retry with the same op_id gets `result` back and writes nothing.
 * Written in the same transaction as the change it records.
 */
export interface AppliedOp {
  tool: string;
  sessionId?: string;
  result: unknown;
  at: string;
  /** A Firestore TTL policy on this field (console: ops, expiresAt) removes old ops. */
  expiresAt: Date;
}

export type Verdict = 'ok' | 'stop' | 'plan_first';

export interface Device {
  token: string;
  platform: 'ios' | 'android' | 'macos' | 'windows' | 'web';
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
  /**
   * post_offer: the evening draft of the day's progress post, with a Post action (Pro).
   * weekly_review: the weekly review email, Sunday 19:00 local (Pro). blockId is '' for both.
   */
  kind: 'block_end' | 'break_end' | 'standup' | 'post_offer' | 'weekly_review';
  workplace: Workplace;
  minutes: number;
  breakMin: number;
  /** Minutes the timer had been running when this reminder was queued. */
  elapsedMin?: number;
  /** The last reminder this timer will send: it looks forgotten. */
  final?: boolean;
  /** post_offer: the local day the post is about. weekly_review: the Monday of the week it reviews. */
  date?: string;
}

/**
 * One week's review email, at users/{uid}/weekly_reviews/{monday}. Claimed in a
 * transaction before the email goes out, so a retried tick never sends a week twice.
 */
export interface WeeklyReviewRecord {
  /** The Monday of the week, YYYY-MM-DD in the person's timezone. */
  week: string;
  /**
   * sending: claimed, the email is on its way (or the server died mid-way: it is never
   * sent again, a missed review is better than a double one). failed: SES refused it,
   * a later tick on the same Sunday may try again.
   */
  status: 'sending' | 'sent' | 'failed';
  attemptAt: string;
  sentAt?: string;
  messageId?: string;
  error?: string;
}

/**
 * A reminder ready for a desktop app to show, at desktop_reminders/{id}. /tick (or the
 * pull itself) turns a due desktop Pending into one; POST /desktop/reminders takes it.
 */
export interface DesktopReminder {
  id: string;
  uid: string;
  kind: Pending['kind'];
  title: string;
  body: string;
  blockId: string;
  dueAt: string;
  createdAt: string;
  /** The stand-up offers Break (stop the timer for a break) and Snooze (ask again later). */
  actions: ('break' | 'snooze')[];
}

// ---------- posting progress in public (docs/public-posting.md) ----------

export const NETWORKS = ['wip', 'bluesky'] as const;
export type Network = (typeof NETWORKS)[number];

/** AES-256-GCM output, base64. The plaintext is the network's credentials as JSON. */
export interface SealedSecret { v: 1; iv: string; tag: string; data: string }

/**
 * One connected network, at users/{uid}/social/{network}. `secret` is the only place
 * the credentials live, sealed; nothing else in the doc is secret.
 */
export interface SocialAccount {
  network: Network;
  /** The public account name: WIP username, Bluesky handle. */
  handle: string;
  connectedAt: string;
  secret: SealedSecret;
}

/**
 * The post AimYear made (or is making) for one day on one network, at
 * users/{uid}/posts/{date}_{network}. Its id tells AimYear's own posts apart from the
 * ones the user wrote on the site, and its status makes a retry post nothing twice.
 */
export interface PostRecord {
  id: string;
  date: string;
  network: Network;
  /** posting: claimed, the network call is under way (or crashed mid-way). */
  status: 'posting' | 'posted' | 'failed';
  text: string;
  attemptAt: string;
  /** The network's id: WIP todo id, Bluesky at:// uri. */
  postId?: string;
  url?: string;
  postedAt?: string;
  error?: string;
}
