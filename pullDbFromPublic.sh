#!/bin/bash
set -e

# Pull the production db (and, for a standalone instance, the content store)
# from staging into THIS instance, then make the pulled db runnable as a dev db.
#
#   Instance dir: $WORDWIKI_DIR  (default: <repo>/mmo)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"

# Refuse to pull into an unconfigured instance: the content store must already
# be provided (a real dir, or a symlink to a shared store).  Otherwise we'd
# silently create one and pull gigabytes into the wrong place.  -e follows
# symlinks, so a dangling symlink also fails here.
if [ ! -e "$RUN_DIR/content" ]; then
    echo "Instance '$RUN_DIR' has no content store (dir or resolvable symlink)." >&2
    echo "Provide it first: production = a real 'content' dir; dev = ln -s <shared>/content." >&2
    echo "(Override the instance with WORDWIKI_DIR=...)" >&2
    exit 1
fi

mkdir -p "$RUN_DIR/database"

# Always pull the db (this instance's own writable copy).
rsync -av mikmaq@staging.mikmaqonline.org:mmo/database/db.db "$RUN_DIR/database/db.db"

# Pull content ONLY into a standalone (real-dir) instance.  If content is a
# symlink it points at a SHARED store - pulling through it would rewrite the
# shared content under every other instance, so skip it.
if [ -L "$RUN_DIR/content" ]; then
    echo "content is a symlink (shared store) - skipping content pull (manage the shared store separately)."
else
    rsync -av mikmaq@staging.mikmaqonline.org:mmo/content/ "$RUN_DIR/content/"
fi

# Make the pulled production db runnable as the dev db (stops any running
# server, recreates/seeds the user tables, marks the db 'dev', sets djz's
# dev password).  Idempotent; needed until the new version IS production.
cd "$WORDWIKI_SRC" && WORDWIKI_DIR="$RUN_DIR" ./wordwiki.sh post-pull

echo
echo "Pull complete.  Start the server with: WORDWIKI_DIR='$RUN_DIR' $WORDWIKI_SRC/wordwiki.sh"
