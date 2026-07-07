---
name: relation-names-in-ui
description: "User-viewable content shows FULL relation names (RefPublicNote), never the three-letter db tags (rnp) — use entrySchema.relationDisplayName(tag)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

dz (2026-07-07, on the migration reports): "in those reports (and generally in user viewable content), would you mind using the full names for the relations not the three letter versions (rnp => RefPublicNote)."

**Why:** the tags (spl/rnp/rse…) are db identity, meaningless to the volunteers/staff who read reports and pages.

**How to apply:** `entrySchema.relationDisplayName(tag)` (entry-schema.ts, backed by `relationDisplayNameByTag`) is the one source — keyed by TAG because relation field names are NOT unique (entry.note and document_reference.note are both named 'note'). Findings/warnings use the name only; report TABLES may keep a small `tag` column as a db cross-reference. Adopted 2026-07-07 in the variant scan/migration reports and verify-workspace warnings — extend to any new user-viewable surface ([[fix-orthographies]] reports especially).
