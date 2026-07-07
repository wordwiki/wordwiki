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
#      corruption (dangling chain heads; clearing the legacy published_*
#      placeholder; cascade-tombstoning dangling live children of deleted
#      parents so the publication tree stays a tree - all BEFORE any workspace
#      load, which now enforces that invariant); no-op once clean
#   4. import categories (stamped '~category-import')
#   5. prove category-import idempotency (re-run must be a pure no-op)
#   6. import lexical forms (stamped '~lexical-form-import') + same proof
#   7. import twitter-posts from the retired legacy Shoebox dump
#      (legacy-mmo.txt): word-a-day was posted there for ~2 years after
#      retirement; match each legacy lexeme to a current entry by Listuguj
#      spelling and add the missing twitter-post (stamped
#      '~twitter-post-import'); homonyms/unmatched skipped + logged.  BEFORE
#      the backfill so the new rows get born-approved.  Idempotent + proof
#   8. publication Phase 0: born-approve existing approved data by mute-in-
#      place (stamp published_* on the current facts of Completed entries;
#      NO approval rows; AFTER imports so re-categorized tuples are stamped
#      and tombstoned old ones are not); idempotent
#   9. normalize shoebox dates: rewrite the imported lexemes' legacy
#      shoebox-date attribute values to ISO yyyy-mm-dd, mute-in-place (the
#      lexeme creation dates - see creation-dates.ts; validates the whole
#      corpus loudly here rather than silently at query time); idempotent
#  10. migrate-variants: THE orthography data migration (fix-orthographies.md):
#      blank normalize + $notVariant column drop + explicit value fixes +
#      per-tag blank backfill, mute-in-place; preconditions re-checked
#      (flagged schema, scan drop gate, mapping coverage); hand-triage rows
#      left for the live Variant Cleanup report; refreshes the committed
#      variant-migration-report.md; idempotent + proof
#  11. verify-migration: read-only invariant checks; exits nonzero on failure
#  12. verify-workspace: read-only STRUCTURAL invariants of the whole store
#      (variant invariants reported as warnings - only the hand-triage
#      remainder should show post-migration)
#  13. restart the server and smoke-test it over HTTP
#
# ---- The PRODUCTION cutover (when the day comes) is NOT this script ------
# On the production host (no pull, no dev marking, no dev password):
#   1. stop the server; BACK UP the db file
#   2. ./wordwiki.sh repair-assertions --allow-production
#   3. ./wordwiki.sh import-categories --allow-production
#   4. ./wordwiki.sh import-categories --allow-production --expect-no-changes
#   5. ./wordwiki.sh import-lexical-forms --allow-production
#   6. ./wordwiki.sh import-lexical-forms --allow-production --expect-no-changes
#   7. ./wordwiki.sh import-twitter-posts --allow-production
#   8. ./wordwiki.sh import-twitter-posts --allow-production --expect-no-changes
#   9. ./wordwiki.sh backfill-publication --allow-production
#  10. ./wordwiki.sh backfill-publication --allow-production --expect-no-changes
#  11. ./wordwiki.sh normalize-shoebox-dates --allow-production
#  12. ./wordwiki.sh normalize-shoebox-dates --allow-production --expect-no-changes
#  13. ./wordwiki.sh migrate-variants --allow-production
#  14. ./wordwiki.sh migrate-variants --allow-production --expect-no-changes
#  15. ./wordwiki.sh verify-migration   (read-only; same checks as here;
#      expect a WARNING for entries created after the assignments dump)
#  16. ./wordwiki.sh verify-workspace   (read-only structural invariants)
#  17. start the server; ./wordwiki.sh publish; spot-check the site
# --------------------------------------------------------------------------

cd "$(dirname "$0")"

step() { echo; echo "=== $* ==="; }

step "[1/13] stopping the server"
./wordwiki.sh stop

step "[2/13] pulling production db + content from staging"
./pullDbFromPublic.sh

step "[3/13] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions

step "[4/13] importing categories"
./wordwiki.sh import-categories

step "[5/13] category import idempotency proof"
./wordwiki.sh import-categories --expect-no-changes

step "[6/13] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms
./wordwiki.sh import-lexical-forms --expect-no-changes

step "[7/13] importing legacy twitter-posts (+ idempotency proof)"
# --report-skipped refreshes the committed hand-off list of the words a human
# must place in production (homonyms/unmatched); it shrinks as they are fixed.
./wordwiki.sh import-twitter-posts --report-skipped=skipped-twitter-posts.md
./wordwiki.sh import-twitter-posts --expect-no-changes

step "[8/13] publication Phase 0: born-approve existing data (+ idempotency proof)"
./wordwiki.sh backfill-publication
./wordwiki.sh backfill-publication --expect-no-changes

step "[9/13] normalizing legacy shoebox creation dates (+ idempotency proof)"
./wordwiki.sh normalize-shoebox-dates
./wordwiki.sh normalize-shoebox-dates --expect-no-changes

step "[10/13] the orthography variant migration (+ idempotency proof)"
# The committed report is the point-in-time record (hand-triage remainder,
# per-action counts); the LIVE Variant Cleanup page is the draining queue.
./wordwiki.sh migrate-variants --report variant-migration-report.md
./wordwiki.sh migrate-variants --expect-no-changes

step "[11/13] verifying the migration"
./wordwiki.sh verify-migration

step "[12/13] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace

step "[13/13] starting the server + smoke test"
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
