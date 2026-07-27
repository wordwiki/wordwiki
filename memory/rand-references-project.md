---
name: rand-references-project
description: "APPROVED design — bind Rand scan images to rand entries via the documentReference ROLE (planted under entry root, no subentry); Opus auto-binder phase 2; doc wordwiki/rand-references-design.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Design written 2026-07-26 (dz approved the shape): rand entries get
document references like MMO's, doc of record
`wordwiki/rand-references-design.md`.  Key converged points:

- The ROLE is the planting mechanism: MMO keeps
  /entry/subentry/document_reference, rand plants the SAME vocab
  (tags ref/rtr/rex/... verbatim) at /entry/document_reference; code
  asks `relationsByRole.documentReference`, never a path.
- SHEETS (dz 2026-07-26): tagging layers are per-(book x dictionary)
  — layer.dictionary column, existing Tagging layers stamped 'dict',
  rand starts clean sheets; the layer IS the scope (create/attach
  target, sidebar lookup — no default-dictionary config, no sweep).
  References = per-dictionary asset; entry PAIRINGS (rand<->MMO,
  machine-contributors citizen) are the conduit — MMO renders own ∪
  via-pair refs; later PDM->RAND matching flows to MMO transitively.
- preserve-foreign BUILT + landed 2026-07-26 (order-of-work step 1):
  fact-granular ownership, stamp reuse (byte-stable preserve
  re-runs), orphans re-parented under machine skeleton stubs.
- Step 2 BUILT 2026-07-26: document_reference vocab verbatim from
  MMO's live schema into rand at /entry/document_reference (dev at
  transform gen 5); lexeme-ops referenceChain()/boundingGroupBind(),
  chain-driven createLexemeFromGroup + NEW addReferenceToEntry
  (reuses first live spine tuple; plain pending posture); tests in
  reference-spine_test.ts.
- Step 3 BUILT 2026-07-26 (sheets): layer.dictionary column +
  ensureLayerColumns stamping ('Tagging'->'dict'); sheets named
  'Tagging:<table>' (dict keeps bare 'Tagging'); sheet-scoped
  pageWordRows/sidebar (facade rows reuse lm-lexeme-view/
  lm-edit-pencil classes so menu + o/e keys just work);
  newLexemeFromGroup resolves dictionary from the GROUP's sheet +
  returns editUrl; NEW rpc addReferenceFromGroup; delete guard
  checks all dictionaries; facade word page renders scans.
  Hand-tag rand: wordwiki.pages.pageEditor('Rand', N, 'Text',
  'rand').
- Step 4 BUILT+APPLIED 2026-07-26: scanned_page.printed_page_number
  (late column) derived by printed-pages.ts sequence fit (offset
  runs + interpolation + ±1 section-opener edge + OCR digit-
  confusion decode); CLI derive-printed-pages (dry-run first).
  Rand scan 13-298 = printed 1-286 (offset -12, 0 conflicts);
  Clark scan 39-210 = printed 1-172 (offset -38, sparse folios,
  endpoints confirmed).  Citations cross-validated 32,114/32,115.

