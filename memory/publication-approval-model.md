---
name: publication-approval-model
description: published_from/published_to dimension + approval/review workflow — design at publication-model.md; PARTLY BUILT (logic + Phase 0/1 + review UI done; open-to-untrusted pending)
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

IMPLEMENTATION STATUS (2026-06-14): logic BUILT + tested behind the oracle/
property-test harness; data migrated. BUILT: the columns; operations
(publication-ops.ts approve/revert/comment over VersionedDb + LexemeOps verbs
approveFact/revertFact/commentFact with permission+persistence); publishedView/
pending queries; structural invariants in versioned-db-validate.ts; Phase 0
born-approve backfill (publication-backfill.ts; repair-assertions clears the
legacy placeholder first; in migrateDevDb.sh, rehearsed); Phase 1 public
renderer (workspace.ts PublishedTupleQuery; WordWiki.publishedEntries =
published projection AND status). REVIEW UI BUILT (2026-06-14): it is a MODE of
the lexeme editor (dz: reviewing+proposing interleave — don't make it a separate
page), toggled in the entry header (Editing⇄Reviewing, badged w/ pending count).
renderEntry(entry_id, mode, participant, full) threads view-state. REVIEW
REDESIGNED TWICE (2026-06-15): first to a per-fact version-timeline GRID, then
dz rejected that — the lexeme TREE is already at users' comprehension limit and
nesting a 2nd per-fact list tipped it over. NOW: review renders ONE FLAT,
REUSABLE change list (wordwiki/change-list.ts — renderChangeList(events,
{showSubject})). NOT a second tree. Each line is an EVENT reading left→right:
WHEN, WHO lead (rigid narrow columns = "activity log"; who = INITIALS, date =
compact yy-MM-dd via timestamp.formatTimestampCompact), then plain-language verb
(added / changed to / deleted / commented / reverted to / approved; baseline =
quiet accepted value) + value (shown only when it MOVES) + note sub-line
(comment/revert/edit-note all share change_note). NO glyph vocabulary (dz: the
"scan like code" framing optimized for a dev-approver, hostile to elders). The
component is pure layout (callers pre-render values to Markup); builders in
lexeme-editor.ts: factChangeEvents (one fact) + lexemeChangeEvents (whole lexeme,
events merged in time order, each naming its fact; the fact's action ☰ rides its
latest event; empty structural-container baselines suppressed). SAME component
serves all contexts (single-fact / lexeme / global / per-user) — only the event
SET differs. REFINEMENTS (2026-06-15, dz playing): a CHANGE renders as before→
after on two ALIGNED rows ('from'/'to' fixed-label column) — REQUIRED, not just
nicer, because in the merged log the prior value is not the row above (facts
interleave), so each change carries its own from/to (factChangeEvents tracks
prevContent; substrate for later char-level diff). Comments render INLINE (the
note is the content); edit/revert rationales stay sub-lines. Clean/approved
facts get NO action menu (giving them a roll-back read as "approved thing under
review"); the menu (Approve/Reject/Comment/Edit) attaches ONLY to pending facts,
and there is NO roll-back-an-approved-value affordance. Buttons renamed origin-
neutral: mode toggle "Edit entry" (was "Back to editing"), history dialog "←
Edit" (was "← Back to edit"). Rationale: a 2nd reviewer must see a contributor's whole interaction
(rejected reassert + reason + follow-up) to handle them fairly, and a flat
conversation carries that better than a nested grid. Walk over raw
VersionedTuples (classifyFact) so pending DELETIONS surface. Bar controls:
PARTICIPANT filter (factHistory of facts a user is *active* on = authored a
non-baseline version; default = Everyone for approvers / self for plain
contributors; subtree-aware so paths to a matching child survive) + FULL-HISTORY
toggle (back past the baseline to creation). Audio stays a real player in the
grid (approving audio = hearing it); other media capped via CSS. DEFAULT editor
view stays the COMPACT value editor (dz: casual contributors mustn't face the
changelog) — review is opt-in; compact view now shows a quiet lm-pending-dot on
unapproved facts. Edits carry an OPTIONAL note (change_note, no schema change)
shown in the timeline. Per-fact full history = the existing History dialog.
The ☰ keeps edit affordances + adds approve/revert/comment (LexemeOps verbs
return outcomes; editor owns the reload). Review reloads COARSELY (whole entry).
Mode/participant/full ride in the entry fragment hx-get + action exprs ONLY when
review (edit keeps byte-identical wire). STATUS: live, 17 review tests; NOT yet
committed (dz playing with it). Open follow-on: per-fact inline full-history
expansion; role-based participant default tuning; the rejected-contributor flow.
LATENT-CORRUPTION FIX surfaced here: editor edit-builders (saveEdit/move/
restoreVersion/supersedeFields/tombstoneFact) spread `...current` and inherited
its published_to=EOT → born-published + an I2 double-published violation; fixed
with `unapprovedDimension` (lexeme-ops.ts) spread last to null the publication/
change_action fields on every proposed edit. Tests: lexeme-review_test.ts (13:
classifyFact units + render/act/two-person). NOT BUILT: open-to-untrusted
(Phase 3); dictionary-wide pending worklist (the natural next follow-on, links
into these per-lexeme review views). Permission model: approve needs 'approve'
role (admin implies); self-approve workaround = 'admin'; LexemeOps.mayApprove/
hasApprovePermission gate the UI. PUBLIC FORMULA (dz): status='Completed' gate
KEPT and ANDed with the published dimension (not replaced). Property test
(reference-model_test.ts) compares oracle vs production after every op incl.
publication ops; `bornApprove(ww)` test helper in testing.ts.

SITTING RECEIPTS (built 2026-07-03): a review action no longer VANISHES the
acted-on group (dz: disappearance confused even him; receipts = confirmation +
misclick recovery + layout stability). The review sitting is anchored at the
db's top tx timestamp (`since`), stamped into the browser URL by an entryPage
redirect (un-anchored visit → `/ww/wordwiki.entry(id,T)`, T =
app.lastAllocatedTxTimestamp — the db-lamport anchor dz wanted, NOT wall
clock). A fact settled by approve/revert NEWER than `since` renders as an
in-place receipt ("approved ✓"/"rejected", chip names the actor) — pure query,
no DOM/session state; refresh/back keep the sitting, fresh navigation
re-stamps (clean queue). Other people's same-sitting approvals show too
(deliberate: consistent state beats silent vanishing). `since` threads through
ReviewOpts + every fragment hx-get; `since=0` (old links) = no receipts =
legacy behavior. factReceipt() in lexeme-editor.ts; receipts don't count as
pending. Tests in lexeme-review_test.ts (receipts section).

GLOBAL CHANGE FEED (built 2026-07-03, change-feed.ts): the dictionary-wide
worklist. A STABLE chrono record of all human changes (dz's pending-only idea
resolved: pending-only + scroll-back positional memory conflict — status is a
badge, position never moves). Events CLUMP: same editor + same lexeme,
consecutive gap ≤ 30 min (GAP-based per dz's edit-session intent, not a fixed
window), closed by any other editor touching that lexeme; gaps compare the
HLC's wall-time component (extractTimeFromTimestamp — dz: "hybrid logical
clock", the db's only clock; stalled-clock anomaly merges clumps, benign).
PAGING REDESIGNED (2026-07-03, dz caught DOM-state flaw in htmx-append):
the page is a PURE FUNCTION of ONE {}-literal route arg -
wordwiki.changes({from_time,to_time,max_rows,restrict_to_user}) via the new
liminal FieldSet (extracted base of Table; normalize/literal = codec for ONE
{} value - dz: do NOT privilege a textual base-URL, URLs are composable route
exprs, a page can carry several independent {} sections). Filters define the
query; max_rows is the depth knob; "Show older" = SAME URL with max_rows+50,
htmx-swapped into #content with hx-replace-url (replaceState for depth,
real-navigation/pushState for filter changes - resolved dz's "divided").
Filter dialog AUTO-GENERATED from the FieldSet's own fields
(renderParamForm); applyFilter returns new {action:'navigate',url} tx action
(rabid-scripts.js). TimestampField (liminal): HLC number <-> datetime-local.
Pages anchored in the past are IMMUTABLE (valid_from append-only); cutFeedSlice
picks the cut C by fixpoint so a page = exactly events ≥ C (interleaved
clumps pulled in whole). Entry links
carry the feed cursor as the review-sitting `since` anchor (one coherent
sitting) and open target=_blank — pages are no-store (bfcache deliberately
defeated), so the feed tab must never navigate; a focus-handler reloads just
the clicked clumps (inline script). Queries: indexed valid_from range /
(id1 + range), plans pinned in change-feed_test.ts; imports + '~' users
filtered in SQL. FEED SHOWS CHANGES ONLY (fix 2026-07-03): filter CHANGE_ROW = (replaces_assertion_id IS NOT NULL OR published_from IS NULL OR valid_to=valid_from) excludes the born-published corpus (backfill/import: published original creation, no predecessor, not a tombstone) - it's standing content, not activity. A baseline kind is also dropped from clump events, and empty clumps drop. Symptom was 'words with no changes' in the feed. (Filter dialog Apply nop was a SEPARATE non-bug: stale in-memory rabid-scripts.js in an open tab lacking the new navigate tx action - reload fixes; resources revalidate via etag.) No approve-from-feed (deliberate: review mode has the
context + gates). TEST GOTCHA discovered: applyTransaction REWRITES valid_from
with allocated tx timestamps (mk* t args only order groups) — fixture tests
needing clump gaps advance the clock via allocTxTimestamps(seconds*RADIX)
(jumpClock helper in change-feed_test.ts).

