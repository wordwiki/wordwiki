---
name: claude-memory-sharing
description: "Claude memory is committed in the repo at memory/ and symlinked into ~/.claude via ~/bin/claude-memlink, so parallel claudes/worktrees share one memory"
metadata: 
  node_type: memory
  type: project
  originSessionId: d3b4ea1a-2e36-4997-98e4-460e03a1bd40
---

This project's Claude memory is **committed in the repo** at `memory/` (one fact per file + `MEMORY.md` index), so parallel claudes across worktrees/clones share one memory instead of each diverging.

The plumbing: `~/bin/claude-memlink` symlinks Claude Code's per-project memory dir (`~/.claude/projects/<dash-encoded-abs-path>/memory`, encoding = non-alphanumeric → `-`) to the committed `memory/`. It's idempotent (no-op if linked), refuses to clobber a real dir with memories, and supports `--adopt` (move an existing ~/.claude memory into the project) / `--archive` / `--dry-run` / `--print-target`. `setup-worktree.sh` calls it (skips gracefully if the tool isn't on PATH).

**How to apply:** writing a memory edits a git-tracked file under `memory/` — after recording, the change must be committed for other checkouts to pick it up. In a new worktree, run `claude-memlink` (or `./setup-worktree.sh`) once to wire the symlink. Set up via `--adopt` on this machine 2026-06-17. See also [[wordwiki-shared-store-layout]].
