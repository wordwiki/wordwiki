# Binding the Rand scans to rand entries — design

2026-07-26.  Goal (dz): the rand dictionary's entries get scan images
from the Rand 1888 book bound to them, like MMO's reference images —
but WITHOUT replicating MMO's entry-construction ceremony: the rand
top-level entry IS the construction, so `document_reference` plants
directly under the entry root, not under a subentry.  The page editor
must interact with rand lexemes through the SAME machinery it uses for
MMO (no per-dictionary magic).  Once the mechanism works with the
existing hand-tagging pipeline, phase 2 uses Opus to build the
references automatically, anchored on the `\so` page citations
(99.5% of the 31,723 entries carry a structured `Rand 1888` page
after parser iteration 1).

Related docs: multi-dictionary-survey.md (the dictionary substrate),
scan-extract.md (the Layer-1 cached extraction primitive),
watson/rand-orthography-survey.md (the Watson review packet).

## 1. What exists (surveyed 2026-07-26)

**The scan side is DONE.**  The Rand book is already a
scanned_document (`Rand`, 305 pages) with a Text layer of 25,252
OCR boxes and a Tagging layer already holding 2,044 boxes — from
MMO-side references INTO Rand (MMO entries have been citing Rand
pages all along).  Clark 1902 is there too (`Clark`, 234 pages,
16,925 Text boxes), so the 28 rand entries citing Clark get bound by
the same mechanism for free.

**MMO's document_reference vocabulary** (dict schema, at
/entry/subentry/document_reference): relation `ref` with
`$role: documentReference`; `bounding_group_id` (integer,
`$shape: boundingGroup` — the marker everything dispatches on); child
relations `rtr` transcription / `rex` expanded_transcription /
`rtl` transliteration / `rse` source_as_entry / `rne`
normalized_source_as_entry / `rfr` foreign_reference / `rnt` note /
`rnp` public_note.

**Already position-independent** (the role system doing its job):
- `schemaRoles.referenceGroupIds()` finds the relation BY ROLE and
  collects group ids via name-path walking — any depth.
- Entry rendering dispatches on `$shape: 'boundingGroup'`
  (render-entry-meta.ts:394) — position-blind.
- `entriesByReferenceGroupIdOf` (site-view.ts) — role-driven.

**The three actually-bound sites:**
1. `createLexemeFromGroup` (lexeme-ops.ts:475) is role-driven but
   assumes EXACTLY ONE wrapper level: it takes
   `refRel.parentRelation` as "the subentry" and emits a fixed
   entry -> subentry -> ref chain.
2. `pageWordRows` (render-page-editor.ts:230) — the page editor's
   group -> word reverse lookup — is raw SQL hardcoded to
   `FROM dict ... ty='ref' ... attr1`.
3. The sidebar / context-menu word links assume MMO entries
   (`templates.lexemeLink`, the `o`/`e` hover keys, the
   `wordwiki.newLexemeFromGroup` rpc).

## 2. Decisions

