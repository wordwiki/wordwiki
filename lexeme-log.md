# The session LOG (+ quick todos)

dz (2026-07-09): the speakers group works one page at a time (the page
editor's word sidebar is that workflow's map), but the discussion itself
happens over the WORD VIEW - the nicest, cleanest rendering of a lexeme,
scans included.  Live structured editing in front of a group is too slow,
so feedback was being recorded in Word and re-entered later.  "It is
better to have unstructured collection of data in the system than out of
it."

## The design (converged over several rounds)

- **A `log` relation on the entry** - LAST in the model (so internal
  views put it at the bottom), internal audience, markdown text.
  Author and time come free from the assertion columns; a `$view.byline`
  rendering hint shows "author (relative time)" on every versioned view
  (hover for the absolute time - the change feed's formatting).
- **TOP-POSTED via order_key**: each post's key sorts before the current
  first, so the raw data reads in its intended interpretation order
  everywhere - the model's user-specified order, not a display filter.
  True chronology stays on `valid_from`.  (dz argued this over
  store-chronological/reverse-render, and was right: the generic
  renderer needs zero log-specific code.)
- **Post-only capture, no autosave, no coalescing**: the pane is "a much
  quicker way to do an edit you can already do" - type while the page
  stays active, click Post.  One post = one fact.  Nothing is written
  until the author says so; a dirty box gets a beforeunload guard.
- **Non-modal, via a floating DOCK** (dz round 2: notes are taken WHILE
  reviewing the word, so the box must be one click away at any scroll
  position): a small fab in the lower left toggles a drawer fixed to
  the bottom edge; the in-flow pane at the page bottom is the log's
  READING presentation.  ONE draft box: it survives toggling and
  navigate-away-and-back (sessionStorage per word), a red dot on the
  fab marks an unposted draft, Escape closes, beforeunload guards.
  (The sanctioned exception to the buttons/modals mutation model:
  modals are for mutations where the page is the context you're
  LEAVING; the log is a mutation where the page is the context you're
  KEEPING.)  The lexeme editor gets the relation through the generic
  machinery (edit/delete/reorder for free).
- **Approval bypassed, model kept**: posting inserts a normal fact and
  approves it through the standard publication op (self-approve as a
  bounded act - the pickTransliteration precedent), so nothing pends in
  review; under a still-UNAPPROVED entry the post stays a normal
  pending fact (born-approving it would violate the published-tree
  invariant) and rides the entry's eventual approval.  Everything is in
  history / the change feed / the activity report as ordinary
  attributed changes.
- **Todos are the actionable peer** (dz: as important as the log -
  "tagging things as errors are noticed").  postTodo files a generic
  unassigned `Todo` with the text as details, refinable in the editor,
  queued in the todo report.  (This replaced an earlier
  #tags-in-the-text idea - the todo model IS the work queue.)
  **HIDDEN for now** (dz round 3: liked but confusing) - the verb,
  route kind, and tests stay; only the UI (the second button + the
  open-todos list) is withheld.
- **Targeted refresh, both surfaces** (dz round 3): posting goes
  through `tx` (the standard mutation client) returning the normal
  `{action:'reload', targets}` - the word view's log section is a
  reloadable fragment, and the same targets hit the LEXEME EDITOR's
  generic log-relation fragments, so the dock sits on the editor page
  too with no page reload.  Bylines show the user's NAME (users-table
  hook), not the login.

## The bundle-leak fix (found during this work)

The publicly-downloadable `data/publish-source.json` carried internal
editorial content: 2,389 entry notes, 393 reference editorial notes,
todos, status rows.  Internal-audience relations (schema
`$view.audience: 'internal'` - now also stamped on entry `note` and
`todo`) are stripped at bundle SERIALIZATION
(`publishSourceToPublicJson`) - not in the in-memory source, whose array
identity the publish staleness check depends on.  The publisher renders
audience 'public' and never reads these relations, so the published
site is unchanged.  The FULL-HISTORY dump still carries everything, per
the founding complete-db licensing decision - flag to dz if the log
should be excluded there too.

## Deferred

- The docked capture panel in the page editor (right-click "Log on…",
  an `l` keybind) - the word view turned out to be where sittings live.
- Todo tagging/refinement in the same pane (assign, kind, done).
- Change-feed collapsing of consecutive log posts to one line, if
  sitting-noise shows up in practice.
