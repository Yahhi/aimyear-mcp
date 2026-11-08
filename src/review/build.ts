/**
 * The weekly review email (docs/weekly-review.md), written by AimYear from the record with
 * no AI model: the week Monday to Sunday against the weekly target, weeks in a row, what
 * moved toward the aim, the main steps done, the hard share, the path stage and its pace,
 * and the week before for comparison. Bad weeks are said plainly, nothing is cheered.
 *
 * Two halves: gatherReview reads the record through AimService into ReviewFacts, and
 * renderReview turns facts into the subject, a plain-text and an HTML email. With the
 * tracking setting moves or quiet (docs/moves.md), no minutes and no percentages appear.
 */
import { daysTowardAim, type AimService } from '../service.js';
import { addDays, isoWeekday } from '../dates.js';

/** "What moved" shows this many items; the rest are counted. */
export const MOVED_CAP = 8;

export type Pace = 'ahead' | 'on_pace' | 'behind' | 'no_steps';
export interface MovedItem { text: string; hard: boolean; main: boolean }
export interface WeekNumbers {
  days: number; met: boolean; weeksInARow: number;
  mainStepDays: number; aimMoves: number; hardDays: number;
  /** Time tracking only: minutes on the aim and the hard share of them (0..1, null without aim time). */
  aimMinutes: number; hardShare: number | null;
}
export interface ReviewFacts extends WeekNumbers {
  /** The Monday and Sunday of the week, YYYY-MM-DD local. */
  week: string; sunday: string;
  /** tracking moves or quiet: words, moves and days only. */
  quiet: boolean;
  aim: string | null;
  target: number;
  /** Monday..Sunday. off: the day was switched off. */
  dayMarks: { date: string; toward: boolean; off: boolean }[];
  moved: MovedItem[];
  /** Items toward the aim beyond MOVED_CAP. */
  movedMore: number;
  mainSteps: string[];
  /** Days that had a main step planned. */
  mainStepPlanned: number;
  stages: { title: string; track: string | null; progress: string; pace: Pace; due: string }[];
  prev: WeekNumbers;
  /** Nothing at all in the record this week: no session, move or plan toward the aim. */
  empty: boolean;
}

type DaySummary = Awaited<ReturnType<AimService['daySummary']>>;

/** Summaries the server wrote itself, not the person: fall back to the task. */
const PLACEHOLDER = /^(auto-closed:|stood up for a break\.?$)/i;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** What moved toward the aim over the given days: deduplicated, the most meaningful first. */
export function movedFrom(days: DaySummary[], hardLevers: Set<string>, exclude: string[] = []): { items: MovedItem[]; more: number } {
  const all: (MovedItem & { score: number; order: number })[] = [];
  let order = 0;
  for (const d of days) {
    for (const s of d.sessions) {
      if (!['main_step', 'goal_hard', 'goal_comfortable'].includes(s.classification)) continue;
      const summary = s.summary?.trim();
      const text = (summary && !PLACEHOLDER.test(summary) ? summary : s.task).trim();
      if (!text) continue;
      const main = s.classification === 'main_step';
      const hard = s.classification === 'goal_hard' || (main && !!s.lever_id && hardLevers.has(s.lever_id));
      all.push({ text, hard, main, score: (main ? 4 : 0) + (hard ? 2 : 0) + (s.outcome === 'done' ? 1 : 0), order: order++ });
    }
    for (const m of d.moves) {
      if (!m.toward_aim) continue;
      const main = m.classification === 'main_step';
      all.push({ text: m.task.trim(), hard: m.hard, main, score: (main ? 4 : 0) + (m.hard ? 2 : 0) + 1, order: order++ });
    }
  }
  // Main steps first, then the hard part, then finished work; in the order it happened within each.
  all.sort((a, b) => b.score - a.score || a.order - b.order);
  const seen = new Set(exclude.map(norm));
  const items: MovedItem[] = [];
  for (const x of all) {
    const k = norm(x.text);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    items.push({ text: x.text, hard: x.hard, main: x.main });
  }
  return { items: items.slice(0, MOVED_CAP), more: Math.max(0, items.length - MOVED_CAP) };
}

