# Recurring events / event series

A proposal for recurring events and a public **schedule**, so the ~6 weekly
recurring events (Public Bike Repair, every summer Saturday 10–3, Victoria Park,
...) don't have to be hand-entered row by row - the burden that made the old
spreadsheet approach painful.

A core value of this system is that it needs little regular care and feeding.
Recurring events are the biggest violation of that today, so getting this right
matters more than the feature's size suggests.

## What we need

1. **Stop hand-entering weekly events.** Define the pattern once; instances appear.
2. **A public schedule** on the site (redraccoon.org) that shows the recurring
   pattern - "Every Summer Saturday, 10am–3pm, Victoria Park."
3. **Bulk import**: when importing historical data for a date range, create the
   corresponding event instances for that range.
4. **Low maintenance, and safe to change.** Changing or ending a recurring event
   must not require tedious hand-deletion, and must never destroy real activity
   (sign-ups, check-ins, logged service).


## The key idea: decouple the SCHEDULE from the INSTANCES

Two different things get conflated in "recurring events", and separating them is
what makes this tractable:

- **The schedule** = the *rules* ("every summer Saturday, 10–3, Victoria Park").
  A handful of recurrence rules.  This is what the public site shows.
- **The instances** = concrete `event` rows people sign up for, get checked into,
  and log service/sales against.

**The public schedule renders from the RULES, not from materialized instances.**
Once that holds, the "turning it off gets ugly" problem dissolves (see below):
the schedule shows a rule *and its active window*, so ending a rule is exactly how
you stop it, and it stays on the schedule until the window closes - no
"turn off recurring → vanishes from the schedule" contradiction.


## Model: a separate `event_series` table (NOT a flag on `event`)

An `is_template` flag on `event` (the literal projects-template copy) would
pollute EVERY existing event query - upcoming, past, attendance, service, sales,
cash - each needing `AND is_template = 0`.  Events have more filters than projects,
and this is the exact leak we already hit with project templates.

Instead: a **separate `event_series` table**, plus a **nullable `series_id` FK on
`event`**.  This changes **zero existing event queries** - a materialized instance
is just a normal event that happens to carry a `series_id`; nothing filters it out,
and a series never appears in an event query because it isn't an event.

The projects precedent (unify via a flag) came from projects being filter-light
and template ≡ instance structurally.  Neither holds for events - so the same
reasoning flips to *separate* here.

```ts
// The recurrence-rule / prototype.  Reuses the event PROTOTYPE fields (the subset
// stable across occurrences); instance-only richness (cash, sign-ups, check-ins,
// service/sale rows) lives on the materialized events, where it belongs.
interface EventSeries {
  event_series_id: number;

  // --- Prototype (mirrors the event fields an occurrence inherits) ---
  event_kind: string;            // event_kind_enum
  description: string;           // 'Public Bike Repair'
  location_description: string;  // 'Victoria Park - Behind 79 Joseph Street'
  location_url: string;
  is_remote_event: number;
  volunteer_only: number;
  host_id?: number;              // optional default host

  // --- Time of day (not a date) ---
  start_time_of_day: string;     // '10:00'
  end_time_of_day: string;       // '15:00'
  setup_time_of_day?: string;
  shop_load_time_of_day?: string;

  // --- Recurrence ---
  frequency: string;             // 'none' | 'weekly' | 'monthly'  (see below)
  weekday?: number;              // 0-6 (weekly; also the weekday for monthly)
  week_of_month?: number;        // 1-5 or 'last' (monthly only)

  // --- Active window ---
  effective_start: string;       // date; recurrence begins
  effective_end?: string;        // date, nullable; recurrence ends (season end).
                                 //   Null = open-ended (rare; prefer a real end).
}
```

`event` gains one column:

```ts
new ForeignKeyField('series_id', 'event_series', 'event_series_id',
                    {nullable: true, indexed: true, edit: security.never}),
```

Plus, for idempotent materialization, either an `occurrence_date` on the event or
a unique index `(series_id, DATE(start_time))` - the same "partial unique index
closes the check-then-create race" trick the catch-all event already uses
(`event_catch_all_by_date`).


## `frequency` unifies three cases in one table

- `frequency = 'none'` → a **manual prototype** (your "template event"): appears in
  the admin Templates list; "Create an event from this" clones it to a real event.
  No schedule, no auto-materialization.
- `frequency = 'weekly' | 'monthly'` → **also** drives the public schedule and
  materializes instances.

So "manual template" and "recurring series" are the same object at different
frequencies.


## Keep the recurrence expression small - NOT iCal RRULE

RRULE is a swamp we don't need.  The real patterns are two:
- **weekly**: a weekday + `[effective_start, effective_end]`.
- **monthly**: nth-weekday (1st..5th / last + weekday) + window.