MONTHLY ACTIVITY REPORT (built 2026-07-03, activity-report.ts): compact
per-month table (last N months, default 12, cap 240) of Changes / New lexemes /
Approved / Rejected — counts are ACTIONS IN the month (dz chose this over
fate-of-the-month's-changes: single-pass, never shifts retroactively). Same
FieldSet pure-function-of-URL pattern as the feed: wordwiki.activity({months,
restrict_to_user}), auto-generated filter dialog; NO to_time anchor stamp
(live dashboard, drifts with today — reproducibility lives in the month
LINKS). ONE db trip: light-row index-range fetch over the whole window using
the feed's imported CHANGE_ROW predicate (counts must be exactly the feed page
they link to), bucketed by (month,user) in JS since month boundaries are
computed in JS anyway for the links; plan pinned. Month name → feed windowed
{from_time,to_time}; "By editor" lines (top-level only) → user-filtered feed +
their per-user monthly view. New lexeme = pending creation of the ent fact
(born-published backfill excluded by CHANGE_ROW, so all-dash until people
create entries under the new model). The unstamped pre-2026 history (NULL
change_by_username, ~14k rows) shows as unlinked 'unknown' line — the feed's
`=` filter can't reach NULL, so no filter links for it. Comments tallied but
not rendered (no column earned yet). Reached from Home + Admin menu. Tests:
activity-report_test.ts (windows/tally/bucketing pure, plan pin, rendered).

