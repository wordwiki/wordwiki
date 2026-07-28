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
# NO-AI PROOF MODE (dz 2026-07-28): `touch <instance>/no-llm-calls` before
# running (the flag file lives in the run cwd, beside the credential file;
# LIMINAL_NO_LLM=1 works too) and any ACTUAL LLM work throws loudly, naming
# the model + prompt.  Cache hits never reach the guard - so a re-run in a
# fresh container over a SHARED CONTENT STORE that completes under the flag
# is PROOF the migration is fully cache-served, zero AI spend.
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
#   1. REFUSE if <instance>/wordwiki.pid exists: a server may be live -
#      possibly inside the container, where this script (run outside) cannot
#      stop or even see it.  Stop it from its own environment first, or
#      remove a stale pidfile
#   2. pull db + content from the V1 source (pullWordWikiV1Db.sh, whose post-pull
#      recreates/seeds users - including the '~' automation identities and
#      the 'test' robot - seeds passwords from the never-checked-in
#      user-passwords.json, and marks the db 'dev')
#   3. repair-assertions: idempotent structural fixes of pre-existing store
#      corruption (dangling chain heads; clearing the legacy published_*
#      placeholder; cascade-tombstoning dangling live children of deleted
#      parents so the publication tree stays a tree - all BEFORE any workspace
#      load, which now enforces that invariant); no-op once clean
#   4. ensure-dict-config: create the dictionary CONFIG PAIR
#      (dict + dict_dict_config) and load the schema into it
#      (multi-dictionary-survey.md §3.1) - explicit + reported, with an
#      idempotency proof; every later step's ensure hook keeps it synced
#   5. import categories (stamped '~category-import')
#   6. prove category-import idempotency (re-run must be a pure no-op)
#   7. import lexical forms (stamped '~lexical-form-import') + same proof
#   8. import twitter-posts from the retired legacy Shoebox dump
#      (legacy-mmo.txt): word-a-day was posted there for ~2 years after
#      retirement; match each legacy lexeme to a current entry by Listuguj
#      spelling and add the missing twitter-post (stamped
#      '~twitter-post-import'); homonyms/unmatched skipped + logged.  BEFORE
#      the backfill so the new rows get born-approved.  Idempotent + proof
#   9. publication Phase 0: born-approve existing approved data by mute-in-
#      place (stamp published_* on the current facts of Completed entries;
#      NO approval rows; AFTER imports so re-categorized tuples are stamped
#      and tombstoned old ones are not); idempotent
#  10. normalize shoebox dates: rewrite the imported lexemes' legacy
#      shoebox-date attribute values to ISO yyyy-mm-dd, mute-in-place (the
#      lexeme creation dates - see creation-dates.ts; validates the whole
#      corpus loudly here rather than silently at query time); idempotent
#  11. migrate-status: the STATUS REMODEL (fix-orthographies.md "Status"):
#      publish gates born from Completed statuses (CompleteAsPDMOnly
#      deliberately gets none), Completed->Complete renames, sta variant
#      blanked (lifecycle is whole-lexeme), 'Unknown' synthesized for
#      no-status entries.  ONCE PER DB (config marker); BEFORE
#      migrate-variants so the gate orthography can read the sta variant
#  12. migrate-variants: THE orthography data migration (fix-orthographies.md):
#      blank normalize + $notVariant column drop + explicit value fixes +
#      per-tag blank backfill, mute-in-place; preconditions re-checked
#      (flagged schema, scan drop gate, mapping coverage); hand-triage rows
#      left for the live Variant Cleanup report; refreshes the committed
#      variant-migration-report.md; idempotent + proof
#  13. auto-publish-sf: TESTING (dz 2026-07-08) - every li-public word whose
#      li content is FULLY matched by SF facts gets a born-published mm-sf
#      gate, so the test db has an SF site to look at.  Production will
#      instead guide the staff via the SF-Ready Words report; idempotent +
#      proof
#  14. the WATSON RAND corpus (multi-dictionary-survey.md phase 5 /
#      rand-references-design.md): sfm-import the merged SFM into the
#      randraw mirror (content-keyed ids), install the mapping, transform
#      into the rich `rand` dictionary.  Deterministic: identical inputs
#      re-create identical tables
#  15. derive printed page numbers for the Rand + Clark scans (the
#      citation->scan-page map; exits 2 on unassigned front matter, which
#      is expected and tolerated)
#  16. bind the Rand book's CACHED pages (cached-only by default - dz):
#      every page whose Opus extraction is already in the SHARED derived
#      store lands on rand's tagging sheet ('~rand-binder'-authored);
#      uncached pages are SKIPPED - zero LLM spend, no credential
#      needed, safe on any container.  Extend coverage manually with
#      bind-references WITHOUT --cached-only (paid once per page ever);
#      the sample-page review gallery (46-55) regenerates alongside
#  17. verify-migration: read-only invariant checks; exits nonzero on failure
#  18. verify-workspace: read-only STRUCTURAL invariants of the whole store
#      (variant invariants reported as warnings - only the hand-triage
#      remainder should show post-migration)
#  19. start the server, smoke-test it over HTTP, then STOP it - the import
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

