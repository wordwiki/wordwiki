# Claude Code statusline setup (container config note, 2026-07-28)

Two files OUTSIDE the repo were changed in this container.  Everything
needed to replicate is inline below; only dependency is `jq`.

## 1. `~/.claude/statusline-command.sh`

PS1 look (green user@host, blue session cwd) + context-window usage
percentage (dim; yellow >= 70%; red >= 90%):

```bash
#!/bin/bash
# Status line derived from the pj-override PS1 in ~/.bashrc:
#   PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
# (green user@host, reset, blue cwd, reset; trailing "\$ " dropped)
# + context-window usage percentage (dz 2026-07-28): dim normally,
#   yellow >= 70%, red >= 90%.

input=$(cat)

user=$(whoami)
host=$(hostname -s)
dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd')
pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' | cut -d. -f1)

ctx=''
if [ -n "$pct" ]; then
    color='\033[02;37m'                       # dim
    [ "$pct" -ge 70 ] && color='\033[01;33m'  # yellow
    [ "$pct" -ge 90 ] && color='\033[01;31m'  # red
    ctx=$(printf ' %b%s%%%b' "$color" "$pct" '\033[00m')
fi

printf '\033[01;32m%s@%s\033[00m:\033[01;34m%s\033[00m%s' "$user" "$host" "$dir" "$ctx"
```

## 2. `~/.claude/settings.json`

Add (MERGE into existing settings, don't overwrite):

```json
"statusLine": {"type": "command",
               "command": "bash ~/.claude/statusline-command.sh"}
```

No chmod needed (invoked via `bash` explicitly).

## Notes

- Interactive equivalents with no statusline configured: `/context`
  (window breakdown grid), `/usage` (tokens + cost).
- Or skip all of the above in a new container: run `/statusline` in
  Claude Code and describe the desired line - it writes both pieces
  itself (that is how this one started; the context %% was added by
  hand after).
