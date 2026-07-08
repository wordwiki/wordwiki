// deno-lint-ignore-file no-unused-vars

import * as markup from '../liminal/markup.ts';
import * as config from './config.ts';
import * as templates from './templates.ts';
import {db} from "../liminal/db.ts";
import {panic} from '../liminal/utils.ts';
import * as utils from '../liminal/utils.ts';
import * as strings from '../liminal/strings.ts';
import {block} from '../liminal/strings.ts';
import * as server from '../liminal/http-server.ts';
import {route, hostOrAdmin} from '../liminal/security.ts';
import {getWordWiki} from './wordwiki.ts';
import {entriesByCategoryOf, categoryCountsOf, entriesByReferenceGroupIdOf} from './site-view.ts';
import {PublishSource, PublishSourceBook, buildPublishSource, writeFullHistoryDump} from './publish-source.ts';
import type {GroupScanData} from './render-page-editor.ts';
import { writeUTF8FileIfContentsChanged } from '../liminal/ioutils.ts';
import { walk as fsWalk, exists as fsExists } from "std/fs/mod.ts";
import * as entryschema from './entry-schema.ts';
import * as category from './category.ts';
import {Entry} from './entry-schema.ts';
import * as audio from './audio.ts';  // REMOVE_FOR_WEB
import * as schema from './scanned-document.ts';
import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../liminal/markup.ts';
import * as renderPageEditor from './render-page-editor.ts';
import * as entryMeta from './render-entry-meta.ts';

// --------------------------------------------------------------------------------
// --- Stale-page pruning (orphan GC) ---------------------------------------------
// --------------------------------------------------------------------------------
//
// The publisher only ever WROTE pages; it never deleted them.  So when a
// category (or entry) stops being public - e.g. the free-text category
// `astronomy` was migrated to the internal `~old-astronomy` and its words moved
// to `sky` - the page it left behind on disk (categories/astronomy.html) keeps
// being served and indexed forever.  pruneOrphanedPages() deletes those
// orphans: any *.html under a publisher-owned directory that was NOT written
// during a full publish this run.
//
// Deleting files from a publish root is dangerous, so this is wrapped in layers
// of paranoia (see pruneOrphanedPages):
//   - OPT-IN MARKER: prune only runs if PUBLISH_MARKER_FILE exists in the
//     publish root.  The publisher NEVER creates it - a human places it once to
//     bless a directory as a real publish root.  Misconfigured root => no marker
//     => nothing deleted.
//   - FULL-PUBLISH ONLY: prune runs from publish() (the complete run), never
//     from publishTargets() (partial), and only over sections that actually ran.
//   - MANIFEST-DRIVEN: it deletes only files NOT in emittedPaths (the exact set
//     of paths written this run), never a recomputed/guessed set.
//   - ERROR GATE: it refuses to run if the publish logged any error (an
//     incomplete manifest could make a failed page look orphaned).
//   - SANITY FLOOR: it refuses to run if implausibly few pages were emitted.
//   - EXTENSION ALLOWLIST: it only ever removes files ending in `.html`.
//   - SCOPE: it only walks PRUNE_*_DIRS (categories / entries / forwarders);
//     resources, books, images, and everything else are never touched.

// Operator-placed marker that opts a publish root in to pruning.  Created by a
// human (`touch`), never by the publisher.
export const PUBLISH_MARKER_FILE = '.wordwiki-publish-root';

// Publisher-owned directories that pruneOrphanedPages may delete orphan *.html
// from.  Each group is only pruned when its section actually ran this publish.
const PRUNE_CATEGORY_DIRS = ['categories', 'top-words'];
const PRUNE_ENTRY_DIRS    = ['entries', 'servlet/words'];

// If a "full" publish emitted fewer than this many pages, treat the manifest as
// broken (something failed upstream) and refuse to prune anything.  The live
// site emits ~17k pages; this only trips on an obviously-broken run.
const PRUNE_MIN_MANIFEST = 100;

// A publish status message: plain text, optionally tagged with the lexeme
// (entry) it is about, so the status page can link to that lexeme's editor.
export type PublishMessage = string | {text: string, entryId?: number};

// The plain text of a message (for the console / CLI and as a fallback).
export function publishMessageText(m: PublishMessage): string {
    return typeof m === 'string' ? m : m.text;
}

// The lexeme this message references, if any.
export function publishMessageEntryId(m: PublishMessage): number | undefined {
    return typeof m === 'string' ? undefined : m.entryId;
}

export class PublishStatus {
    startTime?: number = undefined;
    endTime?: number = undefined;
    log: PublishMessage[] = [];
    errors: PublishMessage[] = [];
    // Warnings vs errors: an ERROR means a page could not be published (and
    // reads as "the site is broken"); a WARNING means the page published but
    // the publish - as the final validation of everything - noticed a
    // data problem to deal with (e.g. a recording with no audio file).
    warnings: PublishMessage[] = [];

    constructor() {
    }

    get isRunning(): boolean {
        return !!this.startTime && !this.endTime;
    }

    start() {
        if(this.isRunning)
            throw new Error('publish is already running');
        this.startTime = +new Date();
        this.endTime = undefined;
        this.log = [];
        this.errors = [];
        this.warnings = [];
    }

    end() {
        this.endTime = +new Date();
    }
}

// We only want one publish running at a time, we model this
// by having the publish status be a singleton.
export const publishStatusSingleton = new PublishStatus();

// One status message as an <li>: the text, plus - when the message references
// a lexeme - a link to open that lexeme in the editor.  The link is for the
// errors/warnings sections (things to fix); the Recent Tasks log suppresses
// it - an edit link next to every published word is just noise.
function renderPublishMessage(m: PublishMessage, withEditLink: boolean=true): any {
    const entryId = publishMessageEntryId(m);
    return ['li', {},
            publishMessageText(m),
            withEditLink && entryId !== undefined
                ? [' ', ['a', {href: `/ww/wordwiki.lexeme.entryPage(${entryId})`},
                         '✎ edit lexeme']]
                : []];
}

export function publishStatus(joiningExistingPublish: boolean=false,
                              publishStatus: PublishStatus = publishStatusSingleton) {

    const title = `Publish Status`;
    const body = [
        ['h1', {}, title],
        
        joiningExistingPublish ?
            [['h2', {style: "color: red"},
              'Showing the progress of an already in process publish'],
             ['h3', {}, 'A new publish was not started']] : [],

        publishStatus.startTime ? 
            [
                ['h2', {}, `Publish started on ${new Date(publishStatus.startTime)}`],
                `Publish started ${Math.round((+new Date() - publishStatus.startTime)/1000)} seconds ago`
            ] :
            ['h2', {}, `A publish has not been started`],
        
        publishStatus.endTime ?
            [
                ['h2', {style: publishStatus.errors.length > 0 ? "color: red" : "color: green"}, `Publish completed on ${new Date(publishStatus.endTime)}`],
                `Publish took ${Math.round((publishStatus.endTime - (publishStatus.startTime??0))/1000)} seconds`                
            ]: [],
        
        (publishStatus.errors.length > 0) ? [
            ['h2', {style: "color: red"}, 'Errors'],
            ['ul', {},
             publishStatus.errors.map(m=>renderPublishMessage(m))
            ]] : [],

        // Deliberately calm (amber, not red): the pages ARE published; these
        // are data items to deal with, found by publish-as-final-validation.
        (publishStatus.warnings.length > 0) ? [
            ['h2', {style: "color: darkgoldenrod"},
             `Warnings (${publishStatus.warnings.length})`],
            ['p', {}, 'These pages published fine - each warning is a data item to fix when convenient.'],
            ['ul', {},
             publishStatus.warnings.map(m=>renderPublishMessage(m))
            ]] : [],

        (publishStatus.log.length > 0) ? [
            ['h2', {}, 'Recent Tasks'],
            ['ul', {},
             publishStatus.log.slice(-500).toReversed().map(m=>renderPublishMessage(m, false))
            ]] : [],
    ];

    const autoRefreshScript = ['script', {}, block`
/**/  window.addEventListener("load", e => {
/**/     setTimeout(()=>location.reload(), 5000);
/**/  });`];

    return templates.pageTemplate({title, body, head: autoRefreshScript});
}

export interface PublicPageContent {
    title?: any;
    head?: any;
    body?: any;
}


export function startPublish(): any {
    if(publishStatusSingleton.isRunning) {
        return server.forwardResponse('/ww/wordwiki.publish.publishStatus(true)');
    } else {
        (async ()=>{
            publishStatusSingleton.start();
            try {
                const wordWiki = getWordWiki();
                writeFullHistoryDump(wordWiki, '.');
                const publish = new Publish(publishStatusSingleton,
                                            await buildPublishSource(wordWiki));
                await publish.publish();
            } catch (e) {
                if(e instanceof Error) {
                    publishStatusSingleton.errors.push(e.toString());
                    console.info('ERROR WHILE PUBLISHING', e.toString());
                    console.info(e.stack);
                } else {
                    console.info('XXX non error thrown !!! ???');
                    publishStatusSingleton.errors.push(String(e));
                }
            }
            publishStatusSingleton.end();
        })();
        return server.forwardResponse('/ww/wordwiki.publish.publishStatus(false)');
    }
}

/**
 * Normally, publish done by users with the above interface, this
 * function is to allow publish to also be done from CLI or a partial
 * publish on every compile etc.
 */
export async function publish(publishOptions: PublishOptions) {
    if(publishStatusSingleton.isRunning)
        throw new Error('A publish is already running');
    try {
        const wordWiki = getWordWiki();
        wordWiki.requestWorkspaceReload();
        writeFullHistoryDump(wordWiki, '.');
        const publish = new Publish(publishStatusSingleton,
                                    await buildPublishSource(wordWiki),
                                    ".",
                                    publishOptions);
        await publish.publish();
        if(publish.entries !== wordWiki.publishedEntries)
            throw new Error(`The dictionary was changed during the publish process - data may be inconsistent - please republish`);
    } catch (e) {
        if(e instanceof Error) {
            publishStatusSingleton.errors.push(e.toString());
            console.info('ERROR WHILE PUBLISHING', e.toString());
            console.info(e.stack);
        } else {
            console.info('XXX non error thrown !!! ???');
            publishStatusSingleton.errors.push(String(e));
        }
        throw e;
    }
    if(publishStatusSingleton.errors.length > 0) {
        console.info('*** PUBLISH ERRORS');
        publishStatusSingleton.errors.forEach(e=>console.info(publishMessageText(e)));
        throw new Error('Publish failed');
    }
 }

