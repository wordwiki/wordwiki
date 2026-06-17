---
name: versioned-db-validation
description: "VersionedDb structural-integrity infrastructure (validator, repair, throw-on-load) — pre-project step 1 for the publication model; reference-oracle is step 2 (not built)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

Pre-project for the publication/approval model ([[publication-approval-model]]):
make the persisted assertion store self-checking so corruption is caught
immediately, before user data piles on top. STEP 1 DONE (2026-06-13/14):

- `wordwiki/versioned-db-validate.ts` — read-only structural sweep over a
  MINIMAL per-fact view (`FactView`: ordered version records + parent
  earliest-time), NOT the workspace tree, so the same checker will later
  validate the in-core reference oracle and export files. Checks: orphans,
  first-version-replaces (dangling head), broken replaces-chain, overlapping
  intervals, valid_from<=valid_to, dangling closed tail, temporal containment,
  global assertion_id uniqueness. `assertVersionedDbValid` throws.
- Incremental write-path checks in `workspace.ts` `_trackAssertion` (apply
  paths, load+live): assertion_id uniqueness + valid_from<=valid_to.
- THROW-ON-LOAD: `ww.workspace` getter runs `assertVersionedDbValid` at end of
  load and throws (editor bricks on corruption — fine, public site is baked
  static). One O(n) sweep per full load, not per edit.
- `./wordwiki.sh verify-workspace` (read-only, exit 1) + `repair-assertions`
  (idempotent, guarded, data-driven, refuses non-head dangling refs).
- migrateDevDb.sh now 9 steps (added repair-assertions + verify-workspace);
  production recipe at top mirrors it.

FINDINGS from running on real prod-pull data: (1) 5 dangling chain heads
(born-dangling rtr/rex/alt from old create-then-edit path; 5 in 226k, all
heads, zero mid-chain — store otherwise clean) — repaired. (2) published_from/
published_to NOT virgin: ~151k rows have constant 2020 epoch-ms placeholder
(different time-space than valid_from) — publication-model.md Phase 0 now
clears it first.

STEP 2 DONE (2026-06-14): reference oracle + property test.
- `versioned-model.ts` — shared OBSERVABLE interface (`VersionedModel`: apply +
  plain-data `fullHistory`/`currentView`), NOT the tree; + `VersionedDbModel`
  production adapter (views via the real tree+query layer = code under test).
- `reference-model.ts` — `ReferenceModel`, a flat Map<factId,versions[]> +
  brute-force views, shares NOTHING with production tree/query; apply mirrors
  applyProposedAssertion checks/accept-reject/predecessor-close exactly.
- `reference-model_test.ts` — seeded generator (ops biased to edit/del/restore/
  move on EXISTING facts + stale writes that must reject), applies each op to
  BOTH, after every op asserts: same accept/reject; identical serialized views;
  production+oracle structurally valid. Path-sorted plain-data compare,
  order_key as value not position, same clock+ids fed to both. Committed 40x150;
  stress 200x400 (80k ops) clean. KEY GOTCHA: BEGINNING_OF_TIME = 1577836800000
  (the 2020 constant — also the legacy published placeholder); all test
  timestamps must exceed it.
- The PUBLICATION-dimension in-core model will EXTEND this (published views/
  exports) reusing the same interface + harness.
