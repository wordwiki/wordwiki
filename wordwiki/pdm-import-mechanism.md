# PDM import — the CURRENT MECHANISM (handoff, 2026-07-29)

Status: UNDER ACTIVE DEVELOPMENT.  This doc is the precise state of the
machine as built, for resuming work (written at dz's request before a
context compaction).  Read with: pdm-import-survey.md (the measured
history and decisions), pdm-transcription.md (phase-1 recipe/eval),
transliteration-findings.md Part 4 (the pm-li phonology).  dz's product
vision (browse → one-click import-to-MMO) is recorded verbatim in
memory/pdm-llm-transcription.md and in the survey doc.

## The pipeline, exactly (mikmaq/pdm-import.ts, `./wordwiki.sh pdm-import`)

Per page (default pilot pages 4,40,67,101,172,209,250,324,435,550 - the
hand-tagged gold pages, chosen so dz can COMPARE):

1. **Geometry** (`pdmPage`, mikmaq/pdm-segment.ts): textract word boxes
   ('Text' layer) + the hand Tagging groups (gold, read-only).
2. **Runs** (`clusterRuns`, TUNED_CLUSTER = {yFactor .45, gapPx 60,
   wordUnitBelow 180}): line-level x-gap-broken clusters; word-level
   units on sparse pages.  Tuned by the zero-LLM ceiling sweep
   (`pdm-segment-sweep`).
3. **Segmentation** (`segmentPage`): numbered-overlay image
   (`annotatedPagePath`, content-addressed) → Opus 'pdm-segment'
   GROUPING task (prompt v2; model assigns run numbers to visual
   entries; never coordinates).  On a malformed response after retries:
   the robust 'pdm-starts' + `spansFromStarts` y-band fallback (v3).
   Measured: opus 68.3 pair-F1 / 46% entries exactly recovered vs
   merged visual-entry gold.
4. **Block group**: one bounding group per visual entry on the
   'Tagging:pdm' sheet (boxes COPIED from the Text layer via
   copyRefBoxToNewGroup/ExistingGroup).  The hand 'Tagging' layer is
   never touched.
5. **Reading** (`readEntry`): masked crop (`groupCropPath`) → the
   5-stage recipe (wordwiki/transcribe.ts `pdmRecipe`): transcribe /
   expand / transliterate / source-as-entry / normalize.  ESCALATION
   POLICY (measured, survey doc table): Sonnet letter stages; if
   transcribe confidence < 42 the WHOLE chain re-runs on Opus;
   structuring stages always Opus.  Stage schemas are LENIENT + coerced
   (coerceRuns/coerceConfidence): a degenerate response scores c0 and
   routes into the escalation gate instead of failing.
6. **Word split** (`wordSplitStage`, Opus, on the EXPAND output - where
   elisions are already restored): enumerates every family/paradigm
   word {source (full Pacifique form), normalized (Listuguj citation),
   gloss, confidence}.  This is decision (a)'s secondary layer - the
   per-word granularity the hand taggers produce, applied where the
   READING exists.
7. **Landing**: ONE ENTRY PER WORD (block-level single entry as
   fallback when the split is empty).  Each word-entry:
   - spl mm-li (normalized) + spl mm-pm (source, when different);
   - gls (the per-form English gloss);
   - ref -> its OWN bounding group: the first word keeps the block's
     group, every further word gets an OVERLAPPING TWIN (same boxes
     copied) - strict 1-1 group<->ref, the hand model (dz 2026-07-29;
     the group->entry map `entriesByReferenceGroupId` is 1-1 by type);
   - the five rungs rtr/rex/rtl/rse/rne nested under ref (attr1 text,
     attr2 confidence) - the researchers' own manual field tags, so the
     import-to-MMO copy is field-for-field.
   Content-keyed ids: ['pdm-ent', `${page}\x01${rtr}`, wordIndex,
   source] (NB the \x01 separator - it is IN the source file; greps
   must expect it).  Import-mirror semantics: wipe + rebuild each run,
   human 'tdo'/'log' rows EXEMPT (survive re-imports), foreign rows
   refuse; ensureWorkflowRelations('pdm'); dictionary display name
   'Pacifique (draft)'.

