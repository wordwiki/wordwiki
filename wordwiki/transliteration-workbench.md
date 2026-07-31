# Transliteration workbench — the research/translit/compare/materialize push

Working doc, started 2026-07-29.  Status: PROPOSAL/DESIGN (dz + claude
conversation distillate); nothing built yet.  Companions:
- orthography-sources.md — the source inventory (in-project keys captured
  from the scans + the web research pass).  Read together with this doc.
- transliteration-findings.md — the measured rules work to date (Parts
  1-4; pm-li phonology is Part 4).
- memory/machine-contributors-design.md + wordwiki/machine-contributors-design.md
  — the machine-owned-facts model that materialization lands on.
- mikmaq/transliterate-pairs.ts — the six registered pairs today
  (li-sf, wsf-wli, wli-mmli, wsf-mmli, wli-wsf, pm-li).

## 1. dz's charter (2026-07-29, paraphrased tight)

Pair count is growing (each pair = research phase + materialization
phase).  Before adding more complexity:
1. Make the research/translit/compare/materialize machinery SOLID.
2. Run language-level research on ONE pair (pronunciation, missing
   vowels, dialect ambiguity, prefix/suffix morphology) to learn how much
   language-specific knowledge buys — might not work; measure it.
3. Materialize some auto-spellings: an mm-li speaker should be able to
   read/search watson-rand via a materialized auto-mm-li lane even if
   slightly wrong.  Human editors approve/disapprove/correct → feedback
   to the mechanism.  Not all pairs materialize; some only show in some
   views.  Perhaps a workflow migrates machine spellings to
   human-approved (peer of human-entered).
4. Multi-path: exploit multi-orthography-bound instances; A→B→C and
   A→B→A as knowledge/consistency sources.
5. Hold SAAS usability in mind (not primary).

## 2. Decisions/positions from the design conversation

- **Hardening before new pairs**: (a) one engine face per pair (li-sf
  legacy path fully behind the registry); (b) standard holdout/corpus
  provenance discipline in the harness so pair numbers are comparable;
  (c) composition FIRST-CLASS: a pair declarable as a composition of
  pairs, harness auto-compares direct-vs-composed on a shared oracle +
  A→B→A round-trip audit.  Multi-path is our best measured result
  already (wsf→mmli 88% high via the watson-sf hub, zero new rules).
- **Materialization = machine-contributors, not a new design**: a
  per-purpose machineSync landing; machine-owned rows freeze on first
  human touch (approve/correct = human fact, machine loses write).
  Corrections ARE corpus pairs — the feedback loop is a rule-derivation
  data pump.  **Search-first materialization**: index the auto lane
  (and top-k candidates via candidatePattern) unconditionally — the
  usability win with zero display noise; display is a separate per-view
  opt-in decision.
- **Language-level experiment: error taxonomy FIRST, method second.**
  Evidence cuts both ways (pm-li rules-in-prompt was flat 58.8 vs 60.3;
  but the normalization-gap finding says a big slice of pm-li error is
  morphological, unreachable by letter transforms).  Plan: on the best
  letter-rules holdout output, hand-classify misses into (a) phonology-
  recoverable (length, o/u, dialect), (b) morphological normalization
  (citation-form mapping, prefix/suffix), (c) irreducible.  Spend on the
  biggest bucket.
- **Pair choice: pm-li** — most headroom (30% vs wsf-wli 86%), phenomena
  match the proposed knowledge exactly, and improvement feeds the PDM
  import directly (rtl stage is the weakest link).  PREREQUISITE:
  hand-clean a ~100-pair holdout subset where gold rtl is verified
  surface-faithful (currently can't distinguish "rules wrong" from
  "gold normalized" — poisoned the v3 measurement).
- **Don't design the full approval-workflow UI up front** — the change
  approver + freeze rule cover most of it; pilot materialization on one
  pair and let real friction specify the workflow.

## 3. Explain plan (dz feature request)

