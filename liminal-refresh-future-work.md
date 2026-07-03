# Liminal refresh: future change sets

Two follow-on designs to the speculative one-round-trip refresh + debug mode work
(see that change set / `.claude/plans/buzzing-squishing-hamming.md`).  Both were
discussed and shaped 2026-07-03; neither is built.  Both treat the dep-key
vocabulary (`.-table-`, `.-table-id-`, future FK-scoped keys) as opaque strings
and ride the same chokepoints, so nothing in the current change set blocks them.

A shared amplifier for both: **FK-scoped dep keys** (e.g. `.-task-project-88-`,
"all tasks on project 88").  Planned separately; both designs below get markedly
better once list fragments carry list-specific keys instead of the bare table key.
Migration rule when that lands: mutations emit both the fine key and its coarse
parent; fragments narrow their tagging at leisure (over-emission is harmless,
like over-speculation).

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
