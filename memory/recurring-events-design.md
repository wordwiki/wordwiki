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
- **Materialization: to a horizon (~5 weeks), race-safe** — reuse the catch-all pattern
  (catchAllForDate + partial unique index). Trigger DECIDED: on startup + a once-a-day guard (memoized
  last-run org day), NOT a write on the general read path (dz's skeeze), NOT a cron. Public schedule
  never materializes. Bulk import = same materialize fn over a PAST window.
- **Skips IN** (dz): tiny `event_series_skip(event_series_id, skip_date, reason)` table — so the public
  schedule shows exceptions ("No session Aug 2 — holiday") purely from rules, no deleted-instance
  dependence. Chosen over a single skip field (barely more code, multiple, no wait-to-pass, has reason).
- **weekday / week_of_month / frequency are STRING enums** (weekday_enum monday..sunday,
  week_of_month_enum first..fourth|last, frequency_enum none/weekly/monthly) → reuse EnumField picker +
  auto-form; a `{monday:1..sunday:7}` map does date math (Temporal dayOfWeek).
- **Reconcile, not manual delete**: create-missing-future + delete-future-occurrences-that-no-longer-
  match; NEVER touch past/committed instances (sign-ups, check-ins, service/sale rows). Series edits
  apply FORWARD-ONLY (never rewrite existing instances); "apply to N upcoming" is a separate explicit
  action. This create/delete-only-never-modify line is the load-bearing semantic.
- Public schedule = a `rabid-schedule` app-registered [[site-editor-design]] block. Admin gets an
  event-series/templates list (like projects Templates page), reusing event prototype fields.
Open: skip/exception handling deferred to v2 (a series_skip table) or handle-by-deleting for now.