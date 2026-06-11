// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as markup from '../liminal/markup.ts';
import * as model from './model.ts';
import * as renderPageEditor from './render-page-editor.ts';
import * as server from '../liminal/http-server.ts';
import * as strings from "../liminal/strings.ts";
import * as utils from "../liminal/utils.ts";
import * as random from "../liminal/random.ts";
import {panic} from '../liminal/utils.ts';
import * as workspace from './workspace.ts';
import {VersionedDb} from  './workspace.ts';
import * as config from './config.ts';
import * as entry from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as templates from './templates.ts';
import * as orderkey from '../liminal/orderkey.ts';
import * as audio from './audio.ts';
import {block} from '../liminal/strings.ts';
import {db} from "../liminal/db.ts";
import * as publish from './publish.ts';
import {asyncRenderToStringViaLinkeDOM} from '../liminal/markup.ts';
import {ScannedDocument, ScannedPage, Layer, BoundingGroup, selectScannedDocumentByFriendlyId, selectBoundingBoxesForGroup, getOrCreateNamedLayer, selectScannedPageByPageNumber, allScannedDocumentSchemaDml} from './scanned-document.ts';
import {Assertion, updateAssertion, assertionPathToFields, getAssertionPath, highestTimestamp, selectAllAssertions, createAssertionDml} from './assertion.ts';
import {dictSchemaJson} from "./entry-schema.ts";
import {pageEditor, PageEditorConfig, renderStandaloneGroup} from './render-page-editor.ts';
import * as pageEditorModule from './page-editor.ts';
import * as pageViewerModule from './page-viewer.ts';

import {LiminalApp, type TestClientSession, type TestCase} from '../liminal/liminal.ts';
import * as schemaUpgrade from '../liminal/schema-upgrade.ts';
import * as security from '../liminal/security.ts';
import * as passwordUtils from '../liminal/password.ts';
import * as date from '../liminal/date.ts';
import {serialize, path} from '../liminal/serializable.ts';
import {lazy} from '../liminal/lazy.ts';
import {LexemeEditor} from './lexeme-editor.ts';
import * as user from './user.ts';
import * as category from './category.ts';
import * as categoryImport from './category-import.ts';
import * as lexicalForm from './lexical-form.ts';
import * as lexicalFormImport from './lexical-form-import.ts';

/**
 *
 */
export class WordWiki extends LiminalApp {
    routes: Record<string, any>;
    dictSchema: model.Schema;
    #workspace: VersionedDb|undefined = undefined;
    #entries: entry.Entry[]|undefined = undefined;
    #entriesById: Map<number, entry.Entry>|undefined = undefined;
    #entriesByCategory: Map<string, entry.Entry[]>|undefined = undefined;
    #publishedEntries: any|undefined = undefined;
    #publishedEntriesByCategory: Map<string, entry.Entry[]>|undefined = undefined;
    #entriesByReferenceGroupId: Map<number, entry.Entry>|undefined = undefined;
    #entryCountByPage: Array<[number, number]>|undefined = undefined;
    #lastAllocatedTxTimestamp: number|undefined;
    sourceLangCollator = Intl.Collator('en'); // TODO make configurable XXX
    
    /**
     *
     */
    constructor() {
        super();

        // --- Load schema and create an empty workspace
        this.dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
        // --- Set up our routes
        this.routes = Object.assign(
            {},
            {wordwiki: this},
            renderPageEditor.routes(),
            audio.routes(),
            publish.routes(),
        );
    }

    [serialize](): string {
        return 'wordwiki';
    }

    // ----- New-style (liminal Table) tables ----------------------------------

    @path get config() { return new config.ConfigTable(); }
    @path get users() { return new user.UserTable(); }
    @path get passwordHash() { return new user.PasswordHashTable(); }
    @path get userSession() { return new user.UserSessionTable(); }
    @path get categories() { return new category.CategoryTable(); }
    @path get lexicalForms() { return new lexicalForm.LexicalFormTable(); }

    // The new-style tables (auto-created at startup; the legacy raw-DML tables
    // - scanned documents, bounding boxes, the dict assertion table - stay in
    // schema.ts).  More rabid-style tables will be added here over time.
    @lazy get tables() {
        return [this.config, this.users, this.passwordHash, this.userSession,
                this.categories, this.lexicalForms];
    }

    // Create the new-style tables if missing (idempotent CREATE IF NOT EXISTS).
    ensureNewStyleTables() {
        for(const t of this.tables)
            db().executeStatements(t.createDMLString());
    }

    // The v2 (server-side htmx) lexeme editor, reachable as wordwiki.lexeme.*
    // (e.g. /ww/wordwiki.lexeme.entryPage(<entry_id>)).  See lexeme-editor-design.md.
    #lexeme: LexemeEditor|undefined = undefined;
    get lexeme(): LexemeEditor {
        return this.#lexeme ??= new LexemeEditor(this);
    }

    // ----- New-style pages ----------------------------------------------------

    usersPage(): templates.Page {
        return templates.page('Users', this.users.renderUsersPage());
    }

    // The category VOCABULARY admin page (the controlled list of categories) -
    // distinct from categoriesDirectory(), the entries-by-category report.
    categoriesPage(): templates.Page {
        return templates.page('Category Table', this.categories.renderCategoriesPage());
    }

    // The lexical form (part of speech) vocabulary admin page.
    lexicalFormsPage(): templates.Page {
        return templates.page('Lexical Form Table', this.lexicalForms.renderLexicalFormsPage());
    }

    get lastAllocatedTxTimestamp() {
        // TODO as we add more tables, this will need to be extended.
        return this.#lastAllocatedTxTimestamp ??= highestTimestamp('dict');
    }

    allocTxTimestamps(count: number=1, opts: {quiet?: boolean} = {}) {
        const lastTxTimestamp = this.lastAllocatedTxTimestamp;
        const nextTxTimestamp = timestamp.nextTime(lastTxTimestamp);
        utils.assert(count>=1);
        this.#lastAllocatedTxTimestamp = nextTxTimestamp + count - 1;
        if(!opts.quiet)
            console.info('alloced timestamp', {last: lastTxTimestamp, next: nextTxTimestamp, next_txt: timestamp.formatTimestampAsLocalTime(nextTxTimestamp)});
        return nextTxTimestamp;
    }

