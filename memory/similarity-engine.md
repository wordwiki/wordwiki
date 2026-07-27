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
- RESOLVED (doc §3b/§3c): PER-TARGET-DICTIONARY relations
  (rand_counterpart etc.) with $targetDictionary annotation + plural
  roles counterpart/related (NEVER name-parsed); link payload grows
  (machine qualifier commentary; human commentary = separate child
  fact).  NO approval flows on link facts - verbs are sever/pin/
  annotate; ALL landings born-approved WITH CONFIDENCE +
  low-confidence reports (dz's 6-month scenario: mass approvals
  would freeze evolution - the bigger loss).  IDF-weighted blocking
  (common keys can't form clusters); land generously/display top-k;
  bounded committed-feedback third pass.
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
- Pass-0 keys are a PERSISTENT incremental INDEX (dz): powers the
  future LIVE single-entry dup/near-match probe at entry-creation
  time (same normalizers + IDF, no LLM; subsumes the
  spelling-duplicates advisory eventually).

- PASS 0 BUILT 2026-07-27 (similarity.ts + similarity_test.ts + CLI
  similarity-rebuild/similarity-candidates): dev eval rand->dict =
  59,316 candidates / 15,082 entries (mean 3.9), 5,716 exact-skel
  pairs, 10s total, no LLM.
- PASS 1 BUILT 2026-07-27 (similarity-judge.ts; extractTextStage +
  optional llm image): per-cluster memoized judge, verdict/conf/
  reason/qualifier, failure isolation.  10-cluster eval: 5 same-word
  4 high, 6 related w/ qualifiers, 19 rejected; ~1.8k in/cluster ->
  full rand->dict est ~$250 on Opus; Sonnet A/B: 86% agreement, 0
  failures, disagreements all fuzzy-boundary (watson/
  rand-mmo-judge-model-ab.md).
- PASS 1a BUILT 2026-07-27 (dz's cost pivot: rule iteration must be
  FREE): similarity-rules.ts = the ALGORITHMIC judge, Mi'gmaq rules
  as reviewable code (VERB_FINALS, DIMINUTIVE, ROOT_LEXICON
  maw/gim/nesp - GROW ME, prefix families, def bands).  rand->dict:
  59,316 pairs in 10s $0 - 4.9% same-word, 27.8% related, 59.9%
  unrelated, 7.4% REFERRAL band (LLM only there, ~$30 Sonnet).
  vs 42 Opus refs: 36 agree/4 refer/2 boundary.  v3 candidates:
  gloss-vs-example token weighting; possible-synonym band tuning.
  NEXT: '~rand-mmo-pair' landing consumes rule verdicts (+LLM band
  when funded); CLI similarity-verdicts.
**How to apply:** build in doc §6 order.  See [[machine-contributors]],
[[rand-references-project]].
