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

import {Entry, entryIsPublicIn, parsedDictSchema, EntryTag} from './entry-schema.ts';
import * as model from './model.ts';
import {variantMatches} from './variant-policy.ts';
import * as category from './category.ts';
import * as user from './user.ts';
import * as orthographyModule from './orthography.ts';
import {ScannedDocument, selectAllScannedDocuments, maxPageNumberForDocument,
        selectScannedPageByPageNumber, getOrCreateNamedLayer} from './scanned-document.ts';
import {GroupScanData, BookPageScanData,
        loadGroupScanData, loadBookPageScanData} from './render-page-editor.ts';
import {getCompressedRecordingPath} from './audio.ts';
import {siteConfig} from './site-config.ts';
import type {SiteView} from './site-view.ts';

export const PUBLISH_SOURCE_FORMAT_VERSION = 1;

/** A user record REFERENCED from the data (recording speakers, todo
 *  assignees, ...), so every in-data username resolves WITHIN the file.
 *  user_id rides along so a future id-keyed data model changes nothing
 *  here. */
export interface PublishSourceUser {
    user_id: number;
    username: string;
    name: string;
    region?: string;
}

/** One audio reference, with the derivation DONE at build time: the
 *  source content path (as stored in the data - archival provenance) and,
 *  as a peer, the SERVED derived path (trimmed/compressed mp3) the site
 *  actually plays.  A failed derivation records its error instead, so a
 *  from-dump publish degrades exactly like a live one. */
export interface PublishSourceMedia {
    source: string;
    served?: string;
    error?: string;
}

export interface PublishSourceBook {
    /** The reference book's metadata (title, author, source credits...). */
    document: ScannedDocument;
    /** Pages in the book (page numbers are 1-based and dense). */
    totalPages: number;
    /** [page_number, dictionary-reference count] for pages that have
     *  references worked through into dictionary entries. */
    entryCountByPage: [number, number][];
    /** The Tagging layer whose groups the public book pages show (resolved
     *  - and created if missing, as the old render path did - at BUILD
     *  time, so publishing itself is read-only). */
    taggingLayerId: number;
    /** Per page (index = page_number-1): everything the annotated-page
     *  render needs - dimensions, image url, the tagging groups + boxes. */
    pageScans: BookPageScanData[];
}

export interface PublishSourceOpts {
    /** Which pub-gate lanes SELECT entries: an entry is in the bundle iff
     *  it is public in ANY of these.  The FIRST is the primary (it drives
     *  the entry-page public ids and the publisher's defaultVariant).
     *  Default: [the public site's orthography] - today's bundle. */
    orthographies?: string[];
    /** 'all' (default): each entry carries every orthography's content.
     *  'selected': variant-tagged tuples are filtered to the selected
     *  orthographies - EXCEPT fields whose variant is annotated
     *  $sourceOrthography in the schema (historical-source provenance,
     *  e.g. the reference transliterations), which always pass, and
     *  $notVariant pseudo-variants (locale relics, dropped by the
     *  orthography migration), which are not orthography lanes at all.
     *  'mm'-wildcard and legacy-blank variants match every lane
     *  (variantMatches, THE central predicate). */
    variantContent?: 'all' | 'selected';
}

export interface PublishSource {
    formatVersion: number;
    /** Stamped by dump-publish-source only; absent on in-memory builds
     *  (keeps the bundle itself deterministic for diffing). */
    generatedAt?: string;
    /** The PRIMARY orthography (= orthographies[0]): drives the entry-page
     *  public ids and the publisher's defaultVariant. */
    orthography: string;
    /** The primary orthography's display name (multi-tree publishes label
     *  the peer-orthography links and the root chooser with it). */
    orthographyName: string;
    /** The primary orthography's URL PATH SEGMENT for multi-tree publishes
     *  (/li/..., /sf/...): the orthography table's abbreviation,
     *  lowercased - DATA, not code (the segment lands in URLs and mirror
     *  directory names forever). */
    orthographySegment: string;
    /** May the public site offer SEARCH in this edition?  (Editorial flag
     *  from the orthography table: a young edition's search is a dead-end
     *  machine, so its home elides the box - browse links remain.) */
    publicSearchEnabled: boolean;
    /** The pub-gate selection set: entries public in ANY of these. */
    orthographies: string[];
    /** Whether each entry carries all orthographies' content or was
     *  filtered to the selected lanes (see PublishSourceOpts). */
    variantContent: 'all' | 'selected';
    /** Collation locale for source-language sorting. */
    collationLocale: string;
    /** The db_purpose marker of the building db (logged into the publish). */
    dbPurpose: string;
    /** The REDUCED public projection: every entry on the site, as plain
     *  entry JSON - published facts only, no history, no pending edits. */
    entries: Entry[];
    /** The category vocabulary rows, in display (theme-block) order.
     *  In-data category references (slugs) resolve against these. */
    categories: category.Category[];
    /** The human users, so in-data usernames (recording speakers, ...)
     *  resolve to a name and region WITHIN the file. */
    users: PublishSourceUser[];
    /** The reference books, with per-page dictionary-reference counts. */
    books: PublishSourceBook[];
    /** The standalone scan render data for every bounding group referenced
     *  by the entries' document references - so entry pages and book-page
     *  info boxes render their scan snippets with no db.  Sorted by group
     *  id for deterministic dumps. */
    scans: GroupScanData[];
    /** Every audio reference in the entries, resolved through the derived
     *  store at BUILD time (source -> served .mp3) - without this, the
     *  reduced form's source hashes are unusable except through the
     *  originals + the derivation machinery.  Sorted by source. */
    media: PublishSourceMedia[];
}

