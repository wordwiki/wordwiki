This is a proposal for a major new feature - a simple site editor similar to google sites.

It is needed by both rabid and wordwiki:

- The Migmaq online authors (powered by wordwiki) want a whole wack of content pages integrated into the
  dictionary - and they should be able to create and edit these pages by themselves (presently the
  content is embedded in the .ts program).

- redraccoon.org (presently using google sites) would be much improved it was connected to rabid
  (up to date bike sales, current events lists, direct volunteer signup etc) - and having the
  site generated from the database (optionally via a static site generator) - would be a big
  improvement.

Because it is needed by both, it needs to be in a shared package.

Presently, we have been putting all shared liminal things in the liminal package.  We don't
want to put the site editor there - liminal is the layer below these sort of application level things.

So I would propose a new package 'components', gallery.ts will move there, and our new site
editor will also live there.

A site editor is a relatively straightforward application of the liminal model - the user views
the rendered page, and can use edit affordances to popup editors and apply transactions (like move up,
insert here).


## Design goals

The primary design goal is to keep this simple - it is easy to overgeneralize this kind of thing, and
it is fine to accept the corresponding limitations of expressiveness for the target sites.

This is NOT a Google Sites competitor (a generic editor for any site).  It is an editor tailored
to a specific hosting site, and it will be much more usable - and much less generic - precisely
because it is cheap to add site-specific blocks.  A site-specific block is essentially a
parameterized function call into the hosting site (a dictionary search, an opening schedule, a
bike-sale list, a game embed, ...).  So the central design win we are optimizing for is: adding a
custom block should be cheap and clean - a payload schema plus a render function, no new table and
no bespoke editor.

Pages can embed content from the site that is hosting them, so that each site (rabid, wordwiki) can
add its own site-specific content blocks (a dictionary search for wordwiki, an opening schedule or a
bike-sale list for rabid).

The design goal for the corresponding CSS is that it be as simple as possible to restyle the page
per site (wordwiki vs rabid).  This is a hard constraint, not a hope: block renderers emit
**structure + semantic classes only** (`.site-block-title`, `.site-block-image-text`), never inline
colors or spacing; palette and spacing live in a handful of CSS custom properties that a per-site
stylesheet overrides.

### FLATNESS RULE

Blocks are a FLAT, ordered list within a page fragment.  Layout blocks (image+text, two-column, ...)
are LEAF blocks with a fixed, small number of typed payload slots - no block kind's payload may
contain child blocks.  Recursion (nested containers, arbitrary-depth layout) is deliberately
excluded: it is the classic site-editor over-generalization, the target authors won't use it, and it
makes reorder/insert/delete, the liveness keys, and per-site restyling all qualitatively harder.
When real two-up / image+text layout is needed, it is a named leaf block with a hand-authored
responsive layout (which is also the only way we keep "trivially restyle per site").  Note the
schema-over-JSON payload model (below) makes recursion *possible* (a payload could hold child blocks)
in a way a pure-SQL table-per-block model did not - so flatness must be an enforced rule, not left to
the schema to prevent.


## The shape of the design

Liminal apps are primarily defined by their schema and a straightforward rendering of that schema to
HTML.  For most of our tables that means one physical table per concept.  A site editor's blocks are
the exception where that instinct works against us: a table per block kind means, for *every* kind, a
new table + a hand-written fetch + a renderer + an editor - and site-specific blocks (the thing we
most want to be cheap) would need a whole separate injection mechanism on top.

So blocks use a different, but still schema-first, arrangement: **one `block` table** carrying a
`kind` string and a JSON `payload`, plus a **registry of block kinds** in code.  Each kind still
carries a real liminal `FieldSet` (so payloads are still validated, and still auto-edited/auto-listed
through the shared field-set/list machinery) - it just isn't a physical table.  The registry is the
polymorphism table, in code, where dispatch belongs, and it serves built-in and site-injected kinds
identically.

This is the same injection pattern already used by `addPageEditorLinkProvider`
(wordwiki/render-page-editor.ts) - a startup-time registry that lets an app push behavior into a
shared component without an import cycle.

### Package dependency rule

Imports only ever go app -> components -> liminal.  Apps are never imported *by* components; they
push block kinds *in* through the registry.  This is what makes site-specific blocks work without a
cycle (and without components knowing anything about rabid or wordwiki).


## The registry (the seam)

