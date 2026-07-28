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

BUILT: wordwiki/page-transcribe.ts (band transcription over textract geometry, book-generic; bands ~16 lines full-res under the 1568px API downscale; BandInput in extract `input` so per-band facts are in the cache key) + CLI `transcribe-survey` (default Clark pages 1,40,85,130,170, report ../clark/transcribe-survey.md) + pure-helper tests. Stage plan A survey → B hand reference (diacritic fidelity — fold-scoring can't see it) → C 20-30 page dev band + landing → D freeze + full 172. Grammar/place-name sections out of scope (place-names maybe their own prize later).

Interaction: Clark landing reshuffles the rand↔dict referral band → MORE reason [[transliteration-pairs]] deferred runs stay deferred.