interface PublishOptions {
    suppressPublishBooks?: boolean;
    suppressPublishCategories?: boolean;
    suppressPublishEntries?: boolean;
}

/**
 *
 */
/**
 * Publish-target grammar: targets are SITE-RELATIVE PATHS - "the URL you
 * want rebuilt" - so the way to name a thing is to copy it from the browser.
 * Tolerant of full URLs (scheme+host stripped), leading/trailing slashes and
 * a .html suffix.  Extend the grammar here as the site grows.
 *
 *   (empty) | index.html | home      home page
 *   404 | all-words | about-us       the other top-level pages
 *   data                              the data-downloads page + the bundle
 *   categories                       categories directory + every category page
 *   categories/water                 one category page
 *   top-words                        Top Words directory + its tier pages
 *   books                            every book
 *   books/PDM                        one book (all pages)
 *   books/PDM/page-0101              one book page (also books/PDM/101)
 *   entries                          every entry page
 *   entries/samqwan                  one entry by its public id (the cluster
 *                                    dir and repeated filename are optional:
 *                                    entries/s/samqwan/samqwan.html works)
 *   entry:121590                     one entry by entry id (escape hatch)
 */
export type PublishTarget =
    | {kind: 'home'} | {kind: '404'} | {kind: 'all-words'} | {kind: 'about-us'}
    | {kind: 'data'}
    | {kind: 'categories-all'}
    | {kind: 'category', slug: string}
    | {kind: 'top-words'}
    | {kind: 'books-all'}
    | {kind: 'book', book: string}
    | {kind: 'book-page', book: string, page: number}
    | {kind: 'entries-all'}
    | {kind: 'entry-public-id', publicId: string}
    | {kind: 'entry-id', entryId: number};

export function parsePublishTarget(raw: string): PublishTarget {
    let t = raw.trim()
        .replace(/^https?:\/\/[^/]+/, '')     // full URL -> path
        .replace(/^\/+/, '').replace(/\/+$/, '')
        .replace(/\.html$/, '');

    const idMatch = /^entry:(\d+)$/.exec(t);
    if(idMatch) return {kind: 'entry-id', entryId: Number(idMatch[1])};

    if(t === '' || t === 'index' || t === 'home') return {kind: 'home'};
    if(t === '404') return {kind: '404'};
    if(t === 'all-words') return {kind: 'all-words'};
    if(t === 'about-us') return {kind: 'about-us'};
    if(t === 'data') return {kind: 'data'};
    if(t === 'top-words') return {kind: 'top-words'};

    const parts = t.split('/');
    switch(parts[0]) {
        case 'categories':
            if(parts.length === 1) return {kind: 'categories-all'};
            if(parts.length === 2) return {kind: 'category', slug: parts[1]};
            break;
        case 'books': {
            if(parts.length === 1) return {kind: 'books-all'};
            if(parts.length === 2) return {kind: 'book', book: parts[1]};
            if(parts.length === 3) {
                const pageMatch = /^(?:page-)?(\d+)$/.exec(parts[2]);
                if(pageMatch)
                    return {kind: 'book-page', book: parts[1], page: Number(pageMatch[1])};
            }
            break;
        }
        case 'entries':
            if(parts.length === 1) return {kind: 'entries-all'};
            // entries/<publicId> or the full entries/<cluster>/<publicId>[/<publicId>]
            return {kind: 'entry-public-id', publicId: parts[parts.length - 1]};
    }
    throw new Error(
        `unrecognized publish target '${raw}' - targets are site-relative paths, e.g. ` +
        `index.html, categories, categories/water, top-words, books/PDM/page-0101, ` +
        `entries/samqwan, entry:121590 (see parsePublishTarget in publish.ts)`);
}

export class Publish {
    entryToPublicId: Map<Entry, string>;
    /** The orthography being published - the source bundle's. */
    defaultVariant: string;
    /** The bundle's public entries (the same ARRAY, not a copy - the
     *  caller's entries-identity staleness check depends on it). */
    entries: Entry[];
    collator: Intl.Collator;

    // The manifest of SITE-RELATIVE paths actually written this run.  Routing
    // every page write through writePage() keeps this complete and authoritative
    // - pruneOrphanedPages() deletes only *.html files NOT in this set.
    emittedPaths: Set<string> = new Set();

    constructor(public status: PublishStatus, public source: PublishSource,
                public publishRoot: string = '.',
                public options: PublishOptions = {}) {
        this.entries = source.entries;
        this.defaultVariant = source.orthography;
        this.collator = Intl.Collator(source.collationLocale);
        this.entryToPublicId = this.computeEntryPublicIds(this.entries, this.defaultVariant);
    }

    // Derived indexes over the bundle, via the SAME pure functions the live
    // site views use (site-view.ts) - a dump-driven publish cannot drift.
    #entriesByCategory: Map<string, Entry[]>|undefined;
    get entriesByCategory(): Map<string, Entry[]> {
        return this.#entriesByCategory ??= entriesByCategoryOf(this.entries, this.collator);
    }
    #entriesByReferenceGroupId: Map<number, Entry>|undefined;
    get entriesByReferenceGroupId(): Map<number, Entry> {
        return this.#entriesByReferenceGroupId ??= entriesByReferenceGroupIdOf(this.entries);
    }
    categoryCounts(): Map<string, number> {
        return categoryCountsOf(this.entries, this.collator);
    }
    bookByFriendlyId(book: string): PublishSourceBook {
        return this.source.books.find(b => b.document.friendly_document_id === book)
            ?? panic(`no reference book '${book}' in the publish source`);
    }

    // Path discipline: every `*Path`/`pathFor*` helper returns a
    // SITE-RELATIVE path (they double as href sources, so they must never
    // contain publishRoot); every filesystem write/mkdir goes through
    // fsPath(), the ONE place publishRoot is applied.
    fsPath(sitePath: string): string {
        return `${this.publishRoot}/${sitePath}`;
    }

    // Write a public page AND record it in the emitted-path manifest.  EVERY
    // page write must go through here (not writePageFromMarkupIfChanged
    // directly) so the manifest stays complete - pruneOrphanedPages() trusts it
    // to decide what on disk is a live page vs a stale orphan.  Takes the
    // SITE-RELATIVE path (fsPath() is applied here, the one place publishRoot is
    // joined for writes).
    async writePage(sitePath: string, pageMarkup: any): Promise<boolean> {
        this.emittedPaths.add(sitePath);
        return writePageFromMarkupIfChanged(this.fsPath(sitePath), pageMarkup);
    }

    // ------------------------------------------------------------------------
    // --- Public-site category policy ------------------------------------------
    // ------------------------------------------------------------------------
    //
    // Internal categories ('~' slugs: ~needs-human, ~old-*, ~tier-*, ...) are
    // NEVER rendered on the public site - every category the publisher emits
    // goes through these helpers (the single-filter rule: see category.ts).
    // Display names come from the category table when seeded; a value with no
    // table row (a pre-import db) falls back to the raw value.

