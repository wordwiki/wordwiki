# RAND ↔ MMO: orthography & part-of-speech survey (for Watson review)

2026-07-26.  An initial survey of word pairs between the RAND
transcription (29,097 records, the July drop) and Mi'gmaq Online
(8,612 Listuguj-lane spellings), produced by matching entries on
spelling.  We ran an auto-transliteration experiment FIRST (see part 2)
so this doc carries measured findings rather than impressions; the
open questions for Watson are at the end of part 1.

## Part 1 — Findings

### 1. Vocabulary overlap

- **1,443 exact spelling matches** between RAND's Listuguj-style lane
  and MMO's (1,446 after normalizing MMO's stray typographic
  apostrophes — see finding 5).
- **577 near matches**: identical once case and the apostrophe-family
  marks (`'`, `` ` ``, `’`, hyphens) are ignored.  These pairs are the
  same word under different marking conventions, and they are the
  evidence base for findings 2–3.
- So roughly a QUARTER of MMO's vocabulary is directly findable in
  RAND by spelling alone — a strong anchor set for the planned batch
  joining.

### 2. The backtick: Watson's distinct schwa mark

**1,279 RAND Listuguj spellings use a backtick `` ` ``** (none in the
SF lane, none anywhere in MMO).  Where MMO has the same word, the
backtick corresponds to MMO's `'` (76 cases) or to nothing (7):

    RAND `nmu'j     →  MMO nmu'j
    RAND e'w`g      →  MMO e'w'g
    RAND engat`g    →  MMO engatg

Reading: Watson distinguishes the SCHWA mark (`` ` ``) from the vowel
LENGTH mark (`'`), where MMO's convention writes `'` for both (or
omits the schwa entirely).

### 3. Apostrophe placement: two different marking practices

After the mechanical rules (finding 2 + case) are applied, **479 near
pairs still differ, purely in `'` placement** — and the difference
decomposes cleanly by context:

| residual marks           | after a VOWEL (length) | after a CONSONANT (schwa) |
|--------------------------|-----------------------:|--------------------------:|
| MMO writes, RAND omits   | **331** (`esa'tl` vs `esatl`) | 19 |
| RAND writes, MMO omits   | 93 (`enga'latl` vs `engalatl`) | **73** (`engat'g`, `nmu'j`-style) |

Reading: **MMO marks vowel length much more consistently than the
RAND transcription** (331 vs 93), while **Watson marks schwa (with
`` ` `` or `'`) more than MMO does** (1,279 backticks + 73 vs 19).
The length-mark contexts are phonologically diffuse (a_t, i_g, a_s,
e_g, o_t, ... — no dominant pattern), so this residue is NOT
mechanically fixable by context-free rules; it needs either the
matched MMO spelling as authority, phonological knowledge, or a
convention decision.

### 4. Part of speech: mostly still unclassified in RAND

- Only **2,131 of RAND's 29,309 senses (~7%) carry a paradigm code**
  (`\ps`, e.g. `W5 ni ei`), and just 255 carry the English-system
  `\pn`.  The larger story is that classification is AHEAD, not
  differently-defaulted.
- RAND's codes are RICHER than MMO's plain pos: class token
  (`W5/T3/T5/T>5/W3/T>3/Ma/An`) + a pos token + an ending.  The pos
  tokens use the same vocabulary as MMO (`ni/vai/vii/vit/vat/na`...).
- Where BOTH dictionaries classify the same word they mostly agree
  (vit~vit, na~na, ni~ni, vai~vai), with occasional crossings
  (MMO `vii` ~ RAND `vit`).
- The classified subset skews noun-heavy relative to MMO (`ni` 29.7%
  of RAND's classified senses vs 13.8% of MMO's; `vat` 6.3% vs
  14.2%) — plausibly "what got classified first" rather than a
  different convention.

### 5. Side-find in MMO itself

30 MMO Listuguj spellings contain the TYPOGRAPHIC apostrophe `’`
instead of `'` — an MMO-side cleanup candidate independent of RAND.

### Questions for Watson

1. Is the backtick `` ` `` deliberately a distinct SCHWA mark (vs `'`
   for length)?  Should it be preserved as-is in the archival copy,
   and mapped to `'` (or dropped?) when presenting in MMO's
   convention?
2. For vowel length: is the intent to converge on MMO's (fuller)
   marking, or is lighter marking a deliberate choice for the RAND
   transcription?
3. The `W5/T3/T>5...` class tokens in `\ps` — what is the system?
   (We would like to make it a controlled vocabulary with display
   names.)
4. Is `\pn` (English-system pos) still intended, or superseded by the
   paradigm codes?
5. Initial capitals (`Lnu` vs MMO `lnu`): a convention, or per-word?

## Part 2 — The auto-transliteration experiment (our notes)

Method: pair RAND-li and MMO-li spellings exactly, then "near"
(equal after stripping case + the apostrophe family); score candidate
mechanical rules by how many additional exact matches they produce;
context-classify the residue.

| rule set                            | exact matches | gain |
|-------------------------------------|--------------:|-----:|
| baseline (MMO `’`→`'` only)         | 1,446         |      |
| + `` ` ``→`'`                       | 1,514         |  +68 |
| + `` ` ``→∅ (instead)               | 1,453         |   +7 |
| + `` ` ``→`'` and case-fold         | **1,531**     | **+85** |

Conclusions:
- `` ` ``→`'` is clearly the right mechanical reading (68 vs 7).
- The mechanical ceiling is low: +85 of 577 near pairs (~15%).  The
  remaining 479 are the length/schwa marking practices of finding 3 —
  lexical, not rule-shaped.  For MATCHING purposes (dup detection,
  batch joining), a mark-insensitive comparison is the right tool;
  for PRESENTATION, the matched MMO spelling should be authority
  where a pair exists, and the rest awaits Watson's answers.
- Pipeline implications: (a) the rand↔MMO matcher wants
  mark-insensitive keys (extend the variantsOverlap/dup-detection
  machinery); (b) Watson's li likely deserves its OWN orthography row
  (auto-transliteration to MMO-li as a derived lane) rather than
  sharing `mm-li` — the same treatment as li→sf.

Reproduce: `python3 watson/rand-orthography-survey.py` against a db
with the `dict` and `rand` tables loaded (the sfm-import + transform
pipeline).  Numbers above are from the 2026-07 Watson drop,
generation 1 of both imports.