# REFUSE while a server may be live (dz): this script often runs OUTSIDE the
# container while the server runs INSIDE it, where wordwiki.sh's /proc-based
# liveness check cannot see across the pid namespace - so pidfile PRESENCE is
# the signal, deliberately conservative.  Working over a live db file risks a
# torn copy.  If the server is genuinely down, remove the stale file and
# re-run.
PIDFILE="$RUN_DIR/wordwiki.pid"
if [ -f "$PIDFILE" ]; then
    echo "REFUSING: $PIDFILE exists - a wordwiki server may be running (possibly inside the container)." >&2
    echo "Stop it from the environment it runs in (./wordwiki.sh stop), or remove the stale pidfile:" >&2
    echo "    rm '$PIDFILE'" >&2
    exit 1
fi

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
EXPECTED="repair-assertions ensure-dict-config ensure-dict-config-proof import-categories import-categories-proof \
import-lexical-forms import-lexical-forms-proof \
import-twitter-posts import-twitter-posts-proof \
backfill-publication backfill-publication-proof \
normalize-shoebox-dates normalize-shoebox-dates-proof \
migrate-status migrate-status-proof migrate-variants migrate-variants-proof \
auto-publish-sf auto-publish-sf-proof \
rand-import rand-transform rand-printed-pages clark-printed-pages rand-binding \
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

step "[1/19] server liveness check passed above (wordwiki.pid absent)"

if [ "$NO_PULL" = 1 ]; then
    step "[2/19] pull SKIPPED (--no-pull): migrating the db already in place"
else
    step "[2/19] pulling the V1 production db + content (pullWordWikiV1Db.sh)"
    ./pullWordWikiV1Db.sh
fi

step "[3/19] repairing pre-existing store corruption (idempotent)"
./wordwiki.sh repair-assertions $ALLOW_PROD --report=$RD/03-repair-assertions.md

step "[4/19] creating the dictionary config pair + loading the schema (+ proof)"
./wordwiki.sh ensure-dict-config $ALLOW_PROD --report=$RD/04-ensure-dict-config.md
./wordwiki.sh ensure-dict-config $ALLOW_PROD --expect-no-changes --report=$RD/04-ensure-dict-config-proof.md

step "[5/19] importing categories"
./wordwiki.sh import-categories $ALLOW_PROD --report=$RD/05-import-categories.md

step "[6/19] category import idempotency proof"
./wordwiki.sh import-categories $ALLOW_PROD --expect-no-changes --report=$RD/06-import-categories-proof.md

step "[7/19] importing lexical forms (+ idempotency proof)"
./wordwiki.sh import-lexical-forms $ALLOW_PROD --report=$RD/07-import-lexical-forms.md
./wordwiki.sh import-lexical-forms $ALLOW_PROD --expect-no-changes --report=$RD/07-import-lexical-forms-proof.md

step "[8/19] importing legacy twitter-posts (+ idempotency proof)"
# --report-skipped refreshes the committed hand-off list of the words a human
# must place in production (homonyms/unmatched); it shrinks as they are fixed.
./wordwiki.sh import-twitter-posts $ALLOW_PROD --report-skipped=skipped-twitter-posts.md --report=$RD/08-import-twitter-posts.md
./wordwiki.sh import-twitter-posts $ALLOW_PROD --expect-no-changes --report=$RD/08-import-twitter-posts-proof.md

step "[9/19] publication Phase 0: born-approve existing data (+ idempotency proof)"
./wordwiki.sh backfill-publication $ALLOW_PROD --report=$RD/09-backfill-publication.md
./wordwiki.sh backfill-publication $ALLOW_PROD --expect-no-changes --report=$RD/09-backfill-publication-proof.md