    #categoryBySlug: Map<string, category.Category>|undefined;
    get categoryBySlug(): Map<string, category.Category> {
        return this.#categoryBySlug ??= (() => {
            return new Map(this.source.categories.map(c => [c.slug, c]));
        })();
    }

    publicCategoryName(slug: string): string {
        return this.categoryBySlug.get(slug)?.name ?? slug;
    }

    // ------------------------------------------------------------------------
    // --- Publish-as-final-validation: data warnings ----------------------------
    // ------------------------------------------------------------------------

    // Recording tuples whose audio file is missing: the page still publishes
    // (renderAudio degrades to a marker), and the publish reports a WARNING
    // per entry.  Called wherever an entry's markup is rendered (its own
    // page, book-page info boxes), deduped so each entry warns once.
    #recordingWarnedEntries = new Set<number>();
    warnMissingRecordings(entry: Entry): void {
        if(this.#recordingWarnedEntries.has(entry.entry_id)) return;
        this.#recordingWarnedEntries.add(entry.entry_id);
        const name = entry.spelling?.[0]?.text || `entry ${entry.entry_id}`;
        const missing = (recording: string|null|undefined) => recording == null || recording === '';
        for(const r of entry.recording ?? [])
            if(missing(r.recording))
                this.status.warnings.push(
                    {text: `Entry '${name}': recording${r.speaker ? ` by ${r.speaker}` : ''} has no audio file`,
                     entryId: entry.entry_id});
        for(const sub of entry.subentry ?? [])
            for(const ex of sub.example ?? [])
                for(const r of ex.example_recording ?? [])
                    if(missing(r.recording))
                        this.status.warnings.push(
                            {text: `Entry '${name}': example recording${r.speaker ? ` by ${r.speaker}` : ''} has no audio file`,
                             entryId: entry.entry_id});
    }

    /** An entry's categories as shown on the public site (internal filtered). */
    publicEntryCategories(entry: Entry): string[] {
        return entry.subentry.flatMap(s=>s.category.flatMap(c=>c.category))
            .filter(c => c != null && c !== '' && !category.isInternalCategorySlug(c));
    }

    /**
     * The public categories with entry counts: internal filtered out, ordered
     * by the category table's order (theme blocks) when seeded - categories
     * without a table row (pre-import) keep their alphabetical order, after
     * the tabled ones.
     */
    publicCategories(): Array<[string, number]> {
        const cats = Array.from(this.categoryCounts().entries())
            .filter(([slug, _n]) => !category.isInternalCategorySlug(slug));
        const order = new Map(Array.from(this.categoryBySlug.keys()).map((slug, i) => [slug, i]));
        return cats.toSorted(([a], [b]) =>
            (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)
            || this.collator.compare(a, b));
    }

    /**
     * The public categories as THEME GROUPS (the shared grouping from
     * category.ts: themes sorted alphabetically by title, names sorted within),
     * for the public categories page.  Un-tabled values (pre-import) trail in an
     * 'Other categories' group; on a fully pre-import db that is the only
     * group.  Counts ride along for the listing.
     */
    publicCategoryGroups(): Array<{theme: string, cats: Array<{slug: string, name: string, count: number}>}> {
        const counts = new Map(this.publicCategories());
        const tabled = Array.from(this.categoryBySlug.values())
            .filter(c => !category.isInternalCategorySlug(c.slug) && counts.has(c.slug));
        const tabledSlugs = new Set(tabled.map(c => c.slug));
        const groups = category.groupByTheme(tabled).map(g => ({
            theme: g.theme,
            cats: g.cats.map(c => ({slug: c.slug, name: c.name,
                                    count: counts.get(c.slug)!}))}));
        const untabled = Array.from(counts.entries())
            .filter(([slug, _n]) => !tabledSlugs.has(slug))
            .toSorted(([a], [b]) => this.collator.compare(a, b))
            .map(([slug, count]) => ({slug, name: slug, count}));
        if(untabled.length > 0)
            groups.push({theme: groups.length > 0 ? 'Other categories' : 'Categories',
                         cats: untabled});
        return groups;
    }

    async publish(): Promise<void> {
        // --- If publish root dir does not exist, create it.
        await Deno.mkdir(this.publishRoot, {recursive: true});

        // --- Record which instance/db this site was built from, and warn if the
        //     output dirs are shared (two instances publishing into one tree
        //     clobber each other) - part of the off-the-rails net.
        this.recordPublishContext();

        // --- Publish top level pages
        await this.publishItem('Home Page', ()=>this.publishHomePage());
        await this.publishItem('404 Page', ()=>this.publish404Page());
        await this.publishItem('All Words Page', ()=>this.publishAllWordsPage());
        await this.publishItem('About Us', ()=>this.publishAboutUsPage());
        await this.publishItem('Data Downloads', ()=>this.publishDataDownloads());

        // --- Publish books
        if(!this.options.suppressPublishBooks) {
            for(const book of this.source.books)
                await this.publishBook(book.document.friendly_document_id);
        }

        // --- Publish categories (and the Top Words listing, same curation)
        if(!this.options.suppressPublishCategories) {
            await this.publishCategoriesDirectory();
            await this.publishCategories();
            await this.publishItem('Top Words', ()=>this.publishTopWords());
        }

        // --- Publish all entries
        if(!this.options.suppressPublishEntries) {
            await this.publishEntries();
        }

        // --- Remove stale orphan pages left by earlier publishes (opt-in,
        //     heavily guarded - see pruneOrphanedPages).  Only meaningful after
        //     a FULL publish() like this one; never called from publishTargets.
        await this.pruneOrphanedPages();
    }

    // Note the building instance + db_purpose in the publish log, and warn if a
    // publish OUTPUT dir is a symlink (a shared output tree means two instances
    // publishing will clobber each other).
    recordPublishContext(): void {
        let instanceDir = '?';
        try { instanceDir = Deno.cwd(); } catch { /* ignore */ }
        let purpose = 'unmarked';
        purpose = this.source.dbPurpose;
        this.status.log.push(`Publishing from instance '${instanceDir}' [db_purpose: ${purpose}].`);
        if(this.source.generatedAt)
            this.status.log.push(
                `Data from a DUMPED publish source generated ${this.source.generatedAt} ` +
                `(${this.source.entries.length} entries) - not the live db.`);
        for(const dir of ['entries', 'categories', 'top-words', 'books', 'servlet']) {
            try {
                if(Deno.lstatSync(this.fsPath(dir)).isSymlink)
                    this.status.warnings.push(
                        `Publish output dir '${dir}' is a symlink - if another instance shares it, `+
                        `concurrent publishes will clobber each other.`);
            } catch { /* not present yet - fine */ }
        }
    }

    /**
     * Delete orphaned published pages: *.html under a publisher-owned directory
     * that was NOT (re)written during this full publish.  This is how a category
     * page survives its category becoming internal/renamed (the reported
     * `astronomy.html` bug) - the publisher stopped emitting it but never
     * removed the file.
     *
     * Deleting from a publish root is dangerous, so every layer here is a
     * fail-SAFE (skip/abort rather than risk a wrong delete).  See the block
     * comment by PUBLISH_MARKER_FILE for the rationale of each guard.  Call this
     * ONLY at the end of a full publish() - the manifest (emittedPaths) must be
     * complete for "not in the manifest" to mean "orphan".
     */
    async pruneOrphanedPages(): Promise<void> {
        // GUARD 1 - opt-in marker.  The publisher never creates it; a human
        // places it to bless a directory as a real publish root.  No marker =>
        // never delete anything (e.g. a misconfigured publishRoot).
        if(!(await fsExists(this.fsPath(PUBLISH_MARKER_FILE)))) {
            this.status.warnings.push(
                `Stale-page prune SKIPPED: no '${PUBLISH_MARKER_FILE}' marker in publish root `+
                `'${this.publishRoot}'. Create it (touch) to enable pruning of orphaned pages.`);
            return;
        }

        // GUARD 2 - error gate.  A publish that logged errors may have an
        // incomplete manifest, which would make a merely-failed page look like
        // an orphan.  Don't delete after a troubled run.
        if(this.status.errors.length > 0) {
            this.status.log.push(
                `Stale-page prune SKIPPED: ${this.status.errors.length} publish error(s) this run; `+
                `the emitted-page manifest may be incomplete, so pruning is unsafe.`);
            return;
        }

        // GUARD 3 - sanity floor.  An implausibly small manifest means something
        // broke upstream; refuse rather than risk deleting a live site.
        if(this.emittedPaths.size < PRUNE_MIN_MANIFEST) {
            this.status.errors.push(
                `Stale-page prune ABORTED: only ${this.emittedPaths.size} pages emitted `+
                `(< ${PRUNE_MIN_MANIFEST}); manifest looks broken - refusing to delete anything.`);
            return;
        }

        // Only prune directories whose section actually ran this publish - a
        // suppressed section emits nothing, so its whole tree would look
        // orphaned.
        const dirs: string[] = [];
        if(!this.options.suppressPublishCategories) dirs.push(...PRUNE_CATEGORY_DIRS);
        if(!this.options.suppressPublishEntries)    dirs.push(...PRUNE_ENTRY_DIRS);
        if(dirs.length === 0) return;

        // publishRoot-prefixed paths from the walk map back to site-relative
        // (manifest) keys by stripping this exact prefix.
        const prefix = this.publishRoot.replace(/\/+$/, '') + '/';

        let pruned = 0;
        const removed: string[] = [];
        for(const dir of dirs) {
            const dirFs = this.fsPath(dir);
            if(!(await fsExists(dirFs))) continue;
            // followSymlinks:false => never traverse out of the publish tree.
            for await (const ent of fsWalk(dirFs, {includeDirs: false, followSymlinks: false})) {
                // GUARD 4 - extension allowlist.  ONLY *.html is ever deletable.
                if(!ent.name.endsWith('.html')) continue;
                // GUARD 5 - must sit under the publish root (defends against any
                // symlink/path surprise from the walk).
                if(!ent.path.startsWith(prefix)) continue;
                const sitePath = ent.path.slice(prefix.length);
                if(this.emittedPaths.has(sitePath)) continue;   // live page - keep
                await Deno.remove(ent.path);
                pruned++;
                if(removed.length < 50) removed.push(sitePath);
            }
        }
        for(const p of removed) this.status.log.push(`Pruned stale page: ${p}`);
        this.status.log.push(
            `Stale-page prune complete: removed ${pruned} orphaned .html page(s) `+
            `from [${dirs.join(', ')}]` + (pruned > removed.length ? ` (first ${removed.length} listed)` : '') + '.');
    }

    /**
     * Publish just the named targets (see parsePublishTarget for the
     * grammar) - the quick-turnaround path for template iteration.  Note it
     * publishes EXACTLY what is asked: cross-page effects (a renamed entry
     * appearing in category listings, say) need their own targets.
     */
    async publishTargets(rawTargets: string[]): Promise<void> {
        for(const raw of rawTargets) {
            let t: PublishTarget;
            try {
                t = parsePublishTarget(raw);
            } catch(e) {
                this.status.errors.push(String(e instanceof Error ? e.message : e));
                continue;
            }
            switch(t.kind) {
                case 'home':      await this.publishItem('Home Page', ()=>this.publishHomePage()); break;
                case '404':       await this.publishItem('404 Page', ()=>this.publish404Page()); break;
                case 'all-words': await this.publishItem('All Words Page', ()=>this.publishAllWordsPage()); break;
                case 'about-us':  await this.publishItem('About Us', ()=>this.publishAboutUsPage()); break;
                case 'data':      await this.publishItem('Data Downloads', ()=>this.publishDataDownloads()); break;
                case 'categories-all':
                    await this.publishItem('Categories Directory', ()=>this.publishCategoriesDirectory());
                    await this.publishCategories();
                    break;
                case 'category':
                    await Deno.mkdir(this.fsPath(this.categoriesDir), {recursive: true});
                    await this.publishItem(`Category ${t.slug}`, ()=>this.publishCategory((t as any).slug));
                    break;
                case 'top-words':
                    await this.publishItem('Top Words', ()=>this.publishTopWords());
                    break;
                case 'books-all':
                    for(const book of this.source.books)
                        await this.publishBook(book.document.friendly_document_id);
                    break;
                case 'book':
                    await this.publishBook(t.book);
                    break;
                case 'book-page': {
                    const pagesInDocument = this.bookByFriendlyId(t.book).totalPages;
                    const tt = t;
                    await this.publishItem(`Book ${tt.book} page ${tt.page}`,
                                           ()=>this.publishBookPage(tt.book, tt.page, pagesInDocument));
                    break;
                }
                case 'entries-all':
                    for(const entry of this.entries)
                        await this.publishItem(`Entry ${entryschema.renderEntrySpellingsSummary(entry)}`,
                                               ()=>this.publishEntry(entry), entry.entry_id);
                    break;
                case 'entry-public-id': {
                    const entry = this.entryByPublicId.get(t.publicId);
                    if(!entry) {
                        this.status.errors.push(
                            `no published entry with public id '${t.publicId}' ` +
                            `(public ids are the entry-page filenames, e.g. 'samqwan')`);
                        break;
                    }
                    await this.publishItem(`Entry ${t.publicId}`, ()=>this.publishEntry(entry), entry.entry_id);
                    break;
                }
                case 'entry-id': {
                    const tid = t.entryId;
                    const entry = this.entries.find(e=>e.entry_id === tid);
                    if(!entry) {
                        this.status.errors.push(
                            `no published entry with entry id ${tid} ` +
                            `(unpublished/deleted entries have no public page)`);
                        break;
                    }
                    await this.publishItem(`Entry ${tid}`, ()=>this.publishEntry(entry), entry.entry_id);
                    break;
                }
            }
        }
    }

    #entryByPublicId: Map<string, Entry>|undefined;
    get entryByPublicId(): Map<string, Entry> {
        return this.#entryByPublicId ??= new Map(
            Array.from(this.entryToPublicId.entries()).map(([e, id]) => [id, e]));
    }

    // entryId: when this item is a lexeme (an entry page/forwarder), tag any
    // error with it so the status page can link to that lexeme's editor.
    async publishItem(itemDesc: string, itemPromise: ()=>Promise<void>,
                      entryId?: number): Promise<void> {
        let error: Error|undefined = undefined;
        //console.info(`publish ${itemDesc}`);
        try {
            await (itemPromise());
        } catch(e) {
            error = e as Error; // bad cast XXX
        } finally {
        }
        if(error) {
            const text = `${itemDesc}: ${error.toString()}`;
            this.status.errors.push(entryId !== undefined ? {text, entryId} : text);
        } else {
            this.status.log.push(entryId !== undefined ? {text: itemDesc, entryId} : itemDesc);
        }
    }
    
    get homePath(): string {
        return 'index.html';
    }

    get fourOhFourPath(): string {
        return '404.html';
    }
    
    async publishHomePage(): Promise<void> {

        const allSearchTerms = Array.from(new Set(
            this.entries.flatMap(entry=>entryschema.computeNormalizedSearchTerms(entry))));
        
        const head = [
            ['style', {}, block`
/**/                .def { display:none; }
/**/                _search_ { display: list-item; }`],
            ['script', {src:'resources/search.js'}],
            ['script', {}, block`
/**/                allSearchTerms = ${JSON.stringify(allSearchTerms)};
/**/                `],
        ];
        const title = "Mi'gmaq/Mi'kmaq Online Talking Dictionary";
        const body =
            ['div', {},
             ['h1', {}, title],

             ['p', {}, `Pjilasi & Welcome to Mi’gmaq-Mikmaq Online & current undertaking, the `,
              ['a', {href:'./books/PDM/page-0307/index.html'},
               'Pacifique Dictionary Manuscripts project']],
             
             // --- Bead image
             ['div', {},
              ['img', {id:'headerImage', class: 'img-fluid', src: 'resources/mmo-bead-image-1080x360.jpg'}]],
             
             // --- Search Box
             ['h2', {}, 'Dictionary Search'],
             ['div', {class: 'public-search-box'},
              ['form', {onsubmit:"updateCurrentSearchFromInput(); event.preventDefault();"},

               ['label', {for:"search", style:"font-weight: bold;"}, 'Search: '],
               ['input', {type:"text", size:"30",
                          name:"search", id:"search", label:"Dictionary Search", autofocus:"",
                          placeholder:"Mi'gmaq or English Search",
                          oninput:"updateCurrentSearchFromInput();"}],
              ], // /form
             ], // /div

             // --- Search instructions display until user starts typing a search
             ['div', {id:"searchInstructions"},
              ['ul', {},
               ['li', {}, "You can search in Mi'gmaq/Mi'kmaq or English."],
               ['li', {}, "Search results will update as you type (after the first 3 letters)."],
               ['li', {}, "Click on ", audio.audioPlayIcon, " to hear a recording of the word."],
               ['li', {}, "To do an exact word search, end the word with a space."],
               ['li', {}, "You can use a * for parts of a word you do not want to spell or are unsure of the spelling of."],
               ['li', {}, "You can do searches that must match multiple words.  For example 'wild cat'."],
              ],

              this.renderAboutUsBody(),
             ],

             // --- If we are returning to this page - restore the search from the fragment id in the URL
             ['script', {}, block`
/**/              updateCurrentSearchFromDocumentHash();
/**/         `],
             
             ['ul', {},
              this.entries.map(entry=>[
                  ['li', {class:entryschema.computeNormalizedSearchTerms(entry).map(term=>'_'+term).join(' ')+' def'},
                   this.renderEntryPublicLink('./', entry)
                  ]
              ])
             ],
            ];
        
        await this.writePage(this.homePath, this.publicPageTemplate('', {title, head, body}));
    }

    async publish404Page(): Promise<void> {

        const title = "Mi'gmaq/Mi'kmaq Online Talking Dictionary";
        const body =
            ['div', {},
             ['h1', {}, title],
             ['h2', {}, 'Page not Found'],
             ['p', {}, `Sorry, we were unable to find the page you requested.`],
             ['p', {}, 'You can ', ['a', {href:`https://${this.publicSiteDomain}`},  'start again at our home page.']],
            ];
        
        await this.writePage(this.fourOhFourPath, this.publicPageTemplate('', {title, body}));
    }
    
    get allWordsPath(): string {
        return 'all-words.html';
    }
    
    async publishAllWordsPage(): Promise<void> {

        const title = "All Words - Mi'gmaq/Mi'kmaq Online Talking Dictionary";
        const body =
            ['div', {},
             ['h1', {}, title],

             ['ul', {},
              this.entries.map(entry=>[
                  ['li', {class: 'def'},
                   this.renderEntryPublicLink('./', entry)
                  ]
              ])
             ]
            ];
        
        await this.writePage(this.allWordsPath,
                             this.publicPageTemplate('', {title, body}));
    }

    get aboutUsPath(): string {
        return 'about-us.html';
    }

    // ----- The data downloads (publish-source.md "site links its own dumps") --
    // The archival stage-3 artifact, ON the site it generated: every crawled
    // or mirrored copy of the site then carries the neutral-format data (and
    // the license) needed to regenerate or convert it - the site's own seed.

    get dataPagePath(): string {
        return 'data/index.html';
    }

    haveFullHistoryDump(): boolean {
        try { Deno.statSync(this.fsPath('data/full-history.json')); return true; }
        catch { return false; }
    }

    async publishDataDownloads(): Promise<void> {
        await Deno.mkdir(this.fsPath('data'), {recursive: true});

        // The EXACT bundle this publish ran from - not a separate export
        // that could drift.  A live build carries no timestamp (so
        // republishing unchanged data rewrites nothing); a --from publish
        // passes its dump's generatedAt through as provenance.
        await writeUTF8FileIfContentsChanged(
            this.fsPath('data/publish-source.json'),
            JSON.stringify(this.source, null, 1));

        // The format documentation rides along, so a future reader of the
        // file never needs this project's repository.
        try {
            const formatDoc = Deno.readTextFileSync(
                new URL('./publish-source.md', import.meta.url));
            await writeUTF8FileIfContentsChanged(
                this.fsPath('data/publish-source-format.md'), formatDoc);
        } catch (e) {
            this.status.warnings.push(`data downloads: could not copy the format doc: ${e}`);
        }

        const rootPath = '../';
        const title = 'Dictionary Data';
        const body =
            ['div', {},
             ['h1', {}, title],

             ['p', {}, `This dictionary's data is made to outlive any one website or
program.  The files below are the complete machine-readable content of this
site, in plain JSON - every published word with its spellings, meanings,
examples, recordings and source-manuscript references.  If you are reading
this on an archived or mirrored copy of the site: these files are all you
need to carry the dictionary forward into whatever comes next.`],

             ['h2', {}, 'Files'],
             ['ul', {},
              ['li', {},
               ['a', {href: 'publish-source.json'}, 'publish-source.json'],
               ` — the dictionary data (${this.entries.length} words).  This is the
exact file this site was generated from, so it is always complete and
current: the site existing is the proof.`,
               this.source.generatedAt ? ` Generated ${this.source.generatedAt}.` : ''],
              ['li', {},
               ['a', {href: 'publish-source-format.md'}, 'publish-source-format.md'],
               ' — documentation of the file format, so the data can be read without this project\'s source code.'],
              this.haveFullHistoryDump()
                  ? ['li', {},
                     ['a', {href: 'full-history.json'}, 'full-history.json'],
                     ` — the COMPLETE versioned data: every fact with its whole
editorial history (who, when, every superseded version).  Larger and
requiring more sophistication to interpret; the file above is the
simplified form.`]
                  : undefined],

             ['p', {}, `The recordings and manuscript images are referenced from the
data by stable content-addressed paths under this site's `,
              ['code', {}, 'derived/'], ' and ', ['code', {}, 'content/'],
              ` directories - a mirror of the whole site therefore contains everything.`],

             this.haveFullHistoryDump() ? undefined :
             ['p', {}, `These files are the simplified, current-published form of the
data (no editorial history).  The complete versioned editorial history is
preserved by the project separately.`],

             ['h3', {}, 'License'],
             ['p', {}, 'This work is licensed under the ',
              ['a', {href:'https://creativecommons.org/licenses/by-nc/4.0/deed.en'}, 'Creative Commons Attribution-NonCommercial 4.0 International license']],
             ['p', {},
              ` You are free to
share copy and redistribute the material in any medium or format
including remixing, transforming, and building upon the material, for any non-commercial purpose as long as you give appropriate credit.  `,
             ]
            ];

        await this.writePage(this.dataPagePath,
                             this.publicPageTemplate(rootPath, {title, body}));
    }
    
    async publishAboutUsPage(): Promise<void> {

        const title = "About Us - Mi'gmaq/Mi'kmaq Online Talking Dictionary";
        const body = 
            ['div', {},
             ['h1', {}, title],

             this.renderAboutUsBody()
            ];
        
        await this.writePage(this.aboutUsPath,
                             this.publicPageTemplate('', {title, body}));
    }

    /**
     *
     */
    renderAboutUsBody(): any {
        return [
            // --- MMO info
            ['h2', {}, 'The Talking Dictionary'],

            ['p', {}, `The talking dictionary (Nnuigtug Ugsituna’tas’g Glusuaqanei) is a resource for the Mi'gmaq/Mi’kmaq language. Each headword is recorded by a minimum of three speakers. Multiple speakers allow one to hear differences and variations in how a word is pronounced. Each recorded word is used in an accompanying phrase. This permits learners the opportunity to develop the important skill of distinguishing individual words when they are spoken in a phrase.`],

            ['p', {}, 'Thus far we have posted ', ['a', {href: './all-words.html'}, `${this.entries.length} headwords`], ', a majority of these entries include two to three additional forms.'],
            ['p', {}, `The project was initiated in Listuguj, therefore all entries have Listuguj speakers and Listuguj spellings. In collaboration with Unama'ki, the site now includes a number of recordings from Unama'ki speakers. More will be added as they become available. `,
             `Listuguj is in the Gespe'g territory of the Mi'gmaw, located on the southwest shore of the Gaspè peninsula. Unama'ki is a Mi’gmaw territory; in English it is known as Cape Breton.`],

            ['p', {}, `Follow our word of the day posts in three orthographies on `,
             ['a', {href:'https://x.com/Pemaptoq'}, 'X'], ' or on ',
             ['a', {href:'https://bsky.app/profile/pemaptoq.bsky.social'}, 'Bluesky']],
            
            ['h2', {}, 'Pacifique Dictionary Manuscripts project'],

            ['img', {class: 'img-fluid', src: 'resources/pdm-sample.png'}],
            
            ['p', {}, `The `,
             ['a', {href:'./books/PDM/page-0307/index.html'},
             'Pacifique Dictionary Manuscripts project'],
             ` is the current source of words for the Mi’gmaq Online Talking Dictionary (MMO).`],

            ['p', {}, `These words from our ancestors are from a time when the language was robust and part of everyday life in all Mi’gmaw/Mi’kmaw communities. `],

            ['p', {},
             `Père Pacifique de Valigny, a parish priest in Listuguj, handwrote a Mi'gmaq - French dictionary in the first half of the 1900s.`],

            //['p', {} 'These words from our ancestors are from a time when the language was robust and part of everyday life in all Mi’gmaw/Mi’kmaw communities.'],

//(I don’t have the latest edit we discussed for this line) Père Pacifique de Valigny was the parish priest in Listuguj, he became a speaker of the language.

            ['p', {}, `The words, handwritten in Pacifique’s orthography with French translations, are:`,
                 
             ['ul', {},

              ['li', {}, 'transcribed'],
              ['ul', {},
               ['li', {}, 'abbreviations are expanded (unless not legible)'],

               ['li', {}, 'references available online are displayed in the Document References section of corresponding headwords']],
              ['li', {}, 'transliterated to contemporary Listuguj orthography'],

              ['li', {}, 'translated to English'],

              ['li', {}, 'researched'],
              ['ul', {},

               ['li', {}, 'historic written materials are consulted to find related entries.  These related entries are particularly useful as a context for words that have gone out of use'],

               ['li', {}, 'the list of reference books consulted and shared are listed in the Reference Books tab'],

               ['li', {}, 'in instances when there is no online access to a referenced work, it is cited (if legible) in the text of the Pacifique page entry']],

              ['li', {}, 'reviewed and discussed with speakers'],
              ['ul', {}, 
               ['li', {}, 'all material is reviewed with local Listuguj speakers; from there a collective decision is made on whether to record the word and add it to the online talking dictionary.'],

               ['li', {}, 'words not selected to be recorded remain accessible in the Pacifique Dictionary Manuscript pages data']]],

              ['p', {}, 'Terms that have gone out of use are a rich part of the information provided by these manuscripts.'],

              ['p', {}, 'Naturally, the manuscripts also contain well known, still-used words that have not yet been added to the dictionary, as they are found, they are added.']
            
            //['p', {}, `The words, handwritten in Pacifique’s orthography with French translations, are transcribed, transliterated to the contemporary Listuguj orthography and translated to English.  Historic written materials are consulted to find related entries. These related entries are particularly useful as a context for words that have gone out of use. Terms that have gone out of use are a rich part of the information provided by these manuscripts, naturally the manuscripts also contain well-known still used words, that have not yet been added to the dictionary. All material is reviewed with local Listuguj speakers. From there a collective decision is made on whether to record the word and add it to the online talking dictionary.`,
             ],

            ['h2', {}, 'Watch Us Working'],
            ['iframe',  {width:"560", height:"315", src:"https://www.youtube.com/embed/8Sq4Z_5xdUw?si=eIFs7BqZQ8-WkA8B", title:"YouTube video player", frameborder:"0", allow:"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share", referrerpolicy:"strict-origin-when-cross-origin", allowfullscreen:''}],
            ['br', {}],
            
            ['h2', {}, 'Contact Us'],
            ['p', {},
              'Email:', ['a', {href:'mailto:info@mikmaqonline.org'}, 'info@mikmaqonline.org']],

            ['h2', {}, 'Thanks'],

            ['p', {}, "Ta'n te'sijig mimajuinu'g apoqonmugsieg ula ntlugowaqannen wesgo'tmeg we'gwiwela'lieg aq we'gwimi'watmuleg."],

            ['p', {}, "We gratefully acknowledge and appreciate the support of all the people who have helped us with our work."],
            
            ['h2', {}, "We gratefully acknowledge the financial support of:"],
            ['ul', {},

             ['li', {}, "Listuguj Mi'gmaq Government ",
              ['a', {href: "https://www.listuguj.ca/"}, "https://www.listuguj.ca/"]],

             ['li', {}, "Government of Canada ",
              ['a', {href:"https://www.canada.ca/"}, "https://www.canada.ca/"]],
              
             ['li', {}, "Listuguj Education, Training & Employment (LED & LMDC) ",
              ['a', {href:"https://www.lete.listuguj.ca/"}, "https://www.lete.listuguj.ca/"]],

             ['li', {}, "First Nation's Educations Council (AFN, ALI) ",
              ['a', {href:"https://www.cepn-fnec.ca/en"}, "https://www.cepn-fnec.ca/en"]],

             ['li', {}, "The Canada Council ",
              ['a', {href:"http://www.canadacouncil.ca"}, "http://www.canadacouncil.ca"]],

             ['li', {}, "Atlantic Canada's First Nation Help Desk ",
              ['a', {href:"http://firstnationhelp.com/"}, "http://firstnationhelp.com/"]]
            ],

            ['h3', {}, "We gratefully acknowledge material support from:"],

            ['ul', {},
             ['li', {}, 'Bibliothèque et Archives nationales du Québec, ',
              ['a', {href:'https://www.banq.qc.ca/'}, 'https://www.banq.qc.ca/']],

             ['li', {}, 'University of Prince Edward Island, Robertson Library, ',
              ['a', {href:'https://islandlives.ca/'}, 'https://islandlives.ca/']],
            ],
            
            ['h3', {}, 'Dictionary Data'],
            ['p', {}, 'The complete machine-readable data behind this site - every published word with its spellings, meanings, examples, recordings and source references - is ',
             ['a', {href: './data/index.html'}, 'available for download'],
             ' under the same license as the site, so the language data can outlive any one website or program.'],

            ['h3', {}, 'License'],
            ['p', {}, 'This work is licensed under the ',
             ['a', {href:'https://creativecommons.org/licenses/by-nc/4.0/deed.en'}, 'Creative Commons Attribution-NonCommercial 4.0 International license']],
             
            ['p', {},
             ` You are free to
share copy and redistribute the material in any medium or format
including remixing, transforming, and building upon the material, for any non-commercial purpose as long as you give appropriate credit.  `,
            ]
        ];
    }

