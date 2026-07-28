---
name: clark-import
description: "Clark 1902 image import as reference dictionary: two-layer OCR/interpretation, textract geometry + LLM text hybrid, rand prior as checker; join hub onto rand/watson for MMO growth"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Clark import project (dz 2026-07-28, doc of record wordwiki/clark-import-design.md): import Clark 1902 ("Rand's Micmac dictionary from phonographic word-lists", Jeremiah S. Clark) from page images as a REFERENCE dictionary in the [[multi-dictionary-project]] model. THE JOIN IS THE POINT: Clark entries become hub starting-points (joined onto rand/watson, some % PDM) that a person copies into MMO — the growth speedup.

MEASURED day one (printed-170 probe): NOT a mechanical reversal of Rand 1888 — weskōdum merges >=4 scattered Rand slips w/ a NEW gloss; wenjāwe regrammaticalized ('leader'→'I lead'); 8/18 probed entries have NO rand match (compiled from Rand's manuscript word-lists); Clark-only apparatus (cf.-refs, P.E.I. dialect notes, place names). Entry granularity = the Mi'kmaq word (like MMO, unlike rand's English slips) → Clark↔rand join is MANY-TO-ONE, Clark = the hub entry. Orthography = Rand lighter: macrons/circumflex kept, breves mostly dropped, tc for ch; plain diacritic folding already joins 10/18.

ASSETS ALL BANKED: 234 tifs imports/Clark (document_id 3); printed 1-172 = scans 39-210 mapped in scanned_page.printed_page_number; textract DONE and loaded as 'Text'-layer bounding_box LINE rows (geometry good, text accent-stripped — dz: unusable as text).

ARCHITECTURE (dz's 3 issues): layer 1 = PHYSICAL transcription only (glyphs+diacritics, *italic* style, line identity; NO language tags — italics carry language; pushback accepted); layer 2 = interpretation, text-only, iterate-freely on cached layer 1; extract substrate (liminal/extract.ts) keys both. Textract's 3 roles: mechanical segmentation (columns/bands/hanging-indent entry starts), bounding boxes (entry ref = union of line boxes — NEVER ask the vision model for coordinates), fold-comparison hallucination check. Rand prior = CHECKER not primer (priming copies the prior over the ink exactly where orthographies differ); second pass w/ candidates only on flagged lines. Entries keep verbatim transcription as first-class field; "See X" lands unresolved, resolved in a later whole-book pass; landing = own `clark` table, machineSync, content-keyed ids.

BUILT: wordwiki/page-transcribe.ts (band transcription over textract geometry, book-generic; MASKED band crops à la PDM — plain rects catch neighbour-column hyphen tails; ~16 lines full-res under the 1568px API downscale; BandInput in extract `input` so per-band facts are in the cache key; alignFolded sequence alignment — the model legitimately drops running heads, index-pairing mis-scores everything) + CLI `transcribe-survey` (--book --pages --model --json --report) + pure-helper tests. Stage plan A survey → B diacritic eval → C 20-30 page dev band + landing → D freeze + full 172. Grammar/place-name sections out of scope (place-names maybe their own prize later).

STAGE A DONE (3 iterations, ~$5.7, clark/transcribe-survey.md): fold-exact 88-96%/page; residual disagreements are TEXTRACT errors (LLM out-reads it); headers merge into one line (harmless). STAGE B DONE (clark/diacritic-eval.md): Opus/Sonnet differential + ink adjudication of all 37 letter-level divergences + 6 MMO hand-ref gold. SONNET WINS: 2.7% vs 4.9% line error rate at 1/5 cost (full book ~$15 vs ~$65) — clean-print property, does NOT transfer to PDM manuscript/binder where Sonnet failed. Production recommendation: DUAL-MODEL gate (agreement ~90% auto-accepts, divergence ~9% = review queue, ~$80/book); known-fuzzy class = worn o-accents (ó/ô), survives even dual-agreement. Layer-2 interpret: Sonnet ≡ Opus on comparable entries. MMO's 6 Clark refs carry hand rtr/rtl — rtl = clark→mm-li seed corpus for a future transliteration pair.

Interaction: Clark landing reshuffles the rand↔dict referral band → MORE reason [[transliteration-pairs]] deferred runs stay deferred.
