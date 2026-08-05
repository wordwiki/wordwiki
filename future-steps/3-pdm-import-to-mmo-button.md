# Thread 3 — PDM import-to-MMO button (the flow centerpiece)

## What / why
dz's product vision: Pacifique (PDM) is THE SOURCE OF WORDS; rand/clark are
evidence/support.  Staff BROWSE the auto-tagged pdm dictionary, select
PRIORITY lexemes (not page-at-a-time), and click IMPORT-TO-MMO → creates an
MMO entry with the bounding boxes COPIED (thereafter MMO-owned), evidence
links (rand/clark joins) copied, and Listuguj transliteration + English
translation captured at selection time.  Edit-after-copy avoids the
box-stealing cascade ("an assistant suggesting a grouping you can import").

## Read first (CRITICAL)
- wordwiki/pdm-import-mechanism.md — THE current-state doc.  READ IT FIRST;
  it has the exact pipeline, generation-5 state, and the ordered next steps.
- memory [[pdm-llm-transcription]] (the pointer) + [[rand-references-project]]
  (the documentReference role the button copies) + [[machine-contributors]].
- wordwiki/pdm-import-survey.md (measured history) if you need depth.

## Current state (landed)
- Generation 5: 747 word entries / 7,309 assertions from the 10 hand-tagged
  gold pages.  The pipeline (mikmaq/pdm-import.ts): geometry → tuned runs →
  Opus grouping → block groups → escalated 5-stage read → word-split → ONE
  ENTRY PER WORD with overlapping-twin bounding groups (strict 1-1 ref↔group).
- The two-window comparison flow + full dictionary-context preservation
  landed (nav/scan-links/page-jumper stay on the active dict).
- dz's OPEN worry: is the machine tagging close enough to be the staff's
  tagging basis?  He was evaluating via the two-window flow.

## FIRST MOVE (in order — the button is GATED on the joins)
Per pdm-import-mechanism.md §next-steps:
1. **pdm similarity joins** = the evidence links the button copies.  Run
   (EXPLICIT — import_mirror is skipped by default):
   `similarity-rebuild pdm` then `similarity-verdicts pdm rand` / `pdm clark`
   / `pdm dict`.  entryKeys picks up both lanes (mm-pm + mm-li).  Thread 2's
   permissiveness would improve these joins.
2. **The import-to-MMO button** (the centerpiece): creates the MMO entry,
   COPIES the word's bounding group to an MMO-owned group (edit-after-copy =
   the unit of decision), copies the evidence links, shows transliteration +
   translation at selection time.  The per-word BOX-SUBSET derivation (stem
   + own suffix/paradigm cell) belongs HERE — or earlier if staff need true
   per-word boxes to trust the tagging (dz's open question decides this).
3. Landing shape: construct real MMO `alt` cells (grammatical-form code +
   gloss + per-lane texts) for Pacifique's paradigm-table entries, matching
   the editors' own sampled-paradigm convention (workbench §5), NOT flat
   separate entries.

## Settled decisions — don't reopen
- Visual-entry granularity (decision "a"); per-word groups are overlapping
  TWINS pending box-subset refinement at the button.  [dz]
- Boxes COPIED at import (thereafter MMO-owned); edit-after-copy avoids the
  cascade.  Transliteration + translation captured at selection time.  [dz]
- Clark-specific / instance-specific code lives in mikmaq/ (the package rule).
- DON'T run the full-book PDM import (~700 pages, ~$2.5-3k / ~half via Batch
  API which is NOT wired — see Thread 4) without dz's explicit go + quote.
  The \x01 separator is IN the canonical ids (greps/edits must expect it).
