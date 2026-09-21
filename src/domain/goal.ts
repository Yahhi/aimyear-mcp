import { daysBetween, isValidDate, localDate } from '../dates.js';

export interface GoalDraft { title?: string; why?: string; metric?: string; baseline?: number; target?: number; deadline?: string }
export interface GoalCheck { problems: string[]; next_question: string | null; pace_per_week: number | null; weeks_left: number | null }

const ABSTRACT = /\b(better|improve|improving|more|less|grow|growing|learn|learning|be good|get good|become|master)\b/i;

/** The rubric: countable, baseline, near, achievable. Same checks in the skill, the app and the server. */
export function checkGoal(d: GoalDraft, tz: string, now = new Date()): GoalCheck {
  const problems: string[] = [];
  const questions: string[] = [];
  const today = localDate(now, tz);

  if (!d.title || d.title.trim().length < 5) { problems.push('title missing'); questions.push('What is the goal, in one sentence?'); }
  else if (ABSTRACT.test(d.title) && !/\d/.test(d.title)) {
    problems.push(`title is abstract ("${d.title.match(ABSTRACT)?.[0]}" without a number)`);
    questions.push('What number will be different in a year? Give the unit and where you will read it (revenue, paying customers, published posts, subscribers, kg, km).');
  }
  if (!d.metric || d.metric.trim().length < 2) { problems.push('metric missing'); questions.push('What is the one number you will measure, and in what unit?'); }
  if (d.baseline === undefined || d.baseline === null || Number.isNaN(d.baseline)) { problems.push('baseline missing'); questions.push('Where is that number today?'); }
  if (d.target === undefined || d.target === null || Number.isNaN(d.target)) { problems.push('target missing'); questions.push('What should the number be at the deadline?'); }
  if (d.baseline !== undefined && d.target !== undefined && d.baseline === d.target) { problems.push('target equals baseline'); questions.push('The target must differ from today. What is the target?'); }

  let weeksLeft: number | null = null;
  if (!d.deadline) { problems.push('deadline missing'); questions.push('By which date? Within 12 months.'); }
  else if (!isValidDate(d.deadline)) { problems.push('deadline is not YYYY-MM-DD'); questions.push('Give the deadline as YYYY-MM-DD.'); }
  else {
    const days = daysBetween(today, d.deadline);
    if (days <= 0) { problems.push('deadline is in the past'); questions.push('Pick a deadline in the future, within 12 months.'); }
    else if (days > 366) { problems.push(`deadline is ${days} days away; the horizon is 12 months`); questions.push('That is further than a year. What is the 12-month slice of this goal?'); }
    else weeksLeft = Math.max(1, Math.round(days / 7));
  }

  let pace: number | null = null;
  if (weeksLeft && d.baseline !== undefined && d.target !== undefined && d.target !== d.baseline) pace = (d.target - d.baseline) / weeksLeft;

  return { problems, next_question: questions[0] ?? null, pace_per_week: pace === null ? null : Math.round(pace * 100) / 100, weeks_left: weeksLeft };
}

/** Steps must be concrete actions: a verb, some length, no abstractions. */
const VAGUE_VERB = /^(do|work on|think about|look into|focus on|deal with|handle|continue|progress on|start)\b/i;
export function checkStepTitle(title: string): string | null {
  const t = title.trim();
  if (t.length < 8) return `step "${t}" is too short to be a concrete action`;
  if (VAGUE_VERB.test(t) && !/\d/.test(t)) return `step "${t}" starts with a vague verb; name the concrete action and its result (e.g. "email 10 people", "publish 1 post")`;
  if (ABSTRACT.test(t) && !/\d/.test(t)) return `step "${t}" is abstract ("${t.match(ABSTRACT)?.[0]}"); say what you will actually do, with a number if possible`;
  return null;
}
