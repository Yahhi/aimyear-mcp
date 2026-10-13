import { Store, newId } from './store.js';
import { addDays, daysBetween, endOfDay, isValidDate, localDate, localTime, minutesBetween, startOfDay, weekStart } from './dates.js';
import { computeAttention, findGaps } from './domain/attention.js';
import { checkGoal, checkStepTitle, type GoalDraft } from './domain/goal.js';
import { classify, decideVerdict, isGoalWork } from './domain/classify.js';
import type { Area, Block, Classification, Commitment, CommitmentKind, Day, Device, Direction, Pending, Goal, Lever, Milestone, Mode, Path, PlanItem, Profile, Project, Session, Step, Workplace } from './types.js';

export class AimError extends Error {}

const round = (n: number) => Math.round(n);

export interface SessionInput {
  direction?: Direction;
  task: string; area?: Area; projectId?: string; leverId?: string; stepId?: string; itemId?: string;
  weight?: number; exclusive?: boolean; workplace?: Workplace; override?: boolean;
}

export class AimService {
  private profileCache: Profile | null = null;
  constructor(private store: Store, private clientSessionId: string, private clientWorkplace: Workplace = 'desktop') {}

  // ---------- helpers ----------
  private async profile(): Promise<Profile> {
    if (!this.profileCache) this.profileCache = await this.store.getProfile();
    return this.profileCache;
  }
  private async tz() { return (await this.profile()).timezone; }
  async today() { return localDate(new Date(), await this.tz()); }
  private async dayWindow(date: string) { const tz = await this.tz(); return { start: startOfDay(date, tz), end: endOfDay(date, tz) }; }
  private assertDate(date: string) { if (!isValidDate(date)) throw new AimError(`date must be YYYY-MM-DD, got "${date}"`); }

  private async requireGoal(): Promise<Goal> {
    const g = await this.store.getGoal();
    if (!g) throw new AimError('No goal set yet. Use validate_goal / set_goal first.');
    return g;
  }

  // ---------- goal ----------
  async validateGoal(draft: GoalDraft) {
    const check = checkGoal(draft, await this.tz());
    return { ...check, ok: check.problems.length === 0, speak: check.problems.length === 0 ? `Goal passes the rubric. Pace needed: ${check.pace_per_week} per week for ${check.weeks_left} weeks.` : check.next_question ?? check.problems.join('; ') };
  }

