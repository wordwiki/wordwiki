---
name: machine-contributors
description: "DESIGN WRITTEN 2026-07-26 — ongoing AI/algo participation in dictionary data; machine-owned predicate on fact HISTORY, machineSync reconcile, feedback loop; doc wordwiki/machine-contributors-design.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

dz's model for AI/algorithmic content as an ONGOING participant
(categories catch-up/refile, li→sf transliteration, rand binder,
periodic all-to-all related-words batch).  Doc of record:
`wordwiki/machine-contributors-design.md`.  Core:

- MACHINE-OWNED = every version in a fact's history + every
  publication op is system-authored.  Any human version freezes;
  APPROVAL freezes; REJECTION = durable human tombstone (never
  reassert).  Same predicate as the transform's edits-block gate /
  preserve-foreign, at fact granularity.
- One system username per FEATURE ('~categorizer', '~translit-li-sf',
  '~xref', '~rand-binder'); algo/prompt version in change_arg.
- machineSync(author, computedFacts): diff-FIRST (unchanged re-run
  writes ZERO rows), supersede changed, retract no-longer-computed,
  skip human-owned (→ frozen-stale report) and human tombstones.
- Deterministic ids hash(author, entry, relation, semantic-key);
  key choice = freeze/change granularity (translit key includes
  SOURCE spelling content → source edits auto-recompute).
- Feedback loop (dz twirk): machineFeedback(author) query returns
  edited/rejected/retracted/added corrections with before/after +
  change_note; review UI INVITES (never requires) a reason on
  overriding machine facts; corrections feed prompts + serve as the
  regression eval.  Curated, not auto-folded (open q).
- Per-feature posture: born-approved vs PENDING (approval workflow
  = control surface).  PREREQ for pending posture: review batch
  grouping + bulk ops + feeds filter system authors.
- Build order: library first, then '~categorizer' as first instance;
  '~rand-binder' [[rand-references-project]] lands via machineSync.

**Why:** results can't be computed on the fly — must be dictionary
data; algorithms improve over time and re-runs must respect human
work [[minimal-ceremony-principle]].
**How to apply:** dz has NOT yet approved-to-build; doc awaits his
review.  See [[multi-dictionary-project]].