//     /**
//      *
//      */
//     renderAboutUsBody(): any {
//         return [
//             // --- MMO info
//             ['h3', {}, 'The Project'],
             
//             ['p', {}, "The talking dictionary project is developing an Internet resource for the Mi'gmaq/Mi’kmaq language. Each headword is recorded by a minimum of three speakers. Multiple speakers allow one to hear differences and variations in how a word is pronounced. Each recorded word is used in an accompanying phrase. This permits learners the opportunity to develop the difficult skill of distinguishing individual words when they are spoken in a phrase."],
              
//             ['p', {}, 'Thus far we have posted ', ['a', {href: './all-words.html'}, `${this.entries.length} headwords`], ', a majority of these entries include two to three additional forms.'],

//             ['p', {}, "The project was initiated in Listuguj, therefore all entries have Listuguj speakers and Listuguj spellings. In collaboration with Unama'ki, the site now includes a number of recordings from Unama'ki speakers. More will be added as they become available."],

//             ['p', {}, "Each word is presented using the Listuguj orthography. The Smith-Francis orthography will be included in the future. Some spellings are speculative."],

//             ['p', {}, "Listuguj is in the Gespe'g territory of the Mi'gmaw; located on the southwest shore of the Gaspè peninsula."],

//             ['p', {}, "Unama'ki is a Mi’gmaw territory; in English it is known as Cape Breton."],

