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

**Per-(book × dictionary) tagging SHEETS** (dz 2026-07-26, revising
the earlier per-book-default-dictionary idea).  Each dictionary gets
its OWN tagging layer per book — in the image tagger, rand starts
with a clean sheet on the Rand book even though MMO's 2,044 existing
groups sit on the same pages (in MMO's layer); pulling references
for MMO is separate from pulling references for rand.  The layer IS
the scope: the page editor opens on a (book, dictionary) sheet, and
everything that needed a "which dictionary?" answer reads it from
the sheet — "Create word from this group" targets the sheet's
dictionary with no config and no menu ambiguity, and the sidebar's
reverse lookup queries exactly one dictionary's table.  Mechanically:
the `layer` table gains a nullable `dictionary` column (NULL for
Text/PageBox; the existing Tagging layers are stamped `'dict'`,
which attributes MMO's current tagging with ZERO group moves; rand's
sheets lazily create as today's Tagging layer does).  The dictionary
tables record NOTHING about layers — `bounding_group_id` is globally
unique, so existing `ref` facts are untouched and a group's sheet
stays derivable.

**References are a PER-DICTIONARY asset; dictionary↔dictionary
PAIRINGS are the conduit** (dz).  MMO will not re-tag the Rand book:
auto-pairing rand↔MMO entries lets MMO's word view show its own refs
∪ its paired rand entry's refs (with "via Rand" provenance).  Later,
PDM→RAND auto-matching proposes refs from RAND entries into the PDM
book (on rand's PDM sheet) — and that imagery flows to MMO through
the same pairing with no MMO-side writes.  Matching PDM against rand
first is right because rand is the most complete surface (31,723
entries vs MMO's ~9k) and PDM is textually descended from Rand, so
the correlations are strongest; match once against the fullest set,
let pairings distribute it.  §6 develops this flow; MMO's existing
direct Rand-book refs are simply grandfathered (human work — pairing
supplements, never replaces).

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

STATUS (§3.1 + §3.2): BUILT 2026-07-26.  The vocab subtree was
copied VERBATIM from MMO's live schema into rand-transform.json at
/entry/document_reference (only the $view order changed, 12 at the
entry level); dev instance transformed to generation 5 with the
schema installed.  lexeme-ops: `referenceChain()` (the spine as
schema data), `boundingGroupBind()` (no attr literals),
createLexemeFromGroup rewritten chain-driven, addReferenceToEntry
added (plain pending posture, same as create).  Tests:
reference-spine_test.ts (spine-0 create+attach on a toy dictionary
via the editorAppFor facade; spine-1 attach reusing MMO's first
subentry) + the existing MMO create regression in
page-word-sidebar_test.ts.

**3.3 Sheets + the sheet-scoped reverse lookup.**  The `layer`
table gains the nullable `dictionary` column (§2); startup stamps
the existing Tagging layers `'dict'` (same idempotent-DDL pattern as
the dict index migration); `pageEditor(...)` resolves/creates the
sheet for its (book, dictionary) instead of the hardcoded
`'Tagging'` layer.  `pageWordRows(page_id, layer_id)` then queries
ONE dictionary's table — the sheet's — with the role relation's
actual tag and the boundingGroup field's actual bind read from that
dictionary's schema (no 'ref'/'attr1'/'dict' literals), restricted
to groups in the sheet.  Table names interpolate into the SQL before
prepare, one memoized statement per dictionary (the established
prepared-query pattern).

**3.4 Sidebar + links.**  Word rows render through the sheet's
dictionary: summaries via its store + schema-roles (headword/gloss
are already generic — the facade browse pages use them today); links
via the dotted facade routes (`wordwiki.dicts.rand.word(...)` / the
per-dictionary lexeme editor facade); MMO sheets keep their existing
URLs.  The `o`/`e` hover keys and the context menu inherit the
sheet's dictionary; `newLexemeFromGroup` reads it from the group's
layer (no client-side dictionary parameter to get wrong); a parallel
`addReferenceFromGroup(entry_id, group_id)` rpc serves the attach
flow, dictionary again from the layer (sidebar search-pick later if
hand-attach wants UI — the binder doesn't need it).  LATER, cheap:
an "onion-skin" read-only toggle showing OTHER dictionaries' sheets
on the page, so taggers don't blindly re-draw regions someone else
already boxed (page scan data is already layer-parameterized).

**3.5 Entry pages.**  render-entry-meta's `$shape: boundingGroup`
dispatch should render rand references (scan crop + page-editor
link) as-is once the schema declares them — verify on the facade,
fix what reaches for MMO-specific context.  The public/publish
renderer is OUT OF SCOPE (rand is not published; when it is, the
bundle-ized scan renders already exist).

STATUS (§3.3–3.5): BUILT 2026-07-26.  `layer.dictionary` column +
`ensureLayerColumns()` (late-column + 'Tagging'→'dict' stamping,
run from ensureNewStyleTables; the dev instance's five Tagging
layers stamped); `getOrCreateTaggingSheet(document_id, dictionary)`
— the default dictionary keeps the bare 'Tagging' name (existing
URLs/groups untouched), other sheets are 'Tagging:<table>' so the
(document, name) uniqueness holds with zero index DDL.
pageEditor(...) gained a trailing `dictionary='dict'` param;
pageWordRows/sidebar are sheet-scoped (the layer resolves the
dictionary, its table/tag/bind come from that schema — no literals);
facade rows use the same lm-lexeme-view/lm-edit-pencil anchor
classes, so the context menu and o/e hover keys work unchanged;
newLexemeFromGroup resolves the dictionary FROM THE GROUP'S SHEET
and returns editUrl (client follows it); NEW rpc
`wordwiki.addReferenceFromGroup(entry_id, group_id)`;
deleteBoundingGroup's guard now checks EVERY dictionary's refs.
The facade word page injects the scan renderer (same composition as
the MMO word view; dangling groups degrade quietly).  Tests: the
sheets disjointness/create/attach/guard test in
page-word-sidebar_test.ts + the §3.5 render pin in
reference-spine_test.ts.  Hand-tagging of rand now works end to
end: open `wordwiki.pages.pageEditor('Rand', N, 'Text', 'rand')`.

**3.6 Tests** (render->act->render, in-memory db, the generic test
layer): create-from-group in a no-subentry dictionary (spine length
0) + MMO regression (spine length 1); attach-to-existing on both;
two dictionaries' sheets on the SAME page staying disjoint (each
sidebar sees only its own sheet's groups + words); the existing-
Tagging-layer stamping migration; facade sidebar links.  Pin one
real flow end to end on the RAND sample fixtures.

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

STATUS: BUILT 2026-07-26 (`--preserve-foreign` on the transform CLI;
runTransform opts.preserveForeign).  Ownership is FACT-granular as
in the machine-contributors predicate: a fact id any of whose rows
has a foreign author survives WHOLE (histories + chains — a human
edit/tombstone is a row on the same id, so this is one DISTINCT-id
query).  Computed rows never displace a preserved fact; nothing is
re-created under a human-tombstoned ancestor (no resurrecting a
deleted sense's children).  Two design deltas the store's
throw-on-load validation forced, both improvements:
 1. Preserve runs REUSE the stored transform_stamp, so rebuilt rows
    keep their born valid_from — preserved human versions (always
    later) still postdate their rebuilt parents, and preserve
    re-runs are byte-stable.
 2. Orphans are re-parented under machine SKELETON stubs (entry/
    spine rows authored '~dict-transform', change_note marks them)
    rather than left dangling: the store keeps loading, the human
    work stays visible and editable in-band, and the stubs — being
    machine-owned — vanish or re-derive on later runs as the
    orphans get resolved.  The report lists orphans + preserved-by-
    author + skipped counts.
Tested: edit survives whole / tombstone stays dead + children not
resurrected / hand-added fact survives / refusal without the flag /
orphan + skeleton with the store loading throughout.

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

STATUS: BUILT + APPLIED 2026-07-26.  The mapping lives as
`scanned_page.printed_page_number` (nullable; late-column via
ensureScannedPageColumns).  printed-pages.ts derives it: per-page
top-band integer candidates from the Text layer (with a
digit-only-token OCR-confusion decode - Clark's 'I2' = 12; guide
words can never become numbers), then a SEQUENCE FIT - runs of
constant printed-minus-scan offset, interior interpolation,
conflicts reported never trusted, plus a ±1 section-opener edge
rule (a folio-less body page 1 under its section title - Rand's
scan 13).  CLI `derive-printed-pages <book> [--apply] [--report=]`
is dry-run-first (human spot check).  Applied: Rand scan 13-298 ->
printed 1-286 (offset -12, 284 confirmed, 0 conflicts), Clark scan
39-210 -> printed 1-172 (offset -38, 27 confirmed - Clark's tiny
folios mostly missed by OCR; consistent offset + confirmed
endpoints carry the interpolation).  Cross-validated against the
citations: 32,114/32,115 Rand cites and 28/28 Clark cites fall
inside the derived ranges (the outlier is a literal 'p 0' typo).
Binder lookup: page_id by (document, printed_page_number).

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
bounding_group on RAND'S OWN SHEET of the Rand book (the §2
per-dictionary layer — MMO's 2,044 existing groups stay untouched on
MMO's sheet), copy the chosen Text boxes into
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

STATUS: THE BINDER STAGE IS BUILT (2026-07-26); the full-book run
awaits dz's review of the eval report.  reference-binder.ts: page
input assembly (the citation relation found by book+page NAME probe;
candidates carry both-lane headwords, glosses, full cited-page
lists; boxes ordered left-column-then-right), the Opus stage on
extract.ts (PROMPT_VERSION_BIND 1, imageBox 2000, full input json in
the cache key), landing (group on the dictionary's sheet, grey-box
copy semantic, addReferenceToEntry via a facade whose
currentUsername IS '~<dict>-binder'), idempotence (an entry already
referencing a group on the page is skipped - hand tags win),
threshold gating, and driver-side reconciliation of contradictory
model output (dupe bindings, bound-and-unmatched).  CLI
`bind-references <book> <dict> --cited-book=... --printed=A-B
[--apply] [--min-confidence] [--report=]`, DRY-RUN by default.
One corpus lesson folded into the prompt: several candidate entries
legitimately share the same printed lines (one Watson record per
Mi'kmaq equivalent), so boxes are NOT exclusive.
LIVE 10-PAGE EVAL, v1 vs v2 (printed 46-55, dry runs):
 - v1 (headwords + sparse gloss as keys; watson/rand-binder-eval.md):
   1,067 candidates -> 924 proposed (87%), 103 below-threshold + 48
   unmatched, 0 bad box ids.
 - v2 (PROMPT_VERSION_BIND 2, dz's expected-words insight;
   watson/rand-binder-eval-v2.md): candidates carry the book's OWN
   text round-tripping back - `english` (\\xe, ~100% coverage, the
   near-verbatim printed phrase) and `source_spelling` (\\xv, the
   book's own orthography, --source-lane=rand) - with the prompt
   ranking them PRIMARY, skeleton-matching the Mi'kmaq side (OCR
   loses accents; read the image when garbled), modern headword
   demoted to corroboration.  RESULT: 1,065/1,067 proposed (99.8%),
   0 below-threshold, 0 bad boxes, 2 genuinely-unmatched.  ~18.9k
   in / 3.5k out tokens per page -> full book ~5.4M in / 1M out.
   (Gloss coverage is only 14% - the \\xe/\\xv keys are what
   carried v1 -> v2.)  Driver reconciles contradictory model output
   (dupe bindings; bound-and-unmatched; non-candidate ids).
   --model is a CLI knob (in the cache key) for A/B against the
   Claude 5 family when wanted; extractions memoized - the eval
   re-ran at 0 calls, --apply after review pays no LLM.
 - v3 (dz's review catch, entry 48794 'buffoonery'): Textract
   sometimes has NO BOX for the accented tail of a line (only the
   English start is boxed), so the binder could not frame the
   Mi'kmaq at all.  The model now flags TRUNCATED boxes
   (extend_box_ids - verified against the image), and the landing
   widens OUR COPY to the column edge (Text-layer originals
   untouched; columns split at the page midline).  Review page
   marks them 'widened'.  10-page re-run: 1,064/1,067 proposed,
   4 widened, 2 below-threshold, 2 unmatched.
 - The VISUAL review page (--review-html=, e.g.
   resources/rand-binder-review.html): every proposal as scan
   region + the FULL entry rendering (the word view's metadata
   renderer + site CSS) side by side - the dry-run review surface
   and, post-apply, the what-was-landed gallery.
Tests: reference-binder_test.ts (input assembly incl. the v2 keys,
landing, sheet + authorship, idempotence, thresholds,
dry-run-writes-nothing) over an injected extractor.

## 6. The cross-dictionary flow (imagery travels by PAIRING)

The end-state (dz 2026-07-26): each dictionary tags books on its own
sheets; entry-level PAIRINGS between dictionaries let imagery (and
eventually more) flow without cross-writes.

- **The pairing entity.**  rand↔MMO pairs are themselves FACTS — a
  role-marked, xref-shaped relation on the entry (designed:
  wordwiki/similarity-design.md, 2026-07-27 — the three-pass
  similarity engine with per-purpose landings).  That makes pairing a
  machine-contributors citizen: '~rand-mmo-pair' proposes (the
  mark-insensitive match keys from rand-orthography-survey.md are
  the candidate generator), a human confirming or severing a pair
  FREEZES it, and re-runs respect both.  The pairing relation is
  load-bearing for everything downstream (imagery flow, batch word
  joining, dup detection) — build it once, as data, not per-feature.
- **Rendering through the pair.**  MMO's word view shows: its own
  document references ∪ its paired rand entry's references, badged
  with provenance ("via Rand").  Read-side only — no MMO facts are
  written.  The same composition later shows PDM imagery that rand
  acquired via PDM→RAND matching: the chain is transitive by
  construction.
- **PDM→RAND matching** (later): '~pdm-rand-binder' proposes refs
  from RAND entries into the PDM book, on rand's PDM sheet, PENDING
  posture (uncertain matches; the approval workflow is the control
  surface per machine-contributors-design.md).  Rand-first because
  rand is the most complete surface and PDM is textually descended
  from Rand — match once against the fullest set, let pairings
  distribute it.
- **Publish**: MMO's public pages rendering via-pair imagery means
  the publish bundle follows the chain into rand's refs (and rand's
  sheets' scan renders).  A widening of what publish-source bundles,
  not a redesign — noted for the pairing project.
- MMO's existing direct Rand-book refs: grandfathered human work;
  pairing supplements, never replaces or migrates them.

## 6a. Identity across drops: CONTENT-KEYED import ids (dz 2026-07-26)

Asking "what invalidates the binder cache?" surfaced the real issue:
POSITIONAL import ids.  A record inserted mid-file shifted every
later id - which would not only re-extract every page (file order is
orthogonal to page order, so 'half' is really 'all'), but worse,
make preserved human work MIS-ATTACH after a re-drop (old ids dealt
to different records).  sfm-import now mints CONTENT-KEYED ids (see
multi-dictionary-survey.md phase 5): unchanged records keep their
identity across drops, edited records orphan visibly, and the
binder's prompts/cache keys stop moving.  Same applies to future
cross-dictionary links (dz) - and post-dev, re-imports should be
rare anyway.  Dev re-imported (randraw gen 3, rand gen 6); the
10-page eval re-extracted once under the new ids (1,064/1,067,
3 below-threshold, 2 unmatched - v3-equivalent).

## 6b. What the 'rand' corpus IS (dz 2026-07-26, reading the bindings)

Reviewing a thousand proposals side by side made two things plain
that the doc should state:

**This is not Rand - it is Rand + WATSON'S REVISIONS.**  Watson's
entries carry details and differences with no counterpart on the
printed page (modernized headwords, regularized English, added
analysis).  Consequences:
- PROVENANCE IN THE DISPLAY NAME: the dictionary's config `name` is
  set to "Rand 1888, transcribed and revised by Watson" (config
  data - refine freely).  The zpt partition records where the
  revision effort landed (final vs queue).
- THE ARCHIVAL LAYERING IS ALREADY RIGHT, but say it: the
  print-as-printed is the SCAN + the bindings; Watson's \xv/\xe
  are an INTERPRETATION layer (not a diplomatic transcription); the
  modern headwords a third layer.
- FUTURE (machine-contributors feature): a FIDELITY JUDGE stage -
  the binder already holds the printed line's image and Watson's
  version per entry; a judge classifies each binding faithful /
  orthography-modernized / reworded / enriched / discrepant.  Turns
  "a fair amount of differences" into a browsable worklist and a
  question list for Watson.  Same memoized substrate; build when
  wanted.

**The SOURCE is ambiguous and over-sparse** (Rand's method: several
Mi'kmaq equivalents per English phrase, collected from multiple
informants/dialects, with no guidance on which to use when - the
gap Clark 1902 already tried to fix).  Consequences:
- THE BINDINGS RECOVER RAND'S SYNONYM SETS FOR FREE: sibling
  entries bound to the SAME printed lines are exactly "the several
  Mi'kmaq words for this English" - a ready-made seed for the
  related-words feature and a natural word-view grouping ("Rand
  also gives: ...").  No extra machinery - it is already data.
- THE DISAMBIGUATION RAND LACKS LIVES IN MMO: once rand<->MMO
  pairing exists, "attested in modern MMO" (recordings, examples,
  speaker review) becomes an automatic annotation over each synonym
  set - and the residue (Rand words with NO modern attestation) is
  the most interesting list in the exercise for the researchers.
- Confirms the §6 pairing design: pair on Mi'kmaq spelling
  skeletons, never on the shared English.

## 7. Order of work

1. ~~Transform preserve-foreign + orphan report (§4)~~ DONE
   2026-07-26 (see the §4 STATUS block).
2. ~~Schema vocab into rand (§3.1) + spine generalization + attach
   op (§3.2), with tests~~ DONE 2026-07-26 (see the §3.2 STATUS
   block).
3. ~~Sheets (layer.dictionary column + stamping migration) +
   sheet-scoped lookup + per-dictionary links (§3.3–3.5)~~ DONE
   2026-07-26 (see the §3.5 STATUS block).
   — hand-tagging of rand now works end to end —
4. ~~Printed->scan page map script (§5)~~ DONE 2026-07-26 (see the
   §5 STATUS block; applied for Rand + Clark on the dev instance).
5. ~~Binder stage + the 10-page eval~~ BUILT 2026-07-26; the dry-run
   eval report (watson/rand-binder-eval.md, printed 46-55) is
   AWAITING DZ REVIEW (see the §5 binder STATUS block).
6. Full run (--apply, then the remaining pages); worklist reports;
   iterate promptVersion as needed.
   STATUS 2026-07-27: the SAMPLE pages are APPLIED on dev - 1,062
   '~rand-binder' references + groups on rand's sheet; word views
   show their scans.  --preserve-foreign PROVEN live: a full
   re-transform (gen 8) preserved all 1,062.  The pipeline is
   INTEGRATED into importWordWikiV1Db.sh (steps 14-16 of 19:
   rand corpus import+transform, printed pages, sample binding -
   re-migrations re-derive everything; binder extractions ride the
   shared derived store, so warm re-runs cost zero LLM).  All four
   passes report on the STANDARD FINDINGS CHANNEL (dz): --report =
   findings fragment (unmapped tail, parse misses, page conflicts,
   binder worklist - the researcher review surface, assembled into
   import-report.md / wordwiki.importReport()); --details = the
   full native markdown (the committed watson/ artifacts).
   NAVIGATION: the navbar's data-driven Dictionaries menu lists
   every discovered dictionary (-> wordwiki.dicts.<t>.home()), and
   Reports gains the Rand Binder Review gallery link.
   Still pending dz's go: the remaining pages (--printed=1-286).
7. (Own project) the pairing relation + rand↔MMO auto-pair, then
   via-pair rendering (§6); PDM→RAND matching after that.

## Open questions (dz)

- Approval posture for binder-created references: born-approved (like
  the log/import precedents — rand has no review flow yet) or left
  pending for the day rand enters review?  Design assumes
  born-approved with the '~rand-binder' stamp as the audit handle.
- MMO attach-to-existing picks the FIRST subentry (§3.2) — fine
  until a real multi-subentry tagging need appears?
- Sheets for the SAME dictionary across worktrees/instances share the
  layer row by (document, dictionary) — any need foreseen for MORE
  than one sheet per pair (e.g. a scratch sheet)?  Design assumes no.
