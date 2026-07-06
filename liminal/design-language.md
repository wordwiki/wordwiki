# Liminal design language: documents you can edit, not editors

*(The aesthetic + interaction conventions for rabid-style pages.  Written to
inform future Claudes — read this before designing any page or list.  The
refresh/state MECHANICS live in liminal.md; the mutation-as-button model in the
ui-mutation-model memory; this file is the LOOK and FEEL those serve.)*

## The goal (and why it's load-bearing)

A liminal page should read like a **clean, beautifully typeset document** that
happens to be editable — not like an admin tool or a form.  Edit affordances are
present but **unobtrusive**: quiet, at the edges, discovered when wanted.

This is not just taste.  Two reasons make it a hard requirement:

1. **Reading is by far the primary use case.**  People come to *see* who's on a
   committee, what's left on the cleanup list, when the next event is — far more
   often than to change anything.  The page should optimise for the read.
2. **The audience is volunteers, not operators.**  A screen that looks like
   software — dense controls, buttons everywhere, editor chrome — reads as
   "complicated," and a confused volunteer simply *doesn't come back*.  A page
   that looks like a nice document is inviting; the editing reveals itself only
   when they look for it.

So the default posture is: **show the content beautifully; keep the machinery
quiet.**  When in doubt, remove an affordance from the resting state.

## List pages — the default recipe

A top-level list (committees, volunteers, events, …) is a **document with a
title**, not a grid of controls.  The pattern:

- **Page heading + a quiet ☰.**  Rare, page-level actions (New X…, view toggles)
  live in an `action.actionMenu` (the ☰) next to the heading — NOT a prominent
  "New" button that competes with the content and makes the page read like an
  editor.  The ☰ also leaves room to add options later.  (rabid/committee.ts
  `renderCommitteesPage`.)
- **Each item is a navigable unit showing what people CARE about**, not
  metadata.  Show the members' names inline, the markdown description, the real
  content — not "5 members".  Two formats, chosen by reading task — see **Two
  list formats** below.  In both, the item title is an `.lm-nav-link` in the
  reserved accent colour; that's the navigation signal.
- **No per-row pencils.**  A list item does not carry an edit control; editing
  happens on the item's detail page.  (Exceptions below.)
- **Whole item navigates** to the detail page (`lmNavigableClick`; the title is
  the `lm-nav-link` delegate).  Controls inside (the ☰, a checkbox) decline the
  navigation, so tapping them never drills in.

## Two list formats — document list vs data table

Both are *document* (a well-set table is typography, not a spreadsheet); pick by
the **reading task**, not by a blanket rule:

- **Document list** — flat sections (`.lm-doc-section` / `.lm-doc-title` /
  `.lm-doc-meta`).  For items you read **one at a time**, with rich or variable
  content: a committee *is* a little document (description, members, its own
  projects), and there are few of them.  Variable row height is fine — you're
  not scanning a column.
- **Data table** — `.lm-data-table` (a single quiet header rule, comfortable
  rows, no cell borders/striping; the whole `tr.lm-navigable` row drills in).
  For **many uniform records you scan and compare** (a roster, a schedule): the
  volunteer list is 90+ people × {name, skills}.  Aligned columns + regular rows
  let the eye run down a column — which flat sections destroy (names scattered to
  variable heights, ~3× the height).

The dial is **richness × count**: rich/variable/few → document list; a couple of
uniform fields × many → data table.  If a table grows toward per-item prose or a
bio, that's the signal to switch to the document list.  And a data table must
stay *typographic* — the moment it sprouts heavy borders or a per-row pencil it's
become the spreadsheet/editor look we're avoiding.

## Composed pages — weight tracks depth

A detail page nests lists under section headings (the committee page: Members /
Projects / Tasks, each a list under a quiet `.lm-doc-section-label`).  Visual
weight must track **semantic depth** — a section heading has to read heavier than
the items nested under it.  The failure mode is a child that outweighs its parent
(a prominent item title sitting under a quiet section label).

The fix is **container-declared, not per-item**: wrap an embedded list in
`.lm-subsection`, which indents it and demotes its item titles one notch below
the section label.  A container (not a render parameter) *on purpose* — a row
that reloads itself (`renderXRowById`) gets swapped back *inside* the subsection,
so the demotion survives; a level passed at first render would be lost on reload.
`renderOwnerTasks` opts in via `docHeading`, and a `.lm-doc-section-head` can
carry a trailing `+` (the committee-projects create affordance).

## Navigating to the detail page — use the web's link, don't reinvent it

These are **linked documents on the web**, and the link is a native, learned
affordance — so we signal navigation with a real link, styled one consistent
way, rather than inventing a bespoke "tappable" look.  (We tried a soft
tappable box and rejected it: it reinvents the link the browser already ships,
and reads as a private affordance the user has to learn.)  The rule is **one
reserved signal, used everywhere and nowhere else**:

- **Navigable titles → a reserved accent colour.**  Every list row/section
  title is an `.lm-nav-link`, styled in the reserved colour (`--lm-nav`, a deep
  teal — *not* 1995 link-blue, which is what made "title as link" feel ugly).
  That single hue means "tap to go here" app-wide; it's used for nothing else,
  so it's learned once.  Persistent colour works on touch (no hover needed);
  hover adds an underline as confirmation.
- **Links inside prose → a monochrome underline.**  A committee named in a
  description, a link in notes: the *other* native link signal, so body copy
  stays document (not a field of coloured words).