//             ['h3', {}, 'Watch Us Working'],
//             ['iframe',  {width:"560", height:"315", src:"https://www.youtube.com/embed/8Sq4Z_5xdUw?si=eIFs7BqZQ8-WkA8B", title:"YouTube video player", frameborder:"0", allow:"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share", referrerpolicy:"strict-origin-when-cross-origin", allowfullscreen:''}],
//             ['br', {}],
            
//             ['h3', {}, 'Contact Us'],
//             ['p', {},
//               'Email:', ['a', {href:'mailto:info@mikmaqonline.org'}, 'info@mikmaqonline.org']],

//             ['h3', {}, 'Thanks'],

//             ['p', {}, "Ta'n te'sijig mimajuinu'g apoqonmugsieg ula ntlugowaqannen wesgo'tmeg we'gwiwela'lieg aq we'gwimi'watmuleg."],

//             ['p', {}, "We gratefully acknowledge and appreciate the support of all the people who have helped us with our work."],

//             ['h3', {}, "We gratefully acknowledge the financial support of"],
//             ['ul', {},

//              ['li', {}, "Listuguj Mi'gmaq Government ",
//               ['a', {href: "https://www.listuguj.ca/"}, "https://www.listuguj.ca/"]],

//              ['li', {}, "Government of Canada ",
//               ['a', {href:"https://www.canada.ca/"}, "https://www.canada.ca/"]],
              
//              ['li', {}, "Listuguj Education, Training & Employment (LED & LMDC) ",
//               ['a', {href:"https://www.lete.listuguj.ca/"}, "https://www.lete.listuguj.ca/"]],

//              ['li', {}, "First Nation's Educations Council (AFN, ALI) ",
//               ['a', {href:"https://www.cepn-fnec.ca/en"}, "https://www.cepn-fnec.ca/en"]],

//              ['li', {}, "The Canada Council ",
//               ['a', {href:"http://www.canadacouncil.ca"}, "http://www.canadacouncil.ca"]],

//              ['li', {}, "Atlantic Canada's First Nation Help Desk ",
//               ['a', {href:"http://firstnationhelp.com/"}, "http://firstnationhelp.com/"]]
//             ],

//             ['h3', {}, 'License'],
//             ['p', {}, 'This work is licensed under the ',
//              ['a', {href:'https://creativecommons.org/licenses/by-nc/4.0/deed.en'}, 'Creative Commons Attribution-NonCommercial 4.0 International license']],
             
