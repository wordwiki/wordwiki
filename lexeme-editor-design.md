# Lexeme Editor v2 — server-side htmx editor (design)

*(Approved direction as of 2026-06-10. Companion doc: [assertion-model.md](assertion-model.md).)*

## Motivation

The current lexeme editor (`datawiki/view.ts`) runs the versioned workspace model
*inside the browser*: assertions are constructed client-side and synced to the
server. This makes the editor a distributed system, requires a transpile step
(`REMOVE_FOR_WEB` hacks, `/scripts/datawiki/*.js`), and is complex enough to be
scary to work on. Since the editor should remain runnable for as long as
possible, that complexity is a direct threat to the project's longevity goals.

The rabid project proved out a much simpler model (see the liminal/htmx
editing standard): read-only server-rendered pages; every mutation is a button
in one of three forms (immediate / confirm / modal-of-action-arguments);
dialogs are generated server-side from Field widgets; mutations happen live on
the server; fragments update in place via htmx. Wordwiki's editor moves to
this model.

**Key structural insight:** the server already has everything. `WordWiki`
holds the full in-RAM `VersionedDb` workspace, `applyTransaction` already
allocates timestamps and persists, and the order-key generators already run
server-side. The client workspace duplicated machinery the server runs
anyway; the new editor stops duplicating it.

## Approved decisions

- **New parallel editor** (`wordwiki/lexeme-editor.ts` + a new page template);
  the old editor stays untouched until parity, then is retired along with the
  datawiki browser transpile.
- **Metadata-driven**: the editor's shape derives entirely from
  `dictSchemaJson` (the soft schema) — schema changes require no editor code
  changes.
- **`change_by_username` keeps the current hacky user-selector mechanism for
  now**; real sessions (rabid-style) are a separate next step.
- **The public-site renderer stays separate** (`entry-schema.ts` renderEntry +
  publish.ts). It must be hand-tuned and tight — which is in direct tension
  with the editor's metadata-driven / history-showing / editable goals. Do not
  attempt to share the rendering walk.
