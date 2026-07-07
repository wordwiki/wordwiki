---
name: event-centric-activity-model
description: rabid activity (services/sales) is logged THROUGH events; per-day Ad-hoc catch-all events absorb drop-in work
metadata: 
  node_type: memory
  type: project
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

The **event is the aggregate root for activity** in rabid (landed on main 2026-07-07, branch `day-log-refactor`; design doc `rabid/event-centric-design.md`). Services and sales are entries in the log of *what happened at an event*, not standalone records. Rule of thumb: an *interaction* is event-shaped (service, sale/giveaway, attendance); a *durable entity* is not (volunteers, bikes-as-assets, committees stay first-class, referenced from events).

Key mechanics:
- `service.event_id` and `sale.event_id` are **mandatory** (`sale` gained `event_id` — it was previously fully detached). `sale.ts` models free bikes (`free-bike`/`free-kids-bike`/`free-helmet`/`balance-bike-loan`).
- **Catch-all "Ad-hoc" events** absorb drop-in work not tied to a scheduled event: `event.is_catch_all` + `event.catch_all_date` (its SOLE day encoding; NULL start/end times), one per calendar day via a partial unique index. `event.catchAllForDate(day, create=false)` / `catchAllForToday(create)` — lazy find-or-create, race-safe, mirrors `project.forOwner`. Labelled `Ad-hoc — <Mon D>` via `recordLabel`.
- Catch-alls carry **no attendance** (`renderEventSummary` suppresses sign-up/check-in when `is_catch_all`) and are **kept out of event lists/counts** (the events-page `matches()` predicate excludes them; NULL times keep them out of dated/schedule/timesheet-overlap paths structurally).
- Event page **Activity** section = two independent reloadable sub-sections, `renderEventServices` / `renderEventSales`, each keyed on ONLY its own table's event fk (`-service-event_id-N-` / `-sale-event_id-N-`) with its own ☰ Add menu. Add mutations (`addServiceForEvent`/`addSaleForEvent`, host/admin) return a `{action:'reload', targets}` directive — NOT a bare id (a bare return makes the client `tx` handler throw; see [[route-undeclared-bug-pattern]] neighbourhood of gotchas).
- **"Today's log"** navbar link (host/admin, `isHostOrAdmin` nav flag) → `/todaysLog` → `catchAllForToday(create=true)` then renders that event. NOTE: opens/creates the catch-all on view, not lazy-on-first-add (a flagged behaviour choice dz may revisit).
- `/service` and `/sales` are **retired from top nav** — relocated under the Reports menu + a home-page entry (not deleted; the routes still back those report views).
- Fake data: `seedActivity` seeds services/sales on past events + 2 Ad-hoc days; runs LAST in `seedScenario` so catch-alls it creates get no commitments/check-ins.

Aligns with [[design-language]] (event page = a document/log) and [[liminal-refresh-model]] (dep-key fragments).
