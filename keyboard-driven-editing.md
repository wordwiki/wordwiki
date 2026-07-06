# Keyboard-driven lexeme editing

dz (2026-07-06): a lexeme in ms-word could be edited with nothing but keyboard
navigation.  We broke a lexeme into ~50 records for structure/versioning, and
one real cost is mouse dependence: every edit is find-row, aim, click, aim at
dialog... The server round trips are fine (fast, and txd makes most of them
one trip); the mouse travel and the re-find-the-row-after-refresh are what
compound.  Add a notion of a FOCUSED ASSERTION with keybinds: next/prev,
Enter to edit, insert-after, etc.  Mostly invisible to casual users; much
faster for power users.

## Core decision: the focused assertion IS DOM focus

No parallel "current assertion" state.  Every editable surface becomes a
genuinely focusable element, and the whole feature is:

- **`.lm-kbd-stop`** - the marker class for a keyboard stop.  The wordwiki
  editor stamps it (with `tabindex="-1"` and a stable `data-kbd` identity) on
  each tuple surface and each empty-relation slot, in the same editing hooks
  that already build those rows.  The mechanism itself lives in liminal
  (liminal-scripts.js) and is app-agnostic: any page that stamps stops gets
  keyboard editing.
- **Roving tabindex** - exactly one stop holds `tabindex="0"` (the client
  promotes the first on load; focusing any stop - by click OR keyboard -
  makes it the holder).  On page ARRIVAL (fresh load or a boosted page
  swap) the first stop is actually FOCUSED (`preventScroll`), so the
  keyboard flow starts immediately - without this, entering it needs a
  mouse click or a Tab march through the navbar (dz).  So from outside,
  the whole entry is ONE tab stop:
  a keyboard user tabbing to the navbar is not trapped behind 50 rows, and
  interior links never interleave into the page's tab order.
- **Invisible to casual users for free** - the focus ring uses
  `:focus-visible`, which browsers show for keyboard focus only.  A mouse
  user sees nothing; rows already tap-to-edit as before.
- **Bindings can never collide with typing** - the keydown handler acts only
  when the event TARGET is a stop itself.  Focus in the modal's fields, the
  search box, or a dropdown item means the handler never fires, so
  single-letter binds are safe.

Why this beats an app-level focus notion: `document.activeElement` is the
one focus the platform already synchronizes with clicks, screen readers, and
the modal's focus trap - a parallel notion would fight all three.

## Keymap (only when a stop has focus)

| key                | action                                              |
|--------------------|-----------------------------------------------------|
| Tab / ↓, S-Tab / ↑ | next / prev stop (Tab falls through at the edges)   |
| Enter              | edit (an empty slot's "edit" IS its insert-first)   |
| + or o / O         | insert after / before                               |
| Alt+↓ / Alt+↑      | move down / up                                      |
| Delete or #        | delete (lmConfirm's OK is focused - Enter confirms) |
| h                  | history dialog                                      |
| m                  | open the ☰ (Bootstrap's menu arrow-nav takes over)  |
| ?                  | keybind help sheet                                  |

The flow this buys: **Tab, Tab, Enter, type, Enter** - dialog-first-field
focus and Enter-submits already exist, so editing a gloss is four keystrokes
plus the text.

Inside the dialog itself (dz 2026-07-06): **Ctrl/Cmd+Enter** submits from
ANY field - the standard binding for where plain Enter is taken (a
textarea's Enter inserts a newline; single-line inputs and selects submit
implicitly already).  **Esc** closes the dialog - enabled by flipping the
modal skeleton's `data-bs-keyboard` (it predated a trustworthy discard
guard); the guard intercepts the hide, so a dirty form asks "Discard
changes?" (where Enter = discard, Esc = keep editing) and a clean one
closes silently.  The static backdrop stays - a stray click outside must
not close a half-filled form.

**Actions dispatch by clicking the row's own buttons.**  Every verb already
exists as a rendered element in the stop - the ☰ items carry the txd deps,
the lmConfirm gating, the dialog URLs.  The keyboard controller finds the
button by a stable class and `.click()`s it (the same delegation trick as
lmEditableClick; hidden dropdown items fire fine).  Single source of truth:
a future change to an action's deps or confirmation is automatically
keyboard-correct.  The editor stamps `lm-act-insert-before`,
`lm-act-insert-after`, `lm-act-move-up`, `lm-act-move-down`,
`lm-act-history`, `lm-act-delete` on its menu items (Edit already carries
`edit` - it is the tap-to-edit delegation target).  Enter's resolution
order: `button.edit`, else the ☰ toggle (a fields-less example row has no
Edit - Enter opens its menu), else the stop's first button (the
document-reference empty slot's per-book add).

## The real work: focus must survive swaps

Every mutation outerHTML-swaps the focused row (htmx reload path) or
`replaceWith`s it (txd speculative path), destroying the focused element and
dropping focus to `<body>` - which would kill the flow after every single
edit.  The restore convention:

- **Identity**: each stop's `data-kbd` (`fact-<id>` for rows,
  `rel-<parent>-<tag>-empty` for slots).  We do NOT reuse the dep-key
  classes - those are refresh vocabulary, and a stop's identity must survive
  key-scheme changes.
