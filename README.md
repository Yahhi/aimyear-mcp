# aimyear-mcp

MCP server for AimYear v2: one measurable yearly goal, a path of milestones and
concrete steps, one main step a day, focus sessions with attention shares across
terminals, and a stop rule for comfortable work that pretends to be progress.

Spec: `../proposals/v2-mcp-api.md` in the aimyear project. Board:
https://github.com/users/Yahhi/projects/3

## Run locally (Phase 1, stdio)

```bash
npm install && npm run build
claude mcp add --scope user aimyear -e AIMYEAR_UID=<firebase uid> -- node $PWD/dist/index.js
```

Credentials: a Firebase admin service account at `~/.aimyear/service-account.json`
(or `AIMYEAR_SERVICE_ACCOUNT=<path>`; falls back to Application Default Credentials).
Data lives in Firestore under `users/{uid}/aim/{goal,path,profile}`, `users/{uid}/days`,
`users/{uid}/sessions`, `users/{uid}/blocks`.

Env: `AIMYEAR_UID` (required in stdio mode), `AIMYEAR_WORKPLACE` (`desktop` default),
`AIMYEAR_TZ` (defaults to the machine timezone, stored in the profile on first run).

## HTTP mode (before OAuth)

```bash
AIMYEAR_TOKENS="sometoken=<uid>" PORT=8787 node dist/index.js --http
# client: Authorization: Bearer sometoken → POST /mcp
```

## Claude Code integration

- Skill: `~/.claude/skills/aim/SKILL.md` (the `/aim` command and the goal rubric).
- Hooks (`~/.aimyear/hooks/`): SessionStart context line; PostToolUse on
  `start_focus` schedules macOS notifications at block end and break end and keeps a
  per-terminal marker; Stop asks for a `heartbeat` once if a session has been silent
  for 10 minutes.

## Tests

```bash
npm test                 # attention weighting, goal rubric
npx tsx test/smoke.ts    # end-to-end against Firestore with a throwaway uid (cleans up)
```
