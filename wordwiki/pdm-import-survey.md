# PDM import survey — the assets, the gold, and the shape of the problem

dz 2026-07-28: the next big piece is the Clark-style import of the PDM
(Pacifique) manuscript dictionary — handwritten, French/Mi'gmaq, ragged
entries with insertions and arrows, elided stems, inline paradigm tables
— PLUS page-structure resolution (segmentation), which Clark got nearly
free from print geometry.  This is the survey of what exists, measured
against that goal.  Phase-1 transcription work is documented in
pdm-transcription.md (repo root); this doc extends it toward the full
import.

## Why (dz): the highest-value import of all

The primary editors' current funded priority is transcribing PDM
page-at-a-time — the only workflow their bookkeeping supports — and it
burns enormous time.  An import that works even *somewhat* well converts
the workflow from "transcribe everything on the page from scratch" to
"review a draft", and could unlock priority-word cherry-picking (needs a
readable draft of EVERYTHING to pick from — see pdm-transcription.md's
vision section).  Accuracy will be materially worse than Clark; the
value is still the largest.

## Asset inventory (dev db, 2026-07-28)

- **Scans**: 828 pages (document_id 1), ~3442x5362 px.  NO printed-page
  mapping yet (unlike Clark) - stage 0 work, and the anchor for the
  editors' page-at-a-time bookkeeping.
- **Textract**: loaded ('Text' layer, 145,676 WORD boxes, ~176/page).
  On the handwriting the TEXT is garbled ("colariy" for eolasig) with
  occasional legible French anchors (miserablement, aller); the word
  GEOMETRY is real.  Weaker than Clark's but usable for clustering,
  band/crop framing and weak anchoring - never as text.
- **Hand SEGMENTATION gold**: 'Tagging' layer - **2,277 hand-drawn entry
  groups (10,043 boxes) across 73 pages**; 43 pages carry >=10 groups
  (fully-worked look), spread through the whole book (pages 4..823 -
  good alphabet/style coverage).  Densest: p101 (91 groups), p209 (86),
  p67 (84).  This is the training/holdout gold for the NEW problem
  (page-structure resolution).
- **Hand ENTRY gold** (dict document_references into PDM): **1,596 refs**,
  with five graded rungs:
  | field | meaning | count |
  |---|---|---|
  | rtr | transcription, letter-by-letter, French kept | 1,555 |
  | rex | expanded (abbrevs + elided stems restored) | 675 |
  | rtl | transliteration (Listuguj + English) | 1,536 |
  | rse | source-as-entry (normalized entry phrasing) | 980 |
  | rne | normalized source-as-entry (modern form) | 987 |
  Example (ref 2479001625590): rtr "eoltjeoetji, pauvre petit, chétif."
  -> rtl "ewuljewe'ji, poor little frail one" -> rne "ewuljewe'jit,
  he/she is a poor frail/sick one".  The rse/rne rungs are STRUCTURING
  gold phase 1 never used - they are the Clark layer-2 analog, judged by
  a human language specialist.
- **The measured phase-1 baseline** (pdm-transcription.md, 25-ref eval):
  transcribe 79.8 strict / 81.6 lenient / 77 judged-equivalence; expand
  77.8; transliterate 60.3 (the weak link); confidence usefully
  CALIBRATED (worst results self-report lowest).  Judge census: of 49
  differences only 15 were real LLM errors (16 punctuation, 9 valid
  alternatives, 5 RESEARCHER errors) - the gold is imperfect and eval
  design must never assume the researcher row is truth.
- **Machinery already built**: masked group crops (solves the
  interleaved/arrow-relocated entry problem - measured 35%→94% on the
  worst ref), the 3-stage recipe with language-tagged runs + ambiguity +
  confidence, the JUDGE stage, the mailable review page, cost
  accounting, and - from the Clark arc - dual-model gating, band
  parallelism + retry, the import-mirror landing pattern, per-dictionary
  UI (picker/search/meta editor/workflow), and the no-llm-calls proof
  mode.  Lanes mm-pm/mm-mp are registered orthographies with fold
  normalizers; ~1,536 rtr↔rtl gold pairs are the corpus for
  Pacifique→Listuguj correspondence mining (the transliterate-pair rules
  program is the method template).

## What page 101 teaches (looked at with the gold overlaid)

- Word FAMILIES with elided stems ("eoltjtelegei, telgei, telemg" - the
  repeated stem written once), Pacifique's abbreviation habit
  everywhere.
- An inline PARADIGM TABLE (a two-column run of inflected forms - telsi,
  teltigo, telemsi... - hanging right of the main entries).  dz: treat
  these as entries anyway.
- Strikethrough entries with "v. plus haut" (see-above) - deletions that
  are still meaningful cross-refs.