CREATION DATES (built 2026-07-03, creation-dates.ts): New lexemes column is
the CREATION-DATE axis, not publication state — ent valid_from for
wordwiki-created lexemes (ent tag never edited, so exact; counting only
pending creations hid everything Phase-0 born-approved), shoebox-date
attribute for the 7,514 batch-imported ones (whose ent rows ALL sit at
exactly BEGINNING_OF_TIME). KEY CONSTRAINT dz should know: the HLC encoding
starts at the 2020 local epoch, so pre-2020 shoebox dates are UNREPRESENTABLE
as valid_from (and BOT is a load-bearing "imported baseline" sentinel) —
creation date therefore stays DATA (the attribute), never a valid_from
rewrite. `wordwiki.sh normalize-shoebox-dates` (migrateDevDb.sh step 8 +
cutover recipe, per dz: reproducible-script steps only) rewrites current
shoebox-date values dd/Mon/yyyy→ISO mute-in-place (backfill pattern;
superseded versions keep original text as audit trail; idempotent,
--expect-no-changes proof; ran on dev: 7,785 normalized, 0 unparseable — the
one two-line value takes its first date). resolveCreationMonth: shoebox ISO
(earliest per entry across subentries) else valid_from>BOT else unknown (3
entries). months cap 400 so the whole 2000→ construction history renders;
shoebox years 2000-2024, 1,905-lexeme spike in 2019. Pre-import months' feed
links are empty by design (creation happened in Shoebox, not here).
REVISED per dz (2026-07-03 pm): COUNTS are the links, month label plain text —
Changes count → month-windowed feed, New lexemes count → createdPage(year,
month[,user]) micro page (every lexeme created that month, oldest first, date
+ entry link + creator; (0,0) = the undated imports). months field now
nullable DEFAULTING TO BLANK = NO LIMIT (dz: fast enough at full depth) —
spanMonths reaches back to the earliest change or dated creation (~318
months, ~0.2s); no-limit view appends "N lexemes with no creation date"
linking createdPage(0,0) (currently 3). filterSummary shows "last N months"
when a limit IS set. FEED RANGE RULE (dz 2026-07-03): a CLOSED feed range
(from_time set, i.e. the report's month links) ignores max_rows entirely -
the range is the clamp, whole window renders, no Show-older (SQL LIMIT
dropped, cutFeedSlice target Infinity); max_rows/FEED_PAGE_ROWS (now 1000,
was 50) paginate only the open-ended feed. Whole-month feeds ~0.15s warm
(~2s first request = workspace warm-up). Table GROUPED BY YEAR (dz): bold
year totals row (Changes → year-windowed feed, New lexemes →
createdPage(year, 0) = whole-year mode of the micro page), month-only labels
indented beneath; an edge year totals only its rendered months.

DESIGN (designed 2026-06-12, revised 2026-06-13 with dz): a second
interval `published_from`/`published_to` on `dict` assertions, peer to
`valid_from`/`valid_to`. valid = editorial currency (workspace view,
`valid_to=EOT`); published = approval currency (public view,
`published_to=EOT`). NOT nested — a value can be editorially superseded but
still published (pending edit on top), or current but unpublished (pending).
Full design at /home/dziegler/wordwiki/publication-model.md.

The model after the full design conversation (dz kept cutting complexity — each
cut was right):
- Goal: untrusted contributors allowed; EVERY change (incl. new entries) needs
  approval by one other senior. Approval gates PUBLICATION, not editing (live
  editor). Two-person rule: publisher ≠ content author.
- EVERYTHING IS ONE ROW SHAPE; `change_action` (assert|approved|reverted|
  comment) is the discriminator. Approval = a RE-ASSERTION row (every fact edit
  = assert row + approve row), so NO `approved_by` column — the approver is the
  approve row's `change_by_username` ("approved-by on chain"). ONE undo
  operation `revert` (= decline a pending edit, what the UI calls "reject", OR
  roll back an already-published value): re-assert a prior published value
  (`reverted`, required note, auto-published under the I4 value-equality
  carve-out). No separate reject vs revert.
- COMMENTS ARE ON-CHAIN VERSIONS (`change_action='comment'`, value re-asserted,
  text in `change_note`), NEVER approved/published → in full-history export,
  auto-excluded from published-only (null published interval). NOT separate
  facts (that needed independent comment-approval, which dz removed: comments
  aren't approved). Chose option (b) ordinary chain version over (a)
  point-event: the one special case (a comment must not make a settled fact
  look pending) is contained in ONE helper — `isPending` = latest NON-comment
  version is unpublished.
- Reject-reason stays on the reject row's `change_note` (symmetry with comments
  achieved by pulling comments onto the chain, not lifting reasons off).
- Two EXPORTS = the two dimensions: published-only (= static site = print) vs
  full-history (durable archival record w/ provenance). Two PHASES: active
  collecting (now — speakers in 70s/80s) where valid/published split =
  capture-ahead-of-curation (nothing lost to review latency); archival edition
  = frozen published projection at date T. The review WORKFLOW is ephemeral
  software; the data-with-provenance is what must survive.
- Invariants I1–I8 + grandfather (backfilled = published `assert` rows w/ no
  approving successor). Phased rollout: backfill-for-equivalence first (like the
  category migration), dual-run, review UI, open to untrusted.

DESIGN POSTURE (dz, load-bearing): every special case must earn its keep —
because the artifact's survival depends on a future archivist reconstructing it
cold AND a solo volunteer continuing to ship (complexity that burns out the
maintainer is itself a way the project dies). This killed: write-time proposal
object, action-log table, comments-as-separate-facts, point-event comments.

Builds on [[wordwiki-assertion-model]]. Deferred: moderation unpublish
(rationale rides a comment row), post-hoc edit sessions (a query, not a
write-time object), trust tiers.
