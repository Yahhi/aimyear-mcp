# AimYear MCP server

**An accountability partner inside the AI agent you already use.** Connect AimYear to
Claude, Claude Code, ChatGPT or any MCP client, and your agent keeps one big aim for your
year, plans one main step a day toward it, runs the timer while you work (or records moves,
without hours) and writes down what actually got done. When you start comfortable work while the main step is still open,
it asks you to do the step first.

Built for indie developers and makers who build all day but keep postponing the work that
moves the goal: selling, talking to users, publishing.

- **Free:** sign-in on any number of devices, aims, plans, routines, time tracking,
  moves without hours, a weekly target and reviews through your own agent. None of it runs AI on AimYear's side, so there are no AI costs.
- **Pro** ($49.99/year or $7.99/month, with the coming phone app): notifications, reviews
  written by AimYear, Google Calendar sync, and posting your
  day's progress to WIP and Bluesky.

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
The server also serves it, so a client without the skill installed still gets the method: the
prompt `aim` and the resource `aimyear://skill/aim` (both answer without sign-in).

## What happens to your data

The server stores what your agent saves through the tools (aim, path, plans, sessions and
their summaries) in Google Cloud Firestore. Your conversation stays with your agent's
provider; AimYear only receives the tool calls. Logs keep the tool name, success and timing,
never argument values. To delete your account and data, use Delete account in the AimYear app
(or email privacy@aimyear.com); Export in the app downloads everything as JSON. Details:
[privacy policy](https://aimyear.com/privacy.html).

## Tools (51)

Names say what a tool does: `get_` reads one thing, `list_` reads several, `find_` looks
for problems, `set_` replaces a whole list, `add_` / `edit_` / `delete_` change one entry.

| Group | Tools |
|---|---|
| Aim | `get_goal`, `check_goal_draft`, `set_goal`, `record_progress`, `set_levers`, `set_projects` |
| Path | `get_path`, `set_milestones`, `set_tracks`, `edit_milestone`, `add_steps`, `edit_step`, `delete_step`, `next_steps` |
| Week | `get_commitments`, `set_commitments`, `get_capacity` |
| Day | `get_planning_context`, `get_plan`, `set_plan`, `edit_plan_item`, `delete_plan_item`, `set_day_mode`, `get_routines`, `set_routines` |
| Moves (no hours) | `add_move`, `list_moves`, `delete_move` |
| Timer and sessions | `get_now`, `start_session`, `add_note`, `split_attention`, `stop_session`, `stop_timer`, `add_session`, `edit_session`, `delete_session`, `list_sessions`, `find_gaps` |
| Reviews | `summarize_day`, `summarize_week`, `find_leaks`, `get_insights` |
| Settings and devices | `get_settings`, `set_settings`, `add_device`, `list_devices`, `delete_device` |
| Connected agents | `list_agents`, `delete_agent` |
| Posting progress (Pro) | `add_social_account`, `list_social_accounts`, `delete_social_account`, `get_post_draft`, `add_post`, `list_wip_projects` |

0.13.0 adds the weekly review email, posts about what was done, and the running timer on the
iPhone (docs/weekly-review.md, docs/public-posting.md and docs/notifications.md in the AimYear
project, 2026-11-07):
- **The weekly review email (Pro).** Every Sunday at 19:00 in the person's timezone, AimYear
  emails a review it writes from the record (no AI model): days toward the aim against the
  weekly target, weeks in a row, what moved (session summaries and moves), main steps done, the
  hard share, the path stage and its pace, and last week. With `tracking` `moves` or `quiet` it
  has no minutes or percentages. `set_settings` `weekly_review_email` (default on) turns it off
  and on; every email has a one-click unsubscribe link (`/email/unsubscribe`, RFC 8058).
- **The progress post is about what was done (Pro).** `get_post_draft` leads with the day's
  session summaries and moves toward the aim, in the user's words; the numbers follow if there
  is room. A day with nothing recorded toward the aim has no draft (`nothing_to_post: true`):
  the agent asks the user to record what they did first.
- **WIP todos per project (Pro).** `set_projects` and `set_levers` take `wip_hashtag`; the WIP
  draft (`wip_todos`, posted with `add_post`) is one todo per project worked on that day, with
  that project's #hashtag. `list_wip_projects` reads the user's WIP projects. When WIP is
  connected from the app, AimYear matches the hashtags once by name, then with one Claude call
  for what is left (Workload Identity Federation, no API key).
- **Reminders on every device (Pro).** Stand-up, stop and break-over reminders reach every
  device whichever device or agent started the timer: a push to the phones, and the desktop
  inbox for the macOS and Windows apps (the Mac is not pushed those too, or it would show each
  twice). The evening post offer is pushed to every device. Before, only the devices of the
  block's workplace got them.
- **The running timer as an iPhone Live Activity (Pro)** (`src/live.ts`). The server starts it
  by push-to-start (iOS 17.2+) and updates and ends it with the activity's push token, through
  FCM HTTP v1 (`apns.live_activity_token`), after `start_session`, `stop_session`, `stop_timer`,
  `delete_session`, `edit_session`, Break and a forgotten timer closing itself. The app reports
  its tokens with `POST /devices/live-activity`.

0.12 adds moves and the weekly target:
- `add_move` records one action toward the aim with no duration ("fixed the signup button
  text"), classified like a session; past days are fine, and a move can tick a plan item.
- `set_settings` `tracking`: `time` (default), `moves` (no timer, no minutes stored) or
  `quiet` (the record is kept, but nothing AimYear says mentions minutes or percentages).
- `weekly_target` (1 to 7 days a week, default 4) replaces the daily streak as the number
  AimYear leads with: `get_now`, `summarize_day`, `summarize_week` and the progress post
  report the days toward the aim this week and how many weeks in a row met the target.

0.9.0 is what the AimYear v2 app needs:
- The app's own Firebase sign-in works as the Bearer on `/mcp` and every app route (verified
  with revocation checked; same uid as the OAuth flow). OAuth and static tokens work as before.
- Pro comes from RevenueCat (entitlement `AimYear Pro`, app user id = Firebase uid): the REST
  API with a one-minute cache, and a webhook that keeps `users/{uid}/aim/pro` current.
- Every session records who started or logged it (`agent`: `app`, `Claude Code`, `ChatGPT`, …),
  returned by `get_now`, `list_sessions`, `start_session` and `stop_session`.
- `list_agents` / `delete_agent` show and disconnect the agents connected to the account.
- `get_insights`: the week or month at a glance (minutes per day on the aim, other work and
  life; hard share; an hour × weekday heatmap; comebacks), the numbers the app used to compute.
- Desktop apps pull their reminders; stand-ups come with Break and Snooze (routes below).
- `add_device` takes `windows`. Stopping the last running session also stops the timer.

0.8.0 adds posting the day's progress in public, to WIP (wip.co) and Bluesky.
The draft is written
from the day's record: the aim and its progress, the main step done or not, minutes on the aim
and on hard work, routines, a comeback after missed days, and it ends with aimyear.com. AimYear
posts only when the user says Post. Before posting on a network it reads the user's own feed,
and skips a network where they already posted that day themselves. Each day goes to each
network once, however often a post is retried. The draft also comes as an evening push with a
Post action, at the end of the day's last focus window. Pro only.

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

### HTTP routes for the apps (0.9)

All take the same Bearer as `/mcp` (the app sends its Firebase ID token); JSON in and out.

| Route | What it does |
|---|---|
| `POST /desktop/reminders` | A desktop app (macOS, Windows) polls this about once a minute. Answer: `{ reminders: [{ id, kind, title, body, block_id, due_at, actions }], poll_after_seconds }`. Each reminder comes once. `kind` is `standup`, `block_end` or `break_end`; a stand-up has `actions: ["break", "snooze"]`. The server keeps the stand-up cadence whether or not a desktop app polls, and a forgotten timer still closes itself. |
| `POST /desktop/reminders/action` | `{ action: "break", minutes? }` stops the timer and every running session (there is no paused state) and queues the "break over" reminder after `minutes` (default the break length); the answer lists the stopped sessions as `paused` so the app can offer to resume. `{ action: "snooze", minutes? }` asks again in `minutes` (default 10); the timer keeps running. |
| `POST /devices/live-activity` | Pro. The iPhone's Live Activity tokens: `{ token, start_token?, activity_token?, ended? }`. `token` is the device's FCM token (registered with `add_device`, else 404); `start_token` is ActivityKit's push-to-start token, `activity_token` the push token of the activity it shows now (hex; `null` clears either). A new `activity_token` gets the current state at once. `ended: true` with an `activity_token` says that activity is gone; swiped away while the timer runs, it is not started again until the timer stops. |
| `GET /account/agents` | `{ agents: [{ client_id, name, connected_at, last_active_at, current }], speak }`. |
| `DELETE /account/agents/:clientId` | Disconnects one agent (deletes its sign-in for this account). 404 when no such agent is connected. |
| `GET /account/export` | Everything the server keeps about the person, as one JSON download: `{ format: "aimyear-export", version, exported_at, uid, account, data: { "aim/goal": …, "sessions/<id>": … }, server_rows, agents }`. Saved WIP and Bluesky logins are left out. |
| `POST /account/delete` | `{ confirm: true }`, and only with the app's Firebase sign-in (an agent's or a static token is refused with 403). Deletes `users/{uid}` with everything under it, the person's reminders, OAuth tokens and codes, the OAuth clients only they used, and the Firebase Auth user. It does not cancel a store subscription, and says so. |
| `POST /revenuecat/webhook` | RevenueCat's webhook. The `Authorization` header must equal `REVENUECAT_WEBHOOK_AUTH`. |
| `GET /email/unsubscribe?t=…` | No sign-in: the token is the uid with an HMAC. Shows a page with one button; opening the link changes nothing. |
| `POST /email/unsubscribe?t=…` | One-click unsubscribe (RFC 8058, body `List-Unsubscribe=One-Click`) and the page's button: turns `weekly_review_email` off. |

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
| `src/social/` | Posting progress: the draft (`draft.ts`), the WIP and Bluesky clients (`clients.ts`), credential sealing (`crypto.ts`), connect / check / post / evening offer (`service.ts`). |
| `src/pro.ts` | The one Pro check point: `AIMYEAR_PRO_UIDS` (by hand) → RevenueCat REST (cached a minute) → the webhook-fed `users/{uid}/aim/pro`. The webhook handler too. |
| `src/account.ts` | Connected agents (list, disconnect), export and delete of the whole account. |
| `src/review/` | The weekly review email: the builder (`build.ts`: record → facts → subject, text, HTML), when it is due (`schedule.ts`), sending through SES once a week (`deliver.ts`, called by `/tick`), the signed unsubscribe link (`unsubscribe.ts`). `npx tsx scripts/weekly-review-preview.ts` renders two made-up weeks into `tmp/`. |
| `src/domain/insights.ts` | Week and month insights and comebacks, the same rules the app used on the device. |
| `src/surface.ts` | The surface fingerprint behind `surface.lock.json`. |
| `.githooks/pre-commit` | Regenerates `docs/ACCESS.md` from `src/access.ts` and stages it on every commit, so the committed table can't drift (`npm ci` points `core.hooksPath` at it through the `prepare` script; `test/access.test.ts` still fails on a stale file). |

