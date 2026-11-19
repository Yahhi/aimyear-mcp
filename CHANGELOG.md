# Changelog

What changed for agents and apps that use the server. Newest first.

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
