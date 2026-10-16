# Who can call what

Generated from `src/access.ts` by `npm run access-doc`. Do not edit by hand.

Rule: what only describes the server is public; everything that reads or writes a person's
aim, plan, timer or history needs a sign-in. Anything not listed needs a sign-in.

## MCP methods

| Method | Access | Why |
|---|---|---|
| `initialize` | public | server name, version, capabilities and instructions; public in the README |
| `notifications/initialized` | public | handshake acknowledgement, carries no data |
| `ping` | public | liveness only |
| `tools/list` | public | tool names, descriptions and schemas; public in the README |
| `prompts/list` | public | prompt names and descriptions; public in the README |
| `prompts/get` | public | fixed prompt text, the same for everyone |
| `tools/call` | auth | every tool reads or writes one person's private aim, plan, timer or history |

## Tools

| Tool | Access | Why |
|---|---|---|
| `get_goal` | auth | reads the signed-in person's private data |
| `check_goal_draft` | auth | checks a draft against the rubric using the person's timezone |
| `set_goal` | auth | changes the signed-in person's data |
| `record_progress` | auth | changes the signed-in person's data |
| `set_levers` | auth | changes the signed-in person's data |
| `set_projects` | auth | changes the signed-in person's data |
| `get_path` | auth | reads the signed-in person's private data |
| `set_milestones` | auth | changes the signed-in person's data |
| `edit_milestone` | auth | changes the signed-in person's data |
| `add_steps` | auth | changes the signed-in person's data |
| `edit_step` | auth | changes the signed-in person's data |
| `delete_step` | auth | changes the signed-in person's data |
| `next_steps` | auth | reads the signed-in person's private data |
| `get_commitments` | auth | reads the signed-in person's private data |
| `set_commitments` | auth | changes the signed-in person's data |
| `get_capacity` | auth | reads the signed-in person's private data |
| `get_planning_context` | auth | reads the signed-in person's private data |
| `get_plan` | auth | reads the signed-in person's private data |
| `set_plan` | auth | changes the signed-in person's data |
| `get_routines` | auth | reads the signed-in person's private data |
| `set_routines` | auth | changes the signed-in person's data |
| `edit_plan_item` | auth | changes the signed-in person's data |
| `delete_plan_item` | auth | changes the signed-in person's data |
| `set_day_mode` | auth | changes the signed-in person's data |
| `get_now` | auth | reads the signed-in person's private data |
| `start_session` | auth | changes the signed-in person's data |
| `add_note` | auth | changes the signed-in person's data |
| `split_attention` | auth | changes the signed-in person's data |
| `stop_session` | auth | changes the signed-in person's data |
| `stop_timer` | auth | changes the signed-in person's data |
| `add_session` | auth | changes the signed-in person's data |
| `edit_session` | auth | changes the signed-in person's data |
| `delete_session` | auth | changes the signed-in person's data |
| `list_sessions` | auth | reads the signed-in person's private data |
| `find_gaps` | auth | reads the signed-in person's private data |
| `summarize_day` | auth | reads the signed-in person's private data |
| `summarize_week` | auth | reads the signed-in person's private data |
| `find_leaks` | auth | reads the signed-in person's private data |
| `get_settings` | auth | reads the signed-in person's private data |
| `set_settings` | auth | changes the signed-in person's data |
| `add_device` | auth | changes the signed-in person's data |
| `list_devices` | auth | reads the signed-in person's private data |
| `delete_device` | auth | changes the signed-in person's data |

## HTTP routes

| Route | Access | Why |
|---|---|---|
| `GET /health` | public | liveness and version |
| `POST /mcp` | auth | MCP endpoint; methods marked public in METHODS answer without a token |
| `POST /c/:token/mcp` | auth | legacy connector URL with the token in the path |
| `GET /mcp` | public | 405: the server is stateless, POST only |
| `DELETE /mcp` | public | 405: the server is stateless, POST only |
| `GET /c/:token/mcp` | public | 405: the server is stateless, POST only |
| `DELETE /c/:token/mcp` | public | 405: the server is stateless, POST only |
| `GET /now/:token` | auth | the person's running timer, for the menu bar app |
| `POST /pull/:token` | auth | claims the person's desktop reminders |
| `POST /tick/:token` | admin | scheduler: delivers due reminders for everyone |
| `GET /.well-known/oauth-authorization-server` | public | OAuth discovery (RFC 8414) |
| `GET /.well-known/oauth-protected-resource` | public | OAuth discovery (RFC 9728) |
| `GET /.well-known/oauth-protected-resource/mcp` | public | OAuth discovery for the /mcp resource |
| `POST /register` | public | dynamic client registration: a client registers itself before anyone signs in |
| `GET /authorize` | public | starts sign-in; the page signs the person in with Firebase |
| `POST /authorize` | public | same as GET /authorize, form-encoded |
| `POST /authorize/approve` | public | the person's Allow/Deny; requires a fresh Firebase ID token in the body |
| `POST /token` | public | code and refresh-token exchange; requires the code or refresh token itself |
| `POST /revoke` | public | token revocation; requires the token itself |
