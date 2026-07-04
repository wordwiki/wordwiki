# Liminal: page-refresh, dependency, and page-state conventions

The load-bearing liminal page-authoring conventions — the ones that live in
discipline, not (only) in code, and are hard to infer from a fresh read.  Two
big topics:

1. **Refresh / dependency model** — how pages stay in sync with the db after a
   mutation: the dependency-key vocabulary, registration/emission rules, the
   one-trip speculative refresh, opt-in liveness, and the debug tooling.
2. **On-page view state** (near the end) — how a page's filters / paging /
   anchors live in its route expression as `{}` arguments decoded by a
   `FieldSet`, so every view is bookmarkable, refreshable, and testable.

Written 2026-07-03 (refresh model; `speculative refresh` + `dependency model:
fk-scoped keys` + long-poll liveness landed that day); the on-page-state
section merged in from the former `liminal/page-state.md` after the rabid
conversion.  Remaining refresh future work (fine-grained insert/delete) is in
`liminal-refresh-future-work.md`.

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

## On-page view state (filters, paging, anchors)

*(Formerly liminal/page-state.md.  Read this before building any page with
filters, paging, time anchors, or other view state.  Machinery:
liminal/table.ts `FieldSet`, liminal/action.ts `renderParamForm`, the
`navigate` tx action in resources/rabid-scripts.js.  Worked examples:
wordwiki/change-feed.ts and wordwiki/activity-report.ts; rabid/volunteer.ts
`volunteer.search` (the filter → navigation case) and rabid/volunteer_time.ts's
Time view (a configurable SECTION with hx-replace-url depth toggles).)*

### The principle

A page's view state (filters, depth, time anchors) lives in its route
expression, as `{}`-literal arguments:

    /ww/wordwiki.changes({to_time:215001495719999,restrict_to_user:"djz"})
    /rabid.volunteer.search({text:"Dav",include_archived:true})

The page render is a **pure function of its arguments**.  Everything follows:
every view is bookmarkable, refreshable, and shareable (including scroll-back
depth); tests render views by constructing the arguments — no browser or
session; and there is no hidden DOM/session state to drift.

Two load-bearing decisions (dz):

- **Do not privilege a textual base-URL.**  URLs here are composable route
  expressions.  A `{}` value is an ordinary argument, composed into the route
  expression like any other (`${R}.page(${fs.literal(q)})`).
- **One schema mechanism.**  The same `Field` objects that define a db table
  (`Table extends FieldSet`) define page queries: the URL codec, the
  auto-generated filter dialog, and the typed in-code value are ONE declaration.

### The unit of state is the SECTION, not the page

A `FieldSet` is a codec for exactly ONE `{}` value — and that one-ness is
**per configurable section, not per page**.  A page with several
independently-configurable parts (multiple filtered widgets, "more" buttons on
separate lists, embedded sub-renderers) carries several `{}` arguments, one per
section, each with its own FieldSet:

    /ww/x.page({from_time:...,max_rows:200}, {status:"pending"})
                ^ the change-list section     ^ the sidebar section

Do NOT merge a page's state into one grand `{}` block.  Merging breaks the
mechanism's own affordances: the auto-generated dialog edits a FieldSet's
FIELDS, so a merged block would make every filter dialog show every section's
knobs; a depth bump ("Show older") on one list would have to understand and
re-emit every other section's state; and two sections couldn't evolve their
schemas independently.  Each section instead (a) normalizes ITS argument and
renders as a pure function of it, (b) generates ITS dialog from ITS fields
(`renderParamForm(fs.fields, ...)`), and (c) emits new-state URLs by
re-composing the FULL route expression — its own argument via `literal`, the
OTHER sections' arguments passed through verbatim.  Single-section pages (the
feed, the activity report, volunteer.search) take one `{}` arg — the common
degenerate case, not the model.  (rabid's volunteer detail page IS multi-
section: the volunteer record and the Time view are separate `{}`s.)

### FieldSet: the codec (liminal/table.ts)

`FieldSet` is the extracted base of `Table`: an ordered set of named `Field`s
describing one record-shaped value, with no persistence.  A page query uses it
directly:

