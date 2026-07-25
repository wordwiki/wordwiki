---
name: offline-fork-merge
description: "FUTURE: offline editing = fork the SQLite db to a laptop, merge back via the assertion HISTORIES; conflicts land as pending assertions handled in the change approver"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

dz's planned offline story (2026-07-25): a researcher forks the db onto a laptop (wordwiki running locally — deno's new electron-alternative), edits offline for months, then merges back. The merge is driven by the two dbs' assertion HISTORIES (immutable version chains + random ids) so it is mostly automatic; merge points needing a human are represented AS ASSERTIONS in the receiving db and dealt with in the existing change approver — the review UI is the merge UI, no separate conflict tool.

[[multi-dictionary-project]] makes this much easier: the fork travels as a self-contained SQLite file, and on return its dictionary sits BESIDE the canonical one as another table pair while the merge reads both histories in one process. Fork changes arrive PENDING (the publication dimension gates the merge like everything else).

**Why:** offline use is an important dictionary-editor feature (fieldwork, poor connectivity); this realizes a long-missed promise of the versioned scheme.
**How to apply:** when touching id allocation, timestamps, or the version-chain invariants, keep the cross-fork merge in mind (ids must stay collision-safe across forks; history must interleave without rewriting). Recorded in multi-dictionary-survey.md §4. Related: [[wordwiki-saas-goal]], [[wordwiki-assertion-model]], [[publication-approval-model]].