- Insertions/arrows relocating text; marginal English glosses ("make him
  poor?", "do poorly"); citations "(41,1)", "(P. Met.)", "(A. M. 200)";
  a pasted green slip overlapping the page top (non-dictionary matter to
  classify away).
- Hand groups interleave heavily on the page - box-set (not rectangle)
  segmentation is the right output shape, exactly what the Tagging gold
  records and the masked-crop reader consumes.

## The problem, factored (proposed - for discussion)

0. **Page atlas**: printed-page mapping + page classification
   (dictionary page / slip / front matter / continuation), the
   bookkeeping backbone for page-at-a-time review.
1. **SEGMENTATION (the new core)**: page -> entry box-sets.  Hybrid:
   textract word geometry (clustering, line detection) + a vision-LLM
   stage proposing entry groupings, output as assignments of word boxes
   to entries (never free coordinates - the Clark lesson).  EVAL: the
   2,277-group gold on 73 pages, train/holdout split; metrics = group
   F1 + box-assignment agreement; dual-model divergence as the review
   flag, like Clark's.
2. **Per-entry reading**: the existing masked-crop recipe (transcribe /
   expand / transliterate+translate) extended with the rse/rne
   structuring rungs - five stages, each with real gold and the judge.
   Transliterate gets the corpus-mined Pacifique→Listuguj rules pass
   (1,536 pairs; the wsf-wli method).
3. **Landing**: a `pdm` reference dictionary in the Clark mold -
   import-mirror, content-keyed ids, documentReference born from the
   segmentation with the transcription riding it (rtr convention),
   workflow relations for review notes, counterpart joins to MMO via
   the existing similarity machinery (mm-pm lane).  Human tags/logs
   survive re-imports (the Clark exemption).
4. **Review flow**: the page editor already shows layers/groups - the
   proposed segmentation lands on its own layer for accept/fix
   page-at-a-time (the staff's existing workflow, pre-filled); entry
   drafts land as clearly-marked machine rows (approval-exempt import
   rows, pending only where humans touch).  Confidence + dual-model
   divergence drive the review ordering - and are what could later
   justify priority-WORD review instead of page-at-a-time.

## Honest expectations

- Clark's fold-agreement gate does not exist here: textract text cannot
  check the reading.  Its replacements: the dual-model divergence gate,
  the calibrated confidence, the judge - all measured tools already.
- Transcribe ~80% / transliterate ~60% (pre-tuning) means drafts, not
  facts - the landing must present them as drafts (it does, by
  construction).
- Segmentation accuracy is unknown - it is THE open empirical question,
  and the 73 gold pages make it measurable before committing.
- Scale: ~700 dictionary pages x O(20-30) entries ≈ 15-25k entries;
  recipe ≈ 5k tok/entry -> order 100M+ tokens for a full pass before
  segmentation/judging.  Levers (all built or proven): cheaper-model
  grading via the eval, batch API, confidence-gated escalation,
  cache-everything.  Pilots quote real numbers before any big run.

## Segmentation pilot results (2026-07-28, pdm/segment-pilot.md)

The 10-page pilot ran with a tunable mechanical layer (textract words ->
numbered runs; the model assigns run numbers to entries) and a CEILING
instrument (best possible score given the runs - pure geometry, zero
LLM), which decomposes the error into clustering-vs-model:

| clustering | ceiling | sonnet F1 | opus F1 | note |
|---|---|---|---|---|
| coarse (v1) | 74.2 | 56.6 | 54.3 | model near its ceiling gap |
| finest | 98.4 | 40.0 | 57.3 | 150-230 units SINK the model |
| middle | ~90 | ~55* | 62.2 | best; *sonnet collapses on word-unit pages |

Findings: (1) the mechanical ceiling is a solved knob (74->98 available;
sweep tool `pdm-segment-sweep` re-tunes free); (2) the BINDING constraint
is the model's visual assignment capacity - scores DEGRADE as units grow
past ~100/page, with response-shape breakdowns (3/10 pages) at the
extreme; (3) textract word RECALL is its own limit on faint pages (p4:
10 words for 16 entries) - word-unit mode covers it mechanically but
sonnet can't hold word-level assignment (opus partly can); (4) cross-model
divergence is tiny on normal pages (1-2%) - both make the SAME systematic
attachment errors, so the Clark-style dual-model gate is weak here.

Best observed: ~62-71 pair-F1 / 20-50% clean group recovery on normal
pages - NOT yet review-draft grade.  The evidence points at TASK
REFORMULATION, not more knob-turning: ask the model to mark ENTRY-START
runs in reading order (a per-run binary, the Clark hanging-indent analog)
and build the spans mechanically, attaching right-column paradigm runs by
geometry.  Smaller output, no long-list breakdown mode, and the units can
stay fine.  That is the v3 experiment, with half-page renders (2x label
legibility) as its companion lever.

## V3: start-marking reformulation (2026-07-28, pdm/segment-pilot-v3.md)

The model marks only ENTRY-START runs; spans build mechanically
(reading-order y-bands; same-line ties by x).  Results:

- **Robustness fixed**: 10/10 pages completed, zero malformed responses
  (output scales with entries, not units).
- Means: sonnet 58.8 / opus 60.0 pair-F1; start-oracle ceiling 58.4.
- **The models now BEAT the oracle on several pages** (sonnet 82 vs 68
  on p67; 100 vs 76 on p324 - a perfect page).  With gold starts the
  naive y-band builder only reaches 58% because HAND GROUPS INTERLEAVE:
  the tagging often makes each paradigm item / family form its OWN group
  sitting inside another entry's band - a structure y-bands cannot
  express.  A model marking coarser starts sometimes matches gold better
  than the oracle constrained to gold's own granularity.

The open question this exposes is not accuracy but TARGET GRANULARITY:
the hand Tagging groups are per-word-sense (each paradigm item its own
group, because each became its own MMO ref), while the visual page
structure - and dz's "treat tables as entries anyway" - suggests the
import should first resolve VISUAL entries and split families later in
interpretation (where the reading is available).  Scored against
visual-entry granularity (tiny same-band gold groups merged), current
numbers would be substantially higher - p324's 100 and p67's 82 hint at
the real level.  DECIDE WITH DZ before v4: (a) target = visual entries
(re-derive eval gold by merging interleaved groups; interpretation
splits families downstream), or (b) target = hand granularity (then the
span builder needs an interleaving-capable second pass - the right-hand
column attachment by vertical-overlap rather than band-top, plus a
boundary-refinement pass).

## V4: visual-entry gold (decision (a)) — the settled measurement

Hand groups merged into connected components (overlap >=40% of the
smaller box) = the VISUAL-ENTRY gold; per-word splits + evidence
box-sets move to interpretation.  Both tasks re-scored (cached, $0):

| task | opus F1 / entries recovered | sonnet | robustness |
|---|---|---|---|
| grouping | **68.3% / 46%** | erratic (18-69) | 1/10 pages fail schema |
| start-marking | 62.9% / 41% | 59.7% / 48% | 10/10 robust |

- Grouping expresses interleaving (ceiling 96-100) and Opus uses that;
  start-marking is capped by the y-band builder (oracle ~66) - the
  models BEAT that oracle, so bands are the limiter, not the marking.
- OPUS is the segmentation model (reverse of Clark's layer 1); sonnet
  collapses on word-unit pages.
- Production shape: BOTH tasks per page (cheap) - grouping primary,
  starts+bands as the fallback when grouping fails schema; per-entry
  confidence + (weak) divergence for review ordering.
- Read against dz's flow (assistant-suggested groupings, edit-after-
  copy): ~half of visual entries land exactly; the rest are one-box
  edits after import - the designed unit of decision.  This clears the
  draft bar; reading quality (transliteration + English at selection
  time) is now the binding quality question, back on phase-1 ground
  (five-rung gold, judge, correspondence mining).

## The import-to-MMO flow (dz 2026-07-28 - the product target)

Rand/Clark = evidence + support; PACIFIQUE = the source of words.  The
auto-tagged pdm dictionary (bound onto clark/rand/MMO) is BROWSED to
select priority lexemes; an IMPORT button creates the MMO entry with the
bounding boxes COPIED (edited thereafter as MMO-owned data - avoiding
the correct-in-place cascade where fixing one auto group steals boxes
from another), evidence links copied, and the Listuguj transliteration +
English translation produced AT SELECTION TIME so the selector
understands what they are importing.  On request the system re-derives
the reading from edited MMO boxes.  Page-at-a-time remains available
(import every box on a page).

## The five-stage recipe baseline (2026-07-28, pdm/transcribe-eval-5stage.md)

The recipe now runs all five gold rungs (transcribe / expand /
transliterate / source-as-entry / normalize - the rse/rne structuring
stages added), scored on the 25-ref sample:

| stage | strict | lenient | judged | n |
|---|---|---|---|---|
| transcribe | 79.9 | 81.8 | 77 | 24 |
| expand | 76.5 | 77.0 | 64 | 7 |
| transliterate | 58.8 | 59.7 | 66 | 23 |
| source-as-entry | 50.4 | 50.9 | 54 | 15 |
| normalize | 53.7 | 54.1 | 51 | 14 |

Reading the rse/rne errors: exact matches on clean inputs (apusqi'gn,
key), judged-acceptable gloss phrasing variants ("poor little frail
one" vs "poor little one, puny"), and PIPELINE INHERITANCE - an
upstream misreading (transliterate 38% on that ref) is unrecoverable
downstream.  The structuring stages themselves are behaving; the
compounding chain puts a premium on the upstream stages' confidence
gating (low-confidence transcriptions poison everything after).
Also measured this round: the pm-li rules DRAFT injected into the
transliterate prompt is FLAT (58.8 vs 60.3) - the strict ceiling there
is the gold's normalization layer, now explicitly owned by these
stages (transliteration-findings.md Part 4).

## Suggested next steps (in order)

1. Segmentation pilot: 10 gold pages, geometry+LLM hybrid vs the hand
   groups - the go/no-go measurement for the whole ambition.
2. Transliterate tuning round: mine the 1,536-pair corpus into rules
   (the known 60% -> ? lever), re-run the existing eval.
3. rse/rne stage prototypes against their ~980-strong gold.
4. Page atlas (printed numbers + classification).
5. Then the pdm dictionary landing + review-flow wiring, Clark-style.
