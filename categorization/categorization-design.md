# Dictionary re-categorization — design, process, and retrospective

*2026-06-11. Status: complete first full pass, awaiting language-team review.*

*Update 2026-07-01: team feedback received; v2 underway. The v2 scheme is in
`scheme.md`, the v2 pass instructions in `v2-instructions.md`; v1 assignments
frozen in `assignments-v1.jsonl`. This document remains the v1 record and the
general method reference.*

This document is three things at once:

1. **For the language team** — what was produced and how to review it.
2. **For rerunning** — the complete recipe to redo this categorization after
   specialist feedback, so a v2 pass is mechanical.
3. **For the next run's categorizer (an LLM, probably me)** — what I learned
   about the shape of this language and dictionary, and what I would do
   differently. Read this section before starting a rerun.

An important note on method: this whole pass was done deliberately **without**
language-specialist feedback. Describing a categorization abstractly is very
hard to engage with; a complete concrete categorization of all 8,822 entries
is something the team can read, react to, and correct. The expected outcome
of review is a list of concrete changes (rename/merge/split categories, move
words, fix tiers) — and possibly a **rerun** of the whole tagging pass with
those decisions folded into the instructions.

---

## 1. What was produced

All artifacts live in `categorization/` (this directory):

| file | role |
|---|---|
| `scheme.md` | **The category scheme** — 85 categories in 12 themes, each with name, stable slug, and inclusion criteria. Single source of truth; `dictq.py` parses it for validation. |
| `entries.jsonl` | English-side dump of all 8,822 entries (regenerable; gitignored). One JSON object per line: id, spellings, statuses, POS, glosses, translations, example translations, old categories, recording/picture counts. |
| `assignments.jsonl` | **The categorization** — append-only; one JSON record per entry; later lines win (corrections are appends, full history kept). |
| `notes.md` | Survey observations + the tagging conventions that accreted during the pass + audit coverage notes. |
| `dictq.py` | Read-only query tool (stats, members, grep, batch, tiers, scheme, validate). Accrued during the work; every report is re-runnable. |
| `dump_entries.py` | Regenerates `entries.jsonl` from the wordwiki db. |
| `curate_tiers.py` | The curated learner-tier decision (exact top-10/100/1000) as a named, re-runnable transformation. |
| `make_review_views.py` | Regenerates `review/` from the data files. |
| `review/` | **What the team reads**: overview, one file per category, tiers, needs-human list, old→new mapping, low-confidence list. All Markdown. |

Assignment record shape (in `assignments.jsonl`):

```json
{"e": 12345, "cats": ["primary", "secondary"], "conf": "m",
 "tier": "t100", "flag": "needs-human", "note": "free text"}
```

- `cats`: 1–3 category slugs, primary first (empty only when flagged).
- `conf`: omitted = high; `"m"` medium, `"l"` low (284 entries total).
- `tier`: curated learner tier, cumulative t10 ⊂ t100 ⊂ t1000 (10/100/1000).
- `flag: "needs-human"`: 716 entries — placeholders, no-English, editor notes.

## 2. How to review (language team)

Start with `review/00-overview.md`, then:

- **Per category** (`review/by-category/`): read each list as a set. Does
  every word belong? What's missing? Is the category name right (names are
  free to change; only slugs are fixed)?
- **Scheme shape** (`scheme.md`): categories to merge, split, add, delete.
  Known judgment calls to look at: *smell-and-taste* also holds touch/feel
  words; *position* holds "put/place/spread/stack"; *condition* holds
  stuck/loose/dry/new/old/tipsy; *body* is the biggest category (390) and
  could split (parts vs. states); *learning-and-teaching* is the smallest (15).
- **Tiers** (`review/tiers.md`): the top-10 and top-100 especially. These came
  from English-side learning intuition, not community knowledge.
- **needs-human** (`review/needs-human.md`): 716 entries needing editor
  decisions (mostly recent in-process placeholders).
- Corrections can be anything from "move word X to category Y" (a one-line
  append) up to "rethink theme Z" (fold into a rerun, §4).

## 3. Import into the database (after sign-off)

Not yet implemented; the plan:

- A small importer reads `assignments.jsonl` (+ scheme.md for the slug set)
  and, per entry, replaces the old `cat` tuples with the new categories via
  `applyTransaction` — i.e. ordinary assertions: stamped with who/when,
  versioned, fully undoable, visible in entry history. No schema change
  needed for categories themselves.
