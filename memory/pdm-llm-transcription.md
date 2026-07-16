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
