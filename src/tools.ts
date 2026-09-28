import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AimService, AimError } from './service.js';
import { AREAS } from './types.js';

const area = z.enum(AREAS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD in the user\'s timezone');
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM local time');

type Handler = (args: any) => Promise<unknown>;
function wrap(fn: Handler) {
  return async (args: any) => {
    try {
      const result = await fn(args ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (e) {
      const msg = e instanceof AimError ? e.message : `${(e as Error).message ?? e}`;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, speak: msg }) }], isError: true };
    }
  };
}

export function registerTools(server: McpServer, svc: AimService) {
  const t = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, fn: Handler) =>
    server.registerTool(name, { description, inputSchema: shape }, wrap(fn));

  // ---- goal ----
  t('get_goal', 'The one yearly goal with metric, baseline, current value, target, deadline, levers (hard/comfortable) and other projects. Call first in most flows.', {}, () => svc.getGoal());
  t('validate_goal', 'Check a goal draft against the rubric (countable metric, baseline, target, deadline within 12 months, pace per week). Returns problems[] and next_question. Loop until problems is empty, then call set_goal.', {
    title: z.string().optional(), metric: z.string().optional().describe('the one number and its unit, e.g. "paying customers"'), baseline: z.number().optional().describe('value today'), target: z.number().optional(), deadline: date.optional(),
  }, a => svc.validateGoal(a));
  t('set_goal', 'Save the yearly goal. Rejects with problems[] if the rubric fails. Keeps existing levers/projects. area tags which of the five life areas the goal belongs to.', {
    title: z.string(), why: z.string().optional(), metric: z.string(), baseline: z.number(), target: z.number(), deadline: date, area: area.optional().describe('default money'),
  }, a => svc.setGoal(a));
  t('update_baseline', 'Record the current value of the goal metric (real progress), e.g. "I now have 4 customers".', { value: z.number(), date: date.optional() }, a => svc.updateBaseline(a.value, a.date));
  t('set_levers', 'Set the recurring kinds of goal work. At least one must be kind=hard (the work the user avoids). keywords/repos are match hints used to classify sessions from task text.', {
    levers: z.array(z.object({ id: z.string().optional(), name: z.string(), kind: z.enum(['hard', 'comfortable']), examples: z.array(z.string()).optional(), keywords: z.array(z.string()).optional(), repos: z.array(z.string()).optional() })),
  }, a => svc.setLevers(a.levers));
  t('add_project', 'Register another project (paid work, another side project, a life routine) so its sessions are classified as other work / life, not goal work.', {
    name: z.string(), area, keywords: z.array(z.string()).optional(), repos: z.array(z.string()).optional(),
  }, a => svc.addProject(a.name, a.area, a.keywords ?? [], a.repos ?? []));
  t('set_pomodoro', 'Pomodoro settings.', { workMin: z.number().int().min(5).max(120).optional(), breakMin: z.number().int().min(1).max(60).optional(), longBreakEvery: z.number().int().min(1).max(10).optional(), longBreakMin: z.number().int().min(5).max(60).optional(), standup: z.boolean().optional() }, a => svc.setPomodoro(a));
  t('set_workplace', 'Default workplace for reminders: desktop or mobile.', { workplace: z.enum(['desktop', 'mobile']) }, a => svc.setWorkplace(a.workplace));

  // ---- devices ----
  t('register_device', 'Register a device token so server reminders (stand up, break over) can reach it. The phone app registers itself; use this for testing or a manual token.', {
    token: z.string().min(20), platform: z.enum(['ios', 'android', 'macos', 'web']), label: z.string().optional(),
  }, a => svc.registerDevice(a.token, a.platform, a.label));
  t('list_devices', 'Which devices can receive reminders, and when each was last seen.', {}, () => svc.listDevices());
  t('forget_device', 'Remove a device so it stops receiving reminders.', { token: z.string() }, a => svc.forgetDevice(a.token));

  // ---- commitments ----
  t('get_commitments', 'Recurring weekly commitments: the time already spoken for (school runs, training, classes, waiting).', {}, () => svc.getCommitments());
  t('set_commitments', 'Replace the list of recurring weekly commitments. days are ISO weekdays 1=Mon..7=Sun; use timesPerWeek instead when there are no fixed days. usableForWork=true marks time that is committed but still workable (waiting, being a passenger).', {
    commitments: z.array(z.object({ id: z.string().optional(), title: z.string(), kind: z.enum(['commitment', 'overhead', 'window']).optional().describe("commitment = unavailable and belongs to an area; overhead = unavailable and belongs to no area (sleep, meals, hygiene, moving between places); window = time available for focus work. Default commitment."), area: area.optional().describe('required for kind commitment'), days: z.array(z.number().int().min(1).max(7)).optional(), timesPerWeek: z.number().int().min(1).max(7).optional(), start: hhmm.optional(), minutes: z.number().int().min(1), usableForWork: z.boolean().optional(), assumed: z.boolean().optional().describe('true when the number is your inference, not something the user stated'), insideWindowId: z.string().optional().describe('id of a kind:window entry this commitment is carved out of, so the window is not counted twice'), projectId: z.string().optional(), note: z.string().optional() })),
  }, a => svc.setCommitments(a.commitments));
  t('capacity', 'Weekly time budget out of 168 hours: overhead (sleep, meals, hygiene, moving), hours committed per area, recorded focus windows, and what is still unaccounted for. Nothing is assumed.', {}, () => svc.capacity());

  // ---- path ----
  t('get_path', 'Milestones with pace (ahead/on_pace/behind) and their steps. current_milestone_id is the one to work on.', {}, () => svc.getPath());
  t('set_milestones', 'Set 2–6 ordered milestones under the goal, each with a metric, target and due date before the goal deadline. Replaces the list; existing ids keep their steps.', {
    milestones: z.array(z.object({ id: z.string().optional(), title: z.string(), metric: z.string(), target: z.number(), due: date })),
  }, a => svc.setMilestones(a.milestones));
  t('add_steps', 'Add concrete steps to a milestone. A step is an action that fits a few focus blocks ("email 10 people from the waitlist"), not "do marketing". Abstract steps are rejected.', {
    milestoneId: z.string(), steps: z.array(z.object({ title: z.string(), leverId: z.string().optional(), estimateMin: z.number().int().optional() })),
  }, a => svc.addSteps(a.milestoneId, a.steps));
  t('update_step', 'Change a step: title, status (todo/doing/done), order, lever, estimate.', { stepId: z.string(), title: z.string().optional(), status: z.enum(['todo', 'doing', 'done']).optional(), order: z.number().int().optional(), leverId: z.string().optional(), estimateMin: z.number().int().optional() }, a => svc.updateStep(a.stepId, a));
  t('next_steps', 'Open steps of the current milestone, hard-lever steps first: the candidates for today\'s main step.', { count: z.number().int().min(1).max(20).optional() }, a => svc.nextSteps(a.count));

  // ---- planning ----
  t('get_planning_context', 'Everything needed to plan a day: goal and pace, next_steps, yesterday\'s summary and undone items, week balance, days since a hard lever. Defaults to tomorrow. The agent plans; then call set_plan.', { date: date.optional() }, a => svc.getPlanningContext(a.date));
  t('set_plan', 'Save the plan for a day. Exactly one item must have isMainStep=true (the step toward the goal), ideally linked by stepId from next_steps. Other items: paid work, family, workout, etc. with their area.', {
    date: date.optional(), items: z.array(z.object({ title: z.string(), area, projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), isMainStep: z.boolean().optional(), estimateMin: z.number().int().optional() })),
  }, a => svc.setPlan(a.date, a.items));
  t('get_plan', 'The plan for a day (default today).', { date: date.optional() }, a => svc.getPlan(a.date));
  t('complete_item', 'Mark a plan item done. If it is linked to a path step, the step is marked done too.', { itemId: z.string(), date: date.optional() }, a => svc.completeItem(a.itemId, a.date));
  t('set_mode', 'Tracking mode for a day: full (everything logged), focus (only focus blocks), off (timer and reminders only, nothing stored, no plan required).', { date: date.optional(), mode: z.enum(['full', 'focus', 'off']) }, a => svc.setMode(a.date, a.mode));

  // ---- sessions ----
  t('start_focus', 'Start a focus session and (if none is running) the pomodoro timer. Returns a verdict: ok | stop | plan_first. On "stop" NO session is created: relay the message, ask the user; if they insist, call again with override=true. Several sessions may run at once (two terminals) and share attention by weight.', {
    task: z.string().describe('what you are about to do, specific'), area: area.optional().describe('default work'), projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), itemId: z.string().optional().describe('plan item id'),
    weight: z.number().min(0).optional().describe('attention weight vs other running sessions, default 1'), exclusive: z.boolean().optional(), direction: z.enum(['up','down']).optional().describe("up (default) counts elapsed time and runs until you stop it, with a stand-up reminder every workMin; down is a fixed timebox, for a break"), minutes: z.number().int().min(5).max(120).optional().describe('length for a down timer, or the stand-up interval for an up timer'), workplace: z.enum(['desktop', 'mobile']).optional(), override: z.boolean().optional().describe('true only after the user confirmed past a stop'),
  }, a => svc.startFocus(a));
  t('split_attention', 'Set attention weights of the running sessions, e.g. {"abc": 0.7, "def": 0.3}. Applies to the whole session.', { shares: z.record(z.string(), z.number().min(0)) }, a => svc.splitAttention(a.shares));
  t('heartbeat', 'Append a one-line note to the running session of this connection (or session_id). Used by the Stop hook. May re-classify an unclassified session.', { note: z.string(), session_id: z.string().optional() }, a => svc.heartbeat(a.note, a.session_id));
  t('end_focus', 'End the running session of this connection (or session_id) with a summary and outcome. outcome=done completes the linked plan item / path step. attention_share (0..1) corrects the share in hindsight.', {
    summary: z.string(), outcome: z.enum(['done', 'partial', 'abandoned']), session_id: z.string().optional(), attention_share: z.number().min(0).max(1).optional(),
  }, a => svc.endFocus(a.summary, a.outcome, a.session_id, a.attention_share));
  t('cancel_focus', 'Discard the running session (not counted).', { session_id: z.string().optional() }, a => svc.cancelFocus(a.session_id));
  t('end_block', 'End the pomodoro timer now (stand up). Returns the break length.', {}, () => svc.endBlock(false));
  t('cancel_block', 'Cancel the pomodoro timer.', {}, () => svc.endBlock(true));
  t('log_session', 'Log past time: minutes (ending now, or at end) or start+end as HH:MM on date. For calls, children, workout, paid work. exclusive=true means nothing else was happening then.', {
    task: z.string(), minutes: z.number().int().min(1).optional(), start: hhmm.optional(), end: hhmm.optional(), date: date.optional(), area: area.optional(), projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), itemId: z.string().optional(), weight: z.number().min(0).optional(), exclusive: z.boolean().optional(),
  }, a => svc.logSession(a));
  t('get_current', 'Running sessions with attention shares, timer time left, today\'s main step.', {}, () => svc.getCurrent());
  t('get_gaps', 'Untracked stretches of 20+ minutes between the first and last session of a day. Ask the user what happened there.', { date: date.optional() }, a => svc.getGaps(a.date));

  // ---- review ----
  t('status', 'How am I doing: today\'s main step, attention minutes per area, goal share, running sessions, streak, one-line nudge.', {}, () => svc.status());
  t('day_summary', 'Full summary of a day: wall and attention minutes per area / classification / lever, sessions, gaps, overlaps, overrides.', { date: date.optional() }, a => svc.daySummary(a.date));
  t('week_summary', 'Week to date: main-step days, goal share, hard share, area balance, overrides, milestone pace.', { date: date.optional().describe('any day of the week, default today') }, a => svc.weekSummary(a.date));
  t('leaks', 'Where time leaks: comfortable goal work while the main step waited, overrides, unplanned work, gaps, switching, missed main steps, days without a plan. Default last 7 days.', { from: date.optional(), to: date.optional() }, a => svc.leaks(a.from, a.to));
  t('streak', 'Consecutive days with the main step done.', {}, () => svc.streak());
  t('history', 'Sessions in a range, optionally filtered by area or project.', { from: date.optional(), to: date.optional(), area: area.optional(), projectId: z.string().optional() }, a => svc.history(a.from, a.to, a.area, a.projectId));

  // ---- prompts ----
  server.registerPrompt('plan-tomorrow', { description: 'Plan tomorrow: one main step toward the goal, then the rest of life.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Call get_planning_context for tomorrow. Propose a plan: exactly one main step chosen from next_steps (prefer a hard lever if it has been more than 2 days), then paid work, family, workout and other commitments as items with their area. Ask me to confirm or adjust, then call set_plan.' } }],
  }));
  server.registerPrompt('evening-review', { description: 'Review today and close the day.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Call day_summary and get_gaps for today. Tell me in 5 lines: was the main step done, minutes on the goal vs elsewhere, hard share, what leaked, and one honest observation. Ask about any gap over 30 minutes and offer to log it. Then offer to plan tomorrow.' } }],
  }));
}
