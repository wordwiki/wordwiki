#!/bin/bash
set -e

# Republish the home pages, then serve (a quick "refresh + run" convenience).
# Instance-dir aware: WORDWIKI_DIR (default <repo>/mmo), WORDWIKI_PORT (9000).

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"

(cd "$WORDWIKI_SRC" && ./transpile.sh "$RUN_DIR")
cd "$RUN_DIR" \
    && deno run --check --allow-all "$WORDWIKI_SRC/wordwiki/publish.ts" publishHomePages \
    && deno run --check --allow-all "$WORDWIKI_SRC/wordwiki/wordwiki.ts" serve