- Step 5 BUILT 2026-07-26: reference-binder.ts on extract.ts/
  getDerived (memoized; PROMPT_VERSION_BIND 1, imageBox 2000);
  candidates by citation (book+page NAME probe); boxes NOT exclusive
  (one Watson record per equivalent -> siblings share lines);
  landing = sheet group + grey-box copies + addReferenceToEntry
  authored '~rand-binder' (facade currentUsername); idempotent;
  CLI bind-references, DRY-RUN default.  LIVE EVAL printed 46-55:
  v1 (headwords+sparse gloss) 924/1067 (87%); v2 (dz's
  expected-words insight: \xe english + \xv source_spelling as
  PRIMARY keys, skeleton-match the Mi'kmaq, --source-lane=rand)
  1,065/1,067 (99.8%), 0 below-threshold, 2 unmatched — report
  watson/rand-binder-eval-v2.md AWAITING DZ REVIEW; full book est
  ~5.4M in/1M out tokens; --model CLI knob for 5-family A/B.
  v3: truncated-box widening (Textract has NO box for accented
  line tails - model flags extend_box_ids, landing widens the COPY
  to the column edge) + --review-html visual page (scan + FULL
  entry side by side, resources/rand-binder-review.html).
  10-page v3: 1,064/1,067, 4 widened.
- CONTENT-KEYED import ids (dz approved 2026-07-26): 53-bit FNV of
  canonical record text (+occurrence), field ids by ordinal, space
  [2^44,2^53) disjoint from counters/derivedId; unchanged records
  keep identity across Watson drops (cache + refs + links survive;
  edits orphan visibly).  Dev: randraw gen 3, rand gen 6, eval
  re-extracted once (1,064/1,067).
- Transform iteration 2 (dz 2026-07-26): entryValidFrom (ent
  valid_from = shoebox \dt via mapping {from,parser}; children keep
  stamp), VALUE replaceAll ('_'->' ' on ge/de), and OWN orthographies
  watson-li/watson-sf/rand seeded (lanes off mm-li/mm-sf; survey .py
  updated; editor dropdowns show them until vocabulary scoping).
  rand gen 7; eval re-extracted (prompt lanes/glosses changed).
- STANDING (dz): keep refreshing the SAME sample pages (printed
  46-55) after every pipeline change.  Sample now APPLIED (2026-07-27,
  dz asked): 1,062 '~rand-binder' refs live on dev; refresh command:
  bind-references Rand rand --cited-book='Rand 1888' --printed=46-55
  --source-lane=rand --apply --details=../watson/rand-binder-eval-v2.md
  --review-html=../resources/rand-binder-review.html (idempotent
  top-up; --report= is now the FINDINGS fragment channel).  NO full
  run until dz says.  Dev transforms MUST use --preserve-foreign now
  (refs are foreign facts; proven: gen 8 preserved all 1,062).
- Migration integration (2026-07-27): importWordWikiV1Db.sh steps
  14-16/19 = rand import+transform, printed pages (Rand+Clark),
  sample binding; all on the standard findings channel (--report=
  fragment, --details= native md); EXPECTED tokens rand-import
  rand-transform rand-printed-pages clark-printed-pages rand-binding.
  Navbar: data-driven Dictionaries menu + Rand Binder Review link.
  PROVEN end-to-end 2026-07-27 on a fresh production pull (dz pulls
  OUTSIDE the container - the staging ssh key is not available
  inside): all 19 steps exit 0; step 14 created rand from scratch;
  1,062/1,067 bound at LLM 0 calls (shared derived store survives
  re-migration); mapping carries targetName so the display name
  reproduces.
  Binder landing is now O(n) (idempotence check via pure SQL, quiet
  batch apply - touching store.entriesById per binding rebuilt the
  entries JSON 1,062x = hours).
- dz's review insights (doc §6b): the corpus IS Rand + Watson's
  REVISIONS (display name config set to 'Rand 1888, transcribed and
  revised by Watson'; \xv/\xe = interpretation layer, scan+bindings
  = the print); source is sparse/ambiguous (several equivalents per
  English) -> bindings recover Rand's SYNONYM SETS free (shared
  lines), MMO attestation = the missing usage signal; future
  fidelity-judge stage.  NEXT: dz finishes review -> --apply 46-55
  + full run --printed=1-286.
- Only three sites were position/table-bound: createLexemeFromGroup
  (fixed one-wrapper spine → generalize to parentRelation-chain
  spine), pageWordRows (hardcoded `FROM dict` → sweep discovered
  dictionaries), sidebar/context-menu links (→ per-dictionary facade
  routes; per-BOOK default target dictionary as config data).
- Transform gains --preserve-foreign (delete only '~dict-transform'
  rows on re-run; deterministic ids keep paths valid; orphan report)
  so references don't lock the still-open mapping worklist.
- Phase 2 Opus binder: anchor = structured \so pages (99.5%);
  printed→scan page offset map needed; ONE extract.ts ExtractStage
  per page (Text-layer boxes + candidate entries IN, box-id
  groupings OUT) memoized via getDerived() [[scan-extract-feature]]
  pattern — dz explicitly wants ALL AI/image work through the
  derived content store; land as groups in the book's existing
  Tagging layer + addReferenceToEntry authored '~rand-binder';
  10-page hand-bound eval BEFORE the full 305-page run.
- Rand book already scanned in db: 305 pages, 25,252 Text boxes,
  Tagging layer has 2,044 boxes from MMO-side refs; Clark (234
  pages) covered free.

**Why:** rand top-level entry IS the construction — no subentry
ceremony; page editor stays book-generic [[page-editor-book-generic]].
**How to apply:** implement in the doc's §6 order (preserve-foreign
first); don't start unprompted.  See [[multi-dictionary-project]].
