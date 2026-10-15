import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AimService, AimError } from './service.js';
import { AREAS } from './types.js';
import { levelOfTool } from './access.js';

const area = z.enum(AREAS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD in the user\'s timezone');
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM local time');

type Handler = (args: any) => Promise<unknown>;

/** What each tool does to the person's data. Clients show these before they approve a call. */
type Kind = 'read' | 'write' | 'idempotent' | 'destructive';
const READ = ['get_goal', 'check_goal_draft', 'get_path', 'next_steps', 'get_commitments', 'get_capacity', 'get_planning_context', 'get_plan',
  'get_now', 'list_sessions', 'find_gaps', 'summarize_day', 'summarize_week', 'find_leaks', 'get_settings', 'list_devices'];
// Replaces a whole list or removes something: an earlier value is gone after the call.
const DESTRUCTIVE = ['set_goal', 'set_levers', 'set_projects', 'set_milestones', 'set_commitments', 'set_plan',
  'delete_step', 'delete_plan_item', 'delete_session', 'delete_device', 'stop_timer'];
// Calling twice with the same arguments leaves the same result.
const IDEMPOTENT = ['record_progress', 'edit_milestone', 'edit_step', 'edit_plan_item', 'set_day_mode', 'split_attention', 'edit_session', 'set_settings', 'add_device'];
export function kindOf(name: string): Kind {
  if (READ.includes(name)) return 'read';
  if (DESTRUCTIVE.includes(name)) return 'destructive';
  if (IDEMPOTENT.includes(name)) return 'idempotent';
  return 'write';
}
const title = (name: string) => name.split('_').map((w, i) => i === 0 ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
function annotationsFor(name: string) {
  const k = kindOf(name);
  return {
    title: title(name),
    readOnlyHint: k === 'read',
    destructiveHint: k === 'destructive',
    idempotentHint: k === 'read' || k === 'idempotent' || (k === 'destructive' && name.startsWith('set_')),
    openWorldHint: false,
  };
}

export const INSTRUCTIONS = `AimYear keeps one person's big aim for the year, the path of stages toward it, today's plan, a timer and an honest record of where the time went. Every tool acts as the signed-in person.

Names: get_ reads one thing, list_ reads several, find_ looks for problems, set_ replaces a whole list, add_ / edit_ / delete_ change one entry. A session is one piece of work; the timer runs while sessions run.

Typical flow: get_goal (or check_goal_draft → set_goal), get_path, get_planning_context → set_plan with one main step, start_session before work (honor its verdict: ok, plan_first or stop), stop_session with a real summary, summarize_day / summarize_week / find_leaks for reviews. To fix a record, use edit_session or delete_session. Every result has a "speak" field: say it to the user in your own words. Start or stop the timer only when the user asks; adding past time with add_session is always fine.`;

function wrap(name: string, fn: Handler, signedIn: boolean) {
  return async (args: any) => {
    // Second check behind the HTTP gate: no tool runs without a person to act as.
    if (!signedIn && levelOfTool(name) !== 'public') {
      const msg = 'Sign in to AimYear first: this tool acts on your own aim and history.';
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, speak: msg }) }], isError: true };
    }
    try {
      const result = await fn(args ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (e) {
      const msg = e instanceof AimError ? e.message : `${(e as Error).message ?? e}`;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, speak: msg }) }], isError: true };
    }
  };
}

