#!/bin/bash
set -e

# Refresh the mikmaqonline.org staging checkout from this dev machine:
#   1. git pull --ff-only on the remote checkout (latest main from origin), and
#   2. rsync THIS dev instance's db over its db.
#
# It does NOT restart the staging server (a later, separate step).  The running
# server keeps serving the OLD db until then; rsync replaces the file via an
# atomic rename, so the live session is unaffected by the copy itself.
#
# Prereq: the code you want live must already be pushed to origin/main (the
# remote pulls from GitHub, not from this machine).  The pushed db is whatever
# this instance currently has - including its db_purpose marker.
#
# Config (override via env):
#   WORDWIKI_DIR   local instance dir (default <repo>/mmo) - source of the db
#   STAGING_HOST   ssh target            (default mikmaq@mikmaqonline.org)
#   STAGING_DIR    remote checkout dir   (default mmo-staging, under the remote home)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
STAGING_HOST="${STAGING_HOST:-mikmaq@mikmaqonline.org}"
STAGING_DIR="${STAGING_DIR:-mmo-staging}"

DB="$RUN_DIR/database/db.db"
[ -f "$DB" ] || { echo "local db '$DB' not found (set WORDWIKI_DIR?)" >&2; exit 1; }

echo "=== 1/2  git pull --ff-only on $STAGING_HOST:~/$STAGING_DIR ==="
ssh "$STAGING_HOST" "cd ~/$STAGING_DIR && git pull --ff-only"

echo "=== 2/2  rsync db -> $STAGING_HOST:~/$STAGING_DIR/mmo/database/db.db ==="
echo "         (from $DB)"
rsync -v "$DB" "$STAGING_HOST:$STAGING_DIR/mmo/database/db.db"

echo
echo "Staging code + db updated.  Restart the staging server to pick it up"
echo "(later step - until then it keeps serving the previous db)."
