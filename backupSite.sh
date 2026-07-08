#!/bin/bash
set -e

# One .tgz snapshot of everything needed to stand the project back up,
# EXCEPT the large media stores (see backupAudio.sh for the source audio;
# the book page-scan images live beside it under content/):
#
#   source/    the source checkout, INCLUDING .git (the code history is
#              small and is part of the story) - media/instance excluded
#   database/  a CONSISTENT db snapshot (VACUUM INTO via `wordwiki.sh
#              backup-db`, an ordinary read transaction - SAFE while the
#              server is running, so this script needs no pidfile dance
#              and can run as a daily systemd timer)
#   site/      the published site tree (html + reports + the data/ dumps:
#              publish-source.json and full-history.json), content/ and
#              derived/ excluded (content-addressed media; derived is a
#              regenerable cache of content)
#
# Manual for now:   ./backupSite.sh [output-dir]
# (default output dir: ../wordwiki-backups, beside the checkout)
# Later: a systemd timer for daily snapshots; add rotation then.
#
# Config (override via env):
#   WORDWIKI_DIR   instance dir (default <repo>/mmo)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
OUT_DIR="${1:-$WORDWIKI_SRC/../wordwiki-backups}"
STAMP="$(date +%F-%H%M%S)"
OUT="$OUT_DIR/wordwiki-site-$STAMP.tgz"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d "$OUT_DIR/.site-backup-work-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "=== 1/3  consistent db snapshot (VACUUM INTO - safe while live) ==="
mkdir -p "$WORK/database"
(cd "$RUN_DIR" && "$WORDWIKI_SRC/wordwiki.sh" backup-db "$WORK/database/db.db")

echo "=== 2/3  tar source + instance (media stores excluded) ==="
# Source: the checkout incl. .git; the instance dir and any media are
# excluded here and picked up (media-free) as site/ below.  Volatile
# files (session logs, server logs) may change mid-read - tar exit 1 is
# that WARNING (the archive is still valid); only exit >=2 is fatal.
tar czf "$OUT" \
    -C "$WORK" database \
    -C "$(dirname "$WORDWIKI_SRC")" \
        --exclude="$(basename "$WORDWIKI_SRC")/mmo" \
        --exclude="$(basename "$WORDWIKI_SRC")/tmp" \
        --exclude="$(basename "$WORDWIKI_SRC")/.claude-home" \
        --transform "s,^$(basename "$WORDWIKI_SRC"),source," \
        "$(basename "$WORDWIKI_SRC")" \
    -C "$(dirname "$RUN_DIR")" \
        --exclude="$(basename "$RUN_DIR")/content" \
        --exclude="$(basename "$RUN_DIR")/derived" \
        --exclude="$(basename "$RUN_DIR")/database" \
        --transform "s,^$(basename "$RUN_DIR"),site," \
        "$(basename "$RUN_DIR")" \
    || [ $? -eq 1 ]

echo "=== 3/3  done ==="
ls -lh "$OUT"
