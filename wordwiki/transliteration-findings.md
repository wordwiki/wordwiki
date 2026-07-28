# Listuguj → Smith-Francis transliteration: findings

Point-in-time summary, written 2026-07-07 after building the
auto-transliteration workflow and running the rules-improvement loop against
the dictionary's own data.  Two audiences, two sections: the **language
experts** who can answer the open questions, and a **future Claude** picking
the work back up once that feedback exists.

Current state (updated 2026-07-08): the machine converts Listuguj text to
Smith-Francis at **75.5% exact match**, and when allowed to offer **up to
five ranked candidates**, the right answer is among them **84.4%** of the
time (all validated on held-out human-written pairs it never trained on).
Every number in this document is measured, not estimated.

---

## Part 1 — For the language experts

### What the machine knows, and how we know it

The dictionary itself contains about **1,530 clean pairs** where a human has
written the same thing in both Listuguj and Smith-Francis — spellings,
example sentences, alternate forms, regional forms.  Those pairs are the
machine's only teacher: every rule below was found *in your own writing* and
is scored against it.  When you correct a machine proposal in the editor,
your correction joins this collection automatically — the machine learns
from the team's practice, nothing else.

What it currently does:

1. **g → k** everywhere (this is right ~99% of the time in your writing).
2. **Weigh each ambiguous spot by how your writing usually resolves it**:
   the cluster apostrophe (weltaq → wel'taq — but not at the start of a
   word, and not in u+l+t), word-final -ei vs -ey, and the '/î choice are
   each decided by their measured frequency in their exact context, not by
   a fixed rule.
3. **Use the word's part of speech** where it knows it (97% of entries):
   vai verbs keep word-final -ei; vit tends to -ey (see Q3).
4. **A short list of irregular words**: ugjit → wjit, goqwei → koqwey.

Each machine proposal carries a **confidence label** (measured, not
guessed): about half of all words are in a band the machine gets right 86%
of the time; a small slice (the *lg* words below) it gets right barely 1
time in 5, and the editor marks those for real scrutiny.

**New: multiple suggestions, one click.**  Where the machine is unsure, it
no longer commits blindly: the proposal row shows the runner-up spellings
as small buttons (each explaining its difference — "apostrophe at l·t",
"word-final -ey").  If the machine's first guess is wrong but a runner-up
is right — which covers most of its mistakes — **fixing it is one click**:
the clicked spelling replaces the guess and is approved in the same act.
Measured: the right answer is somewhere in the top five suggestions for
**84.4%** of words (top guess alone: 75.5%).  And every click teaches the
machine which way that ambiguity resolves — clicks are the highest-value
feedback you can give it, even better than typed corrections.

### The open questions — your agenda, with the evidence

These are the situations where your own writing disagrees with itself, or
where the machine cannot find a letter-based rule.  Each question comes with
counted examples; answering even one materially improves the machine.

**Q1. When does Listuguj *lg* become *l'k*, and when plain *lk*?**
(THE biggest gap: 81 words, machine ~20% accurate.)
The corpus inserts the apostrophe in some words and not others:

  - *algwiluatl → al'kwiluatl*, *elgimsgwet → el'kimskwet*,
    *elguta'latl → el'kuta'latl* (apostrophe inserted)
  - but after **a** the corpus usually does NOT insert (5 for, 12 against),
    while after **e** it usually DOES (20 for, 8 against).

Is this stress? Syllable structure? A morpheme boundary?  A rule of thumb in
your words — even "insert when the l closes a stressed syllable" — is
directly usable.

**Q2. The sonorant apostrophe generally: what conditions it?**
The same letter-context sometimes takes the apostrophe and sometimes not:

  - *weltaq → wel'taq* (yes) — but *apjelmultimkewei* (no, at l+t)
  - *n+t*: dozens of insertions — but *aqantie'umg → aqantie'umk* (no)

The machine found one clean sub-rule (u+l+t never inserts; u+l+p always
does) but the rest conflicts within identical spellings, which means the
conditioning is something spelling doesn't show — your call on what.