`frequency` + `weekday` + `week_of_month` covers both.  Add more only when a real
event demands it (minimal-ceremony principle).


## Materialization: lazy, to a horizon, race-safe - no cron

We already have the pattern: the catch-all "Today's Ad-hoc" event
**materializes on demand, race-safe** (`catchAllForDate(day, create)` guarded by a
partial unique index).  Do the same for series:

- `ensureMaterialized(horizon = today + ~5 weeks)`: for each active series
  (`frequency != 'none'` and `effective_start <= horizon` and
  `effective_end IS NULL OR effective_end >= today`), compute its occurrence dates
  in `[max(effective_start, today), min(effective_end, horizon)]` and INSERT any
  that don't already exist (by `series_id + date`).  Idempotent.
- **Trigger it when a host/admin loads the internal events page.**  Sign-up happens
  *through* that page, so instances exist just-in-time.  No new infra.
- **The public schedule never triggers materialization** (it reads rules), so anon
  page views do no writes.
- **Bulk import = the same function over a PAST window**: `materialize(series,
  from, to)`.  The series is the source of truth for "every Saturday in summer 2023".

A cron can be added later as a pure backstop, but is not required.


## Reconciliation, not manual deletion - with an inviolable safety rule

When a series changes (day/time/window), instead of hand-deleting extras:

- **Reconcile = create missing future occurrences + delete FUTURE occurrences that
  no longer match the rule.**
- **Never touch** an instance that is in the past, or has sign-ups, check-ins, or
  service/sale rows.  Committed activity is sacred.
- **Editing a series does NOT rewrite existing instances.**  A rule change applies
  **going forward** (matches how people think: "from next month it's at 11").
  Bulk-editing existing future occurrences is a SEPARATE, explicit action
  ("apply this change to N upcoming occurrences"), never automatic.

This is the whole low-care promise, and the one line to hold: reconcile only
CREATES and DELETES-future-unactivitied; it never MODIFIES.  Blur that and you're
in change-propagation hell (which instance was hand-edited? did someone sign up?)
- exactly where dz worried it "gets ugly".

Drift between an instance and its series (someone moves one rainy Saturday's
location) is FINE and intended: once an occurrence exists, the instance is
authoritative for its date; the series is authoritative only for *making new ones*.


## How "turning it off" works (the worry, resolved)

- The public schedule shows series with an active window (`effective_end` null or
  future).  To stop a recurring event, **set its `effective_end`** (a season has
  one anyway).  It stays on the schedule until that date, then drops automatically.
- Materialization only creates within the window, so past `effective_end` no new
  instances appear.  Reconcile removes any already-created future occurrences
  beyond the new end (that have no activity).
- There is no on/off flag whose "off" state also hides the schedule row - the
  window does both jobs coherently.


## UI surfaces

- **Admin: "Event templates / series"** - a list (like the projects Templates
  page), grouped by frequency.  Editing a series reuses the event prototype fields
  (shared `Field` definitions).  Actions: Create event from this (frequency none),
  Reconcile now, End (set effective_end), and "apply time change to N upcoming".
- **Public schedule = a site-editor block.**  We just built app-registered blocks
  (`rabid-upcoming-events`); a `rabid-schedule` block renders the active series as
  the recurring schedule.  Drop it on the Home/About page - zero new page
  machinery.
- **Events page** materializes lazily (above) and shows instances as today.  A
  series-linked instance can show a small "recurring" affordance linking back to
  its series.


## Deferred / out of scope (for now)

- Full RRULE (bi-weekly, "every other", complex exceptions).  Add per real need.
- Per-occurrence exceptions/skips ("no repair on the holiday Saturday") - v2 could
  add a `series_skip(series_id, date)` table; for now, delete the one materialized
  instance (it's a real event) and it won't be recreated if we record the skip, OR
  just live with re-materialization not re-creating a manually-deleted future date
  (needs the skip table to be correct - a v2 decision).
- Cron backstop for materialization.


## Open decisions to confirm before building

1. **`frequency: none | weekly | monthly` unification** - one `event_series` table
   for both manual prototypes and recurring series.  (Recommended.)
2. **Series edits apply forward-only**; reconcile never modifies existing
   instances; committed instances are never touched.  (Recommended - this is the
   load-bearing semantic.)
3. **Separate table + nullable `event.series_id`** vs a flag on `event`.
   (Recommended: separate - zero existing-query changes.)
4. **Lazy materialization on the admin events page** vs a cron.  (Recommended:
   lazy; cron optional later.)
5. Skip/exception handling: defer to v2 (a `series_skip` table) or handle by
   deleting materialized instances now?
