#!/bin/bash
set -e

# Point THIS checkout's instance dir at the shared content store, so a fresh
# checkout doesn't need its own 7.6G copy of the recordings.  Run once per new
# checkout (then pullDbFromPublic.sh for the db, then wordwiki.sh).
#
# Yelps (refuses) if content already exists - we never clobber a real local
# content store or an existing link.
#
#   Instance dir : $WORDWIKI_DIR            (default: <repo>/mmo)
#   Shared store : $WORDWIKI_SHARED_CONTENT (default: <parent-of-checkout>/mmo-shared-content)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
SHARED="${WORDWIKI_SHARED_CONTENT:-$(dirname "$WORDWIKI_SRC")/mmo-shared-content}"

# -e follows symlinks (true for a live link), -L catches a dangling one too.
if [ -e "$RUN_DIR/content" ] || [ -L "$RUN_DIR/content" ]; then
    echo "Refusing: '$RUN_DIR/content' already exists." >&2
    echo "  Remove it first to repoint at the shared store: an existing symlink" >&2
    echo "  with 'rm', or move a real local content dir aside." >&2
    exit 1
fi

if [ ! -d "$SHARED" ]; then
    echo "Note: shared content store '$SHARED' doesn't exist yet - populate it with" >&2
    echo "      ./pullSharedContent.sh (until then the link dangles and the server" >&2
    echo "      refuses to start)." >&2
fi

mkdir -p "$RUN_DIR"
# A RELATIVE symlink (so the whole tree stays relocatable); resolves to the
# shared store as a sibling of the checkout.
target="$(realpath -m --relative-to="$RUN_DIR" "$SHARED")"
ln -s "$target" "$RUN_DIR/content"
echo "Linked $RUN_DIR/content -> $target  (=> $SHARED)"
