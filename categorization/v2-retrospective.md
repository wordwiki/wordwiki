# v2 retrospective — handoff notes for the v3 pass

*Written 2026-07-01, immediately after completing the v2 tagging pass, by the
categorizer (an LLM). Audience: the categorizer doing v3 after the community
review, plus dz. The v3 prompt will presumably be: this file +
v2-instructions.md (updated) + scheme.md + notes.md + the community feedback.*

## 1. Setup steps v3 must do first (learned the hard way or by precedent)

- **Freeze v2**: copy/rename `assignments.jsonl` → `assignments-v2.jsonl` and
  start a fresh append-only file, exactly as v1 was frozen. Then teach
  `dictq.py batch` to show a `v2:` evidence column (it currently shows `old:`
  and `v1:`). A v2 tag under an *unchanged* slug is strong evidence; anything
  the community renamed/split/dissolved must be re-decided per the new
  mapping table — put that table in v3-instructions.md like §2 of v2's.
- **Re-dump entries.jsonl** from the live db first (`dump_entries.py`;
  db is `<repo>/mmo/database/db.db`, versioned `dict` table). The editor
  tail churns constantly; v2 had 16 entries newer than v1's dump, v3 will
  have more, and some of v2's 729 needs-human placeholders may have gained
  English — those need real tagging, and nothing will flag them for you:
  they *are* assigned (`cats: []`), so `--untagged-only` skips them.
  **Explicitly re-batch the needs-human set** against the fresh dump.
- `review/by-category/` is NOT cleaned by `make_review_views.py`. If any
  category is renamed/removed, `git rm -r review/by-category/` before
  regenerating, or stale files from the old scheme sit in the team's diff
  (this bit v2; the stale v1 files were still there).

## 2. Mechanics that are settled — don't rediscover

- `batch START 155 --untagged-only` windows by **position**, not by count of
  untagged: advance START by the batch size every time. An empty result
  mid-run means the window was fully tagged, not end-of-data.
- Global dictq flags (`--entries/--assign`) go BEFORE the subcommand.
- The loop (heredoc append → `validate` after every batch → commit every 5)
  produced 0 slug typos in 57 batches. Keep it exactly.
- ~155/batch is right for the main dictionary; the high-id tail (~600
  entries, ids > 10^13) is ~half placeholders and goes 3× faster — you can
  take bigger windows there without losing tail attention.
- Budget reality: v2 did all 8,838 + audits + tiers + views in one session
  with one /compact at the start. ~57 batches, not 60.
- `order-audit` yielded 65 hits of which only **9** were real reorders. Most
  hits are legitimate broad-first (speak-X-language → talking; bedroom →
  dwellings; teacher → occupations). Re-look at each, but expect ~85% keeps.
- `curate_tiers.py` is now a **demote** model (v2 over-nominated 1,052;
  52 were cut to hit 10/100/1000 exactly — criteria documented in the file).
  If v3 re-nominates, recompute the demote list from the new pool; don't
  reuse v2's blindly. The asserts catch count errors. verify-migration
  expects exactly 10/90/900.

## 3. Where v2's judgment is weakest — likely community-feedback targets

`review/low-confidence.md` is the map of concentrated uncertainty. Recurring
calls that were *decided by convention, not confidence* (all conf m):

- **pity/compassion family (ewlite'lm-/ewlite't-)**: split between
  social-life (compassion FOR someone = caring) and fear-anger-sadness
  (self-pity, sad states). The line is defensible but wobbly — if feedback
  touches any of these, re-sweep the whole family for one consistent rule.
- **worship (emtoqwalatl/emtoqwatg)**: tagged [love-and-joy, faith] on the
  strength of an affectionate example. If elders read "worship" as sacred
  first, flip both — they are the only two.
- **aniaps- penance family** (~15 entries): glosses drift between church
  penance and secular "suffers the consequences"; all went church-rituals.
  A single elder ruling moves the family wholesale.
- **want/need words → thinking**, **reach/touch → smell-and-taste**,
  **"in the way" → putting-and-placing**, **sinking-in → falling**: all
  convention picks where no category is obviously right. Consistent, but if
  reviewers balk at one member they'll balk at the family — fix families,
  not entries (dictq family STEM).
- **ewl- (poor/miserable/wretched) root family** is deliberately scattered
  (money-and-trade / condition / social-life / fear-anger-sadness by sense).
  Reviewers reading alphabetically will see the scatter; be ready to defend
  or unify.
- **mjijaqamij [faith, spirits]** and **tobacco-and-smoking covering both
  ceremonial and everyday smoking** were explicit elder decisions in v2 —
  if the wider group pushes back, that's a scheme conversation for dz, not
  a tagging fix.

## 4. Scheme pressure points (if feedback says "still too big / too small")

- Biggest judgment buckets: social-life 228, ways-of-moving 217,
  putting-and-placing 212, food 219, dwellings 208 (dwellings is inflated by
  the editor tail's house-by-material series — dozens of near-duplicates).
  These are the natural next splits if "smaller categories" comes back.
- Smallest: quillwork-and-beadwork 9, learning-and-teaching 16, wrongdoing 19,
  death-and-mourning 24, tobacco-and-smoking 24. Quillwork was
  elder-mandated standalone (like basket-making) — do NOT merge it for size
  reasons without an explicit instruction.
- 729 needs-human — almost all editor-tail placeholders. If the team cleans
  the tail before v3, re-tag; if not, they'll roll forward again, and the
  review overview will keep reporting them (that's fine, it's honest).

## 5. Tier notes

- T10/T100 are still the v1-curated lists (deliberately — an elder-auditable
  baseline). v2's over-nominations that were *not* promoted are visible in
  review/tiers.md; the ones I'd argue for if the team engages: Se'sus,
  Nisgam, Se'ta'n, waltes, wisqoq, sweetgrass (weljemajgewe'l), tia'm,
  te'sipow, wigwom, ugjigsu'g (family), wilu (food), and the kinship set
  promoted during v2 tagging. Any promotion = edit the lists in
  curate_tiers.py, rerun, append, validate — never hand-edit tiers.
- The 52-demotion list (dup-gloss pairs, spelling variants, mid-decades) is
  English-side intuition; it's flagged in the file for team audit. If they
  restore one, something else must drop to keep 1000 exact.

## 6. Sensitive-point checklist that must survive v3 unchanged (unless dz says otherwise)

Faith = Christian sacred vocabulary only; church-rituals = practice;
traditional-stories = Glusgap-and-company, never "legend"/"myth" in anything
we write; spirits = ghosts/shamans/spells/fortune-telling; no customs bucket;
death words death-and-mourning-first; categories ordered
most-pertinent-first. v2 ends with all of these verified clean
(faith/traditional-stories/spirits/church-rituals swept as complete sets) —
v3 should re-sweep them regardless of what the feedback touches, because
they are what the community judges the whole scheme by.
