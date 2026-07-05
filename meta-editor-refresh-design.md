# Metadata editor: fine-grained refresh via the liminal shape model

Design for recovering accurate (scoped) redraws in the metadata-driven lexeme
editor, replacing today's whole-entry coarse reload.  Discussed and settled
2026-07-05 (dz + claude); written down so implementation doesn't have to
re-derive it.  **Status: DESIGN ONLY — not built.**  Prereq reading:
`liminal.md` (dep keys, Rule 1 registration, shape keys, speculation) and
`liminal-refresh-future-work.md` §2 (morph lever, insert directive).

## Where this starts from (current state, 2026-07-05)

- The metadata editor is `wordwiki.lexeme.metaEditPage` →
  `renderMetaEntry(entry_id)`: ONE reloadable fragment for the whole entry
  (class `-entry-<id>-`, hx-trigger `reload consume`).  The renderer is
  `wordwiki/render-entry-meta.ts` (`EntryRenderer` walking the schema, edit
  affordances injected via `EditingHooks` built in
  `lexeme-editor.ts metaEditingHooks`).
- Every mutation currently reloads the whole entry: `EditMode` grew a `'meta'`
  value that rides every action URL (the `'review'` precedent) and widens
  `mutationTargets()` to the root.  This was a deliberate *coarse but correct*
  fallback: parent-scope targets (`.-rel-<parentFact>-<tag>-`) only exist on
  the meta page's EMPTY slot rows, so delete/move/anchored-insert silently
  didn't refresh before it.
- The legacy editor (`entryPage`) has real per-relation fragments registering
  `-rel-<parentFact>-<tag>-` and per-tuple fragments registering
  `-fact-<factId>-`; `mutationTargets` picks self/parent/root by event.

## Why the shape concept applies despite the assertion model

The `dict` table is not a liminal `Table` (no SQL pks/fks in the liminal
sense), but the shape concept is about DOM registration vs. emission
granularity, not storage.  A relation under a parent fact IS an fk-scoped
subset — parent fact id plays fk-value, the child tag plays fk-name — and
`liminal.md` already lists the `-entry-`/`-fact-`/`-rel-<id>-<tag>-` family as
the sanctioned hand-minted precedent.

| liminal key            | assertion-world key                | meaning                       |
|------------------------|------------------------------------|-------------------------------|
| `-t-<pk>-`             | `-fact-<factId>-`                  | one tuple's content           |
| `-t-<fk>-<v>-`         | `-rel-<parentFactId>-<tag>-`       | the relation's member content |
| `-t-<fk>-<v>-shape-`   | `-rel-<parentFactId>-<tag>-shape-` | membership + order only       |
| `-t-`                  | `-entry-<entryId>-`                | the whole entry               |

Events map exactly onto the `shapeFields = ['order_key','deleted']`
convention: edit = content of one fact; insert / delete(tombstone) / move
(order_key) = SHAPE of the parent relation.

## The three things the meta page grows (registration side)

Per liminal Rule 1 (finest sufficient key; delegating wrappers register shape
only):

1. **Relation wrappers.**  Each relation rendering gets a wrapper element
   registering `-rel-<parentFact>-<tag>-shape-` ONLY, with its own fragment
   route (`renderMetaRelationFragment(entry_id, parent_fact_id, tag)`).
   Insert/delete/move re-render just that list.  The transitions that look
   special are all just shape events absorbed by the wrapper re-render:
   - empty slot ↔ first row (the quiet "Prompt: empty" line vs the list);
   - 1 ↔ 2 rows;
   - renumbering of remaining subentries after a delete ("1." markers);
   - fields-less containers (Example): per-tuple headed sections appear/vanish.

2. **Self-refreshing tuple surfaces.**  Each surface keeps `-fact-<id>-` but
   its hx-get becomes `renderMetaTupleFragment(entry_id, fact_id)` instead of
   the whole entry.  Requires a renderer refactor so ONE tuple's surface can
   render in isolation: everything needed is recoverable from schema + parent
   relation (`rf` gives label policy / compose / decoration), and the
   genuinely sibling-dependent bits (the "1." hanging marker) already live
   OUTSIDE the surface — anything that changes them is a shape event anyway.
   So surface markup is context-free by construction.  The fragment route
   recovers `rf` from the fact's `ty` tag.

