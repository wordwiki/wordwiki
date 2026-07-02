---
name: wordwiki-db-location
description: "wordwiki's live db is <repo>/mmo/database/db.db (the ~/mmo move HAPPENED); versioned dict table — use dump scripts, not ad-hoc queries"
metadata: 
  node_type: memory
  type: project
  originSessionId: f61114e0-bc84-4d7a-9f4a-78af0e500abf
---

The wordwiki database lives in the server's INSTANCE DIR at `<instance>/database/db.db`. The instance dir is configurable: `WORDWIKI_DIR` env (default `<repo>/mmo`), `WORDWIKI_PORT` (default 9000). **The planned `mv ~/mmo <repo>/mmo` has happened (verified 2026-07-01): `~/mmo` no longer exists; the live data is `/home/dziegler/projects/wordwiki/mmo/database/db.db`** and plain `./wordwiki.sh` works. It's NOT `database/db.db` in the repo root (that one is rabid's) and not `test.db` (scratch). The lexeme assertion table is named `dict` (per the [[wordwiki-assertion-model]]); there is no table literally named `assertion`.

The `dict` table is a **versioned** store: current assertions are `valid_to = 9007199254740991`. For English-side/content analysis don't query ad hoc — use `categorization/dump_entries.py <db-path>`, which projects current assertions to `entries.jsonl`. No `sqlite3` CLI on this machine; use python3's sqlite3 module with `file:...?mode=ro`.

Parallel instances: each instance dir needs its OWN `database/`; the big read-only stores (`content`/`imports`/`derived`) may be symlinked to a shared store. The server verifies this on startup (refuses on missing `content`/db; db write-lock on the db realpath). Prefer the clean shutdown ([[server-restart-protocol]]) over `killall deno` (a hard kill leaves a stale lock, auto-reclaimed next start, but clean is better).

**Why:** audits of persisted data need the right db; querying the wrong one wastes time and gives false confidence.

**How to apply:** for any "is X persisted / what's in the data" question, query `<repo>/mmo/database/db.db` read-only, table `dict`, filtering `valid_to = 9007199254740991` for current state — or just run/refresh the dump.
