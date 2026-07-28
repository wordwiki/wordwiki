---
name: pdm-llm-transcription
description: "PDM LLM transcription: phase 1 complete + PAUSED 2026-07-16; doc of record repo-root pdm-transcription.md (vision: full-dictionary transliteration for cherry-picking)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

DOC OF RECORD: repo-root pdm-transcription.md (written 2026-07-16 as
the pause/handoff artifact - READ IT FIRST on resuming; it has the
vision, findings, run instructions, and the road map).

PHASE 1 COMPLETE (2026-07-11..16), paused to clean up other WIP. The
short version:

- wordwiki/transcribe.ts + `./wordwiki.sh transcribe-eval` (read-only;
  runs beside the live server). Credential
  wordwiki-anthropic-credential.json at repo root, SYMLINKED into mmo/.
- MASKED group crops (boxes pasted onto white; 16px box margin;
  mask-aware prompts) - union crops leaked neighbors' text (16%-coverage
  ref: 35%@c72 reading neighbors -> 94%@c80 masked). ImageMagick
  CopyOpacity is broken on this build - use the paste approach.
- 3-stage recipe (transcribe/expand/transliterate), language-tagged
  runs in-schema, [a|b] ambiguity + confidence, JUDGE stage classifying
  differences (punctuation/valid-alternative/llm-error/
  researcher-error/unclear). THE GOLD IS IMPERFECT - judge caught real
  researcher omissions; raw string scores UNDERSTATE quality (only
  15/49 differences were LLM errors).
- 25-ref numbers: transcribe 79.8% strict/judged 77; expand 77.8%
  (n=7); transliterate 60.3%/judged 66 (THE WEAK LINK - next: mine
  correspondences from the ~1,520 gold pairs, transliterate.ts-style).
  Confidence well calibrated (worst refs self-report c18-42).
- Review page: resources/transcribe-eval.{json,html}, served at
  /resources/transcribe-eval.html, Reports menu link; self-contained
  (mailable to the research group). Regenerating = re-run the CLI
  (cache makes unchanged runs FREE; deterministic sample order).
- dz's VISION (in the doc): full automated transliteration of all ~700
  pages to enable CHERRY-PICKING (avoid the 200-of-700-pages dead end)
  + faster construction + UI aids (hover-translate French runs).
  Requires an LLM page-SEGMENTATION stage (gold: ~200 hand-transcribed
  pages) + cost levers (cheaper models graded by this eval, Batch API,
  confidence-gated escalation).

Relates to [[minimal-ceremony-principle]], [[wordwiki-archival-publish-model]].

PDM IMPORT PROJECT LAUNCHED (dz 2026-07-28): the Clark-style full import, MUCH harder (handwriting, ragged entries/arrows, elided stems, inline paradigm tables-as-entries, French→English step) but the HIGHEST-VALUE import — the primary editors' funded priority is page-at-a-time PDM transcription; a workable import converts it to review-a-draft and may unlock priority-WORD picking. NEW requirement vs phase 1: PAGE-STRUCTURE RESOLUTION (segmentation). SURVEY DONE: wordwiki/pdm-import-survey.md (read with pdm-transcription.md). Key measured assets: 828 scans (NO printed mapping yet); textract WORD geometry usable/text garbled; SEGMENTATION GOLD = 2,277 hand Tagging groups (10,043 boxes) on 73 pages (43 dense, spread pages 4-823); ENTRY GOLD = 1,596 dict refs with FIVE rungs rtr 1,555 / rex 675 / rtl 1,536 / rse 980 / rne 987 (rse/rne = structuring gold phase 1 never used); ~1,536 rtr↔rtl pairs = Pacifique→Listuguj rule-mining corpus. Proposed factoring: page atlas → segmentation (box-set assignment, eval vs gold, dual-model divergence gate — Clark's fold gate doesn't exist for handwriting) → 5-stage per-entry recipe (+judge) → pdm import-mirror dictionary (Clark landing pattern) → page-editor review layer. Suggested first step: 10-page segmentation pilot (the go/no-go).