3. **A title antenna.**  The `<h1>` renders headword+glosses collected from
   the whole tree (`collectTitleValues`), so a gloss edit dirties its row AND
   the title.  The schema knows which relations feed the title —
   `$view.titleRole` — so emission widens to the entry root (or a finer
   dedicated `-entry-<id>-title-` fragment wrapping the h1) exactly when the
   mutated relation carries a titleRole.  This is liminal.md's "pair the
   delegating wrapper with a content antenna", driven from metadata instead of
   a hand-list, and it subsumes the existing SpellingTag → root special case.

## Emission side (and the 'meta' mode hack dissolves)

`dict` keeps hand-emitting (per `liminal-refresh-future-work.md` §3: the
lexeme editor "keeps hand-emitting or gets its own mint helpers").  Mint
helpers (factKey/relKey/relShapeKey/entryKey) live beside `mutationTargets`,
which becomes the emission table following *writers tell the whole truth*:

| event                        | emit                                        |
|------------------------------|---------------------------------------------|
| edit (saveEdit, restore-in-place) | `[fact, rel]` (+ entry root if titleRole) |
| insert / delete / move / restore-after-delete | `[rel, rel-shape]` (+ root if titleRole) |

Each page then controls refresh cost by REGISTRATION alone:

- meta page: shape wrappers + fact fragments (+ title antenna);
- legacy page: fact fragments + relation wrappers — **with one retag**: the
  legacy relation fragments currently register the CONTENT key
  (`-rel-…-`) while containing self-refreshing tuple rows; that makes them
  delegating wrappers by Rule 1, so they retag to `-rel-…-shape-`.  Without
  the retag, uniform emission would coarsen every edit to a relation
  re-render there (`removeContainedRoots` eats the fact fragment).
- review page: keeps the `mode='review'` ride-along and its root target —
  reclassifying the change list is genuinely whole-entry.

With uniform emission + per-page registration, the `mode='meta'` ride-along
added 2026-07-05 becomes unnecessary for edit/meta and can be removed (review
keeps its mode).

## Follow-ons that come almost free afterwards

- **Speculation (`txd`)**: Move up/down and Delete declare the shape key,
  edits declare the fact key → one-trip swaps.  `applySpeculation` dispatches
  the fragment routes as GETs, which now exist.  Debug mode
  (`lmDebugRefresh(true)`) then tunes over-registration the standard way.
- **Fine-grained insert directive / morph** (future-work §2) apply within a
  relation wrapper if ever needed — but a wrapper re-render is already just
  one relation's rows, so probably not worth it here.

## Stopgap if whole-page swaps bite before this lands

`hx-swap="morph"` (idiomorph) on the existing whole-entry reload kills the
flicker/scroll/focus disruption with near-zero model change, composes with
everything above, and stays useful afterwards for the reloads that remain
coarse (review).  See future-work §2 "cheaper complementary lever".

## Sequencing (agreed)

Fragment routes freeze markup contracts, and the meta look is still being
actively tuned (doc-ref empty loudness, ☰ gutter placement queued).  **Finish
the visual tuning first, then land this.**  Rough effort: renderer grows two
fragment entry points sharing the existing walk methods; editor hooks swap
their reload attrs; `mutationTargets` becomes the emission table; a
debug-mode walk to tune — a day-ish of careful work.

## Wrinkles noted so nobody re-trips on them

- Tuple-surface context-freeness is the load-bearing claim of §2 above; if a
  future $view feature makes a surface depend on siblings (e.g. joined lines
  in EDIT mode — read-mode joins don't exist in edit today), that feature must
  either stay read-only or move the dependence into the wrapper.
- Menus don't depend on position (Move up/down are always offered, no
  disabled-at-edge state), so a move changes only order — pure shape.
- Bounding-group (document reference) creation returns `{action:'open'}` +
  targets and re-renders via the tagger's postMessage hook; its target
  becomes the rel-shape key like any insert.  Scan edits happen on another
  page and remain invisible to this one (same as today, acceptable).
- Fragment routes render BARE content; affordances that must survive a reload
  stay outside the fragment (liminal.md nesting note).
- The whole-entry root stops registering anything (pure shell for
  navigation) once the title antenna exists — do not leave it registered on a
  root key or every titleRole edit re-renders everything again.