    get workspace() {
        return this.#workspace ??= (()=>{

            // --- Create workspace
            const workspace = new VersionedDb([this.dictSchema]);

            // --- Do load of dictionary
            const assertions = selectAllAssertions('dict').all();
            assertions.forEach((a:Assertion)=>workspace.untrackedApplyAssertion(a));

            return workspace;
        })();
    }

    requestWorkspaceReload() {
        this.#workspace = undefined;
        this.requestEntriesJSONReload();
    }

    requestEntriesJSONReload() {
        this.#entries = undefined;
        this.#entriesByCategory = undefined;
        this.#entriesById = undefined;
        // This needs to be more complicated when publishing multiple dialects.
        this.#publishedEntries = undefined;
        this.#publishedEntriesByCategory = undefined;
        this.#entriesByReferenceGroupId = undefined;
        this.#entryCountByPage = undefined;
    }

    /**
     *
     */
    get entries(): entry.Entry[] {
        return this.#entries ??=
            new workspace.CurrentTupleQuery(this.workspace.getTableByTag('dct')).toJSON().entry;
    }

    get publishedEntries(): entry.Entry[] {
        return this.#publishedEntries ??=
            Array.from(this.entries.filter(e=>entry.isPublished(e)));
    }

    get entriesByReferenceGroupId(): Map<number, entry.Entry> {
        return this.#entriesByReferenceGroupId ??= (()=>{
            const refToEntry: Array<[number, entry.Entry]> = this.entries.flatMap(e=>e.subentry.flatMap(s=>
                s.document_reference.map(d=>[d.bounding_group_id, e] as [number, entry.Entry])));
            return new Map(refToEntry);
        })();
    }

    get entriesById(): Map<number, entry.Entry> {
        return this.#entriesById ??= (()=>
            new Map(this.entries.map(e=>[e.entry_id, e])))();
    }
    
    applyTransactions(assertions: Assertion[]) {

        // --- Partition assertions into txes by valid_from
        const txIds = assertions.map(a=>a.valid_from);
        utils.assert(txIds.join(',') === txIds.toSorted((a,b)=>a-b).join(','),
                     'assertions in a tx group must be in valid_from order');
        const transactionsById = Map.groupBy(assertions, a=>a.valid_from);

        try {
            db().transaction(()=>{
                Array.from(transactionsById.values()).forEach(a=>this.applyTransaction(a));
            });
        } catch (e) {
            // --- Request workspace reload
            this.requestWorkspaceReload();
            throw e;
        }
    }

    /**
     * This should probaly move to workspace.
     *
     */
    applyTransaction(assertions: Assertion[], opts: {quiet?: boolean} = {}) {

        if(!opts.quiet)
            console.info('Applying TX',
                         JSON.stringify(assertions, undefined, 2));

        // --- Allocate a new server timestamp for this tx
        //     TODO we may want to allocate multiple here to give client new base.
        const serverTimestamp = this.allocTxTimestamps(1, opts);

        // --- No assertions can be trivially applied (we check this
        //     because our consistency checks can't handle this case)
        if(assertions.length === 0)
            return;

        // ---- Validate that this is a single tx (all assertions have the same
        //      valid_from)
        // THIS WILL NOT BE TRUE FOR OUR NEW SAVE FEATURE, IT CONSISTS OF MULTIPLE TXes.
        // (with potential repeated writes to the same assertion).
        // HOW TO HANDLE THIS:
        //  - they will be in order - do we want to break it down into separate txes
        //    (or have that be part of the update protocol so we don't have to reverse
        //    engineer it.
        //  - do we want applying all the TXes to be one DB transaction? - if not, we can
        //    just break it down into multiple Txes and apply them separately.
        //  - this is probably fine for now (we can wrap the whole outer thing in a DB tx
        //    to ...)

        const clientTimestamp = assertions[0].valid_from;
        assertions.forEach(a=>{
            if(a.valid_from !== clientTimestamp)
                throw new Error(`All assertions in a transaction must have the same timestamp`);
            if(!(a.valid_to === timestamp.END_OF_TIME || a.valid_to === clientTimestamp))
                throw new Error(`Assertions can either be valid to the tx time (a delete tombstone) or valid till the end of time`);
        });

        try {
            // --- Rewrite client timestamps to our newly allocated server timestamp
            assertions.forEach(a=>{
                if(a.valid_from === clientTimestamp)
                    a.valid_from = serverTimestamp;
                if(a.valid_to === clientTimestamp)
                    a.valid_to = serverTimestamp;
            });

            if(!opts.quiet)
                console.info('Applying TX after advancing to server timestamp',
                             serverTimestamp,
                             JSON.stringify(assertions, undefined, 2));

            // --- Apply assertions to workspace (throwing exception if incompatible)
            // TODO swith to an apply method that gives us enough info to update the valid_to
            //      on the prev record.
            const updatedPrevAssertions =
                assertions.map(a=>this.workspace.applyProposedAssertion(a));

            // --- Apply assertions to DB (in a TX) doing some confirmation as we go.
            db().transaction(()=>{
                // Trick here is that we need prev txids - workspace can give us those.
                // Then can load them an confirm that their valid_to matches, then update.
                // We can get the whole prev anyway.
                // For now, just persist as they are.
                // TODO XXX embedding 'dict' in here is BAD (also in insert)
                updatedPrevAssertions.forEach(p=>
                    p && updateAssertion('dict', p.assertion_id, ['valid_to'], {valid_to: p.valid_to}));
                assertions.forEach(a=>
                    db().insert<Assertion, 'assertion_id'>('dict', a, 'assertion_id'));
            });

            // --- Request rebuld of entries JSON
            this.requestEntriesJSONReload();

        } catch (e) {
            // --- Request workspace reload
            this.requestWorkspaceReload();
            throw e;
        }
    }

    /**
     * Create a new (empty) lexeme - an entry with one subentry - and redirect
     * to it in the editor.  Reached by the navbar "Add New Entry" form POST
     * (a POST so link prefetch/prerender can't create entries).
     */
    newLexemeAction(): server.Response {
        const tx_time = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);  // placeholder; applyTransaction allocates

        const entry_id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const newEntryAssertion: Assertion = {
            assertion_id: entry_id,
            valid_from: tx_time,
            valid_to: timestamp.END_OF_TIME,
            id: entry_id,
            ty: 'ent',
            ty0: 'dct',
            ty1: 'ent',
            id1: entry_id,
            order_key: orderkey.new_range_start_string,
            change_by_username: this.currentUsername(),
        };

        const subentry_id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const newSubEntryAssertion: Assertion = {
            assertion_id: subentry_id,
            valid_from: timestamp.nextTime(tx_time),
            valid_to: timestamp.END_OF_TIME,
            id: subentry_id,
            ty: 'sub',
            ty0: 'dct',
            ty1: 'ent',
            id1: entry_id,
            ty2: 'sub',
            id2: subentry_id,
            order_key: orderkey.new_range_start_string,
            change_by_username: this.currentUsername(),
        };

        this.applyTransactions([newEntryAssertion, newSubEntryAssertion]);

        return server.forwardResponse(`/ww/wordwiki.entry(${entry_id})`);
    }

    // The entry editor (the server-side htmx lexeme editor - the old
    // client-side editor is retired).
    entry(entry_id: number): templates.Page {
        return this.lexeme.entryPage(entry_id);
    }

    home(): any {
        const title = "Dictionary Editor";
        const body = [
            ['h1', {}, title],

            ['br', {}],
            ['h3', {}, 'Search'],
            this.searchForm(),
            // --- Add new entry button
            // ['div', {},
            //  ['button', {onclick:'imports.launchNewLexeme()'}, 'Add new Entry']],

            ['br', {}],
            ['h3', {}, 'Reports'],
            ['ul', {},
             ['li', {}, ['a', {href:'/ww/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM Page']],
             ['li', {}, ['a', {href:'/ww/wordwiki.todoReport(null, null)'}, 'TODO Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByPronunciation()'}, 'Entries By Pronunciation']],
             //['li', {}, ['a', {href:'/ww/wordwiki.entriesByEnglishGloss()'}, 'Entries by English Gloss']],
            ],

            ['br', {}],
            ['h3', {}, 'Reference Books'],
            ['ul', {},
             ['li', {}, ['a', {href:`/ww/pageEditor("PDM")`}, 'PDM']],
             ['li', {}, ['a', {href:`/ww/pageEditor("Rand")`}, 'Rand']],
             ['li', {}, ['a', {href:`/ww/pageEditor("Clark")`}, 'Clark']],
             ['li', {}, ['a', {href:`/ww/pageEditor("PacifiquesGeography")`}, 'PacifiquesGeography']],
             ['li', {}, ['a', {href:`/ww/pageEditor("RandFirstReadingBook")`}, 'RandFirstReadingBook']]],
        ];

        return templates.pageTemplate({title, body});
    }

    searchForm(search?: string): any {
        return [
            ['form', {class:'row row-cols-lg-auto g-3 align-items-center', name: 'search', method: 'get', action:'/ww/wordwiki.searchPage(query)'},

             // --- Search text row
             ['div', {class:'col-12'},
              ['label', {for:'searchText', class:'visually-hidden'}, 'Search Text'],
              ['div', {class:'input-group'},
               ['input', {type:'text',
                          class:'form-control',
                          id:'searchText', name:'searchText',
                          value:search ?? ''}]]
             ], // row

             ['div', {class:'col-12'},
              ['button', {type:'submit', class:'btn btn-primary'}, 'Search']],
            ], // form
        ];
    }


    searchPage(query?: {searchText?: string}): any {

        //console.info('ENTRIES', this.entries);

        const rawSearch = String(query?.searchText ?? '');


        // Extract and remove all #\B* terms (they are treated as filters and
        // handled separately)
        const filters:string[] = [];
        const search = rawSearch.replaceAll(/#c[^ ]*/g, filter=>{
            filters.push(filter);
            return ' ';
        });
        console.info('got filters', filters, 'reduced search is', search);


        // replace ' '* with .*\w
        //const searchRegexSrc = `\\b${search.replaceAll(/ /g, ' .*\\b')}`;
        const searchRegexSrc =
            search.startsWith('^') || search.startsWith('\\B') || search.startsWith('\\b')
            ? search
            : `\\b${search}`;
        const searchRegex = new RegExp(searchRegexSrc, 'i');
        console.info('SEARCH IS', search, 'REGEX IS', searchRegexSrc);

        let matches: entry.Entry[] = [];
        if (search !== '') {
            const matchesSet:Set<entry.Entry> = new Set();
            for(const entry of this.entries) {
                for(const spelling of entry.spelling) {
                    if(searchRegex.test(spelling.text))
                        matchesSet.add(entry);
                }
                for(const subentry of entry.subentry) {
                    for(const gloss of subentry.gloss) {
                        if(searchRegex.test(gloss.gloss))
                            matchesSet.add(entry);
                    }
                }
            }
            matches = Array.from(matchesSet.values());
        } else {
            matches = this.entries;
        }

        // if(filters.length > 0) {
        //     for(const entry of matches) {

        //     }
        // }


        // const entriesWithHouseGloss = search === '' ? [] :
        //     this.entries.filter(
        //         entry=>entry.subentry.some(
        //             subentry=>subentry.gloss.some(
        //                 gloss=>gloss.gloss.startsWith(search))));

        //console.info('entriesWithHouseGloss', JSON.stringify(entriesWithHouseGloss, undefined, 2));

        const title = ['Query for ', search];

        function renderEntryItem(e: entry.Entry): any {
            return [
                ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)]
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Query form
            this.searchForm(search),

            // --- Add new entry button
            // ['div', {},
            //  ['button', {onclick:'imports.launchNewLexeme()'}, 'Add new Entry']],
            // --- Results
            ['ul', {},
             matches.slice(0, 500).map(e=>['li', {}, renderEntryItem(e)]),
            ]
        ];

        return templates.pageTemplate({title, body});
    }

    searchDocumentsForm(search?: string): any {
        return [
            ['form', {class:'row row-cols-lg-auto g-3 align-items-center', name: 'search', method: 'get', action:'/ww/wordwiki.searchDocumentsPage(query)'},

             // --- Search text row
             ['div', {class:'col-12'},
              ['label', {for:'searchText', class:'visually-hidden'}, 'Search Text'],
              ['div', {class:'input-group'},
               ['input', {type:'text',
                          class:'form-control',
                          id:'searchText', name:'searchText',
                          value:search ?? ''}]]
             ], // row

             ['div', {class:'col-12'},
              ['button', {type:'submit', class:'btn btn-primary'}, 'Search Documents']],
            ], // form
        ];
    }


    searchDocumentsPage(query?: {searchText?: string}): any {
        throw new Error('not impl yetc');
    }

    get entriesByCategory(): Map<string, entry.Entry[]> {
        return this.#entriesByCategory ??= (()=>{
            //console.time('computing entriesByCategory');
            const entriesByCategoryArray: [string, entry.Entry][]  = 
                this.publishedEntries.flatMap(e=>e.subentry.flatMap(s=>
                    s.category.flatMap(c=>c.category).map(category=>[category, e] as [string, entry.Entry])));

            const entriesByCategory1: Map<string, [string, entry.Entry][]> =
                Map.groupBy(entriesByCategoryArray, a=>a[0])

            const entriesByCategory2: [string, entry.Entry[]][] =
                Array.from(entriesByCategory1.entries()).map(([category, ent])=>
                    [category, ent.map(e=>e[1])
                        .toSorted((a: entry.Entry, b: entry.Entry) =>
                            // TODO: pick spelling for sort better! (+locale etc)
                            this.sourceLangCollator
                                .compare((a.spelling[0]?.text)??'',
                                         (b.spelling[0]?.text)??''))]);
            
            const entriesByCategory = new Map(entriesByCategory2);
            
            //console.timeEnd('computing entriesByCategory');
            return entriesByCategory;
        })();
    }

    getEntriesForCategory(category: string): entry.Entry[] {
        return category === '' ? [] :
            this.publishedEntries.filter(
                entry=>entry.subentry.some(
                    subentry=>subentry.category.some(
                        cat=>cat.category === category)));        
    }

    getCategories0(): Map<string, number> {
        return new Map(Array.from(Map.groupBy(this.publishedEntries.
            flatMap(e=>
                e.subentry.flatMap(s=>
                    s.category.flatMap(c=>
                        c.category))), category=>category)
            .entries()).map(([category, insts]) => [category, insts.length] as [string, number])
            .toSorted((a: [string, number], b: [string, number])=>b[1]-a[1]));
    }

    getCategories(): Map<string, number> {
        return new Map(Array.from(Map.groupBy(this.publishedEntries.
            flatMap(e=>
                e.subentry.flatMap(s=>
                    s.category.flatMap(c=>
                        c.category))), category=>category)
            .entries()).map(([category, insts]) => [category, insts.length] as [string, number])
            .toSorted((a: [string, number], b: [string, number])=>
                this.sourceLangCollator
                    .compare(a[0]??'', b[0]??'')));
    }
    



    

    categoriesDirectory(): any {
        const title = `Categories Directory`;

        // Grouped by theme via the category table (the shared grouping:
        // themes in table order - so Internal and Old categories land at the
        // end - names sorted within).  This is the EDITOR report, so internal
        // '~' categories are shown; the public site filters them.  Values
        // with no table row (a pre-import db) trail in their own group.
        const counts = this.getCategories();
        const tabled = this.categories.allByOrder.all({}).filter(c => counts.has(c.slug));
        const tabledSlugs = new Set(tabled.map(c => c.slug));
        const untabled = Array.from(counts.keys())
            .filter(v => !tabledSlugs.has(v))
            .toSorted((a, b) => this.sourceLangCollator.compare(a, b));

        const categoryLink = (value: string, label: string) =>
            ['li', {}, ['a',
                        {href:`/ww/wordwiki.entriesForCategory(${JSON.stringify(value)})`},
                        label, ` (${counts.get(value)} entries)`]];

        const body = [
            ['h1', {}, title],
            category.groupByTheme(tabled).map(group => [
                ['h3', {}, group.theme],
                ['ul', {}, group.cats.map(c => categoryLink(c.slug, `${c.name} (${c.slug})`))],
            ]),
            untabled.length > 0
                ? [['h3', {}, 'Not in the category table'],
                   ['ul', {}, untabled.map(v => categoryLink(v, v))]]
                : undefined,
        ];

        return templates.pageTemplate({title, body});
    }

    todoReport(restrictToUser: string|null, restrictToTask: string|null): any {
        const userSummary = restrictToUser ? `for user "${entry.users[restrictToUser] ?? restrictToUser}"` : 'for all users';
        const taskSummary = restrictToTask ? `for task "${entry.todos[restrictToTask] ?? restrictToTask}"` : 'for all tasks';
        const title = `TODO report ${userSummary} ${taskSummary}`;

        const userPicker = ['div', {}, ['b', {}, 'Assigned To: '],
                            Object.entries(entry.users).map(([user_id, user_name])=>
                                [['a', {href:`/ww/wordwiki.todoReport(${JSON.stringify(user_id)}, ${JSON.stringify(restrictToTask)})`}, user_id], ' / ']),
                            ['a', {href:`/ww/wordwiki.todoReport(null, ${JSON.stringify(restrictToTask)})`}, 'ALL USERS']];

        const taskPicker = ['div', {}, ['b', {}, 'Task Kind: '],
                            Object.entries(entry.todos).map(([todo_id, todo_name])=>
                                [['a', {href:`/ww/wordwiki.todoReport(${JSON.stringify(restrictToUser)}, ${JSON.stringify(todo_id)})`}, todo_name], ' / ']),
                            ['a', {href:`/ww/wordwiki.todoReport(${JSON.stringify(restrictToUser)}, null)`}, 'ALL TASKS']];

        const entriesForTODO = this.getEntriesForTODO(restrictToUser, restrictToTask);
        
        const body = [
            ['h1', {}, title],
            userPicker,
            taskPicker,
            ['br', {}],
            ['ul', {},
             entriesForTODO.map(e=>
                 ['li', {},
                  ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)]])]];

        return templates.pageTemplate({title, body});
    }

    getEntriesForTODO(restrictToUser: string|null, restrictToTask: string|null): entry.Entry[] {
        return this.entries.filter(
            entry=>
                entry.todo.some(todo=>
                    !todo.done &&
                    (restrictToTask == null || todo.todo === restrictToTask) &&
                    (restrictToUser == null || todo.assigned_to === restrictToUser)));
    }
    
    variantReport(): any {
        
        function findAllVariantFieldValues(entry: Record<string, any>,
                                           v: Record<string, any>,
                                           variants: Set<string>) {
            const variant = v['variant'];
            if(variant) {
                variants.add(variant);
                if(variant !== 'mm-li' && variant !== 'mm-sf')
                    console.info('VARIANT:', variant, typeof variant, entry);
            }
            for(const [key, val] of Object.entries(v)) {
                //console.info('CONSIDERING', key, val);
                if(Array.isArray(val))
                    val.forEach(a=>findAllVariantFieldValues(entry, a, variants));
                else if(val != null && utils.isObjectLiteral(val))
                    findAllVariantFieldValues(entry, val, variants);
            }
        }

        const variants = new Set<string>();
        this.entries.forEach(entry=>findAllVariantFieldValues(entry, entry, variants));
        
        const title = 'Variant Report';
        const body = ['div', {}, 'Variant report',
                      ['ul', {},
                       Array.from(variants.values()).map(v=>['li', {}, v])
                      ],
                     ];
        
        return templates.pageTemplate({title, body});
    }

    entriesForCategory(category?: string): any {
        category = String(category ?? '');

        const entriesForCategory = this.getEntriesForCategory(category);
        const title = ['Entries for category ', category];
        
        function renderEntryItem(e: entry.Entry): any {
            return [
                ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)]
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesForCategory
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }
    
    entriesByTwitterPostStatus(): any {
        
        function getTwitterPostStatusForEntry(e: entry.Entry): string|undefined {
            return e.subentry.flatMap(s=>
                s.attr.filter(a=>a.attr=='twitter-post').map(a=>a.value))[0];
        }
        
        function renderEntryItem(e: entry.Entry): any {
            return [
                (getTwitterPostStatusForEntry(e) ?? 'Not posted on twitter'),
                ' -- ', 
                ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummaryCore(e)]
            ];
        }

        const entriesByTwitterPostStatus =
            this.entries.toSorted((a: entry.Entry, b: entry.Entry)=> {
                const atwit = getTwitterPostStatusForEntry(a);
                const btwit = getTwitterPostStatusForEntry(b);
                if(atwit == btwit)
                    return 0
                if(atwit == undefined)
                    return 1;
                if(btwit == undefined)
                    return -1;
                return this.sourceLangCollator
                    .compare(atwit, btwit)
            });

        const title = "Entries by Twitter Post Status";
        const body = [
            ['h2', {}, title],

            ['div', {},
             ['ul', {},
              entriesByTwitterPostStatus
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }

    entriesByPronunciation(): any {
        throw new Error('no working yet');
       const entriesByPronunciation = utils.multi_partition_by(
           this.entries,
           e=>e.subentry.flatMap(s=>s.pronunciation_guide.flatMap(p=>p.pronunciation_guide)));
                                             
       const entriesByPronunciationSorted =
           new Map(Array.from(entriesByPronunciation.entries()).
           toSorted((a, b) =>
               this.sourceLangCollator.compare(a[0], b[0])));
           
       

       //console.info('SORTED', entriesByPronunciationSorted);
       Array.from(entriesByPronunciationSorted.entries()).forEach((pronunciation, entries) => console.info('pron', pronunciation, 'entries', entries));
        // function renderEntryItem(e: entry.Entry): any {
        //     return [
        //         (getTwitterPostStatusForEntry(e) ?? 'Not posted on twitter'),
        //         ' -- ', 
        //         ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummaryCore(e)]
        //     ];
        // }

        const title = "Entries by Pronunciation";
        const body = [
            ['h2', {}, title],

            ['div', {},
             ['ul', {},
              Array.from(entriesByPronunciationSorted.entries()).map((pronunciation, entries) => ['li', {}, pronunciation])
             ], // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }
    
    entriesByEnglishGloss(): any {
    }
    
    
    // entriesByStatusDirectory(): any {
    //     const title = `Entries By Status`;

    //     const cats: [string, number][] = Array.from(Map.groupBy(this.entries.
    //         flatMap(e=>
    //             e.status.flatMap(s=>s.status))), e=>e)
    //             .toSorted((a: [string, number], b: [string, number])=>b[1]-a[1]);


    //     const body = [
    //         ['h1', {}, title],
    //         ['ul', {},
    //          cats.map(cat=>
    //              ['li', {}, ['a',
    //                          {href:`/ww/wordwiki.entriesForStatus(${JSON.stringify(cat[0])})`},
    //                          cat[0], ` (${cat[1]} entries)`]]),
    //         ]
    //     ];

    //     return templates.pageTemplate({title, body});
    // }

    entriesForStatus(status?: string): any {
        status = String(status ?? '');

        const entriesForStatus = status === '' ? [] :
            this.entries.filter(
                entry=>entry.status.some(
                    s=>s.status === status));
        const title = ['Entries for status ', status];

        function renderEntryItem(e: entry.Entry): any {
            return [
                ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)]
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesForStatus
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }


    emptyBoundingBoxes(): any {

    }

    entriesWithProblem(): any {
        const title = `Entries With empty example translation`;

        const entriesWithProblem =
            this.entries.filter(
                entry=>entry.subentry.some(
                    subentry=>subentry.example.some(
                        example=>example.example_translation.some(
                            example_translation=>example_translation.example_translation === ''))));

        function renderEntryItem(e: entry.Entry): any {
            return [
                ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)]
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesWithProblem
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }

    get entryCountByPage(): Array<[number, number]> {
        return this.#entryCountByPage ??= (()=>{
            const pdmDocumentId =
                selectScannedDocumentByFriendlyId()
                    .required({friendly_document_id: 'PDM'})
                    .document_id;

            //console.time('entryCountByPage');
            const entryCountByPage = db().
                all<{page_number: number, entry_count: number}>(
                    block`
/**/     SELECT pg.page_number AS page_number, COUNT(DISTINCT bg.bounding_group_id) as entry_count
/**/       FROM dict AS ref
/**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
/**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
/**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
/**/       WHERE ref.ty = 'ref' AND
/**/             bg.document_id = :document_id AND
/**/             bb.page_id IS NOT NULL
/**/       GROUP BY pg.page_number ORDER BY pg.page_number`, {document_id: pdmDocumentId});
            //console.timeEnd('entryCountByPage');

            //console.info('entryCountByPage', entryCountByPage);
            return entryCountByPage.map(e=>[e.page_number, e.entry_count]);
        })();
    }
    
    entriesByPDMPageDirectory(): any {
        const title = `Entries by PDM Page Directory`;

//         const pdmDocumentId =
//             selectScannedDocumentByFriendlyId()
//                 .required({friendly_document_id: 'PDM'})
//                 .document_id;

//         console.time('entryCountByPage');
//         const entryCountByPage = db().
//             all<{page_number: number, entry_count: number}>(
//                 block`
// /**/     SELECT pg.page_number AS page_number, COUNT(DISTINCT bg.bounding_group_id) as entry_count
// /**/       FROM dict AS ref
// /**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
// /**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
// /**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
// /**/       WHERE ref.ty = 'ref' AND
// /**/             bg.document_id = :document_id AND
// /**/             bb.page_id IS NOT NULL
// /**/       GROUP BY pg.page_number ORDER BY pg.page_number`, {document_id: pdmDocumentId});
//         console.timeEnd('entryCountByPage');

        //const entryCountByPageMap = Map.fromEntr

        
        // console.info('entryCountByPage', entryCountByPage);

        const entryCountByPage = this.entryCountByPage;
        
        const body = [
            ['h1', {}, title],
            ['ul', {},
             entryCountByPage.map(([page_number, entry_count])=>
                 ['li', {},
                  ['a', {href:`/ww/wordwiki.entriesByPDMPage(${page_number})`},
                   `PDM page ${page_number} has ${entry_count} entries`]
                 ])
            ]
        ];

        return templates.pageTemplate({title, body});
    }

    entriesByPDMPage(page_number: number): any {
        typeof page_number === 'number' || panic('expected page number');

        const title = `Entries for PDM Page ${page_number}`;

        const pdmDocumentId =
            selectScannedDocumentByFriendlyId()
                .required({friendly_document_id: 'PDM'})
                .document_id;

        const pdmPageId =
            selectScannedPageByPageNumber()
                .required({document_id: pdmDocumentId, page_number}).page_id;

        console.time('entriesInDocRefOrder');
        // TODO XXX the page_number returned here is pointless now that this
        //          is locked to a single page.
        const entriesInDocRefOrder = db().
            all<{x: number, bounding_group_id: number, entry_id: number}, {page_id: number}>(
                block`
/**/     SELECT DISTINCT bg.bounding_group_id AS bounding_group_id, ref.id1 AS entry_id
/**/       FROM dict AS ref
/**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
/**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
/**/       WHERE ref.valid_to = 9007199254740991 AND
/**/             ref.ty = 'ref' AND
/**/             bb.page_id = :page_id
/**/       ORDER BY bb.y, bb.x, ref.id1`, {page_id: pdmPageId});


//         const entriesInDocRefOrder = db().
//             all<{page_number: number, x: number, bounding_group_id: number, entry_id: number}, {document_id:number}>(
//                 block`
// /**/     SELECT DISTINCT pg.page_number AS page_number, bg.bounding_group_id AS bounding_group_id, ref.id1 AS entry_id
// /**/       FROM dict AS ref
// /**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
// /**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
// /**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
// /**/       WHERE ref.ty = 'ref' AND
// /**/             pg.page_number = :page_number AND
// /**/             bg.document_id = :document_id
// /**/       ORDER BY pg.page_number, bb.y, bb.x, ref.id1`, {document_id: pdmDocumentId});
        console.timeEnd('entriesInDocRefOrder');

        console.info('entriesForPageInDocRefOrder', entriesInDocRefOrder);

        const entriesById = new Map(this.entries.map(entry=>[entry.entry_id, entry]));

        function renderRef(ref: {bounding_group_id: number, entry_id: number}): any {
            const e = entriesById.get(ref.entry_id)
                ?? panic('unable to find entry with id', ref.entry_id);
            const r = e.subentry.flatMap(s=>s.document_reference)
                .find(r=>ref.bounding_group_id === r.bounding_group_id)
                ?? panic('unable to find reference', ref.bounding_group_id);
            return [
                renderStandaloneGroup('/', ref.bounding_group_id),
                ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)],
                ['table', {},
                 ['tbody', {},
                  r.transcription.map(t=>['tr', {}, ['th', {}, 'Transcription:'], ['td', {}, t.transcription]]),
                  r.expanded_transcription.map(t=>['tr', {}, ['th', {}, 'Expanded:'], ['td', {}, t.expanded_transcription]]),
                  r.transliteration.map(t=>['tr', {}, ['th', {}, 'Transliteration:'], ['td', {}, t.transliteration]]),
                  r.note.map(t=>['tr', {}, ['th', {}, 'Note:'], ['td', {}, t.note]]),
                  r.public_note.map(t=>['tr', {}, ['th', {}, 'Public Note:'], ['td', {}, t.public_note]]),
                  r.source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Source as entry:'], ['td', {}, t.source_as_entry]]),          
                  r.normalized_source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Normalized source as entry:'], ['td', {}, t.normalized_source_as_entry]]),
                  r.foreign_reference.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Foreign reference:'], ['td', {}, t.foreign_reference]]),
                  
                  
                 ]]
            ];
        }

        const body = [
            ['h1', {}, title],
            entriesInDocRefOrder.map(ref=>['li', {}, renderRef(ref)])
        ];

        return templates.pageTemplate({title, body});
    }

    /**
     *
     */
    // ----- LiminalApp hooks --------------------------------------------------

    get appName(): string { return 'wordwiki'; }
    // URLs live under /ww/ even though the route-scope name is 'wordwiki'.
    override get routeSegment(): string { return 'ww'; }
    // The bare /ww/ path renders the dictionary home.
    override get homeRouteExpr(): string { return 'wordwiki.home()'; }

    // Serve the published static site (and resources) from cwd; the longest-prefix
    // router lets the handler mounts (/ww/, /page/) win over this catch-all.
    async resourceContentDirs(): Promise<Record<string, string>> {
        return {'/': './'};
    }
    override requestHandlerPaths(): Record<string, (request: server.Request) => Promise<server.Response>> {
        const handler = (request: server.Request) => this.requestHandler(request);
        return {'/ww/': handler, '/page/': handler};
    }

    // Resolve the session token into the request's security context (one trusted
    // lookup of the actor's own record, before any actor context exists).  The
    // try/catch keeps a not-yet-migrated db (no user_session table) working as
    // anonymous rather than erroring on every request.
    resolveSecurityContext(session_token: string | undefined): security.SecurityContext {
        return security.runSystem(() => {
            try {
                const session = session_token ? this.userSession.getBySessionToken.first({session_token}) : undefined;
                const actor = session ? this.users.getById(session.user_id) : undefined;
                return {
                    actorId: session?.user_id,
                    roles: security.rolesFromPermissionsField(actor?.permissions),
                };
            } catch (_e) {
                return {actorId: undefined, roles: new Set<string>()};
            }
        });
    }

    // The username (short code) of the logged-in user - stamped into
    // assertions as change_by_username.
    currentUsername(): string | undefined {
        const actorId = security.current()?.actorId;
        if(actorId === undefined) return undefined;
        try {
            return security.runSystem(() => this.users.getById(actorId).username);
        } catch (_e) {
            return undefined;
        }
    }

    // Always read the db_purpose marker as a trusted op.
    getDbPurpose(): string | undefined {
        try { return security.runSystem(() => this.config.getDbPurpose()); }
        catch { return undefined; }
    }

    // Test-client durable identity lives on the login-session row.
    stampTestClientOptIn(session_token: string, now: string): void {
        this.userSession.stampTestClientOptIn(session_token, now);
    }
    stampTestClientHeartbeat(session_token: string, now: string): void {
        this.userSession.stampTestClientHeartbeat(session_token, now);
    }
    mostRecentTestClient(): TestClientSession | undefined {
        return this.userSession.mostRecentTestClient.first({});
    }

    makePage(title: any, body: any): any { return templates.page(title, body); }

    // Wrap a page() in the standard htmx document (full load) or reduce it to
    // body-only + <title> (htmx partial swap).  Legacy routes that build full
    // documents with the old pageTemplate pass through untouched.
    protected override coercePageResult(result: any, isHtmxRequest: boolean): any {
        if(templates.isPage(result))
            return isHtmxRequest
                ? [['title', {}, result.title], result.body]
                : templates.htmxPageTemplate({title: result.title, body: result.body,
                                              showTestClientLink: this.isTestDb});
        return result;
    }

    // Unauthenticated requests are sent to the login page (except the login POST
    // - and, on NON-PRODUCTION dbs only, the GET form of the login, so a
    // puppeteer/test session can log in with a single navigation:
    //   /ww/wordwiki.loginRequest(queryArgs)?username=djz&password=...
    // Kept off production because a GET puts the password in the URL.)
    // NOTE the root-level /page/<Book>/<N>.html vanity endpoint is handled
    // before this gate in requestHandler and remains ungated.
    protected override rewriteUnauthenticatedRoute(jsExprSrc: string, ctx: security.SecurityContext, requestUrl: string): string | undefined {
        const allowedWithoutLogin = new Set([
            'wordwiki.loginRequest(bodyArgs)',
        ]);
        if(this.getDbPurpose() !== 'production')
            allowedWithoutLogin.add('wordwiki.loginRequest(queryArgs)');
        const loggedIn = ctx.actorId !== undefined;
        if(loggedIn || allowedWithoutLogin.has(jsExprSrc)) return undefined;
        return `wordwiki.login(${JSON.stringify(requestUrl)})`;
    }

    // Override so /eval server-target code sees WORDWIKI's lexical scope.
    protected override evalServer(js: string): Promise<any> {
        const wordwiki = this; // exposed to the eval'd code
        return security.runSystem(() =>
            // deno-lint-ignore no-eval
            eval(`(async () => { ${js}\n})()`));
    }

    testRuns(): Record<string, TestCase[]> { return {}; }

    // ----- Login / logout -----------------------------------------------------

    login(targetUrl: string, errorMessage?: string): templates.Page {
        const body = [
            ['div', {class: 'container mt-5'},
             ['div', {class: 'row justify-content-center'},
              ['div', {class: 'col-md-6 col-lg-5'},
               ['div', {class: 'card shadow'},
                ['div', {class: 'card-body p-5'},
                 ['h1', {class: 'text-center mb-2'}, 'MMO Editor'],
                 ['p', {class: 'text-center text-muted mb-4'}, `The Mi'gmaq-Mi'kmaq Online dictionary editor`],
                 errorMessage
                     ? ['div', {class: 'alert alert-danger', role: 'alert'}, errorMessage]
                     : undefined,
                 ['form', {name: 'login', method: 'post', action: 'wordwiki.loginRequest(bodyArgs)'},
                  ['div', {class: 'form-group mb-3'},
                   ['label', {for: 'username'}, 'Username'],
                   ['input', {type: 'text', class: 'form-control', name: 'username', id: 'username',
                              placeholder: 'Your short user code (e.g. djz)', required: true}]],
                  ['div', {class: 'form-group mb-4'},
                   ['label', {for: 'password'}, 'Password'],
                   ['input', {type: 'password', class: 'form-control', name: 'password', id: 'password',
                              placeholder: 'Enter your password', required: true}]],
                  ['input', {type: 'hidden', name: 'targetUrl', value: targetUrl}],
                  ['button', {type: 'submit', class: 'btn btn-primary btn-block w-100'}, 'Sign In'],
                 ]]]]]],
        ];
        return templates.page('Login', body);
    }

    loginRequest(args: {username?: string, password?: string, targetUrl?: string}) {
        const {username, password} = args;
        const targetUrl = args.targetUrl || '/ww/';

        const reRenderWithError = (message: string) => this.login(targetUrl, message);

        if(!username) return reRenderWithError('Please enter your username');
        if(!password) return reRenderWithError('Please enter your password');

        const actor = security.runSystem(() => this.users.byUsername.first({username}));
        if(!actor || actor.disabled)
            return reRenderWithError('No account was found for that username');

        const passwordHashRecord = security.runSystem(() =>
            this.passwordHash.byUserId.first({user_id: actor.user_id}));
        const {password_salt, password_hash} = passwordHashRecord ?? {};
        if(!password_salt || !password_hash)
            return reRenderWithError('No password has been set for this account - ask an admin to set one');

        const hashedSuppliedPassword = passwordUtils.hashPassword(password, password_salt);
        if(!passwordUtils.constantTimeEqual(hashedSuppliedPassword, password_hash))
            return reRenderWithError('Incorrect password');

        return this.createSessionResponse(actor.user_id, targetUrl);
    }

    // Cookie attributes for the session cookie.  Secure on a production db
    // (served over HTTPS); dev runs on plain http://localhost.
    private sessionCookieAttrs(): string {
        const secure = this.getDbPurpose() === 'production' ? '; Secure' : '';
        return `Path=/; HttpOnly; SameSite=Lax${secure}`;
    }

    private createSessionResponse(user_id: number, targetUrl: string): server.Response {
        const now = date.currentSqliteDateTime();
        const session_token = passwordUtils.generateSessionToken();
        security.runSystem(() => this.userSession.insert({
            session_token,
            user_id,
            start_time: now,
            last_resume_time: now,
            last_ip: '', // TODO
        }));

        const response = server.forwardResponse(targetUrl);
        // Max-Age is the 400-day browser cap; the authoritative session lifetime
        // is the user_session row (deleting it ends the session regardless).
        const fourHundredDaysInSeconds = 400 * 24 * 60 * 60;
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=${session_token}; ${this.sessionCookieAttrs()}; Max-Age=${fourHundredDaysInSeconds}`;
        return response;
    }

    logout(session_token?: string): server.Response {
        if(session_token) {
            try { this.testClientChannel.drop(session_token); } catch (_e) { /* ignore */ }
            security.runSystem(() => this.userSession.deleteBySessionToken(session_token));
        }
        const response = server.forwardResponse('/ww/');
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=; ${this.sessionCookieAttrs()}; Max-Age=0`;
        return response;
    }

    /**
     *
     */
    // Wordwiki keeps one root-level dynamic endpoint - the /page/<Book>/<N>.html
    // vanity URL.  Everything else under
    // /ww/ (plus shutdown/eval) is handled by the LiminalApp base, which also sets
    // the (anonymous) security context and dispatches via the shared route eval.
    override async requestHandler(request: server.Request): Promise<server.Response> {
        const filepath = decodeURIComponent(new URL(request.url).pathname);

        const pageRequest = /^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+)[.]html)$/.exec(filepath);
        if(pageRequest !== null) {
            const {Book, PageNumber} = pageRequest.groups as any;
            if(typeof Book !== 'string') throw new Error('missing book');
            if(typeof PageNumber !== 'string') throw new Error('missing page number');
            const body = await pageEditor(Book, parseInt(PageNumber));
            const html = await asyncRenderToStringViaLinkeDOM(body);
            return {status: 200, headers: {}, body: html};
        }
        return super.requestHandler(request);
    }
}


