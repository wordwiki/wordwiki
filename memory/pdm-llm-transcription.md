---
name: pdm-llm-transcription
description: "LLM (Opus 4.8) transcription of PDM bounding groups: 3-stage cached recipe + eval CLI vs hand answers (transcribe-eval); phase 1 BUILT 2026-07-11, prompt iteration ongoing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

BUILT 2026-07-11 (wordwiki/transcribe.ts + `./wordwiki.sh
transcribe-eval`): the page-primary flow's READING step, phase 1 =
CLI eval only (READ-ONLY, never writes the dict; UI/queue later, only
if quality earns it). Reuses liminal's scan->extract LAYER 1
(extract.ts extractStage/extractAll + llm.ts loadLlm('wordwiki')) -
NOT rabid's job/queue layer. Credential:
wordwiki-anthropic-credential.json ({apiKey, defaultModel:
claude-opus-4-8}), gitignored, SYMLINKED INTO mmo/ (loadLlm reads
cwd = the run dir).

- 3-stage recipe mirroring document_reference's manual fields:
  transcribe (letter-by-letter) -> expand (abbreviations, elided
  stems) -> transliterate (fr->en + Pacifique->Listuguj). Stages 1-2
  output LANGUAGE-TAGGED RUNS ({text, lang: mm|fr|cit} in the SCHEMA,
  not in-band - dz's early-language-marking idea; cit = citations
  copied verbatim); stage 3 flat text.
- dz's LI->SF lessons carried over: [a|b] AMBIGUITY markers (scored
  as best alternative - honesty never penalized) + global CONFIDENCE
  0-100 per stage (report shows confidence vs similarity =
  calibration).
- CACHING = the budget mechanism: every stage memoised in the derived
  store keyed [cropPath, model, promptVersion, imageBox, stage,
  priorInputHash]; bump PROMPT_VERSION_* consts to re-run just that
  stage + downstream; re-runs otherwise FREE. onUsage hook added to
  liminal llm.ts/extract.ts tallies ACTUAL API tokens (cache hits
  don't fire it).
- Group images: groupCropPath() = derived ImageMagick crop of the
  box-union (+12px margin) -> content-addressed jpg;
  groupCropImageSource bounds to stage imageBox (shrink-only).
- Gold set: ~1,520 refs w/ hand transcription (PDM the main body);
  goldSample() is DETERMINISTIC (ref-id order) so growing the sample
  reuses the cache.
- Results (3-ref sample): v1 transcribe 81.5% / transliterate 54.8%;
  v2 (tagged runs + corpus-mined correspondences in the prompt)
  transcribe 82.8% / transliterate 71.4%. ~5k tokens/ref for the
  whole recipe. Confidence tracks quality.
- Future: mine more Pacifique->LI correspondences from the gold pairs
  (the transliterate.ts LI->SF rules program is the model:
  corpus-derived rules + oracle harness + lexical exceptions);
  possibly a deterministic rules pass before/instead of stage 3;
  writing results into document_reference as unapproved drafts is a
  LATER phase gated on quality.

Relates to [[wordwiki-transcription-oracle]], [[minimal-ceremony-principle]].