function numbers(days: DaySummary[], week: { days: number; met: boolean; weeks_in_a_row: number }): WeekNumbers {
  const aim = days.reduce((s, d) => s + d.goal_attention_min, 0);
  const hard = days.reduce((s, d) => s + Math.round(d.goal_attention_min * d.hard_share_of_goal), 0);
  return {
    days: week.days, met: week.met, weeksInARow: week.weeks_in_a_row,
    mainStepDays: days.filter(d => d.main_step.done).length,
    aimMoves: days.reduce((s, d) => s + d.aim_moves, 0),
    hardDays: days.filter(d => d.hard_lever_touched).length,
    aimMinutes: aim, hardShare: aim ? hard / aim : null,
  };
}

const progressText = (m: { kind: string; current?: number | null; target: number; metric: string; steps_done: number; steps_total: number }) =>
  m.kind === 'count' ? ((m.current ?? 0) >= m.target ? `${m.current} ${m.metric}, target of ${m.target} reached` : `${m.current ?? 0} of ${m.target} ${m.metric}`) : m.steps_total ? `${m.steps_done} of ${m.steps_total} steps done` : 'no steps yet';

/** Reads one week (Monday `week` to Sunday) of the record into facts. Writes nothing. */
export async function gatherReview(svc: AimService, week: string): Promise<ReviewFacts> {
  const sunday = addDays(week, 6);
  const prevSunday = addDays(week, -1);
  const summaries = async (from: string) => { const out: DaySummary[] = []; for (let i = 0; i < 7; i++) out.push(await svc.daySummary(addDays(from, i))); return out; };
  const days = await summaries(week);
  const prevDays = await summaries(addDays(week, -7));
  const wp = await svc.weekProgress(sunday);
  const prevWp = await svc.weekProgress(prevSunday);
  const { goal } = await svc.getGoal();
  const hardLevers = new Set((goal?.levers ?? []).filter(l => l.kind === 'hard').map(l => l.id));
  const mainSteps: string[] = [];
  for (const d of days) if (d.main_step.done && d.main_step.title && !mainSteps.some(t => norm(t) === norm(d.main_step.title!))) mainSteps.push(d.main_step.title);
  const moved = movedFrom(days, hardLevers, mainSteps);
  const path = await svc.getPath();
  const current = path.tracks.length
    ? path.tracks.map(t => ({ m: path.milestones.find(m => m.id === t.current_milestone_id), track: t.title as string | null }))
    : [{ m: path.milestones.find(m => m.id === path.current_milestone_id), track: null }];
  const stages = current.filter(c => !!c.m).map(({ m, track }) => ({ title: m!.title, track, progress: progressText(m!), pace: m!.pace as Pace, due: m!.due }));
  const n = numbers(days, wp);
  const totalItems = moved.items.length + moved.more;
  return {
    week, sunday, quiet: (await svc.tracking()) !== 'time', aim: goal?.title ?? null, target: wp.target,
    dayMarks: days.map(d => ({ date: d.date, toward: wp.dates.includes(d.date), off: d.mode === 'off' })),
    moved: moved.items, movedMore: moved.more, mainSteps, mainStepPlanned: days.filter(d => d.main_step.planned).length,
    stages, ...n, prev: numbers(prevDays, prevWp),
    empty: n.days === 0 && totalItems === 0 && mainSteps.length === 0 && n.aimMoves === 0,
  };
}

