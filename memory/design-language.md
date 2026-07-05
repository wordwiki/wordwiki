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
people CARE about (member names inline, not "5 members"); items are FLAT —
hairline-separated `.lm-doc-section`s or a `tr.lm-navigable` table (NOT boxes;
we tried a soft tappable block and rejected it as "reinventing the link").
Navigation signal = ONE reserved accent colour on titles (`.lm-nav-link` →
`--lm-nav` teal, app-wide, nowhere else) + a monochrome underline for links in
prose — real `<a>`s, matching the web's native link. NO per-row pencils — edit
whole-record params on the DETAIL page; inline affordances only where a per-item
detail round-trip would be excessive (a task's checklist: toggle inline, Edit in
the item's ☰).  View state rides the URL (page-state,
see [[liminal-refresh-model]] / liminal.md § On-page view state): one boolean ->
a quick-pick in the ☰; several knobs -> an auto-generated filter dialog.
Complements the [[ui-mutation-model]] (every mutation is a button).