Data lives in Firestore under `users/{uid}/aim/{goal,path,profile}`, `users/{uid}/days`,
`users/{uid}/sessions`, `users/{uid}/blocks`, `users/{uid}/ops` (applied `op_id`s, TTL on
`expiresAt`), `users/{uid}/social/{wip,bluesky}` (handle and the login sealed with AES-256-GCM),
`users/{uid}/posts/{date}_{network}` (the posts AimYear made: their ids tell them apart from the
user's own posts, and the doc is claimed before each post so a retry never posts twice),
`users/{uid}/aim/pro` (the RevenueCat status), `users/{uid}/weekly_reviews/{monday}` (each week's
review email, claimed before it is sent so a retried tick never sends twice); OAuth under `oauth_clients`, `oauth_requests`, `oauth_codes`, `oauth_tokens`;
reminders in `pending_notifications` (claimed by a transactional delete before each push) and,
for desktop apps, `desktop_reminders` (taken once by `POST /desktop/reminders`).

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
issuer), `AIMYEAR_ALLOWED_ORIGINS` (extra browser origins), `AIMYEAR_WORKPLACE`, `AIMYEAR_TZ`,
`AIMYEAR_SOCIAL_KEY` (32 random bytes, base64, from Secret Manager: seals WIP and Bluesky logins;
without it connecting a network refuses), `AIMYEAR_PRO_UIDS` (comma-separated uids that always
have Pro), `REVENUECAT_SECRET_KEY` (a RevenueCat secret API key, for the REST check; a secret),
`REVENUECAT_ENTITLEMENT` (default `AimYear Pro`), `REVENUECAT_WEBHOOK_AUTH` (the Authorization
value set on the RevenueCat webhook; a secret; unset refuses every webhook call). The weekly
review email: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (default `us-east-1`)
for Amazon SES; `AIMYEAR_REVIEW_FROM` (default `AimYear <review@aimyear.com>`);
`AIMYEAR_UNSUBSCRIBE_KEY` (optional, 32+ characters, the HMAC key for unsubscribe links; unset,
the key is derived from `AIMYEAR_SOCIAL_KEY`; with neither, no review is sent).

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
gcloud run deploy aimyear-mcp --source . --project aimyear-app --region us-central1 \
  --service-account aimyear-mcp@aimyear-app.iam.gserviceaccount.com --quiet
