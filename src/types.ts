export const AREAS = ['health', 'finance', 'relations', 'work', 'happiness'] as const;
export type Area = (typeof AREAS)[number];

export type LeverKind = 'hard' | 'comfortable';
export interface MatchHints { repos: string[]; keywords: string[] }
export interface Lever { id: string; name: string; kind: LeverKind; examples: string[]; match: MatchHints }
export interface Project { id: string; name: string; area: Area; match: MatchHints }

export interface Goal {
  title: string;
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
export interface Milestone { id: string; title: string; metric: string; target: number; due: string; status: ItemStatus; createdAt: string; doneAt?: string }
export interface Step { id: string; milestoneId: string; title: string; leverId?: string; estimateMin: number; order: number; status: ItemStatus; doneAt?: string }
export interface Path { milestones: Milestone[]; steps: Step[] }

export type Mode = 'full' | 'focus' | 'off';
export type Workplace = 'desktop' | 'mobile';

export interface PlanItem {
  id: string; title: string; area: Area; projectId?: string; leverId?: string; stepId?: string;
  isMainStep: boolean; estimateMin: number; done: boolean; doneAt?: string;
}
export interface Day { date: string; mode: Mode; plan: PlanItem[]; stopIssuedAt?: string; createdAt: string; updatedAt: string }

export interface Profile {
  timezone: string;
  pomodoro: { workMin: number; breakMin: number; longBreakEvery: number; longBreakMin: number; standup: boolean };
  defaultMode: Mode;
  defaultWorkplace: Workplace;
}

export interface Block { id: string; start: string; endsAt: string; kind: 'work' | 'break'; minutes: number; workplace: Workplace; ended: boolean; cancelled: boolean }

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
}

export type Verdict = 'ok' | 'stop' | 'plan_first';