**Q3. Word-final *-ei*: does it become *-ey*?  — PARTIALLY ANSWERED
(2026-07-08, by part of speech).**
Your writing splits **41 keep / 23 change** overall — but split by part of
speech (via the single-subentry 1-1: 97% of entries), a real pattern
appears: **vai verbs keep -ei 25 of 30 times**, vit leans -ey (8 of 13),
and the noun classes are mixed.  So the old rule-100 hunch (noun-
conditioned) was pointing at grammatical conditioning but had the class
wrong: it is the VERB paradigm that protects -ei (likely because -ei is an
inflectional ending there).  The machine now conditions this branch on
part of speech.  Remaining question for you: is the vit/noun behaviour a
real rule or just thin data?

**Q4. The apostrophe vs barred-i (î) convention — a decision, not a rule.**
The previous generation's expert rules write the older Smith-Francis style:
*t' → tî*, schwa apostrophes removed.  Today's corpus — the team's own
current SF writing — keeps the apostrophes.  Measured against today's
corpus, the old expert rules score 36%; the apostrophe-keeping rules 74%.
**Which convention is the intended target?**  If the answer is barred-i,
then the corpus itself (and the team's habit) diverges from the target, and
that is a bigger conversation than any rule.  A related small cluster: some
C'C words DO take î in the corpus (*apnmisg'g → apnmiskîk*,
*apsi's'g → apsi'sîk*) while others keep the apostrophe
(*amalapt'g → amalapt'k*) — 22 words, no letter-rule found.

**Q5. Irregular words — just tell us.**
*ugjit → wjit* appears 15 times out of 18; *goqwei → koqwey* 7 of 9.
There is now a plain list in the system where such words can be recorded
directly (no rule needed) — any word you know to be irregular is a
one-line fix.

**Q6. Data housekeeping.**  Ten SF fields are letter-for-letter identical
to their Listuguj sibling *despite containing g* — almost certainly
copy-pastes that were never converted.  Worth fixing in the dictionary when
convenient; the machine already ignores them.

### How your answers become improvements

Three ways, pick whichever suits:
1. **Say the rule out loud** ("after e, lg takes the apostrophe") — it gets
   encoded and measured within minutes.
2. **Correct proposals in the editor** — every correction (and the optional
   "why was this wrong?" note) lands in the Transliteration Report and
   becomes a permanent test case.
3. **Judge example lists** — for any question above we can produce the full
   word list with both options, to mark up on paper.

---

## Part 2 — For a future Claude resuming this work

### The file map

| File | What it is |
|---|---|
| `wordwiki/transliterate.ts` | The engine: rules-v2 (`transliterateLiToSf`), `LEXICAL_EXCEPTIONS`, risk markers + `transliterateLiToSfScored`, frozen `transliterateRulesV1`, the faithful Java ports, `CANDIDATE_TRANSLITERATORS` |
| `wordwiki/transliterate-calibration.ts` | GENERATED by the harness `--calibrate`; never hand-edit |
| `wordwiki/transliterate-harness.ts` | The offline loop: scores, error clusters, train/holdout split, baseline diff, calibration generation |
| `wordwiki/auto-transliterate.ts` | The proposal op (button rules), `pairJunkReason` (oracle cleanliness), `TransliterationReports` (corrections + per-band/per-version outcomes + candidate dashboard) |
| `wordwiki/Transliterate.java` | Provenance: the previous generation's transliterators (see below) |
| `wordwiki/auto-transliterate_test.ts` | All the behavior pins, incl. Java-port fidelity |

### The loop, exactly

```
./wordwiki.sh export-transliteration-pairs oracle.json     # refresh the oracle
deno run --allow-read --allow-write wordwiki/transliterate-harness.ts \
    oracle.json --write-baseline base.json                 # score + clusters (TRAIN)
# ... edit rules in transliterate.ts ...
deno run ... oracle.json --baseline base.json              # fixed/regressed diff
deno run ... oracle.json --holdout                         # the honest number
deno run ... oracle.json --calibrate                       # regen calibration
# bump TRANSLITERATOR_VERSION, update tests, land
```

### Score history (train / holdout exact-match)

| Version | Train | Holdout | Notes |
|---|---|---|---|
| li-sf/rules-v1 (g→k + [lnm][ptj] apostrophe) | 70.6% | 70.1% | both rules corpus-mined |
| li-sf/rules-v2 (+ lexical exceptions, word-start, ult) | 73.5% | 73.8% | frozen |
| li-sf/rules-v3 (probability-RANKED branch decisions) | — | 75.9% | frozen in spirit (v4 = v3 + pos) |
| li-sf/rules-v4 (+ pos-conditioned -ei branch) | 75.0% | **75.5%** | current engine; top-1 statistically unchanged (±1 word) but per-class probabilities truer; top-5 **84.4%** |
| Java rules pipeline (expert set, ported) | — | — | 35.9% on ALL |
| Java scanner (what the old system served) | — | — | 47.4% (48.9% + sonorant) |

### Methodology rules that earned their place

1. **Never invent linguistics — mine it.**  Every rule came from corpus
   alignment (per-context insert/no-insert counts).  When I guessed
   (intervocalic-g exception, i'→î), the corpus rejected it.
2. **Exceptions must be exact.**  u+l+t is 52-vs-14 AGAINST insertion while
   u+l+p is 20-0 FOR — a broader "after u" cut would have destroyed a good
   rule.  Mine the exact window before excluding anything.
3. **Holdout or it didn't happen.**  Deterministic hash split (fold 0 held
   out); v2's gain generalized (73.5 train / 73.8 holdout).  A rule helping
   only the train split is memorization.
4. **Baseline-diff every change** — the harness lists exactly which pairs a
   change fixed and regressed.
5. **The oracle needs hygiene**: `pairJunkReason` excludes (and NAMES)
   editorial junk and identical-despite-g suspected copies.  Identical
   pairs *without* g are legitimate.
6. **The cluster output IS the agenda** — the Part 1 questions above are
   the top clusters, verbatim.
7. **Differential-test ports against their prototypes** — the TS candidate
   engine "scored 55%" until a py-vs-ts differential (2 disagreements in
   294) proved the port right and exposed a measurement bug instead.
8. **When a forced choice is wrong ~25% of the time, stop forcing it** —
   enumerate the branches and let a human click; 75.5% top-1 became 84.4%
   top-5, and each click is labeled training data.

### The ceiling, and what expert feedback unblocks

Character-window rules are exhausted: the remaining clusters contain
conflicting demands inside identical windows (Q1/Q2 above).  When feedback
arrives:

- **Grammatical conditioning (Q3)**: BUILT (2026-07-08).  The oracle
  export carries `pos` (single-subentry 1-1, `singleSubentryPos`); the
  engine's -ei branch key splits by pos class (vai/vit/other, see
  `posClass`); the proposal op, pick verb and chips all pass the same pos.
  Result: top-1 unchanged within noise, probabilities per class now
  measured (vai keeps -ei at .17, the rest ~.55).  The pattern for any
  future pos-conditioned rule is in place — mine by `p.pos`, split the
  branch key, let branchP's n≥5 threshold govern.
