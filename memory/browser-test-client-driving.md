---
name: browser-test-client-driving
description: Drive the real browser for live client-side diagnosis via the /eval endpoint + the any-page test client
metadata: 
  node_type: memory
  type: reference
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

Live client-side diagnosis without puppeteer: the in-house **test client** + the dev **/eval** endpoint.

- The user opts a logged-in browser in as the test client (visit `/rabid.testClientPage()`; needs the `testing` permission on a non-production db). As of 2026-07-07 the agent is injected site-wide (rabid pageTemplate, outside `#content`, for a testing viewer), so it drives **any page**, not just the test-client page — navigate the browser with `location.href='/rabid.event.detailPage(N)'` (a full load restarts + re-opts-in) then eval against that page.
- Drive it over HTTP: `POST http://localhost:<port>/eval` with `{"password": <contents of rabid-eval-password.txt>, "target": "browser"|"server", "js": "<code>"}`. `target:'browser'` runs JS in the test client's browser (`evalInBrowser`, structured-clone result); `target:'server'` runs in the server process with rabid's lexical scope (`rabid`, `security`, etc.; loopback-only). The `js` is an async function body — use `return`/`await`.
- Both `/eval` and the test client are **dev-only** (disabled on a production db; the password file exists only then). The running SERVER holds the browser channel, so `/eval` must hit the live server, not a fresh `getRabid()` process.
- This is how the htmx-settle green-box bug was root-caused (trap `setAttribute`/`classList.remove`, MutationObserver, sample over time — all inside `evalInBrowser`). See [[liminal-refresh-model]].
