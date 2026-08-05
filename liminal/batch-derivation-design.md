# Batch AI derivation via the derived content store — design

Status: DESIGN (dz + claude, 2026-08-05).  Not yet implemented; this doc is
the spec to build from.  Extends the derived content store
(liminal/content-store.ts, getDerived) + the LLM client (liminal/llm.ts,
AnthropicLlm, the no-llm-calls proof flag).  Consumers: the BULK pipeline AI
passes (Phase 3, rebuildDerived.sh — PDM segment/read/split/transliterate,
rand binding, etc.).  See [[rebuild-pipeline]] for the phase context.

## 1. Goal

Use the Anthropic Message Batches API for the bulk AI passes: 50% cheaper,
up to 100k requests / 256 MB per batch, completes within a 24h SLA,
POLL-based (submit -> poll status -> retrieve a JSONL keyed by custom_id;
per-request success/failure; no callback in the core model).

The 24h latency is the whole design problem.  A bulk run cannot block for
hours per request, so batching restructures the passes into a
submit-and-exit-then-resume shape and schedules the maximum work per run.

DECISION (dz): the INTERACTIVE editor AI (auto-transliterate, etc.) stays on
the SYNCHRONOUS (non-batched) API.  Only the bulk passes batch.

## 2. Core principle — batching is a MODE of the store, not a property of the closure

The same getDerived closures serve both paths; behaviour depends only on
whether a BATCH CONTEXT is active in the current execution:
- interactive (no context): synchronous call / cache hit, exactly as today.
- bulk pass (context active): the closure's AI call ENROLLS into the batch,
  defers, and throws-if-awaited (§4).

Consequences:
- ONE set of AI derivations, not an interactive vs batch fork.
- SHARED cache: interactive results prime the bulk cache and vice versa
  (same content-hash slots); the split is only how a MISS is satisfied
  (call now vs enroll), never where results live.
- The editor code is UNCHANGED; the throw discipline (§5) lives only in the
  bulk passes.
- The batch context MUST be explicitly scoped to the bulk pass (passed down
  / async-local), NEVER a module-global flag.  Today bulk runs offline in
  the CLI with the server stopped (Phase 3 refuses a live pidfile) and
  interactive runs in the server, so they are process-isolated and the
  scoping is free.  A global boolean would break if a future staff-triggered
  "re-derive this group" button ran inside the live server, sweeping a
  concurrent editor request into a 24h batch.  Scoped context keeps
  interactive synchronous even then.

## 3. Mechanism

### 3.1 Deferred enrollment (derive-fn shape unchanged)

