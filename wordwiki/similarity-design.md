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
  vetted modern content).  Posture: BORN-APPROVED WITH
  CONFIDENCE (§3c) - low-confidence pairs are a report, not a
  review queue.
- **'~xref' (A<->A related entries)** - top-k related per entry,
  relaxed precision, its own relation.  SEEDED/EVALUATED for free by
  the binder's shared-line synonym sets (siblings bound to the same
  printed lines ARE Rand's related-word clusters).  Posture: pending
  (the approval workflow is the control surface) - but see the
  review-UX prerequisite in machine-contributors-design.md §4 before
  mass-landing.  DZ: it is too much for editors to approve this - at
  least for the first cuts - I would like this to be born approved,
  may change after language editors review on staging.
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

## 3b. The link relations (RESOLVED 2026-07-27, dz + discussion)

**Per-target-dictionary RELATIONS, not a generic link.**  dz's
instinct ('rand-counterpart', 'clark-counterpart'), made principled:
a link to rand and a link to Clark are foreign keys into DIFFERENT
tables - different relations is the orthodox relational move, not
the hack (the generic (target_dictionary, target_entry_id) pair was
the EAV-flavored alternative).  The system's grain agrees: display
and publish policy are RELATION-granular ($view order/audience/
display name, publish audience filters), so "rand counterparts are
public support material; Clark matches are internal-only, badged
'uncorrected OCR'" costs zero new machinery.  Rules that keep it
clean:
- The target dictionary is a SCHEMA ANNOTATION on the relation
  ($targetDictionary: 'rand') plus a shared $role - NEVER encoded in
  and parsed out of names/tags.  Generic code iterates relations by
  role and reads the annotation (the boundingGroup-$shape dispatch
  pattern).  Storage tags stay short and arbitrary; names readable
  (rand_counterpart).
- TWO roles: `counterpart` (the near-1:1 "essentially the same entry
  in another dictionary" claim) and `related` (the ranked many-link;
  A<->A is simply a related relation whose $targetDictionary is the
  dictionary itself; A<->B cross-dictionary related uses the same
  role).  relationsByRole grows a PLURAL form for these roles.
- Adding a dictionary means a schema edit on each consumer that
  wants links to it - accepted, and half a feature: deciding to link
  a new dictionary IS a policy moment (display? publish? audience?),
  and the schema edit is where those decisions live, gated by
  checkProposedSchema.

**The link payload will grow - leave room.**  Beyond
target_entry_id + confidence + evidence + rank, the judge can emit a
QUALIFIER commentary ('plural form', 'diminutive', ...) - machine
data on the link fact.  HUMAN commentary is a separate child fact
(human-owned) beside the machine link, so annotating never entangles
ownership (see §3c).  The shape will be discovered by use; the soft
schema makes field additions cheap.

## 3c. Ownership + verbs: DON'T create approval flows for links (dz)

dz's scenario, recorded because it is the design's center of
gravity: end users will engage lightly, gradually "approving" link
facts if offered the verb - and six months in, when the big prompt
improvement arrives ("things would be a lot better if only XXX"),
the accumulated approvals would FREEZE thousands of facts against
the re-run.  A small early gain, a large permanent loss: "freezing
evolution will be the bigger loss."

The reframe that fits machine-contributors: the "approval freezes"
decision stays true WHERE APPROVAL EXISTS - for these high-volume
link features we simply do not create an approval flow.  Everything
lands BORN-APPROVED WITH CONFIDENCE (dz: not the same as generic
born-approved - the confidence rides the fact, and low-confidence
REPORTS give reviewers a bounded worklist without gating the data).
The human verbs on a link fact are:
- **sever** - "this link is wrong": a durable human tombstone;
  never reasserted by any re-run (the existing rule).
- **pin** - "keep this": an explicit, deliberate freeze.  Rare by
  construction; a re-run that disagrees with a pin lists it in the
  frozen-stale report - a tiny human worklist, not a blocked run.
- **annotate** - a human commentary CHILD fact; the link itself
  stays machine-owned, so re-runs remain free (a retracted link
  orphans the annotation into the skeleton/report path, visibly).
Under this scheme the six-month improvement re-runs the corpus
freely: severs stick, the few pins report where stale, and nothing
else resists.  (machine-contributors-design.md §2.5 gains this as a
per-feature FREEZE-POLICY knob; the content-editing features keep
approval-freezes as decided.)

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

## Resolved questions (2026-07-27)

- **The relations' home**: in each dictionary's schema, PER TARGET
  DICTIONARY, roles `counterpart` + `related` with $targetDictionary
  annotations - §3b.  (dz: 'pairedEntry' too generic; related may be
  A<->B cross-dictionary - see related rand words for an MMO word;
  counterpart expresses "close to being the same entry in two
  dictionaries".)
- **Posture**: born-approved WITH CONFIDENCE across the link
  features; no approval flows on link facts - the verbs are sever /
  pin / annotate (§3c).
- **A<->A k** (dz): experiment - but the fixed limit is secondary to
  CONCEPT COMMONNESS: 'bear bite' usefully relates on bear and bite
  (uncommon concepts); 'time' words would overwhelm (and broad
  topical grouping is the category mechanism's job anyway).
  Mechanically this is pass-0 INVERSE-FREQUENCY weighting: a shared
  key's evidence value is proportional to its rarity; keys above a
  commonness threshold cannot FORM candidate clusters (they may only
  corroborate).  The 'time' cluster never forms, and k becomes
  largely self-regulating.  LAND generously (rank/score on the
  facts), DISPLAY selectively (a UI cap) - display tuning must never
  require re-running a batch.
- **The third pass** (dz): after a full pairing, a JUDGE sweep over
  the landed results produces a FEEDBACK DOCUMENT fed into
  re-pairing.  Constraints: the feedback document is COMMITTED,
  HUMAN-READABLE DATA (stop-list additions, weight adjustments,
  worked examples), reviewed before it feeds back - never an opaque
  model-to-model channel (the curated-not-auto-folded rule); and
  bounded to one-two iterations per corpus change (self-feeding
  critics converge on their own taste).  It rides the substrate:
  the feedback doc sits in the pass-0 config and pass-1 prompt, both
  in cache keys, so re-pairing recomputes exactly what it touched.
