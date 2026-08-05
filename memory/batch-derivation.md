---
name: batch-derivation
description: "BUILT 2026-08-05: batch Anthropic AI through the derived content store (50% cheaper bulk); Tier-1 matrix green + ban-run gate passed; pilot = bind-references --batch; Tier-2 soak REMAINS before first big paid run; doc liminal/batch-derivation-design.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

BUILT 2026-08-05 (commits 47d2bf1..0a9c1ad; design doc **liminal/batch-derivation-design.md** = the spec, still authoritative). Routes BULK pipeline AI passes ([[rebuild-pipeline]] Phase 3) through the Anthropic Message Batches API — 50% cheaper, ≤24h SLA, submit-and-exit-then-rerun.

What exists:
- liminal/content-store.ts: getDerived in-process promise memoization (concurrent same-key calls share one execution — the double-spend fix) + exported `derivedContentAddress` (THE key computation, one place — §12b key-preservation as code structure).
- liminal/batch-backend.ts: BatchBackend interface + disk-persisted FakeBatchBackend (completes on command; the Tier-1 net). batch-backend-anthropic.ts: the real transport (create/status/results/list, ban asserted at create).
- liminal/batch-derivation.ts: DerivationNotAvailable, pending peer-files (`<contentPath>.pending`), BatchContext (enroll w/ **assertLlmCallsAllowed at enrollment**, custom_id = content hash, ONE flush per run chunked only for API caps, lazy list-and-reconnect landing, conservative defer when markers are batch-less beside unaccounted in-flight batches = provably no double-submit, retry cap default 3), batchImplFor, awaitAll (enroll-before-await discipline), runBatchUnits + classifyBatchRun (done/progress/pure-wait).
- liminal/extract.ts: `ExtractConfig.batch?: BatchContext` selects the impl UNDER THE SAME CLOSURE (keystone 0 — batch-ness never in the key; sync-primed cache serves batch runs and vice versa, tested both directions). Interactive callers unchanged (no batch field → sync path).
- Tier-1 §12.1 matrix GREEN in <1s: liminal/batch-derivation_test.ts + testing/batch-pass-cli.ts (REAL subprocess kill/reinvoke; depth-3 chain in exactly 3 flush cycles, crash injection both windows via LIMINAL_BATCH_CRASH, marker loss, partial failure, no-AI gate, interactive isolation...).
- PILOT: `bind-references --batch` (deferred page outcome, flush after the page loop, exit 3 = in flight, rerun same command to land). §12b BAN-RUN acceptance gate PASSED: rebuildDerived clean under no-llm-calls post-refactor, binding numbers byte-identical → zero paid keys orphaned.

REMAINING before the first big paid batch run:
- Tier-2 real-API SOAK (design §12.2): a few days' wall clock, tiny spend, packs all scenarios into one soak. The feature-acceptance gate — run it once before production batch use.
- Retrofit the PDM stages (depth ~4 — where the depth×24h bound really pays) the same way; pdm passes go through the same extract.ts choke point.
- The big deferred jobs ([[deferred-llm-runs]]) should be run THROUGH this at half price once soaked — still need dz's explicit go + quote.
