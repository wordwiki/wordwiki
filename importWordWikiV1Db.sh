#!/bin/bash
set -e

# PHASE 2 of the rebuild pipeline (rebuildAll.sh runs 1->2->3->4): the
# IDEMPOTENT MIGRATION.  Take the pristine live snapshot (live-v1.db, pulled
# by Phase 1 pullLiveSnapshot.sh), copy it to the working db.db, and rebuild
# it onto the current model - controlled vocabularies, publication dimension,
# orthography variants, support tables - every step validated and idempotent.
# The result is a RUNNABLE, smoke-tested system with all V1 data migrated;
# the DERIVED data (bindings, page maps, review pages) is Phase 3
# (rebuildDerived.sh).
#
# Because Phase 1 leaves live-v1.db untouched, this phase re-copies it and
# re-migrates from clean on every run - so it can be re-run freely (e.g.
# after a schema or migration change) WITHOUT re-pulling.  Re-run trigger:
# a schema / migration-code change.
#
# NO-AI PROOF MODE (dz 2026-07-28): `touch <instance>/no-llm-calls` before
# running and any ACTUAL LLM work throws loudly.  Migration does no AI work;
# the flag matters most for Phase 3, but is honoured here too.
#
#   ./importWordWikiV1Db.sh                     # copy live-v1.db -> db.db, migrate
#   ./importWordWikiV1Db.sh --in-place          # migrate the db.db already here
#                                     # (no copy, no re-seed) - the shape used
#                                     # by the PRODUCTION CUTOVER, where the
#                                     # production db IS the local db.
#   ./importWordWikiV1Db.sh --in-place --allow-production
#                                     # the REAL cutover: production marker
#                                     # honoured by every mutating step.
#                                     # BACK UP the db file first!
#
# Every step's commentary lands in <instance>/import-report/NN-<step>.md and
# a trap assembles import-report.md (executive summary; CRASHED/MISSING
# markers) even when a step fails.  The server renders it at
# /ww/wordwiki.importReport().
#
# Steps:
#   1. REFUSE if <instance>/wordwiki.pid exists (a server may be live)
#   2. stage the snapshot: copy live-v1.db -> db.db, then post-pull (recreate/
#      seed users incl. the '~' automation identities + the 'test' robot from
#      the never-checked-in user-passwords.json, mark the db 'dev').
#      --in-place skips this: migrate the db.db already present (cutover)
#   3. repair-assertions: idempotent structural fixes of pre-existing store
#      corruption; no-op once clean
#   4. ensure-dict-config: create the dictionary CONFIG PAIR + load the schema
#   5-6. import categories (+ idempotency proof)
#   7. import lexical forms (+ proof)
#   8. import legacy twitter-posts (+ proof)
#   9. publication Phase 0: born-approve existing approved data (+ proof)
#  10. normalize legacy shoebox creation dates to ISO (+ proof)
#  11. the STATUS remodel migration (+ proof)
#  12. the orthography VARIANT migration (+ proof)
#  13. TESTING auto-publish-sf: born-published mm-sf for fully-transliterated
#      words so the test db has an SF site (+ proof)
#  14. import the Watson RAND corpus (mirror + mapping + transform) - the
#      canonical rand DICTIONARY data (its DERIVED bindings/pages are Phase 3)
#  15. verify-migration: read-only invariant checks
#  16. verify-workspace: read-only structural invariants of the whole store
#  17. start the server, smoke-test it over HTTP, then STOP it (the phase must
#      end with the db AT REST so Phase 4 can rsync it safely)
#
# ---- The PRODUCTION cutover (when the day comes) ------------------------
# On the production host: stop the server, BACK UP the db file, then
#   ./importWordWikiV1Db.sh --in-place --allow-production
# then Phase 3 (rebuildDerived.sh --allow-production), then ./wordwiki.sh
# publish; spot-check the site.
# --------------------------------------------------------------------------

cd "$(dirname "$0")"
RUN_DIR="${WORDWIKI_DIR:-$PWD/mmo}"