```

The service runs as its own Google service account `aimyear-mcp@aimyear-app.iam.gserviceaccount.com`
(2026-11-07; before, the shared Compute default account with Editor): Firestore
(`roles/datastore.user`), Firebase Auth (`roles/firebaseauth.admin`), FCM
(`roles/firebasecloudmessaging.admin`) and read access to its three secrets. A new secret needs
`roles/secretmanager.secretAccessor` for that account. The same account is federated to the
Claude API (Workload Identity Federation: issuer `https://accounts.google.com`, audience
`https://api.anthropic.com`, claims `sub` = `107369159217285539061` and `email`), set by
`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and
optionally `ANTHROPIC_WORKSPACE_ID`; never an `ANTHROPIC_API_KEY`. Values (not secret): rule
`fdrl_0198djrEA7bomAzumR9kS1JZ` (`aimyear-mcp-prod`), organization `56f90d91-0756-4604-8e94-314f3195fd24`,
service account `svac_01VanbEzt25gH1b31N8oMmWS`, workspace `wrkspc_012JqUtDCHQ6CErwifVXb6RD` (Default).
Tested 2026-11-07 from a Cloud Run job as the account: exchange 200, token lifetime 600 s.

Env vars on the service: `AIMYEAR_TOKENS`, `AIMYEAR_TZ`, `AIMYEAR_PROJECT`,
`AIMYEAR_BASE_URL=https://mcp.aimyear.com`, `AIMYEAR_SOCIAL_KEY` (as a Secret Manager secret,
never a plain env value), `AIMYEAR_PRO_UIDS`, and for Pro `REVENUECAT_SECRET_KEY` and
`REVENUECAT_WEBHOOK_AUTH` (Secret Manager secrets) and optionally `REVENUECAT_ENTITLEMENT`.
For the weekly review email: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (Secret Manager
secrets; an IAM user allowed `ses:SendEmail` on the `aimyear.com` identity only), `AWS_REGION=us-east-1`.
The RevenueCat webhook URL is `https://mcp.aimyear.com/revenuecat/webhook`. `mcp.aimyear.com` is a Cloud Run domain mapping
(CNAME to `ghs.googlehosted.com` in Route 53) and is in Firebase Auth's authorized domains.
Health: `/health`. The legacy URL `https://<service>/c/<token>/mcp` still works.

Call analytics: `scripts/mcp-calls.sh [1d]` prints calls per tool and the call sequences
per person and client.

## License

[FSL-1.1-MIT](LICENSE.md): you can read, run, self-host and change this server, but not offer it as a competing commercial service. Each release becomes MIT two years after it is published. The hosted service is at https://mcp.aimyear.com/mcp.
