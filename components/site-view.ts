// The site renderer: turns a Page's block flow into markup, wrapped in the app's
// chrome.  A coordinator over the three schema tables (site.ts), app-subclassed for
// chrome (site-editor.md "Page chrome is app-subclassed").  The hosting app mounts a
// subclass that overrides renderPageChrome (brand header, nav, footer) and supplies
// the edit-permission policy (added with the edit dispatch).
//
// Importing this module registers the built-in block kinds (via block-kinds.ts).

import { h, type Markup } from "../liminal/markup.ts";
import { liveReloadableProps } from "../liminal/table.ts";
import * as action from "../liminal/action.ts";
import * as dirty from "../liminal/dirty.ts";
import * as orderkey from "../liminal/orderkey.ts";
import { route, routeMutation, authenticated } from "../liminal/security.ts";
import { blockKind, allBlockKinds, readPayload, writePayload,
         type BlockCtx, type Heading } from "./block-registry.ts";
import { slugify } from "./block-kinds.ts";
import "./block-kinds.ts";
import type { Page, SiteTable, PageTable, BlockTable, Block } from "./site.ts";

export class SiteView {
    constructor(
        public siteTable: SiteTable,
        public pageTable: PageTable,
        public blockTable: BlockTable,
    ) {}

    // Render a page: its block flow, wrapped in the app chrome.  `editing` selects
    // the read/output path (published site + static generator) vs the editable path
    // (per-block ☰ controls + an add-block menu, the whole flow live on the page
    // shape key so add/move/delete refresh it).
    @route(authenticated)
    renderPage(page_id: number, editing = false): Markup {
        const page = this.pageTable.getById(page_id);
        const ctx: BlockCtx = {site_id: page.site_id, dict: {}, editing, headings: undefined};
        return this.renderPageChrome(page, this.renderBlockFlow(page_id, editing), ctx);
    }

    // The block flow WITHOUT chrome: the read/output flow, or (editing) the live,
    // page-shape-keyed flow with per-block controls and an add-block menu.  The
    // published-page renderer wraps this in app chrome; the authoring editor wraps
    // it in the editor shell instead.
    @route(authenticated)
    renderBlockFlow(page_id: number, editing = false): Markup {
        const page = this.pageTable.getById(page_id);
        const blocks = this.blockTable.forPage.all({page_id});
        const ctx: BlockCtx = {
            site_id: page.site_id, dict: {}, editing,
            headings: this.collectHeadings(blocks),
        };
        const rendered = blocks.map(b =>
            editing ? this.wrapForEdit(b, this.renderBlock(b, ctx)) : this.renderBlock(b, ctx));
        if(!editing)
            return [h.div, {class: 'site-page'}, rendered];
        const props = liveReloadableProps([this.blockTable.pageShapeKey(page_id)],
            `${this}.renderBlockFlow(${page_id}, true)`);
        return [h.div, {...props, class: props.class + ' site-page site-page-editing'},
            rendered, this.renderAddBlockMenu(page_id)];
    }

    // One block: dispatch to its kind.  A kind absent from the registry (e.g. a
    // rabid-only block rendered under wordwiki) is skipped in output, flagged in edit.
    renderBlock(b: Block, ctx: BlockCtx): Markup {
        const k = blockKind(b.kind);
        if(!k)
            return ctx.editing
                ? [h.div, {class: 'site-block-unknown'}, `Unknown block: ${b.kind}`]
                : '';
        return k.render(readPayload(k, b.payload), ctx);
    }

    // The page's headings in order, from every block whose kind defines heading().
    private collectHeadings(blocks: Block[]): Heading[] {
        const out: Heading[] = [];
        for(const b of blocks) {
            const k = blockKind(b.kind);
            if(k?.heading) {
                const hd = k.heading(readPayload(k, b.payload));
                if(hd) out.push({...hd, anchor: slugify(hd.text)});
            }
        }
        return out;
    }

    // The app-subclassed frame.  Default: page title + body.  A hosting app overrides
    // this to render its brand header (page.hero_image + page.page_title), nav (from
    // this.pageTable.forSite), and footer.  This is "more power than CSS".
    protected renderPageChrome(page: Page, body: Markup, _ctx: BlockCtx): Markup {
        return [h.div, {class: 'site-page-outer'},
            page.page_title ? [h.h1, {class: 'site-page-title'}, page.page_title] : undefined,
            body];
    }

    // ------------------------------------------------------------------------
    // --- Edit dispatch -------------------------------------------------------
    // ------------------------------------------------------------------------

