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
#      recreates/seeds users - including the '~' automation identities and
#      the 'test' robot - seeds passwords from the never-checked-in
#      user-passwords.json, and marks the db 'dev')
#   3. repair-assertions: idempotent structural fixes of pre-existing store
#      corruption (dangling chain heads + clearing the legacy published_*
#      placeholder, which must go before any workspace load); no-op once clean
#   4. import categories (stamped '~category-import')
#   5. prove category-import idempotency (re-run must be a pure no-op)
#   6. import lexical forms (stamped '~lexical-form-import') + same proof
#   7. publication Phase 0: born-approve existing approved data by mute-in-
#      place (stamp published_* on the current facts of Completed entries;
#      NO approval rows; AFTER imports so re-categorized tuples are stamped
#      and tombstoned old ones are not); idempotent
#   8. normalize shoebox dates: rewrite the imported lexemes' legacy
#      shoebox-date attribute values to ISO yyyy-mm-dd, mute-in-place (the
#      lexeme creation dates - see creation-dates.ts; validates the whole
#      corpus loudly here rather than silently at query time); idempotent
#   9. verify-migration: read-only invariant checks; exits nonzero on failure
#  10. verify-workspace: read-only STRUCTURAL invariants of the whole store
#  11. restart the server and smoke-test it over HTTP
#
# ---- The PRODUCTION cutover (when the day comes) is NOT this script ------
# On the production host (no pull, no dev marking, no dev password):
#   1. stop the server; BACK UP the db file
#   2. ./wordwiki.sh repair-assertions --allow-production
#   3. ./wordwiki.sh import-categories --allow-production
#   4. ./wordwiki.sh import-categories --allow-production --expect-no-changes
#   5. ./wordwiki.sh import-lexical-forms --allow-production
#   6. ./wordwiki.sh import-lexical-forms --allow-production --expect-no-changes
#   7. ./wordwiki.sh backfill-publication --allow-production
#   8. ./wordwiki.sh backfill-publication --allow-production --expect-no-changes
#   9. ./wordwiki.sh normalize-shoebox-dates --allow-production
#  10. ./wordwiki.sh normalize-shoebox-dates --allow-production --expect-no-changes
#  11. ./wordwiki.sh verify-migration   (read-only; same checks as here;
#      expect a WARNING for entries created after the assignments dump)
#  12. ./wordwiki.sh verify-workspace   (read-only structural invariants)
#  13. start the server; ./wordwiki.sh publish; spot-check the site
# --------------------------------------------------------------------------

cd "$(dirname "$0")"

step() { echo; echo "=== $* ==="; }

step "[1/11] stopping the server"
./wordwiki.sh stop

step "[2/11] pulling production db + content from staging"
./pullDbFromPublic.sh

step "[3/11] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions

step "[4/11] importing categories"
./wordwiki.sh import-categories

step "[5/11] category import idempotency proof"
./wordwiki.sh import-categories --expect-no-changes

step "[6/11] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms
./wordwiki.sh import-lexical-forms --expect-no-changes

step "[7/11] publication Phase 0: born-approve existing data (+ idempotency proof)"
./wordwiki.sh backfill-publication
./wordwiki.sh backfill-publication --expect-no-changes

step "[8/11] normalizing legacy shoebox creation dates (+ idempotency proof)"
./wordwiki.sh normalize-shoebox-dates
./wordwiki.sh normalize-shoebox-dates --expect-no-changes

step "[9/11] verifying the migration"
./wordwiki.sh verify-migration

step "[10/11] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace

step "[11/11] starting the server + smoke test"
(./wordwiki.sh serve > /tmp/wordwiki-serve.log 2>&1 &)
for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 http://localhost:9000/ww/ && break
    sleep 1
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/ww/)
[ "$CODE" = "200" ] || { echo "SMOKE FAIL: server answered $CODE"; exit 1; }
# Smoke-check as the dedicated 'test' robot (NEVER a human's account - tests
# must not depend on any particular human existing), password from the same
# never-checked-in user-passwords.json post-pull seeds from.
TESTPW=$(jq -r '.test // empty' user-passwords.json)
[ -n "$TESTPW" ] || { echo "SMOKE FAIL: no 'test' entry in user-passwords.json"; exit 1; }
COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT
curl -s -c "$COOKIES" -o /dev/null --data-urlencode "username=test" --data-urlencode "password=$TESTPW" -G \
    'http://localhost:9000/ww/wordwiki.loginRequest(queryArgs)'
NCATS=$(curl -s -b "$COOKIES" 'http://localhost:9000/ww/wordwiki.categoriesPage()' \
        | tr '<' '\n' | grep -c 'data-testid="category-row-')
[ "$NCATS" -ge 85 ] || { echo "SMOKE FAIL: categories page shows only $NCATS rows"; exit 1; }
NFORMS=$(curl -s -b "$COOKIES" 'http://localhost:9000/ww/wordwiki.lexicalFormsPage()' \
        | tr '<' '\n' | grep -c 'data-testid="lexical-form-row-')
[ "$NFORMS" -ge 15 ] || { echo "SMOKE FAIL: lexical forms page shows only $NFORMS rows"; exit 1; }
echo "smoke ok: server 200, $NCATS categories, $NFORMS lexical forms"

echo
echo "migration rehearsal complete."
