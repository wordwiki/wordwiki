# v2 categorization pass — complete instructions

*Written 2026-07-01, after language-team feedback on v1 and a planning
session. This document + `scheme.md` + the conventions in `notes.md` ARE the
prompt for the tagging pass. If you (the categorizer — an LLM, probably the
one that wrote this) are reading this in a fresh context: read all three
files fully, then start at §3. The v1 retrospective in
`categorization-design.md` §5 is worth reading too — it describes the shape
of the language (root families, prefix system, big systematic series).*

## 1. What this is

Re-categorize all ~8,838 dictionary entries against the v2 scheme (96
categories, `scheme.md`). This v2 output goes to a **large community review
group** — most reviewers will look exactly once, so correctness on the
sensitive points (faith/traditional-stories/spirits separation, no
"traditions" bucket,
category order) matters more than anywhere else.

v1 (85 categories, all 8,822 entries) is frozen in `assignments-v1.jsonl`
and appears in the batch view as `v1:` evidence.

## 2. What changed since v1 — the non-negotiables

1. **faith / church-rituals / traditional-stories / spirits are separate.**
   Christian sacred vocabulary (Jesus, Mary, God, Creator words, angels,
   saints, heaven, hell, devil, soul) → `faith`; church practice →
   `church-rituals`; Glusgap-and-company → `traditional-stories` (named
   A'tugwaqan — these are core cultural figures, never "legends"/"myths" in
   any text we write); ghosts/shamans/spells/fortune-telling → `spirits`.
   Never file sacred Christian words with traditional stories or spirits.
   Full rules: notes.md "Faith / traditional stories / spirits".
2. **No customs/traditions bucket.** Its members go to first-class homes
   (quillwork-and-beadwork, tobacco-and-smoking, games, leadership-and-law,
   stories-and-writing, family, plants, clothing...). notes.md "Dissolved-
   customs homes".
3. **Giants are split.** body → body-parts/body-descriptions; movement →
   going-and-coming/ways-of-moving; position → posture/putting-and-placing;
   emotions → love-and-joy/fear-anger-sadness; health → sickness/healing/
   death-and-mourning; water → water/sea-and-rivers; character →
   character/wrongdoing. Boundary rules: notes.md "Split-category boundaries".
4. **Categories are ORDERED, most pertinent first.** First = the category
   whose related-words page best serves a learner on this word's page;
   specific beats broad. The site leads with the first category.

### v1 → v2 slug mapping (for reading `v1:` evidence)

| v1 slug | v2 destination |
|---|---|
| body | body-parts OR body-descriptions |
| movement | going-and-coming OR ways-of-moving |
| position | posture OR putting-and-placing |
| emotions | love-and-joy OR fear-anger-sadness |
| health | sickness OR healing OR death-and-mourning |
| water | water OR sea-and-rivers |
| character | character OR wrongdoing |
| ceremony | church-rituals (Mary/saints/sin → faith; wakes → death-and-mourning) |
| spirit-world | faith OR traditional-stories OR spirits — decide per word |
| customs | see "Dissolved-customs homes" in notes.md |
| everything else | same slug, same meaning |

An unchanged slug means the v1 tag is strong evidence (v1 was right and
internally consistent; old hand cats were only ~70% right). A split/renamed/
dissolved slug means: re-decide from the English, using the boundary rules.

## 3. The tagging loop

Work from `categorization/`. All ~8,838 entries, in entry order (families
sit adjacent — tag the family when you meet its first member; use
`python3 dictq.py family STEM` whenever a family straddles a batch
boundary or you want to see all derived forms at once).

Per batch (~150 entries, full view):

1. `python3 dictq.py batch <START> 155 --untagged-only`
   Fields: `id|headword|pos|glosses+translations|old:handcats|v1:v1cats
   [ARCHIVED] ex:first-example`. Evidence order: gloss > translation >
   example (weak) ; old/v1 cats as evidence per the mapping above.
2. Append ~150 records to `assignments.jsonl` (heredoc `cat >>`):
   `{"e": ID, "cats": ["most-pertinent", "second"], "conf": "m",
   "tier": "t100", "flag": "needs-human", "note": "..."}`
   - `cats` 1-3, ORDERED (rule §2.4). Omit `conf` when high ("m"/"l" otherwise).
   - `flag: "needs-human"` + `cats: []` for placeholders/no-English
     (`#id` headwords, TBA, `?`, editor notes). Don't burn attention there.
   - Archived entries: tag normally, cheaply.
3. `python3 dictq.py validate` after EVERY batch (slug typos). Corrections
   are appends — later lines win; never edit earlier lines.
4. Commit every ~5 batches: `git commit -m 'v2 tagging: through N/8838'`.
   Resume after any interruption: `validate --show-missing`, then
   `batch <pos> 155 --untagged-only`.

**Tier nominations while tagging (do it generously this time):** nominate
~1,500 total — every plausible everyday word. `tier: "t10"` for absolute
first words, `"t100"` for first-conversation words, `"t1000"` for working
vocabulary. The `rec` count (recordings, visible via `dictq.py entry ID`)
correlates with community priority — prefer recorded words. Curation cuts
down later; promotion-hunting afterwards is the expensive direction, so
over-nominate.

Budget: ~60 batches. v1 did this in one long session; if context runs low,
commit, note the position, /compact, and resume — the instruction files
carry everything needed.

## 4. After tagging: audits

1. **Category sweeps** (`dictq.py members CAT`): read as a set, at minimum
   every judgment-boundary category — all of Faith & Church, Traditional
   Stories & Spirits, and Music & Games; both halves of every split pair
   (checking the boundary held); quillwork-and-beadwork and
   tobacco-and-smoking; plus the v1
   judgment list (social-life, character, wrongdoing, appearance, thinking,
   seeing, hearing, smell-and-taste, talking, work, occupations,
   making-and-fixing, good-and-bad, condition, amounts, greetings...).
   Corrections = appended records.
2. **Order audit**: `python3 dictq.py order-audit` — every hit is a re-look
   (broad-first is occasionally right; most hits won't be). Fix by appending
   the same cats reordered.
3. `validate` clean, commit.

## 5. Tiers, views, wrap-up

1. Update the T10/T100 decision lists in `curate_tiers.py` if the
   nominations changed the picture; run it; append its output; validate.
   (v1 entry ids are stable, so the v1 lists are a valid starting point.)
2. `python3 make_review_views.py` — regenerates `review/` (overview,
   by-category, tiers, needs-human, old-to-new, low-confidence).
3. Spot-check `review/by-category/` for the sensitive categories: faith must
   contain no traditional-story figures, traditional-stories no Christian
   sacred words, and there must be no customs file.
4. Commit everything; the diff of interest for the team is
   `review/` v1 → v2.

## 6. Mechanics reference

- Batch size ~150-155 full view is calibrated; bigger degrades tail attention.
- Never keyword-match example sentences.
- New-entry tail (~16 entries new since v1, high ids) has no v1 evidence —
  normal tagging.
- `dictq.py` is read-only over the data; transforms are named scripts.
- assignments.jsonl is append-only, later-lines-win, full history kept.