/** What building a PublishSource needs from the app - WordWiki satisfies
 *  this structurally. */
export interface PublishSourceApp {
    site(orthography?: string): SiteView;
    getDbPurpose(): string | undefined;
    readonly categories: category.CategoryTable;
    readonly users: user.UserTable;
    readonly orthographies: orthographyModule.OrthographyTable;
    entryCountByPage(book: string): Array<[number, number]>;
}

/** One source per PUBLISHABLE orthography (table order - the FIRST is the
 *  primary tree, today's li), for the multi-tree publish. */
export async function buildAllPublishSources(app: PublishSourceApp): Promise<PublishSource[]> {
    const rows = app.orthographies.publishableByOrder.all({});
    const out: PublishSource[] = [];
    for(const o of rows)
        out.push(await buildPublishSource(app, {orthographies: [o.slug]}));
    return out;
}

/** Filter one entry's variant-tagged tuples to the selected orthographies
 *  (schema-driven; see PublishSourceOpts.variantContent).  Returns a NEW
 *  object tree - the live projection is never mutated. */
export function filterEntryVariants(entry: Entry, orthographies: string[]): Entry {
    const root = parsedDictSchema().relationsByTag[EntryTag];
    const keepTuple = (rel: model.RelationField, tuple: any): boolean => {
        const vf = rel.scalarFields.find(f => f instanceof model.VariantField) as
            model.VariantField | undefined;
        if(!vf) return true;
        const flags = vf.variantFlags;
        // Provenance tags and locale relics are not display lanes - always pass.
        if(flags.sourceOrthography || flags.notVariant) return true;
        const v = (tuple as any)[vf.name];
        return orthographies.some(o => variantMatches(v, o));
    };
    const filterChildren = (rel: model.RelationField, tuple: any): any => {
        const out = {...tuple};
        for(const child of rel.relationFields) {
            const arr = (tuple as any)[child.name];
            if(Array.isArray(arr))
                out[child.name] = arr
                    .filter((t: any) => keepTuple(child, t))
                    .map((t: any) => filterChildren(child, t));
        }
        return out;
    };
    return filterChildren(root, entry) as Entry;
}