- **v1 secondary actions live in the edit dialog** (Move up / Move down /
  Delete / History as secondary affordances in the tuple's dialog), keeping
  the read surface clean. Inline reorder (drag/arrows) only if reordering
  proves frequent. The old right-click context-menu vocabulary is dropped
  (undiscoverable, no touch support).

## How rabid's mutation vocabulary maps to assertion operations

| Operation | Form | Implementation |
|---|---|---|
| Edit tuple | modal | pencil/tap → `editDialog(...)` → `tx`-save → new assertion replacing current |
| Insert child / peer | modal | "+" button, position baked into dialog URL → new assertion with server `order_key` |
| Delete tuple | confirm | tombstone assertion (`valid_from === valid_to`) |
| Move up / down | immediate (in dialog for v1) | re-assert with new `order_key` |
| History | modal/fragment | render the fact's `TupleVersion` list |
| Undo / restore | confirm | re-assert an old version's values as a new assertion (mutes are never allowed) |

### Why the assertion model fits this even better than SQL tables

- **Conflict protection is native.** Rabid needs `before-<field>` hidden
  snapshots; here the dialog carries `replaces_assertion_id` as a hidden
  param. If the tuple was re-asserted meanwhile, the apply path throws
  ("replaces chain broken") → save returns `{action:'alert'}` ("changed by
  someone else") + a fragment reload. Granularity is per-tuple (the atom of
  the model), not per-field; field-level merge could later be layered by
  composing onto the latest assertion at save time.
- **Fragment tags are natural.** `.-fact-<id>-` per tuple (fact ids are
  globally unique), `.-fact-<parent_id>-rel-<tag>-` per child relation
  (insert/delete/move reload the relation), `.-entry-<entry_id>-` for coarse
  reloads.
- **Server-side allocation.** New fact ids, timestamps, and
  `change_by_username` are stamped server-side in one place, removing the
  client `Math.random()` ids and the "this is wrong but overridden" timestamp
  dance.

## Architecture

1. **Routes module.** `class LexemeEditor` on the dispatch tree (reachable as
   `wordwiki.lexeme.*`): `entryPage(entry_id)`; fragment renderers
   (`renderEntry`, `renderTuple`, `renderRelation`); dialog generators
   (`editDialog`, `insertDialog`, `historyDialog`); actions (`saveTuple`,
   `deleteTuple`, `move`, `restoreVersion`). Reads via `CurrentTupleQuery`
   over the server workspace; writes via `applyTransaction`.

2. **Metadata-driven render.** Server-side walk of the soft-schema
   `RelationField` tree zipped with `CurrentTupleQuery`, dispatching on
   `$shape` exactly as the old `RelationView.renderRelation` did, but emitting
   liminal editable-surface markup: `containerRelation` → nested section with
   heading + per-relation "+ Add"; `inlineListRelation` /
   `compactInlineListRelation` → list items / compact inline runs, each an
   `lm-editable` surface containing an edit pencil.

3. **Field widgets — the adapter.** Dialogs are built with
   `action.renderParamForm` from `liminal/table.ts` Field widgets. A small
   adapter visitor `widgetFor(modelField) → liminal.Field` maps the soft
   schema's field classes: `model.StringField` (+`$width/$height`) →
   `StringField` (textarea variant), `model.EnumField($options)` →
   `EnumField(choices)`, `model.VariantField` → `EnumField(variants)`,
   `model.BooleanField` → `BooleanField`, plus custom widgets for audio and
   bounding-group. The `$bind → attrN` mapping is applied server-side when
   building the assertion — the wire format uses domain field names. Once the
   shape proves out, consider folding the widget interface directly into
   `datawiki/model.ts` and deleting the adapter.

4. **Save path.** `saveTuple(form)`: parse via widgets → look up relation by
   `ty` → build assertion (path fields from current version or hidden parent
   params for inserts; `$bind` mapping; server `order_key`;
   `change_by_username`) → `applyTransaction([assertion])` →
   `{action:'reload', targets:[...]}`. One generic endpoint covers edit/insert
   for every relation because metadata drives it.

5. **History + undo.** `historyDialog(fact_id)`: `TupleVersion` list with
   formatted `valid_from/valid_to`, `change_by_username`, rendered values; old
   versions get "Restore" (confirm) buttons that re-assert. A relation-level
   "show deleted" lists tombstoned facts with restore. Note:
   `applyProposedAssertion` currently throws on asserting over a deleted
   assertion — the one workspace change this plan requires.

6. **Audio (edge point).** The `tx`/`getFormJSON` path is JSON, so files
   don't ride along. **Eager upload on selection**: the audio widget renders a
   file input + hidden path input; on `change`, a small generic widget script
   POSTs to the existing `uploadRecording` endpoint, writes the returned
   content-store path into the hidden input, shows a play-preview. Save
   carries just the path string. Orphaned blobs from cancelled dialogs are
   harmless (content-addressed store). Images: same pattern. The in-browser
   recorder prototypes (`resources/audio-recorder/`) can later feed the same
   endpoint.

7. **Document references / bounding groups.** The popup page-editor (canvas
   client app) stays. "Add reference from PDM/Rand/…" buttons become
   immediate actions calling the existing server-side
   `addNewDocumentReference` logic; tx response gains `{action:'open', url}`
   (or button does `window.open` after tx resolves). The tagger's postMessage
   on save is repointed to `htmx.trigger('.-fact-<id>-', 'reload')`, replacing
   the manual SVG-reload hack.

8. **Page template.** A fresh lexeme page template (htmx 2.x,
   `liminal-scripts.js`, rabid-style modal skeleton with `showModalEditor`,
   audio player) used only by the new editor. The old editor keeps the old
   `pageTemplate` (which loads the transpiled module scripts and its own
   `#modalEditor`) — keeping templates separate avoids the id collision until
   retirement.

## Alternatives considered (and rejected)

- **Replace soft schema with real liminal `Table`s**: discards the assertion
  model's purpose (versioning, approval, variants, fork/merge). No.
- **Whole-entry mega-form**: conflict-prone, loses per-tuple granularity that
  makes history/undo clean, breaks the one-interaction-vocabulary standard.
- **Thin client workspace for batched edits**: single-tuple-per-tx live saves
  are the rabid model; losing the distributed-system-ness is the point.
  Offline field collection remains a future *server-to-server* fork/merge.

## What this retires (longevity payoff)

Browser-resident `VersionedDb`, `ActiveViews`/rerender machinery,
`TupleEditor`, `RemoteDb` sync scaffolding, the context-menu system, client
id/timestamp allocation, and the datawiki transpile step. Remaining browser
JS: htmx, the small liminal scripts, the audio widget, and the (separate,
unchanged) page tagger. The editor becomes server-rendered pure functions of
state, so the rabid test harness (render→act→render as a library, in-memory
db) applies to wordwiki's editor for the first time.

## Phasing

1. ✅ Template + read-only metadata-driven render, parallel route (old editor untouched).
2. ✅ Edit dialog + save for existing tuples, replaces-chain conflict handling.
3. ✅ Insert / delete / move.
4. ✅ History + restore/undo, show-deleted.
5. ✅ Audio eager-upload widget (image upload + in-browser recorder still to do).
6. ✅ Document references (server-create + popup tagger + fragment-reload message).
7. ✅ Switch entry links to the new editor; retire view.ts + datawiki transpile.

All phases complete (2026-06-10).  `wordwiki.entry()` IS the v2 editor (all
existing links follow); "Add New Entry" is a navbar form POST →
`newLexemeAction` → redirect into the editor; datawiki/view.ts and the
workspace's client-sync scaffolding (RemoteDb, /workspace-rpc-and-sync,
persistProposedAssertions) are deleted; transpile.sh now builds only the two
standalone browser files (scannedpage/page-editor.ts for the tagger,
page-viewer.ts for the public site) with none of the module-graph hackery.
Sessions also landed (see wordwiki-toplevel upgrade): every assertion is
stamped with change_by_username from the login session.