Two distinct explains:
- **Transliteration explain** = the derivation: per output segment
  (matched source span, rule that fired, alternatives considered).
  `{trace: true}` mode on the pair mechanism's transliterate/candidates
  face.  Traces are RECOMPUTED (pure versioned functions), never stored.
  Rule identity CONTENT-KEYED (hash of the rule), not array index, so
  verdicts survive rule-set evolution.
- **Comparison explain** = match justification, layered like the
  3-pass similarity engine: blocking explain (which key collapsed them +
  each side's key derivation), residual explain (char alignment: what
  normalization collapsed, what still differs), judge explain (LLM
  verdict rationale — ADD structured rationale + fields-matched to the
  judge schema; display aid only, never feeds rule derivation).

**The review workflow** (dz's proposal): show editors transforms and
comparisons in strata — high-conf, low-conf, failed, random, plus
**disagreement** (direct vs hub-composed, or top-1 vs candidate set —
highest info/judgment; multi-path machinery computes it already).
KEY MECHANISM: editors give INSTANCE-level verdicts (right / wrong /
corrected-to, optional "this step is the problem" tap) with rules
visible; rule-level feedback is DERIVED by joining verdicts against
traces → per-rule precision, rules ranked by error contribution.  No
human-facing rule editor (ceremony; SAAS data-only line).  Verdicts land
as machineFeedback facts pinning (pair, engine version, rule ids);
corrections flow to the pair corpus as gold.  UI = design-language
document (transcription-eval-report / change-feed patterns).  Build
transliteration explain first; comparison explain follows once judge
rationale accumulates.

## 4. Rules as data (dz: explain forces human-legible rules)

The trace requirement is the forcing function: every step must be
attributable to a named displayable rule → rules become declarative
data (pattern, context, output, examples, notes); the .ts engine becomes
an interpreter.  Three consumers, one source of truth: engine, review-UI
traces, and the PUBLISHED artifact — a generated design-language page
per pair: ordered rule table, corpus examples, measured fire-counts and
per-rule precision.  Publishing fills a real field gap (the only
published Rand→modern mappings are community wiki tables; Fidelholtz
1976 inaccessible; Metallic second-hand; mikmaqonline cited as the
pm→li reference with no published chart).  CC-share-alike covers it;
slots into the archival publish model.
- Escape hatches: small registry of NAMED built-ins (trace-displayable);
  don't make the DSL Turing-complete.  Legibility test: the rendered
  page needs no prose apologies.  Migration benchmark: li-sf rules-v4.
- **new Function (dz)**: compiling OUR rule-data to JS at load = safe +
  fast (tenant authored data, compiler emits the only code); emit fast
  and tracing variants from the same table so explain can't drift.
  Tenant-supplied JS is NOT restricted by new Function (globalThis =
  whole Deno permission surface): hosted custom logic would need a real
  boundary (QuickJS / zero-permission worker).  Our instance: repo
  built-ins only.  Compile-for-speed only when measured (corpus scale is
  small; memoized).

## 5. Alternate forms in MMO (dz: "how are alternate-forms constructed")

Schema: alternate_grammatical_form ('alt': grammatical_form code attr1,
gloss attr2) with per-lane alternate_form_text ('alx') nested — same
lane structure as headword spellings.  6,896 of 8,968 MMO entries carry
them; median 3; codes are the GrammaticalFormDescriptions soft vocab
(entry-schema.ts) + newer parenthesized subject(object) forms (3p(0p)).

The editors' SAMPLED-PARADIGM conventions (not full paradigms):
- AI verbs (cite 3sg): 1 / 1d / 1p  — agase'wit → agase'wi /
  agase'wieg / agase'wultieg  (~6,000 of ~15,000 alt cells).
- TA verbs (cite 3-3'): 1-3 / 1-2 / 3-1 — agase'wa'latl →
  agase'wa'l'g / agase'wa'lul / agase'wa'lit.
- TI verbs: 1-3i / 1p-3i — agase'wa'toq → agase'wa'tu / agase'wa'tueg.
- Nouns: p, occasionally loc, 4n — apaqt → apagtug (loc);
  agoqomaw → pl agoqomaq.

Language-level gold in the construction (matches wiki.migmaq.org rules):
- agoqomaw + -g → agoqomaQ (w+velar fuses to uvular).
- apaqt loc: mm-li apaGtug vs mm-sf apaQtuk — velar/uvular alternation
  surfaces DIFFERENTLY per lane in the same cell.
- agase'wa'l'g (li) vs akase'wa'lÎk (sf) — the "not always written"
  schwa appears as ' in one lane, î in the other, mid-paradigm.

Consequences:
1. **alx is an untapped aligned corpus BIGGER than headwords**: 712 alt
   cells with both li+sf texts vs 358 both-lane headwords — and
   inflected forms exercise suffix-region correspondences headwords
   never reach.  Corpus extractors should pick these up.
2. Alternate-form construction is a GENERATOR problem; prior art:
   mikmawconjugator.com (open-source Go conjugator + 6-orthography
   OrthoConverter, github.com/wilmil123/conjugator) — mine both rule
   sets.
3. Natural landing shape for PDM paradigm-table entries at
   import-to-MMO: construct real alt cells (code + gloss + per-lane
   texts) per the editors' own convention, instead of flattening to
   separate entries.  Conversely a generator validated on the 6,896
   hand examples = a measured morphology engine.

## 6. Access notes (anti-bot walls; dz offers manual fetch / puppeteer bridge)

Blocked, ranked: (1) Hewson & Francis 1990 — archive.org borrowable
(human login) or buy CBU 2016; highest value.  (2) HathiTrust all-403 —
prize is the 1853 Micmac Matthew (Pitman phonotype = Rand alphabet #2's
only exemplar); try session puppeteer MCP first.  (3) BAnQ item pages
(direct collections PDF worked): check items 2561563 (Études
historiques) and 3216687/8 (Pacifique ms dictionary vols).  (4) Cyr on
academia.edu; Fidelholtz 1976 (probably genuinely undigitized — ILL).

## 6b. Hardening phase — IN PROGRESS (started 2026-07-29)

Grounding read done: the harness (transliterate-harness.ts) already has
the deterministic hash-fold holdout split, error clustering, baseline
diff, and a clean runHarness() core callable on JSON.  So hardening is
gap-closing, not a rebuild.  Increments, in build order:

- **[DONE 2026-07-29] I1 — first-class composition.**  Built:
  `composition?: string[]` on TransliterationPairSpec;
  composedTransliterator(ids) (lazy lane-abutment check, throws on gap /
  unknown id; pos passed to first step only), roundTripTransliterator(id)
  (looks up the inverse by lane; undefined if absent), and
  validateCompositions() (endpoint + abutment check, called at the binary
  edge).  Harness: a composition pair is scored direct-vs-composed on one
  oracle by default; new `--roundtrip` runs the A->B->A consistency audit
  (roundTripAudit(), no target column).  wsf-mmli declares
  ['wsf-wli','wli-mmli'].  Tests: wordwiki/transliterate-pair_test.ts
  (chaining, gap/endpoint throws, round trip) — 4 pass; harness group 16
  pass; all typecheck.
  MEASURED VALIDATION: wsf-mmli direct 99/140 (70.7%) holdout ==
  composed wsf-wli->wli-mmli 99/140 (70.7%) EXACTLY — the declarative
  chain reproduces the hand-written transliterateWsfToMmli (mechanism
  self-check).  Round trip on wsf-wli (inverse wli-wsf registered):
  837/899 (93.1%) stable; the 62 lossy cases are exactly the aqn<->aqan
  echo vowel (elukaqnatk->elukaqanatk) and initial-cluster u-prothesis
  (wtikmatimkewey->uktikmatimkewey) — a real worklist for FREE, no gold.
  NEXT within I1 (optional): once composed==direct is trusted, simplify
  watson-transliterate.ts's hand-chained transliterateWsfToMmli to
  `composedTransliterator([...])` (or leave as the readable reference).
- **[DONE 2026-07-29] I2 — one engine face per pair (harness).**  The
  harness is now pair-AGNOSTIC: zero li-sf engine imports.  Folded:
  (a) default oracle path = `spec.corpusPath` field (li-sf keeps the bare
  `transliteration-pairs.json`); no more `id==='li-sf'` path branch.
  (b) --calibrate = `spec.calibrate?(pairs)` hook; the ~110-line li-sf
  calibrate() MOVED to wordwiki/transliterate-calibrate.ts (imports
  splitPairs from the harness — one-way, no cycle), registered as the
  li-sf pair's hook.  Harness just calls the hook or errors if a pair has
  none.  Verified behavior-preserving: --calibrate through the hook writes
  a table identical to committed except the version DATE stamp (same
  rules-v4/1233pairs; top-1 75.5%, top-5 84.4%); li-sf default-path run
  scores the known 75.5% holdout.  30 transliterate tests pass; all
  typecheck.
  DEFERRED (I2b, separable — changes export behavior): the cli.ts
  export-transliteration-pairs path still has an li-sf special (the
  pairJunkReason filter + exclusion-naming runs ONLY on the no-`--pair`
  branch; li-sf's extractCorpus returns UNFILTERED).  Converging them
  (move the junk filter into li-sf's extractCorpus so `--pair=li-sf` ==
  default) is a real output change → its own increment with its own
  verification, not folded silently here.
- **[DONE 2026-07-31] I3 — standard provenance.**  Every runHarness()
  result carries a RunProvenance {pairId, engineVersion, corpusPath,
  corpusFingerprint, totalN, trainN, holdoutN, split}; each run's report
  leads with a `[provenance]` line.  corpusFingerprint() = FNV-1a over the
  SORTED source\ttarget\ttag rows (order-independent 8-hex); the anchor
  that makes a quoted score reproducible.  A composition pair shows the
  SAME fingerprint across its direct+composed candidates (same snapshot).
  main() passes meta from the spec; the --roundtrip path stamps too.
  Tests: fingerprint stability/sensitivity + fold-size + header (2 new; 8
  pass); typecheck clean.
  IT IMMEDIATELY EARNED ITS KEEP: the provenance line exposed that my I1
  export (via ./wordwiki.sh, cwd=mmo/) wrote the 793-pair corpus to
  mmo/, while the harness had been reading a STALE 637-pair repo-root file
  from 07-27 - a silent corpus-identity swap.  The I1 direct==composed
  conclusion still holds (structural identity, corpus-independent:
  confirmed 101/177==101/177 on the 793 corpus too), but the SCORE differs
  wildly by snapshot (wsf-mmli hub 70.7% on the 637 corpus vs 57.1% on the
  793 corpus) - exactly why a bare percentage needs a fingerprint.
  OPS NOTE captured: ./wordwiki.sh runs from mmo/, so export paths land in
  mmo/ unless absolute - the harness reads repo-root by default; keep
  oracle files in one place or pass absolute paths.
- **[DONE 2026-07-31] I4 — explain-plan trace + the rule-list
  interpreter.**  New wordwiki/transliterate-rules.ts: a transliterator as
  an ordered list of named rules (reRule = declarative regex→replacement,
  publishable; fnRule = named escape hatch).  compileRules(rules) yields
  BOTH faces from one list - transliterate (run, no recording) and explain
  (run, record each FIRED step as {ruleId, label, before, after}) - dz's
  "emit fast + traced from one table".  Rule ids are CONTENT-KEYED (FNV of
  pattern+flags+replacement, or label for fnRule) so they survive
  reordering - the anchor a verdict/feedback fact pins.  TransliterationTrace
  + renderTrace + spec.explain? field + harness `--explain WORD`.
  PILOT: pm-li (the research pair - explain feeds the coming error
  taxonomy).  Its imperative chain rewritten as PM_LI_RULES (22 rules,
  same regexes/order); explainPmToLi registered.  FAITHFUL REFACTOR PROVEN:
  0 diffs across 1210 outputs vs the pre-change oracle; harness score
  (72/241 holdout) and corpus fingerprint (07e9b827) unchanged.  Live
  --explain shows real derivations (e.g. tātjo → ta'ju via ā→a', tj→j,
  o→u; the o→u rule keeps id ee232da4 across words).  Tests: 6 interpreter
  + group green (26); typecheck clean.
- **[DONE 2026-07-31] I5 — li-sf explain + the HYBRID-ENGINE finding.**
  Reading the engine changed the plan (a real architecture finding, not a
  mechanical migration): li-sf's `transliterateLiToSf` = the top
  `transliterateCandidates` result - a DETERMINISTIC prefix (lexical
  exceptions, g->k) then PROBABILISTIC branch decisions (cluster/schwa/ei
  apostrophe or not), each resolved by a MEASURED context probability
  (BRANCH_PROBABILITIES).  So a full compileRules regex-list migration
  would MISREPRESENT it - the branch engine is inherently procedural and
  stays as code.  What IS rules-as-data: the deterministic layer
  (LI_SF_DETERMINISTIC_RULES = fnRule lexical + reRule g->k/G->K) plus the
  already-generated probability table.
  DELIVERED (hot path UNTOUCHED - li-sf is the production editor engine):
  (a) trace model extended additively - TraceStep gains optional
  {alternative, probability} for branch decisions; renderTrace shows them.
  (b) explainLiToSf: deterministic fired steps + one step per FIRED branch
  decision carrying its chosen probability and the alternative it beat;
  faithful BY CONSTRUCTION (replays the engine primitives, asserts
  reconstructed == transliterateLiToSf - a loud drift guard).  Registered
  as li-sf's spec.explain.
  VERIFIED: 0 drift/throw across all 1527 corpus words; live --explain
  renders real decisions (aqantie'umk shows a p=0.57 near-coin-flip + a
  p=0.76 - exactly the low-confidence sites the review workflow surfaces
  first).  Tests: 4 li-sf-explain + group green (24, incl. untouched
  production auto-transliterate); typecheck clean.
  CONSEQUENCE for the published artifact: li-sf's page is a HYBRID - a
  deterministic correspondence table + a branch-site table with measured
  probabilities - not a flat regex list.  That is honest, not an apology:
  the probabilities ARE the linguistically interesting content (the char-
  rule ceiling the module doc describes).  pm-li-style pure rule-lists and
  li-sf-style hybrid both fit under spec.explain; the review workflow and
  the published page consume the same TransliterationTrace shape either
  way.  Hardening phase (I1-I5) COMPLETE.

## 7. Proposed phase order (standing proposal, not yet approved as a plan)

1. Harness/registry hardening: one path per pair, standard holdouts,
   first-class composition + round-trip audits; explain-plan trace as a
   first-class output of the generic pair mechanism; rules-as-data
   migration (benchmark: li-sf v4).
2. pm-li hand-cleaned holdout (~100 verified-surface-faithful pairs) →
   error taxonomy on best letter-rules output.
3. Targeted language-level experiment on the winning bucket (morphology
   layer vs phonology layer — data decides).
4. Generic materialization landing (machineSync; auto lane + search
   indexing + candidate indexing; approve/correct feedback) piloted on
   the strongest pair (wsf→mmli or improved pm-li).
5. Review workflow (strata sampler + instance verdicts + trace join)
   once 1 gives traces and 4 gives materialized rows to review.
6. Published rule pages fall out of 1's rules-as-data + the publish
   model.