- **Morphology/syllable conditioning (Q1/Q2)**: needs either expert-stated
  rules (encode + measure as usual) or a segmentation the schema doesn't
  have.  If experts stall, the fallback is a **learned weighted transducer**
  over the pairs — likely beats hand rules, but uninspectable; dz values
  expert-legible rules, so treat as last resort.
- **The convention decision (Q4)** changes everything downstream: if
  barred-i wins, the oracle itself needs re-grounding (today's corpus would
  be the *wrong* target) — do not tune further until that's settled if it
  comes up.

### The ranked-candidate engine (rules-v3/v4) and click-to-pick

The residual ambiguities are BINARY BRANCH SITES (cluster apostrophe;
word-final -ei/-ey; schwa '/î).  `transliterateCandidates(li, k, {pos})`
enumerates both branches of every site (capped at 6 sites), ranks the
combinations by the product of each branch's measured context probability
(`BRANCH_PROBABILITIES` in the generated calibration file), and returns the
top k with the distinguishing branch decisions named (near-deterministic
branches, P≤.1 or ≥.9, are left out of the labels).  Top-1 IS the engine.
Holdout: top-1 75.5%, top-2 83.0%, top-5 84.4% — the gain is front-loaded,
so 5 is a UI cap, not a knob worth raising.

Invariants and gotchas:
- **The pick verb re-derives candidates by INDEX** — the chips
  (lexeme-editor tupleSurface), `pickTransliteration`, and the proposal op
  must all call `transliterateCandidates` with the SAME pos
  (`singleSubentryPos(app, entry_id)`) or indexes disagree.
- **Pick = bounded self-approve**: the picker chooses among
  machine-generated candidates and cannot inject text, so
  `approveFact(fact_id, {allowSelfApprove: true})` is sound there — free
  text keeps the normal two-person path.  A pick's change_action is
  `pick-transliteration`, its change_arg carries `pick=N` + the branch
  decisions: a LABELED branch resolution, the highest-value training
  signal (mine these before free-text corrections).
- **`--calibrate` evaluates the table loaded at process start** — after
  writing a fresh table, run it a second time to score it.  (First
  symptom seen: top-1 "55%", which was the empty bootstrap table, not the
  engine.  A differential test against a prototype settled it.)
- Branch keys: `cluster:<before>|<son>|<obs>`, `ei:<posClass>`,
  `schwa:<c1>|<c2>`; `branchP` uses exact key at n≥5, else the kind
  marginal, else 0.5.  posClass is vai/vit/other/'' — splits must be
  chosen on TRAIN (the 2-way vai/other variant flipped non-vai to a 0.50
  coin and cost a holdout word; 3-way is what train supports).
- **±1 holdout word is noise** — don't chase it, and don't ship a variant
  that only train likes.  The pos split shipped because its probabilities
  are TRUER per class (better ranking), not because top-1 moved.

### Confidence system invariants

- Confidence = measured band accuracy; calibration is REGENERATED after any
  rules or oracle change (`--calibrate`), and validated on holdout with
  drift warnings.  Fallbacks: unmeasured combo → min of single-marker
  accuracies → 0.5.
- `change_arg` format on proposals: `<version> conf=NN band=X markers=a+b`.
  The FIRST TOKEN is the version — the corrections report groups by it;
  don't break that.
- The rejected-proposal check compares TEXTS, not versions: a rejected
  output is only re-offered when the rules produce something different.
- The per-band correction-rate table in the Transliteration Report is the
  calibration's self-audit against real reviewer behavior — check it before
  trusting the bands.

### Watch-outs

- A PICKED alternate counts as 'corrected' in the corrections report (text
  differs from the robot's) — right for the calibration audit, but when
  mining corrections as a corpus, `change_action='pick-transliteration'`
  rows are the pre-labeled subset; handle them first and separately.
- The oracle GROWS as transliterations get approved — the corpus
  distribution shifts toward machine-influenced pairs over time.  Human
  *corrections* are the highest-value pairs; consider weighting them.
- `etx` pairs are whole sentences: word counts can differ (maw klu'lk),
  which breaks naive word alignment — the lexical miner skips unequal-length
  sentences.
- The dev db is a disposable rehearsal copy: re-export the oracle after any
  `importWordWikiV1Db.sh` refresh.
- dz reviews everything locally before staging sees it
  ([[staging-workflow]] memory) — polish reports on dev, never suggest
  pushing.

---

## Part 3 — The multi-pair generalization (2026-07-27)

The li→sf machinery above is no longer the only customer.  The rand import
produced two new parallel corpora an order of magnitude bigger than the one
that trained the current rules, and the mechanism has been FACTORED so each
orthography pair is a registered user of the same engine, oracle harness,
and iteration loop.

### The pair mechanism

- `wordwiki/transliterate-pair.ts` — `TransliterationPairSpec` {id, source/
  target lanes, version, transliterate(), ranked candidates(), candidate
  variant list, corpus extractor} + a registry.  General code; knows no
  Mi'gmaq.
- `mikmaq/transliterate-pairs.ts` (registered by `mikmaq/register.ts`) —
  the pairs themselves: `li-sf` wraps the mature engine above; `wsf-wli`
  (watson-sf → watson-li) and `wli-mmli` (watson-li → mm-li) are new.
- The harness (`transliterate-harness.ts`) is generalized: `--pair ID`
  selects the pair, oracle files carry {source, target, tag} (legacy
  {li, sf} still read), and the CORE is the exported `runHarness()` —
  callable as a plain function on JSON query results, so a SAAS future
  with no CLI runs the identical code (dz's requirement).  The CLI entry
  is a binary edge and may import the mikmaq package.
- `export-transliteration-pairs [path] [--pair=ID]` exports any registered
  pair's corpus; the no-flag default is the unchanged li-sf export.
  Corpora and baselines are gitignored scratch, re-exported from the db.

### The ambiguity PATTERN form

`wordwiki/transliterate-pattern.ts`: ranked candidate sets written as one
compact string — `epa'q[oe]t`, `ta(s|ts|)ipow` — a deliberate strict
SUBSET of regex (literals + the two alternation forms, nothing else), so
the set stays finite and enumerable by construction and the regex
transform is mechanical.  What plain regex cannot carry is RANK: here
alternative order IS preference order, which is what top-k, confidence,
and the display default need; `patternToRegExp()` is the one lossy
direction (drops rank, keeps the set).  The bracket form reads like
phonemic variant notation — the review audience is linguists.

### The new corpora, and where they start

Both exported from the dev db and scored with IDENTITY rules (train
split) to map the ground before any rules exist:

- **wsf-wli** — 4,565 pairs, every rand entry Watson wrote in both his
  sf-style and Listuguj-style lanes (ONE author: no team-drift noise).
  Identity: 19.3% exact.  The failures are overwhelmingly systematic:
  k→g voicing (×3,781), word-final -y→-i, ɨ→', q_n→qan epenthesis.
- **wli-mmli** — 2,131 pairs from the landed `~rand-mmo-pair` counterpart
  links (1,409 high-confidence + 722 medium).  Identity: 56.7% exact —
  and **79% on the high-confidence subset**: watson-li and mm-li are
  close, as the Watson→Dianne manual-transliteration heritage predicts.
  Residue: apostrophe length-marks, backtick→apostrophe schwa, qan
  epenthesis, g→q.

### The phonetic hub (Rand's claim, and what we do with it)

Clarke's introduction records that Rand could train a NON-SPEAKER to read
his spelling aloud intelligibly — the claim being that the orthography is
phonetically complete.  Discounted for 19th-century enthusiasm (his
diacritics drift, the typesetting errs, his ear was English-calibrated),
the architectural consequence stands: the Rand-derived lanes are the
information-RICH end of the pair graph, so:

1. **watson-sf is the de-facto hub.**  It is a single author's normalized
   machine-readable rendering of the phonetically complete source, with
   4.5k pairs on each side.  Compositions route THROUGH it (rand ↔
   watson-sf ↔ watson-li ↔ mm-li) and are information-preserving in the
   out-of-hub direction precisely because of the completeness claim.  No
   abstract phoneme inventory is minted — the hub plays that role.
2. **Rules are written over phonological CLASSES**, not letter lists:
   sonorants, obstruents, vowels, schwa sites.  The li-sf engine already
   does this covertly ('lnm', 'ptjk'); the mikmaq package now names the
   classes and the per-pair rules read as phonology — reviewable by the
   people who know the phonology.
3. **Ambiguity = measured underspecification.**  Branch points belong
   exactly where a lane drops information the hub keeps; the corpus
   measures each branch's probability (as the li-sf calibration already
   does).
4. **Residue is a worklist, not embarrassment.**  Once systematic rules
   converge: what remains on the rand↔watson edge is transcription noise;
   what remains on the watson↔mm edges is largely REAL DIALECT difference
   (Rand's Nova Scotia informants vs Listuguj) — each worth surfacing on
   its own report.

The goal behind all of it: derive the ortho mappings from thousands of
single-author pairs instead of the ~358 mixed pairs the current suspect
mm-li→mm-sf understanding rests on, then audit mm-sf consistency by
running the direct rules and the hub composition as two candidates on one
oracle and reading their disagreements.

### First derivation results (same day)

One harness loop per pair, every rule justified by train-fold counts,
scored on the untouched holdout:

- **wsf-wli rules-v2** (`mikmaq/watson-transliterate.ts`): voicing k→g,
  y→i, word-final -sik→s'g (21:2), echo-vowel epenthesis where Watson's
  majority says so (always after o, otherwise medially before e/a),
  w-possessive → ug-, initial ln→nn.  **86.2% train / 86.0% holdout**
  (identity: 19.3%); +2,462 fixed / −15 regressed vs identity.  The two
  branch points Watson's own writing leaves open — the schwa mark
  (' vs `) and word-final aqn epenthesis (70:76, his coin flip) — are
  RANKED PATTERN branches, not guesses: top-2 candidates cover **88.0%**
  holdout.  Note this already beats the mature li-sf engine (75.9%) on
  one day's rules: the single-author corpus is that much cleaner.
- **wli-mmli rules-v1**: backtick→apostrophe, echo-vowel epenthesis.
  **59.2% train / 57.2% holdout** overall; the high-confidence subset is
  at **81%** with ZERO regressions (+43/−0).  The remaining residue needs
  information the watson-li lane does not carry (vowel-length
  apostrophes, g-vs-q uvularity, vowel quality) — exactly the predicted
  underspecification; the path there is hub composition (route through
  watson-sf/rand, which DO carry length and uvularity) and the dialect
  worklist, not more letter rules.

Iteration cost of a loop (edit rules → harness train + holdout + baseline
diff): ~10 seconds, zero LLM spend.

### The hub composition, measured (same day)

A third registered pair puts the hub thesis under the oracle:
**wsf-mmli** — watson-sf → mm-li over the same counterpart links (637
pairs; only ~30% of counterpart-linked rand entries carry a watson-sf
spelling, which is why it is smaller).  Its `transliterate` is LITERALLY
the composition `wliToMmli(wsfToWli(word))` — zero new rules.

Scores (train / holdout): identity 24.7%; **composition 73.8% / 70.7%**,
and on the high-confidence subset **88% / 87%** — ABOVE the direct
wli→mmli route's 81%, despite spending no rules on this pair, because the
sf lane preserves exactly what the li spoke destroys (q-vs-k uvularity
survives; sf vowel-length marks pass through).  Rand's phonetic
completeness, cashed as measured accuracy.  (Caveat: the two corpora
cover different entry subsets, so this is a strong signal, not a
controlled A/B.)

Residue worth noting: the top remaining cluster is mm-li vowel-length
apostrophes the sf lane also lacks (lexical), and FOUR mm-li targets
contain CURLY apostrophes (’) — a data-cleanup worklist item, not a rule.

Consequences: when proposing mm-li counterpart spellings from rand, use
the sf lane when the entry has one, the li spoke otherwise; growing
watson-sf coverage (more rand transcription) directly buys transliteration
accuracy.

### The mm-li → mm-sf composition audit (2026-07-27, report: watson/mmsf-composition-audit.md)

The suspect direct mapping, audited by the hub.  New machinery:
**wli-wsf** (the INVERSE spoke, derived from the reversed rand oracle:
apostrophe class-split — consonant side = schwa ɨ 250:32, vowel side =
length 1393; g→k; -ei→-ey 331:11; final aqan→aqn 69:3; nn→ln 10:0) at
**84.2% train / 86.1% holdout**; the **via-watson audit candidate** on the
li-sf pair (only what Rand's phonetics license: g→k + -ei→-ey — the schwa
apostrophe round-trips and Watson's archaisms are conventions, measured
against TEAM practice: aqan kept 100:0, nn kept, schwa ' 1245:27); and
**wsf-mmsf** (the convention bridge for independent Rand-side prediction).

Results:

- On the li-sf holdout: via-watson 53.1% vs rules-v4 75.5%.  **The
  22-point gap IS the team-convention inventory**, itemized in the
  report: the cluster-aspiration apostrophe (×323 — v4's biggest learned
  convention), pos-conditioned final -ei (×29), lexical wjit (×5), î (×3).
- **62 pairs where v4 overreaches** (the phonetics-only mapping is right
  and v4 is wrong) — a direct rules-v4 bug worklist.
- **194 joint misses** — both routes agree AGAINST the human mm-sf
  spelling: the mm-sf consistency worklist the audit was for.
- The 75 independent triples (watson-sf + mm-li + mm-sf on one entry):
  44 all-agree; 24 v4-right (dialect/Watson divergence); **1 strong
  suspect** — dict 7668 mm-sf 'angua'latl' is an UNtransliterated copy of
  the li form (both routes: ankua'latl).  Sparse but the mechanism works;
  it grows as counterpart coverage and the sf lane grow.

Reading: the direct mapping is not so much WRONG as it is two-thirds
convention — which is fine while the team's conventions are stable, but
means rule changes should be validated against the joint-miss and
overreach lists, and the 194-item worklist is real reviewer material.

### The dialect-residue report (2026-07-27, report: watson/dialect-residue.md)

The 2,666 counterpart pairs after the systematic rules, residue = the
modern mm-li reachable by NEITHER route (li spoke nor hub), classified:
64.4% exact; then A length-mark practice 309 (270 of them the ONLY
residue on high-confidence pairs — convention, not dialect), **C pure
vowel substitutions 85** (the dialect table: a→o ×19, e→i ×17, i→e ×15,
e→a ×14 — real Nova Scotia↔Listuguj vowel correspondences),
**D uvularity g↔q 35**, E single-vowel epenthesis 92, F inflection-tail
100 (different form chosen as headword, excluded from dialect claims),
G unsorted 328.  Every row carries dict+rand entry ids and the confidence
tier; the class C/D/E signal is all medium-tier by construction
(high-confidence pairs have identical skeletons), so the report says so
and tells reviewers to read the pair, not just the letters.  C and D are
the tables for Watson/Dianne.

### orthoMatch: graded cross-orthography matching (2026-07-27)

The registry's answer to "same form, different spelling system?", for
pairing and the live editor dup-probe (`wordwiki/transliterate-match.ts`):

    orthoMatch(a, laneA, b, laneB) → {grade, via?, rank?}
    orthoMatches(a, laneA, b, laneB, min='candidate') → bool

Grades: **exact** (the pair's rules alone produce one from the other),
**candidate** (b is in a's AMBIGUITY set - a branch point went the other
way; rank = which branch, 0 = preferred), **skeleton** (equal modulo
marks, via the transliteration or the raw cross-lane floor), none.
Both directions are tried, so the relation is symmetric; only REGISTERED
pairs are used (compositions are registered explicitly, never inferred).
Set membership is O(1) via the pattern→regex transform - the spec gained
`candidatePattern` and wsf-wli provides it.  Consumers should feed the
grade into their evidence (ruleVerdict), not collapse to bool early.

The BLOCKING half: `transliteratedSkeletons()` - every spelling now also
indexes the skeleton of its rule-rendering in each registered target lane
(as plain 'skel' keys, so cross-lane joins need no query change).  After
rebuild: rand 109,080 keys (the watson lanes fan out), dict 83,721;
verified live - rand 'keknasimkewey' (wsf) indexes 'gegnasimgewei' and
will block against modern spellings.  Ops note (RESOLVED): the rebuild
briefly OOMed the default 4GB heap - the cause was CUMULATIVE workspaces
(storeFor caches each dictionary's ~1GB workspace and the loop never
released them; ~4KB retained per assertion row across 1M rows, vs ~14MB
of actual text).  Fixed two ways: import-mirror dictionaries (randraw)
are now SKIPPED by default (their per-line entries were 31,592 one-key
blocking-noise rows, since cleared; an explicit name still indexes one),
and the loop releases each workspace via requestWorkspaceReload before
the next.  Full rebuild fits the default heap again.

### orthoMatch wired into pairing evidence (2026-07-27)

ruleVerdict gained the spelling GRADE as ordered rule 1b (between exact-
skeleton and near-skeleton): xlit-exact/xlit-candidate + def-overlap →
same-word HIGH; + missing-defs → medium; disjoint defs stay in the
referral band (a grade never rescues meaning disagreement).  ruleVerdicts
takes a spellingsOf accessor (both callers - the verdicts CLI and
pairRandMmo - supply headwordsAllLanes), computes the best cross-product
grade per pair, and RECORDS it on RuledPair.spellGrade; the report now
prints the grade distribution.  The mm-targeting pairs gained an
epenthesis candidatePattern (the aqan/aqn branch), so both shapes grade
'candidate'.

Measured on rand↔dict (59,463 candidate pairs): grades exact 4,778 /
candidate 1 / skeleton 1,125 / none 53,559 - and ZERO verdict changes,
for a good reason: the xlit BLOCKING keys already index both the raw and
rule-transformed skeletons, so every single-branch pair reaches the
exact-skeleton rule first; the grade tier upgrades nothing here.  What
the wiring buys: the recorded grade separates rules-exact matches (4,778
- the strongest same-word evidence in the corpus) from mere
skeleton-equal ones for downstream consumers (planPairs confidence,
support panels), it covers consumers with no index (the live dup-probe
path), and multi-branch mixtures (the 1) that blocking cannot see.

### cskel + stemming (2026-07-27, from the unpaired-word audit)

The audit's two cheap fixes, built and measured:

- **Consonant-skeleton keys** (kind 'cskel', vowels+marks stripped, >= 3
  consonants, emitted for raw and xlit renderings; form 20 / corroborate
  80): syncope-proof blocking - g's'talg and gisatalg finally MEET.
  Verdict rule 2b: shared cskel + def overlap -> same-word medium;
  + missing defs -> referral; disjoint defs fall through (consonants
  alone claim nothing).
- **Light def-token stemming** (-ing/-ed/-ly, silent e, doubled final,
  after the plural fold): finish/finished, encourage/encouraging share a
  key.  Tokens are matching keys, never display text.

rand↔dict measured: candidates 59,463 → 65,919; same-word 2,988 →
**3,584 (+20%)**; cskel+def-overlap fired 190, cskel+missing-defs sent
335 to referral (band now 7,330).  Audit words: elsma'latl and g's'talg
now recovered; wissugwalatl honestly remains missed - ss/sg is a
consonant SUBSTITUTION (its 'cook' bridge sits at df 91 > form 25), the
dialect-correspondence lever, not a syncope case.  Pairing dry run:
plan 3,185 vs 2,679 landed (+506 new pairs, 323 multi-match worklist) -
apply awaiting dz.

### The dialect-correspondence widening (2026-07-27)

Measured first (288 aligned single-substitution pairs among the 3,163
landed counterparts): vowels dominate (a↔e 66, e↔i 63, a↔o 41 - all
already folded by cskel); the real consonant correspondences are
**g↔q 27, l↔n 7, u↔w 5**; g↔t (8) EXCLUDED as inflection (-g/-t
animacy finals).  s↔g (wissugwalatl) is <= 2 - too rare to bet a table
on, which set the design:

- **Blocking**: symmetric-delete 'cskel1' keys (cskel + every single-
  consonant deletion, length-guarded, form 12 / corroborate 40) - ANY
  single consonant edit meets, table-free.  wissugwalatl finally blocks
  against wisgugwalatl (shared keys at df 6).
- **Verdict**: language rules v3 gain dialectSubs ['gq','ln','uw']; new
  rule 2a: one aligned substitution that is a measured correspondence
  (any vowel pair; listed consonants) + meaning agreement -> same-word
  HIGH with the correspondence NAMED as qualifier.  Unmeasured subs
  (s↔g) still resolve via ordinary near-skel (medium) - the table earns
  confidence, the neighborhood earns recall.

Measured rand↔dict: index rand 479,573 keys (~3×, the neighborhoods);
candidates 65,919 → 99,651; same-word 3,584 → **4,006** (+12%;
dialect-sub+def-overlap fired 346, all named for review); referral band
9,854.  Pairing dry run: plan 3,477 vs 3,185 landed (+292) - apply
awaiting dz.

### The referral-band filter (2026-07-28)

`similarity-judge` now judges ONLY the referral band by default: it runs
the pass-1a rules first (same spellingsOf grades as the verdicts CLI),
keeps the pairs ruled 'ambiguous' (`referralCandidates`), and clusters
those.  Measured on rand↔dict: **9,854 of 99,651 candidate pairs in
7,781 clusters** - the model is spent on exactly the 10% the rules
refuse to decide.  `--all` keeps the judge-everything behavior for
evals.  The console line prints pairs + clusters (= LLM calls) before
any spend; `--sample=0` is a free dry run of the band computation.
MEASURED by the 50-cluster pilot (2026-07-28, Opus, report
watson/rand-mmo-judge-band-sample.md): 48 paid calls, 71,032 in / 6,938
out tokens → ~1,480 in / ~145 out per cluster → full band (7,781
clusters) ≈ 11.5M in / 1.1M out = **~$260 Opus / ~$50 Sonnet** (86%
agreement).  The band is RICH: of 57 pairs judged, **28 same-word (20
high)** / 13 related / 16 unrelated - ~49% same-word, and the reasons
are exactly the synonym-bridge tier ('regard'↔'think highly of',
'evil-favored'↔'ugly', 'stopple/plug/cork', la prison loan).  Naive
extrapolation: ~4,800 same-word pairs waiting in the band (sampling
caveat: first-50 clusters, not random).  1 failed cluster, retryable
free.
