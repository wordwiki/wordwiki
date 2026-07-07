# Fix orthographies: narrow `variant` to orthography

Living design doc.  Original proposal dz 2026-07-06; merged with review
discussion (claude) 2026-07-07.  Future updates go against this file.

## Background

The language community that is the primary user of this dictionary writes in
multiple significant orthographies.  The current dictionary is mostly in the
Listuguj orthography, used by a small percentage of Mi'gmaq people; the
largest group writes in Smith-Francis.  Internally the dictionary also has
content in the Modified Pacifique and Pacifique Manuscript orthographies
(content transcribed from the PDM dictionary).

(Orthographies are *written* conventions.  Speech varies by dialect/region,
which is the separate locale problem — this distinction is what keeps
recordings out of the orthography system below.)

The software has always supported multiple orthographies structurally: in the
model, Mi'gmaq text is never a field on a relation, always a subrelation, so
the text can naturally repeat once per orthography.  The field naming the
orthography is presently called `variant`.

`variant` was originally intended to also model locale (e.g. "this word is
only spoken in Cape Breton") — that's why glosses and other subtrees carry
it.  Locale was never fully fleshed out and is a broken model anyway.

**The decision: `variant` becomes orthography, only.**  A second mechanism
will be built for locale (see "Regional variation" below).

The driving motivation is the pending Smith-Francis transliteration of the
dictionary (see "Auto-transliteration" below): growing an SF dictionary
alongside the Listuguj one requires the orthography model, the
per-orthography publish gate, and the approval machinery to all be sound
first.

## The target model

entry-schema.ts has been walked and every variant field classified:

- `$notVariant: true` — the field never really was an orthography (it rode in
  from the locale intent).  Dropped in the migration (gate: see scan below).
- `{$type: 'variant'}` — pure Mi'gmaq text, orthography required.
- `{$type: 'variant', $mixed: true}` — Mi'gmaq text potentially mixed with
  other-language text (English, French).
- `$allowAll: true` — additionally permits the `'mm'` ("All Mig'maq-Mi'kmaq")
  value: one stored value that renders in every orthography.
- `$defaultAll: true` — new content defaults to `'mm'` instead of the
  editor's primary orthography.
- `$metaVariant: true` — on control fields (todo, status): the *state* can be
  per-orthography.  A todo defaults to all-orthographies but can be scoped to
  one; making a word public is inherently per-orthography (see "Status").

Example — `public_note`:

    variant: {$type: 'variant', $mixed: true, $allowAll: true, $defaultAll: true},

A note is usually pure English (or includes its own per-orthography
respellings inline), so it defaults to `'mm'` and shows in whatever
orthography the dictionary is rendered in — but *can* be respelled per
orthography when needed.

The reason `$defaultAll` exists: language editors have a primary orthography
they work in (most have exactly one), so new content's orthography populates
from the new `primary_orthography` field on their user record; `$defaultAll`
overrides that with `'mm'` for fields that are usually orthography-neutral.

Decisions attached to the model:

- **`spelling` never gets `$allowAll`** — a spelling is by definition *in*
  one orthography.  (This also keeps duplicate-spelling detection crisp; the
  1 current `spl` row with variant `mm` gets migrated to explicit.)
- **`'mm'` semantics are defined once, centrally** — a single shared
  predicate (`variantMatches(fieldVariant, renderOrthography)` or similar),
  because at least four consumers must agree exactly: rendering, search,
  publish, and duplicate-spelling detection (spelling-duplicates.ts currently
  compares raw values and would wrongly treat `mm` vs `mm-li` as a
  cross-orthography pair).
- **`$allowAll` is a QUERY-PLANNING fact, not just an editor affordance**:
  it statically determines the shape of match-finding queries per tag.  A
  tag without `$allowAll` keeps the exact form (`variant = :O` — tight,
  index-friendly); an `$allowAll` tag must query exact-or-wildcard
  (`variant IN (:O, 'mm')`).  So `variantMatches` needs a SQL-side twin
  that consults the schema flag per tag — and denying `$allowAll` on
  spelling has a concrete payoff: the duplicate-spelling probe stays a
  pure exact match.
- `primary_orthography` on the user record is the *initial* value for a
  session-level "working orthography" the editor can switch (a few editors
  work in two), not the only source.  Needs the liminal schema-upgrade path;
  the `test` robot user needs a value too or tests get noisy.

## Data scan (2026-07-07, live db, current rows)

The first task was to scan whether the `$notVariant` fields are ever filled
in.  Result — **the drop gate is cleared**; every `$notVariant` field
contains only blank/`mm`/`mm-li`:

| tag | relation             | blank/null | mm-li | other                     |
|-----|----------------------|-----------:|------:|---------------------------|
| tra | translation          |      8,388 |    35 | 1 × literal string "null" |
| gls | gloss                |     13,392 |    24 | 2 × literal string "null" |
| etr | example translation  |      7,933 |    12 | —                         |
| erc | example recording    |      7,073 |   531 | —                         |
| prn | pronunciation guide  |         13 | 8,321 | —                         |
| src | source               |        783 |     0 | —                         |
| rec | recording            |     20,757 | 1,628 | 1 × mm                    |

(The literal `"null"` strings are an old serialization bug; also droppable.)

The scan also surfaced dirt in the *keeper* fields that the migration must
address:

- **`spl` has spelling text in the variant column**: 6 current rows carry
  variants like `us's'g`, `panipja'sit`, `gaqigiwto’qwamgitg` (more in
  history) — a data-entry bug from some old widget.  Hand-triage, not
  rule-based migration.  (The rescued parentheticals/typos have a natural
  destination once per-tuple annotations exist — below.)
- **Blanks in genuinely orthographic fields need a per-tag backfill policy**:
  spl 191, alx 154, etx 31, rtl 353, sta 432, tdo 585 blank rows.  "Blank
  means mm-li" is probably right for most (the corpus is Listuguj-dominant),
  but it is a per-tag decision — e.g. blank `tdo` under `$defaultAll`
  presumably becomes `mm`, while blank `sta` becoming `mm` vs `mm-li`
  changes what "public" means per orthography.  The migration command takes
  an explicit per-tag mapping, not a global default.
- Blank `''` and `NULL` both occur everywhere — normalize to one
  representation in the same pass.
- `rse` has genuine multi-orthography use already (mm-pm ×11, mm ×15) — the
  model's promise is real, not theoretical.

## Migration mechanics

- Follow the `normalize-shoebox-dates` precedent: mute-in-place on current
  rows (history keeps its original values), idempotent, `--expect-no-changes`
  proof mode, refuses a production db without `--allow-production`.
- The scan becomes a permanent wordwiki.ts subcommand whose *pass* is a
  precondition the migration re-checks at run time (protects against data
  moving between now and migration day).
- The VersionedDb validator learns the new invariants (variant required on
  orthographic text tags, absent on dropped tags, value ∈ orthography
  vocabulary ∪ {'mm'} where allowed) — this makes the migration provable and
  prevents regression afterwards.  Flip to throw-on-load after the migration.
- Index: likely a current-rows partial index involving `(ty, variant)` in
  createAssertionDml.  New index lines now apply to existing dbs
  automatically at serve startup.
- **Cleanup reports for the language staff** (dz): the scan's dirt lists
  become report pages on the STAGING server that the language people work
  from — garbage `spl` variants, blank-variant lists per tag, filled
  `$notVariant` oddities.  Lexeme links in these reports point at the OLD
  live server (a configurable link-base), so fixes are made there; re-running
  the import + stage process refreshes the reports.  This turns the
  hand-triage items into a self-draining queue instead of a one-shot editing
  session.

## Findings publish path (migration reports)

Settled 2026-07-07 (dz + claude, all points agreed).  The batch migrators
and validators keep discovering things and logging them to the console,
where they get missed — and even when caught, they have to be hand-reported
to the language person.  Deciding the publish path NOW, before the
orthography migration wave, is critical.  The design:

- **Findings are structured data reported through an API, not teed stdout.**
  Each migrator/validator gets a report handle — `report.section(title)`,
  `report.finding(...)`, `report.table(rows)`,
  `report.lexemeLink(entry_id, text)` — that BOTH prints to console (nothing
  lost there) and accumulates for the report.  The report contains only
  curated findings; tee-ing the raw log would just re-bury findings in the
  same noise, in HTML.
- **Fragment per step, assembled unconditionally.**  importWordWikiV1Db.sh is ~10
  separate deno invocations; each subcommand writes
  `import-report/<NN>-<step>.md` (a re-run of one step replaces just its
  fragment).  A final assemble step — run via shell `trap`, so it happens
  even when a step crashes — concatenates into `import-report.md` with a
  generated EXECUTIVE SUMMARY at top: finding counts per section, and
  "step N CRASHED" when it did.  A crash mid-migration is exactly when the
  report matters most.
- **Markdown as the authored format** (readable in terminal and git diffs,
  trivially authorable from tools, and liminal/markdown.ts already renders
  it).  The assembled .md is COMMITTED — staging gets code via git pull, so
  committing is how it travels, and it gives point-in-time history of every
  migration's findings for free.
- **Served on staging via a small authenticated route** that renders the
  committed .md with markdownToMarkup under the normal page template.  (A
  static .html in resources/ would also work — resources are served
  unauthenticated, but that is NOT a concern here: the complete db contents
  are CC-share-alike by founding decision — the dictionary is owned by the
  whole community and must have public and open licensing, unlike the
  many language projects whose secrecy means all the work is lost when
  they shut down.  The authenticated route is kept anyway as the tidier
  mechanism: no pre-render step, styled for free.)
- **Every report is stamped with its generation time, prominently** — a
  header banner with generated-at timestamp and source-db identification, so
  a reader understands this is a POINT-IN-TIME record, not a live view.
- **One findings vocabulary, two renderers** — unify with the cleanup
  reports above: the scan/validator functions produce findings-as-data; the
  migration report serializes them to markdown at migration time, and the
  live report routes render the same queries against the current db
  (self-draining as fixes land).  One link helper with the two configured
  bases (staging app + legacy live server); migrators never hand-build URLs.
- Clients: the scan subcommand (its first), verify-migration,
  verify-workspace, the variant invariants, and every migrator in
  importWordWikiV1Db.sh.

## Status: the per-orthography go-public decision

Publication (`published_from/to`) is per-fact, but that is not sufficient:
an incomplete lexeme with all its (incomplete) content approved has no
unapproved facts, yet is not ready to be public.  **The initial going-public
decision is an explicit decision made by a human editor, at the lexeme
level, separately per orthography.**  A single approval on the top-level
entry tag would capture the explicitness but not the per-orthography
separation — hence `$metaVariant` on status.

The conflict: status presently encodes much more than publicness (Archived,
InProcess, OnHold, PDM-only…), and most of that does NOT want to fork per
orthography — archiving in particular is surely whole-lexeme (the data
agrees: current Archived rows are 737 × mm-li + blanks; nobody archives per
orthography).  So status needs remodeling; dz will propose that separately.
Shape suggestion to evaluate there:

- split into (a) **lexeme lifecycle** (Archived, InProcess, OnHold, …) —
  whole-lexeme, exactly one, no orthography forking; and (b) a
  **per-orthography publish gate** — one fact per orthography, set by an
  explicit human verb ("Make public in Smith-Francis…"), participating in
  revision tracking so who/when is recorded, gated by approve permission.
- "word is public in orthography O" then composes: gate(O) is set AND the
  rendered facts are the published dimension filtered by variantMatches(O).
- the 309 current `Completed`-with-blank-variant rows and 432 blank `sta`
  variants are this proposal's backfill problem (blank Completed → mm-li,
  presumably, since the current public site is Listuguj).
