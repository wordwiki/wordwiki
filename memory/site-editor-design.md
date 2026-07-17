---
name: site-editor-design
description: "Google-Sites-like site editor shared by rabid+wordwiki; settled on block-kind REGISTRY (one block table + FieldSet-over-JSON), not table-per-block"
metadata: 
  node_type: memory
  type: project
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

Major feature: a simple, per-site-tailored site editor (NOT a generic Google Sites competitor),
needed by both rabid (redraccoon.org, replacing google sites) and wordwiki (Migmaq authors' content
pages, currently embedded in .ts). Doc of record: repo-root **site-editor.md**.

BUILD STATUS (2026-07-17): foundation + render + edit BUILT & wired into rabid (26 tests, rabid suite
298/0). Files: liminal/table.ts (FieldSet.hydrate/defaults/assertHydratable); components/
{block-registry.ts, site.ts (Site/Page/Block tables), block-kinds.ts (title/divider/text/toc),
site-view.ts (SiteView: render+edit dispatch, protected renderPageChrome + canEditSite hooks)};
rabid/rabid-site.ts (RabidSiteView: host/admin canEditSite+canAdminSites + `rabid-upcoming-events`
app block + pageNavProps→templates.pageLinkProps) + mounted on Rabid as site/sitePage/block/siteView.
Route prefix self-resolves via `this.toString()` (the @path stamp) — components never hardcode
`rabid.`. GOTCHA: SiteView is NOT a Table, so it needs its OWN `toString(){return serializeAny(this)}`
(else `${this}` in emitted route exprs = '[object Object]'); tests that construct a SiteView must
`setSerialized(view,'siteView')` or `${this}` throws. AUTHORING UI built (2026-07-17): SiteView.renderAuthoringHome/renderSiteIndex/
renderPageEditor/renderEditorHeader + createSite/createPage/deletePage/editPageSettings (settings
reuse PageTable.renderEditForm→saveForm); reachable at rabid `/site` (index) + `/site({page:N})`
(editor), navbar "Site" link (host/admin). Test note: invoke() needs the arg placeholder in the
expr — `invoke('rabid.siteView.createSite($arg0)', {..})`, NOT a bare path.
BRAND CHROME built (2026-07-17): RabidSiteView.renderPageChrome = RRBR public presentation
(masthead+hero+nav[published+nav_visible, active]+footer, `.rrbr-site-*` CSS); renderPublicPage =
STANDALONE branded document (own <head>+brand css, served full-doc not app-shell), reachable via
editor "View published →" link + renderPublicHome. PUBLIC/SLUG SERVING built (2026-07-17): `/p/<slug>` serves PUBLISHED pages ANONYMOUSLY. Rabid
overrides routeExprFromPath to rewrite `/p/<slug>`→`rabid.renderPublicSite("<slug>")` — the SINGLE
audited publicRoute entry on the app object (route_security_test golden list), which delegates
INTERNALLY to siteView.renderPublicBySlug (internal call bypasses siteView's authenticated gate). Only
published pages resolve (drafts 404 publicly; staff preview drafts via authenticated
renderPublicPage(id)). Empty slug=/p/=home (first published+nav_visible). Nav uses pretty /p/<slug>.
Pattern worth reusing: expose ONE publicRoute method on the app that internally calls
authenticated-gated objects, rather than relaxing an object getter's gate (keeps the tripwire audit
complete). image-and-text block BUILT (2026-07-17) as an APP-REGISTERED block (rabid-site.ts, not a components
built-in): payload ImageField('image','rabid.photo') → the block editor's file picker uploads through
rabid's photo store via ImageField.renderInput (self-contained: hidden path field + file input whose
onchange calls lmPhotoFieldChange); render frames via rabid.photo.aspectImg + markdownToMarkup;
image_side left/right, responsive stack. Pattern: any photo/app-coupled block is app-registered, so
components stays photo-agnostic (no injection hook needed - the block kind IS the injection).
Page reorder/move UI also DONE (per-page ☰: move up/down by nav_order, delete cascades to blocks).
EDIT-ON-THE-BRANDED-VIEW (2026-07-17, dz's preferred model): `/site` opens the BRANDED editor (same
rrbr chrome as the public view, in edit mode), NOT the old ugly shell. Rendered as a CHROMELESS full
page — `templates.page(title, renderPage(id,true), {noNavbar:true})` → new `noNavbar` flag threaded
Page→coercePageResult→pageTemplate omits the rabid navbar — so the branded doc owns the top yet still
gets htmx/modal-skeleton/liminal-scripts/live-poller (editing needs them; the anon /p/ published doc
uses the minimal publicDocument instead). Edit-mode chrome: masthead + an edit toolbar (Published
badge, Settings, Publish/Unpublish toggle=togglePublished, New page, Preview→, All pages, ←App) + nav
TABS (link to /site({page:N}) editors, drafts marked •) — the tabs replace most page-list use. Top is
a live fragment (renderEditTop) on siteShapeKey so publish/new/delete refresh it. Entry renderEditEntry(q):
?page→editor, ?list→page list, else single-site→first page's editor (skip list), multi/0→list.
Brand name = 'Red Raccoon Bike Rescue' (RabidSiteView.BRAND); RRBR has exactly ONE site. Verified in
puppeteer: /site → branded editor, click-to-edit modal works (scripts loaded via noNavbar template).
NOT yet built: gallery.ts move into components, wordwiki wiring, static-site generator.