State right now: generation 5, **747 word entries / 7,309 assertions**
from the 10 pilot pages (304 visual blocks, ~2.5 words/block); ~$35
spent; ~$3.5-4/page => full ~700 pages ≈ $2.5-3k, ~half via the Batch
API (NOT yet wired).

## The comparison surfaces (dz's current activity)

- `/resources/pdm-segment-compare.html` - static side-by-side of hand
  vs machine groups per pilot page; generator = pdm/gen-compare-page.py
  (run from mmo/ after an import).
- The LIVE comparison: two browser windows on the same page -
  `wordwiki.pages.pageEditor("PDM", N)` (MMO context, hand sheet) vs
  `wordwiki.pages.pageEditor("PDM", N, 'Text', "pdm")` (machine sheet,
  draft entries with lanes+glosses in the sidebar).  CONTEXT
  PRESERVATION is done: scan links carry the group's layer dictionary,
  the Reference Books menu follows the active dictionary, the
  editor/viewer chrome stamps the sheet's dictionary
  (PageContent.dictionary -> both page templates), and the nav hook
  resolves URL-first (dicts.X or pageEditor's 4th arg) then falls back
  to the server-rendered badge (`data-dict-active` - derived state, not
  a second store) for URL-silent pages like the page jumper.

- dz's OPEN WORRY: the machine tagging may be too different from the
  hand tagging to serve as the staff's basis - he is evaluating with
  the two-window flow.  The per-word groups are currently TWINS (full
  block boxes); if staff need true per-word boxes on the page to trust
  it, pull the box-subset derivation (stem + own suffix/paradigm cell)
  forward from the import button.

## Next steps, in rough order

1. **dz's verdict** on the tagging-basis question (in progress).
2. **pdm joins**: `similarity-rebuild pdm` (explicit - it is an
   import_mirror, skipped by default) + `similarity-verdicts pdm rand`
   / `pdm clark` / `pdm dict`.  entryKeys picks up both lanes
   automatically (mm-pm normalizer registered; mm-li plain).  The
   joins are the evidence links the import button copies.
3. **The import-to-MMO button** (the flow's centerpiece; vision
   verbatim in memory): creates the MMO entry, COPIES the word's
   bounding group to an MMO-owned group (edit-after-copy is the unit of
   decision), copies evidence links (clark/rand joins), shows
   transliteration+translation at selection time, offers re-derivation
   from edited boxes on request.  Per-word BOX-SUBSET derivation
   belongs here (or earlier, per 1 above).
4. **Batch API wiring** (50% price) before any full-book run; then the
   full-run decision with a real quote.
5. **Page atlas** for PDM (printed-page mapping - none exists; the
   staff's bookkeeping is page-based).
6. Segmentation v5 if needed: per-word box assignment as its own stage,
   half-page renders (2x label legibility); the ceiling/oracle
   instruments make every change measurable for free.

## Operational notes (learned the hard way)

- Server: `(nohup ../wordwiki.sh > ../log 2>&1 &)` from mmo/; any CLI
  run auto-stops it; 8GB heap flag lives in wordwiki.sh.
- `no-llm-calls` flag file in mmo/ = proof mode (any actual AI work
  throws; cache hits pass).
- Suite baseline: 682 passed + 1 known pre-existing parseSchemeMd
  failure (~53s).
- Test login: user 'test' (user-passwords.json); GET loginRequest works
  on dev.
- dz edits mikmaq/clark-import.ts in emacs (lock file .#clark-import.ts
  appears; a stray buffer newline once blocked pj land - revert, don't
  commit).
- Costs print per run; every LLM stage is memoized on the extract
  substrate - re-runs are ~free until a prompt version bumps.
