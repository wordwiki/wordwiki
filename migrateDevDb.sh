#!/bin/bash
set -e

# The COMPLETE dev-db migration rehearsal, as one repeatable program:
# pull the production db and rebuild it onto the controlled category +
# lexical-form vocabularies, with every step validated.  Rerun any time;
# every step is idempotent and the local db/content are disposable copies.
#
#   ./migrateDevDb.sh
#
# Steps:
#   1. stop the server (BEFORE the rsync replaces the db under it)
#   2. pull db + content from staging (pullDbFromPublic.sh, whose post-pull
#      recreates/seeds users - including the '~' automation identities -
#      marks the db 'dev' and sets djz's dev password)
#   3. repair-assertions: idempotent structural fixes of pre-existing store
#      corruption (dangling chain heads); a no-op once clean
#   4. import categories (stamped '~category-import')
#   5. prove category-import idempotency (re-run must be a pure no-op)
#   6. import lexical forms (stamped '~lexical-form-import') + same proof
#   7. verify-migration: read-only invariant checks (system users present,
#      one current version per fact, scheme==table, all current category
#      values tabled, no orphaned tuples, tier sizes exactly 10/90/900,
#      POS normalization at its fixed point, ...); exits nonzero on failure
#   8. verify-workspace: read-only STRUCTURAL invariants of the whole
#      assertion store (chain continuity, no orphans/dangling tails, ...);
#      exits nonzero on any problem - proves the repair + imports left the
#      store well-formed
#   9. restart the server and smoke-test it over HTTP
#
# ---- The PRODUCTION cutover (when the day comes) is NOT this script ------
# On the production host (no pull, no dev marking, no dev password):
#   1. stop the server; BACK UP the db file
#   2. ./wordwiki.sh repair-assertions --allow-production
#   3. ./wordwiki.sh import-categories --allow-production
#   4. ./wordwiki.sh import-categories --allow-production --expect-no-changes
#   5. ./wordwiki.sh import-lexical-forms --allow-production
#   6. ./wordwiki.sh import-lexical-forms --allow-production --expect-no-changes
#   7. ./wordwiki.sh verify-migration   (read-only; same checks as here;
#      expect a WARNING for entries created after the assignments dump -
#      those need incremental tagging)
#   8. ./wordwiki.sh verify-workspace   (read-only structural invariants)
#   9. start the server; ./wordwiki.sh publish; spot-check the site
# --------------------------------------------------------------------------

cd "$(dirname "$0")"

step() { echo; echo "=== $* ==="; }

step "[1/9] stopping the server"
./wordwiki.sh stop

step "[2/9] pulling production db + content from staging"
./pullDbFromPublic.sh

step "[3/9] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions

step "[4/9] importing categories"
./wordwiki.sh import-categories

step "[5/9] category import idempotency proof"
./wordwiki.sh import-categories --expect-no-changes

step "[6/9] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms
./wordwiki.sh import-lexical-forms --expect-no-changes

step "[7/9] verifying the migration"
./wordwiki.sh verify-migration

step "[8/9] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace

step "[9/9] starting the server + smoke test"
(./wordwiki.sh serve > /tmp/wordwiki-serve.log 2>&1 &)
for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 http://localhost:9000/ww/ && break
    sleep 1
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/ww/)
[ "$CODE" = "200" ] || { echo "SMOKE FAIL: server answered $CODE"; exit 1; }
COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT
curl -s -c "$COOKIES" -o /dev/null \
    'http://localhost:9000/ww/wordwiki.loginRequest(queryArgs)?username=djz&password=djz-dev'
NCATS=$(curl -s -b "$COOKIES" 'http://localhost:9000/ww/wordwiki.categoriesPage()' \
        | tr '<' '\n' | grep -c 'data-testid="category-row-')
[ "$NCATS" -ge 85 ] || { echo "SMOKE FAIL: categories page shows only $NCATS rows"; exit 1; }
NFORMS=$(curl -s -b "$COOKIES" 'http://localhost:9000/ww/wordwiki.lexicalFormsPage()' \
        | tr '<' '\n' | grep -c 'data-testid="lexical-form-row-')
[ "$NFORMS" -ge 15 ] || { echo "SMOKE FAIL: lexical forms page shows only $NFORMS rows"; exit 1; }
echo "smoke ok: server 200, $NCATS categories, $NFORMS lexical forms"

echo
echo "migration rehearsal complete."
