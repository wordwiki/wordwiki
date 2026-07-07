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
# Every step's commentary lands in <instance>/import-report/NN-<step>.md and
# a trap assembles import-report.md (executive summary; CRASHED/MISSING
# markers) even when a step fails.  The server renders it all at
# /ww/wordwiki.importReport().
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
#  10. migrate-status: the STATUS REMODEL (fix-orthographies.md "Status"):
#      publish gates born from Completed statuses (CompleteAsPDMOnly
#      deliberately gets none), Completed->Complete renames, sta variant
#      blanked (lifecycle is whole-lexeme), 'Unknown' synthesized for
#      no-status entries.  ONCE PER DB (config marker); BEFORE
#      migrate-variants so the gate orthography can read the sta variant
#  11. migrate-variants: THE orthography data migration (fix-orthographies.md):
#      blank normalize + $notVariant column drop + explicit value fixes +
#      per-tag blank backfill, mute-in-place; preconditions re-checked
#      (flagged schema, scan drop gate, mapping coverage); hand-triage rows
#      left for the live Variant Cleanup report; refreshes the committed
#      variant-migration-report.md; idempotent + proof
#  12. verify-migration: read-only invariant checks; exits nonzero on failure
#  13. verify-workspace: read-only STRUCTURAL invariants of the whole store
#      (variant invariants reported as warnings - only the hand-triage
#      remainder should show post-migration)
#  14. start the server, smoke-test it over HTTP, then STOP it - the import
#      must end with the db AT REST: updateStaging.sh rsyncs the db file,
#      and pushing one with a live writer risks a torn copy.  Restart by
#      hand (./wordwiki.sh) when you want to poke around
#
# ---- The PRODUCTION cutover (when the day comes) IS this script ----------
# On the production host: stop the server, BACK UP the db file, then
#   ./importWordWikiV1Db.sh --no-pull --allow-production
# (verify-migration may WARN about entries created after the assignments
# dump.)  Afterwards: ./wordwiki.sh publish; spot-check the site.
# --------------------------------------------------------------------------

cd "$(dirname "$0")"
RUN_DIR="${WORDWIKI_DIR:-$PWD/mmo}"

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

# THE FINDINGS PUBLISH PATH (fix-orthographies.md): every step writes its
# commentary as a findings fragment under <instance>/import-report/, and a
# trap assembles them into import-report.md WITH an executive summary - even
# when a step crashes, which is exactly when the report matters most.  The
# server renders it at /ww/wordwiki.importReport().
RD="import-report"
rm -rf "$RUN_DIR/$RD"
mkdir -p "$RUN_DIR/$RD"
EXPECTED="repair-assertions import-categories import-categories-proof \
import-lexical-forms import-lexical-forms-proof \
import-twitter-posts import-twitter-posts-proof \
backfill-publication backfill-publication-proof \
normalize-shoebox-dates normalize-shoebox-dates-proof \
migrate-status migrate-status-proof migrate-variants migrate-variants-proof \
verify-migration verify-workspace smoke"
# ONE consolidated EXIT trap (bash keeps a single trap per signal - the
# smoke test's cookie cleanup lives here too, NOT in its own trap, which
# would silently REPLACE this one and skip the assembly on success).
COOKIES=""
finish() {
    [ -n "$COOKIES" ] && rm -f "$COOKIES"
    # shellcheck disable=SC2086
    ./wordwiki.sh assemble-import-report "$RD" import-report.md $EXPECTED
}
trap finish EXIT

step "[1/14] stopping the server"
./wordwiki.sh stop

if [ "$NO_PULL" = 1 ]; then
    step "[2/14] pull SKIPPED (--no-pull): migrating the db already in place"
else
    step "[2/14] pulling the V1 production db + content (pullWordWikiV1Db.sh)"
    ./pullWordWikiV1Db.sh
fi

step "[3/14] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions $ALLOW_PROD --report=$RD/03-repair-assertions.md

step "[4/14] importing categories"
./wordwiki.sh import-categories $ALLOW_PROD --report=$RD/04-import-categories.md