    // The injected site-edit policy.  Default DENIES - the hosting app subclass
    // (the same one that provides chrome) overrides this with its own rule (e.g.
    // host-or-admin).  Mutations gate on it AFTER the generic `authenticated`
    // coarse route gate, so an app role never leaks into components.
    protected canEditSite(_site_id: number): boolean { return false; }

    private assertCanEditPage(page_id: number): void {
        if(!this.canEditSite(this.pageTable.getById(page_id).site_id))
            throw new Error('Not permitted to edit this site');
    }

    // One editable block: a live fragment on its ROW key (an in-place payload edit
    // refreshes just this block) carrying a ☰ of edit / move / delete.
    private wrapForEdit(b: Block, rendered: Markup): Markup {
        const id = b.block_id;
        const props = liveReloadableProps([this.blockTable.rowKey(id)], `${this}.renderBlockCard(${id})`);
        const menu = action.actionMenu([
            {label: 'Edit…',    mode: {kind: 'modal', dialogUrl: `/${this}.renderBlockEditForm(${id})`}},
            {label: 'Move up',   mode: {kind: 'immediate', expr: `${this}.moveBlockUp(${id})`}},
            {label: 'Move down', mode: {kind: 'immediate', expr: `${this}.moveBlockDown(${id})`}},
            {label: 'Delete',    mode: {kind: 'confirm', message: 'Delete this block?', expr: `${this}.deleteBlock(${id})`}},
        ], {ariaLabel: 'Block actions'});
        return [h.div, {...props, class: props.class + ' site-block-edit', 'data-testid': `block-${id}`},
            rendered, [h.div, {class: 'site-block-controls'}, menu]];
    }

    // The row-key reload target for a single editable block.
    @route(authenticated)
    renderBlockCard(block_id: number): Markup {
        const b = this.blockTable.getById(block_id);
        const ctx: BlockCtx = {site_id: this.pageTable.getById(b.page_id).site_id, dict: {}, editing: true,
            headings: this.collectHeadings(this.blockTable.forPage.all({page_id: b.page_id}))};
        return this.wrapForEdit(b, this.renderBlock(b, ctx));
    }

    // The add-block picker: every registered kind, content kinds before app kinds.
    private renderAddBlockMenu(page_id: number): Markup {
        const kinds = allBlockKinds().slice().sort((a, b) =>
            (a.category === 'app' ? 1 : 0) - (b.category === 'app' ? 1 : 0));
        const items: action.ActionMenuItem[] = kinds.map(k =>
            ({label: k.label, mode: {kind: 'immediate', expr: `${this}.addBlock(${page_id}, '${k.kind}')`}}));
        return action.actionMenu(items, {ariaLabel: 'Add block'});
    }

    // The payload editor: a param form over the kind's schema, prefilled with the
    // hydrated payload, submitting the whole posted state back to editBlockPayload.
    @route(authenticated)
    renderBlockEditForm(block_id: number): Markup {
        const b = this.blockTable.getById(block_id);
        this.assertCanEditPage(b.page_id);
        const k = blockKind(b.kind);
        if(!k) throw new Error(`Unknown block kind ${b.kind}`);
        return action.renderParamForm(k.schema.fields, readPayload(k, b.payload), {
            title: `Edit ${k.label}`,
            submitLabel: 'Save',
            hidden: {block_id},
            dispatch: {onsubmit:
                `event.preventDefault(); tx\`${this}.editBlockPayload(\${getFormJSON(event.target)})\``},
        });
    }

    private reloadPage(page_id: number): Markup {
        const key = this.blockTable.pageShapeKey(page_id);
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }
    private reloadBlock(block_id: number): Markup {
        const key = this.blockTable.rowKey(block_id);
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }

    @routeMutation(authenticated)
    addBlock(page_id: number, kind: string): Markup {
        this.assertCanEditPage(page_id);
        const k = blockKind(kind);
        if(!k) throw new Error(`Unknown block kind ${kind}`);
        this.blockTable.insert({page_id, kind, payload: writePayload(k, k.schema.defaults())});
        return this.reloadPage(page_id);
    }

    @routeMutation(authenticated)
    editBlockPayload(args: Record<string, any>): Markup {
        const block_id = Number(args?.block_id);
        const b = this.blockTable.getById(block_id);
        this.assertCanEditPage(b.page_id);
        const k = blockKind(b.kind);
        if(!k) throw new Error(`Unknown block kind ${b.kind}`);
        // A param form posts the whole current state (no before-* snapshots), so the
        // posted values ARE the new payload; block_id is not a schema field and is
        // ignored by parseFormValues.
        const payload = k.schema.parseFormValues(args);
        this.blockTable.updateNamedFields(block_id, ['payload'], {payload: writePayload(k, payload)});
        return this.reloadBlock(block_id);
    }