//             ['p', {},
//              ` You are free to
// share copy and redistribute the material in any medium or format
// including remixing, transforming, and building upon the material, for any non-commercial purpose as long as you give appropriate credit.  `
//             ]
//         ];
//     }
    
    /**
     *
     */
    renderEntryPublicLink(rootPath: string, e: Entry, includeAudioLink: boolean=true): any {
        // TODO handle dialects here.
        const spellings = entryschema.getSpellings(e).map(s=>s.text);
        const glosses = e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss));
        const sampleRecording = entryschema.getStableFeaturedRecording(e);
        //console.info('SAMPLE RECORDING IS', spellings, sampleRecording);
        return [
            ['a', {href: rootPath+this.pathForEntry(e)}, ['strong', {}, spellings.join(', ')], ' : ', glosses.join(' / ')],
            (includeAudioLink && sampleRecording) ?
                audio.renderAudio(sampleRecording.recording, audio.audioPlayIcon, 'Play recording', rootPath, 'audio-icon', this.resolveAudioUrl) : [],
        ];
    }

    /**
     *
     */
    async publishEntries(): Promise<void> {

        for(const entry of this.entries) {
            await this.publishItem(`Entry ${this.getPublicIdForEntry(entry)}`,
                                   ()=>this.publishEntry(entry), entry.entry_id);
        }

        // Generate .html files that forward our old URLS to our new ones (using meta refresh)
        await Deno.mkdir(this.fsPath('servlet/words'), {recursive: true});
        for(const entry of this.entries) {
            await this.publishItem(`Entry Forwarder ${this.getPublicIdForEntry(entry)}`,
                                   ()=>this.publishEntryForwarder(entry), entry.entry_id);
        }
    }
    
    /**
     *
     */
    async publishEntry(entry: Entry): Promise<void> {
        this.warnMissingRecordings(entry);
        const rootPath = '../../../';
        const entryPath = this.pathForEntry(entry);
        const entryDir = this.dirForEntry(entry);
        await Deno.mkdir(this.fsPath(entryDir), {recursive: true});
        const spellingsSummary = entryschema.renderEntrySpellingsSummary(entry);
        const title = entryschema.renderEntryTitle(entry);
        // The metadata-driven renderer is the PUBLIC renderer too (dz,
        // 2026-07-05 - a step toward real multi-orthography, and it reads
        // better): audience 'public' drops the editorial relations
        // ($view.hidden), the internal-only fields (audience:'internal' -
        // the reference's editorial note), and the non-public attr keys.
        const entryMarkup: any = entryMeta.renderEntryMeta(
            {rootPath, audience: 'public', publicKeys: ['borrowed-word'],
             renderBoundingGroup: (gid: number) => this.publicBoundingGroup(rootPath, gid),
             resolveAudioUrl: this.resolveAudioUrl},
            entryschema.parsedDictSchema().relationsByTag[entryschema.EntryTag], entry);
        // renderCategoriesForEntry here.

        const entryCategories = this.publicEntryCategories(entry);
        const relatedCategoryMarkup =
            entryCategories.map(category=>[
                // h2, not h3: this is a whole separate page feature, not a
                // data field of the word - it gets the full ruled section
                // head so the page visibly changes subject here.
                ['h2', {}, `Related entries for category "${this.publicCategoryName(category)}"`],
                ['div', {},
                 ['ul', {},
                  (this.entriesByCategory.get(category)??[])
                      .map(e=>['li', {}, this.renderEntryPublicLink(rootPath, e, false)]),
                 ] // ul
                ] // div
            ]);

        const body = [
            entryMarkup,
            relatedCategoryMarkup,
        ];
                                
        await this.writePage(entryPath, this.publicPageTemplate(rootPath, {title, body}));
    }

    /** The public reference presentation for the metadata renderer: the scan
     *  and its book/page description, both linked to the public bounding-group
     *  page (the same shape the hand renderer's public reference block had). */
    #scanById: Map<number, GroupScanData>|undefined;
    get scanById(): Map<number, GroupScanData> {
        return this.#scanById ??= new Map(this.source.scans.map(s => [s.bounding_group_id, s]));
    }

    // The bundle-backed twins of the db scan-render trio, shared by the
    // entry pages (publicBoundingGroup below) and the book-page info boxes
    // (renderEntry's ctx.scanRenderers).  A group id missing from the
    // bundle renders like an empty group.
    scanStandaloneGroup(rootPath: string, id: number): any {
        const data = this.scanById.get(id);
        return data ? renderPageEditor.renderStandaloneGroupFromData(rootPath, data)
                    : renderPageEditor.renderWarningMessageAsSvg('Empty Group');
    }
    scanBookPageUrl(rootPath: string, id: number): string {
        const path = this.scanById.get(id)?.book_page_path ?? '';
        return path ? `${rootPath}${path}` : '';
    }
    scanDescription(id: number): string {
        return this.scanById.get(id)?.description ?? '';
    }
    scanRenderers() {
        return {
            renderStandaloneGroup: (rootPath: string, id: number) => this.scanStandaloneGroup(rootPath, id),
            publicBookPageUrl: (rootPath: string, id: number) => this.scanBookPageUrl(rootPath, id),
            imageRefDescription: (id: number) => this.scanDescription(id),
        };
    }

    // The bundle's media manifest: recordings render from build-time-
    // resolved derived paths - the publisher never touches the derivation
    // machinery or the source audio.
    #mediaBySource: Map<string, {served?: string, error?: string}>|undefined;
    resolveAudioUrl: audio.AudioUrlResolver = (source: string) => {
        this.#mediaBySource ??= new Map(this.source.media.map(m =>
            [m.source, {served: m.served, error: m.error}]));
        return this.#mediaBySource.get(source);
    };

    private publicBoundingGroup(rootPath: string, id: number): any {
        const scan = this.scanStandaloneGroup(rootPath, id);
        const url = this.scanBookPageUrl(rootPath, id);
        const desc = this.scanDescription(id);
        return ['div', {},
            ['div', {class: 'lm-me-scan'}, url ? ['a', {href: url}, scan] : scan],
            desc ? ['div', {}, url ? ['a', {href: url}, desc] : desc] : ''];
    }

    // <meta http-equiv="refresh" content="3;url=https://www.mozilla.org" />
    // https://www.mikmaqonline.org/servlet/words/gajuewj.html

    get publicSiteDomain() {
        return 'mikmaqonline.org';
    }
    
    /**
     *
     */
    async publishEntryForwarder(entry: Entry): Promise<void> {
        const entryForwarderPath = `servlet/words/${this.getPublicIdForEntry(entry)}.html`;
        
        const siteUrl = `https://${this.publicSiteDomain}`;
        const entryPath = this.pathForEntry(entry);
        const newEntryUrl = `${siteUrl}/${strings.stripOptionalPrefix(entryPath, './')}`;
        
        const head = ['meta', {'http-equiv': 'refresh',
                               'content': `0;url=${newEntryUrl}`}];

        const spellingsSummary = entryschema.renderEntrySpellingsSummary(entry);
        
        const title = `Forwarding to entry ${spellingsSummary}`;

        const body = [
            ['p', {}, `The entry for ${spellingsSummary} has moved to `,
             ['a', {href:newEntryUrl}, newEntryUrl],
             'You should be automatically forwarded.'
            ],

            ['p', {},
             'If this does not work, please search for your word on ',
             ['a', {href: siteUrl}, siteUrl]]
        ];
                                
        await this.writePage(entryForwarderPath, this.publicPageTemplate('../../', {title, head, body}));
    }

    get categoriesDir(): string {
        return 'categories';
    }

    get categoriesDirectoryPath(): string {
        return 'categories.html';
    }

    get topWordsDir(): string {
        return 'top-words';
    }

    get topWordsDirectoryPath(): string {
        return 'top-words.html';
    }

    // Site-relative path to a bucket's entry-list page, within a listing dir.
    // (Categories and Top Words are two listings sharing this scheme.)
    pathForListingPage(dir: string, slug: string): string {
        return `${dir}/${slug.replaceAll(/[^a-zA-Z0-9-']/g, '_')}.html`;
    }

    pathForCategory(category: string): string {
        return this.pathForListingPage(this.categoriesDir, category);
    }

    // ------------------------------------------------------------------------
    // --- Listings: a directory page of buckets, each linking to a page of
    //     its entries.  Categories and Top Words are two instances - they
    //     share publishListingDirectory + publishEntryListPage so the markup
    //     lives in ONE place.
    // ------------------------------------------------------------------------

    /** Render & write a listing's DIRECTORY page (grouped buckets, each
     *  linking to its entry-list page under `dir`).  A group with an empty
     *  theme renders no heading (a single unnamed group, e.g. Top Words). */
    async publishListingDirectory(opts: {
        directoryPath: string, dir: string, title: string, intro?: any,
        groups: Array<{theme: string, cats: Array<{slug: string, name: string, count: number}>}>,
    }): Promise<void> {
        const body = [
            ['h1', {}, opts.title],
            opts.intro ?? [],
            opts.groups.map(group => [
                group.theme ? ['h2', {}, group.theme] : [],
                ['ul', {},
                 group.cats.map(c =>
                     ['li', {}, ['a',
                                 {href:this.pathForListingPage(opts.dir, c.slug)},
                                 c.name, ` (${c.count} entries)`]])],
            ]),
        ];
        await this.writePage(opts.directoryPath, this.publicPageTemplate('', {title: opts.title, body}));
    }

    /** Render & write ONE bucket's entry-list page (its pages live one level
     *  deep, so links use '../'). */
    async publishEntryListPage(dir: string, slug: string, title: any, entries: Entry[]): Promise<void> {
        const body = [
            ['h2', {}, title],
            ['div', {},
             ['ul', {},
              entries.map(e=>['li', {}, this.renderEntryPublicLink('../', e)]),
             ] // ul
            ] // div
        ];
        await this.writePage(this.pathForListingPage(dir, slug), this.publicPageTemplate('../', {title, body}));
    }

    /**
     *
     */
    async publishCategoriesDirectory(): Promise<void> {
        await this.publishListingDirectory({
            directoryPath: this.categoriesDirectoryPath,
            dir: this.categoriesDir,
            title: 'Categories Directory',
            groups: this.publicCategoryGroups(),
        });
    }

    /**
     *
     */
    async publishCategories(): Promise<void> {
        await Deno.mkdir(this.fsPath(this.categoriesDir), {recursive: true});
        for(const [category, _count] of this.publicCategories()) {
            await this.publishItem(`Category ${category}`, ()=>this.publishCategory(category));
        }
    }

    /**
     *
     */
    async publishCategory(category: string): Promise<void> {
        const entriesForCategory = this.entriesByCategory.get(category)??[];
        await this.publishEntryListPage(
            this.categoriesDir, category,
            ['Entries for category ', this.publicCategoryName(category)],
            entriesForCategory);
    }

    // ------------------------------------------------------------------------
    // --- Top Words: the same listing markup as Categories, but the buckets
    //     are the learner tiers (top 10 / 100 / 1000).  Tier tags are stored
    //     MOST-SPECIFIC (an entry carries only its tightest tier), so each
    //     bucket is CUMULATIVE - it unions every tier up to and including its
    //     own (Top 100 = top-10 ∪ top-100 = 100 words).
    // ------------------------------------------------------------------------

    // Smallest bucket first; tierSlugs is the cumulative set unioned for it.
    get topWordsBuckets(): Array<{slug: string, name: string, tierSlugs: string[]}> {
        return [
            {slug: 'top-10',   name: 'Top 10 words',   tierSlugs: ['~tier-top-10']},
            {slug: 'top-100',  name: 'Top 100 words',  tierSlugs: ['~tier-top-10', '~tier-top-100']},
            {slug: 'top-1000', name: 'Top 1000 words', tierSlugs: ['~tier-top-10', '~tier-top-100', '~tier-top-1000']},
        ];
    }

    // The entries in a cumulative tier bucket: union the tier tags (deduped by
    // entry id), then sort by spelling like entriesByCategory does.
    cumulativeTierEntries(tierSlugs: string[]): Entry[] {
        const seen = new Set<number>();
        const out: Entry[] = [];
        for(const slug of tierSlugs)
            for(const e of this.entriesByCategory.get(slug) ?? [])
                if(!seen.has(e.entry_id)) { seen.add(e.entry_id); out.push(e); }
        return out.toSorted((a, b) =>
            this.collator.compare(
                a.spelling[0]?.text ?? '', b.spelling[0]?.text ?? ''));
    }

    async publishTopWords(): Promise<void> {
        const buckets = this.topWordsBuckets.map(b =>
            ({...b, entries: this.cumulativeTierEntries(b.tierSlugs)}));

        // The directory page (single unnamed group).
        await this.publishListingDirectory({
            directoryPath: this.topWordsDirectoryPath,
            dir: this.topWordsDir,
            title: 'Top Words',
            intro: ['p', {}, 'The most frequently used Mi’gmaq words, grouped by ',
                    'how many of the top words to learn first.'],
            groups: [{theme: '', cats: buckets.map(b =>
                ({slug: b.slug, name: b.name, count: b.entries.length}))}],
        });

        // One entry-list page per bucket (reuses the category page markup).
        await Deno.mkdir(this.fsPath(this.topWordsDir), {recursive: true});
        for(const b of buckets)
            await this.publishItem(`Top Words ${b.slug}`,
                ()=>this.publishEntryListPage(this.topWordsDir, b.slug,
                    ['Entries: ', b.name], b.entries));
    }
        
    dirForEntry(entry: Entry): string {
        const publicId = this.getPublicIdForEntry(entry);
        const cluster = this.clusterForEntry(entry);
        return `entries/${cluster}/${publicId}`;
    }

    clusterForEntry(entry: Entry): string {
        return (this.getPublicIdForEntry(entry)[0]??'_').toLowerCase();
    }
    
    pathForEntry(entry: Entry): string {
        const publicId = this.getPublicIdForEntry(entry);
        return `${this.dirForEntry(entry)}/${publicId}.html`;
    }

    getPublicIdForEntry(entry: Entry): string {
        const publicId = this.entryToPublicId.get(entry);
        return publicId || `-${entry.entry_id}`;
    }

    computeEntryPublicIds(entries: Entry[], defaultVariant: string): Map<Entry, string> {
        const entryIdToDefaultPublicId = new Map(
            entries.map(e=>[e, this.computeDefaultPublicIdForEntry(e, defaultVariant)]));
        const duplicateIds = utils.duplicateItems([...entryIdToDefaultPublicId.values()]);
        return new Map(
            entries.map(entry=>{
                const defaultId = entryIdToDefaultPublicId.get(entry) ?? panic();
                if(duplicateIds.has(defaultId))
                    return [entry, `${defaultId}-${entry.entry_id}`]; // Note '-' is reserved for this
                else
                    return [entry, defaultId];
            }));
    }

    computeDefaultPublicIdForEntry(entry: Entry, defaultVariant: string): string {
        const publicIdBase = this.getDefaultPublicIdBase(entry, defaultVariant);
        // TODO: make this fancier if we want to support other languages.
        const urlSafePublicIdBase = publicIdBase.replaceAll(/[^a-zA-Z0-9']/g, '_');
        return urlSafePublicIdBase;
    }

    getDefaultPublicIdBase(entry: Entry, defaultVariant: string): string {
        const id = this.getDefaultPublicIdBase_(entry, defaultVariant);
        if(!id)
            throw new Error(`For entry #${entry.entry_id} got empty default public id base '${id}'`);
        return id;
    }
    
    getDefaultPublicIdBase_(entry: Entry, defaultVariant: string): string {

        // --- If the entry has spellings in the default variant, use the first
        //     such spelling as the base for the public id.
        const firstSpellingInDefaultVariant =
            entry.spelling.filter(s=>s.variant === defaultVariant)[0]?.text;
        if(firstSpellingInDefaultVariant)
            return firstSpellingInDefaultVariant;

        // --- Otherwise, if the entry has a spelling in any variant, use the first
        //     such spelling as the base for the public id.
        const firstSpellingInAnyVariant = entry.spelling[0];
        if(firstSpellingInAnyVariant?.text)
            return firstSpellingInAnyVariant.text

        // --- Otherwise, use the entryId converted to a string as the base for the
        //     public id.
        return String(entry.entry_id);
    }

    dirForBookPage(publicBookId: string, pageNum: number): string {
        return `books/${publicBookId}/page-${String(pageNum).padStart(4, '0')}`;
    }

    pathForBookPage(publicBookId: string, pageNum: number): string {
        return this.dirForBookPage(publicBookId, pageNum)+'/index.html';
    }

    /**
     *
     */
    async publishBook(publicBookId: string) {
        const pagesInDocument = this.bookByFriendlyId(publicBookId).totalPages;
        for(let pageNum=1; pageNum<=pagesInDocument; pageNum++) {
            await this.publishItem(`Book ${publicBookId} page ${pageNum}`,
                                   ()=>this.publishBookPage(publicBookId, pageNum, pagesInDocument));
        }
    }
    
    /**
     *
     */
    async publishBookPage(publicBookId: string, page_number: number, total_pages_in_document: number) {
        const rootPath = '../../../../';

        // Everything from the bundle: book metadata, the Tagging layer id
        // (resolved at BUILD time - publishing is read-only), and the page's
        // scan data.  No db.
        const book = this.bookByFriendlyId(publicBookId);
        const document = book.document;
        const pageScan = book.pageScans[page_number-1]
            ?? panic(`no page scan for ${publicBookId} page ${page_number}`);

        const cfg: renderPageEditor.PageViewerConfig = {
            layer_id: book.taggingLayerId,
            reference_layer_ids: [],
            total_pages_in_document,
        };

        const {markup, groupIds} = renderPageEditor.renderAnnotatedPageFromData(cfg, pageScan);

        const infoBoxesById: Record<string, string> = {};
        for(const groupId of groupIds) {
            infoBoxesById[`bg_${groupId}`] = await this.renderDocumentReferenceInfoBox(rootPath, groupId);
        }
                
        const head = [
            //['link', {href: '/resources/page-viewer.css', rel:'stylesheet', type:'text/css'}],
            ['script', {src:'/scripts/wordwiki/page-viewer.js'}],
        ];

        const body = [
            ['div', {},
             ['h1', {}, `${document.title} - Page ${pageScan.page_number}`],
             cfg.title && ['h2', {}, cfg.title],
             this.renderBookPageTopNote(publicBookId, document),
             renderPageEditor.renderPageJumper(pageScan.page_number, total_pages_in_document,
                                               (page_number:number) => `${rootPath}${this.pathForBookPage(publicBookId, page_number)}`),
            ], // /div

            markup,

            this.renderBookPageCredit(publicBookId, document),

            ['script', {}, `infoBoxesById = ${JSON.stringify(infoBoxesById, undefined, 2)};`],

            // HACK to allow scrolling of info boxes even at end of document
            // TODO do something classier!
            ['div', {style: 'height: 50em;'}],
            
        ]; // body
        
        // 'https://numerique.banq.qc.ca/patrimoine/archives/52327/3216685'

        
        await Deno.mkdir(this.fsPath(this.dirForBookPage(publicBookId, page_number)), {recursive: true});

        await this.writePage(this.pathForBookPage(publicBookId, page_number),
                             this.publicPageTemplate(rootPath, {head, body}));
    }

    async renderBookPageTopNote(publicBookId: string, document: schema.ScannedDocument): Promise<any> {
        const rootPath = '../../../../';
        switch(publicBookId) {
            case 'PDM':
                return [
                    ['p', {},
                     `This is a page from the Pacifique Dictionary Manuscripts, a handwritten Mi'gmaq - French dictionary written in the first half of the 1900’s. `],
                    ['p', {}, `Click on a colored box to see the worked through construction of a modern dictionary entry from a source entry.`],
                    ['p', {}, 'The project is newly underway, pages that we have worked on are: ',
                     this.bookByFriendlyId(publicBookId).entryCountByPage.
                        filter(([pageNumber, entryCount]) => entryCount > 1).
                        map(([pageNumber, entryCount])=>
                            [['a', {href:`${rootPath}${this.pathForBookPage(publicBookId, pageNumber)}`}, `${pageNumber}`], ' '])
                ]];
                break;
            default:
                return [];
        }
    }
    
    async renderBookPageCredit(publicBookId: string, document: schema.ScannedDocument): Promise<any> {
        switch(publicBookId) {
            case 'PDM':
                return [
                    ['p', {}, 'The original manuscripts are housed at the Bibliothèque et Archives nationales du Québec (BAnQ), Rimouski. BAnQ provided these high quality tiff images to the project at no cost.'],

                    // Etudes Historiques et Geographiques https://numerique.banq.qc.ca/patrimoine/details/52327/2561563
                    //['p', {}, 'Pacifique Dictionary Manuscripts:'],

                    ['ul', {},
                     ['li', {}, ['a', {href:'https://numerique.banq.qc.ca/patrimoine/archives/52327/3216685'}, 'Pacifique Dictionary Manuscript Volume I at BANQ']],
                     ['li', {}, ['a', {href:'https://numerique.banq.qc.ca/patrimoine/archives/52327/3216686'}, 'Pacifique Dictionary Manuscript Volume II at BANQ']],
                     ['li', {}, ['a', {href:'https://numerique.banq.qc.ca/patrimoine/archives/52327/3216687'}, 'Pacifique Dictionary Manuscript Volume III at BANQ']],
                     ['li', {}, ['a', {href:'https://numerique.banq.qc.ca/patrimoine/archives/52327/3216688'}, 'Pacifique Dictionary Manuscript Volume IV at BANQ']]]
                ];
                break;
            default:
                return [];
        }
        //return ['p', {}, 'BOOK CREDIT for book ${publicBookId}'];
    }
    
    async renderDocumentReferenceInfoBox(rootPath: string, groupId: number): Promise<string> {
        // PUBLIC entries only (dz ruling 2026-07-08): a not-yet-public
        // entry's facts must not render onto the public book page, so its
        // group gets the same fallback a never-worked group always got.
        // (Historically this looked up the FULL editor projection and
        // leaked in-flight content - see publish-source.md.)
        const entry = this.entriesByReferenceGroupId.get(groupId);
        if(!entry)
            return (`Unknown group id ${groupId}`);
        this.warnMissingRecordings(entry);
        const entryMarkup:any[] = [
            'div', {style: 'overflow: auto;'},
            entryschema.renderEntry({rootPath, noTargetOnRefImages: false, docRefsFirst: true,
                                     scanRenderers: this.scanRenderers(),
                                     resolveAudioUrl: this.resolveAudioUrl}, entry)];
        const entryMarkupString = await asyncRenderToStringViaLinkeDOM(entryMarkup, false);
        //const entryMarkupString = renderToStringViaLinkeDOM(entryMarkup, true, entry.entry_id === 145979);
        // if(entry.entry_id === 145979) {  // ugsuguni
        //     console.info('SPECIAL ENTRY MARKUP STRING', entryMarkupString, 'for', JSON.stringify(entry, undefined, 2));
        //     console.info('MARKUP IS', JSON.stringify(entryMarkup, undefined, 2));
        // }
        return entryMarkupString;
        //return `<b>GROUP ${groupId} </b>`;
    }
    
    /**
     *
     */
    publicPageTemplate(rootPath: string, content: PublicPageContent): any {
        return (
            ['html', {},

             ['head', {},
              ['meta', {charset:"utf-8"}],
              ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
              content.title !== undefined ? ['title', {}, content.title] : undefined,
              config.bootstrapCssLink,
              // Shared theme (accent + link treatment + type) - same file the
              // editor loads, so the two sites match; then public-only layout.
              ['link', {href: `${rootPath}resources/site-theme.css`, rel:'stylesheet', type:'text/css'}],
              // TODO remove most of these css for the public side
              ['link', {href: `${rootPath}resources/public.css`, rel:'stylesheet', type:'text/css'}],
              ['link', {href: `${rootPath}resources/instance.css`, rel:'stylesheet', type:'text/css'}],
              ['link', {href: `${rootPath}resources/page-editor.css`, rel:'stylesheet', type:'text/css'}],
              ['link', {href: `${rootPath}resources/context-menu.css`, rel:'stylesheet', type:'text/css'}],
              ['script', {}, block`
    /**/           let imports = {};
    /**/           let activeViews = undefined`],


              ['script', {}, block`
    /**/           function playAudio(src) {
    /**/             const audioPlayer = document.getElementById("audioPlayer");
    /**/             if(!audioPlayer) throw new Error('could not find audio player');
    /**/             audioPlayer.src = src;
    /**/             audioPlayer.play ();
    /**/          }`],

              content.head,
              this.googleTag()
             ], // head

             ['body', {},

              this.publicNavBar(rootPath),

              // TODO probably move this somewhere else
              ['audio', {id:'audioPlayer', preload:'none'},
               ['source', {src:'', type:'audio/mpeg'}]],

              ['div', {class: 'page-content'},
               content.body,
              ],

              //view.renderModalEditorSkeleton(),

              config.bootstrapScriptTag

             ] // body
            ] // html
        );
    }

    googleTag(): any {
        return config.googleTagId ? [
            ['script', {'async':'', src:`https://www.googletagmanager.com/gtag/js?id=${config.googleTagId}`}],

            ['script', {}, block`
/**/          window.dataLayer = window.dataLayer || [];
/**/          function gtag(){dataLayer.push(arguments);}
/**/          gtag('js', new Date());
/**/          gtag('config', '${config.googleTagId}');`
            ]
        ] : [];
    }

    publicNavBar(rootPath: string): any {
        return [
            ['nav', {class:"navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body", 'data-bs-theme':"dark"},
             ['div', {class:"container-fluid"},
              ['a', {class:"navbar-brand", href:rootPath+this.homePath}, 'MMO'],
              ['button', {class:"navbar-toggler", type:"button", 'data-bs-toggle':"collapse", 'data-bs-target':"#navbarSupportedContent", 'aria-controls':"navbarSupportedContent", 'aria-expanded':"false", 'aria-label':"Toggle navigation"},
               ['span', {class:"navbar-toggler-icon"}],
              ], //button

              ['div', {class:"collapse navbar-collapse", id:"navbarSupportedContent"},
               ['ul', {class:"navbar-nav me-auto mb-2 mb-lg-0"},

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.homePath}, 'Home'],
                ], //li

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.categoriesDirectoryPath}, 'Categories'],
                ], //li

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.topWordsDirectoryPath}, 'Top Words'],
                ], //li

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.allWordsPath}, 'All Words'], // XXX FIX PATH XXX
                ], //li

                ['li', {class:"nav-item"},
                 // XXX hack - starting at P307 for reasons ...
                 ['a', {class:"nav-link", href:rootPath+'books/PDM/page-0307/index.html'}, 'Pacifique Manuscript'],
                ], //li

                // --- Reference Books
                ['li', {class:"nav-item dropdown"},
                 ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
                  'Reference Books'
                 ], //a
                 ['ul', {class:"dropdown-menu"},
                  ['li', {}, ['a', {class:"dropdown-item", href:rootPath+'books/PDM/page-0001/index.html'}, 'Pacifique Manuscript']],
                  ['li', {}, ['a', {class:"dropdown-item", href:rootPath+'books/Rand/page-0001/index.html'}, "Rand's Dictionary"]],
                  ['li', {}, ['a', {class:"dropdown-item", href:rootPath+'books/Clark/page-0001/index.html'}, "Clark's Dictionary"]],
                  ['li', {}, ['a', {class:"dropdown-item", href:rootPath+'books/PacifiquesGeography/page-0001/index.html'}, "Pacifique's Geography"]],
                  ['li', {}, ['a', {class:"dropdown-item", href:rootPath+'books/RandFirstReadingBook/page-0001/index.html'}, "Rand's First Reading Book"]],
                  //['li', {}, ['hr', {class:"dropdown-divider"}]],
                  //['li', {}, ['a', {class:"dropdown-item", href:"#"}, 'Something else here']],
                 ], //ul
                ], //li


                
                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:'/ww/'}, 'Editor'], // FIX PATH XXX
                ], //li
                
                // ['li', {class:"nav-item"},
                //  ['a', {class:"nav-link", href:rootPath+this.aboutUsPath}, 'About Us'], // FIX PATH XXX
                // ], //li

                



                // // --- Reference Books
                // ['li', {class:"nav-item dropdown"},
                //  ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
                //   'Reference Books'
                //  ], //a
                //  ['ul', {class:"dropdown-menu"},
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("PDM")'}, 'PDM']],
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("Rand")'}, 'Rand']],
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("Clark")'}, 'Clark']],
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("RandFirstReadingBook")'}, 'RandFirstReadingBook']],
                //   //['li', {}, ['hr', {class:"dropdown-divider"}]],
                //   //['li', {}, ['a', {class:"dropdown-item", href:"#"}, 'Something else here']],
                //  ], //ul
                // ], //li

               ], //ul

               // // Search form
               // ['form', {class:"d-flex", role:"search", method:'get', action:'/ww/wordwiki.searchPage(query)'},
               //  ['input', {id:'searchText', name:'searchText', class:"form-control me-2", type:"search", placeholder:"Search", 'aria-label':"Search"}],
               //  ['button', {class:"btn btn-outline-success", type:"submit"}, 'Search'],
               // ], //form

              ], //div navbar-collaplse

             ], //div container
            ], //nav
        ];
    }
}

