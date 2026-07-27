# The similarity engine — design

2026-07-27.  dz's proposal: a whole-dictionary (possibly multi-pass)
similarity process - lexeme comparison under orthography filters,
fuzzy language-specific matching, definition comparison - serving
several consumers: rand<->MMO pairing (each the other's support
material), future OCR'd Clark/Pacifique as SUPPORT-ONLY dictionaries,
A<->A related-entries for every entry, and the category machinery.
Confidence-rated; dz suspected a permissive whole-dictionary first
pass then per-cluster attention would suit LLM performance.

Converged shape (discussion 2026-07-27): ONE pair-scoring LIBRARY,
three passes with the LLM only ever judging SMALL evidence-rich
contexts, and SEPARATE landings per purpose - each a
machine-contributors feature (machine-contributors-design.md) with
its own author, posture, and thresholds.  This doc is the doc of
record; the earlier '~xref' sketch in machine-contributors-design.md
§5 and the pairing conduit of rand-references-design.md §6 both
resolve here.

## 1. Principles

- **A library, not a monolith.**  The purposes want different shapes:
  rand<->MMO pairing = high-precision, roughly-1:1; A<->A related =
  top-k per entry at relaxed precision; support-material links =
  "possible match" tolerated, badged as such.  One scoring engine,
  per-purpose thresholds and landings - never one merged output.
- **Small contexts beat sweeps** (the binder's lesson: 99.8% came
  from one page + its candidates + expected strings).  The LLM never
  sees "the whole dictionary"; it judges ONE entry against its
  handful of candidates with the mechanical evidence attached.
- **Evidence over scores.**  Every emitted link carries a confidence
  BUCKET (high/medium/low, calibrated) and a named EVIDENCE tag
  (exact-skeleton / near-skeleton / definition-overlap / llm-judged /
  ...).  Evidence makes worklists reviewable and permits re-scoring
  without re-compute.
- **Results are machineSync instances.**  Per-feature system authors
  ('~rand-mmo-pair', '~xref', '~clark-support', ...), deterministic
  content-keyed fact ids, diff-first re-runs, human confirm/sever
  FREEZES, rejections never reassert.  Nothing here invents new
  landing machinery.
- **Orthography knowledge is DATA.**  Per-orthography normalizers
  (MMO's apostrophe-family strip, Watson's backtick decode, OCR
  confusion tables) live as configuration the passes read - the SAAS
  data-only customization rule, and the orthography table rows
  (watson-li/watson-sf/rand) are already in place.

## 2. The three passes

**Pass 0 - BLOCKING (mechanical, free, deterministic).**  Per entry,
compute normalized keys under the orthography filters:
- spelling SKELETONS per lane (the orthography survey's
  normalization, generalized per-orthography as data);
- English keys: stemmed/normalized definition + gloss tokens
  (rand's \xe english, MMO's glosses);
- category values; cited source pages; (optional, if ever needed:
  definition embeddings - not in scope until token blocking proves
  insufficient).
Join entries into CANDIDATE SETS by shared keys.  This is where
O(n^2) dies: 31,723 x 8,612 becomes "each entry's handful".  Every
candidate pair carries its mechanical evidence + a mechanical score.
Pass 0 alone already lands the survey's 1,443 exact-skeleton pairs
at 'high' with no LLM at all.

**Pass 1 - CLUSTER JUDGMENT (LLM, small contexts, cached).**  One
call per entry-with-candidates: the entry's full presentation
(headwords all lanes, source spellings, definitions, categories,
cited pages) + each candidate's presentation + the mechanical
evidence; output per candidate: same-word / related / unrelated +
confidence + a one-line reason.  Cache key = the cluster's content
(the extract.ts/getDerived substrate, like the binder) - the
six-months-later re-run pays only for changed clusters.  Model: this
task shape likely does NOT need Opus - A/B Sonnet on the eval set
first (--model is a knob).

