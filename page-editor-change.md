When the user is using the page editor (to select bounding boxes for words), then can see greyed out regions (on hover)
for the bounding boxes for existing words - but they have no way of telling what word that is.

On the public site a version of the same page editor (the page viewer) has a click to open dialog thing, which is fine.

But in the editor I have a harder request:

The way the editors are transcribing the PDM dictionary is working one page at a time, transcribing all the 
content, and they would like to interact with it at that level.

To support this I would like a sidebar that shows a (formatted narrow) list of all the words that have scanned
content from that page (the entriesByPDMPage(N) route uses the same query).  As the user hovers on items, they
get a highlight in the editor, I would like to have the correspoinding item highlighted in the sidebar.

Similarly, when hovering the sidebar, the item should show on the main page.  A click on the item sidebar could
do a popup page view, can't do that on the main page (because click does bounding boxes), but perhaps a menu or something,
or just skip it.

Also, in the main editor, When an greyed hover is displayed it would also be nice to have the lexeme summary displayed above it (Just a short line like the links in the main site).  

When thinking about this, be aware the greyed regions can overlap beteen different words (the grey box is the regtangualr that contains all the indivusual tagged smaller boxes, which can be intermixed between words).


The sidebar should probably be minimizable - I am worried about the screen width - but still want it side-by-side so that the
user can look at both at once.

---

## Create-word-from-group (2026-07-10)

The page-primary transcription flow (dz): tag the groups on a page
first, then make the dictionary entry FROM a group.  Right-click an
unlinked group - on the scanned page OR its row in the sidebar's
"Groups not yet linked to a word" tail - and choose "Create word from
this group".  lexemeOps.createLexemeFromGroup builds an entry +
subentry + a document_reference at the group (one unapproved draft,
edited/approved like any word) and the client opens it in the editor.
Route: wordwiki.newLexemeFromGroup -> {entry_id}.

## Status (2026-07-09): BUILT

- SIDEBAR beside the page (flex layout; the locked single-group popup
  editor keeps the plain layout): every word with scanned content on the
  page, in READING ORDER (rows sorted by the group's position on the
  page, not alphabetically - the panel is the page's table of contents
  for the top-to-bottom transcription/elder-review pass), rendered as
  the standard lexeme links (compact summary in the working lane, view
  opens in a new tab, pencil straight to the editor, not-public badge).
  A tail section lists tagged groups no word references yet (orphaned
  tags - page-level review should surface them).  Collapses to a thin
  rail (state in localStorage, survives page jumps).
- TWO-WAY HOVER with the overlap answer: page→sidebar keys off the
  hovered BOX (unambiguous even where group FRAMES interleave; a group
  referenced by two words lights both rows - the sidebar is the
  disambiguator), sidebar→page lights the group's MEMBER BOXES plus its
  frame (exact even when interleaved).
- HOVER TOOLTIP on the page's tagged regions: a cursor-following line
  (clone of the sidebar row's summary - one render, one source of
  truth; 'Not yet linked to a word' for orphan groups).  Suppressed
  during drags (the existing drag-in-progress machinery).
- REFRESH: every page-editor mutation flows through the one rpc()
  helper, which debounce-refetches the sidebar fragment
  (wordwiki.pages.renderPageWordSidebar route) - tag a box, the panel
  updates.
- Same query as editorReports.entriesByBookPage; tests in
  page-word-sidebar_test.ts (reading order, group-id wiring, untagged
  tail).
