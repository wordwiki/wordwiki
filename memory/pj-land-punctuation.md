---
name: ""
metadata: 
  node_type: memory
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

`pj land` is designed as **generic punctuation between work units** — it does the right thing no matter what state the workspace is in. When dz says "pj land", RUN IT, even if the tree is clean and there are no commits ahead of origin/main. Do NOT report "nothing to land" and skip it.

**Why:** dz uses it to mark a boundary between units of work, not only to ship commits. With a clean/empty branch it still: syncs (fetch + rebase onto origin/main), lands any commits, drops the now-empty work branch, and mints a **fresh anonymous** `pj/work/...` branch. dz can later name that branch with `pj branch <name>` if he wants, or keep it generic.

**How to apply:** treat "pj land" (and "pj sync and land") as an always-execute command. My mistake once (2026-07-09) was checking `origin/main..HEAD`, seeing nothing, and declining to run it — wrong. See [[server-restart-protocol]]: a land often pulls new upstream, so restart the server afterward to match.
