# Clark layer-1 diacritic eval (stage B) + Opus-vs-Sonnet

dz 2026-07-28.  The stage-A survey scored transcription against the
textract FOLD, which is blind to exactly what we care about (diacritics).
Stage B measures diacritic fidelity, and answers the economics question:
is Sonnet close enough to Opus?  (Spoiler: it is not just close enough -
it was slightly BETTER on this book, at 1/5 the price.)

## Method: model-differential + ink adjudication

Only 6 Clark refs in MMO carry hand transcriptions (4 with diacritic
content) - too thin as primary gold.  So the instrument is:

1. Transcribe the 5 survey pages with BOTH models (band-transcribe v1,
   identical prompts/crops; claude-opus-4-8 vs claude-sonnet-5).
2. Lines where two independent models agree at full diacritic precision
   are presumed correct (spot-checked against ink below).
3. Every divergence is adjudicated by reading the ink: 330% crops of the
   divergent lines, mark by mark.
4. The MMO hand transcriptions serve as an independent human-gold check
   (their 6 pages transcribed separately, section below).

Caveat: the adjudicator is also a model (this session's Claude reading
zoomed crops with unbounded attention) - but the disagreement-driven
design means it only ever breaks ties between two other readers, and the
hand-ref section is fully human gold.

## Agreement (5 pages, 407 line pairs)

- raw agreement (incl. *italics* markup): 281 (69.0%)
- normalized (markup/space-insensitive, diacritics EXACT): 355 (87.2%)
- divergences: 15 spacing/markup-only, 37 letter-level
- one-side-missing (drops at band edges): 11

Spot-check of 8 diacritic-heavy AGREEMENT lines against ink: 7
assessable, 6 confirmed exactly; 1 suspected shared error (*ēgwejôdoo* -
the ink leans acute *ó*).  The shared-error class is worn accent shapes
over o (acute vs circumflex) - both models inherit the same ambiguity.

## Adjudication of the 37 letter-level divergences

Verdicts by ink reading: **Sonnet right 19, Opus right 10, both wrong 1,
unclear/trivial 7.**

Sonnet's wins were mostly LETTER IDENTITY and macron-vs-breve:
`ejoonkwedek` (Opus *ĭ* for d), `ejigulaloōl` (Opus dropped an l),
`lamitpook` (Opus read column-rule+l as !), `pegat` (Opus *pegai*),
`ameoobootc` (Opus *lc*), `pedâk`/`pedâtkweak` (circumflex not breve),
`wenjootēam` family (macron not breve, 4 lines), `wesamenkusīū`,
`—85—` (Opus transcribed a print smudge as an apostrophe), plus the
alphabetically-provable `pegajeankwodum` (the ink genuinely looks like
*b* - textract agreed with Opus - but the PEG section proves *p*).

Opus's wins were mostly FAINT MARKS Sonnet ignored or invented:
`ababāwe` (Sonnet added a macron), plain `I` (Sonnet *Í*), `pillow`
(Sonnet wrote digit 1s for letter-spaced l's), `pedabāwê`,
`wesâwegesum` (clear circumflex; Sonnet *á*), `wenjoŏtāgā` (mark
present), `lambooónit` (clear acute), `weskakeĺum` (a real mark over
the l that Sonnet dropped).

Both wrong once: `wenjootēamwā` (Opus wrong accent *ĕ*, Sonnet wrong
letters *ou* for *oo*).

Unclear (worn type, mark present but shape undecidable at 330%):
`lambooón` (ó vs ô), `pegàkun`-class faint marks (2), `pēdoobĕgasik`,
`wesamé`, + 2 comma-vs-period trivia.

## Error rates (divergence-based; excludes the shared-error floor)

Per-line letter/diacritic error rate over the 407 aligned pairs:

- **Opus:  ~20/407 = 4.9%** of lines contain >=1 letter/diacritic error
- **Sonnet: ~11/407 = 2.7%**
- shared-error floor (both wrong identically): bounded small by the
  spot-check; concentrated in the o-accent shape class.

Cost per 5-page survey run: Opus ~$1.89, Sonnet ~$0.43.  Extrapolated
full book (172 pages, layer 1): **Opus ~$65, Sonnet ~$15.**

## Layer-2 interpretation: Opus vs Sonnet

Of the survey's interpreted entries, 8 had identical input text across
models; outputs were identical on 4 and trivially different on 4
(trailing period, gloss-splitting granularity, one 'lit.' nuance).  No
substantive disagreement - Sonnet is fully adequate for interpretation,
where iteration is nearly free anyway (text-only, cached).

## Human-gold check: the MMO hand-transcribed refs

The 6 refs' pages (22, 93, 107, 131, 168, 169) transcribed with both
models (~$2.65) and compared line-by-line against the hand rtr text:

- **2 clean confirmations**: `weloomk, flattery, abundance, too much;
  weloolk, I flatter him.` and `welāase, I am pretty.` - both models
  match the human hand letter-for-letter, diacritics included.
- **1 divergence, models RIGHT**: hand wrote `nadooádegā` (acute); both
  models wrote `nadooâdegā` (circumflex); the ink at 400% is an
  unambiguous circumflex.  On the only letter-level human-vs-model
  disagreement, the models beat the human transcriber - and it is again
  the accent-shape class.
- **3 refs are not ink transcriptions at all**: one carries French PDM
  text on a Clark bounding group ('ani, amtigo, regarder avec
  mécontentement' where the Clark ink reads 'aneamk, I regard him with
  displeasure'), one is shorthand ('p. oigasig' for the letter-spaced
  'pegoonwegasik'), one a bare citation note ('(mīoei, 93,2)').
  FINDING for future evals: dict rtr fields on Clark refs are sometimes
  citation notes, not transcriptions - filter before using as gold.

Also banked: the refs' rtl fields are hand Clark->mm-li
transliterations - seed corpus for a future clark->mm-li
transliteration pair.

## Verdict and production recommendation

1. **Sonnet for layer 1** - measurably at least Opus-grade on this
   book's clean roman/italic print, at 1/5 cost.  (This does NOT
   transfer to the PDM manuscript or the binder, where Sonnet measurably
   failed; it is a property of clean print.)
2. Better: **run BOTH models as the production QA gate** (~$80 full
   book).  Agreement (~90% of lines) auto-accepts; divergences (~9%)
   become the review queue, exactly as adjudicated here.  The eval
   methodology IS the production quality mechanism - no hand
   transcription pass needed.
3. The residual hard class - worn accent shapes over o - survives even
   dual-model agreement; treat o-accents as a known-fuzzy class in
   layer 2 (the [a|b] ambiguity convention already covers recording it).