# REFUSE while a server may be live (dz): this script often runs OUTSIDE the
# container while the server runs INSIDE it, where wordwiki.sh's /proc-based
# liveness check cannot see across the pid namespace - so pidfile PRESENCE is
# the signal.  Working over a live db file risks a torn copy.
PIDFILE="$RUN_DIR/wordwiki.pid"
if [ -f "$PIDFILE" ]; then
    echo "REFUSING: $PIDFILE exists - a wordwiki server may be running (possibly inside the container)." >&2
    echo "Stop it from the environment it runs in (./wordwiki.sh stop), or remove the stale pidfile:" >&2
    echo "    rm '$PIDFILE'" >&2
    exit 1
fi

# Flags: --in-place migrates the db already in place (the cutover, or a
# targeted re-run over an existing working db); --allow-production is passed
# through to every mutating step (the cutover target is marked
# db_purpose='production' and each step refuses it otherwise).
IN_PLACE=0
ALLOW_PROD=""
for arg in "$@"; do
    case "$arg" in
        --in-place)         IN_PLACE=1 ;;
        --allow-production) ALLOW_PROD="--allow-production" ;;
        *) echo "unknown argument: $arg (known: --in-place, --allow-production)" >&2; exit 1 ;;
    esac
done

step() { echo; echo "=== $* ==="; }

# THE FINDINGS PUBLISH PATH: every step writes its commentary as a findings
# fragment under <instance>/import-report/, and a trap assembles them into
# import-report.md WITH an executive summary - even when a step crashes.
RD="import-report"
rm -rf "$RUN_DIR/$RD"
mkdir -p "$RUN_DIR/$RD"
EXPECTED="repair-assertions ensure-dict-config ensure-dict-config-proof import-categories import-categories-proof \
import-lexical-forms import-lexical-forms-proof \
import-twitter-posts import-twitter-posts-proof \
backfill-publication backfill-publication-proof \
normalize-shoebox-dates normalize-shoebox-dates-proof \
migrate-status migrate-status-proof migrate-variants migrate-variants-proof \
auto-publish-sf auto-publish-sf-proof \
rand-import rand-transform \
verify-migration verify-workspace smoke"
# ONE consolidated EXIT trap (the smoke test's cookie cleanup lives here too,
# NOT in its own trap, which would silently REPLACE this one).
COOKIES=""
finish() {
    [ -n "$COOKIES" ] && rm -f "$COOKIES"
    # shellcheck disable=SC2086
    ./wordwiki.sh assemble-import-report "$RD" import-report.md $EXPECTED
}
trap finish EXIT

step "[1/17] server liveness check passed above (wordwiki.pid absent)"

if [ "$IN_PLACE" = 1 ]; then
    step "[2/17] --in-place: migrating the db already here (no snapshot copy, no re-seed)"
else
    step "[2/17] staging the snapshot: live-v1.db -> db.db, then post-pull"
    LIVE="$RUN_DIR/database/live-v1.db"
    [ -f "$LIVE" ] || { echo "no '$LIVE' - run ./pullLiveSnapshot.sh (Phase 1) first" >&2; exit 1; }
    cp "$LIVE" "$RUN_DIR/database/db.db"
    # post-pull stops any running server, recreates/seeds the user tables +
    # passwords from user-passwords.json, and marks the db 'dev'.  Idempotent.
    WORDWIKI_DIR="$RUN_DIR" ./wordwiki.sh post-pull
fi

step "[3/17] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions $ALLOW_PROD --report=$RD/03-repair-assertions.md

step "[4/17] creating the dictionary config pair + loading the schema (+ proof)"
./wordwiki.sh ensure-dict-config $ALLOW_PROD --report=$RD/04-ensure-dict-config.md
./wordwiki.sh ensure-dict-config $ALLOW_PROD --expect-no-changes --report=$RD/04-ensure-dict-config-proof.md

step "[5/17] importing categories"
./wordwiki.sh import-categories $ALLOW_PROD --report=$RD/05-import-categories.md

step "[6/17] category import idempotency proof"
./wordwiki.sh import-categories $ALLOW_PROD --expect-no-changes --report=$RD/06-import-categories-proof.md

step "[7/17] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms $ALLOW_PROD --report=$RD/07-import-lexical-forms.md
./wordwiki.sh import-lexical-forms $ALLOW_PROD --expect-no-changes --report=$RD/07-import-lexical-forms-proof.md

