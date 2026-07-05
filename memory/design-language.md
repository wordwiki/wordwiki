---
name: design-language
description: rabid/liminal pages are beautifully-styled DOCUMENTS with unobtrusive edit affordances; the recipe is in liminal/design-language.md
metadata: 
  node_type: memory
  type: reference
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

The rabid/liminal aesthetic + interaction conventions are documented in
`<repo>/liminal/design-language.md` — read it before designing any page or list.

Core stance (dz, established 2026-07-05): pages read like clean, beautifully
typeset DOCUMENTS you can edit, NOT editor UI — because reading is by far the
primary use case AND the audience is volunteers who bail if it feels like
software.  Key conventions: list pages = a titled document, rare/page-level
actions in a quiet ☰ (not big buttons), each item a navigable unit showing what
people CARE about (member names inline, not "5 members"). TWO list formats,
picked by reading task: a flat whitespace-separated `.lm-doc-section` document
list (rich/variable/few items, e.g. committees) OR a typographic `.lm-data-table`
(many uniform records you scan/compare, e.g. the 90+ volunteers) — a table is
document too, just not a spreadsheet grid. NO boxes/hairlines (we tried a soft
tappable block and rejected it as "reinventing the link"). Navigation signal =
ONE reserved accent colour on titles (`.lm-nav-link` → `--lm-nav` teal, app-wide,
nowhere else) + monochrome underline for prose links; chevrons RETIRED (CSS-
hidden — the accent link replaced them). Composed pages: nested lists wrap in
`.lm-subsection` (indent + demote titles) so weight tracks depth; container-driven
so it survives row reloads. NO per-row pencils — edit whole-record params on the
DETAIL page; inline affordances only where a per-item detail round-trip would be
excessive (a task's checklist: toggle inline, Edit in the item's ☰). The
MECHANISM lives in liminal.css (shared w/ wordwiki); apps opt in via `--lm-nav`
(fallback keeps non-adopters unchanged); rabid-specifics in rabid.css. plural()
in liminal/strings.ts for counts (no machine "(s)").  View state rides the URL (page-state,
see [[liminal-refresh-model]] / liminal.md § On-page view state): one boolean ->
a quick-pick in the ☰; several knobs -> an auto-generated filter dialog.
Complements the [[ui-mutation-model]] (every mutation is a button).
