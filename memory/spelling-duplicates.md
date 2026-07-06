---
name: spelling-duplicates
description: duplicate-spelling warning/report + archival-is-delete convention (Archived* prefix); serve startup now runs createAllTables so new dict index lines apply
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Duplicate-spelling detection landed 2026-07-06 (wordwiki/spelling-duplicates.ts is THE doc). Advisory only — never blocks. Rule: same-orthography collision warns; cross-orthography needs no shared distinguishing orthography. Warning renders inside both editor looks' entry-root fragments — spelling edits already emit the root key (headword titleRole), so incrementality needed zero editor plumbing. Report: wordwiki.spellings.duplicatesReport().

**Archival is delete** (dz): resolving a dup = archiving one side. Any status slug starting with 'Archived' counts (isArchivedStatus in entry-schema.ts — the naming convention is load-bearing; ArchivedDuplicate added). Archived words are excluded from dup detection in BOTH directions and marked ARCHIVED in renderEntryCompactSummaryCore (badge) + renderEntryTitle; renderEntrySpellingsSummary deliberately unmarked.

**Gotcha fixed**: createAssertionDml's index DDL only ran at db creation — new CREATE INDEX IF NOT EXISTS lines never reached existing dbs. Serve startup now also runs createAllTables() (idempotent). dict_attr1 index exists for by-value probes.

Matching is exact-text; case/apostrophe normalization deferred — the report shows whether it's needed. TBA/TBD placeholder spellings appear as dups (left in deliberately). Related: [[publication-approval-model]], [[liminal-refresh-model]].
