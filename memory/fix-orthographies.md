---
name: fix-orthographies
description: "MAJOR planned change — variant field narrows to orthography only; THE doc is wordwiki/fix-orthographies.md (living, update against it)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Approved direction (2026-07-07): `variant` = orthography ONLY; locale gets a separate mechanism later. THE doc is wordwiki/fix-orthographies.md — dz's proposal merged with review discussion + live-db scan results; future updates go against it.

Key settled points: $notVariant fields droppable (scan gate CLEARED, table in doc); new schema flags $notVariant/$mixed/$allowAll/$defaultAll/$metaVariant; spelling never $allowAll; 'mm' wildcard semantics via ONE central predicate (duplicate-spelling detection must adopt it); primary_orthography user field seeds a session working-orthography; per-tuple annotations = TWO assertion-table columns (internal note reuses the UNUSED `note` column; public 'aside' is the only new column), default-hidden in editors.

STAGE 1 BUILT (2026-07-07): model.ts parses the $ flags (VariantField.variantFlags; $notVariant exclusive, $defaultAll⇒$allowAll; variant-fields-must-be-leaves parse rule) — dz's flag WIP in entry-schema.ts (still uncommitted, HIS to finish) now parses and the server boots with it; findings-report machinery (wordwiki/findings.ts — console+markdown, generated-at banner, lexemeLink bases); variant-policy.ts (variantPolicyByTag/allowedVariantValues — the shared schema-driven policy); `scan-variants` subcommand (drop gate = exit code, dirt findings, --report md); verify-workspace reports variant invariants as aggregated WARNINGS (warn mode; live db: 0 structural problems, ~28k variant warnings as expected pre-migration).

STAGE 2 BUILT (2026-07-07): variantMatches/variantsOverlap + variantMatchSql ($allowAll-driven) in variant-policy.ts — THE central 'mm' predicate, legacy blank = wild until migration; spelling-duplicates adopted it (mm vs mm-li = same-orthography). `aside` column (late-column ALTER via ensureAssertionColumns at startup; internal note reuses `note`); annotations flow: disclosure inputs (fact_aside/fact_note) in edit+insert dialogs, annotation-only edits are real edits, $aside rides the JSON projection (note deliberately not), rendered next to the value (note internal-audience only), was-diff shows distinct aside/note chips. `primary_orthography` EnumField on user record → new-content variant default ($defaultAll → 'mm'); needs `upgrade-db --apply` per instance; session switcher NOT built (open question).

STAGE 3 BUILT + DEV-REHEARSED (2026-07-07): `migrate-variants` (variant-migrate.ts) — mute-in-place, idempotent, refuses prod, preconditions re-checked (FLAGGED schema required, drop gate, mapping coverage); decision tables `blankBackfillByTag` ($defaultAll tags → 'mm', others → 'mm-li') + `valueFixesByTag` (rse mm→mm-pm, orf/spl mm→mm-li) — DZ TO CONFIRM before staging/prod. Dev rehearsal: 32,184 rows, idempotency proven, warnings 28,031 → 5 (the hand-triage spellings). LIVE cleanup report wordwiki.variants.cleanupReport() (nav "Variant Cleanup") = staff triage queue, self-draining. FLAGGED SCHEMA LANDED (2026-07-07 — dz ok'd committing his annotations; the set-aside dance is RETIRED); migrate-variants is migrateDevDb.sh step 10 + cutover recipe steps 13/14; committed record variant-migration-report.md. Real event still needs: run per instance (staging → production) → flip variant invariants to throw-on-load (blocked on the 5 hand-triage rows).

Pending: stage 4 auto-transliteration; status remodel build. Sequencing: staged code, ONE data-migration event.

**Why:** the pending auto-transliteration to Smith-Francis (the majority orthography) is THE motivation — settled design in the doc's Auto-transliteration section (2026-07-07): editor button, `auto-transliterate` system user authors unapproved mm-sf siblings, per-word-at-edit-time never bulk, approve-all EXCLUDES auto facts, review row shows the li source, corrections harvested from history as the regression corpus, transliterator version in change_arg. Status remodel (sta lifecycle + pub gate) CONFIRMED incl. Complete rename / archive-keeps-gate / PDMOnly-no-gate.
**How to apply:** read the doc before touching variant-related code; [[route-undeclared-bug-pattern]] and [[spelling-duplicates]] interact.
