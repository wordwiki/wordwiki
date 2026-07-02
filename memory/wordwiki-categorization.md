---
name: wordwiki-categorization
description: "Lexeme re-categorization: v1 done, v2 pass prepped (2026-07-01) from elder feedback — faith/legends split, no traditions bucket, smaller cats, ordered cats; v2-instructions.md is the brief"
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

**V2 STATUS (2026-07-01): COMPLETE and pushed.** All 8,838 entries tagged
against the 96-cat/14-theme v2 scheme in one session (57 batches); §4 audits
done (all sensitive + split-pair sweeps clean, ~12 corrections appended;
order-audit yielded 9 reorders — death-first and tobacco-first rules);
tiers curated to exactly 10/100/1000 (curate_tiers.py now uses a
T1000_DEMOTE list — v2 over-nominated 1052, cut 52 by archived/unrecorded/
dup-gloss/variant criteria); review/ regenerated (stale v1 by-category files
git-rm'd first — make_review_views.py does NOT clean them). The v2 accreted
conventions are FOLDED INTO notes.md permanently (commit 137dad7): no dated
per-pass block — each rule lives in its home section (Core rules,
Faith/stories/spirits, Split-category boundaries, and a merged "Standing
conventions (v1 + v2, current slugs)" list). notes.md + scheme.md remain THE
prompt for the next pass, current as-is. 729 needs-human. Team reviews the
review/ v1→v2 diff on GitHub. **For v3 (after community feedback): read
`categorization/v2-retrospective.md` FIRST** — it has the setup steps
(freeze v2, add v2: evidence column to dictq, re-dump, re-batch the 729
needs-human against fresh English), the settled mechanics, the weak-judgment
families likely to draw feedback (pity/compassion, worship, aniaps-, ewl-),
scheme size pressure points, and the tier promotion candidates.
Original elder-feedback framing: The elder-reviewed decisions, which the next reviewer group
will judge v2 by: (1) sacred Christian vocabulary (Jesus, Mary, God,
Creator-words, angels, saints, heaven) got its own `faith` category — NEVER
filed with legends/ghosts (v1's spirit-world did this; hurtful to the
largely-Catholic readership); (2) "ceremony" means Mi'gmaq ceremony in this
community → church category renamed "Church Rituals" (`church-rituals`),
slug `ceremony` deliberately left free; (2b) "legend" is also a trivializing
word here — Glusgap etc. are core cultural figures (dictionary glosses him
"culture hero"), so the category is `traditional-stories`, display name
"A'tugwaqan — Traditional Stories" (Mi'gmaq word leads; final name is the
team's to choose), in its own theme with Ghosts & Spirits right after Faith &
Church — NOT grouped with music/games (theme company is an importance
signal); (3) no customs/traditions bucket —
it frames living culture as a museum exhibit; culturally central practices
get first-class categories instead (basket-making kept tight and standalone
per elder; new quillwork-and-beadwork, tobacco-and-smoking); (4) giants
split (body/movement/position/emotions/health/water/character); (5) cats
are ORDERED most-pertinent-first (drives related-words on entry pages; users
often see only the first). `categorization/v2-instructions.md` is the
self-contained tagging brief; conventions in notes.md; v1 frozen in
assignments-v1.jsonl (shown as evidence in dictq batch view; new dictq cmds:
family, order-audit).

The batch re-categorization of all wordwiki lexemes is complete (v1,
2026-06-11) and lives in `~/wordwiki/categorization/`:

- All 8,822 entries tagged with 1–3 of 85 categories (12 themes) in
  `assignments.jsonl` (append-only, later lines win); 716 flagged
  needs-human; curated learner tiers exactly top-10/100/1000 (cumulative).
- Team review artifacts are all Markdown (dz's request — GitHub-renderable):
  `review/` (overview, per-category lists, tiers, needs-human, old→new,
  low-confidence), `scheme.md`, `notes.md` (conventions),
  `categorization-design.md`.
- `categorization-design.md` §4–5 is the complete RERUN RECIPE + retrospective:
  v1 was deliberately done without specialist feedback so the team has
  something concrete to react to; expect a possible v2 rerun with their
  decisions folded into scheme.md + notes.md conventions (those two files ARE
  the prompt). Tools: dictq.py (read-only queries), dump_entries.py,
  curate_tiers.py, make_review_views.py.
- Category TABLE done (wordwiki/category.ts, liminal style): slug = stable
  id stored in assertions (immutable after create; '~' prefix = internal,
  test via isInternalCategorySlug, never a bare startsWith), renameable
  name, theme, description (public), tagger_notes (internal), retired
  (excluded from pickers; ~old-* imports born retired), managed order_key
  (seeding order = presentation order). Admin-only edits. Page:
  wordwiki.categoriesPage() (Admin navbar). Old cats import as `~old-body`
  (NOT bare ~body — name collisions); tiers as ~tier-top-10/100/1000.
- IMPORT done (wordwiki/category-import.ts, `./wordwiki.sh
  import-categories [dir] [--username=NAME] [--allow-production]`):
  idempotent two-step — seed table (scheme.md parse + 4 internal + retired
  ~old-* from current data) then per-entry assertion rewrite
  (computeDesiredCats is a fixed point ⇒ re-run = no-op, ~2s). Cat tuples
  live under SUBENTRIES (dct/ent/sub/cat); assignment cats go on the first
  subentry. Workspace requires strictly increasing timestamps ⇒ one
  assertion per tx (~26k txes, 4min); applyTransaction/allocTxTimestamps
  have quiet opts. Ran on dev db 2026-06-11: 8,008/8,822 rewritten, 348
  cats, 0 orphans; backup at ~/mmo/database/db.db.pre-category-import.
  Old-name == new-slug values (e.g. 'body') merge into the new cat (814
  entries unchanged). Re-run after each pull until production cutover.
- EDITOR SELECT done (CategorySelectField in lexeme-editor.ts): theme
  optgroups over active cats, retired/unknown current values kept as
  marked options, changed values validated server-side, free-text
  fallback on unseeded dbs. NOTE: a detached `new CategoryTable()` is off
  the dispatch tree — @path queries throw on serialize; always use
  ww.categories.
- PUBLIC FILTER done (publish.ts): all category emit points go through
  Publish.publicEntryCategories/publicCategories/publicCategoryName —
  '~' never renders publicly, display names + table order from the
  category table, raw-value fallback pre-import. Search terms are
  spellings+glosses only (no leak). OPEN: publisher never deletes —
  ~/mmo/categories/ keeps stale old-scheme pages (and stale entry pages
  generally); cleanup is an undecided follow-up.
- LEXICAL FORM TABLE done (wordwiki/lexical-form.ts): part-of-speech
  vocabulary, same shape as category table but slugs allow uppercase
  (PTCL — slug must EQUAL stored value). Editor select =
  VocabSelectField (generalized, serves category + part_of_speech);
  groupByTheme is generic. partsOfSpeech map in entry-schema stays as
  the public renderer's label source for now.
- LEXICAL FORMS IMPORT done (`./wordwiki.sh import-lexical-forms`,
  guarded, idempotent; lexical-form-import.ts): seeds 15 curated forms,
  normalizes ONLY unambiguous values (trim/case-fold to slug + alias
  'particle'→PTCL), reports the rest. Dev run 2026-06-11: 9,110
  subentries, 2 normalized, 873 empty POS, 22 distinct legacy values
  (~30 subentries) = the team's curation worklist ('Wp ini' ×7,
  'ni  mass' ×3, 'PlcN' ×2, na·dk/ni·dt/'fixed pl' singletons...).
  Lossy mappings deliberately left for humans; editor shows them as
  not-in-table options.
- CLI PUBLISH (`./wordwiki.sh publish [target...]`): no targets = full
  site; targets are the site's own URLs (entries/samqwan,
  categories/water, books/PDM/101, entry:ID...) — parsePublishTarget in
  publish.ts is the extension point. Read-only vs db, so wordwiki.sh
  leaves the server running (single page ≈ 2s). Errors/warnings →
  stdout, exit 1 on errors. PublishStatus has a WARNINGS channel
  (amber, calm — dz: errors panic users); renderAudio tolerates missing
  audio with a marker; publish = final validation (warns per entry with
  null recording). Built for the upcoming DIALECT work on the public
  site (fast template iteration).
- LEXEME-OPS SEAM (wordwiki/lexeme-ops.ts, ww.lexemeOps): assertion
  mutations as domain verbs returning OUTCOMES not UI directives
  (tombstoneFact with race outcomes; removeEntryFromCategory sweeps all
  subentries). LexemeEditor delegates. THE pattern for liminal pages
  needing assertion mutations: ops verb + thin page wiring (both worlds
  share tx`expr` → {action:'reload',targets}). Primitives: tombstoneFact
  + supersedeFields (field edit in place, refuses to resurrect).
  Users: category detail lists ALL entries (incl. unpublished —
  curation pages) w/ confirm remove buttons; lexical-form detail lists
  subentries READ-ONLY (dz: clearing a POS is not curation — a wrong
  POS gets fixed in the editor; never add a remove button there).
  Future: game lists, merges.
- AUTOMATED-CHANGE IDENTITY: '~' convention extends to usernames —
  isAutomatedUsername() in user.ts is THE test. ~category-import /
  ~lexical-form-import seeded disabled by seedUsersFromEntrySchema
  (rides along post-pull); imports stamp them by default. History
  dialog folds consecutive automated versions (<details>), deleted
  dialog badges 'by migration'; RESTORE BARRIER in restoreVersion:
  versions older than the fact's newest automated version are refused
  (stale vocabulary). Dev db's djz-stamped v1 history left as-is (dies
  at next pull). DEFERRED by dz: whether ~tier-*/~needs-human move out
  of dict into a side table for v2 (decided at v2 prompt time).
- MUTE PRINCIPLE (dz, 2026-06-12): renames of identifier-valued
  assertion data MUTE in place (assertion-mute.ts: muteAttr1Values —
  validated mapping, ALL history rows, one tx, completeness-verified,
  workspace invalidated); changes of CONTENT assert. Category import
  now mutes legacy values→~old-* (identity/authorship preserved, every
  historical version restorable), merge-case (old value==scheme slug)
  adopted untouched, ~old-* row description = durable rename record.
  Churn: 9,502 assertions vs 29,716 under v1 delete+create; 16
  tombstones (dup collapses) vs 10,124.
- MIGRATION RECIPE = ./migrateDevDb.sh (one program: stop → pull →
  import-categories → --expect-no-changes proof → import-lexical-forms
  (+proof) → verify-migration → serve+smoke). verify-migration
  (migration-verify.ts, read-only, exit 1 on failure): system users,
  one-current-version-per-fact, scheme==table, all cat values tabled,
  no orphans, tiers 10/90/900, POS fixed point; WARNINGS = human
  worklists (uncategorized entries = created-after-dump detector for
  production day; un-tabled POS). PRODUCTION-DAY recipe documented at
  top of migrateDevDb.sh (no pull, --allow-production, backup first,
  publish after). Rehearsed clean 2026-06-12: 0 failures, smoke ok.
- No orthography columns by design (later generic i18n project).

**Why:** categories matter hugely to language learners; dictionary is
fairly complete/slow-changing so batch process is the right workflow.

**How to apply:** for v2, follow design doc §4 exactly; read §5 first.
Single context, no subagents; conventions accrete into notes.md. Related:
[[wordwiki-toplevel-upgrade]], [[wordwiki-assertion-model]].
