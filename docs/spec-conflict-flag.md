# Spec: mark a session as conflicted when two stops disagree

## Decision (2026-10-23): not now

Parked. Revisit when real conflicts show up.

- **It has not happened for real.** On 2026-10-23 Firestore held 101 sessions. One was stopped twice with a different summary and outcome, and it was a smoke-test account ("first" / "phone said done", 2026-10-20). Real accounts: zero.
- **Nothing is lost today.** The earliest end wins, `done` wins, and the other summary goes to `notes`. The stop reply already says "Your summary went to its notes." when that happens, so the second device's caller is told.
- **Nobody would see the flag.** The app is out of scope below, so `conflict` would only show up when an agent calls `day_summary`: a review queue with no reviewer.
- **The cost is real for a feature that never fires.** Four output schemas, the surface lock, a version bump and a deploy, right before store review.

**When to do it:** once the app replays queued stops from devices that were offline and real users run two devices. Count conflicts first: a script that reads every `sessions` doc (collection group) and counts those with more than one entry in `stops` whose summaries or outcomes differ. If real cases appear, build this spec together with the app side that shows the flag.

Context: two devices can stop the same session (a phone offline at 14:05, a Mac online at 14:20). `mergeStop` in `src/service.ts` (around line 1352) already keeps every attempt in `session.stops`, lets the earliest end win, lets `done` win over any other outcome, keeps the first summary, and pushes a different later summary into `session.notes` as "`HH:MM` stop from `<workplace>`: `<summary>`". Nothing is lost, but nothing marks the record either, so a human only finds the disagreement by reading the notes. A reviewer on dev.to (Dimitris Kyrkos) asked for the conflict to be a detectable state. This change adds that state. It changes no merge rule.

## 1. Data

In `src/types.ts`, `interface Session`, add:

```ts
/**
 * Set when two stop attempts disagreed on the summary or the outcome, so a human can
 * review the record. Cleared by edit_session. The attempts themselves are in `stops`.
 */
conflict?: { kind: ('summary' | 'outcome')[]; since: string };
```

`since` is the ISO time of the stop that created the conflict (`stop.receivedAt`). Firestore stores the field as given; no migration, absence means no conflict.

## 2. Detection, in `mergeStop`

After the existing logic (do not change the end-time rule, the `done` rule, or the first-summary rule):

- `summary` conflict: the session already had a real summary (`placeholder` is false) and `stop.summary` is non-empty and differs from `s.summary`. This is the same condition that today pushes the note, so set it where `noted = true` is set.
- `outcome` conflict: the session already had an outcome from an earlier stop (`previousEnd` is set) and `stop.outcome !== s.outcome` as it was before this stop. Note: `done` still wins and is written to `s.outcome`; the conflict records that the two attempts disagreed, not which won.
- If either applies: set `s.conflict = { kind: [...], since: stop.receivedAt }`. If a conflict already exists, append new kinds not already present and keep the original `since`.
- Return value: add `conflict: boolean` to the object `mergeStop` returns (true when this stop created or extended a conflict).

## 3. What the caller hears

In `stopSession`, where `speak` is built for the `shortened` and `recorded` branches: when `m.conflict` is true, append one sentence: ` The two stops disagree on <summary / outcome / summary and outcome>; the session is marked for review.` Also add `conflict: view.conflict` is not needed separately because the session view carries it (next point).

## 4. Views

- `sessionView` (`src/service.ts` around line 804): add `conflict: s.conflict ?? null` to the returned object.
- `daySummary` (around line 1098), in the `sessions: list` mapping: add `conflict: !!s.conflict`. Add a top-level `conflicts: number` next to `overrides` (count of sessions in the day with `conflict` set), so the morning review sees it without opening each session.
- `weekSummary` builds on `daySummary`; no change needed unless it filters the fields, in which case pass `conflicts` through.

## 5. Clearing

In `editSession`: when the patch changes `summary` or `outcome` or `end`, delete `s.conflict` (the human has looked). Say so in the result's `speak`: ` Conflict cleared.` Only when a conflict existed.

## 6. Tool surface

- `stop_session`, `edit_session`, `day_summary`, `get_current` output schemas: add the new optional fields where the session view or day list appears. Keep every field optional so older clients are unaffected.
- `stop_session` description: one sentence, "If two devices stopped the same session with different summaries or outcomes, the session is marked `conflict` for review; `edit_session` clears it."
- Run `npm run surface-lock` after the schema change (the lock hashes the tool surface; the CI check fails otherwise).
- Bump the patch version in `package.json`, `server.json` and `surface.lock.json` (currently 0.9.0), and mention the field in `docs/` wherever the session object is documented.

## 7. Tests (`test/retry-safe.test.ts` has the two-device cases to extend)

1. Phone stops at 14:05 "wrote the intro", Mac stops at 14:20 "fixed the build": in both arrival orders the session ends 14:05, `summary` is whichever arrived first, the other is in `notes`, and `conflict.kind` is `['summary']`. `since` equals the second stop's `receivedAt`.
2. Same end time, same summary, outcomes `done` and `partial`: outcome is `done`, `conflict.kind` is `['outcome']`.
3. Second stop with an identical summary and outcome: no conflict (a pure replay never flags).
4. A replay carrying the same `op_id`: returns the stored result, no conflict, `stops` unchanged (existing behaviour, keep asserting it).
5. First stop onto an auto-closed session (placeholder summary): no conflict (the placeholder is replaced, as today).
6. `edit_session` with a new summary clears `conflict`; an edit that changes only `task` does not.
7. `day_summary` lists `conflict: true` for the flagged session and `conflicts: 1`.
8. The existing test that `mergeStop` is order-independent for end and outcome still passes; add the assertion that `conflict.kind` is the same in both orders.

## 8. Out of scope

No automatic resolution, no notification, no change to the end-time rule, no change to the phone app. The Flutter app can show `conflict` later; nothing here depends on it.

## 9. Deploy

Same as every release: `npm test`, `npm run surface-lock`, commit, `gcloud run deploy aimyear-mcp --source . --project aimyear-app --region us-central1`, then the remote read-only conformance check (`test/conformance.ts`) against the live URL, and check `/health` reports the new version.
