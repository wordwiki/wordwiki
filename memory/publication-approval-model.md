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
