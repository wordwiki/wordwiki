---
name: wordwiki-saas-goal
description: "LONG-TERM: wordwiki as a free open-source SAAS for language groups — tenancy=instance dir, data-only hosted customization, dumps = exit guarantee"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

dz's end-state (2026-07-24): wordwiki runs as a FREE, open-source SAAS — hosting is too much of a barrier for many language groups. The generalization arc ([[fix-orthographies]] orthography-as-data, [[multi-dictionary-project]] schema-as-data) exists in service of this.

Operational implications (recorded in multi-dictionary-survey.md §2.9, the doc of record):
- Tenancy = instance directory (SQLite db + content-addressed stores): provision = mkdir+seed, backup = rsync, EXIT = copy the directory. Data sovereignty is a feature for indigenous-language data; the archival dump model doubles as the portability guarantee.
- Hosted customization is DATA-ONLY (validated schema docs, site-editor blocks, stylesheets) — NO tenant JS on hosted origins. Absolute look-and-feel control = dumps + the reference static generator, run OUTSIDE the SAAS boundary.
- One binary, N instances → migrations fully automatic at boot (no hand-run upgrade steps).

**Why:** hosting cost/complexity, not software capability, is what blocks most groups; static hosting of the published site was never the barrier — the editor/server is.
**How to apply:** when making storage/customization/config choices, prefer the per-tenant-portable and data-not-code option; flag any new hand-run migration step as SAAS debt. Related: [[wordwiki-archival-publish-model]], [[wordwiki-data-licensing]], [[publication-approval-model]] (open-to-untrusted pending).
