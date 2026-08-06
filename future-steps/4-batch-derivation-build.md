# Thread 4 — build the batch AI derivation (design is done)

## STATUS
- TAKEN 2026-08-05 by claude (dz's main container, session w/ dz live) —
  building in the §9/FIRST-MOVE order: memoization → fake backend + Tier-1
  harness → BatchContext/batchImpl → driver → pilot retrofit.
- BUILT 2026-08-05 (same session, commits 47d2bf1..0a9c1ad):
  1. getDerived promise memoization (content-store.ts) + tests.
  2. BatchBackend interface + disk-persisted FakeBatchBackend +
     AnthropicBatchBackend (batch-backend.ts / batch-backend-anthropic.ts).
  3. The core (batch-derivation.ts): DerivationNotAvailable, pending
     peer-files, BatchContext (enroll w/ ban-assert, single flush,
     list-and-reconnect, conservative defer, capped retries), batchImplFor,
     awaitAll, runBatchUnits + classifyBatchRun.
  4. extract.ts: ExtractConfig.batch selects the impl under the SAME closure
     (keystone 0); interactive callers untouched.
  5. Tier-1 §12.1 matrix GREEN (batch-derivation_test.ts + the
     testing/batch-pass-cli.ts subprocess harness; <1s, incl. real-process
     crash injection at both windows).
  6. PILOT: bind-references --batch (deferred pages, flush, exit 3 = rerun
     later).  §12b BAN-RUN acceptance gate PASSED (rebuildDerived clean
     under no-llm-calls, binding numbers byte-identical - zero orphaned keys).
- TIER-2 SOAK PASSED 2026-08-05 (batch-soak.sh / liminal/testing/batch-soak.ts;
  report tmp/batch-soak/): 3 hourly runs, 2+1 real batches, ~33.7k in/1.9k out
  haiku tokens (~3c).  All 9 terminal assertions green: depth-3 chains in
  exactly 3 cycles; 40-request fan-out; the injected after-submit crash run's
  orphan batch recovered by LIST-AND-RECONNECT (43 results landed by custom_id
  from a batch no marker knew, NO double-submit - recorded batches at the
  minimum); real per-request errored landing + retry cap; the flagged
  (LIMINAL_NO_LLM=1) full pass served entirely from cache with the err unit
  failing at the cap WITHOUT enrolling.  THE FEATURE IS PRODUCTION-READY.
  Rerun the soak after any change to the batch client/driver/store paths.
- PDM RETROFIT DONE 2026-08-06 (53572b6): `pdm-import --batch` = derivePdm
  cycles (pure, zero db writes, per-page units, exit 3 in flight) then the
  UNCHANGED importPdm lands the whole mirror from cache (commit-at-end for
  the entire import).  cropClosure = the one shared crop key (§12b);
  boxesCropPath derives crops from raw segmentation rects (no group);
  readEntryFromCrop = the dual-mode op.  BOTH ban gates passed on the pilot
  pages: sync relands gen-5 byte-identically; --batch derives all 304
  readings via the new no-group route with ZERO enrollments against the
  real paid cache.  ALL bulk passes (binder + pdm) now batch-capable.
- DUAL-MODE operations (dz 2026-08-06): some ops run BOTH ways - e.g.
  handwriting->text for a PDM entry's bounding boxes is BATCH when
  auto-processing the whole book, SYNC when a user just edited the box.
  The architecture already carries this (keystone 0 + no ambient mode):
  write the op ONCE taking an ExtractConfig; the bulk driver passes
  cfg.batch, the interactive handler doesn't, and the shared key means the
  two modes serve each other's cache (a user-fixed box is a free hit for
  the book sweep, and vice versa - Tier-1 tests this both ways).  The ONE
  discipline the retrofit must hold for dual-use ops: the shared function
  is PURE up to its await (no side effects before the result), because in
  batch mode it unwinds there with DerivationNotAvailable; sync mode never
  throws it, so interactive callers need no catch.

## What / why
Route the BULK pipeline AI passes (Phase 3: PDM segment/read/split/
transliterate, rand binding) through the Anthropic Message Batches API —
50% cheaper (matters: barely-funded), at the cost of a ≤24h SLA handled by a
submit-and-exit-then-resume model.  Interactive editor AI STAYS synchronous.

## Read first (CRITICAL)
- liminal/batch-derivation-design.md — THE full spec (§1-12).  READ IT ALL;
  it's the result of a careful design discussion.  Especially the FOUR
  keystones (§11) and the money-safety §2.
- memory [[batch-derivation]] + [[rebuild-pipeline]] (Phase 3 is where this
  runs).
- liminal/content-store.ts (getDerived — keys by hash([fnName,...args]),
  fns map per-call) + liminal/llm.ts (AnthropicLlm, the no-llm-calls flag).

## Current state
- Design DONE (the doc).  NOT built.  Nothing to undo.

## FIRST MOVE (build order from §9 — test-first, because it's hard to test)
1. **The general win first: in-process promise memoization in getDerived**
   (Map<hash,Promise>) — today two concurrent requests for the same in-flight
   closure BOTH execute (wasted money for AI).  Helps everything, no batching.
2. **FakeBatchBackend + the Tier-1 subprocess harness** (design §12.1).  A
   fake batch client with a CONTROLLED clock + programmable outcomes, driven
   via real subprocess kill/reinvoke against a temp store.  Build this BEFORE
   the real client — it's how you test the multi-run/crash logic in seconds
   instead of days.
3. **The batch client + BatchContext + the batchImpl pattern** (§2, §3.1):
   same NAME/key as syncImpl (money-safety keystone 0 — batch-ness is the
   fns-map impl choice, NEVER a closure arg); custom_id = content hash;
   batchImpl enrolls + throws NotAvailable on a not-ready miss.
4. **The driver + termination detector** (§8): run→flush→classify
   (progress/pure-wait/done)→poll/reschedule/stop.
5. **Retrofit ONE bulk pass as the pilot** into the throw discipline (§6:
   per-run scope, enroll-before-await, commit-at-end, pure replay).  Then
   Tier-1 green + a Tier-2 real-API soak (§12.2) as the acceptance gate.

## Settled decisions — don't reopen (the FOUR keystones)
0. SAME key, different impl: the batch flag NEVER enters the closure/args
   (would orphan the already-PAID cache).  Wrapper selects syncImpl vs
   batchImpl under the same name via the fns map.  [the money-safety property]
1. custom_id = content hash (idempotent landing, robust crash recovery via
   list-and-reconnect).
2. per-run batch scope + enroll-before-await (preserves wall-clock =
   dependency DEPTH × 24h, not count × 24h).
3. commit-at-end (reruns re-execute; no partial DB writes).
- Interactive AI stays SYNCHRONOUS.  No timer/window batching (explicit
  per-run scope + single flush).  Honours the no-llm-calls flag (a batch
  submit throws under it; a cache hit doesn't).
- The fake + harness + soak driver are BUILD DELIVERABLES (budget them).
