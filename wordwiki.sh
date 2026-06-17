#!/bin/bash
set -e

# wordwiki run script (adapted from rabid.sh).
#
# The server runs with an INSTANCE DIRECTORY as its working directory: the
# SQLite db, the published static site, the content stores, and the runtime
# files (pidfile, shutdown password) all live there.  The code lives in the repo
# (this script's dir).
#
#   Instance dir : $WORDWIKI_DIR  (default: <repo>/mmo)
#   Port         : $WORDWIKI_PORT (default: 9000)
#
# To run a second instance in parallel: point WORDWIKI_DIR at another set-up
# instance dir (its own database/ + published output; the big read-only stores
# content/imports/derived can be symlinks to a shared store) on a free
# WORDWIKI_PORT.  The server verifies the dir on startup and refuses to run an
# unconfigured one (rather than silently serving empty stores).
#
# Usage:
#   ./wordwiki.sh                      # (re)start the server on :9000
#   ./wordwiki.sh upgrade-users        # one-time user-table migration + seed
#   ./wordwiki.sh set-password djz pw  # set a user's password
#   ./wordwiki.sh set-db-purpose dev   # mark the db (production|dev|test)
#   ./wordwiki.sh import-categories    # seed category table + rewrite entry
#                                      # categories from ~/wordwiki/categorization
#                                      # (idempotent; refuses production db;
#                                      # stamps '~category-import' unless
#                                      # --username=NAME)
#   ./wordwiki.sh import-lexical-forms # seed the part-of-speech vocabulary +
#                                      # normalize unambiguous legacy values
#                                      # (idempotent; refuses production db;
#                                      # stamps '~lexical-form-import')
#   ./wordwiki.sh publish [target...]  # publish the public site (or just the
#                                      # named pages, e.g. entries/samqwan);
#                                      # leaves a running server alone
#   ./wordwiki.sh stop                 # stop the server, nothing else
#   ./wordwiki.sh repair-assertions    # idempotent structural fixes of store
#                                      # corruption (refuses production db)
#   ./wordwiki.sh backfill-publication # publication Phase 0: clear legacy
#                                      # placeholder + born-approve Completed
#                                      # data, mute-in-place (refuses prod)
#   ./wordwiki.sh verify-migration     # read-only post-migration sanity
#                                      # checks (exit 1 on failure)
#   ./wordwiki.sh verify-workspace     # read-only structural invariants of
#                                      # the whole assertion store (exit 1)
#
# The whole pull-and-migrate rehearsal is packaged as ./migrateDevDb.sh
# (which also documents the eventual production-cutover recipe).
#
# Any command first cleanly stops a running server (SQLite single writer),
# except `publish`, which only reads the db.

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
PIDFILE="wordwiki.pid"
PWFILE="wordwiki-shutdown-password.txt"
# Port resolution, in order:
#   1. $WORDWIKI_PORT
#   2. this checkout's (git-ignored) wordwiki_port.txt
#   3. a trailing --N in the checkout dir name (wordwiki--1 -> 9001), so a
#      numbered pool of worktrees needs no port file at all
#   4. 9000
# The env var / file let a parallel checkout pin its own port without exporting
# WORDWIKI_PORT on every invocation.
PORT="${WORDWIKI_PORT:-}"
if [ -z "$PORT" ] && [ -f "$WORDWIKI_SRC/wordwiki_port.txt" ]; then
    PORT="$(tr -d '[:space:]' < "$WORDWIKI_SRC/wordwiki_port.txt")"
fi
if [ -z "$PORT" ]; then
    base="$(basename "$WORDWIKI_SRC")"
    suffix="${base##*--}"            # text after the last '--', or $base if none
    case "$suffix" in
        "$base"|""|*[!0-9]*) : ;;    # no '--', or empty / non-numeric suffix
        *) PORT=$((9000 + 10#$suffix)) ;;   # 10# forces base-10 (avoid octal on 08/09)
    esac
fi
PORT="${PORT:-9000}"
# The server reads its listen port from $WORDWIKI_PORT (see wordwiki.ts `serve`).
# Export the resolved value so the deno process below actually binds $PORT
# rather than falling back to its own 9000 default.
export WORDWIKI_PORT="$PORT"

# Refuse on a missing instance dir rather than silently creating an empty one
# (transpile's mkdir -p would otherwise conjure it into existence).  The server
# does the deeper store checks; this is the fast, obvious one.
if [ ! -d "$RUN_DIR" ]; then
    echo "wordwiki instance dir '$RUN_DIR' does not exist." >&2
    echo "Create it and provide its data: production = a real dir (copy/rsync the" >&2
    echo "data in); dev = symlink content/imports/derived to a shared store and give" >&2
    echo "it its own database/.  Override the location with WORDWIKI_DIR=..." >&2
    exit 1
fi

# Always refresh the browser-side scripts and /resources first (transpile.sh
# compiles page-editor/page-viewer into <instance>/scripts and rsyncs resources/
# into <instance>/resources).  A bit hoaky to run it on every invocation, but
# starting with stale client scripts breaks things in confusing ways, and it's
# cheap.
(cd "$WORDWIKI_SRC" && ./transpile.sh "$RUN_DIR")

cd "$RUN_DIR"

# Only one wordwiki server may run at a time: it binds a fixed port and uses
# SQLite in a single-writer configuration.  So before doing anything, stop any
# server that is already running - whether launched from here or by hand.
# This makes "just run wordwiki.sh again" a reliable restart.
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

# Route security: routes are evaluated by the restricted routeterp interpreter in
# STRICT mode (the liminal default now that jsterp is unhooked) - undeclared
# members 404, @route perms + POST-for-mutations enforced.  For debugging only,
# override with `LIMINAL_ROUTE_POLICY=permissive ./wordwiki.sh`.
deno run --check --allow-all "$WORDWIKI_SRC/wordwiki/wordwiki.ts" "$@"
