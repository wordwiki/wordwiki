---
name: keyboard-driven-editing
description: "keyboard editing BUILT+landed (2026-07-06) — DOM-focus stops, liminal-generic; rabid adoption intended (needs lmKbdPrimary nav-link case)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

Keyboard-driven lexeme editing landed 2026-07-06. THE docs are repo-root
keyboard-driven-editing.md (design) and liminal.md § Keyboard-driven editing
(adoption summary). Mechanism is liminal-generic (liminal-scripts.js): the
focused assertion IS DOM focus; apps stamp `lm-kbd-stop` + `tabindex=-1` +
stable `data-kbd` + `lm-act-*` menu classes. Tab/arrows traverse, Enter
edits, o/O insert, Alt+arrows move, Delete/# delete, m menu, ? help; dialogs
Ctrl+Enter submit / Esc exit (data-bs-keyboard flipped true, discard guard
intercepts); inserts return `focus:'fact-<id>'` so + lands on the new row.

**Why:** dz wants ms-word-speed editing over the ~50-records-per-lexeme
structure — mouse travel and re-find-the-row were the compounding costs.

**How to apply:** dz intends to adopt this in rabid ([[liminal-refresh-model]]
peer app). Known gap, flagged in liminal.md: rabid's navigable rows have
`a.lm-nav-link`, not `button.edit` — `lmKbdPrimary` needs that case taught.
Deferred by design: dialog prefetch-on-focus, review-mode verbs as stops.
