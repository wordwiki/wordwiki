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
#   3. import categories (stamped '~category-import')
#   4. prove category-import idempotency (re-run must be a pure no-op)
#   5. import lexical forms (stamped '~lexical-form-import') + same proof
#   6. verify-migration: read-only invariant checks (system users present,
#      one current version per fact, scheme==table, all current category
#      values tabled, no orphaned tuples, tier sizes exactly 10/90/900,
#      POS normalization at its fixed point, ...); exits nonzero on failure
#   7. restart the server and smoke-test it over HTTP
#
# ---- The PRODUCTION cutover (when the day comes) is NOT this script ------
# On the production host (no pull, no dev marking, no dev password):
#   1. stop the server; BACK UP the db file
#   2. ./wordwiki.sh import-categories --allow-production
#   3. ./wordwiki.sh import-categories --allow-production --expect-no-changes
#   4. ./wordwiki.sh import-lexical-forms --allow-production
#   5. ./wordwiki.sh import-lexical-forms --allow-production --expect-no-changes
#   6. ./wordwiki.sh verify-migration   (read-only; same checks as here;
#      expect a WARNING for entries created after the assignments dump -
#      those need incremental tagging)
#   7. start the server; ./wordwiki.sh publish; spot-check the site
# --------------------------------------------------------------------------

cd "$(dirname "$0")"

step() { echo; echo "=== $* ==="; }

step "[1/7] stopping the server"
./wordwiki.sh stop

step "[2/7] pulling production db + content from staging"
./pullDbFromPublic.sh

step "[3/7] importing categories"
./wordwiki.sh import-categories

step "[4/7] category import idempotency proof"
./wordwiki.sh import-categories --expect-no-changes

step "[5/7] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms
./wordwiki.sh import-lexical-forms --expect-no-changes

step "[6/7] verifying the migration"
./wordwiki.sh verify-migration

step "[7/7] starting the server + smoke test"
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
