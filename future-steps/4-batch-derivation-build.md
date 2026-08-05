# Thread 4 — build the batch AI derivation (design is done)

## STATUS
- TAKEN 2026-08-05 by claude (dz's main container, session w/ dz live) —
  building in the §9/FIRST-MOVE order: memoization → fake backend + Tier-1
  harness → BatchContext/batchImpl → driver → pilot retrofit.

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
