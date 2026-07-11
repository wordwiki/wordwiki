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
#                                      # categories from <repo>/categorization
#                                      # (or a dir arg; idempotent; refuses production db;
#                                      # stamps '~category-import' unless
#                                      # --username=NAME)
#   ./wordwiki.sh import-lexical-forms # seed the part-of-speech vocabulary +
#                                      # normalize unambiguous legacy values
#                                      # (idempotent; refuses production db;
#                                      # stamps '~lexical-form-import')
#   ./wordwiki.sh import-twitter-posts # backfill twitter-post from the retired
#                                      # legacy dump (legacy-mmo.txt); matches
#                                      # by Listuguj spelling, adds missing
#                                      # ones (idempotent; refuses production;
#                                      # stamps '~twitter-post-import')
#   ./wordwiki.sh publish [target...]  # publish the public site (or just the
#                                      # named pages, e.g. entries/samqwan);
#                                      # leaves a running server alone
#   ./wordwiki.sh stop                 # stop the server, nothing else
#   ./wordwiki.sh repair-assertions    # idempotent structural fixes of store
#                                      # corruption incl. cascade-tombstoning
#                                      # orphaned children of deleted parents
#                                      # (refuses production db)
#   ./wordwiki.sh backfill-publication # publication Phase 0: clear legacy
#                                      # placeholder + born-approve Completed
#                                      # data, mute-in-place (refuses prod)
#   ./wordwiki.sh normalize-shoebox-dates # rewrite legacy shoebox-date
#                                      # attribute values to ISO yyyy-mm-dd,
#                                      # mute-in-place (idempotent; refuses
#                                      # prod) - the imported lexemes'
#                                      # creation dates, machine-readable
#   ./wordwiki.sh verify-migration     # read-only post-migration sanity
#                                      # checks (exit 1 on failure)
#   ./wordwiki.sh verify-workspace     # read-only structural invariants of
#                                      # the whole assertion store (exit 1);
#                                      # also reports the variant (orthography)
#                                      # invariants as WARNINGS (warn mode
#                                      # until the orthography migration)
#   ./wordwiki.sh scan-variants        # read-only scan of variant values
#                                      # against the schema's orthography
#                                      # flags (fix-orthographies.md); exit 0
#                                      # iff the $notVariant drop gate passes;
#                                      # --report <path.md> writes the
#                                      # findings report
#   ./wordwiki.sh export-transliteration-pairs [path.json]
#                                      # export the clean li/sf pair ORACLE
#                                      # for the standalone rules harness
#                                      # (wordwiki/transliterate-harness.ts)
#   ./wordwiki.sh migrate-status       # the STATUS REMODEL migration:
#                                      # publish gates from Completed, the
#                                      # Complete renames, sta variant blank,
#                                      # 'Unknown' synthesis (once per db via
#                                      # config marker; --dry-run / --report /
#                                      # --expect-no-changes as migrate-variants)
#   ./wordwiki.sh migrate-variants     # THE orthography data migration:
#                                      # blank normalize + $notVariant drop +
#                                      # value fixes + per-tag blank backfill,
#                                      # mute-in-place (idempotent; refuses
#                                      # prod; needs the flagged schema;
#                                      # --expect-no-changes proof mode;
#                                      # --report <path.md>; --dry-run runs
#                                      # everything in a rolled-back tx and
#                                      # reports every case - the REVIEW
#                                      # artifact for the decision tables,
#                                      # and with --expect-no-changes a
#                                      # read-only is-it-migrated probe)
#
#   ./wordwiki.sh assemble-import-report <dir> <out.md> [expected...]
#                                      # concatenate per-step findings
#                                      # fragments into one report with an
#                                      # executive summary (CRASHED/MISSING
#                                      # markers); run by importWordWikiV1Db's
#                                      # EXIT trap
#
# Every pipeline subcommand accepts --report=<path.md>: its log/finding
# commentary lands in a findings fragment (written even on a crash).  The
# server renders the assembled report + fragments at
# /ww/wordwiki.importReport().
#
# The whole pull-and-migrate program is packaged as ./importWordWikiV1Db.sh
# (the V1-db import; --no-pull --allow-production is the production cutover).
#
# Any command first cleanly stops a running server (SQLite single writer),
# except the read-only commands (publish, dump-publish-source,
# dump-full-history, backup-db, transcribe-eval), which run alongside the
# live server.
#
#   ./wordwiki.sh transcribe-eval [--book=PDM] [--sample=10] [--offset=0]
#                                 [--report=transcribe-eval.md]
#                                      # LLM transcription EVAL (read-only;
#                                      # wordwiki/transcribe.ts): 3-stage
#                                      # recipe scored against the hand
#                                      # transcriptions; derived-store cached
#                                      # (re-runs free until a prompt-version
#                                      # bump); prints actual API token spend.
#                                      # Needs wordwiki-anthropic-credential.json
#                                      # in the INSTANCE dir (mmo/; symlink).

WORDWIKI_SRC="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${WORDWIKI_DIR:-$WORDWIKI_SRC/mmo}"
PIDFILE="wordwiki.pid"
PWFILE="wordwiki-shutdown-password.txt"
# Resolve this checkout's port + advertised host (see liminal/run-env.sh for the
# resolution order and the per-checkout cookie-isolation rationale).  The
# checkout is named by the repo src dir (we cd into the instance dir below, so
# $PWD is NOT the checkout).  This exports WORDWIKI_PORT (read by wordwiki.ts
# `serve`) and LIMINAL_PUBLIC_HOST (read by liminal's startServer), so the deno
# process below binds the right port and advertises <checkout-dir>.localhost.
. "$WORDWIKI_SRC/liminal/run-env.sh"
resolve_run_env "$WORDWIKI_SRC" WORDWIKI_PORT "$WORDWIKI_SRC/wordwiki_port.txt" 9000 9000
PORT="$WORDWIKI_PORT"

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
# READ-ONLY commands run happily alongside the server - skip the
# stop-the-server dance for them.  `publish` (reads db, writes site files)
# is what you want when iterating on templates; the dump/backup commands
# exist precisely to run against a LIVE server (backup-db is VACUUM INTO,
# an ordinary read transaction - daily systemd snapshots must not restart
# the site).
case "$1" in
    publish|dump-publish-source|dump-full-history|backup-db|transcribe-eval)
        SKIP_STOP=1;;
    *)  SKIP_STOP=0;;
esac
if [ "$SKIP_STOP" != "1" ] && [ -f "$PIDFILE" ]; then
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
