# PDM LLM transcription — findings, how to run, and where this is going

Status 2026-07-16: exploratory phase 1 COMPLETE and promising.  This doc is
the handoff artifact (dz + a future Claude session): what was built, what
was measured, what was learned, how to run it, and the larger project it
is hopefully the seed of.  Paused here to clean up other WIP; the work
resumes from this file.

## Why this exists — THE VISION (dz)

The Pacifique dictionary (~700 manuscript pages) is currently transcribed
PAGE-AT-A-TIME because that is the only manageable process: cherry-picking
words requires exhausting attention, since the elders are not all fluent
in French and Pacifique's orthography is unfamiliar.  The REAL RISK of the
current approach: the project runs out of resources having completely
transcribed 200 of 700 pages — a worse outcome than having cherry-picked
the most relevant 2/7ths of the whole dictionary.

The quality seen in this prototype (with tuning rounds still to come)
makes a more ambitious goal look feasible: a FULLY AUTOMATED
TRANSLITERATION of the entire dictionary, used
  a) as the basis for CHERRY-PICKING - prioritize words for inclusion in
     the modern dictionary from a readable draft of everything;
  b) to make the subsequent human construction MUCH FASTER (start from a
     draft, not a blank page).
The batch version implies more LLM work than this prototype: page-at-a-time
COMPOSITION (finding/segmenting the entry boxes themselves, not just
reading pre-drawn groups).  It also unlocks UI aids for manuscript work —
e.g. hover a French run of text to see its proposed English translation.

## What was built (phase 1: CLI eval, READ-ONLY — never writes the dict)

- `wordwiki/transcribe.ts` + `./wordwiki.sh transcribe-eval`.  Reuses
  liminal's scan→extract LAYER 1 (`liminal/extract.ts` extractStage/
  extractAll + `liminal/llm.ts` loadLlm) — NOT rabid's job/queue/UI layer.
- **Masked group crops** (`groupCropPath`): each bounding BOX region of the
  group pasted onto a white canvas at its position (union rect + 12px crop
  margin; 16px per-box keep-margin).  The model sees exactly the group's
  ink — dz's original spec.  Content-addressed in the derived store, so the
  crop stands in for the pixels in every downstream cache key.
- **3-stage recipe** mirroring document_reference's manual fields:
  1. `transcribe` — letter-by-letter, abbreviations kept;
  2. `expand` — French abbreviations expanded, elided Mi'gmaq stems
     restored (Pacifique writes word families with the repeated stem
     elided: "aptepogoei, goet" ⇒ second word is "aptepogoet");
  3. `transliterate` — French→English + Pacifique→Listuguj orthography.
  Stages 1–2 output LANGUAGE-TAGGED RUNS ({text, lang: mm|fr|cit} in the
  JSON SCHEMA, not in-band markers — dz's early-language-marking idea; cit
  runs = citations like "(Pi. Met.)", copied verbatim).  Stage 3 is flat.
- **Ambiguity + confidence** (both carried over from the LI→SF
  transliteration work): the model writes `[a|b]` (or `⁇` for illegible)
  instead of guessing — scored as the BEST alternative, so honesty never
  loses to a lucky pick; each stage returns a global 0–100 confidence.
- **The JUDGE stage**: per scored step, a fourth cached call audits
  researcher-vs-LLM, consulting the scan, and classifies EVERY difference:
  punctuation / valid-alternative / llm-error / researcher-error /
  unclear, plus an equivalence-in-substance 0–100.  Framing: a
  classification audit, not a self-grade; the strict string score stays as
  the incorruptible baseline; the page labels judge output "pre-structured
  review questions, not verdicts".
- **Scoring**: strict char similarity (1 − lev/maxlen, NFC+whitespace
  normalized); LENIENT (punctuation stripped, case-folded, apostrophe
  codepoints unified and kept MID-WORD ONLY — boundary apostrophes are
  punctuation, mid-word they are Listuguj orthography); both are lower
  bounds (synonyms + researcher errors still score as differences — hence
  the judge).
