# Browser testing & the eval bridge

A way to **run JavaScript inside a real, logged-in browser from server-side
code** — and to drive whole test runs against that browser — without a separate
puppeteer/CDP/WebDriver process. It reuses the app's own HTTP channel, session,
and auth. The same machinery powers a dev-only `/eval` endpoint for poking at a
running server or browser when things go off the rails.

> Layering: the whole mechanism lives in the framework. `liminal/liminal.ts`
> defines an abstract `LiminalApp` base holding route dispatch, the HTTP handler,
> server lifecycle, the browser-test bridge, the named-run launcher, and `/eval`.
> An app (rabid, and later wordwiki) does `class App extends LiminalApp` and
> supplies a small set of hooks: its `routes` scope, `resolveSecurityContext`,
> `getDbPurpose`, the three `*TestClient*` session-persistence methods, `makePage`,
> `resourceContentDirs`, `testRuns`, and (optionally) `coercePageResult`,
> `rewriteUnauthenticatedRoute`, and `evalServer`. The transient channel is
> `liminal/browser-agent.ts`; the client is `resources/test-agent.js`.

## Why

Driving a browser from tests normally means a second process (puppeteer,
Selenium) with its own driver binary, version-matching, and lifecycle. The pain
isn't "drive a browser", it's the out-of-band machinery. Here the browser the
test drives is a normal tab the app already served — so it tests the *real*
deployed stack (real cookies, htmx, CSP, the actual browser) with no driver.

It is **not** a new trust boundary in the obvious sense — the server already
authors and ships the JS that runs in its clients. The genuine risk is that this
lets *whoever can reach the endpoints* run code in a logged-in session (or on the
host), so the controls below are about **who can drive**, not "can the server run
JS in its client".

## Architecture

Two halves, split by lifetime:

- **Durable identity & liveness — in the session row.** Two columns on the login
  session, `last_test_client_opt_in` and `last_test_client_heartbeat`, record
  which browser is the test client and whether it's alive. Because they're in the
  db they **survive a server restart**: after a reload the server still knows
  which tab to drive without any re-registration handshake.
- **Transient command plumbing — in memory** (`liminal/browser-agent.ts`,
  `BrowserAgentChannel`), keyed by `session_token`: the parked long-poll and the
  pending-result promise. This is the part that legitimately dies on restart; the
  browser's reconnect loop just re-parks a poll.

**Selection rule (deterministic):** the active test client is **always the
most-recent `last_test_client_opt_in`** — never an older one, even if the newest
has gone silent. Heartbeat is *diagnostic only*: it sharpens the timeout error
and lets the launcher fail fast, but it never changes *which* tab is targeted.
No flapping between a stale tab and a new one; if the newest is dead you get a
clear error and the fix is unambiguous (re-open the tab you want, which makes it
newest).

## The protocol

A browser opts in (loads the test-client page), then loops:

1. `POST testClientOptIn` → marks this session the most-recent test client.
2. `POST testClientPoll` → long-poll (~25s). Returns `{cmd}` when a command is
   queued, `{cmd:null}` on timeout (re-poll), or `{stale:true}` if a newer client
   has taken over (this tab stops). Each poll stamps a heartbeat.
3. Runs the command's JS as the body of an `async` function, structured-serializes
   the result, and `POST testClientResult {cmdId, envelope}`.

Server-side, `evalInBrowser(js, {timeoutMs})` allocates a `cmdId`, enqueues the
command (waking a parked poll), and awaits the matching result or times out.

Invariants and edge cases that matter:

- **One command in flight per client.** Server-side test code awaits each
  `evalInBrowser` before the next, so commands are naturally serial; an
  overlapping call is rejected, not silently queued.
- **`cmdId` carries a per-process boot prefix** (`<boot>.<seq>`). `#seq` restarts
  at 0 in a fresh server, so without the prefix the first command after a restart
  would collide with a pre-restart `cmdId` still cached in a reconnecting tab and
  be wrongly treated as a duplicate.
- **Idempotent re-send.** The client caches the last executed `{cmdId, envelope}`.
  If a poll re-delivers a `cmdId` it already ran (e.g. its result POST was lost),
  it re-sends the cached envelope rather than re-evaluating.
- **Reconnect ≠ death.** A failed result POST (almost always the server
  restarting — a `test-run` exits right after the last result) is caught as a
  reconnect, *not* allowed to kill the loop. This is what makes the edit→rerun
  loop survive restarts with no page reload.

### Structured serialization

