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
| `.githooks/pre-commit` | Regenerates `docs/ACCESS.md` from `src/access.ts` and stages it on every commit, so the committed table can't drift (`npm ci` points `core.hooksPath` at it through the `prepare` script; `test/access.test.ts` still fails on a stale file). |

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
