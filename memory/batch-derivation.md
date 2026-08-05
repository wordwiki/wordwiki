---
name: batch-derivation
description: "DESIGN (not built): batch Anthropic AI calls through the derived content store; throw-on-unavailable (Suspense) scheduling; interactive stays synchronous; doc liminal/batch-derivation-design.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Planned enhancement (design DONE 2026-08-05, NOT implemented): route the BULK pipeline AI passes (Phase 3 / [[rebuild-pipeline]] — PDM segment/read/split/transliterate, rand binding) through the Anthropic Message Batches API (50% cheaper, ≤24h SLA, poll-based) via the derived content store. Spec: **liminal/batch-derivation-design.md** (read before implementing).

Core decisions:
- Batching is a MODE of the store (a per-pass batch CONTEXT), not a property of the closure — same getDerived closures serve both paths; shared cache; editor unchanged.
- INTERACTIVE editor AI (auto-transliterate) STAYS SYNCHRONOUS/non-batched (dz decision). Context must be scoped (async-local), never a global flag (free today since bulk = offline CLI, server stopped).
- custom_id = content HASH → results idempotently landable → robust crash recovery (list recent batches, land by custom_id; persisted batch id is an optimization, not correctness).
- Scheduling = throw-on-unavailable (React Suspense for 24h batches): awaiting a pending key throws NotAvailable, top loop catches, moves to next unit, flush whole run's frontier as one batch, exit, rerun-later (= same code as crash-resume). Objective: wall-clock = dependency DEPTH × 24h (not count × 24h); pays off because the PDM chain is ~4 AI levels deep. Plus an isAvailable() query.
- Constraints (or depth bound decays to count×24h): per-RUN batch scope across all units; enroll-before-await for independent siblings; commit-only-at-unit-completion; pure-replay path to the frontier; fine independent units.
- General win to do regardless: in-process promise memoization (today a 2nd request for an in-flight closure double-executes — wasted money for AI).
- Scope: store additions small (pending peer-files, NotAvailable exception, memoization); the batch-aware LLM client + driver + retrofitting the bulk passes to the throw discipline is the real work. Honours the no-llm-calls proof flag (a batch submit throws under it; a cache hit doesn't).
