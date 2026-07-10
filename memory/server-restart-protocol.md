---
name: server-restart-protocol
description: Restart the rabid/wordwiki server by re-running its .sh — never pkill
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0fca39c7-a1e6-4240-b730-70d32e34def8
---

**Standing instruction (dz, 2026-06-16): ALWAYS restart the server after every
change so dz can preview immediately.** Don't wait to be asked, don't batch -
after any edit that affects what renders (server/template/render/publish code,
CSS synced to ~/mmo/resources), restart. For changes that only show on the
PUBLISHED public site (markup baked into static pages), also republish the
affected pages (`./wordwiki.sh publish <targets>`) - a restart alone won't update
already-published HTML. The in-app Publish button needs the restart first (see
the publish gotcha below).

To (re)start the server, just run `./rabid.sh` again (or `./wordwiki.sh`). Each
script's startup already stops any running instance the CLEAN way: it reads the
pidfile (`rabid.pid` / `wordwiki.pid`), confirms the pid is really that server
via `/proc/PID/cmdline`, asks it to shut down via its authenticated route
(`rabid.shutdown(<pw>)` using `rabid-shutdown-password.txt`) so SQLite closes
properly, waits ~10s, and only SIGKILLs a wedged server that ignored the request.
Single fixed port + single-writer SQLite means only one may run at a time, so
"just run the script again" IS the reliable restart.

**To STOP (not restart): `./wordwiki.sh stop`** — the same clean stop-dance
without starting a new server. Don't hand-roll the shutdown-route curl
(fumbled 2026-07-09: wrong password-file path + a bad liveness check that
deleted the pidfile while the server still ran); the passwords live in the
INSTANCE dir (`mmo/wordwiki-shutdown-password.txt`), not the repo root.

**Do NOT `pkill`/`kill` the server by hand.** It races the script's own clean
shutdown, can kill the instance the script is managing (or the one you just
launched), and skips the graceful SQLite close. Manual killing is what produced
spurious exit-144s. Run it backgrounded: `nohup ./rabid.sh >/tmp/rabid.log 2>&1 &
disown`, then verify with curl. **Why:** dz built the clean-shutdown protocol
into the run scripts on purpose. Relates to [[wordwiki-toplevel-upgrade]].

**Stale-pidfile gotcha (seen 2026-07-02):** if a restart doesn't seem to take
effect (server still shows pre-change behavior, e.g. old passwords), check
`pgrep -af "wordwiki/wordwiki.ts"` against `mmo/wordwiki.pid`. A serve attempt
that loses the port-bind race still OVERWRITES the pidfile + shutdown-password
file before dying, after which the surviving old server can't be stopped the
clean way (wrong pid in the pidfile AND wrong shutdown password). Remedy: a
targeted `kill <real pid>` (same last resort the script itself uses), `rm` the
stale pidfile, re-run the .sh, and verify the running pid changed. Avoid the
race in the first place: never launch `serve` while another wordwiki.sh command
may still be in its stop-dance; wait for the previous command to fully exit.

**Cross-container pidfile guard (dz, 2026-07-08):** dz runs
importWordWikiV1Db.sh / updateStaging.sh OUTSIDE the container against the
same instance dir where the server runs INSIDE it — there the /proc-based
liveness check can't see the server (different pid namespace) and
wordwiki.sh's stop is a silent no-op. Both scripts therefore REFUSE to run
while `<instance>/wordwiki.pid` exists (presence alone, deliberately
conservative; dz accepts occasionally rm-ing a stale pidfile). Consequence
for the dev loop INSIDE the container: stop the server (`./wordwiki.sh
stop`) before running the import script — its old auto-stop step is gone.
**Why:** copying into/out of a live db file risks a torn copy. Apply the
same presence-check to any future script that touches the db file.

**Publish gotcha:** the in-app Publish button (`wordwiki.publish.startPublish`)
runs INSIDE the live server process, so it uses whatever code the server was
started with. After editing any publish/render code you MUST restart the server
before publishing, or it emits stale markup (symptom: "I published but my change
isn't on the site"). The CLI `./wordwiki.sh publish [targets]` spawns fresh Deno
and always uses current source, so it doesn't need a restart — but a later
web-publish with a stale server can overwrite CLI-published pages.
