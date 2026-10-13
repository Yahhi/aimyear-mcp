# aimyear-mcp

The AimYear MCP server: one big aim for the year, a path of stages and concrete steps,
one main step a day, focus sessions with attention shares across terminals and apps, and
a stop rule for comfortable work that pretends to be progress.

40 tools, 2 prompts. Every tool acts as one signed-in person; see [docs/ACCESS.md](docs/ACCESS.md).

## Connect

Endpoint: **`https://mcp.aimyear.com/mcp`** (Streamable HTTP, stateless, POST only).

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → paste the
  endpoint. Claude registers itself and opens the AimYear sign-in page.
- **Claude Code:** `claude mcp add --transport http aimyear https://mcp.aimyear.com/mcp`, then
  `/mcp` → aimyear → Authenticate.
- **ChatGPT:** developer mode → add the endpoint as a connector.

Sign-in is OAuth 2.1 with PKCE and dynamic client registration. The sign-in page uses the
same Firebase project as the AimYear app (Google, Apple, email), so the app and every
connected AI share one account and one history. Guest (anonymous) accounts cannot be connected.

Without a token, the server describes itself (`initialize`, `tools/list`, `prompts/list`,
`ping`); everything else answers `401` with a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/mcp`.

The skill that teaches an agent the method is in [skills/aim/SKILL.md](skills/aim/SKILL.md).

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
`users/{uid}/sessions`, `users/{uid}/blocks`; OAuth under `oauth_clients`, `oauth_requests`,
`oauth_codes`, `oauth_tokens`; reminders in `pending_notifications`.

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
                          # tools/list without a token, then all 40 tools with a throwaway user
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
