---
name: publish-orphan-prune
description: "Publisher deletes stale orphan .html pages, gated by automatic per-dir .wordwiki-publish-tree ownership markers (the old root marker gate is GONE)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

The wordwiki publisher historically only ever WROTE pages, never deleted
them (stale `categories/astronomy.html` bug, ~218 orphans). Fix in
`wordwiki/publish.ts`: `Publish.pruneOrphanedPages()` at the end of a full
`publish()` deletes any `*.html` under a publisher-owned dir not in the
`emittedPaths` manifest (every write goes through `writePage()`).

**OWNERSHIP-MARKER MODEL (2026-07-09, replaced the operator-touched
`.wordwiki-publish-root` root gate — that file/constant is GONE):** the
publisher stamps `.wordwiki-publish-tree` into every dir it creates and
owns whole (the /li /sf orthography trees + root /servlet), REFUSES to
publish into an existing unmarked one (claimOwnedDirs, checked for ALL
trees before anything is written — so an orthography URL segment that
collides with a user's directory can't clobber it), and prune only walks
inside stamped dirs. Fully automatic — no operator step on fresh roots;
bless a pre-marker publisher tree with `touch <tree>/.wordwiki-publish-tree`
(dev mmo blessed 2026-07-09; STAGING will refuse its first publish until
blessed the same way). Marker is not .html so prune can never eat it.

Other guards (all fail-safe): full-publish only; error-gate; sanity floor
(<100 pages) — a WARNING now, not an error, since auto-arming means small
young sites hit it every publish; `.html`-only; scope = tree-prefixed
`categories/`, `top-words/`, `entries/`, a preview edition's must-be-empty
`books/`, + root `servlet/words` (rides servlet's own stamp). GOTCHA fixed
2026-07-09: std walk normalizes relative roots, so on publishRoot='.' the
prefix guard silently skipped EVERYTHING — prune had never worked on the
live root; both sides now resolved absolute. Tests:
`wordwiki/publish-prune_test.ts` + `publish-multi-tree_test.ts` (relative
root, refusal, bystanders). See [[wordwiki-db-location]],
[[server-restart-protocol]].
