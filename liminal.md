# Liminal: the page-refresh and dependency model

How liminal pages stay in sync with the database after mutations: the
dependency-key vocabulary, the registration and emission rules, the one-trip
speculative refresh, and the debug tooling.  This documents the conventions as
much as the code — the code enforces some of them, but several live only in
discipline, and this file is their home.

Written 2026-07-03, after the change series that built it landed
(`speculative refresh: ...` and `dependency model: fk-scoped keys ...` on main;
long-poll liveness followed on the same day).  Remaining future work
(fine-grained insert/delete) is in `liminal-refresh-future-work.md`.

## The model in one paragraph

Pages are server-rendered documents that are *coincidentally editable*.  Every
mutation is a button (immediate / confirm / modal-of-action-arguments,
`liminal/action.ts`).  Fragments of a page that the page's own buttons can
change REGISTER dependency keys (CSS classes naming the data they render);
mutations EMIT dirty keys (derived automatically from table metadata); after a
mutation, the client refreshes exactly the registered fragments whose keys were
emitted — usually in the same round trip as the mutation itself, via
speculation.  The machinery reflects a page's OWN edits back into that page; it
is deliberately **not a live-update system** — cross-user liveness is a
separate, per-fragment opt-in (`lm-live`, below) reserved for the few genuinely
shared surfaces.

## Dependency keys

Three granularities, all single-integer keys (no compound keys):

| key form              | meaning                                             |
|-----------------------|-----------------------------------------------------|
| `-table-`             | the whole table: any subset that is not a pk or single-fk select (whole renders, aggregates, SUM()s) |
| `-table-<pk>-`        | one row                                             |
| `-table-<fkname>-<v>-`| the rows WHERE fkname = v (a nested list)           |
| `-table-<fkname>-<v>-shape-` | that subset's SHAPE — membership and order only, not member content |
| `-table-shape-`       | the whole table's shape                             |

- **Class form vs selector form.**  Fragments carry the *bare* class form
  (`-task-project_id-88-`); mutation targets / speculation deps / reload calls
  use the *dotted selector* form (`.-task-project_id-88-`).  `sel(key)`
  (liminal/table.ts) converts.
- **Mint through the helpers**: `Table.tableKey()`, `Table.rowKey(id)`,
  `Table.fkKey(fkName, v)`, `Table.shapeKey(fkName, v)`, `Table.tableShapeKey()`
  — the fk mints validate fkName against the declared `ForeignKeyField`s and
  throw on a typo (so a misspelt key fails at render time instead of silently
  never matching).
- **Keys are opaque strings everywhere except the mint.**  Nothing parses them
  (the one soft exception: keys are recognizable by the `-...-` class shape —
  see liveness watch-key extraction).  Hand-minted keys remain legal for cases
  the vocabulary can't express — e.g. the polymorphic
  `-owner_tasks_<table>-<id>-` (rabid/task.ts), and the wordwiki lexeme editor's
  `-entry-`/`-fact-`/`-rel-<id>-<tag>-` family (a separate assertion-model
  world that hand-emits its targets).
- Unmatched keys are cheap: a failed querySelectorAll.  Sparse registration is
  what keeps uniform emission affordable.

## Registration (the DOM side)

A *reloadable fragment* is an element carrying dep-key classes plus its own
re-render route: `hx-get=<route expr>`, `hx-trigger="reload consume"`,
`hx-swap="outerHTML"`.  The `consume` modifier matters: htmx.trigger events
BUBBLE, so without it a nested fragment's reload would also fire every
ancestor fragment's listener (whole wrappers re-rendering on member
refreshes — visible on the long-poll path, which reloads via events).
Mint with `reloadableProps(keys, reloadURL, extraProps)`
(liminal/table.ts); `Table.reloadableItemProps(id, url)` is the row/table
shorthand.  NOTE: `extraProps.class` *overwrites* the keys class — merge classes
yourself if you must (or use a purpose-built wrapper like `liveReloadableProps`).

**Rule 1 — finest sufficient key(s), exclusively.**
A fragment registers the narrowest keys that cover what it renders:

- single row by pk → `-t-<pk>-` only (rows do NOT co-register the table key);
- `WHERE fk = v` query whose member content renders INLINE →
  `-t-<fkname>-<v>-` only (the checklist, the check-in roster);