step "[10/19] normalizing legacy shoebox creation dates (+ idempotency proof)"
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --report=$RD/10-normalize-shoebox-dates.md
./wordwiki.sh normalize-shoebox-dates $ALLOW_PROD --expect-no-changes --report=$RD/10-normalize-shoebox-dates-proof.md

step "[11/19] the status remodel migration (+ idempotency proof)"
# Gates + renames + lifecycle synthesis; the committed report names the
# CompleteAsPDMOnly words that leave the public site.
./wordwiki.sh migrate-status $ALLOW_PROD --report=$RD/11-migrate-status.md
./wordwiki.sh migrate-status $ALLOW_PROD --expect-no-changes --report=$RD/11-migrate-status-proof.md

step "[12/19] the orthography variant migration (+ idempotency proof)"
# The committed report is the point-in-time record (hand-triage remainder,
# per-action counts); the LIVE Variant Cleanup page is the draining queue.
./wordwiki.sh migrate-variants $ALLOW_PROD --report=$RD/12-migrate-variants.md
./wordwiki.sh migrate-variants $ALLOW_PROD --expect-no-changes --report=$RD/12-migrate-variants-proof.md

step "[13/19] TESTING: auto-publishing fully-transliterated words as SF (+ proof)"
# The SF-site prototype (dz 2026-07-08): every li-public word whose li
# content is FULLY matched by SF facts gets a born-published mm-sf gate.
# On the production flow this decision belongs to the staff, guided by the
# SF-Ready Words report - this step exists so the test db has an SF site.
./wordwiki.sh auto-publish-sf $ALLOW_PROD --report=$RD/13-auto-publish-sf.md
./wordwiki.sh auto-publish-sf $ALLOW_PROD --expect-no-changes --report=$RD/13-auto-publish-sf-proof.md

step "[14/19] importing the Watson RAND corpus (mirror + mapping + transform)"
# The two-step import (multi-dictionary-survey.md phase 5): the literal
# mirror (content-keyed ids - stable across Watson drops), then the
# mapping-driven transform into the rich dictionary.  Deterministic.
# Both report on the standard FINDINGS channel (the researcher review
# surface); exit 2 = worklist items remain, which is expected while the
# mapping iterates.
./wordwiki.sh sfm-import randraw --typ=../watson/rand-structural.typ \
    --data=../watson/rand-merged.sfm --structure=tree \
    --report=$RD/14-rand-import.md || [ $? -eq 2 ]
./wordwiki.sh load-mapping rand ../watson/rand-transform.json --apply > /dev/null
./wordwiki.sh transform rand --report=$RD/14-rand-transform.md \
    --details=../watson/rand-transform-report.md || [ $? -eq 2 ]

step "[15/19] deriving printed page numbers for the Rand + Clark scans"
# The citation->scan-page map (rand-references-design.md §5); conflicts
# report as findings for spot-checking.
./wordwiki.sh derive-printed-pages Rand --apply --report=$RD/15-rand-printed-pages.md || [ $? -eq 2 ]
./wordwiki.sh derive-printed-pages Clark --apply --report=$RD/15-clark-printed-pages.md || [ $? -eq 2 ]

step "[16/19] binding the book's CACHED pages to rand entries"
# CACHED-ONLY by default (dz 2026-07-27): land every page whose Opus
# extraction is already in the SHARED derived store, skip the rest -
# zero LLM spend, NO credential needed, so this step is cheap and safe
# on every container.  (~75 pages extracted so far; extending coverage
# is a manual run WITHOUT --cached-only, paid once per page ever.)
# The binder worklist (unmatched/low-confidence/unclaimed) reports as
# findings; the visual gallery regenerates for dz's standing SAMPLE
# pages (46-55).
./wordwiki.sh bind-references Rand rand --cited-book='Rand 1888' \
    --printed=1-286 --source-lane=rand --apply --cached-only \
    --report=$RD/16-rand-binding.md \
    --details=../watson/rand-binder-full-eval.md || [ $? -eq 2 ]
./wordwiki.sh bind-references Rand rand --cited-book='Rand 1888' \
    --printed=46-55 --source-lane=rand --apply --cached-only \
    --review-html=../resources/rand-binder-review.html > /dev/null || [ $? -eq 2 ]

step "[17/19] verifying the migration"
./wordwiki.sh verify-migration --report=$RD/17-verify-migration.md

step "[18/19] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace --report=$RD/18-verify-workspace.md

step "[19/19] starting the server + smoke test (stopped again after)"
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
cat > "$RUN_DIR/$RD/19-smoke.md" <<SMOKE
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
