#!/bin/bash
set -e

# Point THIS checkout's instance dir at the shared store, so a fresh/lightweight
# checkout doesn't need its own multi-GB copies of these trees:
#
#   content/  - original recordings & interned media (content-addressed)  ~7.6G
#   derived/  - generated tiles / compressed+trimmed audio / image sizes
#               (closure-addressed; identical inputs -> identical files, so it is
#               correct to share, and it spares a fresh checkout the slow
#               from-cold re-derive on first publish)                     ~10G
#   imports/  - source inputs for the importers (read-only)
#
# Each is symlinked: $RUN_DIR/<store> -> $SHARED/<store>.
#
# IDEMPOTENT: a store already correctly linked is a no-op, so setup scripts can
# call this unconditionally.  It REFUSES (per store) to clobber a real local dir
# or a symlink pointing somewhere else - we never destroy a real local store.
#
# content is REQUIRED (see wordwiki/instance-dir.ts) and is never auto-created:
# an empty content store would let the server start and silently serve nothing,
# so if it's absent we warn and let the link dangle (the server then refuses to
# start until you populate it via ./pullSharedContent.sh).  derived and imports
# legitimately start empty, so we create them.
#
#   Instance dir : $WORDWIKI_DIR            (default: <repo>/mmo)
#   Shared store : $WORDWIKI_SHARED_CONTENT (default: <parent-of-checkout>/mmo-shared-content)

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
SHARED="${WORDWIKI_SHARED_CONTENT:-$(dirname "$WORDWIKI_SRC")/mmo-shared-content}"

mkdir -p "$RUN_DIR"

failed=0
for store in content derived imports; do
    src="$SHARED/$store"      # shared target
    link="$RUN_DIR/$store"    # this checkout's symlink
    rel="$(realpath -m --relative-to="$RUN_DIR" "$src")"   # relative => relocatable

    # Stores that legitimately start empty get created; content does not (above).
    case "$store" in
        derived|imports) mkdir -p "$src" ;;
        content)
            if [ ! -d "$src" ]; then
                echo "Note: shared '$src' doesn't exist yet - populate it with" >&2
                echo "      ./pullSharedContent.sh (until then the link dangles and the" >&2
                echo "      server refuses to start)." >&2
            fi
            ;;
    esac

    if [ -L "$link" ]; then
        # Already a symlink: a no-op if it already points where we want (compare
        # the raw target text, which works even when src isn't populated yet).
        if [ "$(readlink "$link")" = "$rel" ]; then
            echo "ok: $link -> $store (already linked)"
            continue
        fi
        echo "Refusing: '$link' is a symlink to '$(readlink "$link")', not '$store'." >&2
        echo "  Remove it by hand if that's stale, then re-run." >&2
        failed=1
        continue
    fi

    if [ -e "$link" ]; then       # -e is false for a (dangling) symlink, true for a real dir/file
        echo "Refusing: '$link' already exists (a real dir, not a symlink)." >&2
        echo "  Move its contents into '$src' and remove it, then re-run." >&2
        failed=1
        continue
    fi

    ln -s "$rel" "$link"
    echo "linked $link -> $rel"
done

if [ "$failed" -ne 0 ]; then
    echo "One or more stores were not linked (see above)." >&2
    exit 1
fi
