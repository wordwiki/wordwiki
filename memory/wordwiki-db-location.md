---
name: wordwiki-db-location
description: "wordwiki's live db is ~/mmo/database/db.db (NOT in the repo); assertions are in the `dict` table"
metadata: 
  node_type: memory
  type: project
  originSessionId: f61114e0-bc84-4d7a-9f4a-78af0e500abf
---

The wordwiki database lives in the server's INSTANCE DIR at `<instance>/database/db.db`. The instance dir is configurable as of commit ecc8c29: `WORDWIKI_DIR` env (default `<repo>/mmo`), `WORDWIKI_PORT` (default 9000). **As of 2026-06-16 the live data is still at `~/mmo` (`~/mmo/database/db.db`)** — the planned `mv ~/mmo <repo>/mmo` is left for dz to run; until then start with `WORDWIKI_DIR=$HOME/mmo ./wordwiki.sh` (plain `./wordwiki.sh` now defaults to `<repo>/mmo`, which won't exist pre-move and the server will refuse). It's NOT `database/db.db` in the repo (that one is rabid's) and not `test.db` (scratch). The lexeme assertion table is named `dict` (per the [[wordwiki-assertion-model]]); there is no table literally named `assertion`.

Parallel instances: each instance dir needs its OWN `database/`; the big read-only stores (`content`/`imports`/`derived`) may be symlinked to a shared store. The server verifies this on startup (refuses on missing `content`/db; db write-lock on the db realpath). Prefer the clean shutdown ([[server-restart-protocol]]) over `killall deno` now that a db-realpath lock exists (a hard kill leaves a stale lock, which is auto-reclaimed next start, but clean is better).

**Why:** audits of persisted-format modules (timestamp, orderkey) need to check what values are actually stored before changing encodings/sentinels; querying the wrong db wastes time and gives false confidence.

**How to apply:** for any "is X persisted / what's in the data" question, query `~/mmo/database/db.db` read-only, table `dict` for lexeme assertions.
