import type { Area, Classification, Day, Goal, Lever, Project, Verdict } from '../types.js';

export interface ClassInput { area: Area; projectId?: string; leverId?: string; stepId?: string; itemId?: string; task: string }
export interface ClassResult { classification: Classification; leverId?: string; projectId?: string; unclassified: boolean; matchedBy: string }

const norm = (s: string) => s.toLowerCase();
function matches(text: string, hints: { repos: string[]; keywords: string[] }, name: string): boolean {
  const t = norm(text);
  if (t.includes(norm(name))) return true;
  return [...(hints?.keywords ?? []), ...(hints?.repos ?? [])].some(k => k && t.includes(norm(k)));
}

/** Decide what a session is, from explicit ids first, then from match hints on the task text. */
export function classify(input: ClassInput, goal: Goal | null, day: Day | null): ClassResult {
  const mainItem = day?.plan.find(p => p.isMainStep);
  if (input.itemId && mainItem && mainItem.id === input.itemId) return { classification: 'main_step', leverId: mainItem.leverId, unclassified: false, matchedBy: 'plan item' };
  if (input.stepId && mainItem?.stepId && mainItem.stepId === input.stepId) return { classification: 'main_step', leverId: mainItem.leverId, unclassified: false, matchedBy: 'main step id' };

  if (input.leverId && goal) {
    const lever = goal.levers.find(l => l.id === input.leverId);
    if (lever) return { classification: lever.kind === 'hard' ? 'goal_hard' : 'goal_comfortable', leverId: lever.id, unclassified: false, matchedBy: 'lever id' };
  }
  if (input.stepId) return { classification: 'goal_comfortable', unclassified: false, matchedBy: 'step id (no lever)' };
  if (input.projectId && input.projectId !== 'goal') return { classification: input.area === 'work' ? 'other_project' : 'life', projectId: input.projectId, unclassified: false, matchedBy: 'project id' };

  if (goal) {
    const lever: Lever | undefined = goal.levers.find(l => matches(input.task, l.match, l.name));
    if (lever) return { classification: lever.kind === 'hard' ? 'goal_hard' : 'goal_comfortable', leverId: lever.id, unclassified: false, matchedBy: `lever keyword "${lever.name}"` };
    const project: Project | undefined = goal.projects.find(p => matches(input.task, p.match, p.name));
    if (project) return { classification: project.area === 'work' ? 'other_project' : 'life', projectId: project.id, unclassified: false, matchedBy: `project keyword "${project.name}"` };
  }
  if (input.area !== 'work') return { classification: 'life', unclassified: false, matchedBy: 'area' };
  return { classification: 'other_project', unclassified: true, matchedBy: 'nothing matched; treated as other work' };
}

export const isGoalWork = (c: Classification) => c === 'main_step' || c === 'goal_hard' || c === 'goal_comfortable';

export interface VerdictResult { verdict: Verdict; message: string; note?: string }

/**
 * The stop rule. One `stop` per day; a confirmed override is stored on the session.
 * `override` = the user confirmed after a stop.
 */
export function decideVerdict(cls: Classification, day: Day | null, goal: Goal | null, override: boolean): VerdictResult {
  if (day?.mode === 'off') return { verdict: 'ok', message: 'Tracking is off today. Timer only.' };
  if (!goal) return { verdict: 'ok', message: 'No goal set yet. Logged as plain time; run the goal setup when ready.' };

  const mainItem = day?.plan.find(p => p.isMainStep);
  const mainDone = !!mainItem?.done;

  if (!day || day.plan.length === 0) {
    if (cls === 'goal_hard' || cls === 'life') return { verdict: 'ok', message: 'No plan for today yet, but this counts anyway.' };
    return { verdict: 'plan_first', message: 'There is no plan for today. Before anything else: what is the one step toward the goal today? Set it with set_plan (or say "no plan today" to set mode off).' };
  }
  if (cls === 'main_step') return { verdict: 'ok', message: "This is today's main step. Go." };
  if (cls === 'goal_hard') return { verdict: 'ok', message: 'Hard lever on the goal. Counts fully.' };
  if (cls === 'goal_comfortable') {
    if (mainDone) return { verdict: 'ok', message: 'Main step is done today, so this is fine.', note: 'counted as comfortable goal work' };
    if (override) return { verdict: 'ok', message: 'Override recorded. Starting comfortable goal work while the main step is pending.', note: 'override' };
    if (day.stopIssuedAt) return { verdict: 'ok', message: `Main step still pending: "${mainItem?.title ?? 'not set'}". Not stopping you twice today, but it goes in the week summary.`, note: 'main step pending' };
    return {
      verdict: 'stop',
      message: `Stop. This is comfortable work on the goal project and today's main step is not done yet: "${mainItem?.title ?? 'not set'}". Do 25 minutes on the main step first? If you really want to continue with this task, call start_focus again with override=true.`,
    };
  }
  return { verdict: 'ok', message: cls === 'life' ? 'Life area. Counts toward balance.' : 'Other work. Counts toward balance.' };
}
