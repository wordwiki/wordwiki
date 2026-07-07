# Running wordwiki as a per-user systemd service

wordwiki can run under **systemd's per-user manager** (`systemctl --user`) so it
starts at boot, restarts on crash, and is managed with the standard systemctl
tooling instead of a hand-run `./wordwiki.sh` in a terminal.

Everything here is unprivileged — a per-user unit needs no root or sudo (the one
exception, `loginctl enable-linger`, is called out below).

A ready-to-edit template lives alongside this doc: **`wordwiki.service.sample`**.

## Why it maps cleanly onto wordwiki.sh

- `./wordwiki.sh` (with no args) runs `serve`, which **blocks in the
  foreground** — exactly what systemd wants for `Type=exec`. No daemonizing, no
  `PIDFile=` juggling.
- `./wordwiki.sh stop` performs a **clean shutdown** by hitting the server's
  authenticated shutdown route, so SQLite closes properly instead of being
  killed mid-write. That maps directly onto `ExecStop=`.
- The server writes its own `wordwiki.pid` / shutdown-password file into the
  instance dir; the unit does not need to know about them.

## The one gotcha: PATH

systemd starts user services with a **minimal PATH** that does *not* include your
login-shell additions. But `wordwiki.sh` calls `transpile.sh`, which needs:

- **`deno`** — here in `~/.deno/bin`
- **`swc`** — here in `~/bin` (the standalone swc binary)
- plus `rsync` / `curl` from the system dirs

If PATH is wrong the service dies instantly with `status=127` and a journal line
like `transpile.sh: line 18: swc: command not found`. The unit therefore sets an
explicit `Environment=PATH=...`. Adjust it to wherever *your* `which deno` and
`which swc` resolve.

## Install

```bash
# 1. Copy the template into the per-user unit dir and edit the marked lines
#    (checkout path, WORDWIKI_PORT, and the PATH entries for deno/swc).
mkdir -p ~/.config/systemd/user
cp wordwiki.service.sample ~/.config/systemd/user/wordwiki.service
$EDITOR ~/.config/systemd/user/wordwiki.service

# 2. Load it and start now, enabling start-on-login.
systemctl --user daemon-reload
systemctl --user enable --now wordwiki.service

# 3. Make it start at boot and survive full logout (needs polkit; may prompt).
loginctl enable-linger "$USER"
```

Without `enable-linger`, the user manager (and this service) only runs while you
have an active login session and stops when you log out. For a server you want
lingering on.

## Manage

A login shell already has `XDG_RUNTIME_DIR` set, so these work as-is:

```bash
systemctl --user status  wordwiki      # is it up? recent log lines
systemctl --user restart wordwiki      # clean stop + fresh start (re-runs transpile)
systemctl --user stop    wordwiki      # clean shutdown
systemctl --user start   wordwiki
journalctl --user -u wordwiki -f       # follow logs
journalctl --user -u wordwiki -n 50    # last 50 lines
```

From a **non-login / cron / `ssh host cmd`** context you may need to point at the
user bus first:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status wordwiki
```

## Updating the code

After a `git pull` (or any change to the sources, `wordwiki.sh`, or the
client-side scripts), restart the service to pick it up — the restart re-runs
`transpile.sh` on the new sources:

```bash
systemctl --user restart wordwiki
```

## Notes / caveats

- **One instance per port + db.** wordwiki uses SQLite single-writer and binds a
  fixed port; `wordwiki.sh` already stops any server it finds before starting, so
  don't also run a hand-launched `./wordwiki.sh` while the service is up.
- **Second instance.** To serve another instance dir on another port, copy the
  unit to a new name (e.g. `wordwiki-dev.service`), and set a different
  `WORDWIKI_PORT` plus `Environment=WORDWIKI_DIR=/path/to/other/instance` (see
  wordwiki.sh's header for the instance-dir contract).
- **Editing the unit** later: re-run `systemctl --user daemon-reload` before
  `restart` so systemd re-reads the file.
