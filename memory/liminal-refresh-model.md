---
name: liminal-refresh-model
description: "The liminal dependency-key/refresh conventions (registration vs emission, speculation, debug mode) are documented in repo-root liminal.md"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

The liminal page-refresh + dependency model (built 2026-07-03) is documented in
`<repo>/liminal.md` — read it before touching fragments, mutations, or dep keys.
Core conventions: keys `-t-`/`-t-pk-`/`-t-fkname-v-` (bare in classes, dotted in
targets); fragments REGISTER the finest sufficient key and only on pages whose
own buttons can change the data (`lm-read-only` excludes shared views rendered
read-only); mutations EMIT all levels automatically via the Table DML funnels +
the ambient collector (liminal/dirty.ts) and return bare `{action:'reload'}`;
`txd(deps)` speculation does apply+refresh in one round trip (hybrid: leftovers
prune/reload); `lmDebugRefresh(true)` shows per-round refresh marks + path badge.
Escape hatches: hand `dirty.record()` at raw-SQL writes; deliberately-silent
writes (task.touch) stay unrecorded with a comment.  Future work (long-poll
liveness [[publication-approval-model]]-style separate mechanism, fine insert/
delete) in `<repo>/liminal-refresh-future-work.md`.
