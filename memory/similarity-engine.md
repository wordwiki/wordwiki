---
name: similarity-engine
description: DESIGN WRITTEN 2026-07-27 — three-pass similarity library (mechanical blocking / LLM cluster judgment / escalation) with per-purpose machineSync landings; doc wordwiki/similarity-design.md
metadata:
  type: project
---

dz's whole-dictionary similarity engine, doc of record
`wordwiki/similarity-design.md` (resolves machine-contributors '~xref'
sketch + rand-references §6 pairing).  Core:

- LIBRARY not monolith: one pair-scorer, SEPARATE landings per
  purpose ('~rand-mmo-pair' high-precision 1:1; '~xref' A-A top-k
  relaxed; '~clark-support'/'~pacifique-support' future).
- dz DECIDED (doc annotation 2026-07-27): '~xref' is BORN-APPROVED
  ("too much for editors to approve, at least for the first cuts");
  may revisit after language editors review on staging.
- Pass 0 mechanical blocking (per-orthography normalizers AS DATA,
  skeleton + english + category keys — kills O(n^2), free; alone
  lands the survey's 1,443 exact pairs).  Pass 1 = LLM judging ONE
  entry vs its candidates w/ evidence (extract.ts cached, per-cluster
  keys, Sonnet A/B).  Pass 2 escalation only on middling confidence.
- Confidence BUCKETS + named EVIDENCE on every fact; eval before
  landing (survey pairs + binder shared-line clusters = free ground
  truth).
- Support-material dictionaries = a dictionary CLASS (config flag:
  unpublishable, badged, never written to; links live on the
  consuming side).  Rand bindings' Textract-vs-Watson aligned pairs =
  the measured OCR confusion table for future Clark/Pacifique.
- Category propagation runs as '~categorizer' consuming LANDED pair
  facts — never inside the batch (feedback loop).

**How to apply:** build in doc §6 order (pass-0 library first); dz
has NOT yet said build.  See [[machine-contributors]],
[[rand-references-project]].
