# Metadata editor: "view changes" mode (simple approval)

Design settled with dz 2026-07-05.  A simpler, elder-friendly approval flow for
the COMMON case, layered on the metadata editor - the full review mode
(`entryPage(id, 'review')`) stays as the real model and the power tool.

## The problem and the shape of the answer

The primary approver is an elder.  The full review flow is powerful but heavy;
the common case is: someone edited a word, the approver wants to look at the
WHOLE word, see what changed since last published, in context, and click
approve-all.  A previous attempt at showing approval state inside the editor
died because it expressed HISTORY as nesting when nesting already meant
containment ("complete doom").  This design expresses history DECORATIVELY:
the page keeps exactly its document shape; pending rows grow an inline
annotation on the same line.  Nothing new to parse - only more ink on lines
the user already understands.  The pending dot (landed 2026-07-05) is this
mode's collapsed form: the mental model is "the dot, opened up".

## Semantics

- Per fact, `classifyFact` reduces any pending stack to ONE
  (published baseline -> current value) pair.  That collapse is the CORRECT
  semantics for approval, not just a simplification: the approver approves
  what will be published; intermediate editing states are noise (per-fact
  approve already works this way).
- Comparison is vs the PUBLISHED baseline (what approval means), not vs a
  sitting anchor - sitting anchors stay a review-mode concept.

## Presentation (opt-in mode)

- **Mode plumbing**: a `changes: boolean` flag on `metaEditPage` /
  `renderMetaEntry`, riding the root fragment's own hx-get (the on-page-state
  model) - so every mutation's whole-entry reload re-renders in the same mode
  with NO per-action threading.  It is a render option of the meta look, NOT a
  fourth EditMode ('meta' already rides the actions).
- **Entry point**: a quiet hint line, only rendered when the entry has pending
  changes ("N unapproved changes - view"), swapping the entry fragment into
  changes mode in place.  In changes mode the hint becomes the changes bar.
- **Edited rows**: one line, no hierarchy.  The row keeps its normal rendered
  current value; the OLD value is appended inline on the same line as a quiet
  "was: <old>" - `diffValues(factText(baseline), factText(current)).from`,
  i.e. the changelog's diff family: deletions struck, long unchanged runs
  elided ("…the X…"), nicest-strategy selection.  One diff vocabulary across
  changelog / review / this mode.  Non-text facts (recording, enum-only
  changes where factText is equal) fall back to the baseline's plain rendered
  values.  "One line" means NO INDENTATION for history - a long diff may wrap;
  the moment an old value gets its own indented line, the doom is back.
- **Added rows**: no diff - a small "added" chip (the changelog's chip class,
  same vocabulary).
- **Deleted facts**: rows for these do NOT render in the tree (the renderer
  walks current tuples and must stay that way).  Instead the changes BAR lists
  each one WITH ITS VALUE ("Deleted: Gloss - xyz", from the published
  baseline via renderAssertionValues).  Deletions are rare; this is the whole
  descope - but the values must be shown, because Approve-all covers them:
  *everything this page shows you as changed is what Approve all approves* -
  that contract is the mode's one rule.
- **Rowless facts** (found while testing - same contract): two relation kinds
  render NO body row at all, so a pending change there would otherwise be
  approved sight-unseen: the HEADWORD (titleRole 'headword' - it lives only
  in the h1) and $view-HIDDEN editorial relations (category, status, todo -
  this editor doesn't show them).  Their pending adds/edits are listed in the
  bar like deletions ("edited Spelling: samqwen was: samqwan", with the same
  inline diff), and count toward the change count.
- **Normal affordances stay live** in changes mode (dots, +, ☰, tap-to-edit):
  the senior-editor workflow is often "fix the typo, then approve".  The mode
  only adds annotation, never takes away.
- The changes bar also links to "Full review…" (`entryPage(id, 'review')`)
  for finer-grained work.

## Approve all

- A confirm-mode button on the changes bar, shown when
  `lexemeOps.hasApprovePermission()`.
- Routes through the existing per-fact verb `lexemeOps.approveFact` (NOT a
  bulk shortcut), so sitting receipts and the global change feed record it
  identically to fancy review, and all server-side gates stay enforced.
- **Ordering** (the tree gates): content approvals (added/edited) in PRE-order
  (`forEachVersionedTuple` visit order - parents before children, because a
  child cannot publish under an unpublished parent); deletion approvals in
  REVERSED visit order (descendants before ancestors - a published child
  cannot be left under a removed parent).  Content first, then deletions.
- **Structural facts** (an entry / subentry / example - no scalar content)
  with pending state must be INCLUDED in approve-all (children can't publish
  without them) but are NOT counted in the user-facing change count (they have
  no annotated row).
- **Two-person rule**: pre-filter each fact with `mayApprove(author)` (author
  = the pending content version's change_by_username; for deletions, the
  tombstone's) and try/catch each approveFact (gates can still throw).  Facts
  the actor may not approve are SKIPPED, not errors.
- **Feedback = the re-rendered page**: approve-all returns a whole-entry
  reload; approved rows lose their dots/annotations, anything remaining
  (skipped self-authored facts) stays visibly pending and the bar shows the
  remaining count.  No alert needed - the race with a concurrent editor is
  exactly the per-fact approve race, no new rigor.

## Implementation map (2026-07-05 codebase)

- `wordwiki/lexeme-editor.ts`: `metaEditPage`/`renderMetaEntry` grow the
  `changes` flag; `metaReloadAttrs`/`metaEditingHooks` capture it;
  `tupleSurface` already computes `classifyFact` (for the dot) - in changes
  mode it appends the annotation INTO the body's last line (inline, same
  line); new `metaPendingChanges(entry_id)` walk (forEachVersionedTuple +
  classifyFact); new `approveAllChanges(entry_id)` route; changes bar/hint
  builders.
- Reused: `diffValues` (wordwiki/diff.ts, .lm-diff-del/.lm-diff-elide CSS in
  liminal.css), `factText`, `renderAssertionValues`, `classifyFact`,
  chip classes `.lm-cl-chip-*` (liminal.css), `lexemeOps.approveFact` /
  `hasApprovePermission` / `mayApprove`.
- New CSS (site-theme.css): the "was:" annotation styling + the bar/hint.

## Descoped / future

- Deleted rows rendered in-place (struck) in the tree - needs the renderer to
  walk tombstoned tuples; the bar listing covers it for now.
- Per-row approve buttons in this mode - selective work goes to full review.
- Un-approve / revert here - same.
- Surfacing WHY a fact was skipped by approve-all (self-authored) beyond the
  remaining count.