SEGMENTATION PILOT + TUNING LOOP DONE (2026-07-28, mikmaq/pdm-segment.ts, CLI pdm-segment-pilot/-sweep, report pdm/segment-pilot.md): method = textract words → numbered RUNS (tunable clustering) → annotated overlay → model assigns run numbers to entries → scored vs hand groups (pairwise F1 + recovered-group rate) + CEILING instrument (majority-gold assignment of runs — zero-LLM decomposition of clustering-vs-model error). MEASURED CURVE: coarse clustering ceiling 74/models ~56; finest ceiling 98/models COLLAPSE (40-57, 150-230 units exceed visual assignment capacity, schema breakdowns); middle (yf .45/gap 60/word-units <180 words) ceiling ~90/opus 62 best. Divergence 1-2% on normal pages = SAME systematic errors both models → dual-model gate weak for segmentation. Textract recall is its own limit on faint pages. VERDICT: ~62-71 F1 not yet draft grade; NEXT = v3 task reformulation: mark ENTRY-START runs (per-run binary, Clark analog), spans built mechanically, paradigm columns attached by geometry; half-page renders for label legibility. Sweep re-tunes free.

V3 START-MARKING DONE (pdm/segment-pilot-v3.md): model marks entry-START runs only, spans by mechanical y-bands. 10/10 pages robust (no schema breakdowns); sonnet 58.8/opus 60.0 mean; START-ORACLE only 58.4 — models BEAT the oracle on pages (sonnet 100 on p324, 82 on p67) because HAND GOLD INTERLEAVES (each paradigm item its own group inside another entry's band — y-bands can't express it; hand granularity = per-word-sense refs, NOT visual entries). OPEN QUESTION FOR DZ (blocks v4): target granularity = visual entries (merge interleaved gold for eval; split families later in interpretation — current numbers substantially higher under this metric) vs hand granularity (needs vertical-overlap column attachment + boundary-refinement pass).

PRODUCT VISION (dz 2026-07-28, VERBATIM INTENT — drives all PDM design): rand/clark = evidence/support material; PACIFIQUE = THE SOURCE OF WORDS (current phase). Target flow: the auto-tagged pdm dictionary is good enough (+ bound onto clark/rand/MMO) that staff BROWSE it to select PRIORITY lexemes (not page-at-a-time) → click IMPORT-TO-MMO → creates an MMO entry with the bounding boxes COPIED to MMO (thereafter edited as MMO-OWNED data) + collected evidence links (clark/rand) copied over + Listuguj transliteration AND English translation done AT SELECTION TIME (so they understand what they're importing as they do it). After copy they fix boxes if needed; ON REQUEST the system re-derives the reading from the edited MMO boxes. Page-at-a-time remains possible (import all boxes on a page). WHY edit-after-copy: correcting the auto version in place cascades (stealing a box from another entry); one-entry-at-a-time = the unit of decision = "an assistant suggesting a grouping you can import". DECISION (a): segmentation targets VISUAL entries (hand groups are per-word OVERLAPPING evidence sets, not a partition — merged connected components = visual-entry gold); per-word splitting + evidence box-sets derive at INTERPRETATION.

V4 DONE (merged visual-entry gold; reports pdm/segment-pilot-v4-{starts,group}.md, $0 cached): GROUP task opus 68.3 F1 / 46% entries exactly recovered (ceiling 96-100; 1/10 schema fail; sonnet erratic) vs STARTS task 62.9/41 (fully robust, y-band-capped — models beat the band oracle). OPUS is the segmentation model (Clark's reverse). PRODUCTION SHAPE: run both tasks, grouping primary + starts fallback, confidence-ordered review. VERDICT: clears the assistant-draft bar under the edit-after-copy flow (~half of entries exact, rest one-box edits). NEXT BINDING QUESTION: reading quality (interpretation stage: block → per-word facts + evidence box-sets, five-rung gold; transliteration tuning via 1,536-pair corpus mining).

PM-LI TRANSLITERATION PAIR DERIVED (2026-07-28, mikmaq/pacifique-transliterate.ts, corpus pdmRefCorpus 1,260 rtr↔rtl headword pairs): rules-v3 measured 6%→26.6 train/30.3 HOLDOUT exact, top-4 candidates 34.0 holdout (no overfit). Key derived phonology: macron=length apostrophe, tj→j, uvularity g→q after a/o (contexts measured), o=/u/ except adjacent to q, glide splits (gwa/gui), tem/gem/gel/nem elisions; the residual = Pacifique doesn't WRITE length → pmLiPattern candidates (plain-first rank). HONEST NEGATIVE: injecting the rules draft into the transcribe-eval transliterate prompt (v3) did NOT lift the stage — 58.8% vs 60.3 baseline (flat; judged equivalence 66 unchanged). Read: the strict-sim ceiling is entangled with the gold's NORMALIZATION decisions (rtl regularizes inflection) which letter rules/drafts can't reach; the pair's real value = candidates/blocking for pdm→MMO joins + the deterministic draft in the selection UI + orthoMatch, same as the watson pairs. Eval hardening: llmRetry + per-stage failure isolation in transcribe-eval (1 ref persistently malformed = finding not crash).