**Pass 2 - ESCALATION (LLM, only on ambiguity).**  Clusters whose
pass-1 confidence lands in the middle get a deeper look: more
content, and - where bindings exist - the scan crops themselves.
Gated by confidence so it stays a small fraction.  (dz's "more
attention to the clusters", bounded.)

Cost model: pass 0 free; pass 1 ~10-20k calls x 1-2k tokens -
binder-run order of magnitude or less; pass 2 a fraction.  Cheap
enough to re-run after every meaningful corpus change, which is the
machine-contributors loop working as intended.

## 3. The landings (per purpose, separate features)

- **'~rand-mmo-pair'** - the PAIRING (rand-references-design.md §6):
  high-precision same-word links, roughly 1:1 (multi-links are a
  worklist, not an output).  Landed as role-marked pairing facts ON
  EACH SIDE (each entry renders its pair without joins; symmetry is
  the batch's job, not the schema's).  This is the conduit: MMO's
  word view shows its rand pair as SUPPORT MATERIAL (and through it
  the Rand page scans); rand's shows its MMO pair (recordings,
  vetted modern content).  Posture: born-approved at 'high' with
  evidence exact-skeleton (they are the survey's anchor pairs);
  PENDING otherwise.
- **'~xref' (A<->A related entries)** - top-k related per entry,
  relaxed precision, its own relation.  SEEDED/EVALUATED for free by
  the binder's shared-line synonym sets (siblings bound to the same
  printed lines ARE Rand's related-word clusters).  Posture: pending
  (the approval workflow is the control surface) - but see the
  review-UX prerequisite in machine-contributors-design.md §4 before
  mass-landing.
- **'~clark-support' / '~pacifique-support'** (future) - links from
  REAL dictionaries' entries to support-dictionary entries.
  ASYMMETRY IS EXPLICIT: the consuming side owns the link; support
  dictionaries are never written to.
- **Category propagation** - a matched MMO entry's categories
  suggest rand categories.  Runs as the '~categorizer' feature
  CONSUMING landed pair facts - NEVER inside the similarity batch
  (category-evidence boosting matches boosting categories is a
  feedback loop; separate batches over each other's landed,
  freeze-respecting outputs).

## 4. Support-material dictionaries (a dictionary CLASS)

"Unvetted OCR, never publishable, exists to support editors" is a
dictionary-level property: a config flag on the pair (with
name/slug), refused by publish, badged in the UI ("support material -
uncorrected OCR").  Clark/Pacifique become ordinary residents of the
multi-dictionary substrate with zero special-casing; the similarity
engine is indifferent to the flag.  Their OCR error model is not
guesswork: once the full Rand bindings land, the aligned
Textract-vs-Watson pairs yield a MEASURED confusion table for this
era of diacritic-heavy type - pass 0's fuzzy matcher for OCR'd
sources reads it as data.  (The OCR import path for Clark/Pacifique
is its own project - the PDM whole-dictionary transliteration
vision - and NOT in this doc's scope; the engine is merely ready for
those dictionaries when they exist.)

## 5. Calibration + eval (before anything lands)

- Ground truth exists: the orthography survey's 1,443 exact + 577
  near rand<->MMO pairs; the binder's shared-line clusters for A<->A.
- The binder discipline: an eval set (~10 clusters, hand-checked),
  measured precision per confidence bucket, BEFORE each full batch
  and after every prompt-version bump.
- Confidence buckets must MEAN something: 'high' = land-clean rate
  measured >= target on the eval set; otherwise the bucket demotes.

## 6. Order of work

1. The pass-0 library: per-orthography normalizers as data, key
   extraction, blocking, mechanical evidence/scores.  Eval against
   the survey pairs (should reproduce 1,443 exact + rank the 577
   near high).
2. The pass-1 judgment stage on the extract substrate + the
   10-cluster eval; Sonnet-vs-Opus A/B while at it.
3. '~rand-mmo-pair' landing via machineSync (the pairing relation +
   role, both word views' support panels) - the first consumer, the
   Watson-packet strengthener.
4. '~xref' A<->A on the same substrate (after the review-UX batch
   affordances of machine-contributors §4, or trickled).
5. Pass-2 escalation when the eval shows the middle bucket earns it.
6. Support-dictionary class flag + Clark/Pacifique consumers when
   their OCR exists.

## Open questions (dz)

- The pairing relation's home: a new role ('pairedEntry'?) on a
  relation in each dictionary's schema, or a separate cross-dict
  table?  Design leans ROLE-MARKED RELATION (assertion-native,
  review/freeze machinery free, survives publish bundling); pushback
  welcome.
- Does 'high'-evidence pairing land born-approved (the design's
  lean, anchor pairs are survey-verified) or should even those queue
  for review initially?
- A<->A k (how many related entries per word is useful in the UI)?
