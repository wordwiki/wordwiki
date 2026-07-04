# Liminal refresh: future change sets

Follow-on designs to the speculative one-round-trip refresh + debug mode work.
Discussed and shaped 2026-07-03.  **Status: #3 (richer dependency model) and
#1 (long-poll liveness) are now BUILT** — #3: `liminal/dirty.ts`,
`Table.dirtyKeysFor/fkKey/delete`, `reloadableProps`, the hybrid
`applySpeculation`, the `lm-read-only` gate; #1: `liminal/live.ts` (LiveLog),
`recordLiveActivity`/`livePoll`/`liveClientConfig` in liminal.ts, the poller in
resources/liminal-scripts.js, `liveReloadableProps` opt-in (rabid checklist,
project task list, event check-in roster).  §1/§3 below are kept as design
rationale; the conventions live in `liminal.md`.  Only #2 remains.

Implementation notes that refined §1's design (validated + built):
- Anonymous polls come back as the 200 HTML login page (loginRouteFor bounces
  POSTs too) — the client permanently stops on any 2xx that isn't a JSON poll
  answer, not just 401/403.
- Echo suppression is per-ENTRY, not cursor-advancing: mutation responses carry
  the log seq; the client queues poll entries and skips noted own seqs at drain
  time, deferring the drain while its own rpc is in flight (the append happens
  after applySpeculation, but the poll answer can still race the mutation
  response).
- Known ceiling: HTTP/1.1 dev serving means ~6 connections per origin across
  tabs; many simultaneous tabs of one checkout can queue requests behind the
  parked polls.  If it bites: SharedWorker/BroadcastChannel leader election.

Two contract points settled while building #3 (also documented in code):
- **Editable pages, not a live system**: fragments register only what the
  page's own buttons can change; read-only contexts wrap shared views in
  `lm-read-only` (suppresses refresh participation, not affordances).
- **Registration = finest sufficient key; emission = all levels, uniformly**
  (table + pk + every declared fk, before-values + changed new values), with
  `task.touch`-style deliberately-silent raw writes as the documented escape
  hatch in the other direction.

---

## 1. Live refresh (long-poll + server dirty log)

**Goal.**  Some fragments (opt-in, e.g. a shared task checklist) update live when
another actor changes their data.  Explicitly NOT for everything: whole-table
watchers would thrash, and unsolicited swaps can steal focus.

**Design.**

- **Server dirty log.**  Mutations already declare their dirty sets in the
  `{action:'reload'|'swap', targets}` return value.  After the speculative-refresh
  change set, every mutation's actual targets pass through ONE chokepoint in
  `LiminalApp.rpcHandler` (the `applySpeculation` call site) — the dirty log is an
  append there, on both the hit and fallback paths.  In-memory ring of
  `(seq, key)` with a monotonic sequence number; fine for a single-process Deno
  server.  Restart resets the seq; clients detect the reset and resync with a
  full refresh.
- **Client.**  Opted-in fragments carry a marker class (say `lm-live`) alongside
  their dep classes.  The watch set is the union of dep keys on live fragments
  currently in the DOM.  Long-poll `{sinceSeq, keys}`; server answers when the log
  grows an intersecting entry (or on timeout) with `{seq, changedKeys}`; client
  runs the existing `reload(changedKeys)` front door (pruning, htmx re-fetch,
  debug marking all come free).
- **Transport.**  Long-poll over the normal route machinery, patterned on the
  existing browser-test bridge (`testClientPoll` / `BrowserAgentChannel`,
  25s poll timeout, liminal/liminal.ts).  SSE deliberately not chosen (first cut).

**Design points settled in discussion.**

- **Echo suppression:** the tab that performed a mutation would hear its own
  change back and refresh twice.  Fix: mutation responses (swap and reload alike)
  carry the log `seq`; the client advances its poll cursor past its own writes.
  Response JSON is extensible — nothing to pre-build.
- **Disruption control:** besides per-fragment opt-in, suppress live swaps while
  the modal editor is open, and skip/queue any fragment containing
  `document.activeElement` or an active text selection until blur.  An outerHTML
  swap under the user's cursor is the failure mode to design against.
