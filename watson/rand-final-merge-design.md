# Merging the Final files (Ng/Lk) into the rand import — survey + design

2026-07-26.  watson.txt describes the workflow: processed entries MOVE
out of the big Rand file into RandMigmFinal2000 (= Ng20726, g-system
headwords) and are then COPIED to RandMikmFinal2000 (= Lk20726,
k-system headwords promoted from \lsf).  This doc verifies that
account against the data and designs the multi-source merge for the
import pipeline.  (Verification script: rand-final-merge-survey.py.)

## What the data says

1. **Disjointness is PERFECT.**  Zero Ng or Lk headwords appear in the
   big file (29,097 records) — the Move really removes them.  So the
   full dictionary is the UNION of the raw queue and the Finals, with
   no dedup needed between them.
2. **Ng ↔ Lk pairing: good but imperfect.**  2,335 of ~2,500 pair
   exactly via `Ng.\lsf == Lk.\lx` (the copy-and-promote key).  150 Lk
   and 129 Ng-lsf keys are unpaired — post-copy spelling edits broke
   them — and 35 Ng records carry no \lsf at all.  (The survey's
   mark-insensitive normalization should close much of this gap; the
   rest is a report.)
3. **The pair has DIVERGED: 200 of 2,348 paired entries** differ in
   content fields — \de (129), \ge (59), \so (40), \xe (35), ... —
   and the newer \dt is on the Lk side 94 times, the Ng side 67, and
   EQUAL 39 times.  Watson edits whichever copy he is in; NEITHER
   file is uniformly authoritative.  This is the manual fork doing
   exactly what manual forks do.
4. **The count closes with a remainder**: 33,276 (original) − 29,097
   (queue) − 2,499 (Ng) = **1,680 records that left the queue but are
   in neither Final** — plausibly deleted duplicates (the queue still
   holds 7,816 duplicate-headword rows), but that is a QUESTION FOR
   WATSON, not an assumption.

## The merge design — REVISED 2026-07-26: PRE-IMPORT (dz)

**Superseding the multi-source-transform section below**: the merge
happens BEFORE import.  merge-rand-sources.ts reads the three
committed files and emits ONE merged SFM file (rand-merged.sfm +
rand-merged-report.md) - the single-source pipeline then runs
unchanged.  Why: far less machinery (zero engine changes), and the
merge result is itself SFM - inspectable, diffable across drops, and
Watson-readable.  Provenance and drift ride IN-BAND as z-markers
(declared in the structural .typ): `\zpt` = partition
(final | final-lk-only | queue), `\zdv` = a field where the Lk copy
disagrees with the Ng base - mapped to `attr` rows
(import-partition / merge-divergence) by the transform, so the
divergence worklist is browsable data in the editor.  Paired Ng
records ARE the merged form (both lanes already); lk-only records
emit with the k-spelling in \lsf and an empty \lx (the cross-lane
headword fallback presents them); the queue passes through.
Numbers from the first run: 2,498 final (2,356 paired = 2,348 exact
+ 21 mark-insensitive rescues... see rand-merged-report.md), 128
lk-only, 29,097 queue, 198 diverged pairs (291 \zdv notes).
The archival mirror of what Watson SENT is the committed originals
in git + the deterministic merge script.

## The multi-source-transform design (NOT built - kept as the
## someday-generalization if a future corpus truly needs it)

Three import mirrors, one transform, one rich dictionary:

    randraw  (done)      the 29,097-record queue
    ngraw               Ng20726, tree mode, the same structural .typ
    lkraw               Lk20726, likewise

**Import-time id spaces.**  sfm-import gains an `--id-base` option
(e.g. randraw 1,000 / ngraw 40,000,000 / lkraw 80,000,000) so the
transform's deterministic id-reuse stays collision-free across
sources.  Still a counter per file: identical re-imports stay
byte-identical.

**Transform: multi-source (the mapping shape anticipated this).**
- `sources` lists all three; RULES gain an optional `source` selector
  (default sources[0]); the Ng rules differ only in the lane
  assignments (`\lx` → the Watson-li lane, `\lsf` → the k-system
  lane); Lk contributes no new lanes when paired (its \lx IS the
  Ng \lsf).
- **Entry pairing**: per-source `entryKey` specs (Ng: \lsf; Lk: \lx),
  compared MARK-INSENSITIVELY (the survey's normalization).  Paired
  Ng+Lk records merge into ONE target entry; the raw queue's entries
  (disjoint, verified) map 1:1 as today.
- **Divergence policy for the 200** (decision needed — options):
  a. *Base = Ng + divergence report*: deterministic, nothing lost
     (the report shows Lk's readings side-by-side); simplest.
  b. *Newer-\dt wins wholesale + report*: honors Watson's latest
     touch, but \dt is record-level (39 ties) and wholesale-clobbers
     the older side's fields.
  c. *Base = Ng; divergent Lk values land as PENDING versions on the
     same facts*: the change approver becomes the merge UI — the
     offline-fork philosophy applied early.  Most alignment with the
     system, more transform machinery (multi-version emission).
  Recommendation: (a) now, (c) when the fork-merge machinery arrives.
- **Provenance**: every rich entry carries an `attr`
  `import-partition` = `queue` | `final`; paired entries also record
  their source ids (`import-source`: `ngraw:<id>,lkraw:<id>`), so the
  reunification is auditable and re-derivable.
- **Unpaired Finals** (after mark-insensitive retry): land as their
  own entries + a pairing report — Watson's worklist alongside the
  divergence list.

**Report additions**: pairing stats, the divergence worklist
(side-by-side field diffs, both \dt stamps), the unpaired list, and
the 1,680-gap accounting.

## New questions for Watson

6. ~1,680 records left the big file but are in neither Final —
   deleted duplicates?  (The queue still holds 7,816
   duplicate-headword rows.)
7. When Ng and Lk disagree on a processed entry (200 today), which
   reading should win?  (Once the merged dictionary exists with both
   lanes on one entry, the two-file fork becomes unnecessary — the
   system maintains both presentations from one record.)
