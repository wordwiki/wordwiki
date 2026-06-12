#!/bin/bash
set -e

# wordwiki run script (adapted from rabid.sh).
#
# The server runs with ~/mmo as its working directory: the SQLite db, the
# published static site, the content stores, and the runtime files (pidfile,
# shutdown password) all live there.  The code lives in ~/wordwiki.
#
# Usage:
#   ./wordwiki.sh                      # (re)start the server on :9000
#   ./wordwiki.sh upgrade-users        # one-time user-table migration + seed
#   ./wordwiki.sh set-password djz pw  # set a user's password
#   ./wordwiki.sh set-db-purpose dev   # mark the db (production|dev|test)
#   ./wordwiki.sh import-categories    # seed category table + rewrite entry
#                                      # categories from ~/wordwiki/categorization
#                                      # (idempotent; refuses production db)
#   ./wordwiki.sh import-lexical-forms # seed the part-of-speech vocabulary +
#                                      # normalize unambiguous legacy values
#                                      # (idempotent; refuses production db)
#   ./wordwiki.sh publish [target...]  # publish the public site (or just the
#                                      # named pages, e.g. entries/samqwan);
#                                      # leaves a running server alone
#
# Any command first cleanly stops a running server (SQLite single writer),
# except `publish`, which only reads the db.

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$HOME/mmo"
PIDFILE="wordwiki.pid"
PWFILE="wordwiki-shutdown-password.txt"
PORT=9000

# Always refresh the browser-side scripts and /resources first (transpile.sh
# compiles page-editor/page-viewer into ~/mmo/scripts and rsyncs resources/).
# A bit hoaky to run it on every invocation, but starting with stale client
# scripts breaks things in confusing ways, and it's cheap.
(cd "$WORDWIKI_SRC" && ./transpile.sh)

cd "$RUN_DIR"

# Only one wordwiki server may run at a time: it binds a fixed port and uses
# SQLite in a single-writer configuration.  So before doing anything, stop any
# server that is already running - whether launched from here, from
# publishHomeAndServe.sh, or by hand.  This makes "just run wordwiki.sh again"
# a reliable restart.
#
# We stop it the clean way: ask the server to shut itself down via its
# authenticated shutdown route, so SQLite closes properly.  We only fall back
# to SIGKILL if a wedged server ignores the request and outlives the timeout.
# `publish` only READS the db (it writes site files), so it runs happily
# alongside the server - skip the stop-the-server dance for it, which is
# exactly what you want when iterating on the public-site templates.
if [ "$1" != "publish" ] && [ -f "$PIDFILE" ]; then
    OLDPID=$(cat "$PIDFILE" 2>/dev/null || true)
    # Act only if that pid is alive AND really is a wordwiki - reading
    # /proc/PID/cmdline both confirms liveness and guards against a stale
    # pidfile whose pid has since been reused by an unrelated process.
    if [ -n "$OLDPID" ] && grep -qs "wordwiki/wordwiki.ts" "/proc/$OLDPID/cmdline"; then
        echo "Asking existing wordwiki (pid $OLDPID) to shut down cleanly..."
        if [ -f "$PWFILE" ]; then
            PW=$(cat "$PWFILE")
            # timeout guards against a sick/unresponsive server hanging the curl.
            timeout 10 curl -s -o /dev/null "http://localhost:$PORT/ww/wordwiki.shutdown($PW)" || true
        else
            echo "  (no $PWFILE found - can't ask nicely; will wait, then force.)"
        fi
        # Wait up to ~10s for the process to actually exit and release the port.
        for _ in $(seq 1 100); do
            grep -qs "wordwiki/wordwiki.ts" "/proc/$OLDPID/cmdline" || break
            sleep 0.1
        done
        # Last resort: a wedged server that ignored the clean shutdown.
        if grep -qs "wordwiki/wordwiki.ts" "/proc/$OLDPID/cmdline"; then
            echo "Clean shutdown timed out; force-killing pid $OLDPID."
            kill -9 "$OLDPID" 2>/dev/null || true
            for _ in $(seq 1 50); do
                grep -qs "wordwiki/wordwiki.ts" "/proc/$OLDPID/cmdline" || break
                sleep 0.1
            done
        fi
    fi
    rm -f "$PIDFILE"
fi

# Default to `serve`; otherwise pass args straight through.
if [ "$#" -eq 0 ]; then
    set -- serve
fi
deno run --check --allow-all "$WORDWIKI_SRC/wordwiki/wordwiki.ts" "$@"