- Open decision: how tiers live in the db. Options: prefixed pseudo-categories
  (`tier:top-100`), a separate per-entry tuple type, or stay outside the db as
  a learning-tools artifact. Decide with the team.
- Category *names* (vs slugs) live in one place (probably the importer config
  or a tiny table) so renames stay cheap.

## 4. Rerun recipe (v2 after specialist feedback)

The whole pass is reproducible. To rerun with revised instructions:

1. **Freeze the old run**: `cp assignments.jsonl assignments-v1.jsonl` (and
   commit) so v2 can be diffed against v1 per category.
2. **Refresh the dump**: `python3 dump_entries.py` (defaults to
   `~/mmo/database/db.db` → `entries.jsonl`).
3. **Fold feedback into the two instruction files** — these ARE the prompt:
   - `scheme.md`: rename/merge/split/add categories; keep slugs stable where
     meaning is unchanged; revise criteria lines (the criteria text is what
     drives consistent tagging).
   - `notes.md` conventions section: add/modify the boundary rules
     ("scatter→position", "fear→emotions", ...). Every team decision should
     land here as a one-line rule, not stay in someone's head.
4. **Start a fresh `assignments.jsonl`** (empty file).
5. **Tagging loop** (single context, multiple passes; no subagents — having
   the whole dictionary pass through one context is what makes the tagging
   self-consistent):
   - `python3 dictq.py batch <START> 155 --untagged-only` — read a batch
     (full view shows glosses + translations always, first example translation
     as marked weak evidence, old/v1 categories as evidence).
   - Append ~150 assignment records (heredoc `cat >> assignments.jsonl`).
   - `python3 dictq.py validate` after every batch (catches slug typos —
     correction = append a fixed record, later lines win).
   - Commit every ~5 batches: `Tagging pass: through N/8822`.
   - Resume after any interruption: `validate --show-missing` then
     `batch <pos> 155 --untagged-only`. ~60 batches ≈ one long session.
6. **Category-sweep audit**: `dictq.py members <cat>` for at least every
   judgment-boundary category; read each as a set; corrections are appends.
7. **Tier curation**: update the decision lists in `curate_tiers.py`, run it,
   append its output, validate.
8. **Views**: `python3 make_review_views.py`; commit everything.

Cost calibration from v1: tagging ~8,800 entries took ~60 batches of ~150;
validation caught 3 slug typos; the sweep found only ~6 real corrections in
~6,400 rows re-read (the conventions file is what kept it consistent).

