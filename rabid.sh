#!/bin/bash
set -e

PIDFILE="rabid.pid"
PWFILE="rabid-shutdown-password.txt"
PORT=8888

# Only one rabid server may run at a time: it binds a fixed port (8888) and uses
# SQLite in a single-writer configuration.  So before starting, stop any rabid
# that is already running - whether launched from here, from emacs M-x compile,
# or by hand.  This makes "just run rabid.sh again" a reliable restart.
#
# We stop it the clean way: ask the server to shut itself down via its
# authenticated shutdown route, so SQLite closes properly.  We only fall back to
# SIGKILL if a wedged server ignores the request and outlives the timeout.
if [ -f "$PIDFILE" ]; then
    OLDPID=$(cat "$PIDFILE" 2>/dev/null || true)
    # Act only if that pid is alive AND really is a rabid - reading
    # /proc/PID/cmdline both confirms liveness and guards against a stale pidfile
    # whose pid has since been reused by an unrelated process.
    if [ -n "$OLDPID" ] && grep -qs "rabid/rabid.ts" "/proc/$OLDPID/cmdline"; then
        echo "Asking existing rabid (pid $OLDPID) to shut down cleanly..."
        if [ -f "$PWFILE" ]; then
            PW=$(cat "$PWFILE")
            # timeout guards against a sick/unresponsive server hanging the curl.
            timeout 10 curl -s -o /dev/null "http://localhost:$PORT/rabid/rabid.shutdown($PW)" || true
        else
            echo "  (no $PWFILE found - can't ask nicely; will wait, then force.)"
        fi
        # Wait up to ~10s for the process to actually exit and release the port.
        # The cmdline check disappears once the process is gone.
        for _ in $(seq 1 100); do
            grep -qs "rabid/rabid.ts" "/proc/$OLDPID/cmdline" || break
            sleep 0.1
        done
        # Last resort: a wedged server that ignored the clean shutdown.  Only
        # fires for a confirmed rabid pid that outlived the timeout; SQLite is
        # crash-safe against a single SIGKILL.
        if grep -qs "rabid/rabid.ts" "/proc/$OLDPID/cmdline"; then
            echo "Clean shutdown timed out; force-killing pid $OLDPID."
            kill -9 "$OLDPID" 2>/dev/null || true
            # kill -9 is asynchronous: the signal returns immediately, but the OS
            # tears the process down (closing its listening socket) a moment
            # later.  Wait for it to actually disappear before we try to bind,
            # otherwise the new server races the old one for the port.
            for _ in $(seq 1 50); do
                grep -qs "rabid/rabid.ts" "/proc/$OLDPID/cmdline" || break
                sleep 0.1
            done
        fi
    fi
    rm -f "$PIDFILE"
fi

# Default to `serve`; otherwise pass args straight through, e.g.
#   ./rabid.sh test-run demo
# which starts the server, runs a named browser test run against an already-open
# test-client browser tab (it reconnects across this restart), and exits with a
# pass/fail code.  The clean-shutdown-of-any-existing-rabid above IS that restart.
if [ "$#" -eq 0 ]; then
    set -- serve
fi

# Route security: routes are evaluated by the restricted routeterp interpreter in
# STRICT mode (the liminal default now that jsterp is unhooked) - undeclared
# members 404, @route perms + POST-for-mutations enforced.  For debugging only,
# override with `LIMINAL_ROUTE_POLICY=permissive ./rabid.sh`.
deno run --check --allow-all rabid/rabid.ts "$@"