## Refresh scoping (implemented 2026-06-10)

Three levels, all reloadable fragments, chosen per mutation:

- **self** (`.-fact-<id>-`, route `renderTupleFragment`) - field edits, restore
  of a live fact;
- **parent** (`.-rel-<parent_fact_id>-<tag>-`, route `renderRelationFragment`) -
  insert, delete, move, restore-after-delete, add-document-reference;
- **root** (`.-entry-<id>-`, route `renderEntry`) - any mutation touching a
  spelling (spellings feed the entry heading), widened automatically in
  `mutationTargets()`.

## Implementation notes (2026-06-10)

- The workspace change for restore-after-delete: `applyProposedAssertion`
  accepts an assertion over a closed (deleted) predecessor (a new valid
  period; no valid_to update needed), and `untrackedApplyAssertion` accepts a
  valid-time GAP on load (`valid_from >= prev.valid_to`, was `===`) - a gap is
  exactly a deletion period.  Verified: db with restore chains reloads fine.
- `tx()` (resources/rabid-scripts.js) gained an `{action:'open', url,
  targets?}` case - used by add-document-reference to open the page tagger
  after creating the group+ref.
- The tagger's "Done editing reference" postMessage is handled in
  `resources/lexeme-editor-scripts.js`: finds the reference SVG by group id
  and htmx-triggers its enclosing fragment's reload.
- Audio eager-upload: `lmAudioUploadChange` (same file) base64s the picked
  file, POSTs to the existing `uploadRecording`, writes the returned
  content-store path into the field's hidden input.
- Dialogs opened from a button INSIDE the modal (history, deleted-items) lift
  their own title via an inline `setTimeout(showModalEditor)` script (htmx
  executes swapped-in scripts; the issuing button is detached by its own swap
  before its after-request can fire).  `showModalEditor` now keeps the
  existing header when content carries no inline title, so the page-button
  path (after-request) and the inline-script path compose safely.
- History shows order_key-only re-asserts as ordinary versions (values look
  identical); annotating them as "(moved)" is a polish item.
- Browser caching of /resources/*.js has no versioning - after changing the
  client scripts, a stale tab needs a hard refresh.
