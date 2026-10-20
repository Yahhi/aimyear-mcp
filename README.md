# AimYear MCP server

**An accountability partner inside the AI agent you already use.** Connect AimYear to
Claude, Claude Code, ChatGPT or any MCP client, and your agent keeps one big aim for your
year, plans one main step a day toward it, runs the timer while you work and writes down
what actually got done. When you start comfortable work while the main step is still open,
it asks you to do the step first.

Built for indie developers and makers who build all day but keep postponing the work that
moves the goal: selling, talking to users, publishing.

- **Free:** sign-in on any number of devices, aims, plans, routines, time tracking and
  reviews through your own agent. No AI runs on AimYear's side, so there are no AI costs.
- **Pro** ($49/year or $8/month, with the coming phone app): notifications, reviews
  written by AimYear, AimYear's own AI coach and Google Calendar sync.

Website: [aimyear.com](https://aimyear.com) · Setup guide: [aimyear.com/connect.html](https://aimyear.com/connect.html) · Privacy: [aimyear.com/privacy.html](https://aimyear.com/privacy.html)
· Contact: privacy@aimyear.com

## Connect (about a minute)

Endpoint: **`https://mcp.aimyear.com/mcp`** (Streamable HTTP, OAuth sign-in with Google,
Apple or email). Nothing to install.

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → paste the
  endpoint → Connect, then sign in.
- **Claude Code:** `claude mcp add --transport http aimyear https://mcp.aimyear.com/mcp`, then
  `/mcp` → aimyear → Authenticate.
- **ChatGPT** (paid plans, developer mode): Settings → Apps & Connectors → Advanced settings →
  turn on Developer mode. Then Apps & Connectors → Create: name `AimYear`, URL the endpoint
  above, authentication OAuth → Create, then sign in.
- **Other MCP clients:** add the endpoint as a remote (HTTP) server with OAuth.

Then say: *"Help me set my aim for this year"*. The agent checks that the aim is countable,
builds the path of stages, and from then on: *"plan my day"*, *"start the timer"*, *"how was
my week?"*.

The skill that teaches an agent the method is in [skills/aim/SKILL.md](skills/aim/SKILL.md).

## What happens to your data

The server stores what your agent saves through the tools (aim, path, plans, sessions and
their summaries) in Google Cloud Firestore. Your conversation stays with your agent's
provider; AimYear only receives the tool calls. Logs keep the tool name, success and timing,
never argument values. To delete your account and data, email privacy@aimyear.com. Details:
[privacy policy](https://aimyear.com/privacy.html).

## Tools (43)

Names say what a tool does: `get_` reads one thing, `list_` reads several, `find_` looks
for problems, `set_` replaces a whole list, `add_` / `edit_` / `delete_` change one entry.

| Group | Tools |
|---|---|
| Aim | `get_goal`, `check_goal_draft`, `set_goal`, `record_progress`, `set_levers`, `set_projects` |
| Path | `get_path`, `set_milestones`, `edit_milestone`, `add_steps`, `edit_step`, `delete_step`, `next_steps` |
| Week | `get_commitments`, `set_commitments`, `get_capacity` |
| Day | `get_planning_context`, `get_plan`, `set_plan`, `edit_plan_item`, `delete_plan_item`, `set_day_mode`, `get_routines`, `set_routines` |
| Timer and sessions | `get_now`, `start_session`, `add_note`, `split_attention`, `stop_session`, `stop_timer`, `add_session`, `edit_session`, `delete_session`, `list_sessions`, `find_gaps` |
| Reviews | `summarize_day`, `summarize_week`, `find_leaks` |
| Settings and devices | `get_settings`, `set_settings`, `add_device`, `list_devices`, `delete_device` |

0.4.2 adds the hard-first check: `set_plan` warns when nothing in the day is on a hard lever,
and `add_steps` / `set_levers` warn when a stage starts with preparation before the first
hard-lever step. The server instructions tell every agent the same rule.

0.4.0 adds routines: small steps that repeat on fixed weekdays ("talk with one person on
Reddit"). The server adds them to each matching day's plan, so every device and agent sees
the same checks; `get_now` lists the open ones and `summarize_week` counts them.

0.3.0 renamed most tools (0.2.x names stop working) and added the editing tools:
`edit_session`, `delete_session` for finished sessions, `edit_milestone`, `delete_step`,
`edit_plan_item`, `delete_plan_item`, `set_projects`, and `get_settings` / `set_settings`
with the timezone.

## Protocol details

Stateless Streamable HTTP, POST only. Sign-in is OAuth 2.1 with PKCE and dynamic client
registration. The sign-in page uses the same Firebase project as the AimYear app, so the app
and every connected AI share one account and one history. Guest (anonymous) accounts cannot
be connected. Every tool acts as one signed-in person; see [docs/ACCESS.md](docs/ACCESS.md).

Without a token, the server describes itself (`initialize`, `tools/list`, `prompts/list`,
`ping`); everything else answers `401` with a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/mcp`.

### Retry-safe writes for apps (0.7)

The server is the source of truth, and a phone may deliver a request long after the tap, or
twice. So `stop_session`, `start_session`, `add_session`, `add_note`, `add_steps` and
`delete_session` take an optional `op_id`: an id the app mints before its first attempt and
reuses on every retry. The write is applied once; a retry gets the first answer back and
writes nothing. Applied ops live in `users/{uid}/ops/{op_id}` (`tool`, `sessionId`, `result`,
`at`, `expiresAt`) and are written in the same Firestore transaction as the change they
record. Give the `ops` collection a TTL policy on `expiresAt` (30 days) in the Firestore console.

`stop_session` takes `end_at` and `start_session` takes `start_at` (ISO 8601) so a stop queued
offline at 14:05 and delivered at 16:40 records 14:05. `start_session` also takes the app's
own `session_id` (create-if-absent). A request with `op_id`, `end_at` or `start_at` must name
its `session_id`: the server never guesses which session a replay means. Without them, an
agent's `stop_session` / `delete_session` acts only on its own connection's single running
session, and otherwise lists the running sessions with ids.

Two devices can stop one session; the result is the same whatever order the stops arrive in:
the earliest end wins (once anyone stopped it, it was not running), `done` wins over any
other outcome, the first summary stays and a different later one goes to the notes. Every
stop is kept in the session's `stops[]`, and the answer says `applied: ended | shortened |
recorded`.

---

The rest of this file is for working on the server itself. You don't need it to use AimYear.

## How it is built

| File | What it does |
|---|---|
| `src/http.ts` | The Express app: the MCP endpoint, the OAuth routes, the menu bar endpoints. |
| `src/access.ts` | One table: every MCP method, tool and route → public / auth / admin, with the reason. Every gate reads it. |
| `src/oauth.ts` | OAuth storage in Firestore (codes and tokens stored as SHA-256 hashes) and the sign-in/consent page. The protocol itself is the MCP SDK's `mcpAuthRouter`. |
| `src/calllog.ts` | One structured log line per MCP call: method, tool, ok, error code, latency, user, client. Never argument values. |
| `src/tools.ts` | Tool registration, annotations (read-only / destructive / idempotent) and the server instructions. |
| `src/service.ts`, `src/domain/` | The rules: goal rubric, classification, attention, plans, sessions. |
| `src/surface.ts` | The surface fingerprint behind `surface.lock.json`. |

Data lives in Firestore under `users/{uid}/aim/{goal,path,profile}`, `users/{uid}/days`,
`users/{uid}/sessions`, `users/{uid}/blocks`, `users/{uid}/ops` (applied `op_id`s, TTL on
`expiresAt`); OAuth under `oauth_clients`, `oauth_requests`, `oauth_codes`, `oauth_tokens`;
reminders in `pending_notifications` (claimed by a transactional delete before each push).

## Run locally

```bash
npm install && npm run build
# stdio, one person:
claude mcp add --scope user aimyear -e AIMYEAR_UID=<firebase uid> -- node $PWD/dist/index.js
# HTTP:
AIMYEAR_TOKENS="sometoken=<uid>" PORT=8787 node dist/index.js --http
```

Credentials: a Firebase admin service account at `~/.aimyear/service-account.json` (or
`AIMYEAR_SERVICE_ACCOUNT=<path>`; falls back to Application Default Credentials).

Env: `AIMYEAR_UID` (stdio), `AIMYEAR_TOKENS` (HTTP: static `token=uid` pairs for Claude Code
scripts, the menu bar app and the scheduler), `AIMYEAR_BASE_URL` (the public URL; the OAuth
issuer), `AIMYEAR_ALLOWED_ORIGINS` (extra browser origins), `AIMYEAR_WORKPLACE`, `AIMYEAR_TZ`.

## Tests

```bash
npm test                  # access table guard, anonymous gate and batch smuggling, OAuth discovery,
                          # annotations, Origin, version negotiation, surface lock, domain rules
npm run test:conformance  # a client's path through the real HTTP entry point: initialize and
                          # tools/list without a token, then every tool with a throwaway user
                          # in the real Firestore; cleans up
CONFORMANCE_URL=https://mcp.aimyear.com/mcp npm run test:conformance   # read-only tools, live
npm run test:oauth        # register → consent → real Firebase ID token → code → token (PKCE) →
                          # tool call → refresh rotation, plus every refusal; cleans up
npx tsx test/smoke.ts     # the service end to end against Firestore
```

When you add a tool: give it an entry in `src/access.ts` (`npm test` fails without one), run
`npm run access-doc`, bump `src/version.ts`, run `npm run surface-lock`.

## Hosted (Cloud Run)

```bash
gcloud run deploy aimyear-mcp --source . --project aimyear-app --region us-central1 --quiet
```

Env vars on the service: `AIMYEAR_TOKENS`, `AIMYEAR_TZ`, `AIMYEAR_PROJECT`,
`AIMYEAR_BASE_URL=https://mcp.aimyear.com`. `mcp.aimyear.com` is a Cloud Run domain mapping
(CNAME to `ghs.googlehosted.com` in Route 53) and is in Firebase Auth's authorized domains.
Health: `/health`. The legacy URL `https://<service>/c/<token>/mcp` still works.

Call analytics: `scripts/mcp-calls.sh [1d]` prints calls per tool and the call sequences
per person and client.

## License

[FSL-1.1-MIT](LICENSE.md): you can read, run, self-host and change this server, but not offer it as a competing commercial service. Each release becomes MIT two years after it is published. The hosted service is at https://mcp.aimyear.com/mcp.
