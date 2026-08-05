# Thread 1 — pm-li taxonomy reading + verdict loop

## What / why
The pm-li (Pacifique→Listuguj) rules score only ~30% on holdout, but a big
slice of the "errors" are (a) the gold rtl being a REGULARIZED citation
form, not a faithful transcription, and (b) corpus NOISE (French source /
English gloss leakage the extractor missed).  We need the language team to
judge the ~34 genuinely-ambiguous cases so the measurement isn't poisoned —
this is the prerequisite for the whole language-level lever work.

## Read first
- wordwiki/transliteration-workbench.md §10 (the taxonomy) + §8.5.
- wordwiki/phonology-reference.md §0.1 (the measured miss clusters) + §4.2.
- mikmaq/pm-li-taxonomy.ts (the generator) + memory [[transliteration-pairs]].

## Current state (landed)
- The review page is BUILT: `./wordwiki.sh build-pm-li-taxonomy` reads the
  db (pm-li extractCorpus / pdmRefCorpus), writes
  resources/generated/pm-li-taxonomy.html — a mailable, design-language
  review page (Phase 3 of the rebuild builds it).  Linked in the navbar
  Reviews menu.
- Human verdicts persist in mikmaq/pm-li-taxonomy-verdicts.json
  (content-keyed by hash(source+gold); the generator MERGES, never
  overwrites — proven).  So partial feedback now + more later both rebind,
  and re-running after a rule change preserves verdicts.
- Preliminary machine sizing (ZERO expert input): 169 holdout misses —
  length 86 (dominant, unrecoverable for generation), phonological 120/169,
  ONLY 34 expert-critical, gloss-leak 11 + data-noise 34 = corpus cleaning.

## FIRST MOVE (no expert needed — do these before the expert has energy)
The expert (most knowledgeable) is mid-chemo, low energy short-term, better
in a few months.  So DON'T wait on them — two high-value Claude-side tasks:
1. **Tighten pdmRefCorpus (mikmaq/transliterate-pairs.ts).**  ~45 of the 169
   misses are gloss-leak (French rtr / English rtl) + tokenization noise
   (spaces, slashes = multi-word/alt-form gold).  The taxonomy already
   detects them (glossLeak() + the 'data' tag in pm-li-taxonomy.ts — reuse
   that logic).  Cleaning the extractor removes them from the corpus →
   improves the measurement denominator, needs NO expert.  Re-run the
   harness + taxonomy after.
2. **Build in-app verdict capture** so the team clicks instead of
   hand-editing JSON.  A small route on the taxonomy page that writes
   mikmaq/pm-li-taxonomy-verdicts.json by content-keyed id (the schema the
   generator already reads: {id: {verdict, note, by}}).  This is the
   machineFeedback loop (see [[machine-contributors]]).  Low ceremony —
   confirm/correct per card (the design-language mutation model).

## Then (expert-gated, when verdicts arrive)
Fold verdicts in, re-bucket (§4.2: length→lever1, uvular/glide→lever3,
morphological→lever2), and that sizing decides which lever to build (see
Thread 2).  Verdicts rebind by id automatically on re-generate.

## Settled decisions — don't reopen
- Live-tunable, not big-bang (verdicts persist + rebind).  [dz]
- Length bucket is phonetically IRRECOVERABLE → it's a MATCH problem
  (Thread 2), not a generation-rule fix.  [phonology §4 F1]
- Don't burn expert energy; the critical set is bounded to ~34.
