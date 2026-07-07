# The dev eval endpoint & browser test bridge

How server-side code (a test, a REPL, an agent) runs arbitrary JavaScript **in the
server process** or **in a real logged-in browser** and gets the value back — with
no puppeteer/CDP process. Two cooperating pieces:

- **`/eval`** — a dev-only HTTP endpoint that runs a chunk of JS and returns its
  (JSON-safe) value. Targets the **server** process or the **browser** test client.
- **The browser test client** — a logged-in browser that long-polls for JS to run,
  executes it, and posts the result back. `evalInBrowser(js)` pushes onto that loop.

Both are **disabled on a production database** and require the **`testing`**
permission; they exist to make client behaviour observable and scriptable during
development and in the named browser-test runs. This is how the htmx-settle
refresh-debug bug was root-caused (see [Refresh debug mode] in `liminal.md`).

Code: `liminal/liminal.ts` (endpoint + routes + `evalInBrowser`), `liminal/browser-agent.ts`
(the transient channel), `resources/test-agent.js` (the browser-side agent), and per
app the page-template injection (`rabid/templates.ts` / `rabid/rabid.ts`).


## `/eval`

A single POST endpoint, intercepted in `requestHandler` before route dispatch
(mounted at `/eval`, or `<routePrefix>eval` for a prefixed app):

```
POST /eval
Content-Type: application/json
{ "password": "<from rabid-eval-password.txt>",
  "js":       "return 1 + 1;",          // an async function BODY: use return/await
  "target":   "server" | "browser",     // default "server"
  "timeoutMs": 30000 }                   // browser target only
```

Response: `{ "ok": true, "target": "...", "value": <serialized> }` on success, or
`{ "ok": false, "error": { "name", "message", "stack" } }` on failure.

**Enabling / the password.** `/eval` answers only when the db is non-production
(`isTestDb`) AND the request carries the exact password. On a non-production db the
server generates the password at startup and writes it to `<appName>-eval-password.txt`
(mode 0600) — e.g. `rabid-eval-password.txt`; on a production db it deletes the file
and the endpoint is off. (The shutdown endpoint uses the same password-file pattern.)

**`target: "server"`** runs the JS in the server process. It is **loopback-only**:
refused unless the peer is `127.0.0.1`/`::1` and no forwarding header
(`x-forwarded-for` / `forwarded` / `x-real-ip`) is present — behind a reverse proxy
every peer is loopback, so the forwarding-header check keeps it off the public net.
The code runs via `evalServer(js)`, which apps **override** so the eval sees the
app's own lexical scope: rabid's override exposes `rabid`, `security`, etc., all
under a `security.runSystem` context. The result is passed through `serializeValue`.

```
# server target: query the db
curl -s -X POST localhost:9000/eval -H 'content-type: application/json' \
  -d "{\"password\":\"$(cat rabid-eval-password.txt)\",\"target\":\"server\",
       \"js\":\"return rabid.service.servicesForEvent.all({event_id:442}).length;\"}"
```

**`target: "browser"`** runs the JS in the current browser test client via
`evalInBrowser` (below).


## `evalInBrowser(js)`

`app.evalInBrowser(js, {timeoutMs})` pushes a command onto the browser agent's poll
loop and awaits its structured-cloned result. It always targets the **most-recent**
opt-in (deterministic — never an older, silent client). Throws if no client has
opted in, on a remote error, or on timeout. This is the primitive the named browser
test runs use, and what `/eval target:browser` calls.

Server-side test code awaits each `evalInBrowser` before the next: **at most one
command is in flight per client**. The transient plumbing (a parked long-poll + a
pending-result promise, keyed by `session_token`) lives in `browser-agent.ts`; it
holds no identity and is simply empty after a server restart (the browser re-parks
a poll and carries on).


## The browser test client

A logged-in browser (with `testing` permission, non-production db) becomes the test
client by opting in. The agent (`resources/test-agent.js`) then:

1. POSTs `testClientOptIn` → this session becomes the most-recent client (older
   clients are told `{stale:true}` on their next poll and stop).
2. long-polls `testClientPoll` for a command (a chunk of JS),
3. runs it as an async function body, `serialize`s the value (JSON-safe tagging of
   `undefined`, `NaN`/`Infinity`, `bigint`, DOM nodes, cycles, …), and POSTs it back
   via `testClientResult`. A lost result POST re-delivers the cached envelope on the
   next poll — never re-runs — so an edit→rerun loop survives a server restart.

**Identity is durable, the channel is transient.** Which session is "the" client
lives on the login-session row (`last_test_client_opt_in` / `last_test_client_heartbeat`,
stamped by opt-in and each poll); `mostRecentTestClient()` reads it. The in-flight
command/poll live only in memory (`browser-agent.ts`). So the client survives server
restarts (the agent reconnects) and the answer to "who runs" is deterministic.

### Runs on ANY page (not just the test-client page)

`GET /rabid.testClientPage()` is the explicit opt-in + status/landing page, but the
agent is **injected site-wide**: the page template adds it on every full page load
for a `testing` viewer on a non-production db (`coercePageResult` passes `testAgent:
testClientRoutes()`, rendered by `pageTemplate`). It sits **outside `#content`**, so a
boosted navigation (which swaps only `#content`) leaves it running — the same agent
keeps polling as you move between pages, so `evalInBrowser` drives **whatever page
you are viewing**. `test-agent.js` guards against double-start (`window.__liminalTestAgentStarted`)
so the page's own injection and the global one don't both spin up a loop; a full
page load makes a fresh window and re-opts-in.

Practically: navigate the browser with `location.href='/rabid.event.detailPage(N)'`
(a full load) via one `evalInBrowser`, then eval against that page.

### Named browser test runs

`runBrowserTests(name)` runs a named suite (`TEST_RUNS[name]`, default `demo`) by
driving the client through `evalInBrowser`; the test-client page's "Run demo tests"
button hits it and renders the summary.


## Gating (both pieces)

- **Non-production db only.** `assertHarnessEnabled` throws on a production db; the
  eval password file only exists on a non-production db.
- **`testing` permission.** `assertTestingRole` gates every test-client route; the
  page template only injects the agent for a `testing` viewer.
- `/eval` additionally requires the password; `target:server` is loopback-only.

Not a new capability surface for an attacker: the server already authors and ships
the JS a page runs; this just makes that scriptable, under the two gates above.


## File map

- `liminal/liminal.ts` — `evalEndpoint` / `evalServer` / `serializeValue`;
  `evalInBrowser`; `testClientOptIn` / `testClientPoll` / `testClientResult` /
  `testClientRoutes` / `testClientPage`; `mostRecentTestClient` + the stamp hooks.
- `liminal/browser-agent.ts` — `BrowserAgentChannel` (the transient poll/result plumbing).
- `resources/test-agent.js` — the browser-side agent (opt-in, poll, run, serialize; idempotent).
- `rabid/templates.ts` (`PageContent.testAgent` + injection) and `rabid/rabid.ts`
  (`coercePageResult`, `evalServer` override, `resolveSecurityContext`, the
  session-row stamp hooks) — the app-side wiring.
