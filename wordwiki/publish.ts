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
import {getWordWiki, WordWiki} from './wordwiki.ts';
import { writeUTF8FileIfContentsChanged } from '../liminal/ioutils.ts';
import * as entryschema from './entry-schema.ts';
import * as category from './category.ts';
import {Entry} from './entry-schema.ts';
import * as audio from './audio.ts';  // REMOVE_FOR_WEB
import * as schema from './scanned-document.ts';
import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../liminal/markup.ts';
import * as renderPageEditor from './render-page-editor.ts';

export const REFERENCE_BOOK_IDS =
    ['PDM', 'Rand', 'Clark', 'PacifiquesGeography', 'RandFirstReadingBook'];

export class PublishStatus {
    startTime?: number = undefined;
    endTime?: number = undefined;
    log: string[] = [];
    errors: string[] = [];
    // Warnings vs errors: an ERROR means a page could not be published (and
    // reads as "the site is broken"); a WARNING means the page published but
    // the publish - as the final validation of everything - noticed a
    // data problem to deal with (e.g. a recording with no audio file).
    warnings: string[] = [];

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
             publishStatus.errors.map(e=>[
                 ['li', {}, e]
             ])
            ]] : [],

        // Deliberately calm (amber, not red): the pages ARE published; these
        // are data items to deal with, found by publish-as-final-validation.
        (publishStatus.warnings.length > 0) ? [
            ['h2', {style: "color: darkgoldenrod"},
             `Warnings (${publishStatus.warnings.length})`],
            ['p', {}, 'These pages published fine - each warning is a data item to fix when convenient.'],
            ['ul', {},
             publishStatus.warnings.map(e=>[
                 ['li', {}, e]
             ])
            ]] : [],

        (publishStatus.log.length > 0) ? [
            ['h2', {}, 'Recent Tasks'],
            ['ul', {},
             publishStatus.log.slice(-500).toReversed().map(e=>[
                 ['li', {}, e]
             ])
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
        return server.forwardResponse('/ww/publishStatus(true)');
    } else {
        (async ()=>{
            publishStatusSingleton.start();
            try {
                const wordWiki = getWordWiki();
                const publish = new Publish(publishStatusSingleton,
                                            wordWiki,
                                            wordWiki.publishedEntries);
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
        return server.forwardResponse('/ww/publishStatus(false)');
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
        const publish = new Publish(publishStatusSingleton,
                                    wordWiki,
                                    wordWiki.publishedEntries,
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
        publishStatusSingleton.errors.forEach(e=>console.info(e));
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
 *   categories                       categories directory + every category page
 *   categories/water                 one category page
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
    | {kind: 'categories-all'}
    | {kind: 'category', slug: string}
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
        `index.html, categories, categories/water, books/PDM/page-0101, ` +
        `entries/samqwan, entry:121590 (see parsePublishTarget in publish.ts)`);
}

export class Publish {
    entryToPublicId: Map<Entry, string>;
    defaultVariant: string = 'mm-li';

    constructor(public status: PublishStatus, public wordWiki: WordWiki,
                public entries: Entry[],
                public publishRoot: string = '.',
                public options: PublishOptions = {}) {
        this.entryToPublicId = this.computeEntryPublicIds(entries, this.defaultVariant);
    }

    // Path discipline: every `*Path`/`pathFor*` helper returns a
    // SITE-RELATIVE path (they double as href sources, so they must never
    // contain publishRoot); every filesystem write/mkdir goes through
    // fsPath(), the ONE place publishRoot is applied.
    fsPath(sitePath: string): string {
        return `${this.publishRoot}/${sitePath}`;
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
            try {
                return new Map(this.wordWiki.categories.allByOrder.all({})
                    .map(c => [c.slug, c]));
            } catch (_e) {
                return new Map();   // pre-import db: no category table yet
            }
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
                    `Entry '${name}': recording${r.speaker ? ` by ${r.speaker}` : ''} has no audio file`);
        for(const sub of entry.subentry ?? [])
            for(const ex of sub.example ?? [])
                for(const r of ex.example_recording ?? [])
                    if(missing(r.recording))
                        this.status.warnings.push(
                            `Entry '${name}': example recording${r.speaker ? ` by ${r.speaker}` : ''} has no audio file`);
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
        const cats = Array.from(this.wordWiki.getCategories().entries())
            .filter(([slug, _n]) => !category.isInternalCategorySlug(slug));
        const order = new Map(Array.from(this.categoryBySlug.keys()).map((slug, i) => [slug, i]));
        return cats.toSorted(([a], [b]) =>
            (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)
            || this.wordWiki.sourceLangCollator.compare(a, b));
    }

    /**
     * The public categories as THEME GROUPS (the shared grouping from
     * category.ts: themes in table order, names sorted within), for the
     * public categories page.  Un-tabled values (pre-import) trail in an
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
            .toSorted(([a], [b]) => this.wordWiki.sourceLangCollator.compare(a, b))
            .map(([slug, count]) => ({slug, name: slug, count}));
        if(untabled.length > 0)
            groups.push({theme: groups.length > 0 ? 'Other categories' : 'Categories',
                         cats: untabled});
        return groups;
    }

    async publish(): Promise<void> {
        // --- If publish root dir does not exist, create it.
        await Deno.mkdir(this.publishRoot, {recursive: true});

        // --- Publish top level pages
        await this.publishItem('Home Page', ()=>this.publishHomePage());
        await this.publishItem('404 Page', ()=>this.publish404Page());
        await this.publishItem('All Words Page', ()=>this.publishAllWordsPage());
        await this.publishItem('About Us', ()=>this.publishAboutUsPage());

        // --- Publish books
        if(!this.options.suppressPublishBooks) {
            for(const book of REFERENCE_BOOK_IDS)
                await this.publishBook(book);
        }

        // --- Publish categories
        if(!this.options.suppressPublishCategories) {
            await this.publishCategoriesDirectory();
            await this.publishCategories();
        }

        // --- Publish all entries
        if(!this.options.suppressPublishEntries) {
            await this.publishEntries();
        }
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
                case 'categories-all':
                    await this.publishItem('Categories Directory', ()=>this.publishCategoriesDirectory());
                    await this.publishCategories();
                    break;
                case 'category':
                    await Deno.mkdir(this.fsPath(this.categoriesDir), {recursive: true});
                    await this.publishItem(`Category ${t.slug}`, ()=>this.publishCategory((t as any).slug));
                    break;
                case 'books-all':
                    for(const book of REFERENCE_BOOK_IDS)
                        await this.publishBook(book);
                    break;
                case 'book':
                    await this.publishBook(t.book);
                    break;
                case 'book-page': {
                    const document = schema.selectScannedDocumentByFriendlyId()
                        .required({friendly_document_id: t.book});
                    const pagesInDocument = schema.maxPageNumberForDocument()
                        .required({document_id: document.document_id}).max_page_number;
                    const tt = t;
                    await this.publishItem(`Book ${tt.book} page ${tt.page}`,
                                           ()=>this.publishBookPage(tt.book, tt.page, pagesInDocument));
                    break;
                }
                case 'entries-all':
                    for(const entry of this.entries)
                        await this.publishItem(`Entry ${entryschema.renderEntrySpellingsSummary(entry)}`,
                                               ()=>this.publishEntry(entry));
                    break;
                case 'entry-public-id': {
                    const entry = this.entryByPublicId.get(t.publicId);
                    if(!entry) {
                        this.status.errors.push(
                            `no published entry with public id '${t.publicId}' ` +
                            `(public ids are the entry-page filenames, e.g. 'samqwan')`);
                        break;
                    }
                    await this.publishItem(`Entry ${t.publicId}`, ()=>this.publishEntry(entry));
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
                    await this.publishItem(`Entry ${tid}`, ()=>this.publishEntry(entry));
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

    async publishItem(itemDesc: string, itemPromise: ()=>Promise<void>): Promise<void> {
        let error: Error|undefined = undefined;
        //console.info(`publish ${itemDesc}`);
        try {
            await (itemPromise());
        } catch(e) {
            error = e as Error; // bad cast XXX
        } finally {
        }
        if(error)
            this.status.errors.push(`${itemDesc}: ${error.toString()}`);
        else
            this.status.log.push(itemDesc);
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
             ['div', {class: 'public-search-box'},
              ['form', {onsubmit:"updateCurrentSearchFromInput(); event.preventDefault();"},

               ['h3', {}, 'Dictionary Search'],

               
               ['label', {for:"search", style:"font-size: larger; font-weight: bold;"}, 'Search: '],
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
               ['li', {}, "Click on 🔉 to hear a recording of the word."],
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
        
        await writePageFromMarkupIfChanged(this.fsPath(this.homePath), this.publicPageTemplate('', {title, head, body}));
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
        
        await writePageFromMarkupIfChanged(this.fsPath(this.fourOhFourPath), this.publicPageTemplate('', {title, body}));
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
        
        await writePageFromMarkupIfChanged(this.fsPath(this.allWordsPath),
                                           this.publicPageTemplate('', {title, body}));
    }

    get aboutUsPath(): string {
        return 'about-us.html';
    }
    
    async publishAboutUsPage(): Promise<void> {

        const title = "About Us - Mi'gmaq/Mi'kmaq Online Talking Dictionary";
        const body = 
            ['div', {},
             ['h1', {}, title],

             this.renderAboutUsBody()
            ];
        
        await writePageFromMarkupIfChanged(this.fsPath(this.aboutUsPath),
                                           this.publicPageTemplate('', {title, body}));
    }

    /**
     *
     */
    renderAboutUsBody(): any {
        return [
            // --- MMO info
            ['h3', {}, 'The Talking Dictionary'],

            ['p', {}, `The talking dictionary (Nnuigtug Ugsituna’tas’g Glusuaqanei) is a resource for the Mi'gmaq/Mi’kmaq language. Each headword is recorded by a minimum of three speakers. Multiple speakers allow one to hear differences and variations in how a word is pronounced. Each recorded word is used in an accompanying phrase. This permits learners the opportunity to develop the important skill of distinguishing individual words when they are spoken in a phrase.`],

            ['p', {}, 'Thus far we have posted ', ['a', {href: './all-words.html'}, `${this.entries.length} headwords`], ', a majority of these entries include two to three additional forms.'],
            ['p', {}, `The project was initiated in Listuguj, therefore all entries have Listuguj speakers and Listuguj spellings. In collaboration with Unama'ki, the site now includes a number of recordings from Unama'ki speakers. More will be added as they become available. `,
             `Listuguj is in the Gespe'g territory of the Mi'gmaw, located on the southwest shore of the Gaspè peninsula. Unama'ki is a Mi’gmaw territory; in English it is known as Cape Breton.`],

            ['p', {}, `Follow our word of the day posts in three orthographies on `,
             ['a', {href:'https://x.com/Pemaptoq'}, 'X'], ' or on ',
             ['a', {href:'https://bsky.app/profile/pemaptoq.bsky.social'}, 'Bluesky']],
            
            ['h3', {}, 'Pacifique Dictionary Manuscripts project'],
            
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

            ['h3', {}, 'Watch Us Working'],
            ['iframe',  {width:"560", height:"315", src:"https://www.youtube.com/embed/8Sq4Z_5xdUw?si=eIFs7BqZQ8-WkA8B", title:"YouTube video player", frameborder:"0", allow:"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share", referrerpolicy:"strict-origin-when-cross-origin", allowfullscreen:''}],
            ['br', {}],
            
            ['h3', {}, 'Contact Us'],
            ['p', {},
              'Email:', ['a', {href:'mailto:info@mikmaqonline.org'}, 'info@mikmaqonline.org']],

            ['h3', {}, 'Thanks'],

            ['p', {}, "Ta'n te'sijig mimajuinu'g apoqonmugsieg ula ntlugowaqannen wesgo'tmeg we'gwiwela'lieg aq we'gwimi'watmuleg."],

            ['p', {}, "We gratefully acknowledge and appreciate the support of all the people who have helped us with our work."],
            
            ['h3', {}, "We gratefully acknowledge the financial support of:"],
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
                audio.renderAudio(sampleRecording.recording, '🔉', undefined, rootPath) : [],
        ];
    }

    /**
     *
     */
    async publishEntries(): Promise<void> {

        for(const entry of this.entries) {
            await this.publishItem(`Entry ${this.getPublicIdForEntry(entry)}`, ()=>this.publishEntry(entry));
        }

        // Generate .html files that forward our old URLS to our new ones (using meta refresh)
        await Deno.mkdir(this.fsPath('servlet/words'), {recursive: true});
        for(const entry of this.entries) {
            await this.publishItem(`Entry Forwarder ${this.getPublicIdForEntry(entry)}`, ()=>this.publishEntryForwarder(entry));
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
        const entryMarkup:any[] = entryschema.renderEntry({rootPath}, entry);
        // renderCategoriesForEntry here.

        const entryCategories = this.publicEntryCategories(entry);
        const relatedCategoryMarkup =
            entryCategories.map(category=>[
                ['h3', {}, `Related entries for category "${this.publicCategoryName(category)}"`],
                ['div', {},
                 ['ul', {},
                  (this.wordWiki.entriesByCategory.get(category)??[])
                      .map(e=>['li', {}, this.renderEntryPublicLink(rootPath, e, false)]),
                 ] // ul
                ] // div
            ]);

        const body = [
            entryMarkup,
            relatedCategoryMarkup,
        ];
                                
        await writePageFromMarkupIfChanged(this.fsPath(entryPath), this.publicPageTemplate(rootPath, {title, body}));
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
                                
        await writePageFromMarkupIfChanged(this.fsPath(entryForwarderPath), this.publicPageTemplate('../../', {title, head, body}));
    }

    get categoriesDir(): string {
        return 'categories';
    }
    
    get categoriesDirectoryPath(): string {
        return 'categories.html';
    }

    pathForCategory(category: string): string {
        return `${this.categoriesDir}/${category.replaceAll(/[^a-zA-Z0-9-']/g, '_')}.html`;
    }
    
    /**
     *
     */
    async publishCategoriesDirectory(): Promise<void> {
        const title = `Categories Directory`;

        const body = [
            ['h1', {}, title],
            this.publicCategoryGroups().map(group => [
                ['h2', {}, group.theme],
                ['ul', {},
                 group.cats.map(c =>
                     ['li', {}, ['a',
                                 {href:this.pathForCategory(c.slug)},
                                 c.name, ` (${c.count} entries)`]])],
            ]),
        ];
        await writePageFromMarkupIfChanged(this.fsPath(this.categoriesDirectoryPath), this.publicPageTemplate('', {title, body}));
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

        //const entriesForCategory = this.wordWiki.getEntriesForCategory(category);
        const entriesForCategory = this.wordWiki.entriesByCategory.get(category)??[];
        
        const title = ['Entries for category ', this.publicCategoryName(category)];
        
        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesForCategory
                  .map(e=>['li', {}, this.renderEntryPublicLink('../', e)]),
             ] // ul
            ] // div
        ];

        await writePageFromMarkupIfChanged(this.fsPath(this.pathForCategory(category)), this.publicPageTemplate('../', {title, body}));
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
        const document = schema.selectScannedDocumentByFriendlyId().required({friendly_document_id: publicBookId});
        const pagesInDocument = schema.maxPageNumberForDocument().
            required({document_id: document.document_id}).max_page_number;
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
        const reference_layer_name = 'Text';
        
        const document = schema.selectScannedDocumentByFriendlyId().required({friendly_document_id: publicBookId});
        const document_id = document.document_id;
        const taggingLayer = schema.getOrCreateNamedLayer(document_id, 'Tagging', 0);

        const referenceLayer = schema.selectLayerByLayerName().required({document_id, layer_name: reference_layer_name});
        const page = schema.selectScannedPageByPageNumber().required({document_id, page_number});

        const cfg: renderPageEditor.PageViewerConfig = {
            layer_id: taggingLayer,
            //reference_layer_ids: [referenceLayer.layer_id],
            reference_layer_ids: [],
            total_pages_in_document,
        };

        const {markup, groupIds} = renderPageEditor.renderAnnotatedPage(cfg, page.page_id);

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
             ['h1', {}, `${document.title} - Page ${page.page_number}`],
             cfg.title && ['h2', {}, cfg.title],
             this.renderBookPageTopNote(publicBookId, document),
             renderPageEditor.renderPageJumper(page.page_number, total_pages_in_document,
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

        await writePageFromMarkupIfChanged(this.fsPath(this.pathForBookPage(publicBookId, page_number)),
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
                     this.wordWiki.entryCountByPage.
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
        const entry = this.wordWiki.entriesByReferenceGroupId.get(groupId);
        if(!entry)
            return (`Unknown group id ${groupId}`);
        this.warnMissingRecordings(entry);
        const entryMarkup:any[] = [
            'div', {style: 'overflow: auto;'},
            entryschema.renderEntry({rootPath, noTargetOnRefImages: false, docRefsFirst: true}, entry)];
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



export const routes = ()=> ({
    startPublish,
    publishStatus,
});


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