- **Honest limitation:** the log sees only *declared* dirties through the route
  layer — a direct db write or an import script is invisible.  Same trust model
  as the whole reload contract (the server author asserts what changed).
- **Granularity pressure:** watching a coarse `-task-` key means every task
  mutation wakes every watcher.  Live refresh is what will make FK-scoped keys
  pay for themselves — expect it to pull that extension forward.
- The refresh **debug mode** (current change set) marks live-poll refreshes like
  any other round, so over-watching is directly visible.

---

## 2. Fine-grained insert/delete (stop re-rendering the whole list)

**Partially superseded (2026-07-03): SHAPE KEYS are built** — see liminal.md.
Delegating wrappers now register `-t-<fk>-<v>-shape-` and member-content edits
no longer re-render lists at all; only genuine shape events (insert / delete /
move / archive-flip) swap the wrapper.  What remains of this section is the
finer-still directive for those shape events themselves: inserting/deleting
ONE row without re-rendering the whole wrapper (the anchor/insert-directive
mechanics below), plus the name-ordered-list adoption caveat (their order
depends on member content, so shape-keying them needs the order column in
shapeFields — adopt per list when worth it).

**Goal.**  Insert/delete of a row currently dirties the whole-table key and
re-renders every list wrapper.  Very common actions (add a service line for the
day) do lots of unnecessary refresh.  Reordering is rare enough not to care.

### Delete: nearly free, no new mechanism

Convention: a row-render route for a record that no longer exists renders
**nothing**; the delete mutation dirties the ROW key (`.-service-123-`) instead of
the table key.

- Speculative path: the swap handler replaces the element with zero nodes.
- Fallback path: htmx swaps the empty response over the row with `outerHTML`.
  Implementation check: the empty body must be a 200 (htmx ignores 204).
- Aggregates elsewhere (day totals, count badges) are separately-tagged fragments
  the mutation names — unchanged.

### Insert: one new response directive, owned by the list renderer

Key observation: **the anchor row IS the insertion point** — every row already
carries a unique addressable key, so "insert before row 9" is fully expressible
against the DOM as it stands.  (Pre-rendered insertion-point/gap elements were
considered and dropped: a gap per row, stale on reorder, their own dep semantics,
and they add nothing the anchor lookup doesn't give.)

New response element (rides the swap response; NOT a new dependency-key kind):

```js
{action:'swap',
 inserts: [{listKey: '.-service-', anchor: '.-service-9-' | 'start' | 'end',
            html: '<div class="-service- -service-123-" ...>'}],
 ...}
```

The "add" button speculates the list key exactly as today, so the client has
already matched the wrapper(s) at invoke time; the server *downgrades* its answer
from "whole wrapper re-rendered" to "one row + where it goes".  Client inserts
the parsed row at the anchor inside each matched wrapper, `htmx.process` as usual.

**Who computes the anchor: a list renderer that owns the process.**  Placement is
unanswerable without the list's filter + ordering, which live in whatever renders
the list.  So the list-rendering component grows two small responsibilities:

1. `placementOf(newId)` — one cheap indexed query for the id of the next row in
   this list's ordering (`... WHERE <list filter> AND order_key > ? ORDER BY
   order_key LIMIT 1`), or start/end.
2. Owning the HTML contract: *rows of list K are children (or `.lm-rows`
   descendants) of the element tagged `-K-`, in query order, each tagged
   `-K-<id>-`.*  Barely a new constraint — list views already render this shape.

An insert mutation returns `renderer.insertDirective(newId)` when it can, and the
plain whole-table dirty when it can't (grouped lists, computed sections) —
graceful degradation, same spirit as speculation.

**The genuine wrinkle: two lists of the same table, different filter/order,
both on screen.**  An anchor computed for one list's ordering can be wrong for
another.  Rule: **per-wrapper** — if the anchor row exists as a child of this
wrapper, insert there; otherwise that wrapper falls back to its own whole-wrapper
reload (it has its `hx-get` for exactly this).  `'start'`/`'end'` anchors are
ambiguous across differently-filtered lists — when more than one wrapper matches,
insert into none and reload all matched.  FK-scoped keys mostly dissolve this:
distinct lists get distinct keys, each renderer computes placement for its own key.

**Cheaper complementary lever:** htmx's idiomorph extension (`hx-swap="morph"`) —
keep returning the whole list but morph the DOM, so only changed rows repaint and
focus/scroll survive.  Doesn't save server render cost or wire bytes, but kills
the UX disruption of wrapper swaps with near-zero model change, and composes with
everything above (could apply to ALL wrapper-level reloads).  If the pain is
mostly flicker/disruption → morph alone may do; if payload/server work too → the
insert directive is the real fix.  Not mutually exclusive.

**Paths not covered (acceptable):** the two-trip fallback and future live-refresh
paths don't get fine-grained inserts — they reload the wrapper.  Those are the
rare paths.

---

## 3. Richer dependency model: FK-scoped keys + automated emission (NEXT PRIORITY)

**Goal.**  Dep keys become `(table)`, `(table, pk)`, or `(table, fk-name,
fk-value)` — encoding `-table-fkname-v-` beside the existing `-table-` /
`-table-pk-` (all keys single integers; SQL names have no hyphens, so exact
string matching stays unambiguous).  Deliberately modest power: enough to kill
the common global resets (nested lists) without query-level dependencies.
Evidence the scope is right — both current hand-tuned hacks are expressible:

- subtask's `-subtask-<task_id>-` is an FK key in disguise → `-subtask-task_id-<v>-`
  (the saveForm retarget + speculatedSaveTargets override become deletable);
- timesheet's hand-appended `-volunteer_time-<vid>-` rider disappears: the
  volunteer_time fragment tags `-timesheet_entry-volunteer_id-<vid>-` and
  `-event_checkin-volunteer_id-<vid>-` and is notified without any mutation
  knowing it exists.

One `depKey(...)` mint helper; nothing else parses keys.

**The crux: emission must be automated.**  Today only the default
`Table.saveForm` emits automatically; ~40 sites across rabid/wordwiki
hand-assemble `targets`.  Hand-emitting `2 + #fks` keys per write (including
OLD+NEW values when an fk changes) would rot immediately.  Automation is
buildable because the funnel exists — `Table.insert` / `update` /
`updateNamedFields` + declared `ForeignKeyField` metadata:

