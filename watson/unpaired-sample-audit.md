# Unpaired-word attention audit (20-entry sample, 2026-07-27)

Method: 20 hash-sampled dict entries with definitions and NO counterpart
link (from the 6,278 unpaired of 8,108 defined).  For each: loosened
searches against rand (IDF def-token overlap far past the blocking
limits; skeleton edit distance <= 3), then individual attention - full
glosses read, roots compared, targeted follow-up queries.  The goal is
not to fix these 20 but to CLASSIFY the misses (transliteration-findings
Part 3; dz: what would better pairing or more LLM time buy?).

## Verdicts

| # | dict word | gloss | finding |
| --- | --- | --- | --- |
| 1 | elsma'latl | lay him down | **MISSED same-word**: rand elisma'latl 'lay down' (syncope: one i) |
| 10 | wissugwalatl | cook him | **MISSED same-word**: rand wisgugwalatl 'cook him' (ss/sg) |
| 16 | g's'talg | finished eating | **MISSED same-word**: rand gisatalg 'finish eating' (syncope ×2 + finish/finished) |
| 8 | aqantie'umg | Sunday | in REFERRAL BAND: rand aqntiewimg 'sunday' (epenthesis + u/wi glide, d=2) |
| 15 | wejimatl | make out (sexually) | in REFERRAL BAND: rand wejimatl 'found' - exact skeleton, disjoint gloss; genuinely needs judgment |
| 7 | pagwe'jg | shallow water | probable: rand pa'gweg 'shoal' (diminutive -j- + SYNONYM gap shoal/shallow) |
| 13 | naspit | attached / member | probable: rand nespit 'sits with/remains' (a/e DIALECT vowel + gloss drift; nesp- root) |
| 0 | nugjaqtesg'g | crush by stomping | possible root-kin: rand nugjemigs`g 'squash (v)' - nugj- crush root, different final |
| 19 | waqamaluat | clean tail | same lexeme, different inflection: rand waqamalue'g 'clean tail' - related, not counterpart |
| 4 | piglewei | (glass) lamp chimney | speculative: rand pegtew 'glass' -> pegtewei; l/t + vowel; expert call |
| 18 | welgwijimatl | put in good humor | related same-stem: welgwije'watl 'encourage' (+ encourage/encouraging STEMMING gap) |
| 2,3,5,6,9,11,12,14,17 | - | - | genuinely ABSENT as same-word (modern compounds / forms Rand lacks); several have root-family relatives (poqt-, sangew-, esp-, gaq-) |

Score: 3 confident recoverable same-words + 2 already waiting in the
referral band + ~3 probable = **~15-25% of unpaired entries look
recoverable**; roughly half the sample is genuinely absent from Rand -
the pairing CEILING is well under 100% and that is not a defect.

## Miss mechanisms -> what to build

1. **Blocking gap - near-identical spellings never meet** (#1,#10,#16).
   Near-skeleton pairs only become candidates via a shared def token
   that survives the df limits; common glosses (lay, cook, eating)
   never do.  CHEAP FIX: index a CONSONANT-SKELETON key kind ('cskel',
   vowels+marks stripped): lsmltl==lsmltl, gstlg==gstlg catch syncope
   exactly.  ~15% of the sample; the single best algorithmic win.
2. **English inflection in def tokens** (#16 finish/finished, #18
   encourage/encouraging).  definitionTokens folds plurals only.
   CHEAP FIX: light stemming (-ed/-ing/-ly).
3. **Synonym / archaic-gloss gap** (#7 shoal vs shallow; Rand's
   'victuals'-era vocabulary).  Needs a semantic bridge: small curated
   synonym table, or the LLM judge.  This is what LLM time buys that
   algorithms cannot.
4. **Referral band is working** (#8, #15 are sitting in the 4,535):
   funding the judge pass recovers these - the sample suggests the band
   contains real pairs, not just noise.
5. **Dialect vowels** (#13 naspit/nespit): C-class correspondences
   (dialect-residue report) could become a NEAR-SKEL widening: treat
   a<->e (etc., the measured table) as half-edits.  Medium risk.
6. **Root lexicon growth is free** (#0 nugj-, #6 sangew-, #5 poqt-,
   #14 gaq-): each adds RELATED links (the future xref layer).
7. Bycatch: rand-internal DUPLICATES surfaced (pa'gweg ×2, nespit ×3) -
   the self-dup probe has work to do inside rand as well.
