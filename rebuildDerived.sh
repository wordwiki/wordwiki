#!/bin/bash
set -e

# PHASE 3 of the rebuild pipeline (rebuildAll.sh runs 1->2->3->4): rebuild the
# DERIVED data on top of the migrated db (Phase 2, importWordWikiV1Db.sh).
#
# Everything here is RE-DERIVABLE from the canonical data + the primed content
# store, so this phase is DESIGNED TO BE RE-RUN (in groups) after a rules or
# data change - eventually against production data.  Re-run trigger: a rules /
# derivation-code change.  Each group is idempotent / content-keyed:
# re-running reproduces identical derived output.
#
# NO-AI PROOF MODE (the point of this phase): when the derived content store
# is already primed, this phase must do ZERO expensive (AI) work.  `touch
# <instance>/no-llm-calls` before running and any ACTUAL LLM call throws
# loudly - a clean run under the flag PROVES the rebuild is fully
# cache-served.  Extending coverage to new inputs is a deliberate PAID run
# WITHOUT the flag (e.g. bind-references without --cached-only), once per
# input ever, then shipped in the store.
#
#   ./rebuildDerived.sh [--allow-production]
#
# Groups (each writes findings to <instance>/derived-report/NN-<step>.md;
# a trap assembles derived-report.md even on crash):
#   1. printed page numbers for the Rand + Clark scans (citation->page map)
#   2. bind the Rand book's CACHED pages to rand entries + the review gallery
#   3. the pm-li taxonomy review page (from the PDM gold)
#   4. verify-workspace: structural invariants after the derived writes

cd "$(dirname "$0")"
RUN_DIR="${WORDWIKI_DIR:-$PWD/mmo}"

PIDFILE="$RUN_DIR/wordwiki.pid"
if [ -f "$PIDFILE" ]; then
    echo "REFUSING: $PIDFILE exists - a wordwiki server may be running." >&2
    echo "Stop it (./wordwiki.sh stop) or remove the stale pidfile: rm '$PIDFILE'" >&2
    exit 1
fi

ALLOW_PROD=""
for arg in "$@"; do
    case "$arg" in
        --allow-production) ALLOW_PROD="--allow-production" ;;
        *) echo "unknown argument: $arg (known: --allow-production)" >&2; exit 1 ;;
    esac
done

step() { echo; echo "=== $* ==="; }

RD="derived-report"
rm -rf "$RUN_DIR/$RD"
mkdir -p "$RUN_DIR/$RD"
EXPECTED="rand-printed-pages clark-printed-pages rand-binding pm-li-taxonomy verify-workspace"
finish() {
    # shellcheck disable=SC2086
    ./wordwiki.sh assemble-import-report "$RD" derived-report.md $EXPECTED
}
trap finish EXIT

# Generated REVIEW ARTIFACTS land in resources/generated/ - a GITIGNORED dir
# shipped to staging by updateStaging.sh (Phase 4) rsync, NOT committed.
mkdir -p resources/generated

step "[1/4] deriving printed page numbers for the Rand + Clark scans"
# The citation->scan-page map (rand-references-design.md §5); conflicts report
# as findings for spot-checking.  exit 2 = unassigned front matter, tolerated.
./wordwiki.sh derive-printed-pages Rand $ALLOW_PROD --apply --report=$RD/01-rand-printed-pages.md || [ $? -eq 2 ]
./wordwiki.sh derive-printed-pages Clark $ALLOW_PROD --apply --report=$RD/01-clark-printed-pages.md || [ $? -eq 2 ]

step "[2/4] binding the book's CACHED pages to rand entries (+ review gallery)"
# CACHED-ONLY (dz 2026-07-27): land every page whose Opus extraction is
# already in the SHARED derived store, skip the rest - zero LLM spend, no
# credential needed.  Extend coverage with a manual paid run WITHOUT
# --cached-only.  The binder worklist reports as findings; the gallery
# regenerates for dz's standing SAMPLE pages (46-55).
./wordwiki.sh bind-references Rand rand --cited-book='Rand 1888' \
    --printed=1-286 --source-lane=rand --apply --cached-only \
    --report=$RD/02-rand-binding.md \
    --details=../watson/rand-binder-full-eval.md || [ $? -eq 2 ]
./wordwiki.sh bind-references Rand rand --cited-book='Rand 1888' \
    --printed=46-55 --source-lane=rand --apply --cached-only \
    --review-html=../resources/generated/rand-binder-review.html > /dev/null || [ $? -eq 2 ]

step "[3/4] building the pm-li taxonomy review page (from the PDM gold)"
# No-arg, read-only: reads the corpus from the db via the pm-li pair's
# extractCorpus.  Skips cleanly if the PDM gold isn't in this db.
./wordwiki.sh build-pm-li-taxonomy --report=$RD/03-pm-li-taxonomy.md

step "[4/4] verifying the assertion store is structurally well-formed"
./wordwiki.sh verify-workspace --report=$RD/04-verify-workspace.md

echo
echo "Phase 3 complete: derived data rebuilt."
echo "Next: ./updateStaging.sh   (Phase 4 - push db + artifacts + store to staging)"
