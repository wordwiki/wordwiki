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
