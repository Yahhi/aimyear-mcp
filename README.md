# AimYear MCP server

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/yahhi/aimyear-mcp)

AimYear is an accountability partner inside the AI agent you already use. Connect it to
Claude, Claude Code, ChatGPT or any MCP client, and your agent keeps one big aim for your
year, plans one main step a day toward it, runs the timer while you work (or records moves
without hours) and writes down what actually got done. When you start comfortable work while
the main step is still open, it asks you to do the step first.

It is built for indie developers and makers who build all day but keep postponing the work
that moves the goal: selling, talking to users, publishing.

Website: [aimyear.com](https://aimyear.com) · Setup guide: [aimyear.com/connect.html](https://aimyear.com/connect.html) · Privacy: [aimyear.com/privacy.html](https://aimyear.com/privacy.html)

## Connect

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

Then say *"Help me set my aim for this year"*. The agent checks that the aim is countable and
builds the path of stages. After that, try *"plan my day"*, *"start the timer"* or *"how was
my week?"*.

The method the agent follows is in [skills/aim/SKILL.md](skills/aim/SKILL.md). The server
also serves it as the prompt `aim` and the resource `aimyear://skill/aim`, so a client
without the skill installed still gets it.

## Free and Pro

Everything you do through your own agent is free: aims, the path, plans, routines, the timer,
moves, reviews your agent writes, on any number of devices. No AI runs on AimYear's side.

Pro is AimYear working for you: notifications and reminders, weekly reviews it writes from
your record, and posting your progress to WIP and Bluesky. Prices are on
[aimyear.com](https://aimyear.com/#pricing).

## What happens to your data

The server stores what your agent saves through the tools (aim, path, plans, sessions and
their summaries) in Google Cloud Firestore. Your conversation stays with your agent's
provider; AimYear only receives the tool calls. Logs keep the tool name, success and timing,
never argument values. To delete your account and data, email privacy@aimyear.com. Details
are in the [privacy policy](https://aimyear.com/privacy.html).

## Tools

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
| Posting progress (Pro) | `add_social_account`, `list_social_accounts`, `delete_social_account`, `get_post_draft`, `add_post`, `list_wip_projects`, `list_auto_posts`, `edit_auto_post`, `delete_auto_post` |

Your agent always sees the current list through `tools/list`. What changed between versions
is in [CHANGELOG.md](CHANGELOG.md); protocol details, running the server and tests are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[FSL-1.1-MIT](LICENSE.md): you can read, run, self-host and change this server, but not offer
it as a competing commercial service. Each release becomes MIT two years after it is
published. The hosted service is at https://mcp.aimyear.com/mcp.