- The item is **flat** — a whitespace-separated section (`.lm-doc-section`) or a
  navigable data-table row, no fill/box/hairlines.  The whole surface still
  navigates (`lmNavigableClick`) as a larger tap target, but the accent title is
  the visible signal.
- **Chevrons are retired.**  The trailing `›` was a *second*, redundant
  "this navigates" cue; once the accent link carries it, the chevron is chrome.
  (`navChevron()` calls remain but are hidden in CSS — rabid.css and
  wordwiki's site-theme.css both carry the hide, so no served app shows
  them.)

This is also the fix for a consistency debt: "what does a navigable thing look
like" now has ONE answer across volunteers, committees, projects, events.

## Filters & view state — quiet, and in the URL

View state (which subset, how far back, search terms) rides in the route
expression as a `{}` argument decoded by a FieldSet — the page-state model (see
**liminal.md § On-page view state**).  The affordance for it scales with the
number of knobs:

- **One boolean → a quick-pick in the ☰.**  "Show dissolved / Hide dissolved",
  "Show done" — a menu item that navigates to the flipped URL.  A full dialog
  around a single checkbox is ceremony.  (rabid/committee.ts include_dissolved;
  the tasks/projects include_done toggles.)
- **Several knobs → an auto-generated filter DIALOG** (`renderParamForm` over
  the FieldSet's fields → an applyFilter route → `{action:'navigate'}`).  The
  volunteer search (text + include_archived) earns this.
- **A recent-window default** (last N days, "Show older") for time-ordered
  lists — see the page-state doc's date-window idiom.

Keep the toggles/quick-picks in the ☰ so the resting page stays clean.

## Edit affordances — where the pencil goes

The single edit affordance is the **pencil** (`editButtonProps` / `editPencil`,
liminal/table.ts) or an **Edit… item in a ☰**.  Placement follows one rule:

> The rarer and heavier the edit, the further "in" it belongs (on the final
> detail page).  The more granular and frequent the edit, the more it earns an
> inline affordance.

- **Whole-record parameters** (a committee's name/description, a volunteer's
  fields) → edit on the **detail page**.  Not on the list.  Routing there for a
  rare edit is fine and keeps the list a clean read.
- **Frequent, granular edits** → inline, because sending someone to a detail
  page for each would be absurd.  A **task's checklist**: you check items off
  and rename them constantly, so the checkbox toggles inline and Edit lives in
  the item's own ☰ (rabid/task.ts).  A checkbox in a task list does NOT get its
  own detail-page round trip.
- **Never tap-to-edit a row.**  Rows/sections NAVIGATE on tap; editing is a
  deliberate, separate act (the pencil, or a ☰ Edit…).  (One legacy exception:
  the wordwiki lexeme editor's fact rows are tap-to-edit; new work doesn't copy
  that.)
- Clicking an item's **text** may perform the item's *common verb* where that's
  the whole point — e.g. clicking a checklist item's title checks it off (the
  common verb), with editing pushed to the ☰.  Use this only where the common
  verb is that obvious.

Everything an edit does is still a **button** (immediate / confirm /
modal-of-arguments) returning a mutation the refresh model resolves — the
mutation model is unchanged; this doc is only about how quiet it looks.

## Where the mechanism lives (liminal vs the app)

The design language is a **liminal** thing, so every app on it (rabid, wordwiki)
shares one visual grammar and evolves together.  The structural primitives
(`.lm-doc-*`, `.lm-subsection`, `.lm-data-table`, `tr.lm-navigable`) and the
accent-link rule live in **liminal.css**.  The accent colour is a variable with a
fallback — `.lm-nav-link { color: var(--lm-nav, var(--bs-body-color)) }` — so an
app **adopts the accent link by setting `--lm-nav`** (rabid: a teal), and one
that hasn't set it is visually unchanged.  App-specific values and treatments
live in the app's own sheet (rabid.css sets `--lm-nav`, the hover underline, the
chevron-hide, and the prose underline; wordwiki isn't even served rabid.css).

## Small things that read as "document, not machine"

- **No "(s)".**  Counts use `plural(n, 'volunteer')` (liminal/strings.ts) —
  "1 volunteer", "3 volunteers", "0 volunteers" — never "volunteer(s)".
- **Management surfaces off the main bar.**  A regular volunteer shouldn't be
  faced with admin lists; things reached via their owning object (Projects,
  Tasks, Templates, Timesheets) live in an Admin menu, not the top nav.

## Pointers

| what | where |
|------|-------|
| document-list + data-table + navigable-row styling | resources/liminal.css (`.lm-doc-*`, `.lm-subsection`, `.lm-data-table`, `tr.lm-navigable`) |
| the accent link + app values | liminal.css (`.lm-nav-link` mechanism) + resources/rabid.css (`--lm-nav`, chevron-hide, prose underline) |
| the ☰ menu, action buttons, param dialogs | liminal/action.ts (`actionMenu`, `actionButton`, `renderParamForm`) |
| navigable item / pencil / chevron helpers | liminal/table.ts (`detailItemProps`, `editPencil`, `navChevron`), `lmNavigableClick` in resources/liminal-scripts.js |
| count phrasing (no "(s)") | liminal/strings.ts (`plural`) |
| view state in the URL (FieldSet) | liminal.md § On-page view state |
| worked examples | rabid/committee.ts (document-list sections + ☰ + show-dissolved + subsection depth), rabid/volunteer.ts (data table + search dialog), rabid/task.ts (inline checklist affordances) |
