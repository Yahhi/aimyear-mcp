import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AimService, AimError, ProRequiredError } from './service.js';
import { AREAS, NETWORKS, TRACKINGS } from './types.js';
import type { SocialService } from './social/service.js';
import type { AccountService } from './account.js';
import { levelOfTool } from './access.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The /aim skill (skills/aim/SKILL.md, also the public repo copy): the method behind the tools,
 * served as the `aim` prompt and the aimyear://skill/aim resource so a client without the skill
 * installed still gets it. Read from the same file, so the two never drift. */
export const SKILL = readFileSync(fileURLToPath(new URL('../skills/aim/SKILL.md', import.meta.url)), 'utf8');
const skillBody = SKILL.replace(/^---\n[\s\S]*?\n---\n+/, '');

const area = z.enum(AREAS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD in the user\'s timezone');
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM local time');

type Handler = (args: any) => Promise<unknown>;

/** What each tool does to the person's data. Clients show these before they approve a call. */
type Kind = 'read' | 'write' | 'idempotent' | 'destructive';
const READ = ['get_goal', 'check_goal_draft', 'get_path', 'next_steps', 'get_commitments', 'get_capacity', 'get_planning_context', 'get_plan', 'get_routines',
  'get_now', 'list_sessions', 'find_gaps', 'summarize_day', 'summarize_week', 'find_leaks', 'get_settings', 'list_devices', 'list_social_accounts', 'get_post_draft',
  'get_insights', 'list_agents', 'list_moves'];
// Replaces a whole list or removes something: an earlier value is gone after the call.
const DESTRUCTIVE = ['set_goal', 'set_levers', 'set_projects', 'set_milestones', 'set_tracks', 'set_commitments', 'set_routines', 'set_plan',
  'delete_step', 'delete_plan_item', 'delete_session', 'delete_move', 'delete_device', 'stop_timer', 'delete_social_account', 'delete_agent'];
// Calling twice with the same arguments leaves the same result.
const IDEMPOTENT = ['record_progress', 'edit_milestone', 'edit_step', 'edit_plan_item', 'set_day_mode', 'split_attention', 'edit_session', 'set_settings', 'add_device',
  // Connecting again replaces the saved login; a day's post goes to each network once, however often it is called.
  'add_social_account', 'add_post'];
// Reaches a network outside AimYear (WIP, Bluesky).
const OPEN_WORLD = ['add_social_account', 'get_post_draft', 'add_post'];
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
    openWorldHint: OPEN_WORLD.includes(name),
  };
}

export const INSTRUCTIONS = `AimYear keeps one person's big aim for the year, the path of stages toward it, today's plan, a timer and an honest record of what moved toward the aim. Every tool acts as the signed-in person.

Names: get_ reads one thing, list_ reads several, find_ looks for problems, set_ replaces a whole list, add_ / edit_ / delete_ change one entry. A session is one piece of work; the timer runs while sessions run. A move (add_move) is one action toward the aim with no duration, for work that had no timer. The weekly target (days a week toward the aim, set_settings weekly_target) is what AimYear leads with, not a daily streak. When a result has quiet_numbers: true, the user chose not to hear minutes or percentages: speak in words, moves and days only.

Typical flow: get_goal (or check_goal_draft → set_goal), get_path (a path can have up to 3 tracks, set_tracks: different ways to the same aim, each with its own current milestone; the main step can come from any of them), get_planning_context → set_plan with one main step (routines from set_routines are added to each day's plan by the server), start_session before work (honor its verdict: ok, plan_first or stop), stop_session with a real summary, summarize_day / summarize_week / find_leaks for reviews. To fix a record, use edit_session or delete_session. Hard first: the first step of each stage and each day's main step should be on a hard lever (the work the user puts off: outreach, applications, selling, publishing). Preparation (CV, profile, research, polishing) comes only when it blocks the hard step, and only as much as it blocks; do the hard step with what exists now and improve after the replies. set_plan, add_steps and set_levers warn when this is broken: fix it before moving on. Every result has a "speak" field: say it to the user in your own words. Start or stop the timer only when the user asks; adding past time with add_session is always fine. Posting progress in public (WIP, Bluesky; Pro): get_post_draft shows the day's draft from the record; add_post publishes it only when the user explicitly asks, with their edits. get_insights gives the week or month at a glance (aim/other/life minutes, hard share, when hard work happens, comebacks). list_agents shows the agents connected to the account; delete_agent disconnects one, only when the user asks.

The method behind these tools (setting a countable aim, stages by readiness, hard first, an honest record, a weekly target) is the prompt "aim", also the resource aimyear://skill/aim. If the client has no /aim skill installed, read it before setting an aim or planning.`;

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
      const code = e instanceof ProRequiredError ? { code: e.code } : {};
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, ...code, speak: msg }) }], isError: true };
    }
  };
}