Inside a derive closure the AI call goes through a BATCH-AWARE client.  When
a batch context is active AND it's a cache miss: enroll the request
(custom_id = the derivation's content hash), persist a pending marker,
return a DEFERRED promise, and do NOT call the API.  The batch flushes ONCE
at the barrier (end of the run/pass): submit all enrolled requests as one
batch, persist the batch id onto each participating key's pending marker.  A
poller resolves the deferred promises as results land.

So the derive fn stays `async (input) => output` — batching is hidden in the
client + context, NOT by splitting the fn into request-builder/result-parser.

### 3.2 custom_id = content hash (the keystone)

Deterministic: the same key across runs yields the same custom_id.  Results
are therefore IDEMPOTENTLY LANDABLE regardless of which batch produced them.
This makes crash recovery robust (§6): on resume, LIST recent batches, fetch
their results, and land any result whose custom_id matches a still-needed
key.  The persisted batch id is an OPTIMIZATION (skip the list/scan), NOT a
correctness requirement.

### 3.3 Store state per key — peer files (same hash, different suffix)

- absent (no file): not started.
- pending {batch_id?, custom_id}: enrolled/submitted, result not yet landed.
  (batch_id absent between enroll and flush.)
- done: the derived output file exists (a normal cache hit).

All three are ordinary content-store peer files — this is in the grain of
the existing mechanism, not a new storage layer.

### 3.4 no-AI-proof interaction

A batch SUBMIT is an AI call and must honour the no-llm-calls flag (throw
loudly under it).  A cache HIT does not.  So a fully-primed store rebuilds
under the flag with zero AI, exactly as the synchronous path does today.

## 4. Two dedup layers (one is a general win, do it regardless)

- IN-PROCESS promise memoization (Map<hash, Promise>): if a second call site
  requests the same key while the first is in flight, they share one promise
  instead of both executing.  GENERAL improvement for ALL derivations (today
  they double-execute — wasted compute for sync, wasted money for AI).  Do
  this whether or not batching lands.
- ON-DISK pending state (§3.3): batch-specific, for CROSS-RUN reconnect.

## 5. Scheduling — throw-on-unavailable (Suspense for 24h batches)

Awaiting an unavailable (pending) key throws a special NotAvailable
exception.  A top loop over independent UNITS OF WORK catches it and moves to
the next unit; each unit primes as much as it can until it throws.  At run
end the batch flushes (the whole run's frontier as one batch) and the process
exits.  Rerun later (when a batch lands): previously-pending results are now
available, so those units complete and their downstream deps enroll -> the
next batch.  Repeat until a run throws zero times (done).

This is React Suspense's "throw when not ready, catch, retry on resolve"
with a 24h resolve time and a persistent store instead of a component tree.

OBJECTIVE: max wall-clock = (dependency DEPTH) x 24h, NOT (request count) x
24h.  It pays off here because the PDM pipeline is DEEP: segment -> read
(needs segment) -> word-split (needs read) -> transliterate, ~4 AI levels ->
~4x24h for the WHOLE BOOK (all pages' segments in one batch, then all reads,
...), versus unusable if serialized.  The throw model discovers the levels
automatically across reruns; you don't hand-stage them.

Also expose a non-throwing `isAvailable(key)` query.  Enrollment happens on
EVERY miss regardless (that IS the scheduling); the throw/query only decides
proceed-vs-defer.  Shape: "always enroll on miss; then await (throws) or
`if available` use else defer" — never "check, and only enroll if available".

## 6. Constraints the throw model imposes (hold these or the depth bound decays toward count x 24h)

1. Batch scope is per-RUN across ALL units, never per-unit — that cross-unit
   breadth is what puts every page's current-frontier request in ONE batch.
2. Within a unit, ENROLL independent siblings BEFORE awaiting any.  `await X;
   await Y` with X pending unwinds before Y enrolls -> X and Y serialize ->
   depth collapses toward count.  Enroll broadly then await, or keep units
   single-request so the top loop provides the breadth.
3. COMMIT ONLY AT UNIT COMPLETION — no DB writes / side effects until every
   await has resolved.  Units re-execute each rerun; a partial commit before
   a throw double-fires.  The DB landing is the final barrier.
4. The path from top-loop to await must be PURE REPLAY — everything expensive
   between them is a cache-hit store derivation, or reruns redo real work.
5. FINE-GRAINED independent units (per page/entry) so the top loop fills each
   run's frontier.

## 7. Crash-resume windows (precise)

- Die BEFORE flush: nothing submitted, nothing paid.  Re-derive/re-enroll
  next run.  Safe.
- Die AFTER submit returns an id, BEFORE markers written: an orphan batch
  (paid, untracked) — but RECOVERABLE because custom_id = hash: list recent
  batches, land results by custom_id.  No double-spend, no lost work.
- PARTIAL batch failure: land the succeeded custom_ids; leave errored/expired
  as cache-misses (retry next run); never let one bad request block the
  batch's landing.
- Make LIST-AND-RECONNECT the standard resume path (robust to ANY marker
  loss, not just the flush-crash).

## 8. The driver / termination detector

Wrap the pass: run -> flush -> classify the outcome:
- made progress (completed units and/or enrolled new work) -> reschedule
  (rerun when the in-flight batch lands).
- pure wait (nothing new enrolled, nothing completed, all blocked on
  in-flight batches) -> don't spin; poll the batch ids, rerun on completion.
- done (zero throws) -> stop.

"Rerun later" is the SAME code as crash-resume: submit-and-exit-and-resume
is the PRIMARY mode, not a crash fallback.

## 9. Build breakdown / scope (honest)

- Store additions (SMALL): the pending peer-files (§3.3), the NotAvailable
  exception, the in-process promise memoization (§4 — general, do anyway).
  These are genuinely in-grain; "not a major addition to the store" holds.
- Batch-aware LLM client (REAL component, beside the store): deferred
  enrollment, submit/poll/retrieve, resume-and-reconnect (list + land by
  custom_id), partial-failure handling.
- The driver (§8): run -> flush -> classify -> poll/reschedule/stop.
- RETROFIT the bulk AI passes into the throw discipline (§6):
  throw-tolerant, enroll-before-await, commit-at-end, pure-until-frontier.
  This is the real APP-SIDE work and it changes how those passes are written
  — budget for it.  The interactive editor is untouched.

## 10. Non-goals / settled decisions

- Interactive AI stays SYNCHRONOUS (non-batched).  [dz]
- No time-window/timer batching — explicit per-run scope + single flush.
  Timers add nondeterminism + tiny-batch risk; the phase barrier is the
  natural flush point.
- Batch size is NOT penalized (50% discount at any size) — accumulate for the
  one-batch-per-run unit and to avoid per-tiny-batch 24h latency, not for the
  discount.
- Adopt the throw ergonomics over manual depth-staging — automatic
  level-discovery is what a depth-4 pipeline wants; hand-staging is more
  error-prone.

## 11. Three keystones to hold onto

1. custom_id = content hash (idempotent landing, robust crash recovery).
2. per-run batch scope with enroll-before-await (preserves the depth bound).
3. commit-at-end (keeps reruns safe).
Get these right and the rest is bookkeeping.

## 12. Testing plan

This is the first mechanism whose correctness spans MULTIPLE PROCESS
INVOCATIONS with PERSISTENT INTERMEDIATE STATE, and whose real run takes
(dependency depth) x ~24h — days.  The plan splits along that fault line:
almost all the hard LOGIC is deterministic and testable in seconds against a
FAKE backend; only the REAL-API integration + timing needs the multi-day
soak.  Both tiers run the SAME driver/pass code via a swappable backend
interface — the only difference is which backend and who controls the clock.

### 12.1 Tier 1 — fast, deterministic, FAKE batch backend (the primary net, CI)

The batch client is an INTERFACE; a FakeBatchBackend implements
create/retrieve/results/list with a CONTROLLED clock and programmable
per-request outcomes (succeed / error / expire, and "not done yet until I
say").  This turns "multiple runs over days" into "multiple invocations
against a fake we complete on command" — the whole hard path runs in
seconds.

FIDELITY: drive REAL SUBPROCESS invocations against a temp content-store dir
(the fake persists its own batch state to disk too), so "crash" is a genuine
process kill and "resume" is a genuine cold reconnect — not just cleared
in-process state.  This matches [[testing-approach]]'s fakes/in-memory
philosophy but adds the cross-invocation dimension our other tests lack.

Matrix (all fast):
- DEPTH-N chain: synthetic derivations A->B->C->D; assert completion in
  EXACTLY N flush cycles (proves the depth bound + automatic level
  discovery), and that all same-level requests share ONE batch (no
  cross-level serialization).
- FAN-OUT: M independent requests enroll into one batch in one run.
- ENROLL-BEFORE-AWAIT: assert the depth bound holds under the discipline and
  DEGRADES (toward count x cycles) without it - so the test pins the
  requirement, not just the happy path.
- CRASH injection at each window (before flush / after submit before marker /
  mid-poll / after some results landed): kill + reinvoke; assert (a) eventual
  completion, (b) NO double-submit (count backend.create calls), (c) NO lost
  work, (d) NO double-SPEND (the money-correctness property).
- MARKER LOSS: delete a pending marker; assert list-and-reconnect recovers
  (lands by custom_id), no resubmit.
- PARTIAL FAILURE: fake errors/expires some requests; assert succeeded land,
  failed stay cache-miss + retry next run, no crash.
- IDEMPOTENT LANDING: same custom_id result landed twice = no-op.
- NO-AI FLAG: after a priming run, a flagged invocation makes ZERO
  backend.create calls (assert on the fake); a flagged invocation with a
  MISS throws.
- INTERACTIVE ISOLATION: an interactive-mode call (no batch context)
  interleaved in the same process calls the backend SYNCHRONOUSLY and does
  NOT enroll - proving the scoped (not global) context.
- TERMINATION: a zero-throw run reports done; a pure-wait run reschedules
  without spinning.

This tier OWNS correctness of the scheduling / resume / dedup logic.

### 12.2 Tier 2 — the multi-day SOAK, REAL Batches API (acceptance gate)

Purpose: validate ONLY what the fake can't — real submit/poll/results
shapes, custom_id round-trip, real partial failures, real list-batches
reconnect, real timing.  NOT to re-test the logic.

Because a cycle is ~24h, PACK EVERY SCENARIO INTO ONE SOAK so total wall
time = max scenario depth x ~24h (a few days), NOT the sum — every
scenario's current-frontier requests ride the SAME batches.  Use trivial
deterministic prompts (the content is irrelevant; keep spend tiny and
results checkable).

Scenarios in the one soak:
- a DEPTH-3 chain (real cross-batch dependency scheduling over real days).
- a wide FAN-OUT (real large-batch submit/retrieve).
- a request built to ERROR (bad params) [+ an expire case if feasible] -
  real partial-failure landing.
- ONE real CRASH-RESUME: a chosen invocation exits after submit, before the
  marker (test hook, e.g. CRASH_AFTER=submit); a later invocation must
  reconnect via list-batches by custom_id - proves the REAL reconnect path.
- the NO-AI-FLAG proof at the end: once everything's landed, a flagged full
  run makes zero real API calls.

DRIVER: a scheduled re-invocation (systemd timer / cron, hourly or on
batch-completion) that runs the pass, flushes, appends a per-scenario line to
a soak report (state + timestamp + running spend), and exits - unattended
over the days.  A final assert-terminals invocation checks every scenario hit
its expected terminal AND that total real spend equals the minimum (the
no-double-spend property, end to end).

Run the soak (a) once before first production use, (b) after any change to
the batch client / driver / store batch paths.  It is the FEATURE ACCEPTANCE
GATE, not a per-commit test.

### 12.3 Deliverables (part of the §9 build)

The FakeBatchBackend, the subprocess test harness (temp store + kill/reinvoke
+ assertions), and the soak driver + report are themselves things to build
alongside the feature - budget them.  Tier 1 exercises the exact code Tier 2
soaks, so a green Tier 1 + a clean multi-day soak is the ship criterion.
