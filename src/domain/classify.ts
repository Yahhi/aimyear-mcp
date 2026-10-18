import type { Area, Classification, Day, Goal, Lever, Project, Verdict } from '../types.js';

export interface ClassInput { area: Area; projectId?: string; leverId?: string; stepId?: string; itemId?: string; task: string }
export interface ClassResult { classification: Classification; leverId?: string; projectId?: string; unclassified: boolean; matchedBy: string }

const norm = (s: string) => s.toLowerCase();
function matches(text: string, hints: { repos: string[]; keywords: string[] }, name: string): boolean {
  const t = norm(text);
  if (t.includes(norm(name))) return true;
  return [...(hints?.keywords ?? []), ...(hints?.repos ?? [])].some(k => k && t.includes(norm(k)));
}

/** The lever a piece of work belongs to: its own lever id, its step's lever id, then the levers' match hints on the title. */
export function leverFor(work: { title: string; leverId?: string; stepId?: string }, goal: Goal | null, steps: { id: string; leverId?: string }[] = []): Lever | undefined {
  if (!goal) return undefined;
  const id = work.leverId ?? (work.stepId ? steps.find(s => s.id === work.stepId)?.leverId : undefined);
  return (id ? goal.levers.find(l => l.id === id) : undefined) ?? goal.levers.find(l => matches(work.title, l.match, l.name));
}

/** Decide what a session is, from explicit ids first, then from match hints on the task text. */
export function classify(input: ClassInput, goal: Goal | null, day: Day | null): ClassResult {
  const mainItem = day?.plan.find(p => p.isMainStep);
  // Accept the main item's plan id or step id in either field: get_current (now get_now) used to
  // return the plan item id as main_step.id, and agents passed it as stepId.
  if (mainItem) {
    const ids = [mainItem.id, mainItem.stepId].filter(Boolean);
    if (input.itemId && ids.includes(input.itemId)) return { classification: 'main_step', leverId: mainItem.leverId, unclassified: false, matchedBy: 'plan item' };
    if (input.stepId && ids.includes(input.stepId)) return { classification: 'main_step', leverId: mainItem.leverId, unclassified: false, matchedBy: 'main step id' };
  }

  if (input.leverId && goal) {
    const lever = goal.levers.find(l => l.id === input.leverId);
    if (lever) return { classification: lever.kind === 'hard' ? 'goal_hard' : 'goal_comfortable', leverId: lever.id, unclassified: false, matchedBy: 'lever id' };
  }

  // A project says WHICH product; a lever says WHAT KIND of work. They are
  // orthogonal, so naming the project must not stop the lever from matching —
  // doing that silently filed hard work (writing, posting) as comfortable.
  const leverByText: Lever | undefined = goal?.levers.find(l => matches(input.task, l.match, l.name));
  if (leverByText) {
    return {
      classification: leverByText.kind === 'hard' ? 'goal_hard' : 'goal_comfortable',
      leverId: leverByText.id, projectId: input.projectId,
      unclassified: false, matchedBy: `lever keyword "${leverByText.name}"`,
    };
  }

  if (input.stepId) return { classification: 'goal_comfortable', unclassified: false, matchedBy: 'step id (no lever)' };
  if (input.projectId && input.projectId !== 'goal') {
    const proj = goal?.projects.find(p => p.id === input.projectId);
    return { classification: fromProject(proj?.area ?? input.area), projectId: input.projectId, unclassified: false, matchedBy: `project id${proj ? ` (${proj.area})` : ''}` };
  }

  if (goal) {
    const project: Project | undefined = goal.projects.find(p => matches(input.task, p.match, p.name));
    if (project) return { classification: fromProject(project.area), projectId: project.id, unclassified: false, matchedBy: `project keyword "${project.name}" (${project.area})` };
  }
  if (input.area !== 'work') return { classification: 'life', unclassified: false, matchedBy: 'area' };
  return { classification: 'other_project', unclassified: true, matchedBy: 'nothing matched; treated as other work' };
}

/** A project in the money area is one of her own products, so work on it is goal work. */
const fromProject = (area: Area | undefined): Classification =>
  area === 'money' ? 'goal_comfortable' : area === 'work' ? 'other_project' : 'life';

export const isGoalWork = (c: Classification) => c === 'main_step' || c === 'goal_hard' || c === 'goal_comfortable';

export interface VerdictResult { verdict: Verdict; message: string; note?: string }

/**
 * The stop rule. One `stop` per day; a confirmed override is stored on the session.
 * `override` = the user confirmed after a stop.
 */
export function decideVerdict(cls: Classification, day: Day | null, goal: Goal | null, override: boolean, requiresMainStep = true): VerdictResult {
  if (day?.mode === 'off') return { verdict: 'ok', message: 'Tracking is off today. Timer only.' };
  if (!goal) return { verdict: 'ok', message: 'No goal set yet. Logged as plain time; run the goal setup when ready.' };

  const mainItem = day?.plan.find(p => p.isMainStep);
  const mainDone = !!mainItem?.done;

  if (!requiresMainStep) return { verdict: 'ok', message: 'No focus window today, so nothing is expected. Logged.' };
  if (!day || day.plan.length === 0) {
    if (cls === 'goal_hard' || cls === 'life') return { verdict: 'ok', message: 'No plan for today yet, but this counts anyway.' };
    return { verdict: 'plan_first', message: 'There is no plan for today. Before anything else: what is the one step toward the goal today? Set it with set_plan (or say "no plan today" and call set_day_mode with off).' };
  }
  if (cls === 'main_step') return { verdict: 'ok', message: "This is today's main step. Go." };
  if (cls === 'goal_hard') return { verdict: 'ok', message: 'Hard lever on the goal. Counts fully.' };
  if (cls === 'goal_comfortable') {
    if (mainDone) return { verdict: 'ok', message: 'Main step is done today, so this is fine.', note: 'counted as comfortable goal work' };
    if (override) return { verdict: 'ok', message: 'Override recorded. Starting comfortable goal work while the main step is pending.', note: 'override' };
    if (day.stopIssuedAt) return { verdict: 'ok', message: `Main step still pending: "${mainItem?.title ?? 'not set'}". Not stopping you twice today, but it goes in the week summary.`, note: 'main step pending' };
    return {
      verdict: 'stop',
      message: `Stop. This is comfortable work on the goal project and today's main step is not done yet: "${mainItem?.title ?? 'not set'}". Do 25 minutes on the main step first? If you really want to continue with this task, call start_session again with override=true.`,
    };
  }
  return { verdict: 'ok', message: cls === 'life' ? 'Life area. Counts toward balance.' : 'Other work. Counts toward balance.' };
}
