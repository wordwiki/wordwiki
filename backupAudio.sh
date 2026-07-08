#!/bin/bash
set -e

# The SOURCE AUDIO dump: one .tgz of the content-addressed source
# recordings (content/Recordings - the irreplaceable elder audio).  Kept
# separate from backupSite.sh because it is huge (~4G) and append-only
# (content-addressed files never change), so it needs dumping far less
# often than the daily site snapshot.
#
# NOT included: derived/ (regenerable trimmed/compressed forms) and the
# book page-scan images (content/<Book>/ - dump those the same way if
# wanted: they are equally source, just less irreplaceable than voices).
#
# Safe while the server runs: content-addressed files are immutable.
#
#   ./backupAudio.sh [output-dir]
# (default output dir: ../wordwiki-backups, beside the checkout)
#
# Config (override via env):
#   WORDWIKI_DIR   instance dir (default <repo>/mmo)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
OUT_DIR="${1:-$WORDWIKI_SRC/../wordwiki-backups}"
STAMP="$(date +%F-%H%M%S)"
OUT="$OUT_DIR/wordwiki-source-audio-$STAMP.tgz"

RECORDINGS="$(realpath "$RUN_DIR/content")/Recordings"
[ -d "$RECORDINGS" ] || { echo "no Recordings dir at '$RECORDINGS'" >&2; exit 1; }

mkdir -p "$OUT_DIR"
echo "=== tar $RECORDINGS ==="
# -h: content/ is reached via symlinks; archive the real files.
tar czhf "$OUT" -C "$(dirname "$RECORDINGS")" Recordings
ls -lh "$OUT"
