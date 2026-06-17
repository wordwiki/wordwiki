---
name: audio-trim-tuning
description: Audio silence/click trim pipeline + the throwaway staff page for choosing the trim threshold by ear (and how to rebuild it)
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

Recordings now auto-trim leading/trailing silence + the start/end click via a
chain of content-addressed derived stores: source (archival, untouched) →
`getTrimmedRecordingPath` (SoX silence-trim + fade, full-fidelity WAV) →
`getCompressedRecordingPath` (lame mp3, derived FROM the trimmed). All in
`wordwiki/audio.ts`. Trim params ride in the getDerived closure (param change =
new artifact; non-destructive, so threshold choice is reversible). Applying a
chosen threshold = set `RECORDING_TRIM_PARAMS.threshold`.

The one tunable is the **silence threshold**. dz can't hear a bad cut, so the
Mi'gmaq language staff choose it BY EAR on a throwaway page
`/ww/wordwiki.audio.trimTuningPage()` — a table of sample words played Original
vs trimmed at several thresholds, with removed-ms readouts. Two sections:
worst-offender words + a random/typical sample. **They will request variants**
(different words/thresholds).

`wordwiki/audio-trim-audit.ts` is the validator: runs the trim over the ~30k
hand-trimmed recordings (the oracle — already-tight clips should lose ~0) and
reports the removed-region PEAK (silence vs speech). Finding: it's a cliff —
0.1% is safe (worst −16 dB), 0.3% cuts loud onsets on ~1% of clips; decision is
~0.2% vs 0.3%.

**Full rebuild recipe (audit → pick offenders/random → resolve headwords via SQL
→ paste into `TRIM_TUNING_SECTIONS` → restart), the design rationale, and the
delete-when-decided steps are in `/home/dziegler/wordwiki/wordwiki/audio-trim-tuning.md`.**
Read that first when staff ask for a page variant.

Related: in-browser recording widget feeds the same upload path ([[wordwiki-transpiled-resources]]
for the client-script gotcha). Server restart: just `./wordwiki.sh` ([[server-restart-protocol]]).
