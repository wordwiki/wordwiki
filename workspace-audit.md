# Audit: datawiki/workspace.ts

*(2026-06-10, post old-editor retirement.  Line numbers refer to the file as
of commit 756364f.  Companion docs: assertion-model.md, lexeme-editor-design.md.)*

> **STATUS: the cleanup below was EXECUTED on 2026-06-10** (same day, after
> first pinning every finding with tests).  Resolved: 1.1 (leak removed with
> the whole proposed-assertion tracking), 1.2 (toJSON cache keyed per flag),
> 1.3 (historicalTupleVersions now really is the PRIOR versions), 1.4/1.5
> (dead scratch + naming/log fixes), 2.1 (per-table fact-id index with
> uniqueness enforced at fact creation + the broken `valid_to = NULL` partial
> indexes in schema.ts fixed — NOTE an existing db keeps its old empty indexes
> until they are dropped by hand), 2.2 (lookups throw; only the apply paths'
> getOrCreate variant creates), 2.3 (tuple-level applies are `_`-prefixed
> internals; VersionedDb is the only guarded door), 2.4/2.5 (ownership and
> load-order contracts documented on the methods), all of §3 (file went from
> ~1030 to ~520 lines), and §4's import/logging trims (including the
> per-call nextTime log in liminal/timestamp.ts).  A bonus demon found during
> the naming pass: the editor's stale MOVE on a deleted tuple would silently
> RESURRECT it (re-assert over the tombstone), and a stale DELETE would chain
> a tombstone onto a tombstone — both now refused/idempotent, with tests.
> Still open by choice: 2.6 (the global-time gate, the future fork/merge
> seam), 2.7 (root-as-empty-record is now documented as the decision), the
> §4.1 deep move of the Assertion type into datawiki, and `currentAssertion`'s
> name (kept for its many callers; its may-be-a-tombstone semantics are now
> documented on the getter).  Suite: 62 tests green.*

## Verdict

The core is sound and now well-tested: the version-chain rules, tombstone
semantics, restore-over-delete, the current-view queries and the order-key
generators all do what the model intends.  The hair is concentrated in four
places: **one real (slow) leak**, **a handful of unenforced invariants** that
the code *assumes* but nothing guarantees, **a large amount of dead scaffolding**
left from the client-editor era, and **an API that exposes its internals**
(callers can reach unvalidated mutation paths, and a read path that mutates).

---

## 1. Confirmed bugs

### 1.1 `proposedAssertions` grows forever on the server (leak)
`VersionedDb.applyProposedAssertion` pushes every assertion onto
`this.proposedAssertions` (line 161).  That array existed so the *client*
editor could drain pending edits to the server (`takeProposedAssertions`).
Verified: **nothing outside this file calls `takeProposedAssertions` any
more** — so the server's singleton workspace accumulates one entry per edit
for the life of the process.  (The objects are also referenced by the tuple
tree, so the waste is array slots, not duplicated assertions — but the
tracking is semantically dead and should go, or move behind an opt-in flag if
the future fork/merge wants it.)

### 1.2 `VersionedTupleQuery.toJSON` caches without keying on `includeHistory`
Line 657: `#json ??= ...` — the first call's `includeHistory` is baked in;
a later call with the other flag silently returns the cached shape.  Harmless
today only because query objects are transient (one render each), but it is a
booby trap for any future caller that holds a query.

### 1.3 `historicalTupleVersions` is mis-named and includes the current version
Line 651: it returns *all* of `src.tupleVersions` (the filter is commented
out).  The history dialog compensates by badging the current row, and the
`toJSON(includeHistory)` "history" array therefore contains the current
version too (the test suite documents this).  Either rename
(`allTupleVersions`) or restore the filter — today the name lies.

### 1.4 `fullLoadTest` is broken (wrong tag) — dead scratch code
Line 975 looks up `childRelations['sp']`; the spelling tag is `'spl'`, so the
CLI test throws if run.  Symptom of the real issue: `jsonTest`/`fullLoadTest`
are ad-hoc scratch `main`s superseded by the real test suite.  Delete them
(and with them the file's `import.meta.main` block and the
`dictSchemaJson`/`wordwiki/schema` *query* imports that exist only for them —
see §4.4).

### 1.5 Misleading log/name details (cosmetic but confusing while debugging)
- `applyServerAssertion` logs "applied **proposed** assertion" (line 491).
- `currentTupleQuerysByRecentness` (line 777) actually sorts **by order key**.
- `getVersionedTupleParentRelation` (line 218) asserts on
  `parentRelation.schema` — a bad tag produces `TypeError: ... of undefined`
  instead of a real error message.
- Both order-key generators' "not found (2)" errors say "before order key"
  even in `generateAfterOrderKey`.

