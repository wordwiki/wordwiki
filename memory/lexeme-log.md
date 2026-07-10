---
name: lexeme-log
description: "The session LOG pane on the word view (+ 'Post as todo' peer): quick capture of speakers-group feedback; doc of record repo-root lexeme-log.md (BUILT 2026-07-09)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

BUILT 2026-07-09 (converged over several design rounds - doc of record:
repo-root lexeme-log.md). The speakers group discusses words over the
WORD VIEW (nicest rendering); feedback was going into Word docs. Now: a
floating DOCK - a fab lower-left toggles a bottom-fixed drawer with
textarea + Post + "Post as todo" (one click away at ANY scroll
position; draft in sessionStorage per word survives navigation, red
dot on the fab = unposted draft); the in-flow pane at the page bottom
is the log's READING presentation.

Key decisions (dz's, after pushing back on my earlier shapes):
- `log` relation LAST in the schema, internal audience, markdown,
  hidden (word view renders its own pane; lexeme editor gets generic
  edit/delete/reorder free). NO autosave, NO coalescing - post-only
  ("a quicker way to do an edit you can already do"); beforeunload
  guards a dirty box.
- TOP-POSTED via order_key (raw data reads in presentation order -
  the model's user-order is first-class; chronology stays on
  valid_from). $view.byline hint renders "author (relative time)"
  from the FIRST version's assertion columns (EntryNode.byline?() -
  WorkspaceNode implements, JsonNode yields undefined).
- Approval BYPASSED, model kept: LexemeOps.postLog/postTodo (shared
  postEntryFact) insert + approve through standard publication ops
  (allowSelfApprove bounded-act precedent); under an UNAPPROVED entry
  the post stays pending (published-tree invariant). Route:
  wordwiki.postLexemeLog (form POST, kind=log|todo, returnTo bounce).
- Todos = the actionable peer (replaced #tags): postTodo files a
  generic unassigned Todo w/ text as details.  UI re-enabled
  2026-07-10 (dz: "work towards a pretty and simple implementation" -
  expect iteration here); reload targets are kind-aware
  (-rel-<id>-tdo-* for todo posts).
- Round 3 (same day): posting via tx -> {action:'reload', targets}
  (word view log section = reloadable fragment `-lexeme-log-<id>-`;
  same targets hit the editor's `-rel-<id>-log-*` fragments) so the
  dock is on the LEXEME EDITOR page too, no page reload.  Bylines show
  user NAMES (entry-schema setUsernameDisplayHook <- users table).
- Design-language: the ONE sanctioned non-modal entry surface -
  "modals are for mutations where the page is the context you're
  LEAVING; the log is one where the page is the context you're
  KEEPING" (recorded in liminal/design-language.md).

BUNDLE LEAK FIXED with this: data/publish-source.json carried 2,389
internal notes + 393 ref editorial notes + todos. audience:'internal'
now stamped on entry note/todo too; stripped at SERIALIZATION
(publishSourceToPublicJson) - NOT in buildPublishSource (in-memory
entries array identity = the publish staleness check). Full-history
dump still carries everything (founding licensing decision) - dz has
not ruled on excluding the log there.

Round 4 (2026-07-10): the word workflow is TWO titled sections - Tags +
Log - via renderLexemeWorkflow(entry_id) on BOTH read view and lexeme
editor (dz: one way everywhere); editor suppresses generic tag/log rows
(meta renderer hideRelationTags). Tags: line per tag w/ inline
✓done/✎edit/×remove + a ☰ quick-pick (tag table `quick` flag) →
"More…" (insertDialog). done is CURRENT-STATE data - a done todo stays
struck until removed (dz's principle: current views complete on current
data, never reach into history; the future feed IS the time dimension).
Verbs lexemeOps.addTag/setTagDone/removeTag; routes return reload
targets -lexeme-tags-<id>- / -lexeme-log-<id>-. tag.quick column +
quickByOrder.

Deferred: page-editor docked capture ('l' keybind, right-click "Log
on…"); todo refinement in the pane; feed collapsing of consecutive
posts. Tests: wordwiki/lexeme-log_test.ts. Relates to
[[publication-approval-model]], [[minimal-ceremony-principle]],
[[design-language]].