/** svc is null for an anonymous caller: the tools are listed, and every call is refused. */
export function registerTools(server: McpServer, maybeSvc: AimService | null) {
  const svc = maybeSvc as AimService;
  const t = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, fn: Handler) =>
    server.registerTool(name, { title: title(name), description, inputSchema: shape, annotations: annotationsFor(name) }, wrap(name, fn, maybeSvc !== null));

  const outcome = z.enum(['done', 'partial', 'abandoned']);
  const sessionLinks = {
    area: area.optional().describe('default work'), projectId: z.string().optional(), leverId: z.string().optional(),
    stepId: z.string().optional().describe('path step id'), itemId: z.string().optional().describe('plan item id'),
    weight: z.number().min(0).optional().describe('attention weight vs other sessions at the same time, default 1'), exclusive: z.boolean().optional().describe('true: nothing else was happening then'),
  };

  // ---- aim ----
  t('get_goal', 'The one yearly goal: metric, starting value, current value, target, deadline, levers (hard/comfortable) and other projects. Call first in most flows.', {}, () => svc.getGoal());
  t('check_goal_draft', 'Check a goal that is not saved yet against the rubric (countable metric, value today, target, deadline within 12 months, pace per week). Changes nothing. Returns problems[] and next_question: loop until problems is empty, then call set_goal.', {
    title: z.string().optional(), metric: z.string().optional().describe('the one number and its unit, e.g. "paying customers"'), baseline: z.number().optional().describe('value today'), target: z.number().optional(), deadline: date.optional(),
  }, a => svc.checkGoalDraft(a));
  t('set_goal', 'Save the yearly goal, or replace it with the next one. Rejects with problems[] if the rubric fails. Keeps levers and projects. area is which of the five life areas the goal belongs to.', {
    title: z.string(), why: z.string().optional(), metric: z.string(), baseline: z.number().describe('value today'), target: z.number(), deadline: date, area: area.optional().describe('default money'),
  }, a => svc.setGoal(a));
  t('record_progress', 'Record the current value of the goal metric, e.g. "I now have 4 customers". One value per date: calling again for the same date corrects it. Says when the target is reached.', { value: z.number(), date: date.optional() }, a => svc.recordProgress(a.value, a.date));
  t('set_levers', 'Replace the list of levers: the recurring kinds of goal work. At least one must be kind=hard (the work the user avoids). keywords/repos are hints for classifying sessions from their task text. Pass existing ids to keep them.', {
    levers: z.array(z.object({ id: z.string().optional(), name: z.string(), kind: z.enum(['hard', 'comfortable']), examples: z.array(z.string()).optional(), keywords: z.array(z.string()).optional(), repos: z.array(z.string()).optional() })),
  }, a => svc.setLevers(a.levers));
  t('set_projects', 'Replace the list of other projects (paid work, other products, life routines), so their sessions count as other work or life, not goal work. Pass the whole list: leave one out to remove it, change its name or hints to edit it. Pass existing ids to keep them.', {
    projects: z.array(z.object({ id: z.string().optional(), name: z.string(), area, keywords: z.array(z.string()).optional(), repos: z.array(z.string()).optional() })),
  }, a => svc.setProjects(a.projects));

  // ---- path ----
  t('get_path', 'Milestones with pace (ahead/on_pace/behind) and their steps. current_milestone_id is the one to work on.', {}, () => svc.getPath());
  t('set_milestones', 'Replace the list of 2–6 ordered milestones under the goal, each with a metric, target and due date before the goal deadline. Pass each existing id, or that milestone\'s steps are deleted. To change one milestone, use edit_milestone.', {
    milestones: z.array(z.object({ id: z.string().optional(), title: z.string(), metric: z.string(), target: z.number(), due: date })),
  }, a => svc.setMilestones(a.milestones));
  t('edit_milestone', 'Change one milestone: title, metric, target, due date or status. status=retired drops it without finishing; done or retired moves the path to the next milestone. Its steps are kept.', {
    milestoneId: z.string(), title: z.string().optional(), metric: z.string().optional(), target: z.number().optional(), due: date.optional(), status: z.enum(['todo', 'doing', 'done', 'retired']).optional(),
  }, a => svc.editMilestone(a.milestoneId, a));
  t('add_steps', 'Add concrete steps to a milestone. A step is an action that fits a few work blocks ("email 10 people from the waitlist"), not "do marketing". Abstract steps are rejected.', {
    milestoneId: z.string(), steps: z.array(z.object({ title: z.string(), leverId: z.string().optional(), estimateMin: z.number().int().optional() })),
  }, a => svc.addSteps(a.milestoneId, a.steps));
  t('edit_step', 'Change one step: title, status (todo/doing/done), order, lever, estimate.', { stepId: z.string(), title: z.string().optional(), status: z.enum(['todo', 'doing', 'done']).optional(), order: z.number().int().optional(), leverId: z.string().optional(), estimateMin: z.number().int().optional() }, a => svc.editStep(a.stepId, a));
  t('delete_step', 'Delete one step from the path.', { stepId: z.string() }, a => svc.deleteStep(a.stepId));
  t('next_steps', 'Open steps of the current milestone, hard-lever steps first: the candidates for today\'s main step.', { count: z.number().int().min(1).max(20).optional() }, a => svc.nextSteps(a.count));

  // ---- week ----
  t('get_commitments', 'Recurring weekly time: commitments (school runs, training, classes), overhead (sleep, meals) and focus windows.', {}, () => svc.getCommitments());
  t('set_commitments', 'Replace the list of recurring weekly commitments. days are ISO weekdays 1=Mon..7=Sun; use timesPerWeek instead when there are no fixed days. Pass existing ids to keep them.', {
    commitments: z.array(z.object({ id: z.string().optional(), title: z.string(), kind: z.enum(['commitment', 'overhead', 'window']).optional().describe("commitment = unavailable and belongs to an area; overhead = unavailable and belongs to no area (sleep, meals, hygiene, moving between places); window = time available for focus work. Default commitment."), area: area.optional().describe('required for kind commitment'), days: z.array(z.number().int().min(1).max(7)).optional(), timesPerWeek: z.number().int().min(1).max(7).optional(), start: hhmm.optional(), minutes: z.number().int().min(1), usableForWork: z.boolean().optional().describe('committed but still workable (waiting, being a passenger)'), assumed: z.boolean().optional().describe('true when the number is your inference, not something the user stated'), insideWindowId: z.string().optional().describe('id of a kind:window entry this commitment is carved out of, so the window is not counted twice'), projectId: z.string().optional(), note: z.string().optional() })),
  }, a => svc.setCommitments(a.commitments));
  t('get_capacity', 'Weekly time budget out of 168 hours: overhead, hours committed per area, focus windows, and what is still unaccounted for. Nothing is assumed.', {}, () => svc.capacity());

  // ---- day ----
  t('get_planning_context', 'Everything needed to plan a day: goal and pace, next_steps, yesterday\'s summary and undone items, week balance, days since a hard lever. Defaults to tomorrow. The agent plans; then call set_plan.', { date: date.optional() }, a => svc.getPlanningContext(a.date));
  t('get_plan', 'The plan for a day (default today).', { date: date.optional() }, a => svc.getPlan(a.date));
  t('set_plan', 'Replace the plan for a day. Exactly one item must have isMainStep=true (the step toward the goal), ideally linked by stepId from next_steps. Other items: paid work, family, workout, etc. with their area. Items that stay keep their done state.', {
    date: date.optional(), items: z.array(z.object({ title: z.string(), area, projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), isMainStep: z.boolean().optional(), estimateMin: z.number().int().optional() })),
  }, a => svc.setPlan(a.date, a.items));
  t('edit_plan_item', 'Change one plan item: mark it done or not done, rename it, change its estimate, area or links, or make it the main step. done=true also completes its linked path step.', {
    itemId: z.string(), date: date.optional(), done: z.boolean().optional(), title: z.string().optional(), area: area.optional(), projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), isMainStep: z.boolean().optional(), estimateMin: z.number().int().optional(),
  }, a => svc.editPlanItem(a.itemId, a.date, a));
  t('delete_plan_item', 'Remove one item from a day\'s plan.', { itemId: z.string(), date: date.optional() }, a => svc.deletePlanItem(a.itemId, a.date));
  t('set_day_mode', 'Tracking for a day: full (everything recorded, the default) or off (timer and reminders only, nothing stored, no plan required).', { date: date.optional(), mode: z.enum(['full', 'off']) }, a => svc.setDayMode(a.date, a.mode));

  // ---- timer & sessions ----
  t('get_now', 'What is happening now: running sessions with attention shares, the timer, today\'s main step, today\'s minutes, the streak and a one-line nudge.', {}, () => svc.getNow());
  t('start_session', 'Start a session of work and, if none is running, the timer. Returns a verdict: ok | stop | plan_first. On "stop" NO session is created: relay the message, ask the user; if they insist, call again with override=true. Several sessions may run at once (two terminals) and share attention by weight.', {
    task: z.string().describe('what you are about to do, specific'), ...sessionLinks,
    direction: z.enum(['up', 'down']).optional().describe('up (default) counts elapsed time and runs until stopped, with a stand-up reminder every workMin; down is a fixed timebox, for a break'), minutes: z.number().int().min(5).max(120).optional().describe('length for a down timer, or the stand-up interval for an up timer'), workplace: z.enum(['desktop', 'mobile']).optional(), override: z.boolean().optional().describe('true only after the user confirmed past a stop'),
  }, a => svc.startSession(a));
  t('add_note', 'Add a one-line note to a running session (this connection\'s, or session_id). May classify a session that was unclassified.', { note: z.string(), session_id: z.string().optional() }, a => svc.addNote(a.note, a.session_id));
  t('split_attention', 'Set attention weights of the running sessions at once, e.g. {"abc": 0.7, "def": 0.3}. Applies to the whole session. For a finished session use edit_session.', { shares: z.record(z.string(), z.number().min(0)) }, a => svc.splitAttention(a.shares));
  t('stop_session', 'Stop a running session (this connection\'s, or session_id) with a summary and outcome. The timer keeps running for other sessions. outcome=done completes the linked plan item or path step. Refuses a session that already ended: use edit_session for that.', {
    summary: z.string(), outcome, session_id: z.string().optional(), attention_share: z.number().min(0).max(1).optional().describe('corrects the share in hindsight'),
  }, a => svc.stopSession(a.summary, a.outcome, a.session_id, a.attention_share));
  t('stop_timer', 'Stop the timer ("pause", "stop", "stand up") and every running session with it. There is no paused state: resuming starts a new session. Pass summary and outcome to save them on the sessions it closes, or call stop_session first. Returns the break length.', {
    summary: z.string().optional(), outcome: outcome.optional().describe('default partial'),
  }, a => svc.stopTimer(a.summary, a.outcome));
  t('add_session', 'Add past time that was not timed: minutes (ending now, or at end), or start+end as HH:MM on date. For calls, children, workout, paid work, or work done away from the agent.', {
    task: z.string(), minutes: z.number().int().min(1).optional(), start: hhmm.optional(), end: hhmm.optional(), date: date.optional(), ...sessionLinks,
  }, a => svc.addSession(a));
  t('edit_session', 'Fix a session, running or finished: start and end (HH:MM on date; an end before the start means it ran past midnight), task, area, project, lever, step, plan item, summary, outcome, attention share, weight. It is classified again after a change. Use it when a timer was forgotten or a session was labelled wrong.', {
    session_id: z.string(), date: date.optional().describe('local date of start and end; default the session\'s own date'), start: hhmm.optional(), end: hhmm.optional(), task: z.string().optional(), ...sessionLinks,
    summary: z.string().optional(), outcome: outcome.optional(), attention_share: z.number().min(0).max(1).optional().describe('share of the session\'s wall time that was real attention'),
  }, a => svc.editSession(a.session_id, { ...a, attentionShare: a.attention_share }));
  t('delete_session', 'Delete a session, running or finished, so it no longer counts. Without session_id it deletes this connection\'s running session.', { session_id: z.string().optional() }, a => svc.deleteSession(a.session_id));
  t('list_sessions', 'Sessions in a date range (default the last 7 days), with ids, optionally filtered by area or project.', { from: date.optional(), to: date.optional(), area: area.optional(), projectId: z.string().optional() }, a => svc.history(a.from, a.to, a.area, a.projectId));
  t('find_gaps', 'Untimed stretches of 20+ minutes between the first and last session of a day. Ask the user what happened there.', { date: date.optional() }, a => svc.getGaps(a.date));

  // ---- reviews ----
  t('summarize_day', 'Full summary of a day: wall and attention minutes per area, classification and lever, sessions, gaps, overlaps, overrides.', { date: date.optional() }, a => svc.daySummary(a.date));
  t('summarize_week', 'A week, Monday to Sunday (to today for the current week): main-step days, goal share, hard share, area balance, overrides, streak, milestone pace.', { date: date.optional().describe('any day of the week, default today') }, a => svc.weekSummary(a.date));
  t('find_leaks', 'Where time leaks: comfortable goal work while the main step waited, overrides, unplanned work, gaps, switching, missed main steps, days without a plan. Default the last 7 days.', { from: date.optional(), to: date.optional() }, a => svc.leaks(a.from, a.to));

  // ---- settings & devices ----
  t('get_settings', 'Timezone, where reminders go (desktop or mobile), and timer settings.', {}, () => svc.getSettings());
  t('set_settings', 'Change any of: timezone (IANA name, e.g. Europe/Madrid; it sets where each day starts and ends), workplace for reminders, stand-up interval workMin, breakMin, longBreakEvery, longBreakMin, standup on/off.', {
    timezone: z.string().optional(), workplace: z.enum(['desktop', 'mobile']).optional(), workMin: z.number().int().min(5).max(120).optional(), breakMin: z.number().int().min(1).max(60).optional(), longBreakEvery: z.number().int().min(1).max(10).optional(), longBreakMin: z.number().int().min(5).max(60).optional(), standup: z.boolean().optional(),
  }, a => svc.setSettings(a));
  t('add_device', 'Register a device token so server reminders (stand up, break over) can reach it. The phone app registers itself; use this for testing or a manual token.', {
    token: z.string().min(20), platform: z.enum(['ios', 'android', 'macos', 'web']), label: z.string().optional(),
  }, a => svc.addDevice(a.token, a.platform, a.label));
  t('list_devices', 'Which devices can receive reminders, and when each was last seen.', {}, () => svc.listDevices());
  t('delete_device', 'Remove a device so it stops receiving reminders.', { token: z.string() }, a => svc.deleteDevice(a.token));

  // ---- prompts ----
  server.registerPrompt('plan-tomorrow', { description: 'Plan tomorrow: one main step toward the goal, then the rest of life.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Call get_planning_context for tomorrow. Propose a plan: exactly one main step chosen from next_steps (prefer a hard lever if it has been more than 2 days), then paid work, family, workout and other commitments as items with their area. Ask me to confirm or adjust, then call set_plan.' } }],
  }));
  server.registerPrompt('evening-review', { description: 'Review today and close the day.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Call summarize_day and find_gaps for today. Tell me in 5 lines: was the main step done, minutes on the goal vs elsewhere, hard share, what leaked, and one honest observation. Ask about any gap over 30 minutes and offer to log it. Then offer to plan tomorrow.' } }],
  }));
}