step "[5/14] category import idempotency proof"
./wordwiki.sh import-categories $ALLOW_PROD --expect-no-changes --report=$RD/05-import-categories-proof.md

step "[6/14] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms $ALLOW_PROD --report=$RD/06-import-lexical-forms.md
./wordwiki.sh import-lexical-forms $ALLOW_PROD --expect-no-changes --report=$RD/06-import-lexical-forms-proof.md

step "[7/14] importing legacy twitter-posts (+ idempotency proof)"
# --report-skipped refreshes the committed hand-off list of the words a human
# must place in production (homonyms/unmatched); it shrinks as they are fixed.
./wordwiki.sh import-twitter-posts $ALLOW_PROD --report-skipped=skipped-twitter-posts.md --report=$RD/07-import-twitter-posts.md
./wordwiki.sh import-twitter-posts $ALLOW_PROD --expect-no-changes --report=$RD/07-import-twitter-posts-proof.md

step "[8/14] publication Phase 0: born-approve existing data (+ idempotency proof)"
./wordwiki.sh backfill-publication $ALLOW_PROD --report=$RD/08-backfill-publication.md
./wordwiki.sh backfill-publication $ALLOW_PROD --expect-no-changes --report=$RD/08-backfill-publication-proof.md

step "[9/14] normalizing legacy shoebox creation dates (+ idempotency proof)"
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --report=$RD/09-normalize-shoebox-dates.md
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --expect-no-changes --report=$RD/09-normalize-shoebox-dates-proof.md

step "[10/14] the status remodel migration (+ idempotency proof)"
# Gates + renames + lifecycle synthesis; the committed report names the
# CompleteAsPDMOnly words that leave the public site.
./wordwiki.sh migrate-status $ALLOW_PROD --report=$RD/10-migrate-status.md
./wordwiki.sh migrate-status $ALLOW_PROD --expect-no-changes --report=$RD/10-migrate-status-proof.md

step "[11/14] the orthography variant migration (+ idempotency proof)"
# The committed report is the point-in-time record (hand-triage remainder,
# per-action counts); the LIVE Variant Cleanup page is the draining queue.
./wordwiki.sh migrate-variants $ALLOW_PROD --report=$RD/11-migrate-variants.md
./wordwiki.sh migrate-variants $ALLOW_PROD --expect-no-changes --report=$RD/11-migrate-variants-proof.md

step "[12/14] verifying the migration"
./wordwiki.sh verify-migration --report=$RD/12-verify-migration.md

step "[13/14] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace --report=$RD/13-verify-workspace.md

step "[14/14] starting the server + smoke test (stopped again after)"
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
COOKIES=$(mktemp)   # cleaned by the consolidated EXIT trap above
curl -s -c "$COOKIES" -o /dev/null --data-urlencode "username=test" --data-urlencode "password=$TESTPW" -G \
    'http://localhost:9000/ww/wordwiki.loginRequest(queryArgs)'
NCATS=$(curl -s -b "$COOKIES" 'http://localhost:9000/ww/wordwiki.categoriesPage()' \
        | tr '<' '\n' | grep -c 'data-testid="category-row-')
[ "$NCATS" -ge 85 ] || { echo "SMOKE FAIL: categories page shows only $NCATS rows"; exit 1; }
NFORMS=$(curl -s -b "$COOKIES" 'http://localhost:9000/ww/wordwiki.lexicalFormsPage()' \
        | tr '<' '\n' | grep -c 'data-testid="lexical-form-row-')
[ "$NFORMS" -ge 15 ] || { echo "SMOKE FAIL: lexical forms page shows only $NFORMS rows"; exit 1; }
echo "smoke ok: server 200, $NCATS categories, $NFORMS lexical forms"
cat > "$RUN_DIR/$RD/14-smoke.md" <<SMOKE
# Smoke test

**0 finding(s)** across 1 section(s):

## Log

- server answered 200; $NCATS categories; $NFORMS lexical forms
SMOKE

# End STOPPED (dz): updateStaging.sh rsyncs the db file, and a running
# server means pushing a live db.  Start it by hand when needed.
./wordwiki.sh stop

echo
echo "V1 db import complete (server stopped - run ./wordwiki.sh to start it)."
