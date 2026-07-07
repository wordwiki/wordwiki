# Event-centric activity model (rabid)

## The thesis

The **event is the aggregate root for activity**. A service, a free bike, a
volunteer showing up — none of these are standalone records the user thinks
about on their own. They are entries in *the log of what happened at an event*:
"we gave Sally a bike, serviced Fred's, three volunteers checked in." The user's
mental model, the UI, and the reporting all center on the event page as a
collaboratively-built log.

Two framing decisions fall out of this:

1. **Activities route through events; entities do not.** Services, giveaways,
   attendance, cash — event-shaped, owned by exactly one event. Volunteers,
   bikes-as-assets, committees — durable things, first-class, *referenced from*
   events but never owned by one. (A bike donated at one event and given away at
   another belongs to two events and neither owns it.) This line is the guardrail
   against "event" dissolving into "any time bucket."

2. **The shop being open is an event.** We already treat regular Tue 2–8 as an
   event. Ad-hoc / drop-in activity that happens outside any scheduled event
   lands on a per-day **catch-all event** ("Drop-in"), lazily created on the
   first entry for that date. This is not a hack once named honestly: it is the
   loosest member of the same family as "regular shop hours."

The payoff is the elimination of the standalone-vs-attached parallel path
(nullable `event_id`, `UNION`-ed reports, two mental models) and its replacement
with **one discriminator boolean on `event`**, respected in a handful of
localized filters.

## Schema changes (rabid/event.ts, rabid/service.ts)

### `event` gains a catch-all discriminator
- `is_catch_all` `BooleanField {default: 0}` — this event is a day's drop-in
  bucket, not a thing we scheduled/ran. Orthogonal to `event_kind` (a catch-all
  is semantically shop-time; the boolean is what list/report filters key on).