    @routeMutation(authenticated)
    moveBlockUp(block_id: number): Markup { return this.moveBlock(block_id, -1); }
    @routeMutation(authenticated)
    moveBlockDown(block_id: number): Markup { return this.moveBlock(block_id, +1); }
    private moveBlock(block_id: number, dir: -1 | 1): Markup {
        const b = this.blockTable.getById(block_id);
        this.assertCanEditPage(b.page_id);
        const sibs = this.blockTable.forPage.all({page_id: b.page_id});
        const i = sibs.findIndex(s => s.block_id === block_id);
        const j = i + dir;
        if(i >= 0 && j >= 0 && j < sibs.length) {
            const order_key = dir < 0
                ? orderkey.between(sibs[j - 1]?.order_key, sibs[j].order_key)
                : orderkey.between(sibs[j].order_key, sibs[j + 1]?.order_key);
            this.blockTable.update(block_id, {order_key} as Partial<Block>);
        }
        return this.reloadPage(b.page_id);
    }

    @routeMutation(authenticated)
    deleteBlock(block_id: number): Markup {
        const b = this.blockTable.getById(block_id);
        this.assertCanEditPage(b.page_id);
        this.blockTable.delete(block_id);
        return this.reloadPage(b.page_id);
    }

    // ------------------------------------------------------------------------
    // --- Authoring UI (site index + page editor) -----------------------------
    // ------------------------------------------------------------------------

    // The app page-map route this authoring UI is mounted at (so index/editor can
    // link to each other), and the nav attrs for those links.  Defaults suit an app
    // that mounts it at /site with a plain full-page swap; an app with an htmx
    // content shell overrides pageNavProps to swap just its content region.
    protected authoringBaseUrl(): string { return '/site'; }
    protected pageNavProps(href: string): Record<string, string> { return {href}; }

    // Site/page creation + deletion policy (default DENY; app overrides).  Distinct
    // from canEditSite (block edits) so an app can, if it wants, let more people edit
    // a page's blocks than create/delete whole pages.
    protected canAdminSites(): boolean { return false; }
    private assertCanAdminSites(): void {
        if(!this.canAdminSites()) throw new Error('Not permitted to manage sites');
    }

    private editorHref(page_id: number): string { return `${this.authoringBaseUrl()}({page:${page_id}})`; }

    // The authoring entry point (an app page-map route delegates here): a page's
    // editor when given ?page, else the site index.
    @route(authenticated)
    renderAuthoringHome(q?: Record<string, any>): Markup {
        const page_id = q && q.page != null ? Number(q.page) : undefined;
        return page_id ? this.renderPageEditor(page_id) : this.renderSiteIndex();
    }

    // The index: every site and its pages, with create affordances (host/admin).
    @route(authenticated)
    renderSiteIndex(): Markup {
        const sites = this.siteTable.listAll.all({});
        const canAdmin = this.canAdminSites();
        const props = liveReloadableProps([this.siteTable.listShapeKey()], `${this}.renderSiteIndex()`);
        return [h.div, {...props, class: props.class + ' container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, 'Site'],
             canAdmin ? action.actionButton('New site…',
                 {kind: 'modal', dialogUrl: `/${this}.newSiteDialog()`},
                 'btn btn-sm btn-outline-primary', {'aria-label': 'New site'}) : undefined],
            sites.length
                ? sites.map(s => this.renderSitePages(s.site_id))
                : [h.p, {class: 'text-muted'}, 'No sites yet.']];
    }

    // One site's page list (its own reloadable fragment - a page add/delete reloads
    // just this site's list).
    @route(authenticated)
    renderSitePages(site_id: number): Markup {
        const site = this.siteTable.getById(site_id);
        const pages = this.pageTable.forSite.all({site_id});
        const canAdmin = this.canAdminSites();
        const props = liveReloadableProps([this.pageTable.siteShapeKey(site_id)], `${this}.renderSitePages(${site_id})`);
        return [h.div, {...props, class: props.class + ' mb-4'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-1'},
             [h.h3, {class: 'h5 mb-0'}, site.site_title || 'Untitled site'],
             canAdmin ? action.actionButton('New page…',
                 {kind: 'modal', dialogUrl: `/${this}.newPageDialog(${site_id})`},
                 'btn btn-sm btn-outline-secondary', {'aria-label': 'New page'}) : undefined],
            [h.ul, {class: 'list-unstyled ms-2'},
             pages.length
                 ? pages.map(p => [h.li, {class: 'py-1', 'data-testid': `page-row-${p.page_id}`},
                     [h.a, {...this.pageNavProps(this.editorHref(p.page_id))}, p.page_title || '(untitled page)'],
                     p.published ? undefined : [h.span, {class: 'badge text-bg-secondary ms-2'}, 'Draft']])
                 : [h.li, {class: 'text-muted'}, 'No pages yet.']]];
    }

