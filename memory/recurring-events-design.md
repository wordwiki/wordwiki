---
name: recurring-events-design
description: "Planned recurring-events / public-schedule feature; separate event_series table (not a flag on event), schedule renders from RULES not instances, lazy materialization, forward-only reconcile"
metadata: 
  node_type: memory
  type: project
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

Planned feature (design approved by dz 2026-07-17, NOT built): recurring events + a public
**schedule**, to kill the weekly hand-entry burden (~6 recurring events/week). Doc of record:
repo-root **recurring-events.md**.

Core design decisions (mine + dz's):
- **Separate `event_series` table**, NOT an `is_template` flag on `event` (a flag would pollute every
  event query — the exact leak we hit with project templates; events have MORE filters). `event`
  gains only a nullable `series_id` FK → ZERO existing-query changes. (Projects unified because it's
  filter-light + template≡instance; neither holds for events, so the reasoning flips to separate.)
- **KEY REFRAME: decouple SCHEDULE from INSTANCES.** The public schedule renders from the RULES
  (series rows), not from materialized event instances. This dissolves the "turn off gets ugly"
  problem: to stop a recurring event you set `effective_end` (a season has one); it stays on the
  schedule until the window closes, then drops. The window (effective_start/end) does the on/off job,
  no separate flag.
- `frequency: none|weekly|monthly` unifies manual prototype (none = clone-to-event) and recurring
  series (weekly=weekday+window, monthly=nth-weekday). Keep it compact — NOT iCal RRULE.
- **Materialization: lazy, to a horizon (~5 weeks), race-safe** — reuse the catch-all event pattern
  (catchAllForDate + partial unique index). Triggered on host/admin events-page view; public schedule
  never materializes (no writes on anon reads). Bulk import = same materialize fn over a PAST window.
  No cron needed (optional backstop later).
- **Reconcile, not manual delete**: create-missing-future + delete-future-occurrences-that-no-longer-
  match; NEVER touch past/committed instances (sign-ups, check-ins, service/sale rows). Series edits
  apply FORWARD-ONLY (never rewrite existing instances); "apply to N upcoming" is a separate explicit
  action. This create/delete-only-never-modify line is the load-bearing semantic.
- Public schedule = a `rabid-schedule` app-registered [[site-editor-design]] block. Admin gets an
  event-series/templates list (like projects Templates page), reusing event prototype fields.
Open: skip/exception handling deferred to v2 (a series_skip table) or handle-by-deleting for now.