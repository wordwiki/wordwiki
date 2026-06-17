#!/bin/bash
set -e

# ONE-TIME, per-machine migration of the shared store from the old FLAT layout
# to the new NESTED layout, then re-wire this checkout's symlinks.
#
#   OLD:  mmo-shared-content/            <- the content stores (Recordings, PDM, ...)
#         mmo/content  -> mmo-shared-content
#         mmo/derived  -> a real ~10G local dir (re-derived per checkout - slow!)
#
#   NEW:  mmo-shared-content/
#           content/   <- the content stores (moved here)
#           derived/   <- promoted from this checkout's local mmo/derived
#           imports/   <- source inputs (created; populate as needed)
#         mmo/{content,derived,imports} -> mmo-shared-content/{content,derived,imports}
#
# Promoting the local derived/ into the shared store is the point: every other
# checkout then reuses it instead of re-deriving ~10G of audio/images on its
# first publish.
#
# Moves are renames within one filesystem (instant) where possible.  Safe to
# re-run: each step detects the already-migrated shape and skips.  Pass
# --dry-run to print the plan without changing anything.
#
#   Instance dir : $WORDWIKI_DIR            (default: <repo>/mmo)
#   Shared store : $WORDWIKI_SHARED_CONTENT (default: <parent-of-checkout>/mmo-shared-content)

DRY=0
[ "$1" = "--dry-run" ] && DRY=1

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
SHARED="${WORDWIKI_SHARED_CONTENT:-$(dirname "$WORDWIKI_SRC")/mmo-shared-content}"

run() { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

echo "Instance dir : $RUN_DIR"
echo "Shared store : $SHARED"
[ "$DRY" = 1 ] && echo "(dry-run: no changes will be made)"
echo

if [ ! -d "$SHARED" ] && [ ! -L "$SHARED" ]; then
    echo "Shared store '$SHARED' does not exist - nothing to migrate." >&2
    echo "A fresh setup creates the nested layout directly via mmo-use-shared-content.sh." >&2
    exit 1
fi

# --- Step 1: flat -> nested for the content stores. ------------------------
# Rename the whole flat dir aside, then move it in as the 'content' child.  One
# rename moves every content store at once - no per-store iteration, nothing
# left behind.
if [ -d "$SHARED/content" ]; then
    echo "Step 1: '$SHARED/content' already exists - content already nested, skipping."
else
    TMP="$SHARED.flat-$$"
    echo "Step 1: nesting flat content stores under '$SHARED/content/'"
    echo "  ($(ls -1 "$SHARED" | wc -l) entries: $(ls -1 "$SHARED" | tr '\n' ' '))"
    if [ -e "$TMP" ]; then echo "  Refusing: temp '$TMP' already exists." >&2; exit 1; fi
    run mv "$SHARED" "$TMP"
    run mkdir "$SHARED"
    run mv "$TMP" "$SHARED/content"
fi

# --- Step 2: promote this checkout's real local derived/ and imports/. ------
# A real local dir is renamed into the shared store (instant on one filesystem)
# so every other checkout reuses it.  Already a symlink -> already shared.  No
# local dir -> create an empty shared one.  Refuses to merge when BOTH the local
# and the shared copy have content (avoids a silent clobber).
for store in derived imports; do
    local_dir="$RUN_DIR/$store"
    sh_dir="$SHARED/$store"
    if [ -L "$local_dir" ]; then
        echo "Step 2 [$store]: local is already a symlink - already shared, skipping promote."
        run mkdir -p "$sh_dir"
    elif [ -d "$local_dir" ]; then
        if [ -d "$sh_dir" ] && [ -n "$(ls -A "$sh_dir" 2>/dev/null)" ]; then
            echo "Step 2 [$store]: WARNING - both local '$local_dir' and shared '$sh_dir' have content." >&2
            echo "  Not auto-merging (could clobber). Merge by hand, e.g.:" >&2
            echo "    rsync -a '$local_dir/' '$sh_dir/' && rm -rf '$local_dir'" >&2
            echo "  then re-run this script (or mmo-use-shared-content.sh)." >&2
            exit 1
        fi
        echo "Step 2 [$store]: promoting local $store ($(du -sh "$local_dir" 2>/dev/null | cut -f1)) -> '$sh_dir'"
        # Drop the empty placeholder (if any) so we can rename the whole dir in.
        run rmdir "$sh_dir" 2>/dev/null || true
        run mv "$local_dir" "$sh_dir"
    else
        echo "Step 2 [$store]: no local '$local_dir' - creating empty shared $store."
        run mkdir -p "$sh_dir"
    fi
done

# --- Step 3: drop the old content symlink (pointed at the flat root). -------
# It pointed at $SHARED itself; the linker will repoint it at $SHARED/content.
# Only remove it if it still resolves to the flat root - leave an already
# repointed (-> $SHARED/content) link alone so re-runs don't churn it.
if [ -L "$RUN_DIR/content" ] && \
   [ "$(readlink -f "$RUN_DIR/content")" = "$(readlink -f "$SHARED")" ]; then
    echo "Step 3: removing old content symlink (was -> flat shared root)"
    run rm "$RUN_DIR/content"
else
    echo "Step 3: content symlink already repointed (or absent) - leaving as is."
fi

# --- Step 4: wire the symlinks. --------------------------------------------
echo "Step 4: wiring symlinks via mmo-use-shared-content.sh"
if [ "$DRY" = 1 ]; then
    echo "  [dry-run] $WORDWIKI_SRC/mmo-use-shared-content.sh"
else
    "$WORDWIKI_SRC/mmo-use-shared-content.sh"
fi

echo
echo "Migration complete."