- **The review page**: the batch writes `resources/transcribe-eval.json`
  (data) + `resources/transcribe-eval.html` (a pure render of it) into the
  served resources dir → `/resources/transcribe-eval.html`, linked from
  the Reports menu ("PDM LLM Transcription Eval").  Fully self-contained
  (inline styles incl. the lexeme change-approval `.lm-diff-*` diff
  family; images as data URIs) so the same file can be MAILED to the
  research group or archived.  Shows: the rules (per-stage prompts,
  versioned, collapsible), summary + confidence-calibration table +
  difference-kind census, then per-entry: the masked crop (exactly what
  the model saw), researcher vs LLM with diff coloring, judge rows with
  kind chips.
- **Cost accounting**: an `onUsage` hook added through liminal
  llm.ts/extract.ts tallies ACTUAL API tokens (cache hits fire nothing);
  every run prints its spend.

## Findings (the empirical narrative — each step measured)

- **Prompt v1 → v2** (language-tagged runs + corpus-attested Pacifique→
  Listuguj correspondences mined from the gold pairs): transliterate
  54.8% → 71.4% on the first 3-ref sample.  The tagging idea works.
- **Union-crop bleed was real and the eval caught it**: boxes are runs of
  text; interleaved/arrow-relocated groups leave the union rect mostly
  FOREIGN text.  Worst ref had 16% box coverage — the model read the
  NEIGHBORS' text at 35% sim, confidence 72 (the overconfident-wrong
  quadrant).  MASKING fixed it: that ref → 94% at c80.