```ts
// components/block-registry.ts
import { FieldSet } from "../liminal/table.ts";
import type { Markup } from "../liminal/markup.ts";

// Everything a block render/edit needs that is NOT ambient request state, so a
// block can render live OR inside the static generator with no "db of the moment".
export interface BlockCtx {
  site_id: number;
  dict: Record<string, string>;   // page-supplied specialization values (see macros, below)
  editing: boolean;               // show edit affordances, or produce final output
}

export interface BlockKind {
  kind: string;                       // 'title', 'rabid-hours', ...  (stored in block.kind)
  label: string;                      // menu label in the "add block" picker
  schema: FieldSet;                   // the payload's fields - drives edit form + validation
  render(payload: any, ctx: BlockCtx): Markup;
  category?: 'content' | 'app';       // for grouping the add-block menu
}

const registry = new Map<string, BlockKind>();
export function registerBlockKind(k: BlockKind): void {
  if (registry.has(k.kind)) throw new Error(`duplicate block kind ${k.kind}`);
  registry.set(k.kind, k);
}
export function blockKind(kind: string): BlockKind | undefined { return registry.get(kind); }
export function allBlockKinds(): BlockKind[] { return [...registry.values()]; }
```


## Schema (three tables)

```ts
// Site level (a site contains page fragments)
interface Site {
  site_id: number;
  site_title: string;
}

export const page_fragment_kind: Record<string, string> = {
    'page':     'Page',
    'header':   'Page Header',
    'footer':   'Page Footer',
    'template': 'Template',
};

// PageFragment rather than Page because we reuse the full page mechanism for:
//  - headers and footers (for now it can be an error to create more than one of each);
//  - template fragments (a page specialized by a supplied dict - see "Deferred", below).
// When a fragment is rendered it is handed a dict (BlockCtx.dict) that can specialize
// templates (including a page-head template).
interface PageFragment {
  page_fragment_id: number;
  site_id: number;
  page_title: string;
  fragment_kind: string;   // page_fragment_kind
  fragment_name: string;   // hint for template binding (not yet rich enough)
  slug: string;            // URL path
  nav_order: string;       // order_key for header navigation
  published: number;       // boolnum: draft vs live
}

// One flat, ordered list of blocks per page fragment.  BlockFlow and every per-kind
// block/box table from earlier drafts collapse into this single table; the block's
// typed value lives in `payload`, shaped by blockKind(kind).schema.
interface Block {
  block_id: number;
  page_fragment_id: number;
  order_key: string;
  kind: string;    // registry key: 'title', 'divider', 'rabid-hours', ...
  payload: string; // JSON
}
```

As liminal `Table` declarations:

```ts
class BlockTable extends Table<Block> {
  constructor() { super('block', [
    new ForeignKeyField('page_fragment_id', 'page_fragment', 'page_fragment_id',
                        {edit: security.never}),
    new OrderKeyField('order_key'),
    new StringField('kind', {edit: security.never}),
    new JsonField('payload'),
  ]); }
}
```

The photo/text "boxes" of earlier drafts become **fields inside a payload**, not tables.  A shared
`renderPhoto(payload.photo, ctx)` helper gives the gallery-framing reuse the box level was after -
code reuse, no FK hop.


## A kind is a FieldSet + a render fn

Built-in kinds are registered by components at import.  Each carries a real FieldSet, so its payload
is validated and auto-editable - it simply isn't a physical table.

```ts
// components/block-kinds.ts
export const title_level: Record<string, string> = { 'h1':'h1','h2':'h2','h3':'h3','h4':'h4' };

registerBlockKind({
  kind: 'title', label: 'Title', category: 'content',
  schema: new FieldSet('title', [
    new EnumField('level', title_level, {default: 'h2'}),
    new StringField('text', {prompt: 'Heading'}),
  ]),
  render: (p, _ctx) => [p.level ?? 'h2', {class: 'site-block-title'}, p.text ?? ''],
});

registerBlockKind({
  kind: 'divider', label: 'Divider', category: 'content',
  schema: new FieldSet('divider', []),
  render: () => ['hr', {class: 'site-block-divider'}],
});

registerBlockKind({
  kind: 'image-and-text', label: 'Image + text', category: 'content',
  schema: new FieldSet('image-and-text', [
    new StringField('photo', {edit: security.never}), // storage path, set via a gallery-style editor
    new StringField('text',  {prompt: 'Text (markdown)'}),
  ]),
  render: (p, ctx) =>
    ['div', {class: 'site-block-image-text'},
      renderPhoto(p.photo, ctx),
      ['div', {class: 'site-block-prose'}, renderMarkdown(p.text ?? '')]],
});
```

A table-of-contents block renders from the `title` blocks on the page (their text + level nesting) -
it reads the sibling block list from `ctx`, staying within the flatness rule.

Site-injected kinds are **identical in shape** - registered from the app instead of components, and
free to reach the app's own DB inside `render` (this is the whole point: a custom block is a
parameterized function call into the hosting site):