- designing status in *parallel* to the publication dimension would risk two
  overlapping publicness mechanisms — co-design them.

### Concrete draft (claude 2026-07-07; CONFIRMED by dz; BUILT + dev-migrated 2026-07-07)

**BUILT (2026-07-07), then CONVERTED TO THE NORMAL MODEL (dz: "I was
imagining these fields just being normal data fields"):** `pub` facts are
ordinary data — they render as generic editable tuples (dialogs, history,
changes mode, review participation, all standard), any editor can PROPOSE
one, and THE GATE IS THE PUBLISHED DIMENSION: a word is public in O iff a
pub fact for O is published-current (a pending proposal gates nothing).
The original born-published verb design is retired; `makePublic`/`withdraw`
survive as approver SUGAR composed from the normal ops (insert the proposal
if needed + approve it / tombstone + approve the deletion — self-approval
allowed because the verb itself is approve-gated and a presence-only gate
has no content for the two-person rule to protect).  The editor's Public
row is a READ-ONLY per-orthography summary (public ✓ since/by, proposed
pending, withdrawal pending, —) with the sugar verbs behind its ☰.  Also
built: the schema (lifecycle-only `sta` — no variant, `Complete` renames),
the `entryIsPublicIn` composition rule (publishedEntries = published
projection ∘ gate), and the `migrate-status` command
(once-per-db config marker like the publication backfill; dry-runnable;
decisions as changeable constants; step 10 of importWordWikiV1Db.sh, BEFORE
migrate-variants so gates can read the sta variant).  Dev migration: 6,973
gates, 6,974 renames, 7,917 sta variants blanked, 983 'Unknown' lifecycles
synthesized; committed record status-migration-report.md.  The ONE
CompleteAsPDMOnly word left the public site (named in the report) — note the
old isPublished had INCLUDED PDM-only words, contradicting this doc's
premise; with exactly one word affected, the confirmed no-gate mapping
stands.


Two relations replace today's overloaded status:

**`sta` (kept tag, narrowed): lexeme lifecycle.**  Whole-lexeme, exactly one
current tuple, NO variant field (drops in the migration like the $notVariant
fields).  Fields: `status_id` pk, `status` enum, `details` string (kept).

    lifecycleStates = {
        'Unknown':            'Unknown Status',        // migration fidelity; retire later
        'InProcess':          'In Process',
        'InProcessPDMOnly':   'In Process - For PDM Only',
        'OnHold':             'On Hold - To Be Processed',
        'Complete':           'Complete',              // content-complete; says nothing about publicness
        'CompleteAsPDMOnly':  'Complete As PDM Only',
        'Archived':           'Archived',
        'ArchivedIncomplete': 'Archived - Incomplete',
        'ArchivedNotAWord':   'Archived - Not A Word',
        'ArchivedDuplicate':  'Archived - Duplicate',
    }

(Values deliberately map 1:1 from today's `states` — a mechanical migration.
`Completed` renames to `Complete` to break the old "complete = public"
reading.  The `Archived*` prefix convention carries over unchanged.)

**`pub` (new tag): the per-orthography publish gate.**  One fact per
orthography; the fact's *presence* is the gate.  Fields: `public_id` pk,
`variant {$type: 'variant', $metaVariant: true}` (the orthography) — nothing
else; who/when/why come free from assertion columns + revision tracking.

- Verbs: `makePublic(entry_id, orthography)` / `withdraw(entry_id,
  orthography)` — approve-permission-gated, explicit confirm; withdraw
  tombstones the fact (history preserved).  A `pub` fact is born-published
  (the verb itself carries approve permission, like the publication verbs'
  never-published carve-out) — it does not queue for second approval.
- Editor UI: a "Public" row on the entry showing per-orthography chips
  (`Listuguj ✓ since 2026-03-01 (dmm)`, `Smith-Francis —`), verbs behind the
  row ☰.

**The composition rule** — a word is public in orthography O iff:

    lifecycle is not Archived*  AND  pub(O) is current
    AND (facts rendered = published dimension ∩ variantMatches(O))

Archiving does NOT tombstone `pub` facts: un-archiving restores prior
publicness (and the gate history stays honest).  [dz to confirm this choice.]

**Migration mapping** (old `sta` (value, variant) → new):

| old                                | new                                    |
|------------------------------------|----------------------------------------|
| Completed, mm-li or blank          | sta=Complete + pub(mm-li)              |
| CompletedAsPDMOnly, any            | sta=CompleteAsPDMOnly, no pub          |
| InProcess/OnHold/Unknown/etc, any  | same lifecycle value, no pub           |
| Archived*, any                     | same lifecycle value, no pub           |

(CompletedAsPDMOnly gets no gate on the assumption those words are not on
the public site today — the publisher gates on `Completed`.  [dz to
confirm.])

## Per-tuple annotations: internal note + public aside

Every tuple gets TWO annotation fields, stored as columns on the assertion
table (peers of `variant`), so they exist uniformly on every record and
participate in revision tracking:

1. **internal note** — a place for per-field internal data: rarely needed
   but long-term very valuable (future researchers, collaborators).
2. **public aside** — qualifying text rendered next to the data field (or in
   the head for things like example).  This is where the weird special cases
   go that currently either aren't representable or leak into the data
   fields (a parenthetical of English inside a Mi'gmaq text field).

Why two: users stuff internal yappage into whatever field exists.  Fields
that don't show to the public get polluted with internal notes; when there's
no internal place, public fields get polluted instead — and the author won't
realize they're polluting the published product.  Two fields drain the
swamp, and the migration's spl-variant cleanup gets a destination for
rescued text.

Mechanics and decisions:

- **The dict table already has an unused `note` column (0 rows use it;
  `confidence_expr` and `tags` are also unused)** — the internal note can
  simply BE `note`.  Only the public aside needs a new column (working name:
  `aside`; "Public Annotation" is long and "annotation" is jargon for the
  volunteer audience — UI prompt something like "Note (shown with the
  word)").  Avoid "note" in the public field's *name*: `nte` and
  `public_note` already exist and three kinds of note is a support burden.
- Because the annotations are columns on the tuple, they automatically
  inherit the tuple's own orthography scope: a per-orthography fact's aside
  is per-orthography, an orthography-neutral fact's aside is shared.  No
  recursive variant-on-the-annotation machinery needed.  ($mixed-style
  content — English with embedded Mi'gmaq — is fine in both.)
- **Editor bulk**: both fields default not-shown, with a reveal affordance
  (the change-comment pattern), so the dialogs stay calm.
- **RESOLVED (dz 2026-07-07) — annotation edits go through the NORMAL
  approval flow**, internal notes included.  Reasons: internal notes are
  seldom edited so the approval burden is small; an exemption introduces a
  model inconsistency; exempted edits would be changes nobody else sees —
  the review queue is the change-*visibility* mechanism, not just a publish
  gate; and in practice the two-approver model is already relaxed
  (approve-all).  One follow-on for the review UI: the diff display should
  show annotation deltas distinctly from value deltas (extend the
  was-annotation), so approvers see at a glance that only a note moved.
- **Naming (dz): `aside`, used consistently in UI and code** (replacing the
  earlier "public note" working name).  Editor shows a short helper text
  that it is displayed publicly (the editor preview shows it anyway).
  Internal notes get a clearly SEPARATE presentation — suggestion: aside
  previews styled as public content; internal note styled muted like the
  change-comment gray, prompt along the lines of "Internal note (never
  published)".

## Rendering in an orthography: variant fields are LEAVES

Rendering content in a particular orthography O is a filter over the tuple
tree: a tuple with a variant passes iff `variantMatches(variant, O)`;
variant-less tuples pass; a filtered-out tuple drops its whole subtree.

dz audited the schema (2026-07-07): **every variant field is currently on a
leaf relation**, so the filter is a straightforward filter of leaves.  If a
variant-bearing node had children, subtree filtering would silently make a
descendant with an *opposing* specific orthography unreachable in its own
orthography's rendering — an unstated inconsistency in the model.  Stated
now:

- **For now: variant fields must be leaves.**  Enforced at SCHEMA PARSE in
  model.ts (a relation with a variant field may not have child relations) —
  a parse error, not doc prose someone forgets.  Rides in stage 1 with the
  `$` flag parser.
- **If interior variant nodes are ever allowed**: within a subtree rooted at
  a node with a *specific* orthography V, every variant-bearing descendant
  must be V or `mm`.  (An `mm` interior node passes every filter, so its
  children are unconstrained — they filter individually; `mm` descendants
  under a specific V render whenever the subtree does.)  This becomes a
  data-level validator invariant at that point.

## Auto-transliteration (the motivation for this whole fix)

The pending Smith-Francis transliteration is WHY the orthography fix is
happening now.  Listuguj → Smith-Francis transliteration is ~95% correct
algorithmically, so the process is automated with the language expert acting
mostly as an approver, correcting the wrong ~5%.  Settled design
(dz + claude 2026-07-07, all points agreed):

**Core mechanism.**  A button in the lexeme editor transliterates the word's
Listuguj texts into Smith-Francis, creating UNAPPROVED sibling facts (variant
mm-sf) owned by a new `auto-transliterate` system user.  The human then goes
through the normal approval mechanism — approving, or editing the wrong
cases in place.  The two-person rule does real work for free: the author is
a robot, so ANY human approver satisfies it.

**One word at a time, at edit time — never a bulk pass.**  Transliterator
improvements made while working word n are available for word n+1, and the
review queue stays honest: only words someone is actively working on carry
pending changes.

**Button rules:**

- Only FILL GAPS: never propose over an existing human-authored SF text.
- Never re-propose a transliteration a human has rejected, UNLESS the auto
  output has changed since (see version stamp).  Re-offering the same wrong
  answer after a human said no erodes the trust the workflow depends on.
- Stamp the transliterator version in `change_arg` on every proposed fact.
  Per-version quality metrics and the resurrection rule both need it;
  costs nothing now, unrecoverable later.
- v1 scope: pure (non-`$mixed`) text fields only.  Transliterating mixed
  English/Mi'gmaq text is a different, harder problem.

**The complacency problem (the "almost-there self-driving car").**  The
danger: a user believes they are contributing by clicking auto-transliterate
then approve-all without reading — growing the SF dictionary while actually
polluting it.  Protections, structural over advisory:

1. **Approve-all EXCLUDES auto-authored facts by default** (not a warning —
   warnings train click-through).  Auto-transliterations are approved
   per-fact; keyboard-driven editing + approve-in-place makes that a
   keystroke per fact, so the added friction is exactly the "human must
   read each one" we want.  An explicit separate "also approve N
   auto-transliterations" action is the escape hatch.
2. **The review row shows the EVIDENCE**: the Listuguj source rendered right
   next to the proposed SF.  The reviewer validates SF-against-Listuguj, not
   old-vs-new; if checking requires navigating away, even diligent reviewers
   rubber-stamp.  Probably the highest-value measure here.
3. **Objective rubber-stamp detection**: the activity report gains
   "auto-transliterations approved unchanged vs corrected, per approver, per
   period".  A diligent reviewer corrects ~5%; a 0%-corrector over hundreds
   of approvals is statistically visible without any human re-review.  The
   same stat per transliterator version measures whether the algorithm is
   improving.
4. **Attributed approvals + a specified retroactive-undo tool**: "undo all
   Sally's approvals" is possible in this model (every publication event is
   attributed, history immutable) but must not be improvised in anger — the
   naive version stomps later edits by others.  The tool: enumerate facts
   whose publication event was by the suspect approver in period X AND whose
   published version is still the unchanged auto version — revert those,
   flag the rest for human review.
5. **The `pub` gate is free defense-in-depth**: bulk-approved facts still
   don't reach the public SF dictionary — words go SF-public only via the
   explicit per-orthography `makePublic`, a second attributed human
   decision.  Rubber-stamping's blast radius is the internal dictionary,
   not the published one.

**The feedback loop is data-driven; notes are a bonus.**  Every human
correction of an auto fact is mechanically harvestable from the assertion
history: current version human-authored, replacing an `auto-transliterate`
version, with the Listuguj source in the sibling fact.  A "transliteration
corrections report" lists (li source, auto SF, corrected SF, note-if-any) —
and that corpus IS the transliterator's regression test suite: every human
correction becomes a test case forever.  The edit dialog for an
auto-authored pending fact offers an OPTIONAL note prompt ("why was the auto
version wrong?" → `change_note`) to capture the why (loanword, irregular).

**Sequencing**: depends on the migration (clean variant data,
`variantMatches`, working-orthography, the `pub` gate) — phase 4 of the
plan below.

## The orthography TABLE (first-class vocabulary; dz 2026-07-07)

**BUILT (2026-07-07).**  Which orthographies exist, their names, and whether
words may GO PUBLIC in them are DATA, not code: the `orthography` table
(peer of lexical-forms; slug create-only, name, `publishable`, retired,
ordered; admin page "Orthography Table", `edit-orthographies` grant, seeded
idempotently li ✓ / sf ✓ / mp ✗ / pm ✗).  Motivation (dz): the archaic
Pacifique source orthographies must never be publish targets, and a
hard-coded filter would be one more language hack — this system is heading
toward other language-preservation projects, so the language-specific bits
should gradually move to data.  The 'mm' wildcard is deliberately NOT a row
(model semantics, variant-policy.ts); selects offer it only under
`$allowAll` (fixing the old over-offering).  Consumers: variant selects,
the Public row + makePublic (publishable only — non-publishable
orthographies are HIDDEN, not greyed), user primary_orthography choices,
report names, the scan/validator vocabulary — all table-first with the old
map as unseeded fallback.  Public-row chips also suppress import-epoch
dates (the mass-import time is not a meaningful date — a portable rule for
any project that starts from a v1 import) and automation-account
attributions; migrate-status now stamps gates from the GRANTING sta
assertion's time and synthesized lifecycles from their entry's time (the
dev db was surgically re-stamped to match: 6,576 gates read as
grandfathered/no-date, 397 carry real completion dates).

## Regional variation / locale

Long term, probably modeled in data.  For now (and even then, as the final
fallthrough) the public aside above is the escape hatch: "(Cape Breton)"
renders next to the value without pretending we have a locale model.

## Sequencing

The *data migration* is one event, but the code lands in test-green stages:

1. **BUILT (2026-07-07).**  Parser support for the new `$` flags (+ the
   variant-leaves parse rule); the findings-report machinery (findings.ts;
   the `scan-variants` subcommand is its first client — live gate: PASS);
   validator invariants (warn mode, aggregated in verify-workspace).
2. **BUILT (2026-07-07).**  `variantMatches`/`variantsOverlap` + the
   $allowAll-driven SQL twin in variant-policy.ts (duplicate-spelling
   detection adopted: 'mm' vs 'mm-li' is now a same-orthography pair;
   legacy blank matches everything until the migration); working
   orthography as `primary_orthography` on the user record (new-content
   variant defaults from it, `$defaultAll` → 'mm'; run `upgrade-db --apply`
   per instance; the session-level switcher remains future); annotation
   fields (`aside` column added + late-column ALTER at startup, internal
   note reuses `note`) with disclosure inputs in the edit/insert dialogs,
   display next to the value (aside all audiences via the `$aside` JSON
   projection, note internal-only), and distinct aside/internal-note chips
   in the was-diff.
3. **BUILT + REHEARSED ON DEV (2026-07-07).**  `migrate-variants`
   (variant-migrate.ts): blank normalize (''/"null" → NULL), $notVariant +
   variant-less columns emptied, explicit value fixes (rse mm→mm-pm ×15,
   orf mm→mm-li ×2, spl mm→mm-li ×1), per-tag blank backfill from the
   DECISION TABLE `blankBackfillByTag` ($defaultAll tags tdo/att/rnp/src →
   'mm'; all others → 'mm-li', matching each tag's own non-blank
   distribution, e.g. rse is 903×mm-li vs 11×mm-pm) — **ACCEPTED as
   defaults by dz (2026-07-07), and CHANGEABLE IN A FUTURE RUN**: every
   value the migration fills is recorded in the `variant_migration_fill`
   bookkeeping table, so re-running after editing a decision table revises
   exactly the rows still carrying an unedited migration fill; rows a human
   has re-versioned or re-stamped since are released from bookkeeping and
   never revised (an edit carries the variant the editor saw and saved —
   ratification).  Mute-in-place,
   idempotent (`--expect-no-changes` proven), preconditions re-checked at
   run time (flagged schema in force, drop gate, mapping coverage),
   refuses production.  Dev rehearsal: 32,184 rows changed; verify-workspace
   variant warnings 28,031 → 5 (exactly the hand-triage spellings).  The
   LIVE cleanup report (`wordwiki.variants.cleanupReport()`, nav "Variant
   Cleanup") is the staff triage queue — same findings vocabulary, second
   renderer, drains as fixes land.  The flagged entry-schema is LANDED
   (2026-07-07, dz's annotations) and `migrate-variants` is step 10 of
   importWordWikiV1Db.sh (+ steps 13/14 of the production-cutover recipe;
   committed record: variant-migration-report.md).  STILL TO DO at the real
   event: run per instance (staging, then production), THEN flip the
   variant invariants from verify-workspace warnings to throw-on-load
   (blocked until the 5 hand-triage spellings are resolved by the staff).
4. **BUILT (2026-07-07).**  Auto-transliteration: the whole design above -
   the Public-row `Transliterate…` button (any editor; one word at a time)
   proposing normal pending facts by `~auto-transliterate` with
   TRANSLITERATOR_VERSION in change_arg; fill-gaps-only + never-re-offer-
   rejected-output; v1 scope = the schema-driven pure variant text relations
   (spl/etx/alx/orf); approve-all EXCLUDES robot facts structurally with the
   explicit "Approve N auto-transliterations…" escape hatch; a pending auto
   fact shows `from Listuguj: <source>` on its row in every look; the
   Transliteration Report (nav) = corrections/rejections with the why-notes
   (the regression corpus), per-version outcome stats, and CURRENT-RULES
   ACCURACY against every human li/sf pair; the activity report gains the
   per-approver approved-unchanged vs corrected split (rubber-stamp
   detection); the auto-fact edit dialog asks "why was the auto version
   wrong?".  THE RULES (transliterate.ts, `li-sf/rules-v1`) are CORPUS-
   DERIVED, not invented: g→k plus the sonorant+obstruent apostrophe
   ([lnm]→'[ptj]), measured at **69.4% exact on the 1,627 human li/sf
   pairs** - the linguistics beyond that (contextual g voicing, i→y glides,
   iʼ→î, finer schwa placement) is the report-driven development loop, and
   dz's ~95% target is rules work from here (edit rules, bump the version,
   read the accuracy line).

This is a major change touching db upgrade processes, schema, indexes, and a
lot of code — the point of settling this document first is to get it all in
at once *at the data level* while keeping the code path incremental.

## Schema + data re-review (2026-07-07, design-in-hand)

A second pass over entry-schema.ts and the live data with the settled rules.
Leaf rule verified mechanically: all 19 variant-bearing relations are leaves.

**Flag-vs-data conflicts (small, need decisions):**

- `rse` (source_as_entry) is `$mixed` without `$allowAll`, but 15 current
  rows carry `mm` — samples ("sasgeiăsi, I lay down flooring") are Pacifique
  diacritics + English gloss, i.e. probably mis-stamped `mm-pm`.
  Recommendation: migrate the 15 → `mm-pm`, keep the flags as marked.
- `orf` has 2 `mm` rows — regional form texts are specific spellings, so
  `mm` is wrong: migrate → `mm-li`, keep pure/no-`$allowAll`.
- (`spl` ×1 `mm` already decided → explicit; `rec` ×1 drops with
  `$notVariant`.)

**Model-level findings:**

- **`related_entry.unresolved_text` violates "Mi'gmaq text is always a
  subrelation"**: a direct, orthography-unmarked text field (one sample even
  holds two words separated by a newline).  In an SF rendering these li
  texts still show.  Long-term fix: resolve to entry REFERENCES (render the
  target's spelling in the render orthography); until then this is a known
  leak, and the transliteration workflow must skip it.
- **`subentry` carries a stale `// probably should have variant here TODO`**
  — now illegal under the leaf rule and superseded by the design (subentries
  are shared; their *texts* fork).  Delete during implementation.
- **`example_recording` carries a stale comment** wanting variant values
  like "mm/sf = usable but not ideal" — that intent (per-orthography
  recording *quality*) belongs to the future locale/quality mechanism, not
  to orthography; `$notVariant` on recordings is correct and this intent is
  recorded here so it isn't lost with the comment.
- `transcription`/`expanded_transcription` (rtr/rex) have no variant —
  correct and now stated: verbatim source quotes are orthography-neutral by
  definition (historical artifacts); they render in every orthography.
- **`att` key `watson-spelling` (257 current rows) is orthography data
  hiding in the attr bag** — Watson-convention spellings stored as
  key/value, invisible to the variant machinery, search, and duplicate
  detection.  Decision needed: add a Watson orthography to the vocabulary
  and migrate these into real `spl` facts, or explicitly declare Watson
  out-of-scope (it stays an attr).  (Also: 1 att row has an empty key.)

**Lifecycle/status data:**

- **983 entries (11%) have NO current `sta` fact at all** (672 of them have
  spellings — real words).  The remodel's "exactly one lifecycle" invariant
  needs the migration to synthesize one (Unknown?  InProcess?) — decision
  needed.  Zero entries have >1 current sta, so the invariant is otherwise
  free.

**Data dirt inventory (sizes the cleanup reports + aside workload):**

- Editorial text leaked into pure Mi'gmaq fields (parens / "or" / "?"):
  spl 8, alx 83, etx 856, orf 342 — ≈1,300 rows.  Spelling samples:
  "papqa'latl (move to paqa'latl", "wigumatieg (potential headword)",
  "anenaq ?".  These pollute headwords, duplicate detection, AND the
  transliterator's input ("apt's(qo'guig) TBA" transliterated is garbage) —
  so the aside + cleanup reports are on the transliteration critical path,
  not a nicety.
- Empty-text skeleton rows carrying a variant: erc 2, rec 8, rne 2, rse 1.
- Two entries have duplicate same-orthography spellings: one case-dup
  ("wintsug | Wintsug"), one two-different-words ("nipigtuguni |
  wijigtugunitieg") — hand-triage.

**Encouraging find — the transliterator's seed corpus already exists:**
358 entries and 556 examples already have BOTH mm-li and mm-sf texts
(human-authored).  The sibling model is proven in real data, and these
pairs are the auto-transliterator's initial regression/test corpus before
a single correction is ever harvested.

## Open questions

(Resolved 2026-07-07 and folded into the sections above: internal-note edits
use the normal approval flow; `aside` is the name, consistently in UI and
code; cleanup reports on staging with old-live-server links are the triage
mechanism.)

- Status remodel: concrete draft in the Status section CONFIRMED by dz
  2026-07-07, including the three judgment calls: (a) `Completed` →
  `Complete` rename, (b) archiving does NOT tombstone the `pub` gate
  (un-archive restores publicness), (c) CompletedAsPDMOnly gets no `pub`
  fact.  (A further orthographies+approvals feature is under discussion and
  may feed back into this design before build.)
- Per-tag blank-variant backfill mapping (esp. `sta`: blank → mm-li? — the
  status draft's migration mapping assumes yes).
- Cleanup-report details: link-base config for the old live server; which
  reports (spl garbage variants, blank variants per tag, filled $notVariant).
- ~~Review-UI treatment of annotation deltas~~ (built 2026-07-07: the
  was-diff names aside / internal-note deltas as their own chips).
- Session-level working-orthography UI (picker placement; does it also drive
  the editor's render orthography or only new-content defaults?).  Stage 2
  shipped the narrow version: `primary_orthography` on the user record
  drives new-content defaults only; no session switcher yet.
- Watson spellings (att key `watson-spelling`, 257 rows): real orthography
  in the vocabulary + migrate to `spl`, or declared out-of-scope?
- Lifecycle synthesis for the 983 no-status entries (Unknown? InProcess?).
- rse `mm` ×15 → `mm-pm` (recommended) — dz confirm.
- related_entry: schedule the unresolved_text → entry-reference conversion
  (or accept the li-text-in-SF-render leak for now).
