---
name: puppeteer-session-reuse
description: How to drive the rabid app with the puppeteer MCP without re-logging-in every time
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 576fa148-8a4a-46dc-9b84-a3b32f7ca4cb
---

When browser-testing the rabid app via the puppeteer MCP, pass `launchOptions` (needed here: `{headless:true, args:['--no-sandbox','--disable-setuid-sandbox']}`, with `allowDangerous:true`) **only on the first `puppeteer_navigate`**. Supplying launchOptions on a later navigate relaunches the browser with a fresh profile and wipes cookies, forcing a re-login.

**Why:** the puppeteer MCP server is long-lived and keeps one browser + cookie jar across tool calls. Reusing it preserves the login session. The rabid session also survives `./rabid.sh` restarts because it lives in the `volunteer_session` DB table, not just the cookie.

**How to apply:** first launch with launchOptions once; afterwards call `puppeteer_navigate` with just the URL. Log in once (rocky@redraccoon.org / rcky — see fake_data Rocky) and stay logged in for the rest of the session. Chrome needs `--no-sandbox` in this environment (the no-launchOptions first call fails with a sandbox FATAL). Related: [[ui-mutation-model]].
