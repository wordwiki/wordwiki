---
name: wordwiki-toplevel-upgrade
description: "Wordwiki's top level is on the rabid/liminal standard (2026-06-10) — sessions, login, rabid-style user/config tables, wordwiki.sh, test harness"
metadata: 
  node_type: memory
  type: project
  originSessionId: c4675fb2-aad8-4afe-a51d-24117428b622
---

Wordwiki's top level now matches rabid (done 2026-06-10):

- **Tables (new liminal style, auto-created on serve):** `wordwiki/user.ts` (UserTable — username = the 3-letter code stored in assertion attrs; `permissions` roles admin/publish/testing; PasswordHashTable; UserSessionTable with test-client columns) + ConfigTable in `wordwiki/config.ts` (db_purpose + assertSafeToWipe). Old raw-DML user table removed from schema.ts (was empty/unused). Users seeded from entry-schema's hardcoded `users` map via `./wordwiki.sh upgrade-users` (the map STAYS as the enum-options label source for now — deriving $options from the table is a follow-up).
- **Auth:** all /ww/ routes gated behind login (rewriteUnauthenticatedRoute); GET login allowed on non-production (`/ww/wordwiki.loginRequest(queryArgs)?username=djz&password=...`); sessions are db rows (revocable, survive restarts). The two legacy root endpoints (/page/..., /workspace-rpc-and-sync) bypass the gate until the old editor retires. **Dev db marked db_purpose=dev; ALL passwords (djz's too, and the 'test' robot's) come from the gitignored user-passwords.json — the djz-dev override was removed 2026-07-02, see [[user-passwords-seed-file]]**. `change_by_username` is now stamped from the session in every lexeme-editor assertion (changeStamp()).
- **Pages:** templates.page()/isPage marker + htmxPageTemplate (htmx navbar w/ Users/test-client/logout, modal skeleton, liminal scripts) via WordWiki.coercePageResult; the LEGACY pageTemplate stays for old-editor routes. Users page = standard editable-item list at /ww/wordwiki.usersPage().
- **Run script:** `./wordwiki.sh` (adapted from rabid.sh; cd ~/mmo, port 9000, clean-stop-then-start; commands: serve(default)/upgrade-users/set-password/set-db-purpose/post-pull). Does NOT transpile — use publishHomeAndServe.sh when old-editor client code/resources change.
- **Production pulls (2026-06-11):** the dev db is now a fresh production pull. `./wordwiki.sh post-pull` makes a pulled prod db dev-runnable (replaces old-shape empty user table, seeds users + passwords from user-passwords.json, marks dev) — idempotent, and `pullWordWikiV1Db.sh` (now versioned) runs it automatically after the rsync. Needed until the new version IS production. dz is starting a batch re-categorization project for lexemes (stats from prod: 8,822 entries, 92% with glosses, 264 messy hand categories incl. `_`×232 and a long once-used tail).
- **Eval/test bridge:** /eval enabled on dev db (wordwiki-eval-password.txt in ~/mmo); evalServer override gives wordwiki lexical scope.

**Why:** brings rabid's testing, sessions, logins and table editing to wordwiki; base for migrating more tables to the rabid style over time.

**How to apply:** new tables go on WordWiki as `@path get foo()` + into `tables`; new pages return templates.page(). Related: [[lexeme-editor-v2]], [[testing-approach]], [[wordwiki-assertion-model]].