export async function writePageFromMarkupIfChanged(path: string, pageMarkup: any): Promise<boolean> {
    const html = await asyncRenderToStringViaLinkeDOM(pageMarkup);
    return writeUTF8FileIfContentsChanged(path, html);
}



/**
 * The publish URL routes, namespaced under `wordwiki.publish` so the strict
 * route interpreter's member @route gate covers them (they used to be bare
 * top-level scope functions, which routeterp does NOT gate - see
 * render-page-editor.ts PageRoutes for the rationale).  Both are `hostOrAdmin`:
 * pushing the public site is a release/curator task.
 *
 * Neither is marked `mutates`: startPublish is triggered by a GET navbar link
 * and publishStatus is a GET status view (both redirect via forwardResponse), so
 * POST-only gating would 405 them.  startPublish IS state-changing over GET -
 * acceptable here because it is admin-only; harden to a POST form if wanted.
 */
export class PublishRoutes {
    @route(hostOrAdmin) startPublish(...a: Parameters<typeof startPublish>) { return startPublish(...a); }
    @route(hostOrAdmin) publishStatus(...a: Parameters<typeof publishStatus>) { return publishStatus(...a); }
}


// function makeJsonForCategoryPlay() {
//     const wordWiki = getWordWiki();
//     const publishedEntries = wordWiki.publishedEntries;
//     const jsonForCats = publishedEntries.map(e=>
//         ({
//             entry_id: e.entry_id,
//         }));
// }

if (import.meta.main) {
    const args = Deno.args;
    const command = args[0];
    switch(command) {
        case 'publishHomePages':
            console.time('publishHomePages');
            publish({
                suppressPublishBooks: true,
                suppressPublishCategories: true,
                suppressPublishEntries: true
            });
            console.timeEnd('publishHomePages');
            break;
        // case 'makeJsonForCategoryPlay':
        //     makeJsonForCategoryPlay();
        //     break;
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
    
}
