---
name: wordwiki-assertion-model
description: "Wordwiki's lexeme data lives in an Assertion meta-model; full architecture notes persisted at /home/dziegler/wordwiki/assertion-model.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

Ongoing work (as of 2026-06-10): updating wordwiki (all in the wordwiki/ dir since the 2026-06-11 merge of datawiki/ + scannedpage/ into it; liminal/ is the shared framework) as liminal is updated. Wordwiki powers mikmaqonline.org; dev editor at http://localhost:9000/ww/ (restart: ./publishHomePageAndServe.sh — the :9000 site is dev, OK to mutate data through the UI). Public site is generated as static HTML by wordwiki/publish.ts for 1000-year artifact longevity (generation is slow).

Key model: all lexeme data is in one `dict` assertion table (wordwiki/assertion.ts; the scanned-document tables are in wordwiki/scanned-document.ts) — one row per immutable fact version (`id` = fact, `assertion_id` + `replaces_assertion_id` = version chain, HLC `valid_from/valid_to`, tombstones, materialized path ty0..ty5/id1..id5, payload attr1..attr15 bound by the soft schema in wordwiki/entry-schema.ts via wordwiki/model.ts, in-RAM VersionedDb workspace in wordwiki/workspace.ts). Designed for community (bazaar) editing with approval/undo, dialect overrides via `variant` (mm-li etc.), and (unrealized intent) offline field-collection forks merged later as proposed assertions — keep model evolution compatible with fork/merge. Full detailed notes: /home/dziegler/wordwiki/assertion-model.md

**Why:** This is the foundation for upcoming model changes David will describe; re-reading the doc is much cheaper than re-deriving from code.

**How to apply:** Read /home/dziegler/wordwiki/assertion-model.md before working on assertion/datawiki code. Related: [[ui-mutation-model]], [[testing-approach]].