**The role IS the planting mechanism — no new machinery.**  dz's
question ("could the role system be extended to allow the doc
reference tree planted differently in different dicts?") turns out to
be already answered by the role system's design: `relationsByRole`
finds the relation wherever the schema puts it.  Each dictionary's
schema simply plants the subtree where it wants it — MMO under
subentry, rand under the entry root — and the code asks the role, not
the path.  What needs extending is the three sites above that
BYPASSED the role abstraction (fixed depth, fixed table, fixed URLs).

**The vocabulary carries over VERBATIM.**  rand's schema gets MMO's
document_reference subtree with the same relation names, tags and
`$role` (planted at /entry/document_reference).  Tags are
per-dictionary-schema data, so there is no collision concern, and
identical vocab is what lets the page editor, renderers and the
future rand->MMO word-import all treat references uniformly (the
no-gratuitous-difference principle again).

**Per-BOOK default target dictionary.**  "Create word from this
group" needs to know which dictionary to create into.  Each scanned
book gets a default target dictionary (Rand book -> `rand`,
Clark -> `rand`, PDM -> `dict`), configured data-side alongside the
existing primarySourceBook convention; the context menu can offer
the non-default dictionaries when needed.  The page editor stays
book-generic — this is data it reads, not code it grows.

**Transform re-runs must PRESERVE the reference layer** — see §4.
References are post-transform edits; today the edits-block-rerun gate
would lock the mapping the moment the first reference lands, and the
mapping worklist (the sd/li/lf... tail) is still open.  Rather than
sequencing (finish the mapping, then bind — which permanently
freezes mapping iteration the day Opus starts), the transform learns
to preserve foreign-authored subtrees across re-runs.  The
deterministic entry ids make this sound: a re-run recreates the same
entry ids, so preserved subtrees still hang off the right entries.

## 3. Phase 1 — the mechanism (hand-tagging works end to end)

**3.1 The schema.**  Add the document_reference subtree to
watson/rand-transform.json's targetSchema at /entry/document_reference
(verbatim MMO vocab; `$role: documentReference`;
`bounding_group_id` `$shape: boundingGroup`).  NO transform rules feed
it — it exists to receive post-import data.  load-mapping gates it
through checkProposedSchema as usual.

**3.2 The spine generalization** (lexeme-ops.ts).  A small helper
(schema-roles or lexeme-ops): the REF SPINE = the `parentRelation`
chain from the documentReference relation up to (exclusive) the entry
root.  `createLexemeFromGroup` synthesizes one placeholder tuple per
spine level instead of exactly one — MMO synthesizes its subentry,
rand synthesizes nothing, a future dictionary can nest however it
likes.  Same ascending-placeholder-times transaction pattern,
length now data-driven.

New op alongside it: `addReferenceToEntry(entry_id,
bounding_group_id)` — attach a group to an EXISTING entry (today only
create-new exists).  For rand this is the common case (31,723 entries
already exist!) and the Opus binder's landing op.  Spine synthesis
for attach: reuse the entry's FIRST existing spine tuple at each
level, creating only what's missing (rand: nothing to decide; MMO:
first subentry — good enough until MMO needs a subentry picker).

**3.3 The reverse-lookup sweep** (render-page-editor.ts
`pageWordRows`).  Iterate the DISCOVERED dictionaries
(dictionary-config discovery); for each whose schema declares the
documentReference role, run the same query against ITS table with the
role relation's actual tag and the boundingGroup field's actual bind
(both from the schema — no 'ref'/'attr1' literals).  Table names
interpolate into the SQL before prepare, one memoized statement per
dictionary (the established prepared-query pattern).  Rows become
`{dict: string, entry_id: number, groupIds: number[]}`.

