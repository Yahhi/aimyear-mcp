/**
 * One table decides what answers without a token.
 *
 * The rule: anything that only DESCRIBES the server (who it is, which tools and prompts
 * it has, the OAuth discovery documents) is public, because the same text is already
 * public in the README and on aimyear.com. Anything that reads or writes a person's
 * aim, plan, timer or history needs a sign-in, because all of it is private.
 * Anything missing from this table counts as `auth`.
 *
 * Every gate reads from here: the MCP handler (which JSON-RPC methods answer without
 * a token), the tool wrapper (a second check before any tool runs) and the HTTP
 * routes. test/access.test.ts fails when a tool or route has no entry, and when
 * docs/ACCESS.md is stale.
 */
export type Level = 'public' | 'auth' | 'admin';
export interface Entry { level: Level; why: string }

const pub = (why: string): Entry => ({ level: 'public', why });
const auth = (why: string): Entry => ({ level: 'auth', why });
const admin = (why: string): Entry => ({ level: 'admin', why });

/** JSON-RPC methods on /mcp. */
export const METHODS: Record<string, Entry> = {
  'initialize': pub('server name, version, capabilities and instructions; public in the README'),
  'notifications/initialized': pub('handshake acknowledgement, carries no data'),
  'ping': pub('liveness only'),
  'tools/list': pub('tool names, descriptions and schemas; public in the README'),
  'prompts/list': pub('prompt names and descriptions; public in the README'),
  'prompts/get': pub('fixed prompt text, the same for everyone'),
  'resources/list': pub('resource names; only the public /aim skill is listed'),
  'resources/templates/list': pub('resource templates; none are private'),
  'resources/read': pub('the /aim skill text, the same for everyone and public in the repo'),
  'tools/call': auth('every tool reads or writes one person\'s private aim, plan, timer or history'),
};

const read = auth('reads the signed-in person\'s private data');
const write = auth('changes the signed-in person\'s data');

/** Tools. Every tool acts as one person, so none is public; the entries say what each touches. */
export const TOOLS: Record<string, Entry> = {
  get_goal: read, check_goal_draft: auth('checks a draft against the rubric using the person\'s timezone'),
  set_goal: write, record_progress: write, set_levers: write, set_projects: write,
  get_path: read, set_milestones: write, set_tracks: write, edit_milestone: write, add_steps: write, edit_step: write, delete_step: write, next_steps: read,
  get_commitments: read, set_commitments: write, get_capacity: read,
  get_planning_context: read, get_plan: read, set_plan: write, get_routines: read, set_routines: write, edit_plan_item: write, delete_plan_item: write, set_day_mode: write,
  get_now: read, start_session: write, add_note: write, split_attention: write, stop_session: write, stop_timer: write,
  add_session: write, edit_session: write, delete_session: write, list_sessions: read, find_gaps: read,
  add_move: write, list_moves: read, delete_move: write,
  summarize_day: read, summarize_week: read, find_leaks: read,
  get_insights: read,
  get_settings: read, set_settings: write, add_device: write, list_devices: read, delete_device: write,
  list_agents: auth('reads which agents are connected to the person\'s account (never their tokens)'),
  delete_agent: auth('disconnects one of the person\'s own agents'),
  add_social_account: auth('stores the person\'s own WIP or Bluesky login, encrypted'),
  list_social_accounts: auth('reads which networks the person connected (never the logins)'),
  delete_social_account: auth('deletes the person\'s saved network login'),
  get_post_draft: auth('drafts a post from the person\'s private record and reads their own feed'),
  add_post: auth('posts on the person\'s own WIP or Bluesky account, at their explicit request'),
  list_wip_projects: auth('reads the person\'s own WIP projects with their saved WIP login'),
};

