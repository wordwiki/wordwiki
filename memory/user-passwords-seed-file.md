---
name: user-passwords-seed-file
description: "user-passwords.json (gitignored, plaintext) is the ONLY source of team passwords; copy by hand to new checkouts/hosts — the caddy conf + extractor it came from were deleted 2026-07-02"
metadata: 
  node_type: memory
  type: project
  originSessionId: 225013f3-43d7-4dc9-879f-2805f7150e40
---

`<repo>/user-passwords.json` — gitignored `{username: plaintext-password}` map — is the primary artifact for seeding the language team's passwords (carried over from the old basic-auth site). Loaded by `wordwiki.sh post-pull` and `upgrade-users` via `user.seedPasswordsFromFile`, which fills in only users with no password yet (never overwrites; missing file = HARD FAIL of the recipe, by dz's request; djz's dev override djz-dev still wins in post-pull).

**Why:** the caddy config (mikmaqonline.conf) and extractUserPasswords.ts were deleted once the JSON existed, so the file can no longer be regenerated.

**How to apply:** a new checkout or the production host needs user-passwords.json copied over by hand before post-pull/upgrade-users will seed team passwords. Related: [[wordwiki-toplevel-upgrade]].