// Create the legacy raw-DML tables (both data worlds: the scanned-document
// tables and the dict assertion table).  Idempotent; the new-style liminal
// tables are created separately by WordWiki.ensureNewStyleTables().
export function createAllTables() {
    db().executeStatements(allScannedDocumentSchemaDml + createAssertionDml('dict'));
}

export let wordwiki: WordWiki|undefined = undefined;

export function getWordWiki(): WordWiki {
    return wordwiki ??= new WordWiki();
}

if (import.meta.main) {
    const args = Deno.args;
    const command = args[0];
    const ww = getWordWiki();
    switch(command) {
        case 'serve':
            security.runSystem(() => ww.ensureNewStyleTables());
            // Legacy-template pages don't go through coercePageResult, so the
            // navbar's test-client-link default is set once here instead.
            templates.setDefaultShowTestClientLink(ww.isTestDb);
            ww.startServer({hostname: 'localhost', port: 9000,
                            allowSchemaMismatch: args.includes('--allow-schema-mismatch')});
            break;

        // Compare the db against the declared (new-style) table model; with
        // --apply, bring it up to date (additive changes only - see
        // liminal/schema-upgrade.ts; a backup is taken first).  The legacy
        // raw-DML tables (scanned documents, dict, ...) are not covered: they
        // show up as ignorable notes.  Stop the server before --apply.
        case 'upgrade-db': {
            const code = security.runSystem(() =>
                schemaUpgrade.upgradeDbCommand(ww.tables, args.slice(1)));
            Deno.exit(code);
            break;
        }

        // One-time migration: replace the old (never-used) raw-DML user table
        // with the new liminal-style one and seed it from the hardcoded users
        // map in entry-schema.ts.  Refuses if the old table has rows.
        case 'upgrade-users': {
            security.runSystem(() => {
                const userCount = (() => {
                    try { return db().prepare<{n: number}, {}>('SELECT COUNT(*) AS n FROM user').required({}).n; }
                    catch (_e) { return 0; }  // no user table at all
                })();
                const hasNewShape = (() => {
                    try { db().prepare('SELECT permissions FROM user LIMIT 1').all({}); return true; }
                    catch (_e) { return false; }
                })();
                if(userCount > 0 && !hasNewShape)
                    throw new Error(`user table has ${userCount} rows but the OLD schema - migrate manually`);
                if(!hasNewShape) {
                    console.info('dropping old-style empty user table');
                    db().execute('DROP TABLE IF EXISTS user', {});
                }
                ww.ensureNewStyleTables();
                const {inserted, skipped} = user.seedUsersFromEntrySchema(ww.users);
                console.info(`user table upgraded: ${inserted} users seeded, ${skipped} already present`);
                console.info('set a password with: wordwiki.ts set-password <username> <password>');
            });
            Deno.exit(0);
            break;
        }

        // Set (or replace) a user's password.  Run with the server stopped
        // (SQLite single writer).
        case 'set-password': {
            const [username, password] = [args[1], args[2]];
            if(!username || !password)
                throw new Error('usage: set-password <username> <password>');
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const u = ww.users.byUsername.first({username})
                    ?? panic(`no user with username '${username}' (run upgrade-users first?)`);
                ww.passwordHash.setPassword(u.user_id, password);
                console.info(`password set for ${u.name} (${username})`);
            });
            Deno.exit(0);
            break;
        }

        // Everything a freshly-pulled PRODUCTION db needs to run as the dev
        // db: upgrade/seed the user table (production still has the old empty
        // one), mark the db 'dev', and set a dev password for djz.  Re-run
        // after every pull until the new version IS production.
        //   ./wordwiki.sh post-pull [djz-password]   (default: djz-dev)
        case 'post-pull': {
            const djzPassword = args[1] ?? 'djz-dev';
            security.runSystem(() => {
                // Same logic as upgrade-users: replace an old-shape (empty)
                // user table, create anything missing, seed from the
                // entry-schema users map (idempotent - existing rows kept).
                const hasNewShape = (() => {
                    try { db().prepare('SELECT permissions FROM user LIMIT 1').all({}); return true; }
                    catch (_e) { return false; }
                })();
                if(!hasNewShape) {
                    const userCount = (() => {
                        try { return db().prepare<{n: number}, {}>('SELECT COUNT(*) AS n FROM user').required({}).n; }
                        catch (_e) { return 0; }
                    })();
                    if(userCount > 0)
                        throw new Error(`user table has ${userCount} rows but the OLD schema - migrate manually`);
                    console.info('dropping old-style empty user table');
                    db().execute('DROP TABLE IF EXISTS user', {});
                }
                ww.ensureNewStyleTables();
                const {inserted, skipped} = user.seedUsersFromEntrySchema(ww.users);
                ww.config.setDbPurpose('dev');
                const djz = ww.users.byUsername.first({username: 'djz'})
                    ?? panic('djz missing after seed?');
                ww.passwordHash.setPassword(djz.user_id, djzPassword);
                console.info(`post-pull complete: ${inserted} users seeded (${skipped} already present), ` +
                             `db marked 'dev', djz password set${args[1] ? '' : " to the default 'djz-dev'"}`);
            });
            Deno.exit(0);
            break;
        }

        // Import the batch re-categorization (see categorization/ and
        // category-import.ts): seed the category table (new scheme + internal
        // + retired ~old-*) and rewrite every entry's category tuples via
        // applyTransaction.  Idempotent - re-run freely after pulls; entries
        // already in the desired state are skipped.  This is the prototype
        // for the eventual production import, so it refuses a production-
        // marked db unless --allow-production is given.
        //   ./wordwiki.sh import-categories [categorization-dir]
        //                  [--username=NAME] [--allow-production]
        case 'import-categories': {
            const dir = args.find((a, i) => i >= 1 && !a.startsWith('--'))
                ?? `${Deno.env.get('HOME')}/wordwiki/categorization`;
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? 'djz';
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                if(!ww.users.byUsername.first({username}))
                    throw new Error(`--username '${username}' is not in the user table`);
                const schemeText = Deno.readTextFileSync(`${dir}/scheme.md`);
                const assignmentsText = Deno.readTextFileSync(`${dir}/assignments.jsonl`);
                categoryImport.importCategories(ww, {
                    schemeText, assignmentsText, username,
                    log: (msg) => console.info(msg),
                });
            });
            Deno.exit(0);
            break;
        }

        // Publish from the CLI - the whole site, or just the named targets
        // for quick turnaround while iterating on templates.  Targets are
        // site-relative paths ("the URL you want rebuilt" - see
        // parsePublishTarget in publish.ts for the grammar); errors and
        // warnings go to stdout and a non-zero exit means errors.
        // Publishing only READS the db, so wordwiki.sh leaves the dev
        // server running for this command.
        //   ./wordwiki.sh publish                                 # everything
        //   ./wordwiki.sh publish entries/samqwan categories/water
        case 'publish': {
            const targets = args.slice(1).filter(a => !a.startsWith('--'));
            const exitCode = await security.runSystem(async () => {
                const status = new publish.PublishStatus();
                status.start();
                const pub = new publish.Publish(status, ww, ww.publishedEntries);
                try {
                    if(targets.length === 0)
                        await pub.publish();
                    else
                        await pub.publishTargets(targets);
                } catch(e) {
                    status.errors.push(String(e instanceof Error ? (e.stack ?? e.message) : e));
                }
                status.end();
                for(const w of status.warnings)
                    console.info(`WARNING: ${w}`);
                for(const err of status.errors)
                    console.error(`ERROR: ${err}`);
                const secs = Math.round(((status.endTime ?? 0) - (status.startTime ?? 0)) / 1000);
                console.info(`publish${targets.length ? ` of ${targets.join(', ')}` : ''} ` +
                             `completed in ${secs}s: ` +
                             `${status.errors.length} errors, ${status.warnings.length} warnings`);
                return status.errors.length > 0 ? 1 : 0;
            });
            Deno.exit(exitCode);
            break;
        }

        // Import the lexical form (part of speech) vocabulary (see
        // lexical-form-import.ts): seed the curated table, normalize the
        // UNAMBIGUOUS legacy values in the data ('vii ' -> vii, 'particle'
        // -> PTCL) via applyTransaction, and report the remaining un-tabled
        // values as the team's curation worklist.  Idempotent; guarded like
        // import-categories.
        //   ./wordwiki.sh import-lexical-forms [--username=NAME] [--allow-production]
        case 'import-lexical-forms':
        case 'seed-lexical-forms': {   // older name kept as an alias
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? 'djz';
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                if(!ww.users.byUsername.first({username}))
                    throw new Error(`--username '${username}' is not in the user table`);
                lexicalFormImport.importLexicalForms(ww, {username, log: (msg) => console.info(msg)});
            });
            Deno.exit(0);
            break;
        }

        // Mark the database's purpose (production databases refuse destructive
        // test/dev operations and get Secure cookies).
        case 'set-db-purpose': {
            const purpose = args[1];
            if(purpose !== 'production' && purpose !== 'dev' && purpose !== 'test')
                throw new Error('usage: set-db-purpose production|dev|test');
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                ww.config.setDbPurpose(purpose);
                console.info(`db_purpose set to '${purpose}'`);
            });
            Deno.exit(0);
            break;
        }

        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
