# Working on the AimYear MCP server

You don't need this to use AimYear: see the [README](../README.md).

## Protocol details

Stateless Streamable HTTP, POST only. Sign-in is OAuth 2.1 with PKCE and dynamic client
registration. The sign-in page uses the same Firebase project as the AimYear app, so the app
and every connected AI share one account and one history. Guest (anonymous) accounts cannot
be connected. Every tool acts as one signed-in person; see [ACCESS.md](ACCESS.md).

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
| `GET /pro/checkout?t=…` | No sign-in: the token is `<uid>.<expiry>.<HMAC>`, made by `get_pro_link` and valid for an hour. Shows the Pro checkout (Paddle.js, overlay) for that uid only; an expired or changed link, an account that already has Pro, or no web checkout set up get a plain page. See "Pro on the web" below. |
| `GET /email/unsubscribe?t=…` | No sign-in: the token is the uid with an HMAC. Shows a page with one button; opening the link changes nothing. |
| `POST /email/unsubscribe?t=…` | One-click unsubscribe (RFC 8058, body `List-Unsubscribe=One-Click`) and the page's button: turns `weekly_review_email` off. |

## Pro on the web (Paddle, through RevenueCat)

Someone who uses AimYear only through an agent buys Pro on the web (docs/pricing.md in the
AimYear project, "Where Pro is bought"). The purchase is kept by RevenueCat, like the app's:

1. `get_pro_link` (or a Pro refusal over MCP, as `pro_link`) gives the agent
   `https://<base>/pro/checkout?t=<uid>.<expiry>.<HMAC>`, valid for an hour.
2. The page loads Paddle.js and opens the overlay checkout for the yearly (preselected) or
   monthly price, with `customData: { <PADDLE_APP_USER_ID_FIELD>: <uid> }` and the account's
   email prefilled. Prices on the page come from Paddle (`PricePreview`), never from the server.
3. Paddle notifies RevenueCat; RevenueCat's Paddle integration reads the uid from the custom
   data (App user ID matching → "Use a custom field"), so the purchase lands on the same RevenueCat customer as the
   app's. `src/pro.ts` then sees it through the REST check and `POST /revenuecat/webhook`
   (`store: PADDLE`), with no Paddle code on the server and no Paddle webhook of our own.

Only `/pro/checkout` sends a Content-Security-Policy that allows Paddle: `script-src` with
the response's nonce and `https://cdn.paddle.com`, `frame-src` the environment's
`sandbox-buy.paddle.com` or `buy.paddle.com`, `connect-src https://*.paddle.com`.

Never set `PADDLE_ENV=sandbox` on the production service: sandbox purchases are real
RevenueCat purchases in the sandbox environment and give Pro for a test card.

Sandbox setup (sandbox-vendors.paddle.com, and the RevenueCat project the server's
`REVENUECAT_SECRET_KEY` belongs to):

- Paddle → Catalog → Products: one product "AimYear Pro" (tax category: Standard digital
  goods), with two prices: $49.99 USD recurring every 1 year and $7.99 USD recurring
  every 1 month, no trial. Their `pri_…` ids go to `PADDLE_PRICE_YEARLY` and `PADDLE_PRICE_MONTHLY`.
- Paddle → Checkout → Checkout settings: a default payment link (sandbox accepts any URL, e.g.
  the server's base URL). Sandbox approves checkout domains by itself.
- Paddle → Developer tools → Authentication: a client-side token (`test_…`) for
  `PADDLE_CLIENT_TOKEN`, and an API key for RevenueCat with the permissions RevenueCat's
  Paddle guide lists (Customer portal sessions write; Transactions, Client-side tokens and
  Notification settings read and write; Subscriptions, Products, Prices, Customers and
  Notifications read), not expiring.
- RevenueCat → Web → Paddle: a new config with that API key (there is no sandbox switch: a
  sandbox key, `pdl_sdbx_apikey_…`, makes a sandbox config; live needs a second config with a
  live key). Purchase tracking: Method **Automatic**; App user ID matching **Use a custom field**,
  field `app_user_id` (or whatever `PADDLE_APP_USER_ID_FIELD` says). The default, "Use
  autogenerated user IDs", files every web purchase under a new anonymous customer, and a
  purchase filed that way stays there even when Paddle's notifications are replayed after the
  fix (seen 2026-11-21). Connecting adds RevenueCat's destination to Paddle → Developer tools →
  Notifications; the server needs no Paddle notification of its own.
- RevenueCat → Product catalog → Products → Import from Paddle: both prices; attach them to the
  `AimYear Pro` entitlement (and to an offering if the app should list them).
- Test with card 4242 4242 4242 4242 and a real-looking email domain (RevenueCat ignores
  `.test`, `.invalid` and `.localhost`); Paddle's webhook simulator is ignored by RevenueCat.

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
| `src/checkout.ts` | Pro on the web: the env switch, the signed checkout link, the checkout page (Paddle.js) and its Content-Security-Policy. |
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
value set on the RevenueCat webhook; a secret; unset refuses every webhook call). Pro on the web
(all five, or there is no web checkout and nothing changes): `PADDLE_ENV` (`sandbox` or
`production`, no default), `PADDLE_CLIENT_TOKEN` (Paddle's client-side token, `test_…` in sandbox,
`live_…` in production; public by design), `PADDLE_PRICE_YEARLY` and `PADDLE_PRICE_MONTHLY`
(`pri_…`), `CHECKOUT_LINK_SECRET` (32+ characters, the HMAC key for the links; a secret), and
optionally `PADDLE_APP_USER_ID_FIELD` (default `app_user_id`). The weekly
review email: `AWS_ROLE_ARN` (the role whose short-lived credentials the server gets for its
Google identity token; without it, the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`),
`AWS_REGION` (default `us-east-1`) for Amazon SES; `AIMYEAR_REVIEW_FROM` (default `AimYear <review@aimyear.com>`);
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
For the weekly review email: `AWS_ROLE_ARN=arn:aws:iam::539247463479:role/aimyear-mcp-ses` and
`AWS_REGION=us-east-1`, no AWS key. The role trusts only Google identity tokens of the
`aimyear-mcp` service account (`accounts.google.com` with `aud` and `sub` its unique id and
`oaud` `https://aimyear.com/aws-ses`) and may only send from the `aimyear.com` SES identity
(Easy DKIM on, DMARC `p=none`).
The RevenueCat webhook URL is `https://mcp.aimyear.com/revenuecat/webhook`. `mcp.aimyear.com` is a Cloud Run domain mapping
(CNAME to `ghs.googlehosted.com` in Route 53) and is in Firebase Auth's authorized domains.
Health: `/health`. The legacy URL `https://<service>/c/<token>/mcp` still works.

Call analytics: `scripts/mcp-calls.sh [1d]` prints calls per tool and the call sequences
per person and client.
