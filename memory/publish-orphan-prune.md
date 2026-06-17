---
name: publish-orphan-prune
description: "Publisher now deletes stale orphan .html pages, but only opt-in via a marker file in the publish root"
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

The wordwiki publisher historically only ever WROTE pages, never deleted them,
so when a category/entry stopped being public its old page lived on disk and
kept being served/indexed forever. Reported symptom: `categories/astronomy.html`
still listed a word, even though `astronomy` had been migrated to internal
`~old-astronomy` and its words moved to `sky` (so the word's own page correctly
showed "Sky & Heavens", not astronomy). It was a STALE FILE (Feb 2025 publish),
not a re-publish of an internal category. ~218 such orphans existed in
`~/mmo/categories/`.

Fix (in `wordwiki/publish.ts`): `Publish.pruneOrphanedPages()` runs at the end
of a full `publish()`. Every page write now goes through `Publish.writePage()`,
which records the site-relative path into `emittedPaths` (the manifest); prune
deletes any `*.html` under a publisher-owned dir NOT in that manifest. Guards
(all fail-safe): **opt-in marker** `.wordwiki-publish-root` must exist in the
publish root (publisher never creates it — a human `touch`es it; no marker =>
prune is a logged no-op); full-publish only (never from `publishTargets`);
error-gate (skip if the run logged errors); sanity floor (skip if < 100 pages
emitted); `.html`-only allowlist; scope limited to `categories/`,`entries/`,
`servlet/words/` and only sections that actually ran. Tests:
`wordwiki/publish-prune_test.ts`.

**To enable on the live site: `touch ~/mmo/.wordwiki-publish-root`** (server cwd
is `~/mmo`, publishRoot=`.`). Until then the next full publish just logs
"prune SKIPPED: no marker". Once enabled, that publish cleans the ~218 orphans.
Books are deliberately NOT pruned yet. See [[wordwiki-db-location]],
[[server-restart-protocol]].
