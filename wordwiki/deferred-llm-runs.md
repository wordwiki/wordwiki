# Deferred LLM batch runs

dz 2026-07-28: two funded LLM batch runs are APPROVED IN PRINCIPLE but
deliberately DEFERRED.  Running them now brings little advantage, and the
projects still in motion (multi-dictionary, transliteration rules, the
rand import itself) can each invalidate the caches these runs would
build - the economics rule says spend once, on a settled corpus.  This
doc is the trigger checklist and the exact commands, so the runs need no
re-derivation when the time comes.

## The runs

### 1. Full referral-band judge (Sonnet)

    ./wordwiki.sh similarity-judge rand dict --model=claude-sonnet-5 \
        --details=../watson/rand-mmo-judged.md

- Scope: the pass-1a referral band ONLY (the CLI default) - at last
  measure 9,854 pairs in 7,781 clusters of 99,651 candidates.
- Cost: **~$50 Sonnet** (measured by the 50-cluster Opus pilot
  2026-07-28: ~1,480 in / ~145 out tokens per cluster; Opus would be
  ~$260).  Sonnet measured 86% agreement with Opus on the judge - the
  approved budget choice (unlike the binder, where Sonnet is REJECTED).
- Expected yield: the pilot found **28/57 same-word (20 high)** - the
  synonym-bridge tier ('regard'↔'think highly of', la prison loans).
  Naive extrapolation ~4,800 same-word pairs waiting, which would more
  than double the landed pairing.
- Already banked: the 50 pilot clusters are cached (Opus); a full run
  pays only for uncached clusters.
- FOLLOW-UP WORK ITEM (before or after the run - the cache keeps):
  `planPairs`/`pairRandMmo` consume RULE verdicts today; merging judged
  same-word verdicts into the landing (and judged 'related' into the
  future '~xref' landing) is a small pairing extension that must exist
  before the judgments turn into facts.

### 2. Full rand image binding (Opus) - DONE 2026-08-07

    ./wordwiki.sh bind-references Rand rand --cited-book='Rand 1888' \
        --printed=81-286 --source-lane=rand --apply --batch

- STATUS: COMPLETE.  Ran pages 81-286 via the batch path (dz go
  2026-08-07); 5-page probe 76-80 first as the live quote.  The store now
  holds **~30,075 '~rand-binder' refs across 279 pages** (was 8,462 on
  1-75).  Everything cached; the migration's --cached-only step reproduces
  it at zero spend.
- ACTUAL SPEND: batch msgbatch_018dJ8kwYn7GRTxaj19x8zfS - 206 requests,
  4.03M in / 0.87M out => **$62.86 batched** (would have been $125.71
  sync).  + probe ~$1.71 + p.95 sync recovery $0.54 = **~$65 total**.
  Matched the ~$65-75 quote.
- Model: Opus (prompt v3).  Sonnet REJECTED for this task (4/20 page
  failures, dropped bindings in the A/B).
- One page (p.95) failed our schema validation on the batch result (model
  returned bindings as a string); recovered with a sync re-run (96/96
  bound).  A per-run worklist (unmatched / low-confidence / unclaimed
  regions) is in the batch's --report for spot-checking.
- If ever extended: the same command over a wider --printed range; fresh
  pages re-quote via a small dry-run.

## What invalidates the caches (why we wait)

Both runs cache on the extract substrate: the key is the STAGE (name,
model, prompt version) + the full INPUT content.  Anything below
invalidates exactly the affected clusters/pages - nothing else:

- **rand import churn** (transform edits, re-import, schema changes):
  changes entry presentations -> judge clusters AND binder page inputs.
- **transliteration rule changes**: change xlit/cskel index keys ->
  change candidate SETS -> change cluster membership and content.
- **similarity rules/limits changes** (new key kinds, df limits,
  verdict rules): change the referral band itself and the evidence
  lines inside clusters.
- **multi-dictionary work**: presentation/schema shape changes.
- **prompt/model bumps** (PROMPT_VERSION_JUDGE, PROMPT_VERSION_BIND,
  model ids): full re-extract of that stage BY DESIGN.

## Trigger checklist (run when ALL hold)

1. rand import stable: transform + schema final, no pending re-import.
2. Similarity index/rules settled: no planned key-kind or verdict-rule
   changes (currently rules v3, keys skel/cskel/cskel1/def/cat).
3. Judge prompt/model frozen (PROMPT_VERSION_JUDGE 1 + sonnet decision
   re-confirmed); binder prompt frozen (v3).
4. The judge->landing pairing extension exists (work item above).
5. Then: judge run (Sonnet) -> review judged report -> land pairs;
   binder re-quote -> full binder run -> review gallery + landing.
