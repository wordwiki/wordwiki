# Machine contributors — design

2026-07-26.  Goal (dz): formalize AI/algorithmic participation in the
dictionary DATASET as an ONGOING activity, not an import-time event.
Motivating features: the category tree (today: one-shot upgrade — new
words never get categories, taxonomy changes never refile),
auto-transliteration (li -> sf), the Rand scan binder
(rand-references-design.md — better if it compares OCR'd English
defs against Watson's, i.e. an Opus call), cross-dictionary entry
binding, and a periodic-batch "related words" all-to-all cross
reference.  None of these are computable on the fly — the results
must live IN the dictionary data, versioned like everything else.

The design principle: machine output participates through the SAME
assertion/approval machinery as human work, under one crisp ownership
rule, so that (a) batches can be re-run as algorithms improve —
"don't get everything perfect up front", (b) human judgment, once
expressed, is never silently overridden, and (c) the existing
approval workflow becomes the control surface for high-uncertainty
machine output.

## 1. What exists (this mostly assembles built pieces)

- Every assertion carries `change_by_username`; system authors are
  established practice ('~sfm-import', '~dict-transform', the planned
  '~rand-binder'), and the user table already marks system users.
- Assertion HISTORIES: supersessions chain via
  `replaces_assertion_id`; retractions are tombstones (closed
  valid_to) — deletion is durable, queryable data.
- The publication/approval model: facts land pending, a reviewer
  approves or rejects; sitting receipts, the global change feed.
- The ownership predicate at COARSE grain, twice: the transform's
  edits-block-rerun gate (table granularity) and preserve-foreign
  (rand-references-design.md §4).  This doc is the same predicate at
  FACT granularity.
- Deterministic derived ids (dictionary-transform.ts `derivedId`).
- The derived content-addressable store (`getDerived()`,
  content-store.ts) + the Layer-1 extraction primitive (extract.ts):
  all LLM/image compute persistently memoized — re-runs pay only for
  changed inputs.

## 2. The model

### 2.1 Machine-owned: a predicate on a fact's HISTORY

    A fact is MACHINE-OWNED iff every version in its history, and
    every publication op on it, is authored by a system user.

Consequences, stated as the rules dz proposed plus two decisions:

- **Untouched machine facts are the machine's**: any sync run may
  supersede or retract them freely (batch replace as algorithms
  improve; retract-then-repropose granularities are fine).
- **Any human version FREEZES the fact**: edited content, an edited
  field, a human reorder (order_key is a version too) — the machine
  never touches it again.
- **DECISION — approval freezes.**  A human approving a pending
  machine fact is recorded human judgment; later algo improvements
  must NOT silently replace it.  Improving a vetted fact means
  proposing a SUPERSEDING pending version that goes through review
  again.  Corollary to accept: high-approval-rate features gradually
  freeze themselves — the reward for traction is less automation,
  which is correct.
- **DECISION — rejection is human ownership.**  A reviewer's reject
  must leave a durable human-authored tombstone the sync can see
  forever ("do not re-propose").  REQUIREMENT to verify/fix: if
  rejection is currently a hard delete anywhere in the approval
  path, that's a small but load-bearing change.

### 2.2 One system username per FEATURE

'~categorizer', '~translit-li-sf', '~xref', '~rand-binder', ... —
the author IS the sync's ownership scope ("retract everything ~xref
no longer computes").  The algo/prompt version rides in `change_arg`
(queryable without multiplying users).  System users are marked in
the user table; per-feature POLICY decides their approval posture
(§2.5), not a global bypass.

### 2.3 machineSync — the one reconcile primitive

Every feature reduces to: compute the set of facts the feature
CURRENTLY asserts, then

    machineSync(author, computedFacts):
      for each computed fact (by deterministic id, §2.4):
        - id exists, machine-owned, content identical  -> NOTHING
          (diff-first is load-bearing: an unchanged algo re-run must
          write ZERO assertions - no history churn, no feed noise)
        - id exists, machine-owned, content differs    -> supersede
        - id exists, HUMAN-owned                       -> skip; if
          the computed content differs from the frozen value, record
          in the FROZEN-STALE report
        - id tombstoned by a human (retract or reject) -> skip
          (never reassert a human retraction)
        - id absent                                    -> assert
          (per the feature's posture: born-approved or pending)
      for each existing machine-owned fact by `author` NOT in
      computedFacts                                    -> retract
      returns the run report: asserted/superseded/retracted/
        unchanged counts + the frozen-stale and skipped-tombstone
        worklists

The FROZEN-STALE report is the escape valve for rule changes: a
human-edited category pointing at a deleted taxonomy bucket can't be
refiled by the machine — but every run lists it, so the human tail
of a taxonomy change is a visible worklist, not silent rot.

### 2.4 Deterministic content-keyed fact ids

Machine facts mint ids as

    id = derivedHash(author, entry_id, relation-tag, semantic-key)

where the semantic key is the fact's IDENTITY for sync purposes
(xref: the target entry id; category: none — one per entry... or the
category value if multi-valued; transliteration: the SOURCE
spelling's content).  This is what makes §2.3 work: recognizing
"this proposal = the fact a user deleted last year" is an id lookup
against tombstones, and idempotence falls out.  Choosing the key
sets the granularity of human freezing AND of change detection —
putting the source spelling's content in the transliteration key
means a human edit to the li spelling makes the old sf output
"no longer computed" (retract) and the new one a fresh assert, with
no special-cased source tracking.

(Id-space note: hash-derived ids alongside counter ids, as the
transform already does with derivedId — same collision posture.)

### 2.5 Per-feature policy knobs

- **Posture**: born-approved (high confidence: categories were
  one-shot approved already; the rand binder per its design doc) vs
  PENDING (high uncertainty: transliteration, related-words) — the
  approval workflow as control surface.
- **Publish-through**: whether approved machine facts flow to the
  public site immediately (categories did) or wait on something.
- **Proposal shape**: mass-batch pendings ONLY where the review UX
  can absorb them (§4); otherwise trickle — propose on the word view
  where a human is already looking, retract-unapproved-and-redo as
  the algo improves (dz's word-at-a-time pattern).
- **Freeze policy** (added 2026-07-27, similarity-design.md §3c):
  WHAT human actions freeze is itself per-feature.  Content-editing
  features keep approval-freezes as decided above.  High-volume LINK
  features (counterpart/related) land born-approved WITH CONFIDENCE
  and offer NO approval verb at all — the verbs are sever (durable),
  pin (explicit freeze, rare), annotate (a separate human-owned
  child fact) — so corpus-wide algorithm improvements re-run freely
  years in (dz: "freezing evolution will be the bigger loss").

## 3. The feedback loop (dz: user edits should FEED the next run)

Human touches on machine facts are exactly the correction corpus the
next run wants — few-shot examples, eval sets, rule mining.  The
histories already contain everything; what's needed is a CONVENIENT
query surface, per feature:

    machineFeedback(author) -> [{
        kind: 'edited' | 'rejected' | 'retracted' | 'added',
        entry context (headword, the entry's relevant facts),
        before,            // the machine's version (edited/rejected)
        after,             // the human's version (edited; absent on reject)
        change_note,       // the human's stated REASON, when given
        who, when
    }]

- 'edited': human version superseding a machine version (walk
  `replaces_assertion_id`).
- 'rejected'/'retracted': human tombstones of machine facts.
- 'added': human-authored facts in a machine-managed relation the
  machine did NOT propose (users showing the algorithm what it
  missed — e.g. hand-added cross references).

Reasons: `change_note` already exists on every assertion.  The
review/edit UI should INVITE (never require — minimal ceremony) a
one-line reason specifically when a human overrides or rejects a
machine fact: "so the machine learns" is a motivator users
understand.  A reason-bearing correction is worth ten bare ones to
a prompt.

Consumption pattern: a batch run pulls machineFeedback(author),
folds selected corrections into the prompt (or the algorithm's rule
table) — and because prompt text is in the getDerived cache key,
feedback-driven prompt changes re-extract exactly what they affect.
The feedback set ALSO serves as the regression eval: a new
promptVersion should reproduce the human's `after` on past
corrections before it ships (the PDM eval pattern, fed for free).

## 4. Review UX requirements (PREREQUISITE for pending-mode features)

Mass-pending machine proposals through the existing review flow will
drown it (tens of thousands of facts from one xref run vs a
human-scale queue).  Before any feature ships in pending posture:

- Review grouping by (system author, batch/run) with BULK
  approve/reject at the group and per-page level.
- The change feeds and activity reports filter system authors by
  default (a toggle to see them).
- Sitting receipts must not count machine floods as sitting work.

Born-approved features (categories catch-up, rand binder) don't wait
on this — their control surface is the frozen/feedback loop plus
their own run reports.

## 5. The features, as instances

- **Categories catch-up + refile** ('~categorizer', born-approved):
  compute per-entry categories under the CURRENT taxonomy; sync.
  New words get filed; a taxonomy change refiles every
  machine-owned category and reports the frozen-stale human tail.
  First instance to build — smallest compute, exercises the whole
  model including frozen-stale.
- **Transliteration li -> sf** ('~translit-li-sf', pending posture —
  dz: "I'll get it as good as I can, researchers will improve it"):
  semantic key = source spelling content; algo improvements
  batch-replace unapproved output; approvals freeze; corrections
  feed the rule table via machineFeedback.
- **Rand binder** ('~rand-binder', born-approved): as designed in
  rand-references-design.md; comparing the OCR'd English definitions
  against Watson's entry content is simply MORE INPUT in the
  extraction stage's cache key (the candidate-entry json already
  carries glosses — the design anticipated this).  preserve-foreign
  is this doc's ownership rule enforced by the transform.
- **Related words / all-to-all xref** ('~xref' - the design resolved
  into wordwiki/similarity-design.md, 2026-07-27; the sketch below
  stands as first written) (pending posture,
  periodic batch): MULTI-PASS with delta-shaped cache keys —
  algorithmic candidate generation (embeddings/string keys; O(n²)
  Opus is out), then one Opus judgment per word over its candidate
  set, keyed on (word content + candidate contents + promptVersion).
  The 6-month re-run pays only for new/changed words and words whose
  candidate sets shifted; sync respects hand-added xrefs ('added'
  feedback) and never reasserts rejected ones.  Symmetry decision
  for the feature (assert both directions? one canonical?) — not a
  model concern.
- **Cross-dictionary binding** (rand <-> MMO, later): same shape as
  xref with pairs drawn from the mark-insensitive match keys
  (rand-orthography-survey.md); whole-entry comparison is again just
  richer stage input.

## 6. Order of work

1. ~~The predicate + machineSync + deterministic ids as a library~~
   BUILT 2026-07-27: wordwiki/machine-sync.ts, first consumer
   '~rand-mmo-pair' (mikmaq/pairing.ts) - 2,679 pairs landed both
   sides on dev, re-run = zero writes.  Tests cover the full case
   table incl. freeze/frozen-stale/human-tombstone.
2. machineFeedback query + the review-UI "reason" invitation.
3. First instance: categories catch-up ('~categorizer') — proves the
   model end to end on the existing AI content.
4. Review batch-grouping + feed filtering (unblocks pending-posture
   features).
5. Transliteration and the rand binder adopt the library ('~rand-
   binder' lands via machineSync instead of bespoke code; preserve-
   foreign unchanged).
6. The xref batch (candidate pass, judgment stage, symmetry
   decision) — the 1-hour-batch flagship.

## Open questions (dz)

- Approval-freezes and rejection-freezes are stated as decisions —
  confirm.  Yes.
- Categories: is the semantic key "the category value" (multiple
  machine categories per entry, each independently frozen/synced)?
  Assumed yes.
- Should machineFeedback corrections ever be AUTO-folded into
  prompts, or always curated by a human before the next run?
  (Design assumes curated: a hostile/wrong edit shouldn't silently
  steer the machine.)
  - an additional reason this needs to be explicit: some prompts
    become part of the key for AI call memoization (by altering
    the prompt) - which we need to be explicit and careful about
    for cost reasons.