Lives in a NEW **`components`** package (liminal < components < app; gallery.ts moves there). Apps
never imported by components — they push behavior IN, same as [[page-editor-book-generic]]'s
`addPageEditorLinkProvider`.

Key decision (dz + me, 2026-07-17): blocks use a **block-kind registry**, not a table per block kind.
- ONE `block` table: `{page_id, order_key, kind, payload(JsonField)}`. Three tables total
  (Site, Page, Block); the old typed `BlockFlow`+`*Block`+`*Box` tables all collapse in.
- **PageFragment DROPPED** (2026-07-17): no header/footer/template fragments. Just Pages + per-page
  config columns (page_title, slug, hero_image, nav_order, nav_visible, published). A page's CHROME
  (header/nav/footer) is an **app-subclassed `renderPageChrome(page, body, ctx)` hook** ("more power
  than CSS") — because the real requirement (different hero image PER page) fought the shared-fragment
  model, and chrome is the most site-specific, logic-heavy part. Shared author-editable header/footer
  content goes via site-settings fields or an embedded app block, NOT the block flow.
- **One-off block kinds are a first-class strategy**: when generic blocks can't express a layout, the
  programmer writes a bespoke block kind for that one site (cheap: schema+render, no table). This is
  the pressure valve that keeps the generic core small — bespoke-but-cheap beats generic-but-unbounded.
  Discipline: keep user-tweakable bits in the payload schema, only layout in render.
- A `BlockKind = {kind, label, schema: FieldSet, render(payload, ctx)}` registered into a Map.
  Each kind still carries a real liminal FieldSet (payload validated + auto-edited via shared
  list/form machinery) — schema-first WITHOUT a physical table. Reusing FieldSet was the win over
  table-editing reuse: the LIST machinery is reused too.
- **Central goal being optimized: adding a site-specific block is cheap** — a payload schema + a
  render fn, no table, no bespoke editor. A custom block = a parameterized function call into the
  host (dictionary-search, rabid-hours, rabid-bike-sales, game embed). This cheapness is WHY the
  registry beat table-per-block for us.
- **FLATNESS RULE** (enforced, not structural): blocks are a flat ordered list; layout blocks are
  LEAF blocks with a fixed small number of typed slots; no payload may contain child blocks.
  Recursion deliberately excluded. The schema-over-JSON model makes recursion *possible* (a pure-SQL
  model didn't), so it must be a stated rule.
- render is `f(payload, ctx)`, no ambient request state → same path feeds the static-site generator
  headlessly. Liveness reuses gallery.ts's composite-owner two-key scheme (page shape key + block row
  key). Deferred on purpose: templates/one-per-row fragments, `{{name}}` macros, header/footer
  multiplicity.

Payload schema migration (DECIDED 2026-07-17; in site-editor.md "Payload schema migration"):
- Default **hydrate-on-read**: new lenient `FieldSet.hydrate(payload)` (distinct from `normalize`,
  which rejects unknowns) fills absent field→default, drops unknown keys, coerces. Every read =
  `JsonField.parse → schema.hydrate`. Makes add-field / remove-field free, no migration, no store touch.
- **Register-time guard**: registerBlockKind requires every field nullable-or-defaulted → hydrate is total.
- **Escape hatch for rename/retype** (hydrate only fills ABSENT fields, won't fix present-but-stale):
  optional per-kind `payloadVersion` + `migratePayload(p, from)` chain, applied on read BEFORE hydrate.
- **No eager batch migration** (would version-churn every block in the versioned Table DML). Lazy
  drift reconciled by write-back-on-touch and/or an optional `canonicalize` command. Align hydrate
  with the existing [[versioned-db-validation]] repair-on-load pattern.