- **Masking needed two companions**: a 16px per-box margin (6px clipped
  descenders — the eval literally lost a 'j'), and mask-aware prompts
  ("white gaps are masking, not missing text; never return empty while
  handwriting is visible") — without which the model returned empty at
  confidence 0 on sparse fragment layouts.
- **ImageMagick gotcha**: this build's CopyOpacity mask route silently
  yields an all-white image — the paste-boxes-onto-white approach is used
  instead (also alpha-free and easier to reason about).
- **Current numbers** (25-ref deterministic sample, 24 scored):
  | step | strict | lenient | judged equivalence | mean confidence |
  |---|---|---|---|---|
  | transcribe | 79.8% | 81.6% | 77 | 51 |
  | expand (n=7) | 77.8% | 78.2% | 66 | 60 |
  | transliterate | 60.3% | 61.6% | 66 | 63 |
- **The judge census says the raw scores understate quality** (dz's
  observation, quantified): on the 10-ref v3 run, of 49 differences only
  15 were actual LLM errors; 16 punctuation-only, 9 valid alternatives,
  5 RESEARCHER errors, 4 unclear.  The judge caught dz's exact
  researcher-omission case verbatim ("clearly visible in the image and
  was omitted by version A").  THE GOLD IS IMPERFECT — eval design must
  never assume the researcher row is truth.
- **Confidence is usefully calibrated**: the worst transcriptions
  self-reported c18–c42 while the strong ones sat c55–c80.  This is the
  property that would let a production flow auto-accept high-confidence
  readings and route only the low tail to humans.
- **Transliterate is the weak link** (60% vs transcribe's 80%).  Next
  lever: mine correspondences systematically from the ~1,520 gold pairs
  (the LI→SF `transliterate.ts` rules program is the model: corpus-derived
  rules + oracle harness + lexical exceptions + held-out folds); possibly
  a deterministic rules pass before/alongside the LLM stage.
- **Data findings from running the eval**: bounding group 218155 is
  referenced by a word but has ZERO boxes (eval skips + logs it); the
  gold's `expanded` field is sparse (7 of first 24 refs).

## How to run the batch

```
./wordwiki.sh transcribe-eval [--book=PDM] [--sample=10] [--offset=0]
                              [--report=transcribe-eval.md]
                              [--json=resources/transcribe-eval.json]
                              [--html=resources/transcribe-eval.html]
```
- READ-ONLY on the db; runs beside the live server (stop-dance exempt).
- Needs `wordwiki-anthropic-credential.json` — lives at the repo root
  (gitignored), SYMLINKED into `mmo/` (loadLlm reads the run dir = the
  instance dir).  Format: `{apiKey, defaultModel}`; currently
  claude-opus-4-8.
- **The cache is the budget mechanism**: every stage is memoised in the
  derived store keyed `[cropPath, model, promptVersion, imageBox, stage,
  priorInputHash]`.  Re-running an unchanged batch = 0 API calls.  The
  sample is DETERMINISTIC (ref-id order), so growing `--sample` reuses the
  entire prefix.  A long first run that dies mid-way resumes nearly free —
  just re-run the same command.
- **Prompt iteration loop**: edit a prompt in `wordwiki/transcribe.ts`,
  bump ITS `PROMPT_VERSION_*` const (transcribe/expand/transliterate/
  judge), re-run — only that stage and downstream re-derive.
- **Costs**: full recipe ≈ 5k tokens/ref; judge ≈ 2k per scored step.
  The whole exploratory phase (≈25 refs × several prompt versions) ran
  ≈ 400k tokens total.  The run prints exact usage every time.
- Outputs: console scores; side-by-side markdown; `resources/…json` +
  `…html` (the review page — also at /resources/transcribe-eval.html via
  Reports → PDM LLM Transcription Eval).

## The road to the ambitious version (not started)

1. **Tuning rounds** (cheap, now): dz's rules review of the current page →
   prompt v4+; research-group pass over the same page (each judged
   difference is a pre-structured question for them); systematic
   correspondence mining from the gold pairs for the transliterate stage.
2. **Whole-page pipeline** (new LLM work): today the input is hand-drawn
   bounding groups; the batch version must COMPOSE pages itself — segment
   each page into entries (boxes/groups), then run the recipe per entry.
   The existing Text layer + tiling machinery are raw material; expect an
   LLM segmentation stage (page image → entry regions) with its own eval
   against the hand-drawn groups on transcribed pages (~200 pages of gold
   segmentation!).
3. **Scale + cost**: ~700 pages × O(15) entries ≈ 10k entries ≈ 50M+
   tokens at current recipe cost, before segmentation.  Levers: cheaper
   models for the easy stages (grade Sonnet/Haiku against the Opus
   baseline using this same eval), Anthropic's Batch API (50% price),
   confidence-gated escalation (cheap model first, Opus only when
   confidence is low).  The eval harness built here is exactly the tool
   for making those calls with evidence.
4. **Landing results**: write LLM output into `document_reference` fields
   as clearly-marked unapproved drafts (the auto-transliterate precedent:
   version stamped in change_arg, never re-propose rejected) — gated on
   the quality bar; the assertion model keeps human corrections as
   harvestable regression data, closing the tuning loop.
5. **Cherry-picking**: with a full draft transliteration, a report of the
   whole dictionary (searchable in English!) from which elders/staff pick
   the words worth full treatment — the project's actual goal.
6. **UI aids**: hover-translate for French runs (the language-tagged runs
   make this nearly free), proposed-reading overlays in the page editor,
   confidence-colored review queues.

## Pointers

- Code: `wordwiki/transcribe.ts` (everything), `wordwiki/transcribe_test.ts`
  (scoring unit tests), CLI case in `wordwiki/cli.ts`, liminal usage hook
  in `liminal/llm.ts` + `liminal/extract.ts`.
- Review page data flow: transcribeEval → EvalData → renderEvalHtml
  (pure; regenerating presentation needs no API calls if nothing changed).
- Memory: `memory/pdm-llm-transcription.md`.
- Related: `wordwiki/transliterate.ts` (the LI→SF rules program — the
  method template for Pacifique→LI rules), `page-editor-change.md`
  (the page-primary editor workflow this feeds).
