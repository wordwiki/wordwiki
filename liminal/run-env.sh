# Shared per-checkout run-environment resolution for liminal apps (rabid, wordwiki).
# Sourced by the per-app launcher scripts (rabid.sh, wordwiki.sh).
#
# Each parallel git worktree (e.g. wordwiki--2) gets:
#   * its own listen PORT, so the servers coexist (SQLite is single-writer per db);
#   * its own advertised host <checkout-dir>.localhost, so a browser / puppeteer
#     pointed at it keeps a SEPARATE cookie jar from other checkouts - while still
#     counting as a localhost secure-context, so no HTTPS is required.
# `*.localhost` resolves to loopback with no /etc/hosts entry needed.
#
# This is the ONE place the per-checkout naming conventions live (port = base+N,
# host = <dir>.localhost); the server code stays generic and just consumes the
# resolved values via the env vars exported below.
#
# Usage (source, then call):
#   . "$(dirname "$0")/liminal/run-env.sh"
#   resolve_run_env <identity_dir> <port_env_var> <port_file> <port_base> <default_port>
#
#   identity_dir  dir whose basename names the checkout (rabid: $PWD; wordwiki: repo src)
#   port_env_var  env var the launcher + server use for the port (RABID_PORT / WORDWIKI_PORT)
#   port_file     git-ignored per-checkout port file (may be absent / empty arg)
#   port_base     a numeric --N suffix maps to port_base + N
#   default_port  used when there is no env / file / numeric --N suffix
#
# Resolution order for the port (first hit wins): $port_env_var, $LIMINAL_PORT,
# port_file, a trailing --N in the checkout dir name, then default_port.
#
# $LIMINAL_PORT is the framework-level port the container environment injects
# (pj sets it per-container): several co-developed liminal apps share a checkout
# and whichever one you launch binds the container's assigned port.  It ranks
# just below the app-specific $port_env_var (still the explicit override) and
# ABOVE the per-checkout file / --N conventions, since a container's injected
# port must win over the dirname/file heuristics inside that container.  Unset on
# the host, so host behaviour is unchanged.
#
# Exports the resolved port under $port_env_var and the advertised host under
# LIMINAL_PUBLIC_HOST (both read by liminal's startServer / DenoHttpServer).

resolve_run_env() {
    local identity_dir="$1" port_env_var="$2" port_file="$3" port_base="$4" default_port="$5"

    local port="${!port_env_var:-}"
    # Framework-level port injected by the container env (pj); wins over the
    # per-checkout file/suffix conventions below, loses to the app-specific var.
    if [ -z "$port" ] && [ -n "${LIMINAL_PORT:-}" ]; then
        port="$LIMINAL_PORT"
    fi
    if [ -z "$port" ] && [ -n "$port_file" ] && [ -f "$port_file" ]; then
        port="$(tr -d '[:space:]' < "$port_file")"
    fi
    local base suffix
    base="$(basename "$identity_dir")"
    if [ -z "$port" ]; then
        suffix="${base##*--}"            # text after the last '--', or $base if none
        case "$suffix" in
            "$base"|""|*[!0-9]*) : ;;    # no '--', or empty / non-numeric suffix
            *) port=$((port_base + 10#$suffix)) ;;  # 10# forces base-10 (avoid octal on 08/09)
        esac
    fi
    port="${port:-$default_port}"

    # Advertise <checkout-dir>.localhost so each checkout keeps its own cookie jar.
    export "$port_env_var=$port"
    export LIMINAL_PUBLIC_HOST="${base}.localhost"
}
