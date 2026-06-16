#!/bin/bash
set -e

# Pull the production db from staging into THIS instance, then make it runnable
# as a dev db.  Pulling the db is the CORE rebuild loop (we re-pull constantly to
# rerun the migration as it changes), so it ALWAYS happens.  The content store is
# only synced when it's a real local dir; a shared store (symlink) or an instance
# with no content is synced separately by hand - we never pull through a symlink
# (that would rewrite the shared content under every other instance).
#
#   Instance dir: $WORDWIKI_DIR  (default: <repo>/mmo)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"

mkdir -p "$RUN_DIR/database"

# Always pull the db (this instance's own writable copy) - the core workflow.
rsync -av mikmaq@staging.mikmaqonline.org:mmo/database/db.db "$RUN_DIR/database/db.db"

# Sync content ONLY into a real local dir (a standalone instance).  Skip it when
# content is a symlink to a shared store, or absent - those are synced separately.
if [ -d "$RUN_DIR/content" ] && [ ! -L "$RUN_DIR/content" ]; then
    rsync -av mikmaq@staging.mikmaqonline.org:mmo/content/ "$RUN_DIR/content/"
else
    echo "Skipping content sync ('$RUN_DIR/content' is a shared symlink or not present here)."
    echo "Sync the shared content store separately."
fi

# Make the pulled production db runnable as the dev db (stops any running
# server, recreates/seeds the user tables, marks the db 'dev', sets djz's
# dev password).  Idempotent; needed until the new version IS production.
cd "$WORDWIKI_SRC" && WORDWIKI_DIR="$RUN_DIR" ./wordwiki.sh post-pull

echo
echo "Pull complete.  Start the server with: WORDWIKI_DIR='$RUN_DIR' $WORDWIKI_SRC/wordwiki.sh"
