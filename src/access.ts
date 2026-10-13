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
  'tools/call': auth('every tool reads or writes one person\'s private aim, plan, timer or history'),
};

const read = auth('reads the signed-in person\'s private data');
const write = auth('changes the signed-in person\'s data');

/** Tools. Every tool acts as one person, so none is public; the entries say what each touches. */
export const TOOLS: Record<string, Entry> = {
  get_goal: read, validate_goal: auth('checks a draft against the rubric using the person\'s timezone'),
  set_goal: write, update_baseline: write, set_levers: write, add_project: write,
  set_pomodoro: write, set_workplace: write,
  register_device: write, list_devices: read, forget_device: write,
  get_commitments: read, set_commitments: write, capacity: read,
  get_path: read, set_milestones: write, add_steps: write, update_step: write, next_steps: read,
  get_planning_context: read, set_plan: write, get_plan: read, complete_item: write, set_mode: write,
  start_focus: write, split_attention: write, heartbeat: write, end_focus: write, cancel_focus: write,
  end_block: write, cancel_block: write, log_session: write, get_current: read, get_gaps: read,
  status: read, day_summary: read, week_summary: read, leaks: read, streak: read, history: read,
};

/** HTTP routes, "VERB /path". */
export const ROUTES: Record<string, Entry> = {
  'GET /health': pub('liveness and version'),
  'POST /mcp': auth('MCP endpoint; methods marked public in METHODS answer without a token'),
  'POST /c/:token/mcp': auth('legacy connector URL with the token in the path'),
  'GET /mcp': pub('405: the server is stateless, POST only'),
  'DELETE /mcp': pub('405: the server is stateless, POST only'),
  'GET /c/:token/mcp': pub('405: the server is stateless, POST only'),
  'DELETE /c/:token/mcp': pub('405: the server is stateless, POST only'),
  'GET /now/:token': auth('the person\'s running timer, for the menu bar app'),
  'POST /pull/:token': auth('claims the person\'s desktop reminders'),
  'POST /tick/:token': admin('scheduler: delivers due reminders for everyone'),
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
