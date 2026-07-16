---
name: page-editor-book-generic
description: "the page editor serves ALL reference books — app/book-specific links/markup must be INJECTED (label/href providers), never imported"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

The page editor (render-page-editor.ts) is NOT PDM-specific — it serves every
reference book (Rand, Clark, …).

**Why:** dz 2026-07-16, when I was about to link the PDM change-feed slice from
it: "the page editor is not just for PDM … whatever mechanism you propose
should not import PDM-specific stuff or markup (ie. prefer something like being
able to inject a generic menu label/link pair)".  Also structurally forced:
entry-schema.ts VALUE-imports render-page-editor.ts, so render-page-editor
importing change-feed (which imports entry-schema) would be a real init-order
cycle (the same class of bug as [[wordwiki-decomposition]]'s provider hooks).

**How to apply:** use `addPageEditorLinkProvider(key, (doc, page) => [{label,
href}])` (keyed so per-test re-registration replaces, not accumulates);
register from the WordWiki ctor next to setPageEditorAppProvider.  The
primary-book feed link ('primary-book-feed') is the exemplar.  Any future
book-specific companion goes in the same way.