- **Track**: a `focusin` listener records the last-focused stop's
  `{key, index}` (index into the stop list, recomputed at focus time).
- **Restore** (`lmKbdAfterChurn`): after any churn - htmx `afterSettle`, the
  end of a speculative `lmApplySwap`, and the modal editor's
  `hidden.bs.modal` (Bootstrap drops focus to body ~150ms after our swaps
  when the fade ends, so the modal path must restore THEN) - if focus is
  now on `<body>`/disconnected and no modal is open, re-focus the stop with
  the recorded key, else the stop at the recorded INDEX (clamped).
- The index fallback is exactly right for **delete**: the dead row's index
  now names the row that slid into its place.  For **insert from an empty
  slot** the slot's key is gone and the index lands on the new row.  For
  **insert-after** v1 restores the anchor row (one ↓ reaches the new row);
  focusing the new row from the response's new-fact id is a deferred nicety.
- Boosted whole-page navigations clear the memory (a stale index must not
  yank focus/scroll on some other page's stops).  `.lm-read-only` contexts
  are excluded from the stop list, matching refresh participation.

## Empties and structure

Empty slots participate as stops (they already read and behave like filled
rows; Enter triggers their `+`, which carries class `edit`).  Excluded from
v1: pure-label rows with no action (the read-only recordings empty), section
headings, the changes-bar/review verbs - stops without actions just slow
traversal.  Nesting needs nothing: the stop order is `querySelectorAll`
document order.

## Deferred (deliberately)

- **Dialog prefetch on focus** (warm Enter): real but small win; adds a
  request per traversal step.  The hx-get URL is on the edit button when we
  want it.
- **Focus-the-new-row after insert** via a response focus hint.
- **Review-mode verbs and rabid list pages** adopting stops (the mechanism
  is generic; the stamps are one hook each).
- Home/End (first/last stop) if traversal length ever warrants it.

## Implementation map

- `resources/liminal-scripts.js` - the whole mechanism: roving tabindex,
  keydown dispatch, focus restore, `?` help sheet (singleton modal like
  lmConfirm).
- `resources/rabid-scripts.js` - one hook: `lmApplySwap` calls
  `lmKbdAfterChurn()` when it finishes.
- `resources/liminal.css` - `:focus-visible` ring + `scroll-margin` on
  stops.
- `wordwiki/lexeme-editor.ts` - stamps: stop attrs in `tupleSurface` /
  `emptyRelation`, `lm-act-*` classes in `editMenuItems`.
- Tests: render-level stamps in `wordwiki/keyboard-nav_test.ts`; the flow
  itself is browser-verified (focus is a DOM-runtime concern the render
  tests can't see).
