#!/bin/bash
set -e

# Sync the SHARED content store (recordings) from staging.  This is the one copy
# that every dev instance symlinks to (see mmo-use-shared-content.sh); the db
# pull (pullWordWikiV1Db.sh) deliberately does NOT touch it, so the big content
# store is fetched once here and reused across all checkouts.
#
#   Shared store: $WORDWIKI_SHARED_CONTENT
#                 (default: <parent-of-checkout>/mmo-shared-content, i.e. a
#                  sibling of the repo so every sibling checkout shares it)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
SHARED="${WORDWIKI_SHARED_CONTENT:-$(dirname "$WORDWIKI_SRC")/mmo-shared-content}"

mkdir -p "$SHARED"
rsync -av mikmaq@staging.mikmaqonline.org:mmo/content/ "$SHARED/"

echo
echo "Shared content synced to: $SHARED"
