import { Store } from '../src/store.js';
import { AimService } from '../src/service.js';
import { addDays } from '../src/dates.js';

const uid = 'smoke-test-' + Date.now();
const svcA = new AimService(new Store(uid), 'terminal-A');
const svcB = new AimService(new Store(uid), 'terminal-B');
const say = (label: string, r: any) => console.log(`\n# ${label}\n  ${r.speak ?? JSON.stringify(r)}`);
const today = await svcA.today();

say('validate abstract', await svcA.checkGoalDraft({ title: 'Get better at marketing' }));
say('validate far', await svcA.checkGoalDraft({ title: '20 paying customers', metric: 'paying customers', baseline: 2, target: 20, deadline: addDays(today, 500) }));
say('set_goal', await svcA.setGoal({ title: 'AimYear v2 to 20 paying customers', why: 'prove people pay', metric: 'paying customers', baseline: 2, target: 20, deadline: addDays(today, 300) }));
say('milestones', await svcA.setMilestones([
  { title: 'Dogfood works', metric: 'days used', target: 14, due: addDays(today, 30) },
  { title: '5 users', metric: 'users', target: 5, due: addDays(today, 120) },
]));
const path = await svcA.getPath();
const m1 = path.milestones[0].id;
say('add_steps abstract', await svcA.addSteps(m1, [{ title: 'do marketing' }]));
say('add_steps', await svcA.addSteps(m1, [{ title: 'Email 10 people from the waitlist about v2', leverId: 'outreach', estimateMin: 50 }, { title: 'Ship start_focus with the stop rule', leverId: 'build', estimateMin: 100 }]));
say('levers no hard', await svcA.setLevers([{ name: 'build', kind: 'comfortable' }]));
say('levers', await svcA.setLevers([{ name: 'outreach', kind: 'hard', keywords: ['email', 'reddit', 'call', 'interview'] }, { name: 'build', kind: 'comfortable', keywords: ['feature', 'refactor', 'mcp', 'flutter'], repos: ['aimyear'] }]));
say('add_project', await svcA.setProjects([{ name: "Client work", area: "work", keywords: ['client', 'jira'], repos: ['clientrepo'] }]));
const next = await svcA.nextSteps();
say('next_steps', next);
const hardStep = next.steps.find(s => s.hard)!;

say('start before plan (comfortable)', await svcA.startSession({ task: 'refactor the mcp tools' }));
say('set_plan no main', await svcA.setPlan(today, [{ title: 'Client bug', area: 'work', projectId: 'client-work' }]));
say('set_plan', await svcA.setPlan(today, [{ title: hardStep.title, area: 'work', stepId: hardStep.id, isMainStep: true }, { title: 'Client bug', area: 'work', projectId: 'client-work' }, { title: 'Workout', area: 'health' }]));
say('cancel earlier', await svcA.deleteSession());

say('A: comfortable → STOP', await svcA.startSession({ task: 'add a feature to the flutter app' }));
say('A: comfortable override', await svcA.startSession({ task: 'add a feature to the flutter app', override: true }));
say('B: client work joins block', await svcB.startSession({ task: 'fix client jira bug', projectId: 'client-work' }));
say('split 70/30', await svcA.splitAttention(Object.fromEntries((await svcA.getCurrent()).running_sessions.map(r => [r.id, r.mine ? 0.7 : 0.3]))));
say('B heartbeat', await svcB.addNote('looked at logs'));
say('current', await svcA.getCurrent());
say('A end', await svcA.stopSession('feature half done', 'partial'));
say('B end', await svcB.stopSession('bug fixed', 'done'));
say('log workout', await svcA.addSession({ task: 'Workout', area: 'health', minutes: 40, start: '07:00', end: '07:40' }));
say('log main step', await svcA.addSession({ task: 'Emailed 10 people', minutes: 50, stepId: hardStep.id, itemId: (await svcA.getPlan(today)).plan[0].id }));
say('A: main step focus', await svcA.startSession({ task: 'email 5 more people', itemId: (await svcA.getPlan(today)).plan[0].id }));
say('A: end main done', await svcA.stopSession('sent', 'done'));
say('day_summary', await svcA.daySummary(today));
say('status', await svcA.getNow());
say('gaps', await svcA.getGaps(today));
say('leaks', await svcA.leaks());
say('week', await svcA.weekSummary());
say('planning ctx', await svcA.getPlanningContext());
say('path', await svcA.getPath());
say('end_block', await svcA.stopTimer());

// cleanup
const { getFirestore } = await import('firebase-admin/firestore');
await getFirestore().recursiveDelete(getFirestore().collection('users').doc(uid));
console.log('\ncleaned up', uid);
process.exit(0);
