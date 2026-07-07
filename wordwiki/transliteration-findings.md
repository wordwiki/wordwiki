# Listuguj → Smith-Francis transliteration: findings

Point-in-time summary, written 2026-07-07 after building the
auto-transliteration workflow and running the rules-improvement loop against
the dictionary's own data.  Two audiences, two sections: the **language
experts** who can answer the open questions, and a **future Claude** picking
the work back up once that feedback exists.

Current state: the machine converts Listuguj text to Smith-Francis at
**73.8% exact match** (validated on held-out human-written pairs it never
trained on).  Every number in this document is measured, not estimated.

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
2. **Insert the apostrophe in l/n/m + t/p/j clusters** (weltaq → wel'taq) —
   with exceptions found in the data: not at the start of a word (*Lpa*
   stays *Lpa*), and not in the u+l+t context (*apjelmultimkewei*).
3. **A short list of irregular words**: ugjit → wjit, goqwei → koqwey.

Each machine proposal now carries a **confidence label** (measured, not
guessed): about half of all words are in a band the machine gets right 86%
of the time; a small slice (the *lg* words below) it gets right barely 1
time in 5, and the editor marks those for real scrutiny.

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

**Q3. Word-final *-ei*: does it become *-ey*?**
Your writing splits **41 keep / 23 change** (*Pilei → Piley*,
*Mijipjewei → Mijipjewey*, but *angamsutiei* stays).  Intriguingly, the
previous generation's expert rules (Transliterate.java, rule 100) made
ey-handling conditional on the word being a **noun** — is -ei → -ey
grammatically conditioned?  If you can state the condition, the machine can
apply it (it knows each word's part of speech).

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
| li-sf/rules-v2 (+ lexical exceptions, word-start, ult) | 73.5% | **73.8%** | current engine |
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

### The ceiling, and what expert feedback unblocks

Character-window rules are exhausted: the remaining clusters contain
conflicting demands inside identical windows (Q1/Q2 above).  When feedback
arrives:

- **Grammatical conditioning (Q3)**: part-of-speech is available — the
  entry's subentry `part_of_speech` (lexical-forms vocabulary); the
  proposal op has entry context, and the old export scripts already
  demonstrated a noun flag per pair.  Java rule 100's `isNoun` precondition
  is the precedent.
- **Morphology/syllable conditioning (Q1/Q2)**: needs either expert-stated
  rules (encode + measure as usual) or a segmentation the schema doesn't
  have.  If experts stall, the fallback is a **learned weighted transducer**
  over the pairs — likely beats hand rules, but uninspectable; dz values
  expert-legible rules, so treat as last resort.
- **The convention decision (Q4)** changes everything downstream: if
  barred-i wins, the oracle itself needs re-grounding (today's corpus would
  be the *wrong* target) — do not tune further until that's settled if it
  comes up.

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