**3.4 Sidebar + links.**  Word rows render through their OWN
dictionary: summaries via that dictionary's store + schema-roles
(headword/gloss are already generic — the facade browse pages use
them today); links via the dotted facade routes
(`wordwiki.dicts.rand.word(...)` / the per-dictionary lexeme editor
facade); MMO rows keep their existing URLs.  The `o`/`e` hover keys
and the context menu carry the row's dictionary.
`newLexemeFromGroup` gains a dictionary parameter, defaulted from the
book's target dictionary (§2); a parallel
`addReferenceFromGroup(dict, entry_id, group_id)` rpc serves the
attach flow (sidebar search-pick later if hand-attach wants it —
the binder doesn't need UI for it).

**3.5 Entry pages.**  render-entry-meta's `$shape: boundingGroup`
dispatch should render rand references (scan crop + page-editor
link) as-is once the schema declares them — verify on the facade,
fix what reaches for MMO-specific context.  The public/publish
renderer is OUT OF SCOPE (rand is not published; when it is, the
bundle-ized scan renders already exist).

**3.6 Tests** (render->act->render, in-memory db, the generic test
layer): create-from-group in a no-subentry dictionary (spine length
0) + MMO regression (spine length 1); attach-to-existing on both;
the sweep returning rows from TWO dictionaries referencing one page;
facade sidebar links.  Pin one real flow end to end on the RAND
sample fixtures.

## 4. Transform re-run preserve

Current runTransform: refuses when the target holds any assertion
not authored '~dict-transform' (edits block re-runs), then DELETEs
the assertion table and rebuilds.  Extension: `--preserve-foreign` —
DELETE only '~dict-transform'-authored rows; foreign-authored rows
(hand edits, '~rand-binder' references) survive.  Deterministic ids
keep their ancestor paths valid.  After rebuild, report ORPHANS:
preserved subtrees whose ancestor entry no longer exists (a source
record vanished in a re-import) — a worklist, not a crash.  The
report also counts preserved-by-author so a run says what it kept.

This is deliberately the first step toward the offline-fork/merge
philosophy (conflicts as data, review UI as merge UI) — but scoped
tiny: no version merging, just "the transform owns ONLY its own
rows".  Once preserve exists, the edits-block gate applies only to
runs WITHOUT the flag.  (The generalization of this ownership rule
to fact-granularity machine participation — sync semantics, the
feedback loop, per-feature postures — is
machine-contributors-design.md; the binder is planned to land
through that model's machineSync.)

## 5. Phase 2 — the Opus auto-binder

**The anchor.**  Per printed page, we know (a) which rand entries
claim it (structured `src` book+page rows — 99.5% coverage) and (b)
the page's OCR: the Text layer's boxes with their text and positions.
The binder's job is the correspondence: which Text boxes form each
entry's region.

**Printed page -> scan page.**  `\so` cites PRINTED page numbers;
`scanned_page.page_number` is scan order (front matter shifts it).
Prerequisite: a small mapping, derived once by reading the printed
page number from each page's Text-layer header boxes (a script, spot
checked), stored as data (a config row or a tiny table beside the
book).  Clark gets the same treatment.

**The extraction stage — on the EXISTING Layer-1 substrate.**  All
LLM/image work goes through the derived content-addressable store
(content-store.ts `getDerived()`), exactly like the PDM transcription
and the derived crops: persistently memoized, so re-running the
binder is nearly free and iterating the prompt re-extracts only what
the promptVersion bump invalidates.  Concretely: one
extract.ts `ExtractStage` per page —

    inputs (all in the cache key): the page image (content-addressed
      path; contained via the cached derivation), model
      ('claude-opus-4-8'), promptVersion, imageBox, and the INPUT
      json: the Text-layer boxes (id, text, rect) + the candidate
      entries for the page (entry_id, headwords both lanes, gloss,
      zpt partition, cited pages)
    output (schema-validated): per entry, the Text box ids forming
      its region + a confidence; plus unmatched-entry and
      unclaimed-region lists

Feeding the OCR text IN and asking for box-id groupings (rather than
asking Opus to read the scan cold) keeps the task cheap and the
output mechanically landable; the image is still attached so Opus can
resolve OCR garbage and column order visually.  ~305 pages x 1 call.

**Landing (Layer 2, plain code).**  For each accepted match: create a
bounding_group in the book's Tagging layer (the SAME layer the
existing 2,044 MMO-ref groups live in — the page editor then shows
both dictionaries' tagging together), copy the chosen Text boxes into
it (the same copy semantic as the page editor's grey-box click), and
`addReferenceToEntry` on the rand entry — authored '~rand-binder' so
the work is identifiable, preservable (§4), and re-derivable.
Idempotence: skip entries that already carry a reference to a group
on that page (hand tags win; re-runs top up).  Per-page report:
bound / ambiguous / unmatched — the ambiguous+unmatched tail IS the
human worklist, and it surfaces naturally in the page editor sidebar
(entries claiming the page without refs; groups without words).

**Eval before the full run** (the PDM lesson): hand-bind ~10 pages
as a reference set, run the binder over them, measure
precision/recall on box membership before letting it loose on 305
pages.  The judge-stage pattern is available if precision needs it.

## 6. Order of work

1. Transform preserve-foreign + orphan report (§4 — small, unblocks
   everything else from the mapping-lock).
2. Schema vocab into rand (§3.1) + spine generalization + attach op
   (§3.2), with tests.
3. Page-editor sweep + per-dictionary links + per-book target
   dictionary (§3.3–3.5).
   — hand-tagging of rand now works end to end —
4. Printed->scan page map script (§5).
5. Binder stage + the 10-page eval set (§5).
6. Full run; worklist reports; iterate promptVersion as needed.

## Open questions (dz)

- Approval posture for binder-created references: born-approved (like
  the log/import precedents — rand has no review flow yet) or left
  pending for the day rand enters review?  Design assumes
  born-approved with the '~rand-binder' stamp as the audit handle.
- MMO attach-to-existing picks the FIRST subentry (§3.2) — fine
  until a real multi-subentry tagging need appears?