- `catch_all_date` `DateField {nullable: true}` — set **only** on catch-all
  events; the wall-clock day it stands for. NULL for every normal event. This is
  the catch-all's **sole day encoding** — a catch-all has NULL `start_time`/
  `end_time` (it is not a clock-bounded event; see "no attendance / no timesheet
  overlap" below), so `catch_all_date` is what every day-based lookup keys on.
- **Partial unique index** (mirrors `project_by_owner`, closes the
  check-then-create race):
  `CREATE UNIQUE INDEX event_catch_all_by_date ON event(catch_all_date) WHERE catch_all_date IS NOT NULL;`
  SQLite treats the NULLs as distinct, so normal events are unconstrained and
  there is at most one catch-all per day (1-1 with calendar days — lazy
  materialization is the *only* creation flow, per dz).

### Activity records become event-bound (`service` **and** `sale`)
- `service.event_id`: drop `nullable: true`. Every service belongs to an event.
- `sale.event_id`: **new** `ForeignKeyField('event','event_id', {indexed: true})`,
  mandatory. `Sale` (free bikes/helmets, balance-bike loans, paid bikes) is today
  fully detached from events — only `sale_recorded_by` + `sale_time`. Binding it
  to an event is what lets the giveaway count roll up the same way services do,
  and what puts free bikes in the event log alongside services.
- (dz: regenerate fake data rather than migrate; see Migration.)

## Catch-all machinery (rabid/event.ts) — mirrors `project.forOwner`

- `catchAllForDate(day: string /* sqlite date */, create = false): number | undefined`
  - `SELECT event_id FROM event WHERE catch_all_date IS :day` (indexed).
  - `create=true` and none exists → insert
    `{is_catch_all: 1, catch_all_date: day, event_kind: 'shopTime',
      description: '', start_time: null, end_time: null,
      location_description: '', is_remote_event: 0, volunteer_only: 0, ...}`.
    Return the id. The partial unique index makes the insert race-safe.
    **NULL times on purpose**: a catch-all has no clock range, so it can never
    be "concurrent with" a timesheet range (dz's timesheet-overlap constraint is
    then structural, not just a filter) and it never lands in a schedule table's
    dated rows.
- `catchAllForToday(create)` = `catchAllForDate(date.orgToday(), create)`.
  "Which day" always resolves in **org wall-clock** (`date.orgToday`/`orgNow`),
  consistent with all existing event date math — a UTC `new Date()` would shift
  the day boundary by the server's zone.
- `recordLabel` / description: a catch-all with an empty `description` labels as
  `Ad-hoc — <Mon D>` (derived from `catch_all_date`), so it reads sensibly as a
  service/sale's parent link.

## The event page as a log (rabid/event.ts renderEventDetail)

Add an **Activity** section (services *and* sales) as a peer document section,
slotted alongside the existing task/checklist sections:

```
renderEventSummary(...)          // who's here — SUPPRESSED on catch-alls
renderEventNotes(e)
renderEventPhotos(e)
renderEventActivity(event_id)    // <- NEW: the log — services + sales
renderOwnerTasks('event', id)    // event's own to-do list
renderOwnerChecklists('event', id)
```

- `renderEventActivity(event_id)` — a `reloadableItemProps` section keyed on the
  `service` **and** `sale` tables + their `event_id` fk keys (so an add/edit/
  toggle to either refreshes it live via the existing dirty-key/reload
  machinery). Heading "Activity"; renders `servicesForEvent` (via
  `renderServiceRow`) and `salesForEvent` (via `renderSaleRow`) — interleaved by
  time, or two labelled sub-lists ("Services" / "Sales & giveaways"), TBD in
  build. Empty state + an **Add** affordance (☰: *Add service* / *Add sale*) for
  editors.
- `servicesForEvent(event_id)` on `ServiceTable`, `salesForEvent(event_id)` on
  `SaleTable` (`WHERE event_id = :event_id ORDER BY <time>`).
- `newServiceForEventDialog(event_id)` / `newSaleForEventDialog(event_id)` + saves
  that stamp `event_id` — the record form over an empty record pre-bound to this
  event. The service dialog is the natural sink for the **scanned-intake**
  feature: OCR'd rows become services on this event.

Per the design-language memory (☰ over buttons, document-first), the add sits as
a quiet affordance in the section header, not a loud "Create" button.

### Catch-alls carry no attendance
`renderEventSummary`'s check-in/sign-up affordances are **suppressed** when
`is_catch_all` (dz: full-event check-in to a catch-all would corrupt reporting —
a drop-in day is not something volunteers "attend"; they log time via
timesheets). A catch-all's page is therefore: the Activity log (+ notes), no
attendance, no sign-up.

## Entry points — where a user starts a log entry

- **From a scheduled event's page**: the Service log section's Add. Direct.
- **Ad-hoc / today**: a "Today's log" entry point (home page and/or navbar) that
  resolves to `catchAllForToday(create=true)`'s event page — the first add
  materializes the day's catch-all; subsequent adds reuse it. The user never
  thinks "standalone service," only "add to today's log."
- The standalone **/service** page (and by the same logic **/sale**) is **retired**
  (dz). Service/sale access is through events; the cross-event *reporting* view
  gets a home-page entry point and lives under the existing **Reports** menu, not
  as its own top-level nav page.

## Reporting (rabid/activity_report.ts + event queries)

- **Counts of events we held** exclude catch-alls: `WHERE is_catch_all = 0`
  (event schedule tables, "N events" tallies, upcoming/past lists — a catch-all
  is not something we scheduled).
- **Activity/service totals include catch-alls** — those are real services; no
  filter. The whole point is that ad-hoc work reports uniformly with scheduled
  work: every metric is `GROUP BY event` rolled up by date/window, no `UNION`.
- **Timesheet-overlap report** (events shown concurrent with a timesheet range):
  must not surface catch-alls (dz). Structural — a catch-all has NULL times so it
  has no range to overlap — with `AND is_catch_all = 0` as belt-and-suspenders on
  the overlap query.
- **Attendance/hours reports**: catch-alls have no check-ins by construction (see
  above), so they contribute no attended-event counts; volunteer hours on a
  drop-in day come from timesheets, which is correct.
- Net: the special-casing is one boolean checked in the few places that count
  *events* vs. count *activity* — localized, not spread through a nullable-owner
  path.

## Migration

- rabid is the testbed; per dz, **regenerate fake data** (`rabid_create_fake_data.sh`)
  after the schema change rather than preserving. `seedServices` **and**
  `seedSales` get an `event_id` on every row (attach to a seeded event, or to
  that date's catch-all via `catchAllForDate(..., create=true)`); add a couple of
  catch-all days carrying a few drop-in services + a free-bike giveaway to
  exercise the model.
- Breaking column changes: `service.event_id` and `sale.event_id` become
  mandatory. The two new `event` columns are additive (schema-upgrade accepts
  them).

## Adjacent / later

- **Giveaways / free bikes** are `Sale` rows (`sale.ts`: `free-bike`,
  `free-kids-bike`, `free-helmet`, `balance-bike-loan`). They come **in scope
  here** — `sale.event_id` (above) binds them to events and the Activity section
  renders them next to services. No new giveaway model needed; the existing
  `sale` table plus event-binding is it.
- **Scanned intake** (handwritten repair-intake pages → service records) writes
  service rows straight into an event's log — it converges on
  `newServiceForEventDialog`. Built separately, but this is its landing zone.

## Decisions (resolved with dz)

1. **Granularity** — one catch-all per day. 1-1 with calendar days; lazy
   materialization is the only creation flow.
2. **Naming** — **"Ad-hoc — Jul 7"**. The catch-all names the *residual,
   exclusive* bucket: activity that was **not** part of any scheduled event. So
   the label must read as "the leftover," not "the day's total" (rules out
   "Day Log") and must not imply a time of day (rules out "After Hours").
   "Ad-hoc" says *unplanned / as-needed* — exactly the not-a-scheduled-event
   sense — is time-neutral, and collides with no real bike-shop event type. Label
   derives from `catch_all_date`: `Ad-hoc — <Mon D>`.
3. **Events-list visibility** — catch-alls are **reachable but not listed** among
   scheduled events (via "Today's log" and a service/sale's parent link),
   consistent with the reporting exclusion and reinforced by decisions 4-5.
4. **No attendance on catch-alls** — full-event check-in/sign-up is disallowed on
   a catch-all (would corrupt attendance reporting); the summary's check-in UI is
   suppressed. Drop-in volunteer time is logged via timesheets.
5. **Timesheet-overlap exclusion** — catch-alls must not appear as events
   concurrent with a timesheet range (handled structurally by NULL times +
   `is_catch_all = 0`).
6. **/service (+ /sale) pages retired** — no standalone activity pages; access is
   through events, and cross-event reporting gets a home-page entry point + lives
   under the **Reports** menu.

## Build order (naming aside, decisions have landed)

1. **Schema + catch-all machinery**: `event.is_catch_all` + `catch_all_date` +
   partial unique index; `service.event_id` and `sale.event_id` mandatory;
   `catchAllForDate`/`catchAllForToday`.
2. **Event Activity section**: `renderEventActivity` + `servicesForEvent` /
   `salesForEvent` + `newServiceForEventDialog` / `newSaleForEventDialog` + reload
   wiring. Suppress `renderEventSummary` check-in UI on catch-alls.
3. **"Today's log" entry point** → `catchAllForToday(create=true)` → its page.
4. **Retire** the `/service` and `/sale` nav pages; move cross-event reporting
   under Reports + a home entry point.
5. **Reporting filters**: `is_catch_all = 0` on event counts + the
   timesheet-overlap query; keep catch-alls out of schedule/upcoming/past lists.
6. **Fake data regen + tests**: catch-all 1-1 per day + race safety;
   service-and-sale-on-event render; catch-all excluded from event counts,
   schedule lists, and timesheet overlap; activity totals include catch-alls;
   no check-in affordance on a catch-all page.
