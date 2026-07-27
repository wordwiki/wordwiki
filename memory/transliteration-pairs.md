---
name: transliteration-pairs
description: "general TransliterationPair mechanism + registry, harness callable core, ambiguity PATTERN form, watson-sf PHONETIC HUB architecture; wsf-wli rules 86% holdout day one"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Transliteration-pair factoring (dz-approved, built 2026-07-27): the mature li→sf machinery generalized into per-pair users, feeding dz's vision of deriving ortho mappings from the rand corpus (and re-deriving the SUSPECT mm-li→mm-sf, currently based on only ~358 MMO pairs).

- `wordwiki/transliterate-pair.ts` — `TransliterationPairSpec` {id, lanes, version, transliterate, candidates (RANKED = the ambiguity surface), candidateTransliterators, extractCorpus} + registry; `CorpusPair` {source,target,tag,pos?} with legacy {li,sf} normalization.
- `mikmaq/transliterate-pairs.ts` (registered via [[mikmaq-package]] register.ts): 'li-sf' wraps the mature engine; 'wsf-wli' + 'wli-mmli' are identity rules-v0 with SQL corpus extractors (rand both-lane spellings; landed mcp counterpart facts, confidence-tagged).
- Harness (`transliterate-harness.ts`): core is exported `runHarness(pairsJson, candidates, {split, clusterN, baseline})` — dz: STANDALONE preferred so a SAAS future can call it as a function on db JSON; CLI entry is a binary edge (dynamic-imports mikmaq/register.ts); `--pair ID`; `--calibrate` stays li-sf-only.
- CLI: `export-transliteration-pairs [path] [--pair=ID]` (registry extractor path; default = legacy li-sf junk-filtered export). Corpora/baselines are gitignored scratch (`/transliteration-pairs*.json`, `/*-baseline.json`).
- Ambiguity PATTERN form (`transliterate-pattern.ts`, dz design discussion): strict regex SUBSET — literals + `[oe]` + `(s|ts|)`, alternative ORDER = RANK; parse/format/enumerate(k, rank-ordered)/patternToRegExp (the only lossy direction: drops rank)/candidatesToPattern. Linguist-readable (phonemic variant notation); reserved chars loose in data are loud parse errors.

PHONETIC HUB architecture (dz's Rand note, doc Part 3): Clarke's intro claims Rand's spelling was phonetically complete → the Rand-derived lanes are the info-rich end. watson-sf = the DE-FACTO hub (no abstract phoneme inventory); compositions route through it; rules written over phonological CLASSES (language.ts VOWELS/SONORANTS/OBSTRUENTS); ambiguity = measured underspecification (branch probabilities from corpus); post-convergence residue = worklists (rand↔watson noise; watson↔mm DIALECT differences — dz's regional-dialect confound made visible).

Corpora (dev db) + derived rules (mikmaq/watson-transliterate.ts): wsf-wli 4,565 pairs, rules-v2 86.2% train/86.0% holdout (identity 19.3%; beats mature li-sf 75.9% day one — single-author corpus is cleaner); branch points ' vs ` schwa + word-final aqn (Watson's 70:76 coin flip) are ranked pattern branches, top-2 = 88.0% holdout. wli-mmli 2,131 pairs (1,409 high/722 medium), rules-v1 57.2% holdout, HIGH subset 81%, +43/−0 regressions; residue needs info the lane lacks (length ', g-vs-q) → hub composition, not letter rules. Loop cost ~10s, zero LLM. EVERY rule justified by train-fold counts (scratch measurement scripts), holdout untouched.

HUB MEASURED: third pair 'wsf-mmli' (637 counterpart pairs — only ~30% of linked rand entries carry watson-sf), transliterate = LITERAL composition wliToMmli(wsfToWli(w)), zero new rules → 73.8/70.7% train/holdout, HIGH subset 88/87% — beats the direct wli route's 81% (caveat: different entry subsets, strong signal not controlled A/B). Rand's phonetic completeness cashed as accuracy. Consequence: propose mm-li spellings from the sf lane when present, li spoke otherwise; more watson-sf transcription directly buys accuracy. Found 4 mm-li targets with CURLY apostrophes (data-cleanup worklist). NOTE: an early Write left NUL bytes in transliterate-pairs.ts making grep/Edit silently fail on it — if a file behaves 'binary', check for \x00.

COMPOSITION AUDIT DONE (report watson/mmsf-composition-audit.md): wli-wsf inverse spoke (apostrophe CLASS-split: C-side=schwa ɨ, V-side=length; 86.1% holdout) + via-watson audit candidate on li-sf (phonetics-only = g→k + -ei→-ey; team conventions measured: aqan kept 100:0, nn kept, schwa ') + wsf-mmsf bridge. Verdict: v4 75.5% vs phonetics-only 53.1% — the 22-pt gap = TEAM CONVENTION inventory (cluster-aspiration ' ×323, pos -ei ×29); 62 v4-overreach pairs (rule-bug worklist); 194 JOINT MISSES = the mm-sf consistency worklist; triples: 1 strong suspect (dict 7668 'angua'latl' = untransliterated li copy). Direct mapping ≈ 2/3 convention, not wrong; validate rule changes against overreach+joint-miss lists.

NEXT: dialect-residue report, curly-apostrophe cleanup, walk the 194 joint misses + 62 overreaches with reviewers.