    // The page editor shell: a back link, the page header (title + settings), and the
    // editable block flow.  (This is the editor - NOT the published page, which is
    // renderPage; the editor deliberately omits the app chrome.)
    @route(authenticated)
    renderPageEditor(page_id: number): Markup {
        const page = this.pageTable.getById(page_id);
        return [h.div, {class: 'container py-3 site-editor', 'data-testid': `page-editor-${page_id}`},
            [h.div, {class: 'mb-2'},
             [h.a, {...this.pageNavProps(this.authoringBaseUrl()), class: 'small'}, '← All pages']],
            this.renderEditorHeader(page_id),
            this.renderBlockFlow(page_id, true)];
    }

    // The editor's page header: title + publish state + a settings pencil.  Its own
    // reloadable fragment on the page row key, so a settings save refreshes it.
    @route(authenticated)
    renderEditorHeader(page_id: number): Markup {
        const page = this.pageTable.getById(page_id);
        const canAdmin = this.canAdminSites();
        const props = liveReloadableProps([this.pageTable.rowKey(page_id)], `${this}.renderEditorHeader(${page_id})`);
        return [h.div, {...props, class: props.class + ' d-flex align-items-center gap-2 mb-3'},
            [h.h2, {class: 'mb-0'}, page.page_title || '(untitled page)'],
            page.published ? [h.span, {class: 'badge text-bg-success'}, 'Published']
                           : [h.span, {class: 'badge text-bg-secondary'}, 'Draft'],
            canAdmin ? action.actionButton('Settings…',
                {kind: 'modal', dialogUrl: `/${this}.editPageSettings(${page_id})`},
                'btn btn-sm btn-outline-secondary', {'aria-label': 'Page settings'}) : undefined];
    }

    // Page settings: the standard record edit form over the page's config fields
    // (saves via the mounted PageTable's own saveForm, which reloads this row).
    @route(authenticated)
    editPageSettings(page_id: number): Markup {
        this.assertCanAdminSites();
        const page = this.pageTable.getById(page_id);
        return this.pageTable.renderEditForm(page,
            ['page_title', 'slug', 'hero_image', 'nav_visible', 'published']);
    }

    // --- Create dialogs + mutations -----------------------------------------

    @route(authenticated)
    newSiteDialog(): Markup {
        this.assertCanAdminSites();
        return action.renderParamForm([this.siteTable.fieldsByName.site_title], {}, {
            title: 'New site', submitLabel: 'Create',
            dispatch: {onsubmit: `event.preventDefault(); tx\`${this}.createSite(\${getFormJSON(event.target)})\``},
        });
    }

    @routeMutation(authenticated)
    createSite(args: Record<string, any>): Markup {
        this.assertCanAdminSites();
        this.siteTable.insert({site_title: String(args?.site_title ?? '').trim()});
        const key = this.siteTable.listShapeKey();
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }

    @route(authenticated)
    newPageDialog(site_id: number): Markup {
        this.assertCanAdminSites();
        const f = this.pageTable.fieldsByName;
        return action.renderParamForm([f.page_title, f.slug], {}, {
            title: 'New page', submitLabel: 'Create',
            hidden: {site_id},
            dispatch: {onsubmit: `event.preventDefault(); tx\`${this}.createPage(\${getFormJSON(event.target)})\``},
        });
    }

    @routeMutation(authenticated)
    createPage(args: Record<string, any>): Markup {
        this.assertCanAdminSites();
        const site_id = Number(args?.site_id);
        this.pageTable.insert({
            site_id,
            page_title: String(args?.page_title ?? '').trim(),
            slug: String(args?.slug ?? '').trim(),
        });
        return this.reloadSitePages(site_id);
    }

    @routeMutation(authenticated)
    deletePage(page_id: number): Markup {
        this.assertCanAdminSites();
        const p = this.pageTable.getById(page_id);
        this.pageTable.delete(page_id);
        return this.reloadSitePages(p.site_id);
    }

    private reloadSitePages(site_id: number): Markup {
        const key = this.pageTable.siteShapeKey(site_id);
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }
}
