---
name: tag-model
description: "TODO generalized into TAG: vocabulary table (category-shaped, is_todo flag drives the todo system), storage tag 'tdo' unchanged - zero data migration; doc of record repo-root tag-model.md (BUILT 2026-07-10)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

BUILT 2026-07-10 (doc of record: repo-root tag-model.md). dz: TODO was
a fixed-enum tagging model; wanted a general one, not both. Shape (my
recommendation, dz-approved): RENAME THE SCHEMA NAME ONLY - the dict
storage tag stays 'tdo' and the tag table's seed slugs ARE the old enum
codes, so existing assertions are reinterpreted, never rewritten (zero
dict migration; the best migration is one that moves nothing).

- tag.ts: TagTable (category-shaped: slug create-only, name, theme,
  description, is_todo, retired, order_key), seedTags at ensure,
  'Tag Table' admin page, edit-tags grant. todoTagSlugs()/
  tagDisplayName() helpers w/ entry-schema `todos` map as unseeded
  fallback.
- Schema: relation todo->tag ($tag 'tdo'), details->value; Entry.tag:
  Tag[] (JSON keys change at runtime only; bundles strip internal
  relations anyway). TagTag const (was TodoTag).
- is_todo drives the todo system (todoReport, word-view open-todos,
  dock postTag) - plain tags are classification only, editor-visible.
- done/assigned_to stay as relation columns (option a); done-as-
  tag-removal (tombstone = the record) noted as possible future.
- Editor: table-driven VocabSelectField for the tag field +
  vocabValueLabel display names.
- THE CHARTER (in tag-model.md + tag.ts header): categories = public
  classification; tag = internal editorial; attr = public keyed word
  facts; status = lifecycle. Recurring LOG phrases are the evidence a
  new table tag is warranted.

Relates to [[lexeme-log]], [[wordwiki-categorization]],
[[fix-orthographies]].
