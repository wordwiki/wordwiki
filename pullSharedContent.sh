#!/bin/bash
set -e

# Sync the SHARED content-addressable store FROM staging onto ours.  This is
# the one copy every dev instance symlinks to (see mmo-use-shared-content.sh);
# the db snapshot (pullLiveSnapshot.sh, which also calls this) is separate, so the big
# store is fetched here and reused across all checkouts.
#
# The WHOLE store ships - content/ (interned media), derived/ (generated
# tiles/audio/image sizes), imports/ (importer source inputs) - so a fresh
# checkout can run the import fully CACHE-SERVED (the no-AI-proof re-run).
#
# NO --delete, on purpose (dz 2026-07-31): the store is content-addressed, so
# pulling staging's onto ours is a safe UNION merge - it only ADDS what we
# lack, never drops what only we have.  The reverse ship (updateStaging.sh)
# is the same operation the other way; you can pull, work in dev, and ship
# back without either side clobbering the other.
#
#   Shared store: $WORDWIKI_SHARED_CONTENT
#                 (default: <parent-of-checkout>/mmo-shared-content, a sibling
#                  of the repo so every sibling checkout shares it)
#   Source:       $PULL_SHARED_HOST (default mikmaq@staging.mikmaqonline.org),
#                 its checkout's mmo/<store>/ (symlinks resolve to its store)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
SHARED="${WORDWIKI_SHARED_CONTENT:-$(dirname "$WORDWIKI_SRC")/mmo-shared-content}"
PULL_SHARED_HOST="${PULL_SHARED_HOST:-mikmaq@staging.mikmaqonline.org}"

for store in content derived imports; do
    echo "=== pulling $store/ (union, no --delete) ==="
    mkdir -p "$SHARED/$store"
    rsync -a "$PULL_SHARED_HOST:mmo/$store/" "$SHARED/$store/"
done

echo
echo "Shared store synced to: $SHARED"