```ts
export const volunteerQuery = new FieldSet('volunteer_query', [
    new StringField('text', {prompt: 'Name or email starts with…', default: ''}),
    new CheckboxField('include_archived', {prompt: 'Include archived', default: false}),
]);
export interface VolunteerQuery extends Tuple {   // the typed view of the same thing
    text: string; include_archived: boolean;
}
```

Three codec operations:

- **`normalize(q)`** — route-literal → value, the per-route GUARD (route args
  are user-typeable text): unknown keys rejected, each present value
  type-checked/coerced by its field's `fromLiteral`, absent/null → the field's
  `default` (or null).  Every route method begins
  `const query = fs.normalize(q) as MyQuery;`.
- **`literal(q)`** — value → canonical route literal.  Declaration order; null
  AND default-valued fields OMITTED, so common views get the shortest — and
  *equal views get equal* — URLs.  Strings JSON-quote (JSON ⊂ the route
  grammar).  The inverse of normalize.  **Always emit URLs through `literal`,
  never by string-building**, or canonicality drifts.
- **`parseFormValues(form)`** — filter-dialog postback → COMPLETE value (empty
  inputs fall to default/null).  Contrast `parseFormChanges` (the record-EDIT
  parse, which extracts only fields changed against `before-<name>` snapshots):
  a query dialog's submitted state IS the new value, so it uses the complete
  parse.

**Field types by app** — the same query, two clocks:

- **wordwiki** (versioned/HLC store): `TimestampField` codecs the raw
  hybrid-logical-clock NUMBER to `datetime-local` and local display (from/to
  time ranges).
