---
name: liminal-htmx-config
description: Shared htmx page config lives in liminal/htmx.ts; includes the back-button JS-breakage fix used by every liminal app
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

The htmx `<meta name="htmx-config">` and `<script>` for every liminal app
(rabid, wordwiki, future ones) come from **`liminal/htmx.ts`**
(`htmxConfigMeta()` / `htmxScriptTag()`), so the config is fixed in ONE place.

The config that matters: `historyCacheSize:0` + `refreshOnHistoryMiss:true`
(plus `scrollIntoViewOnBoost:false`). Without the first two, htmx's default
Back restores a saved DOM snapshot, which resurrects widget state Bootstrap no
longer tracks — symptom: **navbar pulldown/☰ dropdown menus (and other JS
hookups) go dead after pressing Back**. With the snapshot cache off, Back is a
real page load: everything re-initialises. rabid had this; wordwiki was missing
it (only had scrollIntoViewOnBoost) until 2cff9a9.

If a new liminal page template breaks JS on Back, it's almost certainly not
routing its `<head>` through `htmxConfigMeta()`. wordwiki's legacy
`pageTemplate` doesn't load htmx at all (boost is inert there); the htmx path is
`htmxPageTemplate` (via coercePageResult). See [[server-restart-protocol]].

**Client-side widget init after a boosted nav.** A page's own inline `<script>`
using `DOMContentLoaded` does NOT fire on a boosted (htmx) navigation — the
document is already loaded — so any JS-instantiated Bootstrap widget
(popovers/tooltips) or picker set up that way goes dead after the first hop.
Init globally in `resources/rabid-scripts.js` on load AND `htmx:afterSwap`
instead: `initPickers` (TomSelect) and `initPopovers` (`[data-bs-toggle=popover]`,
guarded by `bootstrap.Popover.getInstance`) both follow this. Symptom that got
fixed this way: the activity-report "all active volunteers" popover was dead
after navigating to the page (verified fixed in-browser 2026-07-05).
