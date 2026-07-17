// The site editor's schema: Site -> Page -> Block, a shared `components` feature
// used by both rabid and wordwiki.  See site-editor.md.
//
// Blocks are a FLAT, ordered list within a page (the FLATNESS RULE): one physical
// `block` table carrying a `kind` string and a JSON `payload`, dispatched through
// the block-kind registry rather than a table per block kind.  A page's chrome
// (header/nav/footer) is NOT modeled here - it is an app-subclassed render hook
// (site-editor.md "Page chrome is app-subclassed"); the page table carries only the
// per-page config that chrome reads.  This module owns the tables, ordering, and
// lookup queries; render/edit live alongside.

import { db } from "../liminal/db.ts";
import { Table, PrimaryKeyField, StringField, BooleanField,
         ForeignKeyField, JsonField } from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import * as orderkey from "../liminal/orderkey.ts";
import { block } from "../liminal/strings.ts";
import { path } from "../liminal/serializable.ts";

// A framework-managed order column: hidden from forms, set by insert()/moves.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// --- Site ------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface Site {
    site_id: number;
    site_title: string;
}
export type SiteOpt = Partial<Site>;

export class SiteTable extends Table<Site> {
    constructor() {
        super('site', [
            new PrimaryKeyField('site_id', {}),
            new StringField('site_title', {default: '', prompt: 'Site title'}),
        ]);
    }

    // All sites (the authoring index lists these).
    @path
    get listAll() {
        return this.prepare<Site, Record<string, never>>(block`
/**/   SELECT ${this.allFields} FROM site ORDER BY site_id`);
    }

    // Shape key for the sites list (a site added/removed reloads the index).
    listShapeKey(): string { return '-site-shape-'; }
}

// ---------------------------------------------------------------------------
// --- Page ------------------------------------------------------------------
// ---------------------------------------------------------------------------

// A page carries its block flow plus the per-page config the app's chrome reads
// (hero image, nav placement, publish state).  Header/nav/footer are not columns -
// they are rendered by the app-subclassed renderPageChrome hook.
export interface Page {
    page_id: number;
    site_id: number;
    page_title: string;
    slug: string;         // URL path
    hero_image: string;   // per-page header image (app chrome renders it); '' = none
    nav_order: string;    // order_key for the site nav
    nav_visible: number;  // boolnum: show in the site nav
    published: number;    // boolnum: draft vs live
}
export type PageOpt = Partial<Page>;

export class PageTable extends Table<Page> {
    constructor() {
        super('page', [
            new PrimaryKeyField('page_id', {}),
            new ForeignKeyField('site_id', 'site', 'site_id', {indexed: true, edit: security.never}, 'site_title'),
            new StringField('page_title', {default: '', prompt: 'Page title'}),
            new StringField('slug', {default: '', prompt: 'URL path'}),
            // A per-page header image path; the app chrome renders it via its own
            // photo pipeline (kept a plain string so components stays app-agnostic).
            new StringField('hero_image', {default: '', nullable: true, prompt: 'Header image'}),
            // Nav order among a site's pages.  Managed - set by insert()/moves.
            new ManagedStringField('nav_order', {default: ''}),
            new BooleanField('nav_visible', {default: 1, prompt: 'Show in nav'}),
            new BooleanField('published', {default: 0}),
        ]);
    }

    // Append at the end of the site's page order unless an explicit nav_order is given.
    override insert<P extends PageOpt>(tuple: P): number {
        const nav_order = (tuple as any).nav_order
            ?? this.nextNavOrder(Number(tuple.site_id));
        return super.insert({nav_order, ...tuple});
    }
    private nextNavOrder(site_id: number): string {
        const last = security.runSystem(() => db().prepare<{k: string}, {site_id: number}>(
            'SELECT MAX(nav_order) AS k FROM page WHERE site_id = :site_id').first({site_id}));
        return orderkey.between(last?.k, undefined);
    }

    // A site's pages in nav order (the app chrome builds its nav from this; the
    // authoring index lists them).
    @path
    get forSite() {
        return this.prepare<Page, {site_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM page
/**/          WHERE site_id = :site_id
/**/          ORDER BY nav_order, page_id`);
    }

    // Shape key for a site's page list (a page added/removed/moved reloads it).
    siteShapeKey(site_id: number): string { return `-page-site-${site_id}-shape-`; }
}

// ---------------------------------------------------------------------------
// --- Block -----------------------------------------------------------------
// ---------------------------------------------------------------------------

// One flat, ordered block on a page.  `kind` is a block-kind registry key;
// `payload` is that kind's FieldSet value as JSON (read via registry
// readPayload/hydrate - old blobs upgrade lazily).
export interface Block {
    block_id: number;
    page_id: number;
    order_key: string;
    kind: string;
    payload: string;   // JSON
}
export type BlockOpt = Partial<Block>;

export class BlockTable extends Table<Block> {
    constructor() {
        super('block', [
            new PrimaryKeyField('block_id', {}),
            new ForeignKeyField('page_id', 'page', 'page_id',
                                {indexed: true, edit: security.never}),
            new ManagedStringField('order_key', {default: ''}),
            new StringField('kind', {default: '', edit: security.never}),
            new JsonField('payload', {default: ''}),
        ]);
    }

    // Append at the end of the page's block order unless an explicit key is given.
    override insert<P extends BlockOpt>(tuple: P): number {
        const order_key = (tuple as any).order_key
            ?? this.nextOrderKey(Number(tuple.page_id));
        return super.insert({order_key, ...tuple});
    }
    private nextOrderKey(page_id: number): string {
        const last = security.runSystem(() => db().prepare<{k: string}, {page_id: number}>(
            'SELECT MAX(order_key) AS k FROM block WHERE page_id = :page_id')
            .first({page_id}));
        return orderkey.between(last?.k, undefined);
    }

    // The page-scoped SHAPE key (liminal.md): add/move/delete rebuild the ordered
    // list, so the whole block flow reloads; an in-place payload edit uses the plain
    // row key instead.  A page owns a single flat flow, so one key suffices.
    pageShapeKey(page_id: number): string {
        return `-block-page-${page_id}-shape-`;
    }

    // A page's blocks in order.
    @path
    get forPage() {
        return this.prepare<Block, {page_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM block
/**/          WHERE page_id = :page_id
/**/          ORDER BY order_key, block_id`);
    }
}

// The site-editor tables, for schema creation and the test harness.  An app adds
// these to its own tables list when it mounts the site editor.
export const siteEditorTables = [new SiteTable(), new PageTable(), new BlockTable()];
export const allDml = siteEditorTables.map(t => t.createDMLString()).join('\n');
