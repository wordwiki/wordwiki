#!/bin/bash
set -e

# One-time setup for a fresh checkout / git worktree of wordwiki.
#
#   1. Wire Claude Code's per-project memory to the committed memory/ dir, so
#      every checkout shares one memory instead of diverging (idempotent - safe
#      to re-run; no-op once linked).  Needs ~/bin/claude-memlink.
#   2. Point this checkout's instance dir at the shared content store, so it
#      doesn't need its own 7.6G copy of the recordings.
#
# After this: pullWordWikiV1Db.sh (or pullSharedContent.sh) for data, then
# wordwiki.sh to run.

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"

# 1. Shared Claude memory.
if command -v claude-memlink >/dev/null 2>&1; then
    claude-memlink "$WORDWIKI_SRC"
else
    echo "Note: claude-memlink not on PATH - skipping Claude memory link." >&2
    echo "      Install ~/bin/claude-memlink to share memory across checkouts." >&2
fi

# 2. Shared content store (refuses if this checkout already has content).
"$WORDWIKI_SRC/mmo-use-shared-content.sh"