step "[8/17] importing legacy twitter-posts (+ idempotency proof)"
# --report-skipped refreshes the committed hand-off list of the words a human
# must place in production (homonyms/unmatched); it shrinks as they are fixed.
./wordwiki.sh import-twitter-posts $ALLOW_PROD --report-skipped=skipped-twitter-posts.md --report=$RD/08-import-twitter-posts.md
./wordwiki.sh import-twitter-posts $ALLOW_PROD --expect-no-changes --report=$RD/08-import-twitter-posts-proof.md

step "[9/17] publication Phase 0: born-approve existing data (+ idempotency proof)"
./wordwiki.sh backfill-publication $ALLOW_PROD --report=$RD/09-backfill-publication.md
./wordwiki.sh backfill-publication $ALLOW_PROD --expect-no-changes --report=$RD/09-backfill-publication-proof.md

step "[10/17] normalizing legacy shoebox creation dates (+ idempotency proof)"
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --report=$RD/10-normalize-shoebox-dates.md
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --expect-no-changes --report=$RD/10-normalize-shoebox-dates-proof.md

step "[11/17] the status remodel migration (+ idempotency proof)"
# Gates + renames + lifecycle synthesis; the committed report names the
# CompleteAsPDMOnly words that leave the public site.
./wordwiki.sh migrate-status $ALLOW_PROD --report=$RD/11-migrate-status.md
./wordwiki.sh migrate-status $ALLOW_PROD --expect-no-changes --report=$RD/11-migrate-status-proof.md

step "[12/17] the orthography variant migration (+ idempotency proof)"
# The committed report is the point-in-time record (hand-triage remainder,
# per-action counts); the LIVE Variant Cleanup page is the draining queue.
./wordwiki.sh migrate-variants $ALLOW_PROD --report=$RD/12-migrate-variants.md
./wordwiki.sh migrate-variants $ALLOW_PROD --expect-no-changes --report=$RD/12-migrate-variants-proof.md

step "[13/17] TESTING: auto-publishing fully-transliterated words as SF (+ proof)"
# The SF-site prototype (dz 2026-07-08): every li-public word whose li
# content is FULLY matched by SF facts gets a born-published mm-sf gate.
# On the production flow this decision belongs to the staff, guided by the
# SF-Ready Words report - this step exists so the test db has an SF site.
./wordwiki.sh auto-publish-sf $ALLOW_PROD --report=$RD/13-auto-publish-sf.md
./wordwiki.sh auto-publish-sf $ALLOW_PROD --expect-no-changes --report=$RD/13-auto-publish-sf-proof.md

step "[14/17] importing the Watson RAND corpus (mirror + mapping + transform)"
# The two-step import (multi-dictionary-survey.md phase 5): the literal
# mirror (content-keyed ids - stable across Watson drops), then the
# mapping-driven transform into the rich dictionary.  Deterministic.  This is
# canonical DATA; its derived bindings/page-maps are Phase 3.  exit 2 =
# worklist items remain, expected while the mapping iterates.
./wordwiki.sh sfm-import randraw --typ=../watson/rand-structural.typ \
    --data=../watson/rand-merged.sfm --structure=tree \
    --report=$RD/14-rand-import.md || [ $? -eq 2 ]
./wordwiki.sh load-mapping rand ../watson/rand-transform.json --apply > /dev/null
./wordwiki.sh transform rand --report=$RD/14-rand-transform.md \
    --details=../watson/rand-transform-report.md || [ $? -eq 2 ]

step "[15/17] verifying the migration"
./wordwiki.sh verify-migration --report=$RD/15-verify-migration.md

step "[16/17] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace --report=$RD/16-verify-workspace.md

step "[17/17] starting the server + smoke test (stopped again after)"
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
cat > "$RUN_DIR/$RD/17-smoke.md" <<SMOKE
# Smoke test

**0 finding(s)** across 1 section(s):

## Log

- server answered 200; $NCATS categories; $NFORMS lexical forms
SMOKE

# End STOPPED (dz): Phase 4 (updateStaging.sh) rsyncs the db file, and a
# running server means pushing a live db.  Start it by hand when needed.
./wordwiki.sh stop

echo
echo "Phase 2 complete: V1 data migrated, system smoke-tested (server stopped)."
echo "Next: ./rebuildDerived.sh   (Phase 3 - rebuild derived data)"
