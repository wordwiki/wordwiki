#!/bin/bash
set -e

# Import the WORDWIKI V1 PRODUCTION DATABASE into the current wordwiki
# install, as one repeatable program: pull the V1 db, then rebuild it onto
# the current model (controlled vocabularies, publication dimension,
# orthography variants), every step validated and idempotent.
#
# We run this REPEATEDLY during development - each re-run re-rehearses the
# whole migration against the latest V1 data - and will run it ONCE FOR REAL
# on the production V2 target at cutover.
#
#   ./importWordWikiV1Db.sh                           # rehearsal: pull + migrate
#   ./importWordWikiV1Db.sh --no-pull                 # migrate the db already here
#   ./importWordWikiV1Db.sh --no-pull --allow-production
#                                     # the REAL cutover on the V2 production
#                                     # target: no pull (the V1 db IS the local
#                                     # db), production marker honoured.
#                                     # BACK UP the db file first!
#
# The PULL step is packaged separately as ./pullWordWikiV1Db.sh (fetch the
# V1 db + make it runnable as a dev db) because re-pulling alone is a useful
# loop; THIS script is that pull + the migration steps + the proofs.
#
# Steps:
#   1. stop the server (BEFORE the rsync replaces the db under it)
#   2. pull db + content from the V1 source (pullWordWikiV1Db.sh, whose post-pull
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
# ---- The PRODUCTION cutover (when the day comes) IS this script ----------
# On the production host: stop the server, BACK UP the db file, then
#   ./importWordWikiV1Db.sh --no-pull --allow-production
# (verify-migration may WARN about entries created after the assignments
# dump.)  Afterwards: ./wordwiki.sh publish; spot-check the site.
# --------------------------------------------------------------------------

cd "$(dirname "$0")"

# Flags: --no-pull migrates the db already in place (a re-run, or the real
# cutover); --allow-production is passed through to every mutating step (the
# cutover target is marked db_purpose='production' and each step refuses it
# otherwise).
NO_PULL=0
ALLOW_PROD=""
for arg in "$@"; do
    case "$arg" in
        --no-pull)          NO_PULL=1 ;;
        --allow-production) ALLOW_PROD="--allow-production" ;;
        *) echo "unknown argument: $arg (known: --no-pull, --allow-production)" >&2; exit 1 ;;
    esac
done

step() { echo; echo "=== $* ==="; }

step "[1/13] stopping the server"
./wordwiki.sh stop

if [ "$NO_PULL" = 1 ]; then
    step "[2/13] pull SKIPPED (--no-pull): migrating the db already in place"
else
    step "[2/13] pulling the V1 production db + content (pullWordWikiV1Db.sh)"
    ./pullWordWikiV1Db.sh
fi

step "[3/13] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions $ALLOW_PROD

step "[4/13] importing categories"
./wordwiki.sh import-categories $ALLOW_PROD

step "[5/13] category import idempotency proof"
./wordwiki.sh import-categories $ALLOW_PROD --expect-no-changes

step "[6/13] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms $ALLOW_PROD
./wordwiki.sh import-lexical-forms $ALLOW_PROD --expect-no-changes

step "[7/13] importing legacy twitter-posts (+ idempotency proof)"
# --report-skipped refreshes the committed hand-off list of the words a human
# must place in production (homonyms/unmatched); it shrinks as they are fixed.
./wordwiki.sh import-twitter-posts $ALLOW_PROD --report-skipped=skipped-twitter-posts.md
./wordwiki.sh import-twitter-posts $ALLOW_PROD --expect-no-changes

step "[8/13] publication Phase 0: born-approve existing data (+ idempotency proof)"
./wordwiki.sh backfill-publication $ALLOW_PROD
./wordwiki.sh backfill-publication $ALLOW_PROD --expect-no-changes

step "[9/13] normalizing legacy shoebox creation dates (+ idempotency proof)"
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --expect-no-changes

step "[10/13] the orthography variant migration (+ idempotency proof)"
# The committed report is the point-in-time record (hand-triage remainder,
# per-action counts); the LIVE Variant Cleanup page is the draining queue.
./wordwiki.sh migrate-variants $ALLOW_PROD --report variant-migration-report.md
./wordwiki.sh migrate-variants $ALLOW_PROD --expect-no-changes

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
echo "V1 db import complete."
