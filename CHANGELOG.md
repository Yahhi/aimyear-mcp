# Changelog

What changed for agents and apps that use the server. Newest first.

0.13.4: tool descriptions use the words users say (aim, gym, forgot the timer, what should
I work on), and every ID parameter names the tool that returns it.

0.13.3: only finished work posts to WIP; work stopped in the app waits for the agent's words.

0.13.2: one rule for every number: attention minutes everywhere, hard decided by the lever,
rounded once from exact sums.

0.13.1: a switch splits attention 70/30 from now; live tokens no longer overwrite each other;
SES through a role, no stored AWS key.

0.13.0 adds the weekly review email, posts about what was done, the running timer on the
iPhone and calendar events read by your own agent (docs/weekly-review.md, docs/public-posting.md,
docs/notifications.md and docs/calendar-sync.md in the AimYear project, 2026-11-07):
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
- **Work posts to WIP, automatic with undo (Pro, WIP connected).** `set_projects` takes
  `public` (default false, kept when a call leaves it out). A session on a public project that
  ends done with a real summary (60 characters or more, and more than the task title again),
  from `stop_session` or `stop_timer`, or a move on one (`add_move`), is queued as a WIP
  todo: the summary trimmed, with the project's #hashtag, no AI model; `wip_text` on
  `stop_session` and `add_move` gives the agent's own text. It posts 10 minutes after the work
  ended (never sooner than 10 minutes after it was queued), sent by `/tick`; a push to every
  device (`kind: auto_post`) carries Cancel and Edit (`POST /social/auto-posts/:id/cancel`,
  `POST /social/auto-posts/:id/edit` with `{ text }`, which posts at once; `GET
  /social/auto-posts` lists a day's). A shorter summary gets the evening offer's push with a
  Post button for that one todo instead. Work on the same project and task within 2 hours of
  a todo joins it: a queued one takes the new text and its post time moves to the new end + 10
  minutes (with a new push), a posted one posts nothing new. One session is in at most one
  todo. The evening WIP draft leaves out projects that already got their automatic todo, and
  the "already posted today" check never takes AimYear's own todos for the user's. Agents use
  `list_auto_posts`, `delete_auto_post` (cancel) and `edit_auto_post`.
  **Finished work only, the agent writes it** (2026-11-13): a session that ends partial,
  abandoned or with no outcome makes no todo; the evening draft shows unfinished work only on
  a day with nothing finished toward the aim, by its summary, never by the task title. Work
  stopped in the app (no agent present) makes a `waiting` todo: no push, nothing goes out.
  The agent's next answers (`get_now`, `start_session`, `stop_session`, `get_post_draft` and
  a few more) carry `post_waiting`, and `edit_auto_post` posts the text the agent wrote with
  the user. Waiting todos of a day are cancelled once the day's WIP post goes out; until then
  their work is in the evening draft.
- **The weekly review email's "what moved" says something.** A session summary too thin to
  mean anything to a reader (under 4 words or under 20 characters: "ready", "posted some
  replies") gives way to the session's task title; when both are thin, the longer one.
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
- **Your calendar, read by your own agent (Free)** (docs/calendar-sync.md). AimYear does not
  connect to Google. `add_session` and `set_commitments` entries take `calendar_event_id`, the
  event's id from the agent's own calendar connector: an event that was work toward the aim is
  logged with it, a recurring life event becomes one commitment with it, and the server refuses
  to log the same event twice (or two commitments for one event). The /aim skill says how.

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