```ts
// rabid startup
registerBlockKind({
  kind: 'rabid-hours', label: 'Opening hours', category: 'app',
  schema: new FieldSet('rabid-hours', []),
  render: (_p, _ctx) => renderOpeningSchedule(),
});
registerBlockKind({
  kind: 'rabid-bike-sales', label: 'Bikes for sale', category: 'app',
  schema: new FieldSet('rabid-bike-sales', [ new EnumField('status', bike_sale_status) ]),
  render: (p, _ctx) => renderBikeSaleList(p.status),
});

// wordwiki startup
registerBlockKind({
  kind: 'dictionary-search', label: 'Dictionary search', category: 'app',
  schema: new FieldSet('dictionary-search', [ new StringField('orthography') ]),
  render: (p, _ctx) => renderDictionarySearch(p.orthography),
});
```

Note `rabid-bike-sales` **is** the "one entry per bicycle for sale" need - solved as a live-DB block,
not a page-template engine.


## Render dispatch (page render is a pure fn of rows + registry + ctx)

```ts
renderPage(page_fragment_id: number, ctx: BlockCtx): Markup {
  const blocks = db().all<Block>(
    `SELECT * FROM block WHERE page_fragment_id=:id ORDER BY order_key`,
    {id: page_fragment_id});

  const body = blocks.map(b => {
    const kind = blockKind(b.kind);
    const payload = JsonField.parse(b.payload, {});
    if (!kind)   // e.g. wordwiki rendering a page that used a rabid-only block
      return ctx.editing ? ['div', {class:'site-block-unknown'}, `Unknown block: ${b.kind}`] : '';
    const rendered = kind.render(payload, ctx);
    return ctx.editing ? this.wrapForEdit(b, rendered) : rendered;
  });

  return ctx.editing
    ? ['div', liveReloadableProps([this.pageShapeKey(page_fragment_id)],
                                  `components.site.renderPage(${page_fragment_id}, ...)`),
       body, this.renderAddBlockMenu(page_fragment_id)]
    : ['div', {class: 'site-page'}, body];
}
```

Because `render` only ever touches `payload` + `ctx` (never ambient request state), the **same code
path** feeds the static-site generator - `editing:false`, no live wrapper.  The headless requirement
for the static generator falls out for free; a site-injected block just has to render from the `ctx`
it is handed, not from a live request.


## Edit dispatch (mutations on ONE table; the form is the kind's FieldSet)

All per-block-table CRUD collapses to a handful of mutations on `block`, and the payload editor is
the kind's `FieldSet.renderForm` - no bespoke editor per kind.

```ts
@routeMutation(hostOrAdmin)
addBlock(page_fragment_id: number, kind: string, after_order_key: string) {
  const k = blockKind(kind) ?? panic(`unknown kind ${kind}`);
  this.insert({page_fragment_id, kind,
               order_key: orderKeyAfter(after_order_key),
               payload: JsonField.format(k.schema.defaults())});
  return this.reloadPage(page_fragment_id);
}

@routeMutation(hostOrAdmin)
editBlockPayload(block_id: number, form: Record<string,string>) {
  const b = this.getById(block_id);
  const k = blockKind(b.kind) ?? panic();
  const changes = k.schema.parseFormChanges(form);            // existing FieldSet method
  const merged  = {...JsonField.parse(b.payload, {}), ...changes};
  this.updateNamedFields(block_id, ['payload'], {payload: JsonField.format(merged)});
  return this.reloadBlock(block_id);
}

@routeMutation(hostOrAdmin) moveBlockUp(block_id) { /* reorder order_key */ return this.reloadPage(pid); }
@routeMutation(hostOrAdmin) deleteBlock(block_id) { this.update(block_id, {deleted:1}); return this.reloadPage(pid); }
```

