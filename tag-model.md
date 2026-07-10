# The TAG model (né TODO)

dz (2026-07-10): TODO was a tagging model with a fixed enum of kinds; a
general tagging model was wanted anyway, and two tagging models is one too
many.  TODO is generalized into TAG, with the vocabulary in a TABLE (the
category-table pattern) - data hygiene over free-form text.

## The shape (as built)

- **`tag` vocabulary table** (tag.ts, category-shaped): slug (stable,
  create-only), name (renames freely), theme (optional grouping),
  description, `is_todo`, retired, order.  Admin page "Tag Table" (Admin
  menu), `edit-tags` grant (admin implies).  Seeds at server start.
- **ZERO data migration**: the dict relation's storage tag stays `'tdo'`,
  and the seed rows' slugs are the old enum codes
  (`Todo`, `NeedsRecording`, ...) - existing assertions are
  REINTERPRETED, never rewritten.  Only the schema NAMES changed:
  relation `todo` -> `tag`, field `details` -> `value` (JSON projection
  keys; nothing stored).
- **`is_todo` drives the todo system** (like `publishable` on the
  orthography table - a behavior flag in plain sight): the todo report,
  the word view's open-todos list, and the dock's quick-post all read
  the todo-marked subset.  Plain (non-todo) tags are classification
  only - they show in the editor, not in the todo surfaces.
- **`done`/`assigned_to` stay as columns** on the tagging relation
  (option (a) of the design discussion): uniform row shape, todo-tags
  light the workflow fields up, plain tags leave them idle.  The
  alternative - done = tag REMOVAL, with the tombstone as the record -
  stays noted as where this could go once tags are lived-in.
- **Editor**: the tag field is a table-driven select (VocabSelectField,
  same as categories/lexical forms), display names table-first.

## THE CHARTER — which label mechanism is which

Four label-shaped mechanisms exist; keep them from blurring:

- **categories** — PUBLIC classification of meaning (two-level, table)
- **tag** — INTERNAL editorial classification + workflow (this model;
  internal audience, stripped from the public bundle)
- **attr** — the keyed bag of PUBLIC word facts (`borrowed-word`);
  honestly also a tagging model - the boundary is: public facts go to
  attr/categories, editorial state goes to tag
- **status** — whole-lexeme lifecycle; load-bearing, stays out of this

New-tag rule of thumb: if the speakers group's phrase keeps recurring in
the LOG, that's the evidence it should become a table tag - free text is
the log's job, structure is the tag's job.