export async function buildPublishSource(app: PublishSourceApp,
                                         opts: PublishSourceOpts = {}): Promise<PublishSource> {
    const orthographies = opts.orthographies ?? [siteConfig.publicSiteOrthography];
    // The primary orthography's display name + URL path segment come from
    // the TABLE (data, not code - the segment lands in URLs forever).
    const primaryRow = (() => {
        try { return app.orthographies.allByOrder.all({}).find(o => o.slug === orthographies[0]); }
        catch (_e) { return undefined; }
    })();
    const orthographyName = primaryRow?.name || orthographies[0];
    const publicSearchEnabled = !!primaryRow?.public_search;
    const orthographySegment = (primaryRow?.abbreviation || orthographies[0])
        .toLowerCase().replace(/[^a-z0-9_]/g, '');
    const variantContent = opts.variantContent ?? 'all';
    if(orthographies.length === 0)
        throw new Error('publish source needs at least one orthography');
    const site = app.site(orthographies[0]);

    // Entry selection: public in ANY selected orthography, in published-
    // projection order.  The single-orthography unfiltered default keeps
    // the live view's ARRAY IDENTITY (the publish staleness check);
    // multi-orthography or filtered bundles are dump artifacts and build
    // new arrays.
    let entries: Entry[] =
        orthographies.length === 1
            ? site.publicEntries
            : site.store.publishedProjection.filter(e =>
                orthographies.some(o => entryIsPublicIn(e, o)));
    if(variantContent === 'selected')
        entries = entries.map(e => filterEntryVariants(e, orthographies));
    const books: PublishSourceBook[] =
        selectAllScannedDocuments().all({}).map(document => {
            const totalPages = maxPageNumberForDocument()
                .required({document_id: document.document_id}).max_page_number;
            const taggingLayerId = getOrCreateNamedLayer(document.document_id, 'Tagging', 0);
            const pageScans: BookPageScanData[] = [];
            for(let page_number = 1; page_number <= totalPages; page_number++) {
                const page_id = selectScannedPageByPageNumber()
                    .required({document_id: document.document_id, page_number}).page_id;
                pageScans.push(loadBookPageScanData(page_id, taggingLayerId));
            }
            return {
                document,
                totalPages,
                entryCountByPage: app.entryCountByPage(document.friendly_document_id),
                taggingLayerId,
                pageScans,
            };
        });

    // Every bounding group the bundle's entries reference (their document
    // references) - the standalone scan snippets on entry pages and in the
    // book-page info boxes.  Loading resolves (and generates if missing)
    // the content-addressed image tiles, hence async.
    const groupIds = Array.from(new Set(entries.flatMap(e =>
        e.subentry.flatMap(s => s.document_reference.map(d => d.bounding_group_id)))))
        .toSorted((a, b) => a - b);
    const scans: GroupScanData[] = [];
    for(const id of groupIds)
        scans.push(await loadGroupScanData(id));

    // Every audio reference (schema-driven: any AudioField value), each
    // resolved - derived if not yet cached - to the served mp3.  A failed
    // derivation (e.g. a recording row naming a missing file) records the
    // error message so the from-dump render degrades identically.
    const audioSources = collectAudioSources(entries);
    const media: PublishSourceMedia[] = [];
    for(const source of audioSources) {
        try {
            media.push({source, served: await getCompressedRecordingPath(source)});
        } catch (e) {
            media.push({source, error: String((e as Error)?.message ?? e)});
        }
    }
    const categories = (() => {
        try { return app.categories.allByOrder.all({}); }
        catch (_e) { return [] as category.Category[]; }  // pre-import db
    })();
    // Every HUMAN user (automation '~' identities never speak or get
    // assignments), disabled included - history and recordings reference
    // former staff forever.  Sorted for deterministic dumps.
    const users: PublishSourceUser[] = (() => {
        try {
            return app.users.allUsersByName.all({})
                .filter(u => !u.username.startsWith('~'))
                .map(u => ({user_id: u.user_id, username: u.username,
                            name: u.name, region: u.region ?? undefined}))
                .toSorted((a, b) => a.username < b.username ? -1 : 1);
        } catch (_e) { return []; }   // pre-migration db: no user table yet
    })();
    return {
        formatVersion: PUBLISH_SOURCE_FORMAT_VERSION,
        orthography: orthographies[0],
        orthographyName,
        orthographySegment,
        publicSearchEnabled,
        orthographies,
        variantContent,
        collationLocale: siteConfig.collationLocale,
        dbPurpose: app.getDbPurpose() ?? 'unmarked',
        // In the default single-orthography/'all' shape this is the live
        // view's entries array ITSELF, not a copy: the publish staleness
        // check is entries-IDENTITY against the live view.
        entries,
        categories,
        users,
        books,
        scans,
        media,
    };
}

/** Every distinct non-empty AudioField value in the entries, schema-driven
 *  (recordings, example recordings, and any future audio field), sorted. */
export function collectAudioSources(entries: Entry[]): string[] {
    const root = parsedDictSchema().relationsByTag[EntryTag];
    const out = new Set<string>();
    const walk = (rel: model.RelationField, tuple: any): void => {
        for(const f of rel.scalarFields)
            if(f instanceof model.AudioField) {
                const v = (tuple as any)[f.name];
                if(typeof v === 'string' && v !== '') out.add(v);
            }
        for(const child of rel.relationFields) {
            const arr = (tuple as any)[child.name];
            if(Array.isArray(arr))
                for(const t of arr) walk(child, t);
        }
    };
    for(const e of entries) walk(root, e);
    return Array.from(out).toSorted();
}

/** Write the FULL-HISTORY dump - the versioned assertion tree
 *  (workspace.ts dump(): every fact with its whole version chain) - the
 *  archival counterpart of the reduced bundle.  Written into
 *  `<publishRoot>/data/` by every LIVE publish (a from-dump publish has
 *  no db and leaves any existing file in place); also available as
 *  `./wordwiki.sh dump-full-history [path]`. */
export function writeFullHistoryDump(app: PublishSourceApp, publishRoot: string): string {
    const path = `${publishRoot}/data/full-history.json`;
    Deno.mkdirSync(`${publishRoot}/data`, {recursive: true});
    Deno.writeTextFileSync(path, JSON.stringify(app.site().store.workspace.dump()));
    return path;
}

/** Parse a dumped publish source, gating on the format version.  (A source
 *  loaded from JSON naturally cannot satisfy the live staleness identity
 *  check - from-dump publishing is for standalone generation.) */
export function publishSourceFromJson(text: string): PublishSource {
    const source = JSON.parse(text);
    // Older dumps predate the name/segment fields - default them.
    if(source && source.orthography) {
        source.orthographyName ??= source.orthography;
        source.orthographySegment ??= String(source.orthography).toLowerCase()
            .replace(/[^a-z0-9_]/g, '');
        source.publicSearchEnabled ??= true;   // pre-flag dumps were li
    }
    if(source?.formatVersion !== PUBLISH_SOURCE_FORMAT_VERSION)
        throw new Error(`unsupported publish-source formatVersion '${source?.formatVersion}' ` +
                        `(this reader understands ${PUBLISH_SOURCE_FORMAT_VERSION})`);
    return source as PublishSource;
}