- a **delegating wrapper** — a `WHERE fk = v` list whose member rows are
  themselves nested self-refreshing fragments — registers the SHAPE key
  `-t-<fkname>-<v>-shape-` only: inserts/deletes/moves re-render the list,
  member-content edits refresh just the member's own fragment (the project
  task list is the exemplar; pair it with a small content-keyed fragment for
  anything content-derived in the wrapper, like the "N open" count).
  CAVEAT: a list ORDERED BY member content (name-ordered lists) has shape
  that depends on content — shape-keying it requires declaring the order
  column in `shapeFields`, which wins little; leave those content-keyed;
- whole-table render / aggregate / any other subset → `-t-`;
- a fragment may register several keys (a join, a multi-table view: the
  volunteer Time view registers `-timesheet_entry-volunteer_id-<v>-` AND
  `-event_checkin-volunteer_id-<v>-`).  In practice most fragments register
  only their primary table and accept staleness on joined labels.

**Rule 2 — register only what this page's own buttons can change.**
Editable pages, not a live system.  A read-only report registers nothing (it is
naturally inert anyway — refresh only runs during a page-local tx round).  A
read-only summary ON an editable page (a count the page's checkboxes affect)
*should* register.  A context that renders a shared *editable* view read-only
wraps it in class **`lm-read-only`**: everything under such an element is
excluded from refresh participation (not collected as a speculated section, not
reload-triggered — `lmRefreshable` in resources/liminal-scripts.js).
`lm-read-only` suppresses REFRESH only, not affordances — pair it with the
usual canEdit paths rendering the view affordance-less.

**Nesting.**  When a dirty set matches both a wrapper and fragments inside it,
only the wrapper reloads (`removeContainedRoots`).  Fragment routes render
BARE content — add/edit affordances that must survive a reload live *outside*
the fragment (see the checklist comment in rabid/task.ts).

## Emission (the mutation side)

**Rule — all levels, always, automatically.**  Every row write emits `-t-`,
`-t-<pk>-`, and `-t-<fkname>-<v>-` for every declared FK: the *before-row's*
values always (the parents whose subsets contain the row), plus the *new*
values of any fk the write changes (the parent the row joins).  SHAPE keys are
emitted when the subset's membership or order may have changed: always on
insert and delete; on update only when the write moves the row between fk
subsets (both the old and new value's shape keys) or touches a
**`Table.shapeFields`** column (default `['order_key','deleted'] ∩ declared` —
the framework's ordering and soft-delete conventions; override where a table's
list queries order/filter membership by something else).  Writers tell the
whole truth at every granularity; readers control their refresh cost by
registering precisely.

- Derivation: `Table.dirtyKeysFor(kind, pk, beforeRow, changedFields)` — one
  source of truth, shared with the speculation defaults (kind `'all'` is the
  speculation superset: everything derivable from the record at render time;
  over-speculating is free, sections only render for actually-emitted keys).
- The funnels: `Table.insert` / `Table.update` (delegates to) /
  `Table.updateNamedFields` / `Table.delete` all record automatically.
  `Table.delete` is deliberately not `@route`d — declare deletion routes per
  table with their own permission checks.
- The collector (`liminal/dirty.ts`): an ambient per-request `Set` in its OWN
  AsyncLocalStorage (separate from the security context, so `runSystem` blocks
  inside mutations don't drop it).  `rpcHandler` installs it around the
  mutation dispatch only, and merges the collected keys into the response's
  `targets`.  Without a collector (scripts, seeding, direct table calls in
  tests) `record()` is a silent no-op and the DML layer skips even the
  before-row read.
- **Mutations return bare `{action:'reload'}`** — no hand-assembled target
  lists.  Hand-written `targets` still merge (union, deduped) where they exist.

**Escape hatches** (both directions, both deliberate):

- *Raw SQL writes* (the rare multi-row deletes, session tables, etc.) call
  `dirty.record([sel(...)])` by hand at the site — see the event
  commitment/checkin deletes in rabid/event.ts for the exemplar.
- *Deliberately-silent writes*: a write whose consumers are not page fragments
  may stay raw with NO record — `rabid.task.touch` (last_change_time bump on
  every subtask mutation; its consumer is the change-poll, and emitting would
  cascade task-block re-renders on every checklist tick).  Comment the why at
  the site.

## The mutation round trip

Client dispatch is a tagged template (resources/rabid-scripts.js, shared by
rabid and wordwiki's htmx pages):

- `` tx`rabid.task.moveUp(7)` `` — plain: server answers
  `{action:'reload', targets:[...]}`; client matches the selectors against the
  DOM, prunes contained roots and `lm-read-only` zones, and htmx-refetches each
  fragment.  Two trips (apply, then the fragment fetches).
- `` txd(deps)`...` `` — **speculative**: `deps` is the dirty set the button
  expects (selector strings).  The client resolves them against the DOM
  *before* sending and ships the matched fragments' reload routes in the body
  (`$speculate: {deps, sections:[{url, keys}]}`).  The server
  (`applySpeculation`, liminal/liminal.ts) partitions the actual dirty set:
  - **anticipated** (∈ deps) keys get their sections rendered into the same
    response — `{action:'swap', sections:[{url, html}], targets, reloadTargets?}`;
  - **leftover** keys ride back as `reloadTargets`; the client reloads only the
    ones that match something not already swapped fresh, and silently prunes
    the rest (a new row's pk, a provenance fk's value — routine emission noise);
  - nothing anticipated / malformed / over the 20-section cap / a section
    render error → plain reload annotated `speculation:'miss'|'error'|'skipped'`.

  Section urls are client-supplied strings: they are dispatched through strict
  routeterp as GETs under the actor's own ambient context — exactly the trust
  of a GET the client could already issue (mutations, denied, and undeclared
  routes all throw → fallback).
- Buttons declare deps via `ActionMode.deps` (liminal/action.ts, immediate and
  confirm modes); record-edit forms get them automatically —
  `Table.renderForm`'s default dispatch is
  `txd(speculatedSaveTargets(record))`, whose default derives from
  `dirtyKeysFor` on the render-time record.  Overriding
  `speculatedSaveTargets` should be rare: unforeseeable keys just become
  pruned/reloaded leftovers, not misses.
- Client swap mechanics: manual `replaceWith` + `htmx.process()` on every
  inserted element (re-binds hx- attributes) + `initPickers(document)`
  (TomSelect re-enhancement normally rides htmx:afterSwap, which manual swaps
  never fire).  Fragments that vanished mid-flight fall back to a reload of
  their keys.
- Other response actions: `alert` (toast), `open` (new window + optional
  targets reload).  All mutation responses flow through one chokepoint in
  `rpcHandler` — which is also where the future liveness dirty-log appends.

## Refresh debug mode

`lmDebugRefresh(true)` in the console (localStorage-persisted;
resources/liminal-scripts.js).  Each tx round:

- clears the previous round's marks, then outlines every refreshed fragment —
  **green** = refreshed and actually different, **yellow** = refreshed but
  byte-identical (pure over-refresh; judged by isEqualNode with transient
  classes stripped);
- a fixed badge reports the path: `1-trip · N changed · M unchanged`,
  `1-trip (partial +K reload)` (a leftover key matched something — real
  under-speculation), `2-trip fallback (miss|error|skipped)`.

Use it to tune: yellow marks = over-registration or over-emission worth
narrowing; chronic `partial`/`miss` = a button's deps need enriching.  Live
rounds show as `live · ...`.

## Long-poll liveness (opt-in)

For the few surfaces several people genuinely work at once (a task checklist,
an event-day check-in roster), a fragment can additionally track OTHER actors'
edits: mint its props with `liveReloadableProps` (adds class `lm-live`).  When
a page contains a live fragment, a poller (resources/liminal-scripts.js)
long-polls the app's `livePoll` route with the union of the live fragments'
dep keys; every mutation's dirty set is appended to an in-memory log
(`liminal/live.ts` LiveLog, appended by `recordLiveActivity` in rpcHandler),
and an intersecting append answers the parked poll — the changed keys then run
through the ordinary `reload()` front door, so pruning, `lm-read-only`, and
debug marking behave exactly like the page's own rounds.

Conventions and behaviors to know:

- **Keep `lm-live` rare** — it is not a general live-update switch, and coarse
  keys on live fragments wake the watcher on every same-table write.
- **Shape-keyed live wrappers need a content antenna.**  A delegating wrapper
  watches only its shape key, so foreign member-CONTENT edits wouldn't wake
  the poll — give the page one small content-keyed `lm-live` fragment (the
  project page's "N open" count): its watch key wakes the poll, and the
  entry's row keys then reload the edited member fragments themselves.
- Mutation responses carry `{seq, epoch}` (the log position); the client uses
  them for **echo suppression** (its own edits come back on the poll too) —
  entries are queued and drained only when no rpc is in flight, the modal
  editor is closed, and neither focus nor a text selection sits inside an
  affected fragment.
- `epoch` detects server restarts; a stale cursor answers `resync:true` and
  the client reloads everything it watches.  The log is a bounded ring — a
  freshness hint, not a durable event stream.
- The poller uses plain fetch (never `rpc()` — a parked poll would count
  against the storm watchdog) and PERMANENTLY stops when the session dies
  (401/403, or the 200 HTML login page that denied anonymous POSTs bounce to).
- Same honesty limits as the whole model: only declared dirties reaching
  rpcHandler are logged.

## Recipes

**A new reloadable fragment**: give it a `@route(authenticated)` render method
taking the ids it needs; mint props with `reloadableProps([finest keys], url)`;
render bare content (affordances that must survive reloads go outside).  Only
do this on pages whose buttons can change the data (Rule 2).

**A new mutation**: write through the Table funnels (`insert`/`update`/
`updateNamedFields`/`delete`) and `return {action:'reload'}` — emission and
response targets are automatic.  Raw SQL → hand `dirty.record`.  Give its
button `deps` (usually one `sel(fkKey(...))` or `sel(rowKey(id))`).

**A new table**: declare FKs as `ForeignKeyField` (emission and `fkKey`
validation depend on it); polymorphic (owner_table, owner_id) pairs can't be
FK fields — hand-mint their keys and hand-maintain their targets.

**A page with filters / paging / view state** (a search box, a "show all"
toggle, a date range): the view state rides in the route expression as a `{}`
argument decoded by a `FieldSet` — see **liminal/page-state.md** (rabid
worked example: `volunteer.search`).  Filter changes navigate
(`{action:'navigate', url}`); depth/refinement toggles swap the fragment and
`hx-replace-url` the page URL.

**Tests**: direct table calls have no collector — assert on merged targets via
`invoke()` (both testing.ts harnesses install the collector, mirroring
rpcHandler) or `withDirtyTargets(fn)`.  Emission specifics live in
rabid/dirty_keys_test.ts; speculation semantics in
rabid/speculative_refresh_test.ts.

## Known limitations (accepted)

- The dirty log of record is *declared* dirties: direct db writes, imports,
  and other processes are invisible (the server author asserts what changed —
  the same trust model throughout).
- A whole-table-registered fragment refreshes on any same-table write —
  including a row pencil-save on a list page (the list swaps, not just the
  row).  Honest per the model; the pressure valves are fk-key registration,
  the future insert/delete mechanism (future-work §2), and the debug mode.
- rabid mutations are not transaction-wrapped: a mid-mutation throw can leave
  committed rows that were never emitted (the erroring page doesn't refresh
  either — consistent — but other viewers stay stale until a full load).

## File map

| what | where |
|------|-------|
| dep-key mint, registration props, DML emission, speculation defaults | liminal/table.ts |
| ambient dirty collector | liminal/dirty.ts |
| liveness log (LiveLog) | liminal/live.ts |
| rpcHandler merge, applySpeculation, recordLiveActivity, livePoll, response protocol | liminal/liminal.ts |
| action buttons + deps, param dialogs | liminal/action.ts |
| tx/txd, reload front door, swap mechanics, speculation resolution | resources/rabid-scripts.js |
| lmRefreshable / lm-read-only gate, debug mode, liveness poller, modal editor | resources/liminal-scripts.js |
| debug mark styles | resources/liminal.css |
| on-page view state (filters/paging in the URL, FieldSet) | liminal/page-state.md |
| remaining future work (fine-grained insert/delete) | liminal-refresh-future-work.md |
