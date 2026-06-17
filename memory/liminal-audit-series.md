---
name: liminal-audit-series
description: ongoing module-by-module correctness audits of liminal/; the established per-module recipe
metadata: 
  node_type: memory
  type: project
  originSessionId: f61114e0-bc84-4d7a-9f4a-78af0e500abf
---

Ongoing series (June 2026): audit + test one liminal/ module per request. Done: orderkey, timestamp, date, nanoid, random, lazy, levenshtein-distance, strings, utils, markup (commits b2dcd00..2a66d6b). markup was the big one: live stored-XSS via unescaped textarea content, fixed 2a66d6b. Remaining candidates: db.ts, table.ts, action.ts. Side-findings parked: liminal/stash.ts is an abandoned stub (delete candidate); importer/import-mmo.ts has rotted imports (fails deno check, pre-existing).

**Why:** these modules are foundational ("there is a lot on top of this, and bugs here will just give confusing results" — dz); several had real bugs (biased shuffle, broken counter decode, dead rapture clamp, infinite loops).

**How to apply** (the recipe dz approves of):
1. Read module + grep all callers; check persisted data (~/mmo/database/db.db) before changing any encoding/sentinel — frozen values get documented + pinned, not "fixed".
2. Confirm suspected bugs empirically with a throwaway probe in tmp/ (delete after).
3. Fix with canonical-form validation at parse edges; fail loudly over silent garbage; prefer exact integer math over float behavior.
4. Tests in liminal/<name>_test.ts via [[testing-approach]] choke points (testing/test.ts, testing/assert.ts), including seeded-LCG randomized property tests (vs a reference implementation where one exists); Math.random-based stats get >=10-sigma bounds.
5. Remove scratch main()/play()/examples() blocks — tests demonstrate usage.
6. Report findings (sound parts too), then ASK before committing; commit per module with a findings-style message. Don't run wordwiki/ tests if another session is working there.