/** svc is null for an anonymous caller: the tools are listed, and every call is refused. */
export function registerTools(server: McpServer, maybeSvc: AimService | null, maybeSocial: SocialService | null = null, maybeAccount: AccountService | null = null) {
  const svc = maybeSvc as AimService;
  const social = maybeSocial as SocialService;
  const account = maybeAccount as AccountService;
  const t = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, fn: Handler) =>
    server.registerTool(name, { title: title(name), description, inputSchema: shape, annotations: annotationsFor(name) }, wrap(name, fn, maybeSvc !== null));

  const outcome = z.enum(['done', 'partial', 'abandoned']);
  const network = z.enum(NETWORKS);
  const opId = z.string().min(8).max(128).optional().describe('for apps replaying queued requests: an id the app minted before its first attempt and reuses on retries, so the write is applied once and a retry gets the first answer back. Do not invent one; an agent calling interactively leaves it out');
  const iso = (what: string) => z.string().optional().describe(`${what} as ISO 8601 with offset, e.g. 2026-10-20T14:05:00+02:00. For apps delivering a request queued offline; an agent calling interactively leaves it out. Rejected before the session start; a clock more than 2 minutes ahead of the server is taken as now`);
  const sessionLinks = {
    area: area.optional().describe('default work'), projectId: z.string().optional(), leverId: z.string().optional(),
    stepId: z.string().optional().describe('path step id'), itemId: z.string().optional().describe('plan item id'),
    weight: z.number().min(0).optional().describe('attention weight vs other sessions at the same time, default 1'), exclusive: z.boolean().optional().describe('true: nothing else was happening then'),
  };

  // ---- aim ----
  const goalKind = z.enum(['count', 'done']).optional().describe('count (default): a number from baseline to target, e.g. "15 paying customers". done: a one-time result checked yes or no, e.g. "launch v2 in the stores"; no metric, baseline or target, progress is the share of stages done');
  t('get_goal', 'The one yearly goal: kind (count or done), metric, starting value, current value, target, deadline, progress, levers (hard/comfortable) and other projects. Call first in most flows.', {}, () => svc.getGoal());
  t('check_goal_draft', 'Check a goal that is not saved yet against the rubric (a countable metric with value today and target, or a done-or-not result you can check yes or no; deadline within 12 months; pace per week). Changes nothing. Returns problems[] and next_question: loop until problems is empty, then call set_goal. Prefer count; use done only when no honest number exists.', {
    kind: goalKind, title: z.string().optional(), metric: z.string().optional().describe('the one number and its unit, e.g. "paying customers"'), baseline: z.number().optional().describe('value today'), target: z.number().optional(), deadline: date.optional(),
  }, a => svc.checkGoalDraft(a));
  t('set_goal', 'Save the yearly goal, or replace it with the next one. Rejects with problems[] if the rubric fails. Keeps levers and projects. area is which of the five life areas the goal belongs to.', {
    kind: goalKind, title: z.string(), why: z.string().optional(), metric: z.string().optional().describe('required for kind count'), baseline: z.number().optional().describe('value today; required for kind count'), target: z.number().optional().describe('required for kind count'), deadline: date, area: area.optional().describe('default money'),
  }, a => svc.setGoal(a));
  t('record_progress', 'Record the current value of the goal metric ("I now have 4 customers"), or of a countable milestone when milestoneId is given ("I have talked to 7 people"). For a done-or-not goal, 1 marks it done. One value per date: calling again for the same date corrects it. Says when the target is reached; a countable milestone that reaches its target is done.', { value: z.number(), date: date.optional(), milestoneId: z.string().optional().describe('a countable milestone instead of the goal') }, a => svc.recordProgress(a.value, a.date, a.milestoneId));
  t('set_levers', 'Replace the list of levers: the recurring kinds of goal work. At least one must be kind=hard (the work the user avoids). keywords/repos are hints for classifying sessions from their task text. Pass existing ids to keep them.', {
    levers: z.array(z.object({ id: z.string().optional(), name: z.string(), kind: z.enum(['hard', 'comfortable']), examples: z.array(z.string()).optional(), keywords: z.array(z.string()).optional(), repos: z.array(z.string()).optional() })),
  }, a => svc.setLevers(a.levers));
  t('set_projects', 'Replace the list of other projects (paid work, other products, life routines), so their sessions count as other work or life, not goal work. Pass the whole list: leave one out to remove it, change its name or hints to edit it. Pass existing ids to keep them.', {
    projects: z.array(z.object({ id: z.string().optional(), name: z.string(), area, keywords: z.array(z.string()).optional(), repos: z.array(z.string()).optional() })),
  }, a => svc.setProjects(a.projects));

  // ---- path ----
  const milestoneKind = z.enum(['count', 'steps']).optional().describe('count: progress is a recorded value against target ("talk to 20 people"); steps: progress is steps done ("implement the onboarding flow"), no metric needed. Default: count when metric and target are given, else steps; an existing milestone keeps its kind');
  const trackId = z.string().optional().describe('the track this milestone belongs to (set_tracks); required for open milestones once the path has tracks');
  t('get_path', 'Milestones with kind, progress (recorded value or steps done), pace (ahead/on_pace/behind) and their steps. With tracks: tracks[], each with its current_milestone_id (every track has its own current milestone); current_milestone_id is then the first open one in list order. Without tracks, current_milestone_id is the one to work on.', {}, () => svc.getPath());
  t('set_milestones', 'Replace the list of ordered milestones under the goal (2–6, or up to 6 per track), each countable (metric and target) or measured by its steps, with a due date before the goal deadline; due dates in order within a track. Pass each existing id, or that milestone\'s steps are deleted. To change one milestone, use edit_milestone.', {
    milestones: z.array(z.object({ id: z.string().optional(), title: z.string(), kind: milestoneKind, metric: z.string().optional(), target: z.number().optional(), due: date, trackId })),
  }, a => svc.setMilestones(a.milestones));
  t('set_tracks', 'Replace the tracks of the path: 0 to 3 different ways to reach the same aim (e.g. two products that could each earn the target), each with its own milestones and current milestone. reach says how this track alone would reach the aim. milestoneIds puts those milestones into the track, in that order. An empty list makes the path one list again. Use tracks only when the user chooses to work on more than one way; never present one track as the wrong one.', {
    tracks: z.array(z.object({ id: z.string().optional(), title: z.string(), reach: z.string().optional().describe('how this track alone reaches the aim, e.g. "about 24 yearly plans sold in December"'), milestoneIds: z.array(z.string()).optional() })),
  }, a => svc.setTracks(a.tracks));
  t('edit_milestone', 'Change one milestone: title, kind (count or steps), metric, target, due date, status or track. status=retired drops it without finishing; done or retired moves its track to the next milestone. Its steps are kept.', {
    milestoneId: z.string(), title: z.string().optional(), kind: milestoneKind, metric: z.string().optional(), target: z.number().optional(), due: date.optional(), status: z.enum(['todo', 'doing', 'done', 'retired']).optional(), trackId: z.string().optional().describe('move it to this track (set_tracks)'),
  }, a => svc.editMilestone(a.milestoneId, a));
  t('add_steps', 'Add concrete steps to a milestone. A step is an action that fits a few work blocks ("email 10 people from the waitlist"), not "do marketing". Abstract steps are rejected. Put a hard-lever step first; preparation only where it blocks it (warns otherwise).', {
    milestoneId: z.string(), steps: z.array(z.object({ title: z.string(), leverId: z.string().optional(), estimateMin: z.number().int().optional() })), op_id: opId,
  }, a => svc.addSteps(a.milestoneId, a.steps, a.op_id));
  t('edit_step', 'Change one step: title, status (todo/doing/done), order, lever, estimate.', { stepId: z.string(), title: z.string().optional(), status: z.enum(['todo', 'doing', 'done']).optional(), order: z.number().int().optional(), leverId: z.string().optional(), estimateMin: z.number().int().optional() }, a => svc.editStep(a.stepId, a));
  t('delete_step', 'Delete one step from the path.', { stepId: z.string() }, a => svc.deleteStep(a.stepId));
  t('next_steps', 'Open steps of the current milestone (of every track, taken in turns, each step with its track), hard-lever steps first: the candidates for today\'s main step.', { count: z.number().int().min(1).max(20).optional() }, a => svc.nextSteps(a.count));

  // ---- week ----
  t('get_commitments', 'Recurring weekly time: commitments (school runs, training, classes), overhead (sleep, meals) and focus windows.', {}, () => svc.getCommitments());
  t('set_commitments', 'Replace the list of recurring weekly commitments. days are ISO weekdays 1=Mon..7=Sun; use timesPerWeek instead when there are no fixed days. Pass existing ids to keep them.', {
    commitments: z.array(z.object({ id: z.string().optional(), title: z.string(), kind: z.enum(['commitment', 'overhead', 'window']).optional().describe("commitment = unavailable and belongs to an area; overhead = unavailable and belongs to no area (sleep, meals, hygiene, moving between places); window = time available for focus work. Default commitment."), area: area.optional().describe('required for kind commitment'), days: z.array(z.number().int().min(1).max(7)).optional(), timesPerWeek: z.number().int().min(1).max(7).optional(), start: hhmm.optional(), minutes: z.number().int().min(1), usableForWork: z.boolean().optional().describe('committed but still workable (waiting, being a passenger)'), assumed: z.boolean().optional().describe('true when the number is your inference, not something the user stated'), insideWindowId: z.string().optional().describe('id of a kind:window entry this commitment is carved out of, so the window is not counted twice'), projectId: z.string().optional(), note: z.string().optional() })),
  }, async a => {
    const r = await svc.setCommitments(a.commitments);
    // The evening post offer follows the last focus window: move it with the windows.
    if (r.ok && social) await social.armOffer().catch(e => console.error('[set_commitments] post offer re-arm failed', (e as Error).message));
    return r;
  });
  t('get_capacity', 'Weekly time budget out of 168 hours: overhead, hours committed per area, focus windows, and what is still unaccounted for. Nothing is assumed.', {}, () => svc.capacity());

  // ---- day ----
  t('get_planning_context', 'Everything needed to plan a day: goal and pace, next_steps, yesterday\'s summary and undone items, week balance, days since a hard lever. Defaults to tomorrow. The agent plans; then call set_plan.', { date: date.optional() }, a => svc.getPlanningContext(a.date));
  t('get_plan', 'The plan for a day (default today).', { date: date.optional() }, a => svc.getPlan(a.date));
  t('set_plan', 'Replace the plan for a day. Exactly one item must have isMainStep=true (the step toward the goal), ideally linked by stepId from next_steps and on a hard lever. Warns when no item is on a hard lever. Other items: paid work, family, workout, etc. with their area. Items that stay keep their done state.', {
    date: date.optional(), items: z.array(z.object({ title: z.string(), area, projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), isMainStep: z.boolean().optional(), estimateMin: z.number().int().optional() })),
  }, a => svc.setPlan(a.date, a.items));
  t('edit_plan_item', 'Change one plan item: mark it done or not done, rename it, change its estimate, area or links, or make it the main step. done=true also completes its linked path step. For a weekly routine, count says how many units this tick did (talked to 2 people today). For a routine, level minimum says only its bad-day minimum was done: it counts for the day, reported apart from full.', {
    itemId: z.string(), date: date.optional(), done: z.boolean().optional(), level: z.enum(['full', 'minimum']).optional().describe('routines only; sets done unless done is given'), count: z.number().int().min(0).optional().describe('units done in this tick, for a routine with perWeek; above 0 ticks it, 0 unticks it'), title: z.string().optional(), area: area.optional(), projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional(), isMainStep: z.boolean().optional(), estimateMin: z.number().int().optional(),
  }, a => svc.editPlanItem(a.itemId, a.date, a));
  t('get_routines', 'Routines: small steps that repeat on fixed weekdays, e.g. "talk with one person on Reddit", or that count up to a number a week, e.g. "talk to 5 people a week", each with an optional bad-day minimum. The server adds them to each matching day\'s plan, so every device and agent sees the same checks. With no routines yet, returns ready-made starters for the aim\'s area to offer as they are.', {}, () => svc.getRoutines());
  t('set_routines', 'Replace the list of routines: small steps that repeat on fixed weekdays. From today on, each one appears as a plan item on its days; tick it with edit_plan_item, skip it for one day with delete_plan_item. set_plan keeps them. days are ISO weekdays 1=Mon..7=Sun, default every day. perWeek makes it a weekly count: each tick adds its count (default 1), and once the week reaches perWeek it leaves the plan until Monday. Link it to the goal with leverId. minimum is the small version for a bad day ("read one thread" for "talk to one person"). Pass existing ids to keep them.', {
    routines: z.array(z.object({ id: z.string().optional(), title: z.string(), area, projectId: z.string().optional(), leverId: z.string().optional(), days: z.array(z.number().int().min(1).max(7)).optional(), estimateMin: z.number().int().optional().describe('default 15'), perWeek: z.number().int().min(1).optional().describe('weekly count, e.g. 5 for "talk to 5 people a week"'), minimum: z.string().optional().describe('the bad-day version, e.g. "read one thread"') })),
  }, a => svc.setRoutines(a.routines));
  t('delete_plan_item', 'Remove one item from a day\'s plan. A routine item is skipped for that day only.', { itemId: z.string(), date: date.optional() }, a => svc.deletePlanItem(a.itemId, a.date));
  t('set_day_mode', 'Tracking for a day: full (everything recorded, the default) or off (timer and reminders only, nothing stored, no plan required).', { date: date.optional(), mode: z.enum(['full', 'off']) }, a => svc.setDayMode(a.date, a.mode));

  // ---- timer & sessions ----
  t('get_now', 'What is happening now: running sessions with attention shares, the timer, today\'s main step, today\'s minutes, the streak and a one-line nudge.', {}, () => svc.getNow());
  t('start_session', 'Start a session of work and, if none is running, the timer. Returns a verdict: ok | stop | plan_first. On "stop" NO session is created: relay the message, ask the user; if they insist, call again with override=true. Several sessions may run at once (two terminals) and share attention by weight. Apps replaying a queued start pass op_id, their own session_id and start_at; an agent leaves all three out.', {
    task: z.string().describe('what you are about to do, specific'), ...sessionLinks,
    direction: z.enum(['up', 'down']).optional().describe('up (default) counts elapsed time and runs until stopped, with a stand-up reminder every workMin; down is a fixed timebox, for a break'), minutes: z.number().int().min(5).max(120).optional().describe('length for a down timer, or the stand-up interval for an up timer'), workplace: z.enum(['desktop', 'mobile']).optional(), override: z.boolean().optional().describe('true only after the user confirmed past a stop'),
    op_id: opId, start_at: iso('when the work began'), session_id: z.string().min(6).max(64).optional().describe('for apps: the session id the app minted itself. Create-if-absent: if a session with this id exists it is returned and nothing is created. An agent leaves it out; the server mints the id'),
  }, a => svc.startSession({ ...a, opId: a.op_id, startAt: a.start_at, sessionId: a.session_id }));
  t('add_note', 'Add a one-line note to a running session (this connection\'s, or session_id). May classify a session that was unclassified.', { note: z.string(), session_id: z.string().optional().describe('from get_now; required with op_id'), op_id: opId }, a => svc.addNote(a.note, a.session_id, a.op_id));
  t('split_attention', 'Set attention weights of the running sessions at once, e.g. {"abc": 0.7, "def": 0.3}. Applies to the whole session. For a finished session use edit_session.', { shares: z.record(z.string(), z.number().min(0)) }, a => svc.splitAttention(a.shares));
  t('stop_session', 'Stop a running session with a summary and outcome. Pass session_id from get_now; without it, only this connection\'s single running session is stopped, never another one. The timer keeps running for other sessions. outcome=done completes the linked plan item or path step. Without end_at or op_id it refuses a session that already ended: use edit_session for that. With end_at (apps delivering a stop queued offline) a second stop on the same session is merged, whatever order they arrive in: the earliest end wins, done wins over any other outcome, the first summary stays and a different later one goes to the notes; the answer says applied: ended | shortened | recorded.', {
    summary: z.string(), outcome, session_id: z.string().optional().describe('from get_now; required with op_id or end_at'), attention_share: z.number().min(0).max(1).optional().describe('corrects the share in hindsight'),
    end_at: iso('when the work ended'), op_id: opId,
  }, a => svc.stopSession(a.summary, a.outcome, a.session_id, a.attention_share, { opId: a.op_id, endAt: a.end_at }));
  t('stop_timer', 'Stop the timer ("pause", "stop", "stand up") and every running session with it. There is no paused state: resuming starts a new session. Pass summary and outcome to save them on the sessions it closes, or call stop_session first. Returns the break length.', {
    summary: z.string().optional(), outcome: outcome.optional().describe('default partial'),
  }, a => svc.stopTimer(a.summary, a.outcome));
  t('add_session', 'Add past time that was not timed: minutes (ending now, or at end), or start+end as HH:MM on date. For calls, children, workout, paid work, or work done away from the agent. Apps replaying a queued entry pass op_id, so a retry does not count the time twice.', {
    task: z.string(), minutes: z.number().int().min(1).optional(), start: hhmm.optional(), end: hhmm.optional(), date: date.optional(), ...sessionLinks, op_id: opId,
  }, a => svc.addSession({ ...a, opId: a.op_id }));
  t('edit_session', 'Fix a session, running or finished: start and end (HH:MM on date; an end before the start means it ran past midnight), task, area, project, lever, step, plan item, summary, outcome, attention share, weight. It is classified again after a change. Use it when a timer was forgotten or a session was labelled wrong.', {
    session_id: z.string(), date: date.optional().describe('local date of start and end; default the session\'s own date'), start: hhmm.optional(), end: hhmm.optional(), task: z.string().optional(), ...sessionLinks,
    summary: z.string().optional(), outcome: outcome.optional(), attention_share: z.number().min(0).max(1).optional().describe('share of the session\'s wall time that was real attention'),
  }, a => svc.editSession(a.session_id, { ...a, attentionShare: a.attention_share }));
  t('delete_session', 'Delete a session, running or finished, so it no longer counts. Pass session_id from get_now or list_sessions; without it, only this connection\'s single running session is deleted, never another one.', { session_id: z.string().optional().describe('required with op_id'), op_id: opId }, a => svc.deleteSession(a.session_id, a.op_id));
  // ---- moves (docs/moves.md) ----
  t('add_move', 'Record a move: one action toward the aim with no duration, e.g. a small fix the user described to you from the phone, or a message sent. task says what changed, in plain words. Classified like a session (pass leverId, stepId, itemId or projectId when known). Past days are fine (date). completes_item: true with item_id ticks that plan item, so a move can finish the main step. Counts toward the weekly target. Use it for work that had no timer; use add_session for timed work.', {
    task: z.string().describe('what changed, e.g. "fixed the signup button text on the landing page"'), date: date.optional().describe('default today; a past day for a move done then'), time: hhmm.optional().describe('when it happened, if known'),
    area: area.optional().describe('default work'), projectId: z.string().optional(), leverId: z.string().optional(), stepId: z.string().optional().describe('path step id'), itemId: z.string().optional().describe('plan item id'),
    completes_item: z.boolean().optional().describe('true: this move finishes the plan item item_id (and its path step)'),
  }, a => svc.addMove({ ...a, completesItem: a.completes_item }));
  t('list_moves', 'Moves in a date range (default the last 7 days), with ids, whether each was toward the aim and on the hard part.', { from: date.optional(), to: date.optional() }, a => svc.listMoves(a.from, a.to));
  t('delete_move', 'Delete a move recorded by mistake. Pass move_id from list_moves. A plan item it ticked stays ticked.', { move_id: z.string() }, a => svc.deleteMove(a.move_id));
  t('list_sessions', 'Sessions in a date range (default the last 7 days), with ids, optionally filtered by area or project.', { from: date.optional(), to: date.optional(), area: area.optional(), projectId: z.string().optional() }, a => svc.history(a.from, a.to, a.area, a.projectId));
  t('find_gaps', 'Untimed stretches of 20+ minutes between the first and last session of a day. Ask the user what happened there.', { date: date.optional() }, a => svc.getGaps(a.date));

  // ---- reviews ----
  t('summarize_day', 'Full summary of a day: wall and attention minutes per area, classification and lever, sessions, gaps, overlaps, overrides.', { date: date.optional() }, a => svc.daySummary(a.date));
  t('summarize_week', 'A week, Monday to Sunday (to today for the current week): main-step days, goal share, hard share, area balance, overrides, streak, milestone pace.', { date: date.optional().describe('any day of the week, default today') }, a => svc.weekSummary(a.date));
  t('get_insights', 'Week (the last 7 days) or month (the last 30 days) ending on to (default today): minutes per day on the aim, other work and life; hard vs comfortable share of aim time; an hour × weekday heatmap of aim minutes (6:00–23:00, Mon–Sun) with its hard part and the peak; main-step days; and comebacks (active days after 2+ days away, over 90 days). Wall minutes of finished sessions, as the app shows them.', {
    range: z.enum(['week', 'month']).optional().describe('default week'), to: date.optional().describe('last day, default today'),
  }, a => svc.getInsights(a.range, a.to));
  t('find_leaks', 'Where time leaks: comfortable goal work while the main step waited, overrides, unplanned work, gaps, switching, missed main steps, days without a plan. Default the last 7 days.', { from: date.optional(), to: date.optional() }, a => svc.leaks(a.from, a.to));

  // ---- settings & devices ----
  t('get_settings', 'Timezone, where reminders go (desktop or mobile), timer settings, which networks get progress posts (post_to), tracking (time, moves or quiet) and the weekly target.', {}, () => svc.getSettings());
  t('set_settings', 'Change any of: timezone (IANA name, e.g. Europe/Madrid; it sets where each day starts and ends), workplace for reminders, stand-up interval workMin, breakMin, longBreakEvery, longBreakMin, standup on/off, post_to (networks for progress posts), tracking (time, moves or quiet) and weekly_target (days a week toward the aim).', {
    timezone: z.string().optional(), workplace: z.enum(['desktop', 'mobile']).optional(), workMin: z.number().int().min(5).max(120).optional(), breakMin: z.number().int().min(1).max(60).optional(), longBreakEvery: z.number().int().min(1).max(10).optional(), longBreakMin: z.number().int().min(5).max(60).optional(), standup: z.boolean().optional(),
    post_to: z.array(network).optional().describe('which connected networks get the day\'s progress post (the app sets it); [] for none'),
    tracking: z.enum(TRACKINGS).optional().describe('time (default): sessions with minutes, plus moves. moves: no timer and no minutes stored, only moves. quiet: the record is kept, but reviews and posts speak in words and days, never minutes or percentages'),
    weekly_target: z.number().int().min(1).max(7).optional().describe('days a week the user wants to move toward the aim (default 4)'),
  }, a => svc.setSettings(a));
  t('add_device', 'Register a device token so server reminders (stand up, break over) can reach it. The phone app registers itself; use this for testing or a manual token.', {
    token: z.string().min(20), platform: z.enum(['ios', 'android', 'macos', 'windows', 'web']), label: z.string().optional(),
  }, a => svc.addDevice(a.token, a.platform, a.label));
  t('list_devices', 'Which devices can receive reminders, and when each was last seen.', {}, () => svc.listDevices());
  t('delete_device', 'Remove a device so it stops receiving reminders.', { token: z.string() }, a => svc.deleteDevice(a.token));

  // ---- connected agents ----
  t('list_agents', 'Agents connected to this AimYear account (Claude, ChatGPT, Claude Code, the AimYear app…): name, client_id, when it connected and when it was last active. current marks the one calling.', {}, () => account.listAgents());
  t('delete_agent', 'Disconnect one agent: its sign-in for this account is deleted and it can no longer read or change anything until it connects again. Only on the user\'s explicit request. client_id from list_agents.', { client_id: z.string().min(1).max(200) }, a => account.disconnectAgent(a.client_id));

  // ---- posting progress in public (Pro) ----
  t('add_social_account', 'Connect WIP (wip.co) or Bluesky so AimYear can post the day\'s progress there when the user says Post (Pro). WIP: api_key from wip.co settings. Bluesky: handle and an app password (Settings → Privacy and security → App passwords), never the account password. The login is checked, stored encrypted and never shown again. The app\'s connect screen usually calls this; if the user pastes a key into the chat, use it once and do not repeat it.', {
    network, api_key: z.string().min(8).max(512).optional().describe('WIP only'), handle: z.string().max(253).optional().describe('Bluesky only, e.g. name.bsky.social'), app_password: z.string().max(64).optional().describe('Bluesky only: xxxx-xxxx-xxxx-xxxx'),
  }, a => social.connect(a));
  t('list_social_accounts', 'Connected networks (handle, since when), which of them get progress posts, and whether the user has Pro. Never returns any key or password.', {}, () => social.listAccounts());
  t('delete_social_account', 'Disconnect a network and delete its saved login. Posts already made stay there.', { network }, a => social.disconnect(a.network));
  t('get_post_draft', 'The day\'s progress post drafted from the record (aim and progress, main step done or not, minutes on the aim and on hard work, routines, comebacks), at most 300 characters, ending with aimyear.com; and per network whether it is ready, already posted, or skipped because the user already posted there that day. Posts nothing. Pro.', { date: date.optional() }, a => social.draft(a.date));
  t('add_post', 'Post the day\'s progress, only after the user explicitly said to post. text is the draft as the user edited it (default: the draft from get_post_draft). Goes to the networks chosen in settings, or the ones given. A network where the user already posted that day themselves is skipped. Each day goes to each network once: a retry never posts twice. Today or yesterday only. Pro.', {
    date: date.optional(), text: z.string().max(4000).optional(), networks: z.array(network).optional().describe('default: the networks chosen in settings'),
  }, a => social.post(a));

  // ---- prompts ----
  server.registerPrompt('plan-tomorrow', { description: 'Plan tomorrow: one main step toward the goal, then the rest of life.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Call get_planning_context for tomorrow. Propose a plan: exactly one main step chosen from next_steps (prefer a hard lever if it has been more than 2 days), then paid work, family, workout and other commitments as items with their area. Ask me to confirm or adjust, then call set_plan.' } }],
  }));
  server.registerPrompt('aim', { description: 'The AimYear method (the /aim skill): set a countable aim, build the path, plan the day, focus, review. Load it once per session when no /aim skill is installed.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Use this method with the AimYear tools for the rest of this session.\n\n${skillBody}` } }],
  }));
  server.registerResource('aim-skill', 'aimyear://skill/aim', { title: 'The /aim skill', description: 'The AimYear method as a skill file (SKILL.md). Install it as ~/.claude/skills/aim/SKILL.md or read it before setting an aim.', mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SKILL }] }));
  server.registerPrompt('evening-review', { description: 'Review today and close the day.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Call summarize_day and find_gaps for today. Tell me in 5 lines: was the main step done, minutes on the goal vs elsewhere, hard share, what leaked, and one honest observation. Ask about any gap over 30 minutes and offer to log it. Then offer to plan tomorrow.' } }],
  }));
}
