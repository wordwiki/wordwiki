#!/bin/bash
set -e

# Refresh the mikmaqonline.org staging checkout from this dev machine:
#   1. stop the staging wordwiki (per-user systemd service),
#   2. git pull --ff-only on the remote checkout (latest main from origin),
#   3. rsync THIS dev instance's db over its db, and
#   4. start the staging wordwiki again (which re-runs transpile on the new code).
#
# The server is stopped for the swap so SQLite releases its write lock and
# checkpoints the WAL before we replace the db file - then started fresh on the
# new code + db.  (Staging runs wordwiki under `systemctl --user`; see
# systemd.md.  This is why we moved it under systemd: so this script can drive
# it over ssh.)
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

# `systemctl --user` over a non-login ssh needs XDG_RUNTIME_DIR pointed at the
# user bus (lingering is enabled, so the manager is up even with no session).
SC="XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user"

echo "=== 1/4  stop wordwiki on $STAGING_HOST ==="
ssh "$STAGING_HOST" "$SC stop wordwiki.service"

echo "=== 2/4  git pull --ff-only on $STAGING_HOST:~/$STAGING_DIR ==="
# Discard any deno.lock the staging deno rewrote at runtime, so the ff-only pull
# never trips over a dirty working tree (see the deno.lock discussion in
# systemd.md / the lockfile notes).
ssh "$STAGING_HOST" "cd ~/$STAGING_DIR && git checkout -- deno.lock 2>/dev/null; git pull --ff-only"

echo "=== 3/4  rsync db -> $STAGING_HOST:~/$STAGING_DIR/mmo/database/db.db ==="
echo "         (from $DB)"
# The server is stopped, so drop any leftover WAL/SHM sidecars first - otherwise
# a stale -wal could be replayed onto the freshly-copied db on next start.
ssh "$STAGING_HOST" "rm -f ~/$STAGING_DIR/mmo/database/db.db-wal ~/$STAGING_DIR/mmo/database/db.db-shm"
rsync -v "$DB" "$STAGING_HOST:$STAGING_DIR/mmo/database/db.db"

echo "=== 4/4  start wordwiki on $STAGING_HOST ==="
ssh "$STAGING_HOST" "$SC start wordwiki.service"

echo
echo "Staging code + db updated and wordwiki restarted."
