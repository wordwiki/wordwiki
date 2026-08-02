#!/bin/bash
set -e

# THE FULL REBUILD, ONE COMMAND - so "clean repo -> working system" stays a
# single invocation even though the pipeline is split into phases that each
# rerun on their own trigger:
#
#   Phase 1  pullLiveSnapshot.sh   pull live store (union) + db -> live-v1.db
#            (outside the container; network)      trigger: refresh the source
#   Phase 2  importWordWikiV1Db.sh migrate the snapshot -> runnable system
#                                                  trigger: schema/migration change
#   Phase 3  rebuildDerived.sh     rebuild derived data (cache-served)
#                                                  trigger: rules/derivation change
#   Phase 4  updateStaging.sh      push db + artifacts + store to staging
#                                                  trigger: deploy
#
# Each phase is ALSO runnable on its own - re-deriving after a rules change is
# Phase 3 alone; a schema change is Phase 2 (+3); a deploy is Phase 4.  This
# orchestrator is the from-clean path and the standing rehearsal.
#
#   ./rebuildAll.sh                 # phases 1,2,3  (pull, migrate, derive)
#   ./rebuildAll.sh --no-pull       # skip Phase 1 (reuse live-v1.db + store)
#   ./rebuildAll.sh --push          # ...and Phase 4 (push to staging)
#   ./rebuildAll.sh --in-place --allow-production
#                                   # the CUTOVER shape: Phase 2 migrates the
#                                   # db in place, Phase 3 derives; no pull,
#                                   # no push (do the production push by hand)
#
# NO-AI PROOF: `touch <instance>/no-llm-calls` first; a clean full run under
# the flag proves phases 2+3 are entirely cache-served (zero AI spend).

cd "$(dirname "$0")"

NO_PULL=0
PUSH=0
IN_PLACE=""
ALLOW_PROD=""
for arg in "$@"; do
    case "$arg" in
        --no-pull)          NO_PULL=1 ;;
        --push)             PUSH=1 ;;
        --in-place)         IN_PLACE="--in-place"; NO_PULL=1 ;;   # cutover: db is already here
        --allow-production) ALLOW_PROD="--allow-production" ;;
        *) echo "unknown argument: $arg" >&2
           echo "known: --no-pull, --push, --in-place, --allow-production" >&2; exit 1 ;;
    esac
done

if [ "$NO_PULL" = 0 ]; then
    echo "########## PHASE 1: pull live snapshot ##########"
    ./pullLiveSnapshot.sh
else
    echo "########## PHASE 1 skipped (--no-pull / --in-place) ##########"
fi

echo "########## PHASE 2: migrate ##########"
# shellcheck disable=SC2086
./importWordWikiV1Db.sh $IN_PLACE $ALLOW_PROD

echo "########## PHASE 3: rebuild derived ##########"
# shellcheck disable=SC2086
./rebuildDerived.sh $ALLOW_PROD

if [ "$PUSH" = 1 ]; then
    echo "########## PHASE 4: push to staging ##########"
    ./updateStaging.sh
else
    echo "########## PHASE 4 skipped (pass --push to deploy) ##########"
fi

echo
echo "Rebuild complete."
