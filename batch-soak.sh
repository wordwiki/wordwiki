#!/bin/bash
set -e

# Tier-2 SOAK runner for the batch AI derivation (batch-derivation-design.md
# §12.2) - the feature ACCEPTANCE GATE before production batch runs.  Wraps
# liminal/testing/batch-soak.ts (the scenarios live there) with:
#   - the one-time CRASH INJECTION on the very first invocation (run 1
#     submits the whole frontier and dies after submit, before the markers
#     learn the batch id - exit 9 is EXPECTED; later runs must reconnect
#     with no double-submit), and
#   - the unattended hourly loop that reruns until 'done', then asserts.
#
#   ./batch-soak.sh run     one invocation (exit 0 done / 3 in-flight / 9 crash)
#   ./batch-soak.sh loop    run hourly until done, then assert (foreground;
#                           start detached:  (nohup ./batch-soak.sh loop
#                              > tmp/batch-soak/loop.log 2>&1 &) )
#   ./batch-soak.sh status  state + report so far
#   ./batch-soak.sh assert  final terminal assertions + the no-AI-flag proof
#   ./batch-soak.sh reset   wipe the soak state (a fresh soak re-SPENDS a few
#                           cents - deliberate)
#
# Spend: ~90 trivial haiku requests over ~3 batches - a few cents total.
# State/report: tmp/batch-soak/ (untracked).  Run from the repo root (the
# wordwiki credential lives there); does NOT touch mmo/ or the real stores.

cd "$(dirname "$0")"
DIR=tmp/batch-soak
SOAK="deno run --allow-all liminal/testing/batch-soak.ts"

case "${1:-status}" in
    run)
        mkdir -p "$DIR"
        if [ ! -f "$DIR/crash-injected" ]; then
            touch "$DIR/crash-injected"
            echo "=== first soak invocation: injecting the after-submit crash (exit 9 EXPECTED) ==="
            set +e
            LIMINAL_BATCH_CRASH=after-submit $SOAK run --dir=$DIR
            code=$?
            set -e
            echo "=== crash run exited $code (9 expected) ==="
            [ $code -eq 9 ] && exit 3 || exit $code
        fi
        exec $SOAK run --dir=$DIR
        ;;
    loop)
        while true; do
            set +e
            ./batch-soak.sh run
            code=$?
            set -e
            if [ $code -eq 0 ]; then
                echo "=== soak DONE - running the terminal assertions ==="
                exec $SOAK assert --dir=$DIR
            fi
            echo "=== in flight (exit $code) - sleeping 1h ==="
            sleep 3600
        done
        ;;
    status) exec $SOAK status --dir=$DIR ;;
    assert) exec $SOAK assert --dir=$DIR ;;
    reset)
        rm -rf "$DIR"
        echo "soak state wiped ($DIR) - the next run starts a fresh (paid) soak"
        ;;
    *)
        echo "usage: batch-soak.sh run|loop|status|assert|reset" >&2
        exit 1
        ;;
esac
