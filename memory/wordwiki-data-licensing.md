---
name: wordwiki-data-licensing
description: "the COMPLETE db contents are CC-share-alike by founding decision — data \"leaks\" are not a security concern; community-owned, public and open"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

The complete wordwiki db contents are licensed CC-share-alike, by founding decision: the dictionary is owned by the whole community and must have public and open licensing. dz: most language projects keep their data secret, and then all the work is lost when they shut down — this project deliberately chose the opposite.

**Why:** protects the community's work against project death; the data outlives any host.
**How to apply:** when weighing designs, "this exposes dictionary data publicly" is NOT a blocking concern (auth on wordwiki protects EDIT integrity and internal workflow tidiness, not data secrecy). Don't over-engineer secrecy mechanisms; dz may still prefer tidy authenticated delivery (e.g. migration findings reports) — but as a mechanism choice, not a security requirement. Contrast: rabid has real per-field privacy ([[field-security-model]]).
