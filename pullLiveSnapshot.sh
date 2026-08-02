#!/bin/bash
set -e

# PHASE 1 of the rebuild pipeline (rebuildAll.sh runs 1->2->3->4).
#
# The ONLY phase that needs live/network access, and the only one meant to
# run OUTSIDE the container.  It pulls the canonical LIVE state onto this dev
# machine NON-DESTRUCTIVELY:
#
#   1. the content-addressable STORE (content/ derived/ imports/) UNION-merged
#      onto ours (via pullSharedContent.sh; NO --delete - every file is named
#      by its content hash, so merging two stores only ADDS, never conflicts).
#   2. the live DB, to a PRISTINE SNAPSHOT named live-v1.db - deliberately NOT
#      the working db.db.  Phase 2 (importWordWikiV1Db.sh) copies live-v1.db ->
#      db.db and migrates; because the snapshot is untouched, Phase 2 can be
#      re-run any number of times (e.g. after a schema change) WITHOUT
#      re-pulling.  Re-run THIS phase only to refresh the source from live.
#
#   Instance dir: $WORDWIKI_DIR (default <repo>/mmo)
#   Live source:  $LIVE_HOST    (default mikmaq@staging.mikmaqonline.org),
#                 pulled from its checkout's mmo/ (db + the shared store)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
LIVE_HOST="${LIVE_HOST:-mikmaq@staging.mikmaqonline.org}"

echo "=== 1/2  pulling the shared content-addressable store (union, no --delete) ==="
# One host controls both pulls; pullSharedContent reads PULL_SHARED_HOST.
PULL_SHARED_HOST="$LIVE_HOST" "$WORDWIKI_SRC/pullSharedContent.sh"

echo "=== 2/2  pulling the live db -> live-v1.db (pristine snapshot) ==="
mkdir -p "$RUN_DIR/database"
rsync -v "$LIVE_HOST:mmo/database/db.db" "$RUN_DIR/database/live-v1.db"

echo
echo "Phase 1 complete: store synced; snapshot at $RUN_DIR/database/live-v1.db"
echo "Next: ./importWordWikiV1Db.sh   (Phase 2 - migrate the snapshot)"