- **rabid** (SQLite date strings): a date/time filter uses `DateField`
  (`YYYY-MM-DD`) or `DateTimeField` (`YYYY-MM-DD HH:MM:SS`) — NOT
  `TimestampField`.  Both validate STRUCTURALLY in `fromLiteral` (a hand-typed
  URL can't smuggle junk into a date filter), matching their `parseSimpleInput`
  bar: shape, not calendar validity (so a URL date and a form date agree).
- **either**: a boolean knob rendered as a checkbox is `CheckboxField`, whose
  whole codec is boolean, so `flag:true/false` round-trips canonically.
  `EnumField` renders a select from a `Record<value,label>`.
- **subclass `fromLiteral`** to loosen or tighten: change-feed's `UserField`
  LOOSENS (the dropdown offers known editors, but any historic username stays
  URL-typeable and filterable); the rabid date fields TIGHTEN.

Nullable-with-default vs nullable-no-default matters: `max_rows` has
`default:1000` so it always normalizes to a number; `months` has NO default so
null survives normalize and means "no limit" (activity-report.ts).

### The page pattern

```ts
const R = '/rabid.volunteer';                     // the routes' prefix

@route(authenticated)
search(q?: Record<string, any>): templates.Page { // (or | server.Response if it stamps)
    const query = volunteerQuery.normalize(q) as VolunteerQuery;
    return templates.page('Title', [
        header,
        filterSummary(query),                      // quiet "N matching X"
        action.actionButton('Search…',
            {kind: 'modal', dialogUrl: `${R}.searchDialog(${volunteerQuery.literal(query)})`}, ...),
        this.renderBody(query)]);                  // pure function of query
}

@route(authenticated)
searchDialog(q?: Record<string, any>): Markup {    // AUTO-GENERATED from the fields
    const query = volunteerQuery.normalize(q);
    return action.renderParamForm(volunteerQuery.fields, query, {
        title: 'Search…', submitLabel: 'Search',
        dispatch: {onsubmit: 'event.preventDefault(); tx`rabid.volunteer.applySearch(${getFormJSON(event.target)})`'}});
}

@route(authenticated)
applySearch(form: Record<string, any>): any {      // form → canonical URL → navigate
    const query = volunteerQuery.parseFormValues(form);
    return {action: 'navigate', url: `${R}.search(${volunteerQuery.literal(query)})`};
}
```

`renderParamForm` renders each field with its own widget (date pickers,
selects…), pre-filled from the current value — the dialog IS the schema, so
adding a field to the FieldSet adds it to the URL, the dialog, and the typed
query at once.  Two dispatch details:

- **The form navigates SERVER-side.**  The dialog dispatches an `applyFilter`
  route that runs `parseFormValues → literal` and returns
  `{action:'navigate', url}` (the `navigate` tx action does
  `window.location.assign`, a real history entry).  The old client-side
  route-builder `lmNavigateFormRoute` is RETIRED — it couldn't omit defaults,
  reject unknown keys, or coerce types.  (A tab whose loaded JS predates the
  `navigate` action makes Apply a silent no-op; a reload fixes it — resources
  revalidate via etag, but an OPEN tab keeps its in-memory scripts.)
- **Showing the modal**: wordwiki dialogs prepend an inline
  `['script',{},'setTimeout(showModalEditor)']`; rabid dialogs are opened by an
  `actionButton({kind:'modal'})` whose `after-request` already runs
  `showModalEditor()`, so they don't need the inline script.

### State-change taxonomy: navigation vs replacement

Two kinds of state change, deliberately different in history behavior:

- **Filter changes are REAL navigations** (`{action:'navigate', url}` →
  pushState).  Distinct filters are distinct views; Back walks filter history.
- **Depth/refinement changes replace in place.**  The feed's "Show older"
  (bump `max_rows`) and volunteer_time's "Show all weeks" / orphan-tasks
  toggles are the SAME view refined: the button `hx-get`s the fragment route
  with the new literal, `hx-swap`s the fragment, AND carries
  `hx-replace-url=<page URL with the new literal>` (replaceState — depth is
  always in the URL so refresh keeps it, but Back leaves the page rather than
  un-toggling).  htmx `hx-replace-url` is core, no client plumbing.

### Temporal anchors: stamp or drift, choose per page

- **Stamp** (the feed): a visit with no `to_time` redirects
  (`server.forwardResponse`) to the canonical URL with it stamped at the db's
  top tx timestamp — the anchor rides in the browser URL (survives
  refresh/Back), past-anchored pages are immutable, and it doubles as the
  review-sitting `since`.
- **Drift** (the activity report, and rabid's "recent"/"upcoming" windows): a
  live dashboard — "the last 12 months" should move with today.  Reproducibility
  lives in the LINKS it emits (absolute closed ranges).

Pages are served no-store (bfcache defeated); the page must be cheap to
re-render, which the purity discipline gives you.

### Counts must be their links

When a report links into another view (activity counts → feed pages), the two
must compute from the SAME predicate — import the predicate, don't re-derive
it.  A number that opens a page showing a different number is worse than no link.

### Testing & gotchas

Purity makes tests cheap: `markupToString(x.renderBody(fs.normalize({...})))`
over the in-memory fixture; assert canonical URLs EXACTLY
(`rabid.volunteer.search({text:"Dav"})`); pin any redirect stamping
(`isRedirectResponse` + Location); pin EXPLAIN QUERY PLAN per query shape
(export the shapes so the test can't drift from the impl).  Examples:
change-feed_test.ts, activity-report_test.ts, rabid/page_state_test.ts.

- `literal` omits defaults: changing a field's `default` silently changes which
  URLs are canonical (old URLs still normalize fine).
- Braces in URLs: browsers percent-encode transparently; curl does NOT (its
  `{}` globbing mangles them) — encode `%7B`/`%7D` when testing by hand.
- `normalize` treats absent and null identically (both → default/null); only
  round-tripping through `literal` preserves canonicality.
- A FieldSet field name is also its form-input name and its URL key: renaming
  breaks old bookmarks (old keys are REJECTED by normalize, by design).
- The URL path is STRICT (normalize rejects/coerces); the form path is LENIENT
  (parseFormValues stringifies, empty→default) — the right asymmetry, since a
  real browser form is always strings.
- Server-rendered relative times / "now"-dependent labels age in an open tab
  until a fragment reload; anchor-stamped pages avoid the worst of it.

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
argument decoded by a `FieldSet` — see the **On-page view state** section above
(rabid worked example: `volunteer.search`).  Filter changes navigate
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
| on-page view state (filters/paging in the URL, FieldSet) | this file, § On-page view state |
| FieldSet codec (normalize/literal/parseFormValues), field types | liminal/table.ts |
| remaining future work (fine-grained insert/delete) | liminal-refresh-future-work.md |
