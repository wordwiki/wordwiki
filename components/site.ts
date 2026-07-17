// The site editor's schema: Site -> PageFragment -> Block, a shared `components`
// feature used by both rabid and wordwiki.  See site-editor.md.
//
// Blocks are a FLAT, ordered list within a page fragment (the FLATNESS RULE): one
// physical `block` table carrying a `kind` string and a JSON `payload`, dispatched
// through the block-kind registry rather than a table per block kind.  This module
// owns the tables, ordering, and lookup queries; render/edit live alongside.

import { db } from "../liminal/db.ts";
import { Table, PrimaryKeyField, StringField, IntegerField, BooleanField,
         ForeignKeyField, EnumField, JsonField } from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import * as orderkey from "../liminal/orderkey.ts";
import { block } from "../liminal/strings.ts";
import { path } from "../liminal/serializable.ts";

// A framework-managed order column: hidden from forms, set by insert()/moves.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

// Fragment kinds.  A fragment reuses the whole page mechanism for headers/footers
// (at most one of each per site, enforced in app logic - not a schema constraint)
// and for template fragments (binding deferred - see site-editor.md).
export const page_fragment_kind: Record<string, string> = {
    'page':     'Page',
    'header':   'Page Header',
    'footer':   'Page Footer',
    'template': 'Template',
};

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
}

// ---------------------------------------------------------------------------
// --- PageFragment ----------------------------------------------------------
// ---------------------------------------------------------------------------

export interface PageFragment {
    page_fragment_id: number;
    site_id: number;
    page_title: string;
    fragment_kind: string;   // page_fragment_kind
    fragment_name: string;   // hint for template binding (deferred; see site-editor.md)
    slug: string;            // URL path
    nav_order: string;       // order_key for header navigation
    published: number;       // boolnum: draft vs live
}
export type PageFragmentOpt = Partial<PageFragment>;

export class PageFragmentTable extends Table<PageFragment> {
    constructor() {
        super('page_fragment', [
            new PrimaryKeyField('page_fragment_id', {}),
            new ForeignKeyField('site_id', 'site', 'site_id', {indexed: true, edit: security.never}, 'site_title'),
            new StringField('page_title', {default: '', prompt: 'Page title'}),
            new EnumField('fragment_kind', page_fragment_kind, {default: 'page'}),
            new StringField('fragment_name', {default: ''}),
            new StringField('slug', {default: '', prompt: 'URL path'}),
            // Header-nav order among a site's pages.  Managed - set by insert()/moves.
            new ManagedStringField('nav_order', {default: ''}),
            new BooleanField('published', {default: 0}),
        ]);
    }

    // Append at the end of the site's page order unless an explicit nav_order is given.
    override insert<P extends PageFragmentOpt>(tuple: P): number {
        const nav_order = (tuple as any).nav_order
            ?? this.nextNavOrder(Number(tuple.site_id));
        return super.insert({nav_order, ...tuple});
    }
    private nextNavOrder(site_id: number): string {
        const last = security.runSystem(() => db().prepare<{k: string}, {site_id: number}>(
            'SELECT MAX(nav_order) AS k FROM page_fragment WHERE site_id = :site_id').first({site_id}));
        return orderkey.between(last?.k, undefined);
    }

    // A site's fragments in nav order (all kinds; callers filter by fragment_kind).
    @path
    get forSite() {
        return this.prepare<PageFragment, {site_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM page_fragment
/**/          WHERE site_id = :site_id
/**/          ORDER BY nav_order, page_fragment_id`);
    }
}

// ---------------------------------------------------------------------------
// --- Block -----------------------------------------------------------------
// ---------------------------------------------------------------------------

// One flat, ordered block on a page fragment.  `kind` is a block-kind registry
// key; `payload` is that kind's FieldSet value as JSON (read via registry
// readPayload/hydrate - old blobs upgrade lazily).
export interface Block {
    block_id: number;
    page_fragment_id: number;
    order_key: string;
    kind: string;
    payload: string;   // JSON
}
export type BlockOpt = Partial<Block>;

export class BlockTable extends Table<Block> {
    constructor() {
        super('block', [
            new PrimaryKeyField('block_id', {}),
            new ForeignKeyField('page_fragment_id', 'page_fragment', 'page_fragment_id',
                                {indexed: true, edit: security.never}),
            new ManagedStringField('order_key', {default: ''}),
            new StringField('kind', {default: '', edit: security.never}),
            new JsonField('payload', {default: ''}),
        ]);
    }

    // Append at the end of the fragment's block order unless an explicit key is given.
    override insert<P extends BlockOpt>(tuple: P): number {
        const order_key = (tuple as any).order_key
            ?? this.nextOrderKey(Number(tuple.page_fragment_id));
        return super.insert({order_key, ...tuple});
    }
    private nextOrderKey(page_fragment_id: number): string {
        const last = security.runSystem(() => db().prepare<{k: string}, {page_fragment_id: number}>(
            'SELECT MAX(order_key) AS k FROM block WHERE page_fragment_id = :page_fragment_id')
            .first({page_fragment_id}));
        return orderkey.between(last?.k, undefined);
    }

    // The page-scoped SHAPE key (liminal.md): add/move/delete rebuild the ordered
    // list, so the whole block flow reloads; an in-place payload edit uses the plain
    // row key instead.  A fragment_id owns a single flat flow, so one key suffices.
    pageShapeKey(page_fragment_id: number): string {
        return `-block-page-${page_fragment_id}-shape-`;
    }

    // A fragment's blocks in order.
    @path
    get forFragment() {
        return this.prepare<Block, {page_fragment_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM block
/**/          WHERE page_fragment_id = :page_fragment_id
/**/          ORDER BY order_key, block_id`);
    }
}

// The site-editor tables, for schema creation and the test harness.  An app adds
// these to its own tables list when it mounts the site editor.
export const siteEditorTables = [new SiteTable(), new PageFragmentTable(), new BlockTable()];
export const allDml = siteEditorTables.map(t => t.createDMLString()).join('\n');
