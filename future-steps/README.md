# Future-steps handoff (written 2026-08-05, end of a long session)

COMMITTED orientation notes — this dir is a shared coordination channel:
dz may hand a thread to a fresh claude after /compact, AND peer-container
claudes may pick up threads and communicate through git (so these files are
TRACKED, not scratch).  Each file is ORIENTATION + FIRST MOVE +
what-not-to-relitigate; the DEPTH lives in the committed design docs + memory
(pointed to below).

If you (a claude) TAKE a thread, say so here — add a `## STATUS` line to that
thread's file (who/what-container, date, what you're doing) and commit it,
so peers don't collide.  Update it as you progress; when a thread is done or
superseded, note that too.

## How to use (for the future claude)
Read your one thread file, then the "read first" docs it names, then act on
its FIRST MOVE.  The decisions in these files are settled — don't reopen
them; build on them.

## The threads
1. `1-pm-li-taxonomy-reading.md` — unpoison the pm-li measurement + let the
   language team give rule-level feedback.  Partly expert-gated, but has
   real no-expert Claude work (corpus cleaning, verdict-capture UI).
2. `2-match-permissiveness.md` — build the highest-value phonology lever:
   matching that treats voicing/uvular/labial variants as equivalent.
   The phonology reading said this beats a generation scorer.  Cheap, measurable.
3. `3-pdm-import-to-mmo-button.md` — the PDM flow centerpiece: browse →
   select → one-click import a Pacifique entry into MMO (boxes + evidence +
   transliteration/translation copied).  Gated on the pdm similarity joins.
4. `4-batch-derivation-build.md` — implement the batch-AI-through-the-store
   design (50% cheaper bulk runs).  Design is DONE; this is the build.

## The durable docs (committed — the real reference, read as needed)
- wordwiki/transliteration-workbench.md — the whole translit/match push
  (§6b hardening DONE, §8 branch-engine design, §9 matching-as-driver, §10
  taxonomy).
- wordwiki/phonology-reference.md — the Mi'kmaq phonology rules + §4
  THREE-LEVER verdict (match-permissiveness > morphology > generation-scoring).
- wordwiki/orthography-sources.md — all the orthography sources.
- wordwiki/pdm-import-mechanism.md — THE pdm state doc (read first for #3).
- liminal/batch-derivation-design.md — the batch spec (read first for #4).
- memory/ (loaded each session): [[rebuild-pipeline]], [[batch-derivation]],
  [[transliteration-pairs]], [[pdm-llm-transcription]], [[similarity-engine]],
  [[deferred-llm-runs]], [[machine-contributors]].

## Cross-cutting gotchas (true for ALL threads)
- Ops: server runs `(nohup ../wordwiki.sh > ../log 2>&1 &)` from mmo/; any
  CLI run auto-stops it; NEVER pkill.  8GB heap in wordwiki.sh.  `wordwiki.sh`
  runs from mmo/, so relative paths land in mmo/ (use ../ or absolute) —
  this bit us (the I3 provenance stale-corpus catch).
- Tests: `deno test --allow-all wordwiki/ mikmaq/ liminal/`; baseline ~697
  pass + 1 KNOWN parseSchemeMd failure (missing external file).  Login as
  user 'test' (user-passwords.json is the only copy, gitignored).
- Pipeline: 4 phases — pullLiveSnapshot / importWordWikiV1Db (migrate) /
  rebuildDerived (derive) / updateStaging (push); rebuildAll.sh orchestrates.
  See [[rebuild-pipeline]].
- DON'T run the deferred LLM jobs (full rand binder, full-band Sonnet judge,
  full-book PDM import) without dz's explicit go + the cost quote —
  wordwiki/deferred-llm-runs.md gates them.  Barely-funded project.
- dz lands via `pj land` (his call, always run when asked).  Commit explicit
  files.  His emacs may leave a working-tree edit — don't revert deliberate
  edits, don't commit buffer noise.