The "edit this block" affordance is the standard modal-of-arguments: `hx-get` the kind's form into
`#modalEditorBody` - identical wiring to `editButtonProps`, with the payload FieldSet standing in for
a table's own fields.  The "add block" menu is `action.actionMenu` over `allBlockKinds()`, grouped by
`category` (content blocks vs this site's app blocks).


## Liveness keys (lift gallery's scheme, don't rediscover it)

A block's owner is composite (page + order position) and blocks reorder, so the DML can't auto-emit -
exactly the situation `gallery.ts` documents at its top.  Reuse its two-key scheme:

- **Page shape key** `-block-page-<page_fragment_id>-shape-` on the page fragment (add / move / delete
  rebuild the ordered list) -> `liveReloadableProps` + `dirty.record` for cross-browser liveness.
- **Block row key** `this.rowKey(block_id)` for an in-place payload edit that doesn't move anything.

Since gallery.ts is moving into `components` anyway, factor the composite-owner shape-key helper out
of it and share it.


## Payload schema migration

Physical-table field adds ride the existing schema-migration process; JSON payload blobs do not, so a
block kind's FieldSet gaining/losing/changing a field must be handled here.  The decision:

**Default: hydrate-on-read.**  Give `FieldSet` a lenient `hydrate(payload)` - distinct from `normalize`
(which guards user-typed route args and *rejects* unknown keys):

- absent field -> its schema default
- unknown key -> dropped (a field that was removed from the schema)
- coerce present values through their field

Every read goes `JsonField.parse(row.payload) -> schema.hydrate(...)`.  This makes the two common
changes free with no migration and no touching the store: **add a field** (reads see the default) and
**remove a field** (stale key dropped).

**Register-time guard makes hydrate total.**  `registerBlockKind` checks that every field is nullable
*or* has a default; then `hydrate` can never fail to produce a complete value, and "non-nullable field
with a schema default" is an enforced invariant rather than a hope.

**Escape hatch for rename / retype: per-kind payload version + migrate fns.**  Hydrate only fills
*absent* fields; it never fixes a field that is present but stale, so it does NOT cover a rename (new
name reads its default, old data orphaned) or a type/enum-value change (a value that no longer
validates is left intact - render defensively, the edit form re-validates on save).  Those are true
migrations.  Extend `BlockKind` with an optional chain applied on read *before* hydrate:

```ts
interface BlockKind {
  // ...
  payloadVersion?: number;                        // current, default 0
  migratePayload?: (p: any, from: number) => any; // 0 -> 1 -> ... -> current
}
```

Store a `v` in the payload; read becomes `parse -> migrate(v -> current) -> hydrate`.  Adds stay
automatic (hydrate); only rename/retype cost the kind author a small migrate fn.

**No eager batch migration.**  A one-shot pass rewriting every `block` of a kind (the closest analog
to the existing schema-upgrade) fights the versioned Table DML: it bumps a version on *every* block,
churning the store with migration noise.  Lazy-on-read avoids that.  The cost of lazy is that stored
blobs drift from current shape (a dumped/grepped payload may be missing fields).  Reconcile that
*without* the churn via:

- **write-back-on-touch** - the hydrated (upgraded) shape persists whenever a block is next edited
  anyway, so the store converges over time with zero extra version bumps; and/or
- an optional **`canonicalize`** maintenance command that rewrites drifted payloads only when
  explicitly run (opting into the version bump deliberately).

Hydrate is essentially "repair on load" for payloads, so align it with the existing
VersionedDb validator/repair-on-load pattern rather than inventing a parallel mechanism.


## Deferred (kept out of v1 on purpose)

These are real, but each is a separate, harder feature; folding them into the v1 schema is the
overgeneralization the design goals warn against.

- **Templates / one-per-row fragments.**  `fragment_kind:'template'` and `fragment_name` are carried
  in the schema as a hint, but template *binding* (a page parameterized by a query row, iterated per
  row, with per-row URLs) is not built.  The concrete need behind it (a bike-sale listing) is served
  now by a live-DB app block (`rabid-bike-sales`), which is simpler and sufficient.
- **`{{name}}` macros everywhere text is rendered.**  A markdown `TextBox`/`image-and-text` already
  gives formatting; a second macro-expansion system is deferred.  `BlockCtx.dict` is the hook it
  would eventually use.
- **Header/footer multiplicity.**  Reusing PageFragment for header/footer is in; the "at most one
  header, one footer" guard is app logic for now, not a schema constraint.


## Design decision on file: registry vs table-per-block

The earlier draft of this doc modeled every block kind and box as its own physical table
(`BlockFlow(block_table, block_id)` + `TitleBlock`, `DividerBlock`, `ImageAndTextBlock`, `PhotoBox`,
`TextBox`, ...).  We chose the registry model instead.

| | Typed table-per-block | Registry + one `block` table (chosen) |
|---|---|---|
| Tables | ~11 (BlockFlow + blocks + boxes), grows per kind | 3, fixed |
| New block kind | table + SQL fetch + renderer + editor | one `registerBlockKind({...})` |
| Site-injected blocks | needs a separate, unspecified mechanism | same call, from the app |
| Schema-driven? | yes (physical columns) | yes (FieldSet over JSON payload) |
| Per-**field** version history | yes (versioned Table columns) | no - a block versions as a whole |
| Cross-block payload queries | easy (real columns) | awkward (`json_extract`) - but unused here |
| Static-gen / headless | must be designed in | falls out (render = f(payload, ctx)) |
| Layout "boxes" | 2 extra tables + FK hop | fields in payload + shared render helper |

The typed-table version wins where you want field-level version granularity on page copy (wordwiki's
assertion instinct) or expect to query across blocks by payload.  For per-site tailored content pages
we do neither, and the registry model is what makes the central goal - cheap, clean custom blocks -
actually cheap.