// ---------------------------------------------------------------- rendering

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
/** "Nov 2 – 8" or "Oct 27 – Nov 2". */
export const weekRange = (from: string, to: string) => from.slice(5, 7) === to.slice(5, 7) ? `${md(from)} – ${Number(to.slice(8, 10))}` : `${md(from)} – ${md(to)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hm = (min: number) => { const m = Math.round(min); const h = Math.floor(m / 60); return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const PACE: Record<Pace, string> = { ahead: 'ahead of pace', on_pace: 'on pace', behind: 'behind pace', no_steps: 'no steps planned for it yet' };
const DAY_LETTER = ['', 'M', 'T', 'W', 'T', 'F', 'S', 'S'];

export interface RenderOptions { unsubscribeUrl: string; appUrl?: string }
export interface RenderedReview { subject: string; preheader: string; text: string; html: string }

/** The lines both versions say, in order. Plain strings: the HTML escapes them. */
function wording(f: ReviewFacts) {
  // The weekly target's wording is weekProgress's (daysTowardAim): never "6 of 4 days".
  const subject = `Your week toward ${f.aim ?? 'your aim'}: ${daysTowardAim(f.days, f.target, '')}`;
  const headline = f.days === 0 ? 'No days toward the aim this week.' : `${daysTowardAim(f.days, f.target)}.${f.met ? '' : ' Target not met.'}`;
  let run = '';
  if (f.met) run = f.weeksInARow > 1 ? `${f.weeksInARow} weeks in a row at the target.` : '';
  else if (f.prev.weeksInARow > 0) run = `This ends a run of ${plural(f.prev.weeksInARow, 'week')} at the target.`;
  const lastWeek = `Last week: ${daysTowardAim(f.prev.days, f.target)}.`;
  const movedTitle = 'What moved toward the aim';
  const movedEmpty = f.empty ? 'Nothing toward the aim is in the record this week: no sessions, moves or main steps.' : 'No session summaries or moves toward the aim this week.';
  const more = f.movedMore ? `And ${plural(f.movedMore, 'more item')}.` : '';
  const mainTitle = 'Main steps done';
  const mainLine = f.mainStepPlanned === 0 && f.mainSteps.length === 0
    ? 'No main step was planned this week.'
    : `${f.mainStepDays} of ${plural(f.mainStepPlanned, 'planned day')}.`;
  const rows: [string, string, string][] = [
    [`Days toward the aim (target ${f.target})`, String(f.days), String(f.prev.days)],
    ['Main steps done', String(f.mainStepDays), String(f.prev.mainStepDays)],
  ];
  if (f.aimMoves || f.prev.aimMoves) rows.push(['Moves toward the aim', String(f.aimMoves), String(f.prev.aimMoves)]);
  rows.push(['Days on the hard part', String(f.hardDays), String(f.prev.hardDays)]);
  if (!f.quiet) {
    rows.push(['Time on the aim', hm(f.aimMinutes), hm(f.prev.aimMinutes)]);
    rows.push(['Hard share of aim time', pct(f.hardShare), pct(f.prev.hardShare)]);
  }
  const pathTitle = f.stages.length > 1 ? 'The path, by track' : 'The path';
  const stageLines = f.stages.map(s => `${s.track ? `${s.track}: ` : ''}${s.title}. ${s.progress[0].toUpperCase()}${s.progress.slice(1)}, ${PACE[s.pace]}, due ${md(s.due)}.`);
  const pathEmpty = 'No open stage on the path. Set the next stages with your agent.';
  const next = `A new week starts tomorrow. The target is ${plural(f.target, 'day')} toward the aim.`;
  const preheader = [headline, run].filter(Boolean).join(' ');
  return { subject, headline, run, lastWeek, movedTitle, movedEmpty, more, mainTitle, mainLine, rows, pathTitle, stageLines, pathEmpty, next, preheader };
}

export function renderText(f: ReviewFacts, o: RenderOptions): string {
  const w = wording(f);
  const out: string[] = [`AimYear · Week of ${weekRange(f.week, f.sunday)}`, ''];
  if (f.aim) out.push(`Aim: ${f.aim}`, '');
  out.push(w.headline);
  if (w.run) out.push(w.run);
  out.push(f.dayMarks.map(d => `${DAY_LETTER[isoWeekday(d.date)]} ${d.toward ? '●' : d.off ? '–' : '○'}`).join('  '));
  out.push(w.lastWeek, '');
  out.push(w.movedTitle.toUpperCase());
  if (f.moved.length) { for (const m of f.moved) out.push(`- ${m.text}${m.hard ? ' (hard)' : ''}`); if (w.more) out.push(w.more); }
  else out.push(w.movedEmpty);
  out.push('', w.mainTitle.toUpperCase(), w.mainLine);
  for (const t of f.mainSteps) out.push(`- ${t}`);
  out.push('', w.pathTitle.toUpperCase());
  if (w.stageLines.length) out.push(...w.stageLines); else out.push(w.pathEmpty);
  out.push('', 'THIS WEEK AND LAST');
  for (const [k, a, b] of w.rows) out.push(`${k}: ${a} (last week ${b})`);
  out.push('', w.next, '', '--',
    'AimYear writes this review from your record every Sunday evening.',
    `Stop these emails: ${o.unsubscribeUrl}`,
    'Or turn off "Weekly review email" in the app, under Profile, Settings.');
  return out.join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The app's colours (aimyear-v2 lib/ui/theme.dart). Light inline, dark in a <style> for the
// clients that honour prefers-color-scheme (Apple Mail, iOS); Gmail applies its own dark mode
// to these light colours, which keeps the contrast.
const C = { bg: '#F2F3F7', card: '#FFFFFF', ink: '#141828', ink2: '#5A6173', ink3: '#81889B', rule: '#E4E6EE', acc: '#0E7A52', dot: '#2FB089', empty: '#E4E6EE', hard: '#6A2CA6', hardBg: '#F1E9F8' };
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

export function renderHtml(f: ReviewFacts, o: RenderOptions): string {
  const w = wording(f);
  const h2 = (t: string) => `<tr><td class="ink2" style="padding:24px 28px 8px;font:600 12px/16px ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${C.ink2};">${esc(t)}</td></tr>`;
  const p = (t: string, extra = '') => `<tr><td class="ink" style="padding:0 28px 6px;font:400 15px/22px ${FONT};color:${C.ink};${extra}">${esc(t)}</td></tr>`;
  const tag = `<span class="tag" style="display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;background:${C.hardBg};color:${C.hard};font:600 11px/18px ${FONT};vertical-align:1px;">hard</span>`;
  const list = (items: { text: string; hard?: boolean }[]) => `<tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${items.map(i =>
    `<tr><td width="16" valign="top" class="acc" style="font:700 15px/22px ${FONT};color:${C.acc};">·</td><td class="ink" style="padding:0 0 6px;font:400 15px/22px ${FONT};color:${C.ink};">${esc(i.text)}${i.hard ? tag : ''}</td></tr>`).join('')}</table></td></tr>`;
  const dots = f.dayMarks.map(d => {
    const bg = d.toward ? C.dot : C.empty;
    const mark = d.toward ? '&#10003;' : d.off ? '&ndash;' : '&nbsp;';
    return `<td align="center" style="padding:0 3px;"><div class="ink3" style="font:600 11px/14px ${FONT};color:${C.ink3};padding-bottom:4px;">${DAY_LETTER[isoWeekday(d.date)]}</div><div class="${d.toward ? 'dot' : 'nodot'}" style="width:30px;height:30px;border-radius:15px;background:${bg};color:#FFFFFF;font:700 14px/30px ${FONT};text-align:center;">${mark}</div></td>`;
  }).join('');
  const rows = w.rows.map(([k, a, b]) => `<tr><td class="ink rule" style="padding:8px 0;border-top:1px solid ${C.rule};font:400 14px/20px ${FONT};color:${C.ink};">${esc(k)}</td><td class="ink rule" align="right" style="padding:8px 0 8px 12px;border-top:1px solid ${C.rule};font:600 14px/20px ${FONT};color:${C.ink};white-space:nowrap;">${esc(a)}</td><td class="ink2 rule" align="right" style="padding:8px 0 8px 12px;border-top:1px solid ${C.rule};font:400 14px/20px ${FONT};color:${C.ink2};white-space:nowrap;">${esc(b)}</td></tr>`).join('');
  const body = [
    `<tr><td class="ink2" style="padding:24px 28px 0;font:600 13px/18px ${FONT};color:${C.ink2};">AimYear &middot; Week of ${esc(weekRange(f.week, f.sunday))}</td></tr>`,
    f.aim ? `<tr><td class="ink2" style="padding:4px 28px 0;font:400 14px/20px ${FONT};color:${C.ink2};">${esc(f.aim)}</td></tr>` : '',
    `<tr><td class="ink" style="padding:14px 28px 4px;font:700 22px/28px ${FONT};color:${C.ink};">${esc(w.headline)}</td></tr>`,
    w.run ? p(w.run, `color:${C.ink2};`) : '',
    `<tr><td style="padding:14px 25px 6px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>${dots}</tr></table></td></tr>`,
    p(w.lastWeek, `color:${C.ink2};font-size:14px;`),
    h2(w.movedTitle),
    f.moved.length ? list(f.moved) + (w.more ? p(w.more, `color:${C.ink2};font-size:14px;`) : '') : p(w.movedEmpty),
    h2(w.mainTitle),
    p(w.mainLine),
    f.mainSteps.length ? list(f.mainSteps.map(t => ({ text: t }))) : '',
    h2(w.pathTitle),
    ...(w.stageLines.length ? w.stageLines.map(l => p(l)) : [p(w.pathEmpty)]),
    h2('This week and last'),
    `<tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td></td><td class="ink3" align="right" style="padding:0 0 4px 12px;font:600 11px/14px ${FONT};color:${C.ink3};">THIS WEEK</td><td class="ink3" align="right" style="padding:0 0 4px 12px;font:600 11px/14px ${FONT};color:${C.ink3};">LAST</td></tr>${rows}</table></td></tr>`,
    `<tr><td class="ink" style="padding:22px 28px 26px;font:400 15px/22px ${FONT};color:${C.ink};">${esc(w.next)}</td></tr>`,
  ].join('\n');
  const foot = `<p class="ink3" style="margin:0;font:400 12px/18px ${FONT};color:${C.ink3};">AimYear writes this review from your record every Sunday evening.<br><a class="acc" href="${esc(o.unsubscribeUrl)}" style="color:${C.ink2};text-decoration:underline;">Stop these emails</a> &middot; or turn off &ldquo;Weekly review email&rdquo; in the app, under Profile, Settings.${o.appUrl ? `<br><a href="${esc(o.appUrl)}" style="color:${C.ink2};text-decoration:underline;">aimyear.com</a>` : ''}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(w.subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .bg { background:#0B0E1A !important; } .card { background:#151A2B !important; }
  .ink { color:#E6EAF5 !important; } .ink2 { color:#A8AEC4 !important; } .ink3 { color:#8A91AA !important; }
  .rule { border-color:#262C40 !important; } .acc { color:#3FC79B !important; }
  .nodot { background:#262C40 !important; } .tag { background:#2E2140 !important; color:#CDA2EA !important; }
}
</style></head>
<body class="bg" style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(w.preheader)}</div>
<table role="presentation" class="bg" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="card" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:${C.card};border-radius:14px;">
${body}
</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;"><tr><td style="padding:16px 28px;">${foot}</td></tr></table>
</td></tr></table>
</body></html>`;
}

export function renderReview(f: ReviewFacts, o: RenderOptions): RenderedReview {
  const w = wording(f);
  return { subject: w.subject, preheader: w.preheader, text: renderText(f, o), html: renderHtml(f, o) };
}
