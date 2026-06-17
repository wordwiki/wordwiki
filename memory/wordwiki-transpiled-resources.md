---
name: wordwiki-transpiled-resources
description: wordwiki serves /resources/*.js from a transpile OUTPUT dir — stale js until transpile runs (start script now always transpiles)
metadata: 
  node_type: memory
  type: project
  originSessionId: 0fca39c7-a1e6-4240-b730-70d32e34def8
---

wordwiki has a transpile step and serves `/resources/*.js` out of the transpile **output dir**, not the source `resources/` tree — so edits to client scripts (e.g. `resources/liminal-scripts.js`) are invisible to wordwiki until transpilation reruns. rabid serves the sources directly, so the same edit shows up there immediately — a "works in rabid, broken in wordwiki" client-behaviour split is the signature of a stale transpile output.

**Why:** cost a debugging round on 2026-06-12: new `lmNavigableClick` worked in rabid but wordwiki rows wouldn't navigate — wordwiki was serving the pre-edit script copy.

**How to apply:** after changing any `resources/*.js`, rerun the transpile (see `transpile.sh`) before testing wordwiki in a browser. dz changed the wordwiki start script (2026-06-12) to always transpile on start, so a restart suffices; suspect a stale output dir before suspecting the code. See [[ui-mutation-model]] for the row-species work this surfaced in.