---

## 2. Latent demons (true today, enforced nowhere)

### 2.1 Fact-id uniqueness is assumed, never enforced
`findVersionedTupleById` (line 328) throws if an id appears twice in a
subtree, and the v2 editor addresses tuples by `(entry_id, fact_id)` on the
assumption that ids are unique at least per entry.  Checked the real db: all
176,738 fact ids are globally unique today.  But **no insert path checks
this** — `applyProposedAssertion` would happily create a second fact with the
same id under a different relation (same-relation reuse is accidentally caught
by the replaces-chain check), after which `findVersionedTupleById` throws and
that entry becomes uneditable.  The DB-side guard rails are also no-ops: the
`current_<table>_by_id_ty` partial indexes in schema.ts use
`WHERE valid_to = NULL`, which never matches (and the live convention is
`END_OF_TIME`, not NULL).  Recommend: (a) an id-uniqueness check at apply time
(the workspace can keep a per-table id→tuple index, which also fixes §3.2),
and (b) repairing the partial indexes to `WHERE valid_to = 9007199254740991`.

### 2.2 `getVersionedTupleByPath` is get-OR-CREATE — a read path that mutates
Lines 290–311: looking up a path **materialises empty `VersionedTuple` nodes**
for any segment that doesn't exist.  That is wanted by the apply path (first
version of a new fact) but it also runs for pure reads
(`getVersionedTupleParentRelation`, used by the editor's move).  A typo'd or
stale path silently plants permanent ghost nodes (zero versions) in the maps;
ghosts are invisible to the current-view queries but **are** found by
`findVersionedTupleById`, where they panic downstream (`mostRecentTuple`
undefined).  Today the server is saved by a coincidence: a failed
`applyTransaction` triggers `requestWorkspaceReload`, discarding ghosts.
Recommend splitting `getVersionedTupleByPath` (throwing) from
`getOrCreateVersionedTupleByPath` (apply-only).

### 2.3 The apply machinery is public at the wrong level
The validated entry point is `VersionedDb.applyProposedAssertion`
(monotonic-time + valid_to-shape checks, lines 150–163).  But the tuple-level
`VersionedTuple.applyProposedAssertion` / `untrackedApplyAssertion` are public
too, and calling them directly skips the time checks (and the
`mostRecentLocalTimestamp` bookkeeping).  Same for
`VersionedDb.untrackedApplyAssertionByPath` (no external callers — verified).
Recommend making the tuple-level methods module-private in spirit (rename with
`_` or restructure) so there is exactly one guarded door per path.

### 2.4 Closing the predecessor mutates a caller-visible object
Line 426: `prevAssertion.valid_to = assertAtTime` — the one in-place mutation
in an otherwise immutable model, and it aliases whatever object the caller
handed in earlier (applyTransaction also rewrites `valid_from/valid_to` on its
inputs).  This is by design (the caller persists the returned
`updatedPrevAssertion`), but the contract — *assertions given to the workspace
are owned by it and may be mutated later* — is documented nowhere.  The test
suite already defends itself with `structuredClone`; the contract should be a
doc comment on `applyProposedAssertion`, or the workspace should clone on
ingest.

### 2.5 Load-order contract is implicit
`untrackedApplyAssertion` requires each fact's versions to arrive in
`valid_from` order; that holds only because `selectAllAssertions` says
`ORDER BY valid_from, id`.  Nothing in the workspace states or checks the
precondition (the chain checks *happen* to reject most violations).  One
comment on the method would do.

### 2.6 The global-time gate is where fork/merge will land
`valid_from <= mostRecentLocalTimestamp → throw` (line 153) imposes a total
order across the whole workspace — correct for a single server, and exactly
the line that must relax for the offline-fork/merge design intent
(assertion-model.md §why-4).  Also the source of the documented same-timestamp
limitation (two assertions in one tx must have distinct times; applyTransaction
sidesteps by allocating per group).  No action now; flagging it as the known
future fault line.

### 2.7 The root tuple works by accident
The table root is a `VersionedTuple` with id 0 and **no versions ever**.
`CurrentTupleQuery` over it only works because `toJSON` falls back to `{}`
when `mostRecentTupleVersion` is undefined (the "TODO what about no most
recent tuple version" at line 663).  The big design comment at the top of the
file ("How does root work?") is this exact unresolved question.  It works;
it deserves either a decision or a comment saying the fallback is the
decision.

---

## 3. Dead weight inventory (verified caller-less)

| Item | Lines | Note |
|---|---|---|
| `applyServerAssertion` (both levels) | 139–142, 472–495 | client-sync scaffolding; the VersionedDb one just throws |
| `mostRecentSourceDbTimestamp` | 118 | only ever BEGINNING_OF_TIME now |
| `proposedAssertions` + `takeProposedAssertions` | 120, 165–171 | §1.1 — used only by tests |
| `getTable` / `getVersionedTupleById` (Db + Table) | 183–193, 530–533 | no callers; `getTable` also has the wrong return type (`VersionedTuple` vs `VersionedTable`); `getVersionedTupleById` ignores its `typeTag` arg and is a linear scan |
| `reset()` (both) | 126–129, 248–253 | throw 'not impl' |
| `findVersionedTuples` | 319–326 | no callers |
| `isRootTupleId` | 518–520 | no callers |
| `compareVersionedTupleByRecentness` dead branches | 781–783 | the undefined cases can't occur post-filter |
| `switch(true)` cases 4 + default | 449–459 | unreachable: `valid_to >= valid_from` always, so case 3 subsumes case 4 |
| `untrackedApplyAssertion` else-branch | 374–381 | `valid_to` is always truthy; "time travel prolbem" branch unreachable |
| Type experiments (`FilterConditionally`, `TupleType`, `const k`, `FFF`) | 82–107 | scratch |
| Commented-out blocks (`VersionedRelationContainer`, `VersionedDatabaseWorkspace`, `generateRelativeOrderKey`, `#currentTuple` remnants) | ~30–110, 795–822, 875–910 | era-of-exploration comments |
| `jsonTest` / `fullLoadTest` / `import.meta.main` | 918–1028 | superseded by the test suite; `fullLoadTest` is broken (§1.4) |

Deleting all of the above (plus §4.4's import trims) takes the file from
~1030 lines to roughly 500, all of it live.

## 4. Structure / API warts

1. **Layering**: the "generic" datawiki workspace imports `wordwiki/schema`
   (for `Assertion` — fundamental, fine) but also `wordwiki/entry-schema`
   (`dictSchemaJson`) purely for the dead CLI tests, and
   `selectAssertionsForTopLevelFact` for `getAssertionsForEntry` (which
   hardcodes `'dict'` and belongs in wordwiki, beside its only callers).
2. **Two names for one idea**: `mostRecentTuple` vs `current` vs
   `requiredMostRecentTuple` on VersionedTuple, and again
   `mostRecentTupleVersion` on the query — `current` is an alias with a
   commented-out past.  Pick one vocabulary (suggest `mostRecentVersion` +
   `currentVersion` where the isCurrent distinction matters).
3. **`TupleVersion.relation` is misnamed** — it holds the *VersionedTuple*,
   not a relation.
4. **Unused/legacy imports** after the cleanup: `BEGINNING_OF_TIME` (only the
   dead field), `model`/`dictSchemaJson`/`updateAssertion` etc. — trim with
   the dead code.
5. **Logging**: `applyProposedAssertion` does two full `JSON.stringify`s per
   apply (lines 407–409, 464) and the order-key generators log every call —
   server-log spam and per-edit cost.  Demote to a debug flag or delete.

## 5. Performance notes (all acceptable today, listed for the record)

- Query objects (`CurrentTupleQuery`/`CurrentRelationQuery`) materialise the
  whole subtree eagerly; the `entries` getter does this for the entire
  dictionary on every cache invalidation (= every tx).  That is the intended
  design (~10ms-scale, once per edit) — fine until it isn't; the file's own
  closing comment sketches the identity-based caching that would fix it.
- The editor's `(entry_id, fact_id)` addressing keeps `findVersionedTupleById`
  scans entry-local; the per-table id index from §2.1(a) would make them O(1)
  and kill the last linear scan.
- `domainFields`/`toJSON` memoization on TupleVersion is safe because
  `valid_to` (the only field ever mutated) isn't a domain field — worth a
  comment, since it is one `bind:'valid_to'` away from being a stale-cache bug.

## 6. Suggested cleanup order

1. Drop the proposed-assertion tracking (or gate it) — the leak (§1.1).
2. Delete the dead-weight inventory (§3) + trim imports/logging (§4.4, §4.5).
3. Split get vs get-or-create on the path lookup (§2.2).
4. Add the per-table id index: O(1) lookup + id-uniqueness enforcement at
   apply (§2.1) — and fix the broken partial indexes in schema.ts.
5. Key `toJSON`'s cache on `includeHistory`, fix `historicalTupleVersions`
   (§1.2, §1.3).
6. Naming/encapsulation pass (§2.3, §4.2, §4.3) + the ownership doc comment
   (§2.4, §2.5).

Steps 1–2 are pure deletion against a green test suite.  Steps 3–5 each want
a test added first (ghost-path read, duplicate-id insert, history-flag cache).
