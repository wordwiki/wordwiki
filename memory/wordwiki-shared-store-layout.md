---
name: wordwiki-shared-store-layout
description: "shared store is nested mmo-shared-content/{content,derived,imports}; mmo/* symlinks in; derived is content-addressed so safe to share"
metadata: 
  node_type: memory
  type: project
  originSessionId: d3b4ea1a-2e36-4997-98e4-460e03a1bd40
---

The big read-only/regenerable stores are shared across all checkouts/worktrees on a machine via a single `mmo-shared-content/` dir (sibling of the checkout), so a fresh/lightweight checkout doesn't need its own copies:

```
mmo-shared-content/
  content/   named content stores (Recordings, PDM, Clark, Rand, ...)  ~7.6G — REQUIRED
  derived/   generated tiles/compressed+trimmed audio/image-sizes/*-textract  ~10G
  imports/   importer source inputs (LegacyMmo, scanned docs, ...)  ~49G
```

Each `mmo/{content,derived,imports}` is a **relative** symlink into the matching child. The server verifies stores on startup and refuses to run with a missing/dangling `content`.

Why sharing `derived` is correct (not just a cache): `getDerived()` in [[liminal/content-store.ts]] addresses every derived file by the sha256 of the closure JSON (fn name + args), and generation is concurrency-safe (unique temp + atomic move + discard-temp-if-exists). Identical inputs → identical path on every checkout, so a derived file made once is reused verbatim — this is what spares a fresh checkout the slow from-cold re-derive on first publish. Discipline: a derivation **logic** change must bump something in the closure args, or stale output gets reused.

Scripts (in repo root):
- `mmo-use-shared-content.sh` — links all three stores; idempotent (no-op if already linked), refuses to clobber a real local dir; creates derived/imports (start empty) but never content.
- `migrate-shared-content.sh` — one-time per-machine flat→nested restructure + promotes a checkout's real local derived/imports into the shared store (instant same-fs renames); `--dry-run` supported; re-runnable.
- `setup-worktree.sh` — calls `mmo-use-shared-content.sh` (+ `claude-memlink`); run once per new worktree.

Migration done on this machine 2026-06-17 (promoted 9.8G derived + 49G imports). See also [[wordwiki-db-location]] (db.db stays per-instance, NOT shared).