`JSON.stringify` is lossy (drops `undefined`, mangles `NaN`/`Infinity`, throws on
cycles, doesn't understand DOM nodes), so values are tagged instead:

| value | wire form |
|---|---|
| `undefined` | `{__undefined:true}` |
| `NaN` / `±Infinity` | `{__number:"NaN"}` etc. |
| `bigint` | `{__bigint:"..."}` |
| function | `{__function:"name"}` |
| symbol | `{__symbol:"..."}` |
| `Date` | `{__date:"<iso>"}` |
| DOM node (browser only) | `{__dom, id, class, text, outerHTML}` |
| cycle / >depth | `{__circular:true}` / `{__truncated:true}` |

Objects with `toJSON` (e.g. Temporal) use it. Depth- and length-capped.

## Named test-run launch

`./rabid.sh test-run <name>` (default `demo`): starts the server, waits for a live
test client, runs the named run, prints a summary, and exits with a code —
**0** all-passed, **1** failures, **2** unknown run, **3** no client. (`startServer`
resolves once `Deno.serve` is listening — it serves in the background — so the run
and the server run concurrently in one process.)

Runs are registered in a `TEST_RUNS` map; a run is a list of cases, each of which
may freely **intermix** in-process checks (query the db / dispatch a route
directly) and in-browser checks (`evalInBrowser`).

**The edit→rerun loop (no browser clicking):**

1. Open the test-client page in a logged-in browser **once**; leave the tab open.
2. Edit code.
3. `./rabid.sh test-run <name>` — `rabid.sh`'s clean-shutdown-of-any-existing IS
   the restart; the tab reconnects on its own (opt-in is durable, the client
   re-polls), so the run targets it with no interaction. Repeat 2–3.

Caveat: this holds for **code** changes. A **db rebuild** (`create_fake_data.sh`)
wipes the session table, so the cookie/opt-in are gone — log in and re-open the
page once.

## The `/eval` endpoint (dev god-mode)

For interactive exploration of a wedged server or browser.

```
POST /eval   {password, target: 'server'|'browser', js, timeoutMs?}
  → {ok:true, target, value}            # value is structured-serialized
  | {ok:false, target?, error:{name,message,stack?}}
```

Matched on the **raw path** and handled directly — *not* via the route
interpreter — so the posted code is never parsed as a route expression.

- **`target:'server'`** runs `js` in the server process via **direct `eval`** (not
  `new Function`, which would see only globals) wrapped in an `async` IIFE under a
  trusted/system context (field-read guards bypassed for exploration). So the code
  reaches the eval site's lexical scope: `rabid` and every module import there
  (`security`, `db`, `table`, `volunteer`, `event`, `commitment`, `templates`,
  `date`, `Temporal`, …), plus globals (`Deno`, `fetch`, `crypto`) and
  `await import('…')` for anything else. The result is JSON-safed before sending.
- **`target:'browser'`** reuses `evalInBrowser` against the current test client.

Example:

```bash
PW=$(cat rabid-eval-password.txt)
curl -s -X POST -H 'content-type: application/json' \
  -d "{\"password\":\"$PW\",\"target\":\"server\",
       \"js\":\"return rabid.volunteer.allVolunteersByName.all({}).length;\"}" \
  http://localhost:8888/eval
```

## Security model — the gates

Layered; the harness routes require **both** of the first two, and the `/eval`
server target adds the third:

1. **Non-production db.** Everything is refused when `db_purpose === 'production'`
   (the marker travels with the data; see the destructive-op guard). The
   `eval-password` is *generated only* on a non-production db, so `/eval` is
   hard-off on production.
2. **Permission / password.** The test-client routes require the **`testing`**
   permission. `/eval` is authorised by a **separate** `eval-password`
   (`rabid-eval-password.txt`, mode `0600`, gitignored) — deliberately *not* the
   shutdown password, so its much larger blast radius is its own.
3. **Localhost (server eval only).** Server-target `/eval` (RCE on the host) also
   requires a **loopback TCP peer** (`127.0.0.1`/`::1`) **and** refuses if any
   forwarding header (`X-Forwarded-For` / `Forwarded` / `X-Real-IP`) is present —
   because binding to localhost is *not* enough behind a reverse proxy, where
   every peer is loopback and the real (possibly remote) client rides in a
   forwarding header. (The peer address is threaded through the server
   abstraction as `server.Request.remoteAddr`.)

The browser target is intentionally *not* localhost-gated: it executes in the
dev's own browser, not on the host, so it isn't host-RCE.

Honest caveat: server-target `/eval` is genuine RCE. The gates make it safe as a
dev tool, but the `eval-password` is the fence — don't expose a dev/test server
beyond localhost while trusting only the password.

## Setup / usage

1. Serve a non-production db: `./rabid.sh` (the dev db is marked `dev`).
2. Log in as a volunteer with the **`testing`** permission. In dev, the canonical
   login **Rocky** (`rocky@redraccoon.org` / `rcky`) has `admin,testing`.
3. Open the **test-client page** — a test-mode-only nav button labelled
   "Test client" (shown only on a non-production db; it's a `<button>`, not a
   prefetchable link, so prerender can't silently opt a tab in), or navigate to
   `/rabid.testClientPage()` directly (the `/rabid/` prefix is optional - it's
   stripped by the handler and `/` catches everything). Leave the tab open.
4. Run tests: the page's "Run demo tests" button, or `./rabid.sh test-run demo`.

## File map

| Concern | File |
|---|---|
| Framework core: dispatch, HTTP handler, lifecycle, bridge, launcher, `/eval`, gates | `liminal/liminal.ts` (`LiminalApp`) |
| Transient command channel | `liminal/browser-agent.ts` |
| Peer address in the request abstraction | `liminal/http-server.ts`, `liminal/deno-http-server.ts` |
| App hooks (routes, auth, page template, `evalServer` scope, login) | `rabid/rabid.ts` (`class Rabid extends LiminalApp`) |
| Durable identity (session columns + queries) | `rabid/volunteer.ts` |
| Browser client (app-agnostic; reads `window.__liminalTestAgent`) | `resources/test-agent.js` |
| Demo suite / `TEST_RUNS` registry | `rabid/browser_test_demo.ts` |
| Launch passthrough | `rabid.sh` (`./rabid.sh test-run <name>`) |