  async setGoal(draft: Required<Pick<GoalDraft, 'title' | 'metric' | 'baseline' | 'target' | 'deadline'>> & { why?: string; area?: Area }) {
    const check = checkGoal(draft, await this.tz());
    if (check.problems.length) return { ok: false, ...check, speak: `Not saved: ${check.problems.join('; ')}. ${check.next_question ?? ''}` };
    const existing = await this.store.getGoal();
    const now = new Date().toISOString();
    const goal: Goal = {
      title: draft.title.trim(), area: draft.area ?? existing?.area ?? 'money', why: (draft.why ?? existing?.why ?? '').trim(), metric: draft.metric.trim(),
      baseline: draft.baseline, target: draft.target, deadline: draft.deadline,
      baselineHistory: existing?.baselineHistory?.length ? existing.baselineHistory : [{ value: draft.baseline, date: await this.today() }],
      levers: existing?.levers ?? [], projects: existing?.projects ?? [],
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    await this.store.saveGoal(goal);
    return { ok: true, goal, pace_per_week: check.pace_per_week, weeks_left: check.weeks_left, speak: `Goal saved [${goal.area}]: "${goal.title}" — ${goal.metric} from ${goal.baseline} to ${goal.target} by ${goal.deadline}. That is ${check.pace_per_week} per week.${goal.levers.length ? '' : ' Next: milestones (set_milestones), steps for the first one (add_steps), then levers (set_levers).'}` };
  }

  async getGoal() {
    const goal = await this.store.getGoal();
    if (!goal) return { goal: null, speak: 'No goal set yet.' };
    const today = await this.today();
    const daysLeft = daysBetween(today, goal.deadline);
    const latest = goal.baselineHistory[goal.baselineHistory.length - 1];
    const progress = goal.target === goal.baseline ? 0 : (latest.value - goal.baseline) / (goal.target - goal.baseline);
    const totalDays = daysBetween(goal.createdAt.slice(0, 10), goal.deadline) || 1;
    const elapsed = Math.min(1, Math.max(0, daysBetween(goal.createdAt.slice(0, 10), today) / totalDays));
    return {
      goal, current_value: latest.value, days_left: daysLeft, progress_fraction: Math.round(progress * 100) / 100, time_elapsed_fraction: Math.round(elapsed * 100) / 100,
      speak: `Goal [${goal.area ?? 'money'}]: "${goal.title}". ${goal.metric}: ${latest.value} of ${goal.target} (started at ${goal.baseline}), ${daysLeft} days left. Levers: ${goal.levers.map(l => `${l.name} (${l.kind})`).join(', ') || 'none yet'}.`,
    };
  }

  async updateBaseline(value: number, date?: string) {
    const goal = await this.requireGoal();
    const d = date ?? await this.today(); this.assertDate(d);
    goal.baselineHistory.push({ value, date: d });
    goal.baselineHistory.sort((a, b) => a.date.localeCompare(b.date));
    goal.updatedAt = new Date().toISOString();
    await this.store.saveGoal(goal);
    return { ok: true, history: goal.baselineHistory, speak: `Recorded ${goal.metric} = ${value} on ${d}. Target ${goal.target} by ${goal.deadline}.` };
  }

  async setLevers(levers: { id?: string; name: string; kind: 'hard' | 'comfortable'; examples?: string[]; keywords?: string[]; repos?: string[] }[]) {
    const goal = await this.requireGoal();
    goal.levers = levers.map(l => ({ id: l.id ?? slug(l.name), name: l.name.trim(), kind: l.kind, examples: l.examples ?? [], match: { keywords: l.keywords ?? [], repos: l.repos ?? [] } }));
    if (!goal.levers.some(l => l.kind === 'hard')) return { ok: false, speak: 'At least one lever must be marked hard: the kind of work you admit to avoiding. Which one is it?' };
    goal.updatedAt = new Date().toISOString();
    await this.store.saveGoal(goal);
    return { ok: true, levers: goal.levers, speak: `Levers saved: ${goal.levers.map(l => `${l.name} [${l.kind}]`).join(', ')}.` };
  }

  async addProject(name: string, area: Area, keywords: string[] = [], repos: string[] = []) {
    const goal = await this.requireGoal();
    const p: Project = { id: slug(name), name: name.trim(), area, match: { keywords, repos } };
    goal.projects = [...goal.projects.filter(x => x.id !== p.id), p];
    goal.updatedAt = new Date().toISOString();
    await this.store.saveGoal(goal);
    return { ok: true, project: p, speak: `Project "${p.name}" (${area}) added. Sessions matching ${[p.name, ...keywords, ...repos].join(', ')} will be classified as other work, not goal work.` };
  }

  // ---------- path ----------
  private milestonePace(m: Milestone, prev: Milestone | undefined, steps: Step[], today: string) {
    const mine = steps.filter(s => s.milestoneId === m.id);
    const done = mine.filter(s => s.status === 'done').length;
    const from = prev?.due ?? m.createdAt.slice(0, 10);
    const span = Math.max(1, daysBetween(from, m.due));
    const elapsed = Math.min(1, Math.max(0, daysBetween(from, today) / span));
    const doneFrac = mine.length ? done / mine.length : 0;
    const status = m.status === 'done' ? 'done' : mine.length === 0 ? 'no_steps' : doneFrac >= elapsed + 0.1 ? 'ahead' : doneFrac < elapsed - 0.15 ? 'behind' : 'on_pace';
    return { steps_total: mine.length, steps_done: done, days_left: daysBetween(today, m.due), time_elapsed_fraction: Math.round(elapsed * 100) / 100, pace: status };
  }

  async getPath() {
    const path = await this.store.getPath();
    const today = await this.today();
    const milestones = path.milestones.map((m, i) => ({ ...m, ...this.milestonePace(m, path.milestones[i - 1], path.steps, today), steps: path.steps.filter(s => s.milestoneId === m.id).sort((a, b) => a.order - b.order) }));
    const current = milestones.find(m => m.status !== 'done');
    return { milestones, current_milestone_id: current?.id ?? null, speak: current ? `Current milestone: "${current.title}" due ${current.due}, ${current.steps_done}/${current.steps_total} steps done, ${current.pace}.` : 'No open milestones.' };
  }

  async setMilestones(items: { id?: string; title: string; metric: string; target: number; due: string }[]) {
    const goal = await this.requireGoal();
    const path = await this.store.getPath();
    const problems: string[] = [];
    if (items.length < 2 || items.length > 6) problems.push('use 2 to 6 milestones');
    let lastDue = '';
    for (const it of items) {
      if (!isValidDate(it.due)) problems.push(`milestone "${it.title}": due must be YYYY-MM-DD`);
      else { if (it.due > goal.deadline) problems.push(`milestone "${it.title}" is due after the goal deadline ${goal.deadline}`); if (lastDue && it.due < lastDue) problems.push(`milestone "${it.title}" is due before the previous one`); lastDue = it.due; }
      if (!it.metric?.trim()) problems.push(`milestone "${it.title}" needs a metric`);
    }
    if (problems.length) return { ok: false, problems, speak: problems.join('; ') };
    const now = new Date().toISOString();
    const byId = new Map(path.milestones.map(m => [m.id, m]));
    path.milestones = items.map(it => { const id = it.id ?? slug(it.title); const prev = byId.get(id); return { id, title: it.title.trim(), metric: it.metric.trim(), target: it.target, due: it.due, status: prev?.status ?? 'todo', createdAt: prev?.createdAt ?? now, doneAt: prev?.doneAt }; });
    const keep = new Set(path.milestones.map(m => m.id));
    path.steps = path.steps.filter(s => keep.has(s.milestoneId));
    await this.store.savePath(path);
    return { ok: true, milestones: path.milestones, speak: `${path.milestones.length} milestones saved. Now add concrete steps for the first one ("${path.milestones[0].title}") with add_steps.` };
  }

  async addSteps(milestoneId: string, steps: { title: string; leverId?: string; estimateMin?: number }[]) {
    const path = await this.store.getPath();
    const m = path.milestones.find(x => x.id === milestoneId);
    if (!m) throw new AimError(`milestone "${milestoneId}" not found; ids: ${path.milestones.map(x => x.id).join(', ')}`);
    const problems = steps.map(s => checkStepTitle(s.title)).filter((p): p is string => !!p);
    if (problems.length) return { ok: false, problems, speak: problems.join('; ') };
    const order0 = path.steps.filter(s => s.milestoneId === milestoneId).length;
    const added: Step[] = steps.map((s, i) => ({ id: newId(), milestoneId, title: s.title.trim(), leverId: s.leverId, estimateMin: s.estimateMin ?? 50, order: order0 + i, status: 'todo' }));
    path.steps.push(...added);
    await this.store.savePath(path);
    return { ok: true, steps: added, speak: `${added.length} steps added to "${m.title}".` };
  }

  async updateStep(stepId: string, patch: { title?: string; status?: 'todo' | 'doing' | 'done'; order?: number; leverId?: string; estimateMin?: number }) {
    const path = await this.store.getPath();
    const s = path.steps.find(x => x.id === stepId);
    if (!s) throw new AimError(`step "${stepId}" not found`);
    if (patch.title) { const p = checkStepTitle(patch.title); if (p) return { ok: false, problems: [p], speak: p }; s.title = patch.title.trim(); }
    if (patch.status) { s.status = patch.status; s.doneAt = patch.status === 'done' ? new Date().toISOString() : undefined; }
    if (patch.order !== undefined) s.order = patch.order;
    if (patch.leverId !== undefined) s.leverId = patch.leverId;
    if (patch.estimateMin !== undefined) s.estimateMin = patch.estimateMin;
    this.autoCloseMilestones(path);
    await this.store.savePath(path);
    return { ok: true, step: s, speak: `Step updated: "${s.title}" is ${s.status}.` };
  }

  private autoCloseMilestones(path: Path) {
    for (const m of path.milestones) {
      const mine = path.steps.filter(s => s.milestoneId === m.id);
      if (mine.length && mine.every(s => s.status === 'done') && m.status !== 'done') { m.status = 'done'; m.doneAt = new Date().toISOString(); }
    }
  }

  async nextSteps(count = 5) {
    const goal = await this.store.getGoal();
    const path = await this.store.getPath();
    const current = path.milestones.find(m => m.status !== 'done');
    if (!current) return { steps: [], speak: 'No open milestone. Set milestones first.' };
    const hard = new Set((goal?.levers ?? []).filter(l => l.kind === 'hard').map(l => l.id));
    const open = path.steps.filter(s => s.milestoneId === current.id && s.status !== 'done').sort((a, b) => (Number(hard.has(b.leverId ?? '')) - Number(hard.has(a.leverId ?? ''))) || a.order - b.order).slice(0, count);
    return { milestone: { id: current.id, title: current.title, due: current.due }, steps: open.map(s => ({ ...s, hard: hard.has(s.leverId ?? '') })), speak: open.length ? `Candidates for the main step (hard first): ${open.map(s => `[${s.id}] ${s.title}`).join('; ')}.` : `Milestone "${current.title}" has no open steps. Add some with add_steps.` };
  }

  // ---------- profile ----------
  async setPomodoro(p: Partial<Profile['pomodoro']>) {
    const prof = await this.profile();
    prof.pomodoro = { ...prof.pomodoro, ...p };
    await this.store.saveProfile(prof); this.profileCache = prof;
    return { ok: true, pomodoro: prof.pomodoro, speak: `Pomodoro: ${prof.pomodoro.workMin} min work, ${prof.pomodoro.breakMin} min break, long break every ${prof.pomodoro.longBreakEvery}.` };
  }
  async setWorkplace(w: Workplace) {
    const prof = await this.profile(); prof.defaultWorkplace = w; await this.store.saveProfile(prof); this.profileCache = prof;
    return { ok: true, speak: `Default workplace is now ${w}.` };
  }
  async setMode(date: string | undefined, mode: Mode) {
    const d = date ?? await this.today(); this.assertDate(d);
    const day = await this.store.getOrCreateDay(d, (await this.profile()).defaultMode);
    day.mode = mode; await this.store.saveDay(day);
    return { ok: true, date: d, mode, speak: mode === 'off' ? `Tracking off for ${d}: timer and reminders only, nothing stored.` : `Mode for ${d}: ${mode}.` };
  }

  // ---------- devices ----------
  async registerDevice(token: string, platform: Device['platform'], label?: string) {
    const now = new Date().toISOString();
    await this.store.saveDevice({ token, platform, lastSeen: now, foregroundAt: now, label });
    const all = await this.store.getDevices();
    return { ok: true, devices: all.map(d => ({ platform: d.platform, label: d.label, lastSeen: d.lastSeen, token: `…${d.token.slice(-8)}` })), speak: `Registered a ${platform} device. Reminders will reach ${all.length} device(s).` };
  }
  async listDevices() {
    const all = await this.store.getDevices();
    return { devices: all.map(d => ({ platform: d.platform, label: d.label, lastSeen: d.lastSeen, token: `…${d.token.slice(-8)}` })), speak: all.length ? `Devices: ${all.map(d => `${d.platform}${d.label ? ` (${d.label})` : ''}`).join(', ')}.` : 'No devices registered, so server reminders have nowhere to go. Sign in on the phone app to register one.' };
  }
  async forgetDevice(token: string) {
    await this.store.removeDevice(token);
    return { ok: true, speak: 'Device removed.' };
  }

  // ---------- commitments & capacity ----------
  async getCommitments() {
    const items = await this.store.getCommitments();
    return { commitments: items, speak: items.length ? items.map(c => `${c.title} [${c.kind}${c.area ? ' ' + c.area : ''}]: ${describeWhen(c)}, ${c.minutes} min${c.assumed ? ' (assumed)' : ''}`).join('; ') : 'No recurring commitments recorded.' };
  }

  async setCommitments(items: (Omit<Commitment, 'id' | 'days' | 'kind'> & { id?: string; days?: number[]; kind?: CommitmentKind })[]) {
    const problems: string[] = [];
    const out: Commitment[] = items.map(c => {
      if (!c.title?.trim()) problems.push('a commitment has no title');
      if (!c.minutes || c.minutes < 1) problems.push(`"${c.title}" needs minutes per occurrence`);
      const days = (c.days ?? []).filter(d => d >= 1 && d <= 7);
      if (!days.length && !c.timesPerWeek) problems.push(`"${c.title}" needs days (1=Mon..7=Sun) or timesPerWeek`);
      const kind: CommitmentKind = c.kind ?? 'commitment';
      if (kind === 'commitment' && !c.area) problems.push(`"${c.title}" needs an area (or kind overhead/window)`);
      return { id: c.id ?? slug(c.title), title: c.title.trim(), kind, area: kind === 'commitment' ? c.area : undefined, days, timesPerWeek: c.timesPerWeek, start: c.start, minutes: c.minutes, usableForWork: c.usableForWork, assumed: c.assumed, insideWindowId: c.insideWindowId, projectId: c.projectId, note: c.note };
    });
    if (problems.length) return { ok: false, problems, speak: problems.join('; ') };
    await this.store.saveCommitments(out);
    const cap = await this.capacity();
    return { ok: true, commitments: out, capacity: cap, speak: `${out.length} commitments saved. ${cap.speak}` };
  }

  /** Weekly time budget. Nothing is assumed: only what has been recorded is counted. */
  async capacity() {
    const items = await this.store.getCommitments();
    const occ = (c: Commitment) => c.days.length || c.timesPerWeek || 0;
    const perArea: Record<string, number> = {};
    let overhead = 0, committed = 0, windows = 0;
    const windowList: string[] = [], assumedList: string[] = [];
    for (const c of items) {
      const min = occ(c) * c.minutes;
      if (c.assumed) assumedList.push(`${c.title} (${Math.round(c.minutes)} min)`);
      if (c.kind === 'overhead') { overhead += min; continue; }
      if (c.kind === 'window') { windows += min; windowList.push(`${c.title}: ${describeWhen(c)}, ${Math.round((min / 60) * 10) / 10} h/week`); continue; }
      perArea[c.area ?? 'work'] = (perArea[c.area ?? 'work'] ?? 0) + min;
      committed += min;
      if (c.usableForWork) windows += min;
    }
    const h = (m: number) => Math.round((m / 60) * 10) / 10;
    const weekMin = 7 * 24 * 60;
    // Commitments carved out of a declared window must not be counted twice.
    const carved = items.filter(c => c.insideWindowId && c.kind === 'commitment').reduce((sum, c) => sum + occ(c) * c.minutes, 0);
    const netWindows = Math.max(0, windows - carved);
    const carvedList = items.filter(c => c.insideWindowId && c.kind === 'commitment').map(c => `${c.title} (${h(occ(c) * c.minutes)} h/week)`);
    const unaccounted = weekMin - overhead - committed - netWindows;
    return {
      hours_in_a_week: 168, overhead_hours: h(overhead), committed_hours: h(committed),
      focus_window_hours_gross: h(windows), carved_out_of_windows_hours: h(carved), focus_window_hours_net: h(netWindows), carved_out_by: carvedList,
      unaccounted_hours: h(unaccounted), by_area_hours: Object.fromEntries(Object.entries(perArea).map(([k, v]) => [k, h(v)])),
      focus_windows: windowList, assumed_entries: assumedList,
      speak: `Per week: ${h(overhead)} h overhead (sleep, meals, hygiene, moving), ${h(committed)} h committed to areas (${Object.entries(perArea).map(([k, v]) => `${k} ${h(v)}h`).join(', ') || 'none'}), ${h(windows)} h of focus windows minus ${h(carved)} h carved out of them (${carvedList.join(', ') || 'nothing'}) = ${h(netWindows)} h genuinely free for the goal, ${h(unaccounted)} h not yet accounted for.${windowList.length ? ` Windows: ${windowList.join('; ')}.` : ' No focus windows recorded yet, so the planner has nowhere to put the main step.'}${assumedList.length ? ` Assumed by Claude, please confirm: ${assumedList.join(', ')}.` : ''}`,
    };
  }

  /** Minutes of declared focus window on that weekday, net of commitments carved out of them. */
  private async windowMinutesFor(date: string): Promise<number> {
    const items = await this.store.getCommitments();
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const iso = dow === 0 ? 7 : dow;
    const on = (c: Commitment) => c.days.includes(iso);
    const gross = items.filter(c => c.kind === 'window' && on(c)).reduce((s, c) => s + c.minutes, 0);
    const carved = items.filter(c => c.kind === 'commitment' && c.insideWindowId && on(c)).reduce((s, c) => s + c.minutes, 0);
    return Math.max(0, gross - carved);
  }

  private async commitmentsFor(date: string): Promise<Commitment[]> {
    const items = await this.store.getCommitments();
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const iso = dow === 0 ? 7 : dow;
    return items.filter(c => c.days.includes(iso));
  }

  // ---------- planning ----------
  async getPlan(date?: string) {
    const d = date ?? await this.today(); this.assertDate(d);
    const day = await this.store.getDay(d);
    return { date: d, mode: day?.mode ?? (await this.profile()).defaultMode, plan: day?.plan ?? [], speak: day?.plan.length ? `Plan for ${d}: ${day.plan.map(p => `${p.done ? '✓' : '·'} ${p.isMainStep ? '★ ' : ''}${p.title}`).join('; ')}` : `No plan for ${d} yet.` };
  }

  async setPlan(date: string | undefined, items: { title: string; area: Area; projectId?: string; leverId?: string; stepId?: string; isMainStep?: boolean; estimateMin?: number }[]) {
    const d = date ?? await this.today(); this.assertDate(d);
    const day = await this.store.getOrCreateDay(d, (await this.profile()).defaultMode);
    const mains = items.filter(i => i.isMainStep);
    const warnings: string[] = [];
    const windowMin = await this.windowMinutesFor(d);
    if (day.mode !== 'off' && windowMin > 0) {
      if (mains.length === 0) return { ok: false, problems: ['plan has no main step'], speak: 'Every day needs exactly one step toward the goal marked as the main step. Which item is it? (Use next_steps for candidates.)' };
      if (mains.length > 1) return { ok: false, problems: ['more than one main step'], speak: 'Only one item can be the main step. Which one?' };
      if (!mains[0].stepId) warnings.push('main step is free text, not linked to a path step; link it with stepId so the path advances when it is done');
    } else if (windowMin === 0 && day.mode !== 'off') {
      warnings.push('no focus window on this day, so no main step is required');
    }
    const path = await this.store.getPath();
    for (const it of items) if (it.stepId && !path.steps.some(s => s.id === it.stepId)) return { ok: false, problems: [`stepId "${it.stepId}" not found in path`], speak: `Step ${it.stepId} is not in the path.` };
    const prev = new Map(day.plan.map(p => [p.stepId ?? p.title, p]));
    day.plan = items.map(it => { const old = prev.get(it.stepId ?? it.title); return { id: old?.id ?? newId(), title: it.title.trim(), area: it.area, projectId: it.projectId, leverId: it.leverId ?? (it.stepId ? path.steps.find(s => s.id === it.stepId)?.leverId : undefined), stepId: it.stepId, isMainStep: !!it.isMainStep, estimateMin: it.estimateMin ?? 50, done: old?.done ?? false, doneAt: old?.doneAt }; });
    await this.store.saveDay(day);
    const main = day.plan.find(p => p.isMainStep);
    return { ok: true, date: d, plan: day.plan, warnings, speak: `Plan for ${d} saved (${day.plan.length} items). Main step: ${main ? `"${main.title}" [${main.id}]` : 'none (mode off)'}. ${warnings.join(' ')}` };
  }

  async completeItem(itemId: string, date?: string) {
    const d = date ?? await this.today(); this.assertDate(d);
    const day = await this.store.getDay(d);
    const item = day?.plan.find(p => p.id === itemId);
    if (!day || !item) throw new AimError(`plan item "${itemId}" not found on ${d}`);
    item.done = true; item.doneAt = new Date().toISOString();
    await this.store.saveDay(day);
    let stepNote = '';
    if (item.stepId) { const r = await this.updateStep(item.stepId, { status: 'done' }); stepNote = ` Path step done: "${r.step?.title}".`; }
    return { ok: true, item, speak: `${item.isMainStep ? 'Main step' : 'Item'} done: "${item.title}".${stepNote}` };
  }

  async getPlanningContext(date?: string) {
    const d = date ?? addDays(await this.today(), 1); this.assertDate(d);
    const goal = await this.getGoal();
    const next = await this.nextSteps(6);
    const yesterday = addDays(d, -1);
    const ySum = await this.daySummary(yesterday);
    const yDay = await this.store.getDay(yesterday);
    const undone = (yDay?.plan ?? []).filter(p => !p.done);
    const week = await this.weekSummary(addDays(d, -1));
    const daysSinceHard = await this.daysSinceHardLever(d);
    const existing = await this.store.getDay(d);
    const commitments = await this.commitmentsFor(d);
    const cap = await this.capacity();
    const committedToday = commitments.reduce((sum, c) => sum + c.minutes, 0);
    const windowMinutes = await this.windowMinutesFor(d);
    return {
      date: d, commitments, committed_minutes_that_day: committedToday, focus_window_minutes: windowMinutes, capacity: cap, goal: goal.goal ? { title: goal.goal.title, metric: goal.goal.metric, current: goal.current_value, target: goal.goal.target, days_left: goal.days_left, levers: goal.goal.levers, projects: goal.goal.projects } : null,
      milestone: next.milestone ?? null, next_steps: next.steps,
      yesterday: { date: yesterday, main_step_done: ySum.main_step.done, goal_attention_min: ySum.goal_attention_min, by_area: ySum.by_area, undone_items: undone },
      week: { main_step_days: week.main_step_days, goal_share: week.goal_share, hard_share: week.hard_share, by_area: week.by_area },
      days_since_hard_lever: daysSinceHard, existing_plan: existing?.plan ?? [],
      speak: `Planning ${d}. ${windowMinutes === 0 ? 'NO focus window that day: do not plan goal work, and do not ask for a main step. ' : `Focus window: ${Math.round(windowMinutes / 6) / 10} h. `}Fixed that day: ${commitments.length ? commitments.map(c => `${c.title} ${c.minutes}min${c.usableForWork ? ' (usable)' : ''}`).join(', ') : 'nothing recorded'} = ${Math.round(committedToday / 6) / 10} h. ${goal.speak} Days since a hard lever: ${daysSinceHard ?? 'never'}. Yesterday main step ${ySum.main_step.done ? 'done' : 'NOT done'}${undone.length ? `, ${undone.length} items left undone` : ''}. Pick the main step from next_steps (hard first), then fit paid work, family, workout.`,
    };
  }

  private async daysSinceHardLever(before: string): Promise<number | null> {
    const tz = await this.tz();
    const from = startOfDay(addDays(before, -30), tz).toISOString();
    const to = startOfDay(before, tz).toISOString();
    const sessions = (await this.store.getSessionsOverlapping(from, to)).filter(s => s.classification === 'goal_hard' || s.classification === 'main_step');
    if (!sessions.length) return null;
    const last = sessions.map(s => localDate(new Date(s.start), tz)).sort().pop()!;
    return daysBetween(last, before);
  }

  // ---------- blocks ----------
  private async ensureBlock(minutes: number | undefined, workplace: Workplace, direction: Direction = 'up'): Promise<{ block: Block; joined: boolean }> {
    const running = await this.store.getRunningBlock();
    if (running) return { block: running, joined: true };
    const prof = await this.profile();
    const mins = minutes ?? prof.pomodoro.workMin;
    const start = new Date();
    const block: Block = {
      id: newId(), start: start.toISOString(), direction, kind: 'work', minutes: mins, workplace,
      endsAt: direction === 'down' ? new Date(start.getTime() + mins * 60000).toISOString() : undefined,
      ended: false, cancelled: false,
    };
    await this.store.saveBlock(block);
    const base = { uid: this.store.uid, blockId: block.id, workplace, minutes: mins, breakMin: prof.pomodoro.breakMin };
    if (direction === 'down' && block.endsAt) {
      await this.store.savePending({ id: `${block.id}-end`, ...base, dueAt: block.endsAt, kind: 'block_end' });
      if (prof.pomodoro.standup) {
        await this.store.savePending({ id: `${block.id}-break`, ...base, dueAt: new Date(new Date(block.endsAt).getTime() + prof.pomodoro.breakMin * 60000).toISOString(), kind: 'break_end' });
      }
    } else if (prof.pomodoro.standup) {
      // One stand-up at a time; the next is queued when this one fires.
      await this.store.savePending({ id: `${block.id}-standup-0`, ...base, dueAt: new Date(start.getTime() + mins * 60000).toISOString(), kind: 'standup' });
    }
    return { block, joined: false };
  }

  private blockView(b: Block | null) {
    if (!b) return null;
    const now = new Date();
    return {
      id: b.id, kind: b.kind, direction: b.direction ?? 'down', workplace: b.workplace,
      started_at: b.start,
      elapsed_min: minutesBetween(new Date(b.start), now),
      ends_at: b.endsAt ?? null,
      minutes_left: b.endsAt ? minutesBetween(now, new Date(b.endsAt)) : null,
    };
  }
  async endBlock(cancel = false) {
    const b = await this.store.getRunningBlock();
    if (!b) return { ok: false, speak: 'No block is running.' };
    if (cancel) b.cancelled = true; else b.ended = true;
    await this.store.saveBlock(b);
    await this.store.clearPendings(b.id);
    // A session only counts while the timer runs, so stopping the timer closes them all.
    // Otherwise they stay open overnight and split today's attention with yesterday's work.
    const now = new Date().toISOString();
    const closed = await this.store.getRunningSessions();
    for (const s of closed) { s.end = now; s.outcome = 'partial'; s.summary ??= 'Closed when the timer stopped.'; await this.store.saveSession(s); }
    const closedNote = closed.length ? ` Closed ${closed.map(s => `"${s.task}"`).join(', ')}.` : '';
    const prof = await this.profile();
    const { start, end } = await this.dayWindow(await this.today());
    const blocksToday = (await this.store.getBlocksInRange(start.toISOString(), end.toISOString())).filter(x => x.kind === 'work' && !x.cancelled).length;
    const long = blocksToday % prof.pomodoro.longBreakEvery === 0;
    return { ok: true, blocks_today: blocksToday, next_break_min: long ? prof.pomodoro.longBreakMin : prof.pomodoro.breakMin, closed_sessions: closed.map(s => s.id), speak: (cancel ? 'Block cancelled.' : `Block ${blocksToday} done. Stand up and walk for ${long ? prof.pomodoro.longBreakMin : prof.pomodoro.breakMin} minutes.`) + closedNote };
  }

  // ---------- sessions ----------
  private async runningForConnection(sessionId?: string): Promise<Session> {
    if (sessionId) { const s = await this.store.getSession(sessionId); if (!s) throw new AimError(`session "${sessionId}" not found`); return s; }
    const running = await this.store.getRunningSessions();
    const mine = running.filter(s => s.clientSessionId === this.clientSessionId);
    if (mine.length === 1) return mine[0];
    if (mine.length === 0 && running.length === 1) return running[0];
    if (running.length === 0) throw new AimError('No running session.');
    throw new AimError(`Several sessions are running; pass session_id. Running: ${running.map(s => `[${s.id}] ${s.task}`).join('; ')}`);
  }

  private async sessionView(s: Session) {
    const start = new Date(s.start), end = s.end ? new Date(s.end) : new Date();
    const others = await this.store.getSessionsOverlapping(s.start, end.toISOString());
    const att = computeAttention(others.some(o => o.id === s.id) ? others : [...others, s], start, end);
    return { id: s.id, task: s.task, area: s.area, classification: s.classification, lever_id: s.leverId, project_id: s.projectId, start: s.start, end: s.end, wall_min: round(att.wall.get(s.id) ?? 0), attention_min: round(s.attentionShareOverride !== undefined ? (att.wall.get(s.id) ?? 0) * s.attentionShareOverride : att.attention.get(s.id) ?? 0), weight: s.weight, notes: s.notes, override: s.override ?? false, summary: s.summary, outcome: s.outcome };
  }

  private async runningView() {
    const running = await this.store.getRunningSessions();
    const total = running.reduce((s, x) => s + (x.weight || 1), 0) || 1;
    return running.map(s => ({ id: s.id, task: s.task, classification: s.classification, started: s.start, share: Math.round(((s.weight || 1) / total) * 100) / 100, mine: s.clientSessionId === this.clientSessionId }));
  }

  async startFocus(input: SessionInput & { minutes?: number }) {
    const prof = await this.profile();
    const today = await this.today();
    const day = await this.store.getOrCreateDay(today, prof.defaultMode);
    const goal = await this.store.getGoal();
    const area = input.area ?? 'work';
    const cls = classify({ area, projectId: input.projectId, leverId: input.leverId, stepId: input.stepId, itemId: input.itemId, task: input.task }, goal, day);
    const verdict = decideVerdict(cls.classification, day, goal, !!input.override, (await this.windowMinutesFor(today)) > 0);
    const workplace = input.workplace ?? this.clientWorkplace ?? prof.defaultWorkplace;

    if (verdict.verdict === 'stop') {
      day.stopIssuedAt = new Date().toISOString(); await this.store.saveDay(day);
      return { verdict: verdict.verdict, message: verdict.message, classification: cls.classification, session: null, block: this.blockView(await this.store.getRunningBlock()), speak: verdict.message };
    }
    const { block, joined } = await this.ensureBlock(input.minutes, workplace, input.direction ?? 'up');
    if (day.mode === 'off') return { verdict: 'ok', message: verdict.message, session: null, block: { ...this.blockView(block), joined }, notify_via: 'hook', speak: `Timer ${joined ? 'joined' : 'started'}. Nothing stored (mode off).` };

    const mainItem = day.plan.find(p => p.isMainStep);
    const session: Session = {
      id: newId(), start: new Date().toISOString(), source: 'agent', clientSessionId: this.clientSessionId, weight: input.weight ?? 1, exclusive: input.exclusive, workplace,
      area, projectId: cls.projectId ?? input.projectId, leverId: cls.leverId ?? input.leverId, stepId: input.stepId ?? (cls.classification === 'main_step' ? mainItem?.stepId : undefined), itemId: input.itemId ?? (cls.classification === 'main_step' ? mainItem?.id : undefined),
      task: input.task.trim(), notes: [], classification: cls.classification, unclassified: cls.unclassified, verdictAtStart: verdict.verdict, override: !!input.override && verdict.note === 'override',
    };
    await this.store.saveSession(session);
    const running = await this.runningView();
    const devices = await this.store.getDevices();
    const reachable = devices.filter(d => (workplace === 'desktop' ? ['macos', 'web'] : ['ios', 'android']).includes(d.platform));
    const notifyVia = joined ? 'the reminder already set for this block' : devices.length ? `push to ${(reachable.length ? reachable : devices).map(d => d.platform).join(', ')}` : 'no registered device: local hook only';
    return {
      verdict: verdict.verdict, message: verdict.message, note: verdict.note, classification: cls.classification, matched_by: cls.matchedBy, unclassified: cls.unclassified,
      session: { id: session.id, task: session.task, area, lever_id: session.leverId, project_id: session.projectId, step_id: session.stepId, item_id: session.itemId, weight: session.weight },
      block: { ...this.blockView(block), joined }, running_sessions: running, notify_via: notifyVia,
      speak: `${verdict.message} Session [${session.id}] "${session.task}" → ${cls.classification}${cls.unclassified ? ' (unclassified: tell me the lever or project)' : ''}. Timer ${joined ? 'joined' : 'started'}${running.length > 1 ? `; ${running.length} sessions share attention` : ''}.`,
    };
  }

  async splitAttention(shares: Record<string, number>) {
    const running = await this.store.getRunningSessions();
    const changed: string[] = [];
    for (const s of running) if (shares[s.id] !== undefined) { s.weight = Math.max(0, shares[s.id]); await this.store.saveSession(s); changed.push(s.id); }
    if (!changed.length) throw new AimError(`No running session matched. Running: ${running.map(s => s.id).join(', ') || 'none'}`);
    const view = await this.runningView();
    return { ok: true, running_sessions: view, applies_to: 'whole session (retroactive)', speak: `Attention: ${view.map(v => `${Math.round(v.share * 100)}% ${v.task}`).join(', ')}.` };
  }

  async heartbeat(note: string, sessionId?: string) {
    const s = await this.runningForConnection(sessionId);
    s.notes.push(`${localTime(new Date(), await this.tz())} ${note.trim()}`);
    if (s.unclassified) {
      const goal = await this.store.getGoal(); const day = await this.store.getDay(await this.today());
      const cls = classify({ area: s.area, task: `${s.task} ${note}` }, goal, day);
      if (!cls.unclassified) { s.classification = cls.classification; s.leverId = cls.leverId ?? s.leverId; s.projectId = cls.projectId ?? s.projectId; s.unclassified = false; }
    }
    await this.store.saveSession(s);
    return { ok: true, session_id: s.id, classification: s.classification, speak: `Noted on [${s.id}].` };
  }

  async endFocus(summary: string, outcome: 'done' | 'partial' | 'abandoned', sessionId?: string, attentionShare?: number) {
    const s = await this.runningForConnection(sessionId);
    s.end = new Date().toISOString(); s.summary = summary.trim(); s.outcome = outcome;
    if (attentionShare !== undefined) s.attentionShareOverride = Math.min(1, Math.max(0, attentionShare));
    await this.store.saveSession(s);
    let extra = '';
    if (outcome === 'done' && s.itemId) { const day = await this.store.getDay(await this.today()); const item = day?.plan.find(p => p.id === s.itemId); if (item && !item.done) { const r = await this.completeItem(s.itemId); extra = ' ' + r.speak; } }
    else if (outcome === 'done' && s.stepId) { const r = await this.updateStep(s.stepId, { status: 'done' }); extra = ` Path step done: "${r.step?.title}".`; }
    const view = await this.sessionView(s);
    const block = await this.store.getRunningBlock();
    return { ok: true, session: view, block: this.blockView(block), speak: `Ended [${s.id}] "${s.task}": ${view.wall_min} min wall, ${view.attention_min} min attention, ${outcome}.${extra}${block ? ` Timer still running, ${this.blockView(block)?.minutes_left} min left.` : ''}` };
  }

  async cancelFocus(sessionId?: string) {
    const s = await this.runningForConnection(sessionId);
    await this.store.deleteSession(s.id);
    return { ok: true, speak: `Session [${s.id}] "${s.task}" discarded.` };
  }

  async logSession(input: SessionInput & { minutes?: number; start?: string; end?: string; date?: string }) {
    const tz = await this.tz();
    const prof = await this.profile();
    let start: Date, end: Date;
    if (input.start && input.end) {
      const d = input.date ?? await this.today(); this.assertDate(d);
      start = parseLocal(d, input.start, tz); end = parseLocal(d, input.end, tz);
      if (end <= start) throw new AimError('end must be after start');
    } else if (input.minutes) { end = input.end ? parseLocal(input.date ?? await this.today(), input.end, tz) : new Date(); start = new Date(end.getTime() - input.minutes * 60000); }
    else throw new AimError('give minutes, or start and end as HH:MM');
    const date = localDate(start, tz);
    const day = await this.store.getOrCreateDay(date, prof.defaultMode);
    if (day.mode === 'off') return { ok: false, speak: `Mode is off for ${date}; nothing stored. Use set_mode to turn tracking on for that day.` };
    const goal = await this.store.getGoal();
    const area = input.area ?? 'work';
    const cls = classify({ area, projectId: input.projectId, leverId: input.leverId, stepId: input.stepId, itemId: input.itemId, task: input.task }, goal, day);
    const v = decideVerdict(cls.classification, day, goal, true, (await this.windowMinutesFor(date)) > 0);
    const session: Session = {
      id: newId(), start: start.toISOString(), end: end.toISOString(), source: 'manual', clientSessionId: this.clientSessionId, weight: input.weight ?? 1, exclusive: input.exclusive, workplace: input.workplace ?? prof.defaultWorkplace,
      area, projectId: cls.projectId ?? input.projectId, leverId: cls.leverId ?? input.leverId, stepId: input.stepId, itemId: input.itemId, task: input.task.trim(), notes: [], classification: cls.classification, unclassified: cls.unclassified, verdictAtStart: v.verdict, outcome: 'done',
    };
    await this.store.saveSession(session);
    const view = await this.sessionView(session);
    return { ok: true, session: view, classification: cls.classification, matched_by: cls.matchedBy, speak: `Logged [${session.id}] "${session.task}" ${localTime(start, tz)}–${localTime(end, tz)} on ${date}: ${view.wall_min} min wall, ${view.attention_min} min attention → ${cls.classification}${cls.unclassified ? ' (unclassified)' : ''}.` };
  }

  async getCurrent() {
    const running = await this.runningView();
    const block = await this.store.getRunningBlock();
    const today = await this.today();
    const day = await this.store.getDay(today);
    const main = day?.plan.find(p => p.isMainStep);
    return { running_sessions: running, block: this.blockView(block), mode: day?.mode ?? 'full', main_step: main ? { id: main.id, title: main.title, done: main.done } : null, speak: `${running.length ? `Running: ${running.map(r => `[${r.id}] ${r.task} (${Math.round(r.share * 100)}%)`).join(', ')}.` : 'Nothing running.'} ${block ? `Timer: ${this.blockView(block)?.minutes_left} min left.` : 'No timer.'} ${main ? `Main step today: "${main.title}" ${main.done ? 'done' : 'pending'}.` : 'No main step planned today.'}` };
  }

  async getGaps(date?: string) {
    const d = date ?? await this.today(); this.assertDate(d);
    const { start, end } = await this.dayWindow(d);
    const sessions = await this.store.getSessionsOverlapping(start.toISOString(), end.toISOString());
    const tz = await this.tz();
    const gaps = findGaps(sessions, start, end).map(g => ({ ...g, from: localTime(new Date(g.start), tz), to: localTime(new Date(g.end), tz) }));
    return { date: d, gaps, speak: gaps.length ? `Untracked on ${d}: ${gaps.map(g => `${g.from}–${g.to} (${g.minutes} min)`).join(', ')}. What happened there? Log it with log_session or leave it.` : `No gaps of 20+ minutes on ${d}.` };
  }

  // ---------- review ----------
  async daySummary(date?: string) {
    const d = date ?? await this.today(); this.assertDate(d);
    const tz = await this.tz();
    const { start, end } = await this.dayWindow(d);
    const sessions = await this.store.getSessionsOverlapping(start.toISOString(), end.toISOString());
    const att = computeAttention(sessions, start, end);
    const goal = await this.store.getGoal();
    const day = await this.store.getDay(d);
    const byArea: Record<string, { wall_min: number; attention_min: number }> = {};
    const byClass: Record<string, { wall_min: number; attention_min: number }> = {};
    const byLever: Record<string, { wall_min: number; attention_min: number; kind?: string }> = {};
    const add = (m: Record<string, { wall_min: number; attention_min: number }>, k: string, s: Session) => { const e = (m[k] ??= { wall_min: 0, attention_min: 0 }); e.wall_min += att.wall.get(s.id) ?? 0; e.attention_min += s.attentionShareOverride !== undefined ? (att.wall.get(s.id) ?? 0) * s.attentionShareOverride : att.attention.get(s.id) ?? 0; };
    for (const s of sessions) { add(byArea, s.area, s); add(byClass, s.classification, s); if (s.leverId) { add(byLever, s.leverId, s); byLever[s.leverId].kind = goal?.levers.find(l => l.id === s.leverId)?.kind; } }
    const r = (m: Record<string, { wall_min: number; attention_min: number }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, wall_min: round(v.wall_min), attention_min: round(v.attention_min) }]));
    const goalAtt = ['main_step', 'goal_hard', 'goal_comfortable'].reduce((s, k) => s + (byClass[k]?.attention_min ?? 0), 0);
    const hardAtt = ['main_step', 'goal_hard'].reduce((s, k) => s + (byClass[k]?.attention_min ?? 0), 0);
    const workAtt = byArea['work']?.attention_min ?? 0;
    const totalAtt = Object.values(byArea).reduce((s, v) => s + v.attention_min, 0);
    const main = day?.plan.find(p => p.isMainStep);
    const hardTouched = sessions.some(s => (s.classification === 'goal_hard' || (s.classification === 'main_step' && goal?.levers.find(l => l.id === s.leverId)?.kind === 'hard')) && (att.attention.get(s.id) ?? 0) >= 10);
    const overrides = sessions.filter(s => s.override).length;
    const list = sessions.sort((a, b) => a.start.localeCompare(b.start)).map(s => ({ id: s.id, from: localTime(new Date(s.start), tz), to: s.end ? localTime(new Date(s.end), tz) : 'running', task: s.task, area: s.area, classification: s.classification, lever_id: s.leverId, wall_min: round(att.wall.get(s.id) ?? 0), attention_min: round(s.attentionShareOverride !== undefined ? (att.wall.get(s.id) ?? 0) * s.attentionShareOverride : att.attention.get(s.id) ?? 0), override: s.override ?? false, outcome: s.outcome, summary: s.summary }));
    const gaps = findGaps(sessions, start, end).map(g => ({ from: localTime(new Date(g.start), tz), to: localTime(new Date(g.end), tz), minutes: g.minutes }));
    return {
      date: d, mode: day?.mode ?? 'full', main_step: { title: main?.title ?? null, done: !!main?.done, planned: !!main },
      total_attention_min: round(totalAtt), goal_attention_min: round(goalAtt), goal_share_of_work: workAtt ? Math.round((goalAtt / workAtt) * 100) / 100 : 0, hard_share_of_goal: goalAtt ? Math.round((hardAtt / goalAtt) * 100) / 100 : 0,
      hard_lever_touched: hardTouched, overrides, by_area: r(byArea), by_classification: r(byClass), by_lever: r(byLever), overlaps: att.overlaps.map(o => ({ from: localTime(new Date(o.start), tz), to: localTime(new Date(o.end), tz), count: o.count })), gaps, sessions: list,
      speak: `${d}: ${round(totalAtt)} min tracked, ${round(goalAtt)} min on the goal (${Math.round((workAtt ? goalAtt / workAtt : 0) * 100)}% of work), hard share ${Math.round((goalAtt ? hardAtt / goalAtt : 0) * 100)}%. Main step ${main ? (main.done ? 'done' : `NOT done ("${main.title}")`) : 'not planned'}. Hard lever ${hardTouched ? 'touched' : 'not touched'}. ${overrides ? `${overrides} override(s). ` : ''}${gaps.length ? `${gaps.length} gap(s).` : ''}`,
    };
  }

  async weekSummary(date?: string) {
    const d = date ?? await this.today(); this.assertDate(d);
    const from = weekStart(d);
    const days: Awaited<ReturnType<AimService['daySummary']>>[] = [];
    for (let i = 0; i < 7; i++) { const day = addDays(from, i); if (day > d) break; days.push(await this.daySummary(day)); }
    const sum = (f: (x: typeof days[number]) => number) => days.reduce((s, x) => s + f(x), 0);
    const byArea: Record<string, number> = {};
    for (const x of days) for (const [k, v] of Object.entries(x.by_area)) byArea[k] = (byArea[k] ?? 0) + v.attention_min;
    const goalAtt = sum(x => x.goal_attention_min), workAtt = byArea['work'] ?? 0;
    const hardAtt = sum(x => Math.round(x.goal_attention_min * x.hard_share_of_goal));
    const path = await this.getPath();
    const current = path.milestones.find(m => m.id === path.current_milestone_id);
    return {
      week_of: from, through: d, days: days.map(x => ({ date: x.date, main_step_done: x.main_step.done, goal_attention_min: x.goal_attention_min, total_attention_min: x.total_attention_min, hard_lever_touched: x.hard_lever_touched, overrides: x.overrides })),
      main_step_days: days.filter(x => x.main_step.done).length, days_counted: days.length,
      goal_share: workAtt ? Math.round((goalAtt / workAtt) * 100) / 100 : 0, hard_share: goalAtt ? Math.round((hardAtt / goalAtt) * 100) / 100 : 0,
      by_area: Object.fromEntries(Object.entries(byArea).map(([k, v]) => [k, round(v)])), overrides: sum(x => x.overrides),
      milestone: current ? { title: current.title, due: current.due, steps_done: current.steps_done, steps_total: current.steps_total, pace: current.pace } : null,
      speak: `Week of ${from}: main step done ${days.filter(x => x.main_step.done).length}/${days.length} days, goal share ${Math.round((workAtt ? goalAtt / workAtt : 0) * 100)}% of work, hard share ${Math.round((goalAtt ? hardAtt / goalAtt : 0) * 100)}%, ${sum(x => x.overrides)} overrides. ${current ? `Milestone "${current.title}": ${current.steps_done}/${current.steps_total} steps, ${current.pace}, due ${current.due}.` : ''}`,
    };
  }

  async leaks(from?: string, to?: string) {
    const today = await this.today();
    const t = to ?? today, f = from ?? addDays(t, -6); this.assertDate(f); this.assertDate(t);
    const tz = await this.tz();
    const goal = await this.store.getGoal();
    const items: { date: string; kind: string; minutes: number; detail: string }[] = [];
    for (let d = f; d <= t; d = addDays(d, 1)) {
      const s = await this.daySummary(d);
      const day = await this.store.getDay(d);
      const planned = new Set((day?.plan ?? []).map(p => p.id));
      for (const x of s.sessions) {
        if (x.classification === 'goal_comfortable' && !s.main_step.done) items.push({ date: d, kind: 'comfortable_while_main_pending', minutes: x.attention_min, detail: x.task });
        if (x.override) items.push({ date: d, kind: 'override', minutes: x.attention_min, detail: x.task });
      }
      const sessionsRaw = await this.store.getSessionsOverlapping(startOfDay(d, tz).toISOString(), endOfDay(d, tz).toISOString());
      for (const x of sessionsRaw) if (x.area === 'work' && !x.itemId && !planned.has(x.itemId ?? '')) { const v = s.sessions.find(y => y.id === x.id); if (v && v.attention_min >= 15) items.push({ date: d, kind: 'unplanned_work', minutes: v.attention_min, detail: x.task }); }
      for (const g of s.gaps) items.push({ date: d, kind: 'gap', minutes: g.minutes, detail: `${g.from}–${g.to}` });
      for (const o of s.overlaps) items.push({ date: d, kind: 'switching', minutes: 0, detail: `${o.from}–${o.to}, ${o.count} sessions at once` });
      if (s.main_step.planned && !s.main_step.done) items.push({ date: d, kind: 'main_step_missed', minutes: 0, detail: s.main_step.title ?? '' });
      if (!s.main_step.planned && s.mode !== 'off') items.push({ date: d, kind: 'no_plan', minutes: 0, detail: '' });
    }
    const totals: Record<string, { count: number; minutes: number }> = {};
    for (const i of items) { const e = (totals[i.kind] ??= { count: 0, minutes: 0 }); e.count++; e.minutes += i.minutes; }
    const hardLevers = goal?.levers.filter(l => l.kind === 'hard').map(l => l.name) ?? [];
    return { from: f, to: t, totals, items, hard_levers: hardLevers, speak: `Leaks ${f}..${t}: ${Object.entries(totals).map(([k, v]) => `${k} ×${v.count}${v.minutes ? ` (${round(v.minutes)} min)` : ''}`).join(', ') || 'none found'}.` };
  }

  async streak() {
    const today = await this.today();
    const days = await this.store.getDaysInRange(addDays(today, -90), today);
    const done = new Set(days.filter(d => d.plan.some(p => p.isMainStep && p.done)).map(d => d.date));
    const off = new Set(days.filter(d => d.mode === 'off').map(d => d.date));
    let n = 0; let cursor = done.has(today) ? today : addDays(today, -1);
    while (done.has(cursor) || off.has(cursor)) { if (done.has(cursor)) n++; cursor = addDays(cursor, -1); }
    return { streak_days: n, today_done: done.has(today), speak: `${n} consecutive day(s) with a main step done${done.has(today) ? ', including today' : ', today still pending'}.` };
  }

  async history(from?: string, to?: string, area?: Area, projectId?: string) {
    const today = await this.today();
    const t = to ?? today, f = from ?? addDays(t, -6); this.assertDate(f); this.assertDate(t);
    const tz = await this.tz();
    const sessions = (await this.store.getSessionsOverlapping(startOfDay(f, tz).toISOString(), endOfDay(t, tz).toISOString())).filter(s => (!area || s.area === area) && (!projectId || s.projectId === projectId)).sort((a, b) => a.start.localeCompare(b.start));
    return { from: f, to: t, count: sessions.length, sessions: sessions.map(s => ({ id: s.id, date: localDate(new Date(s.start), tz), from: localTime(new Date(s.start), tz), to: s.end ? localTime(new Date(s.end), tz) : 'running', task: s.task, area: s.area, classification: s.classification, lever_id: s.leverId, project_id: s.projectId, wall_min: s.end ? minutesBetween(new Date(s.start), new Date(s.end)) : null, summary: s.summary, outcome: s.outcome })), speak: `${sessions.length} sessions between ${f} and ${t}.` };
  }

  async status() {
    const s = await this.daySummary();
    const cur = await this.getCurrent();
    const st = await this.streak();
    const tz = await this.tz();
    const hour = Number(localTime(new Date(), tz).slice(0, 2));
    let nudge = '';
    const windowMin = await this.windowMinutesFor(s.date);
    if (s.mode !== 'off' && windowMin > 0) {
      if (!s.main_step.planned) nudge = 'No main step planned today. Set one with set_plan.';
      else if (!s.main_step.done && hour >= 14) nudge = `Main step still pending: "${s.main_step.title}". Do 25 minutes on it next.`;
      else if (s.main_step.done && !s.hard_lever_touched) nudge = 'Main step done. A hard lever has not been touched today.';
    } else if (windowMin === 0 && s.mode !== 'off') {
      nudge = 'No focus window today. Nothing is expected of you toward the goal.';
    }
    return { ...cur, focus_window_minutes_today: windowMin, today: { date: s.date, main_step: s.main_step, total_attention_min: s.total_attention_min, goal_attention_min: s.goal_attention_min, goal_share_of_work: s.goal_share_of_work, hard_share_of_goal: s.hard_share_of_goal, by_area: s.by_area, overrides: s.overrides }, streak_days: st.streak_days, nudge, speak: `${s.speak} ${cur.speak} Streak ${st.streak_days}. ${nudge}` };
  }
}

const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function describeWhen(c: { days: number[]; timesPerWeek?: number; start?: string }): string {
  const when = c.days.length ? c.days.map(d => DOW[d]).join('/') : `${c.timesPerWeek ?? 0}×/week`;
  return c.start ? `${when} at ${c.start}` : when;
}

function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || newId(); }

function parseLocal(date: string, hhmm: string, tz: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new AimError(`time must be HH:MM, got "${hhmm}"`);
  const start = startOfDay(date, tz);
  return new Date(start.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000);
}