## 5. Retrospective — what I learned about the language/dictionary
*(input for the next run's categorizer: read before tagging)*

**The unit is the root family, not the entry.** Mi'gmaq is polysynthetic; one
root yields 4–15 entries (vai/vii/vat/vit verb forms, nominalizations,
diminutives). The dictionary is ordered so families sit adjacent, which is the
single biggest consistency lever: tag the family when you meet its first
member, and the rest follow. RULE that emerged: the verb-class suffix *never*
changes the category; a derivational family shares its primary category.

**The prefix system is grammar, not topic.** Directional/manner/time prefixes
(al- about, el- toward, ejigl- away, enm- homeward, wejgw- toward speaker,
pem- along, apaj-/apat- back, nis- down, so'q-/toqju- up, eset- backward,
asoqom- across, saput- through, gesgij- over, giwto'q- around, nipi- at
night, naqs- quickly, mesta- completely, sangew- slowly, wisq- suddenly)
generate huge regular series. "Run up", "run home", "run at night" are all
*movement*. Exception: genuinely bi-domain derivations ("hunt at night" stays
hunting; "paddle by night" stays boats).

**Big systematic series to expect** (each hundreds of entries): metew- "heard
X-ing" → hearing; "have such/big/small BODYPART" → body; "clean BODYPART" →
cleaning+body; nuji-/-winu professional nouns → occupations(+domain);
house-by-material × has/lives-in/builds/resembles → dwellings; numbers with
shape classifiers (two-globular-objects) → numbers; tel- "in such a way" and
ta's- "how many" series; wel-/win- good-X/bad-X pairs across every domain.

**Polysemy is entry-level, not sense-level.** Some entries carry two unrelated
senses (glmuej mosquito|boil; go'gwejij spider|cancer; sapun hair|contrary
person; gli'gn flagpole|snack). Categories currently attach to the whole
entry, so these get awkward unions. A v2 with per-sense (per-subentry)
category support would fix this — needs a db-side decision first.

**Evidence quality ranking that worked:** gloss > translation > first example
translation (weak, never keyword-matched — examples are full of incidental
names/days that would mis-attract categories). The old hand categories were
right ~70% of the time and are worth keeping in the batch view as evidence;
they fail exactly where they're too fine (verb-gloss-as-category: "knit",
"smother") or junk (`_` ×232).

**The data has a placeholder tail.** ~600 entries with ids > 10^13 are recent
in-process editor work: `#<id>` headwords, TBA, crossed-out notes, French
heading fragments. Don't burn attention there — flag needs-human and move on
(v1 flagged 716 total). Also 738 Archived entries: tag them normally (cheap)
but keep them separated in review views.

**What I would do differently in v2:**

- **Make family-grouping explicit.** Add a `dictq.py family <stem>` command
  (prefix-match on headword) and tag family-at-a-time instead of relying on
  adjacency across batch boundaries — the few inconsistencies the sweep found
  were families split across batches.
- **Consider a second annotation axis for grammar patterns.** Learners would
  benefit from "all the wejgw- words" as much as from topic categories. A
  `pattern` field (prefix family, verb class) would be cheap to add during
  tagging and is orthogonal to topic. Ask the team if this is wanted before
  v2; it doubles the value of the same pass.
- **Decide the touch words up front.** I folded touch/feel into
  *smell-and-taste* mid-pass; it works but the name hides it. Either rename
  (Smell, Taste & Touch) or make a separate category — team call.
- **Pre-split the giants.** *body* (390), *movement* (380), *position* (300)
  are too big to review comfortably. Candidate splits: body → body-parts vs
  body-description; movement → going-places vs manner-of-motion. Decide
  before tagging; splitting later costs a re-read of the giant category.
- **Tier nominations were too conservative early.** I nominated while tagging
  A→M more sparingly than N→W (48 t10 / 390 t100 / 496 t1000 nominations,
  then curation to exactly 10/100/1000 plus 68 promotions found by a
  heuristic sweep). In v2, nominate generously while tagging (aim ~1,500)
  and let curation cut; promotion-hunting afterwards is the expensive
  direction. Also: the `rec` (recording count) field correlates with
  community priority and should be used as a tier signal from the start.
- **Write conventions as they happen — into the prompt files.** The single
  most valuable practice of v1. Every "hmm, where does X go?" decision became
  a one-liner in notes.md; consistency comes from there, not from memory.
- **Batch size ~150 with full view was right.** Bigger batches degrade
  attention on the tail; smaller wastes passes. Keep `--untagged-only`
  resume; keep validate-after-every-batch.

## 6. Feedback on the original proposal (as requested)

The original plan (dump → LLM proposes scheme → tag all → peer file → text
views → team audit → import) held up well. Refinements that proved out, and
were adopted:

- **Multiple passes over one context beat parallel subagents.** Consistency
  is the whole game in categorization; all the information flowing through a
  single context (survey → scheme → tag → sweep) is what made 8,822 entries
  come out coherent. Wall-clock didn't matter.
- **A fixed, reviewed-first scheme beats emergent categories.** Designing all
  85 categories after a full survey read, then never adding mid-pass, meant
  no drift and no re-tagging. The escape valve (notes/conventions) absorbed
  every boundary surprise.
- **An accruing query tool beats ad-hoc greps.** Every report used to make a
  decision is re-runnable by anyone (`dictq.py`); the transformations are
  separate named scripts. This is also exactly what makes the rerun cheap.
- **Append-only with later-lines-win** made corrections free and kept full
  history — the audit pass cost nothing to apply.
- **Plain-file artifacts in git** (now all Markdown) mean the team reviews on
  GitHub with no tooling, and every state of the project is a commit.

Where the proposal needed extension: tiers needed a *curation* step distinct
from tagging (nomination during tagging, exact selection after — one pass
can't pick "the" 100 while seeing 1% of the data); and the needs-human flag
turned out to be a first-class output — 8% of the dictionary isn't
categorizable without editorial work, and surfacing that list is itself
valuable.