- **Derive at the DML layer**: any write to T emits `-T-`, `-T-pk-`, and
  `-T-fkname-v-` per non-null declared FK; fk-CHANGING updates read the
  before-row (the save path already loads it) and emit old AND new fk keys.
- **Ambient per-request dirty collector** in its OWN AsyncLocalStorage (NOT on
  the security context — `runSystem` blocks inside mutations would drop keys).
  `rpcHandler` drains it into the response `targets`; mutations return bare
  `{action:'reload'}`.  Hand-added keys remain possible (additive) during
  migration.
- **Gap: deletes** are raw `db().execute` today (e.g. subtask.remove) — add a
  `Table.delete` funnel so the before-row's keys emit (pairs with
  delete-as-empty-render in §2).
- The collector's drain point IS the long-poll dirty log's append point (§1):
  one mechanism, two consumers.

**Consequences to design for.**

- Automated emission notifies MORE than the hand lists did (e.g. subtask.toggle
  → task.touch → `-task-<id>-` now dirties the task block).  Mostly more
  correct, sometimes wasteful — the debug mode's yellow refreshed-but-identical
  marks are the tuning instrument; walk the app with the badge on after landing.
- **Speculation's all-or-nothing subset test becomes too brittle** (a button
  can't speculate a touch-chain → chronic misses).  Soften to a HYBRID
  response: server swaps the anticipated sections AND returns leftover
  unanticipated targets for client-side reload.  Strictly better than both
  current behaviors.  Also derive `speculatedSaveTargets`' default from the
  same mint/emission function — one source of truth.
- wordwiki's `dict` table is not a liminal Table (raw assertion-model DML) —
  lexeme-editor mutations keep hand-emitting or get their own mint helpers.

**Migration property**: automation always emits fine keys AND coarse parents,
so fragments retag from `-task-` to `-task-project_id-88-` one at a time, any
order, no flag day.

**Sequencing**: (1) mint + automated emission collector, debug-mode walk;
(2) retag the worst fragments; (3) hybrid speculation response; (4) long-poll
(§1) on the collector's log, watch sets built from fine keys.
