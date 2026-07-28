# Clark import: images -> reference dictionary (design + survey plan)

dz 2026-07-28.  Import Clark ("Rand's Micmac dictionary from phonographic
word-lists", Jeremiah S. Clark, 1902) from the page images as a REFERENCE
dictionary: support material joined onto rand/watson (and some % of PDM),
so that someone growing MMO can start from a pre-assembled joined word
instead of a blank entry.  The join is the point; the import is the means.

## Why this book (measured, printed page 170 probe 2026-07-28)

Clark is NOT a mechanical reversal of Rand 1888 - it is a consolidation
with fresh lexicography, done while the language was in far wider use:

- *weskōdum*: Rand scatters it under >=4 English slips (keep / retain /
  have / detain); Clark merges them and writes a NEW gloss ("I have it,
  possess it, mention it" - "mention" is in none of the four).
- *wenjāwe*: Rand's slip is the noun 'leader'; Clark regrammaticalizes to
  "I lead" - entries are organized around the Mi'kmaq word, not the
  English card.
- ~half the probed entries (8/18) have NO rand match by folded spelling
  (wenmajogun 'anguish', wep 'the pith', weskakelum 'a kiss', the
  wenjooe- prefix note) - consistent with Clark compiling from Rand's
  manuscript phonographic word-lists, not (only) the printed 1888.
- Clark-only apparatus: cross-refs ("cf. maktomanētckul"), dialect notes
  ("wejek, pl: gul, P.E.I. dialect"), place names ("Wesek, Gibraltar,
  N.S."), editorial brackets.

Entry granularity is the Mi'kmaq word (like MMO), where rand is
English-slip granularity - so Clark<->rand joins are MANY-TO-ONE and a
Clark entry is the natural HUB that groups the scattered Rand slips (plus
watson forms) into exactly the copy-into-MMO starting point.

Orthography: Rand's system but lighter - macrons + circumflex kept
(wenjāwe, wenkâbeme), Rand's breves mostly dropped (wĕskijenooe ->
weskijenooe), 'tc' where Rand prints 'ch' (Wenootc).  Plain diacritic
folding already collided Clark<->rand at 10/18 on the probe page with
zero new transliteration work - the join pays from day one, and the
misses are themselves the interesting list.

## What we already have (all banked, zero new spend)

- Scans: `imports/Clark` - 234 tifs; scanned_document id 3; scanned_page
  rows with content-store image_refs (~2474x3954 px pages).
- Printed-page mapping DONE: printed 1-172 = scans 39-210 (27 confirmed,
  143 interpolated; import-report/15-clark-printed-pages.md).
- Textract run AND loaded: raw JSON in `derived/Clark-textract`, and -
  the useful form - LINE boxes with text in the db (`Text` layer,
  document 3; e.g. 91 line boxes on printed 170).  The textract TEXT is
  accent-stripped junk for our purpose; the GEOMETRY is good.
- The scan->extract substrate (liminal/extract.ts): cached staged
  extraction keyed on [image, stage name, model, promptVersion, imageBox,
  prior input] in the derived content store; per-stage usage accounting;
  re-runs free until a key component changes.  Proven by the PDM
  transcription eval and the rand reference binder.
- Page views already published (mmo/books/Clark/page-NNNN).

## Architecture: two layers over the extract substrate

### Layer 1 - PHYSICAL transcription (expensive, frozen early, cached)

Records only what a myopic typesetter sees: glyphs WITH diacritics, style
(italic/bold), line identity and position.  No language tags, no entry
boundaries, no interpretation - that discipline is what makes layer 1
stable enough to cache and never redo.  (In Clark, italic-vs-roman
physically encodes Mi'kmaq-vs-English anyway, so capturing style gives
layer 2 language for free.)

Unit of transcription: a BAND - a run of ~16 consecutive textract line
boxes from one column, cropped at full resolution (a band is ~1200x1150
px, under the vision API's 1568 downscale threshold, ~70 px per line -
diacritics stay legible; a full column would be downscaled to ~28
px/line).  Bands and column split are derived MECHANICALLY from the
textract line geometry: lines assigned left/right by center-x, banded in
y order, band crop = column x-range x band y-range (+margin).  Crops are
content-addressed derived files ([page image, rect] in the key), so they
stand in for the pixels in the extraction cache key.

The model gets the crop + the expected LINE COUNT (physical, safe prior)
and returns one output line per printed line, diacritics exact, *italic*
markup, the PDM ambiguity conventions ([a|b], ⁇) and a 0-100 confidence.

Textract's three roles (never its text as output):
1. SEGMENTATION - columns, bands, entry-start detection (hanging indent:
   entry-start lines sit at column left edge, continuations indent).
2. BOUNDING BOXES - the entry's documentReference box = union of its
   line boxes.  The vision model is never asked for coordinates.
3. HALLUCINATION CHECK - fold(LLM line) vs fold(textract line)
   (diacritics/markup stripped, lowercase alnum): agreement is a free
   per-line quality gate; disagreements are the re-review queue.

The rand prior (dz's suggestion) is used as a CHECKER, not a primer:
priming the transcriber with expected spellings risks the model copying
the prior over the ink - silently normalizing Clark's diacritics toward
Rand's, exactly where the orthographies differ.  So: layer 1 sees only
guide-word/alphabet context; then lines where the LLM disagrees with BOTH
the textract fold AND every rand spelling in the alphabetical window get
flagged, and only flagged lines get a second pass that shows the crop
plus the rand candidates and asks which, if any, matches the ink.  The
prior can rescue hard cases but never overwrite easy ones.

### Layer 2 - INTERPRETATION (cheap, text-only, iterate freely)

Consumes cached layer-1 lines; every run is text-only (cheap-model
eligible) and re-runnable at near-zero cost - dz's issue 2 solved by the
same caching machinery the binder and judge use.

- Entry assembly: mechanical-first (entry-start x-position + italic
  headword), LLM confirms/repairs - column/page continuations are the
  known hard case; guide words + hyphenation are the anchors.
- Per entry, the LLM reads the assembled text as the intelligent reader:
  headword + variant spellings (parenthesized alternates like
  (wenjoogwam)), glosses, embedded derivatives (wēoosaboo 'broth' inside
  the wēoos entry), cross-refs, dialect/usage/place-name notes,
  decompositions.  The soft schema GROWS from what the content actually
  contains (multi-dictionary model: per-dictionary schema as data).
- Every entry keeps its VERBATIM layer-1 transcription as a first-class
  field - interpretation extracts alongside, never replaces (the
  archival philosophy).
- Cross-refs ("See X", "cf. Y") land as UNRESOLVED reference strings
  first; a separate later pass resolves them to entry links once the
  whole book is in.
- Landing: own dictionary table `clark`, machineSync diff-first with
  deterministic content-keyed ids - re-interpretation reconciles instead
  of clobbering, so iterating stays safe after people use the joined
  view.
- documentReference planted per entry from the line-box union (we start
  FROM the images this time, so refs come with the import instead of
  needing a binder run).

### Joining (the actual goal)

After landing: similarity index + pairing machinery as for rand<->dict
(skeleton folding already collides Clark<->rand; add a 'clark' lane
normalizer = rand's folding + tc/ch).  Clark<->rand join is many-to-one
by design (hub).  MMO reach via the existing transliteration hub.  The
survey measures join rate from day one because the join is the purpose.

## Survey plan (iterative work-up, affordable to redo)

Stage A - 5-page survey (NOW): printed 1 (A, section opener), 40 (E),
85 (L, section opener), 130 (P), 170 (W, hand-probed).  Per page:
- layer-1 transcribe all bands (Opus, per PDM/binder precedent);
- score vs textract fold (agreement %, near-miss distances, flag list);
- entry segmentation from geometry; headword join rate vs rand window;
- interpret a taste of entries (layer-2 sketch) to seed the soft schema;
- report with real per-page cost -> quote for the full 172.
Est. ~30 band calls ~ $1-2 Opus; all cached.

Stage B - diacritic fidelity + model economics: DONE 2026-07-28, report
clark/diacritic-eval.md.  Method: Opus/Sonnet differential + ink
adjudication of every divergence + the 6 MMO hand-transcribed Clark refs
as human gold.  Outcome: Sonnet slightly BETTER than Opus on this book
(2.7% vs 4.9% line error rate) at 1/5 cost; production recommendation is
the DUAL-MODEL gate (agreement auto-accepts, divergences = the review
queue, ~$80 full book); known-fuzzy class: worn accent shapes over o.

Stage C - dev band: BUILT 2026-07-28 (clark-import.ts + assembly in
page-transcribe.ts; CLI `clark-import --pages=1-25`).  Dual-model layer 1
(Sonnet primary per stage B, Opus gate; divergent lines flagged),
mechanical entry assembly (gutter-detected column split - center-x
misfiles short indented lines; hanging-indent starts; cross-column/page
stitching), Sonnet interpretation, landing as an import-mirror `clark`
table (sfm-style wipe+rebuild, content-keyed ids, '~clark-import' stamp)
with per-entry bounding groups on the Tagging:clark sheet.  881 entries
/ 5,163 assertions from printed 1-25 (generation 3).  Two bugs found and
fixed by the dev band: the center-x column split misfiled short indented
lines into the wrong column's entry ('abode'; now gutter-detected), and
liminal's getDerived used std fs.move (remove-then-rename - a concurrent
reader sees the file vanish; now atomic Deno.rename - hit by the
dual-model runs deriving the same contained crop).
JOIN: rand entries were invisible to Clark until entryKeys also indexed
SOURCE-ORTHOGRAPHY texts (schemaRoles.sourceOrthographyTexts - rand's
headword role holds only watson lanes; rand index 740k keys).  Measured:
clark->rand same-word 371 pairs (referral band 466); 20.3% of clark
entries collide exact-skeleton with rand; 5.9% reach MMO through the
landed rand->mcp hub already.  clark->dict direct stays small by design
- MMO reach is the hub composition.  Known dev-band items: entry-start
over-detection (junk fragment entries), interpretation confidence <70 on
~11%.

Stage D - freeze + full run: DONE 2026-07-28 (generation 5).  Printed
1-172: 6,694 entries / 37,715 assertions; 7,659 glosses, 2,049
derivatives, 232 cross-refs, 794 notes; 162 cross-column/page joins; 524
headers skipped; 1,019 dual-model divergent lines flagged; 1 interpret
failure, 331 low-confidence, 4 empty fragments skipped.  Run hardening:
llmRetry covers schema-mismatch responses, and a band that still fails
degrades to textract fallback instead of killing the run.
JOIN (full book): clark->rand same-word 4,563 pairs (referral band
5,424); 27.6% of clark entries collide exact-skeleton with rand; 8.7%
(583 entries) already reach MMO through the landed rand->mcp hub.
clark->dict direct 281 same-word.  Review-band prep (dev-band review
2026-07-28): interpret v2 fixed the ending-as-headword class (91
'endings:' notes); residual junk ~0.5% fragment entries.
Grammar + place-name sections remain OUT OF SCOPE (place-names may be
their own prize).

POST-STAGE-D refinements (dz review, 2026-07-28): the verbatim
transcription now NESTS inside the documentReference ('rtr', rand's
convention - a detached sibling was not a win); the Clark-SPECIFIC code
(schema, importer, stage prompts) moved to mikmaq/clark-import.ts per
the packaging rule - wordwiki/page-transcribe.ts keeps only the
book-generic machinery and takes the stages as parameters; the shared
Tags/Log workflow surface is generalized by role
(ensure-workflow-relations copies the default dictionary's tag+log
relation shapes; the workflow verbs/fragments carry a dict parameter),
and clark's mirror wipe PRESERVES human 'tdo'/'log' rows across
re-imports (content-keyed entry ids keep them attached; changed entries
orphan them visibly).

## Interaction with the deferred LLM runs

Clark landing reshuffles the rand<->dict referral band and adds a new
join surface - MORE reason the full-band judge + full rand binding stay
deferred until this settles (wordwiki/deferred-llm-runs.md).  Clark's
own layer-1 cache is safe to build early: it keys on the page images +
prompt, which nothing else churns.
