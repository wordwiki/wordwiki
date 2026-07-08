/**
 * The PUBLISH SOURCE: everything the public-site generator consumes, as ONE
 * serializable data bundle (doc of record: wordwiki/publish-source.md).
 *
 * WHY (the archival model): this dictionary's data must outlive the
 * software.  The reduced, simplified projection that drives publishing is
 * the neutral-format artifact a future generation converts to whatever
 * medium comes next - and because the LIVE publish is driven off this very
 * bundle, it is guaranteed correct and complete for as long as the site
 * exists.  Exports nothing consumes rot; the production pipeline cannot.
 *
 * The bundle is pure JSON-serializable data.  Derived indexes (by-category,
 * by-reference-group, public ids, collation) are computed by the consumer
 * from the bundle via the SHARED pure functions in site-view.ts, so the
 * live site views and a publish driven from a dump can never drift.
 *
 * EVOLUTION DISCIPLINE: this format is (becoming) the project's most
 * important API - future consumers cannot file bug reports.  formatVersion
 * gates readers; prefer additive changes; document every field in
 * publish-source.md.
 */

import {Entry} from './entry-schema.ts';
import * as category from './category.ts';
import {ScannedDocument, selectAllScannedDocuments, maxPageNumberForDocument} from './scanned-document.ts';
import {siteConfig} from './site-config.ts';
import type {SiteView} from './site-view.ts';

export const PUBLISH_SOURCE_FORMAT_VERSION = 1;

export interface PublishSourceBook {
    /** The reference book's metadata (title, author, source credits...). */
    document: ScannedDocument;
    /** Pages in the book (page numbers are 1-based and dense). */
    totalPages: number;
    /** [page_number, dictionary-reference count] for pages that have
     *  references worked through into dictionary entries. */
    entryCountByPage: [number, number][];
}

export interface PublishSource {
    formatVersion: number;
    /** Stamped by dump-publish-source only; absent on in-memory builds
     *  (keeps the bundle itself deterministic for diffing). */
    generatedAt?: string;
    /** The orthography this site is rendered in. */
    orthography: string;
    /** Collation locale for source-language sorting. */
    collationLocale: string;
    /** The db_purpose marker of the building db (logged into the publish). */
    dbPurpose: string;
    /** The REDUCED public projection: every entry on the site, as plain
     *  entry JSON - published facts only, no history, no pending edits. */
    entries: Entry[];
    /** The category vocabulary rows, in display (theme-block) order. */
    categories: category.Category[];
    /** The reference books, with per-page dictionary-reference counts. */
    books: PublishSourceBook[];
}

/** What building a PublishSource needs from the app - WordWiki satisfies
 *  this structurally. */
export interface PublishSourceApp {
    site(orthography?: string): SiteView;
    getDbPurpose(): string | undefined;
    readonly categories: category.CategoryTable;
    entryCountByPage(book: string): Array<[number, number]>;
}

export function buildPublishSource(app: PublishSourceApp): PublishSource {
    const site = app.site();
    const books: PublishSourceBook[] =
        selectAllScannedDocuments().all({}).map(document => ({
            document,
            totalPages: maxPageNumberForDocument()
                .required({document_id: document.document_id}).max_page_number,
            entryCountByPage: app.entryCountByPage(document.friendly_document_id),
        }));
    const categories = (() => {
        try { return app.categories.allByOrder.all({}); }
        catch (_e) { return [] as category.Category[]; }  // pre-import db
    })();
    return {
        formatVersion: PUBLISH_SOURCE_FORMAT_VERSION,
        orthography: site.orthography,
        collationLocale: siteConfig.collationLocale,
        dbPurpose: app.getDbPurpose() ?? 'unmarked',
        // The view's entries array ITSELF, not a copy: the publish
        // staleness check is entries-IDENTITY against the live view.
        entries: site.publicEntries,
        categories,
        books,
    };
}

/** Parse a dumped publish source, gating on the format version.  (A source
 *  loaded from JSON naturally cannot satisfy the live staleness identity
 *  check - from-dump publishing is for standalone generation.) */
export function publishSourceFromJson(text: string): PublishSource {
    const source = JSON.parse(text);
    if(source?.formatVersion !== PUBLISH_SOURCE_FORMAT_VERSION)
        throw new Error(`unsupported publish-source formatVersion '${source?.formatVersion}' ` +
                        `(this reader understands ${PUBLISH_SOURCE_FORMAT_VERSION})`);
    return source as PublishSource;
}