/** HTTP routes, "VERB /path". */
export const ROUTES: Record<string, Entry> = {
  'GET /health': pub('liveness and version'),
  'POST /mcp': auth('MCP endpoint (Bearer: OAuth access token, static token or the app\'s Firebase ID token); methods marked public in METHODS answer without a token'),
  'POST /c/:token/mcp': auth('legacy connector URL with the token in the path'),
  'GET /mcp': pub('405: the server is stateless, POST only'),
  'DELETE /mcp': pub('405: the server is stateless, POST only'),
  'GET /c/:token/mcp': pub('405: the server is stateless, POST only'),
  'DELETE /c/:token/mcp': pub('405: the server is stateless, POST only'),
  'GET /now/:token': auth('the person\'s running timer, for the menu bar app'),
  'POST /pull/:token': auth('claims the person\'s desktop reminders'),
  'POST /social/post': auth('the Post action of the evening offer: posts the person\'s day at their explicit request (Bearer token)'),
  'POST /tick/:token': admin('scheduler: delivers due reminders for everyone'),
  'POST /desktop/reminders': auth('a desktop app takes the person\'s due reminders (Bearer token)'),
  'POST /desktop/reminders/action': auth('Break or Snooze on the person\'s stand-up reminder (Bearer token)'),
  'POST /account/open-day': auth('completes the person\'s today before the app reads it: routines in the plan, Pro status mirrored (Bearer token)'),
  'GET /account/agents': auth('the agents connected to the person\'s account (Bearer token)'),
  'DELETE /account/agents/:clientId': auth('disconnects one of the person\'s agents (Bearer token)'),
  'GET /account/export': auth('everything the server keeps about the person, as JSON (Bearer token)'),
  'POST /account/delete': auth('deletes the person\'s account and data; the app\'s Firebase sign-in only, with {"confirm": true}'),
  'POST /revenuecat/webhook': admin('RevenueCat subscription events; the Authorization header must equal REVENUECAT_WEBHOOK_AUTH'),
  'GET /.well-known/oauth-authorization-server': pub('OAuth discovery (RFC 8414)'),
  'GET /.well-known/oauth-protected-resource': pub('OAuth discovery (RFC 9728)'),
  'GET /.well-known/oauth-protected-resource/mcp': pub('OAuth discovery for the /mcp resource'),
  'POST /register': pub('dynamic client registration: a client registers itself before anyone signs in'),
  'GET /authorize': pub('starts sign-in; the page signs the person in with Firebase'),
  'POST /authorize': pub('same as GET /authorize, form-encoded'),
  'POST /authorize/approve': pub('the person\'s Allow/Deny; requires a fresh Firebase ID token in the body'),
  'POST /token': pub('code and refresh-token exchange; requires the code or refresh token itself'),
  'POST /revoke': pub('token revocation; requires the token itself'),
};

export const levelOfMethod = (m: string): Level => METHODS[m]?.level ?? 'auth';
export const levelOfTool = (name: string): Level => TOOLS[name]?.level ?? 'auth';

/**
 * A JSON-RPC body is public only if EVERY message in it is a public method.
 * An unparseable, empty or non-object body is not public.
 */
export function isPublicBody(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  if (msgs.length === 0) return false;
  return msgs.every(m => !!m && typeof m === 'object' && typeof (m as any).method === 'string' && levelOfMethod((m as any).method) === 'public');
}

/** docs/ACCESS.md, generated from the tables. */
export function renderAccessDoc(): string {
  const rows = (t: Record<string, Entry>) => Object.entries(t).map(([k, e]) => `| \`${k}\` | ${e.level} | ${e.why} |`).join('\n');
  return `# Who can call what

Generated from \`src/access.ts\` by \`npm run access-doc\`. Do not edit by hand.

Rule: what only describes the server is public; everything that reads or writes a person's
aim, plan, timer or history needs a sign-in. Anything not listed needs a sign-in.

## MCP methods

| Method | Access | Why |
|---|---|---|
${rows(METHODS)}

## Tools

| Tool | Access | Why |
|---|---|---|
${rows(TOOLS)}

## HTTP routes

| Route | Access | Why |
|---|---|---|
${rows(ROUTES)}
`;
}
