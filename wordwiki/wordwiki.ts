// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as markup from '../tabula/markup.ts';
import * as model from '../datawiki/model.ts';
import * as renderPageEditor from '../scannedpage/render-page-editor.ts';
import * as schema from "./schema.ts";
import * as server from '../tabula/http-server.ts';
import * as strings from "../tabula/strings.ts";
import * as utils from "../tabula/utils.ts";
import * as random from "../tabula/random.ts";
import {panic} from '../tabula/utils.ts';
import * as view from '../datawiki/view.ts';
import * as workspace from '../datawiki/workspace.ts';
import {VersionedDb} from  '../datawiki/workspace.ts';
import * as config from './config.ts';
import * as entry from './entry-schema.ts';
import * as timestamp from '../tabula/timestamp.ts';
import * as templates from './templates.ts';
import * as orderkey from '../tabula/orderkey.ts';
import * as audio from './audio.ts';
import {block} from '../tabula/strings.ts';
import {db} from "../tabula/db.ts";
import * as publish from './publish.ts';
import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../tabula/markup.ts';
import {DenoHttpServer} from '../tabula/deno-http-server.ts';
import {ScannedDocument, ScannedPage, Assertion, updateAssertion, selectScannedDocumentByFriendlyId, Layer, assertionPathToFields, getAssertionPath, BoundingGroup, selectBoundingBoxesForGroup, getOrCreateNamedLayer, selectScannedPageByPageNumber} from './schema.ts';
import {dictSchemaJson} from "./entry-schema.ts";
import {evalJsExprSrc} from '../tabula/jsterp.ts';
import {exists as fileExists} from "std/fs/mod.ts"
import {pageEditor, PageEditorConfig, renderStandaloneGroup} from '../scannedpage/render-page-editor.ts';
import * as pageEditorModule from '../scannedpage/page-editor.ts';
import * as pageViewerModule from '../scannedpage/page-viewer.ts';

import {rpcUrl} from '../tabula/rpc.ts';
export interface WordWikiServerConfig {
    hostname: string,
    port: number,
}

/**
 *
 */
export class WordWiki {
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

        // --- Load schema and create an empty workspace
        this.dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
        // --- Set up our routes
        this.routes = Object.assign(
            {},
            {wordwiki: this},
            renderPageEditor.routes(),
            schema.routes(),
            workspace.routes(),
            view.routes(),
            audio.routes(),
            publish.routes(),
        );
    }

    get lastAllocatedTxTimestamp() {
        // TODO as we add more tables, this will need to be extended.
        return this.#lastAllocatedTxTimestamp ??= schema.highestTimestamp('dict');
    }

    allocTxTimestamps(count: number=1) {
        const lastTxTimestamp = this.lastAllocatedTxTimestamp;
        const nextTxTimestamp = timestamp.nextTime(lastTxTimestamp);
        utils.assert(count>=1);
        this.#lastAllocatedTxTimestamp = nextTxTimestamp + count - 1;
        console.info('alloced timestamp', {last: lastTxTimestamp, next: nextTxTimestamp, next_txt: timestamp.formatTimestampAsLocalTime(nextTxTimestamp)});
        return nextTxTimestamp;
    }

    get workspace() {
        return this.#workspace ??= (()=>{

            // --- Create workspace
            const workspace = new VersionedDb([this.dictSchema]);

            // --- Do load of dictionary
            const assertions = schema.selectAllAssertions('dict').all();
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
    applyTransaction(assertions: Assertion[]) {

        console.info('Applying TX',
                     JSON.stringify(assertions, undefined, 2));

        // --- Allocate a new server timestamp for this tx
        //     TODO we may want to allocate multiple here to give client new base.
        const serverTimestamp = this.allocTxTimestamps(1);

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

    // XXX THIS IS UTTER GARBAGE - JUST GET IT OUT THE DOOR FIX FIX TODO XXX
    addNewDocumentReference(entry_id: number, subentry_id: number, friendly_document_id: string, title?: string): any {
        console.info('*** Add new document reference', entry_id, subentry_id, friendly_document_id, title);

        // XXX copying these colors form pageeditor.ts is BAD.
        const groupColors = [
            'crimson', 'palevioletred', 'darkorange', 'gold', 'darkkhaki',
            'seagreen', 'steelblue', /*'dodgerblue',*/ 'peru', /*'tan',*/ 'rebeccapurple'];


        // --- Create new layer in the specified document id.
        const document = selectScannedDocumentByFriendlyId().required({friendly_document_id});
        const document_id = document.document_id;
        const layer_id = schema.getOrCreateNamedLayer(document.document_id, 'Tagging', 0);
        const color = groupColors[random.randomInt(0, groupColors.length-1)];
        const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
            'bounding_group', {document_id, layer_id, color}, 'bounding_group_id');

        console.info('new bounding group id is', bounding_group_id);

        // --- Add a new document reference to the subentry that references this new
        //     bounding_group_id
        // XXX Seems safest to do all mutes though a workspace - this is a hack fest for now.
        // TODO make this less weird
        const ws = new VersionedDb([model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson)]);
        workspace.getAssertionsForEntry(entry_id)
            .forEach((a:Assertion)=>ws.untrackedApplyAssertion(a));
        const subentry = ws.getVersionedTupleById('dct', 'sub', subentry_id)
            ?? panic('unable to find subentry', subentry_id);
        const refsRelation = subentry.childRelations['ref']
            ?? panic("can't find doc refs?");
        //console.info('refsRelation', refsRelation);

        const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const order_key = workspace.generateAtEndOrderKey(refsRelation);

        const newAssertion: Assertion = Object.assign(
            {},
            assertionPathToFields([...getAssertionPath(subentry.currentAssertion??panic()), ['ref', id]]),
            {
                ty: 'ref',
                assertion_id: id,
                valid_from: timestamp.nextTime(timestamp.BEGINNING_OF_TIME),  // This is wrong - but it is overridden
                valid_to: timestamp.END_OF_TIME,
                attr1: bounding_group_id,
                id: id,
                order_key,
            });

        console.info('applying assertion', JSON.stringify(newAssertion, undefined, 2));

        this.applyTransaction([newAssertion]);

        const bounding_boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
        // XXX Note: if a entry has bounding boxes on muiltiple pages, we are
        //     picking the first page by page_id, not page number.
        const page_id =
            bounding_boxes.length > 0
            ? bounding_boxes.map(b=>b.page_id).toSorted((a,b)=>a-b)[0]
            : schema.selectScannedPageByPageNumber().required({document_id, page_number: 1}).page_id;

        const reference_layer_id = getOrCreateNamedLayer(document_id, 'Text', 1);
        //const title = 'TITLE'; // XXX
        const pageEditorConfig: PageEditorConfig = {
            layer_id,
            reference_layer_ids: [reference_layer_id],
            title,
            is_popup_editor: true,
            locked_bounding_group_id: bounding_group_id,
        };
        const taggerUrl = `/ww/renderPageEditorByPageId(${page_id}, ${JSON.stringify(pageEditorConfig)})`;

        // --- Redirect the browser to the image tagger on this layer.
        return {location: taggerUrl};
    }


    // XXX THIS IS UTTER GARBAGE - JUST GET IT OUT THE DOOR FIX FIX TODO XXX
    addNewLexeme(): any {
        console.info('*** Add new lexeme');

        // --- Add a new entry
        // TODO make this less weird
        const ws = new VersionedDb([model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson)]);

        // This is wrong - but it is overridden
        const tx_time = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);

        const entry_id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        // TODO more thinking about order_key here
        const order_key = orderkey.new_range_start_string;
        const newEntryAssertion: Assertion = {
            assertion_id: entry_id,
            valid_from: tx_time,  // This is wrong - but it is overridden
            valid_to: timestamp.END_OF_TIME,
            id: entry_id,
            ty: 'ent',
            ty0: 'dct',
            ty1: 'ent',
            id1: entry_id,
            order_key,
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
        };

        const assertions = [
            newEntryAssertion, newSubEntryAssertion];

        console.info('applying assertions', JSON.stringify(assertions, undefined, 2));

        this.applyTransactions(assertions);
        console.info('created new assertion with id', entry_id);

        // --- Redirect the browser to the image tagger on this layer.
        return {location: `/ww/wordwiki.entry(${entry_id})`};
    }


    // entry_old(entryId: number): any {

    //     const e = this.entries
    //         .filter(entry=>entry.entry_id === entryId)[0];

    //     if(!e) {
    //         const title = `Missing or deleted entry ${entryId}`;
    //         return templates.pageTemplate({title, body: ['h1', {}, title]});
    //     } else {
    //         const title = entry.renderEntrySpellings(ctx, e, e.spelling);
    //         const body = entry.renderEntry(e);
    //         return templates.pageTemplate({title, body});
    //     }
    // }

    entry(entry_id: number): any {
        return templates.pageTemplate({
            body: [
                ['div', {id: 'entryEditorBody'}],
                ['script', {type: 'module'}, block`
/**/           document.addEventListener("DOMContentLoaded", (event) => {
/**/             console.log("DOM fully loaded and parsed");
/**/              imports.entryEditor('Edit Entry', ${entry_id}, 'ent', ${entry_id}, undefined, 'entryEditor');
/**/           });`
                ]
            ],
        });
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

        function renderEntryItem_OFF(e: entry.Entry): any {
            return [
                ['span', {onclick: `imports.popupEntryEditor('Edit Entry', ${e.entry_id})`}, entry.renderEntryCompactSummary(e)]
            ];
        }

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

        const body = [
            ['h1', {}, title],
            ['ul', {},
             Array.from(this.getCategories().entries()).map(cat=>
                 ['li', {}, ['a',
                             {href:`/ww/wordwiki.entriesForCategory(${JSON.stringify(cat[0])})`},
                             cat[0], ` (${cat[1]} entries)`]]),
            ]
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
    async startServer(config: WordWikiServerConfig) {
        console.info('Starting wordwiki server');

        // const contentdirs = {
        //     // '/resources/': await findResourceDir('resources')+'/',
        //     // '/scripts/': await findResourceDir('web-build')+'/',
        //     '/resources/': 'resources/', 
        //     '/scripts/': 'scripts/',
        //     '/entries/': 'entries/',
        //     '/categories/': 'categories/',
        //     '/content/': 'content/',
        //     '/derived/': 'derived/'};

        const contentdirs = {
            // '/resources/': await findResourceDir('resources')+'/',
            // '/scripts/': await findResourceDir('web-build')+'/',
            '/': './'};
        
        // const contentfiles = {
        //     '/index.html': 'index.html',
        //     '/all-words.html': 'all-words.html',
        //     '/about-us.html': 'about-us.html',
        //     '/categories.html': 'categories.html',
        // };

        const contentfiles = {};
        const requestHandlerPaths: Record<string, (request: server.Request) => Promise<server.Response>> = {
            '/ww/': request=>this.requestHandler(request),
        };
        await new DenoHttpServer({port: config.port,
                                  hostname: config.hostname,
                                  contentdirs, contentfiles, requestHandlerPaths}
                                 ).run();
    }

    /**
     *
     */
    // Proto request handler till we figure out how we want our urls etc to workc
    async requestHandler(request: server.Request): Promise<server.Response> {
        if(false && !request?.url?.endsWith('/favicon.ico'))
            console.info('tagger request', request);
        const requestUrl = new URL(request.url);
        const filepath = decodeURIComponent(requestUrl.pathname);
        const searchParams: Record<string,string> = {};
        const user = request.headers["x-webauth-user"];
        requestUrl.searchParams.forEach((value: string, key: string) => searchParams[key] = value);
        // if(Object.keys(searchParams).length > 0)
        //     console.info('Search params are:', searchParams);

        // TEMPORARY MANUAL HANDING OF THE ONE VANITY URL WE ARE CURRENTLY SUPPORTING
        const pageRequest = /^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+)[.]html)$/.exec(filepath);
        //console.info('pageRequest', pageRequest, 'for', filepath);
        if(pageRequest !== null) {
            const {Book, PageNumber} = pageRequest.groups as any
            if(typeof Book !== 'string') throw new Error('missing book');
            const book = Book;
            if(typeof PageNumber !== 'string') throw new Error('missing page number');
            const page_number = parseInt(PageNumber);

            const body = await pageEditor(book, page_number);
            const html = await asyncRenderToStringViaLinkeDOM(body);
            return Promise.resolve({status: 200, headers: {}, body: html});
        } else if (filepath === '/favicon.ico') {
            return Promise.resolve({status: 200, headers: {}, body: 'not found'});
        } else if (filepath === '/workspace-rpc-and-sync') {
            console.info('workspace sync request');
            const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
            return workspace.workspaceRpcAndSync(bodyParms as workspace.WorkspaceRpcAndSyncRequest);
        } else {
            let jsExprSrc = strings.stripOptionalPrefix(filepath, '/');
            jsExprSrc = strings.stripOptionalPrefix(jsExprSrc, 'ww/')
            switch(jsExprSrc) { // XXX HACK - move to better place
                case '':
                    jsExprSrc = 'wordwiki.home()';
                    break;
            }
            const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
            return this.rpcHandler(jsExprSrc, searchParams, bodyParms, user);
        }
    }

    /**
     *
     */
    async rpcHandler(jsExprSrc: string,
                     searchParams: Record<string, any>,
                     bodyParms: Record<string, any>,
                     user: string|undefined): Promise<any> {

        // --- Top level of root scope is active routes
        let rootScope = this.routes;

        // --- Push (possibly empty) URL search parameters as a scope
        //     with the single binding 'query'.  Later we may add more stuff
        //     from the request to this scope.
        rootScope = Object.assign(Object.create(rootScope), {query: searchParams});

        // --- If the query request body is a {}, then it is form parms or
        //     a json {} - push on scope.
        rootScope = Object.assign(Object.create(rootScope), bodyParms);

        console.info("***", new Date().toLocaleString(), '::', user, '::', jsExprSrc);
        // console.info('about to eval', jsExprSrc, 'with root scope ',
        //              JSON.stringify(utils.getAllPropertyNames(rootScope)));

        let result = null;
        try {
            result = evalJsExprSrc(rootScope, jsExprSrc);
            while(result instanceof Promise)
                result = await result;
        } catch(e) {
            // TODO more fiddling here.
            console.info('request failed', e);
            return server.jsonResponse({error: String(e)}, 400)
        }

        if(server.isMarkedResponse(result)) {
            return result;
        } else if(typeof result === 'string') {
            return server.htmlResponse(result);
        } else if(markup.isElemMarkup(result) && Array.isArray(result) && result[0] === 'html') { // this squigs me - but is is soooo convenient!
            let htmlText: string = 'cat';
            try {
                // Note: we allow markup to contain Promises, which we force
                //       at render time (inside asyncRenderToStringViaLinkeDOM)
                // TODO: we may want to make this opt-in per request after
                //       profiling how much extra cpu we are spending using
                //       the async version fo renderToStringvialinkedom.
                //       If the sync one is way faster, we could even consider
                //       having it throw if it finds a promise, then re rendering
                //       with the async one.
                htmlText = await markup.asyncRenderToStringViaLinkeDOM(result);
            } catch(e) {
                console.info('request failed during content force', e);
                return server.jsonResponse({error: String(e)}, 400);
            }
            return server.htmlResponse(htmlText);
        } else {
            return server.jsonResponse(result);
        }

        // result can be a command - like forward
        // result can be json, a served page, etc
        // so - want to define a result interface - and have the individualt mentods rethren tnat
        // this can also be the opporthunity to allow streaming
        // this mech is part of our deno server stuff.
        // have shortcuts for returning other things:

        //return Promise.resolve({status: 200, headers: {}, body: 'not found'});
    }
}


/**
 * We want the site resources (.js, .css, images) to be part of the source tree
 * (ie. under revision control etc).  So we have a directory in the source tree
 * called 'resources'.  AFAICT Deno has no particular support for this (accessing
 * these files as part of it's normal package mechanism) - so for now we are
 * using import.meta to find this file, then locating the resource dir relative to that.
 *
 * The present issue is that we are only supporting file: urls for now.
 *
 * An additional complication to consider when improving this is that in the
 * public site, we will usually be running behind apache or nginx, so having the
 * resouces available as files in a known location is important.
 *
 * Also: once we start uploading resources to a CDN, we will want to make corresponding
 * changes to resources URLs.
 */
async function findResourceDir(resourceDirName: string = 'resources') {
    const serverFileUrl = new URL(import.meta.url);
    if(serverFileUrl.protocol !== 'file:')
        throw new Error(`wordwiki server can only be run (for now) with it's code on the local filesystem (to allow access to resource files) - got server file url - ${serverFileUrl} with protocol ${serverFileUrl.protocol}`);
    const serverFilePath = decodeURIComponent(serverFileUrl.pathname);
    const resourceDir = strings.stripRequiredSuffix(serverFilePath, '/wordwiki/wordwiki.ts')+'/'+resourceDirName;
    const resourceMarkerPath = resourceDir+'/'+'resource_dir_marker.txt';
    if(!await fileExists(resourceMarkerPath))
        throw new Error(`resource directory ${resourceDir} is missing marker file ${resourceMarkerPath}`);

    return resourceDir;
}

export let wordwiki: WordWiki|undefined = undefined;

export function getWordWiki(): WordWiki {
    return wordwiki ??= new WordWiki();
}

if (import.meta.main) {
    const args = Deno.args;
    const command = args[0];
    switch(command) {
        case 'serve':
            getWordWiki().startServer({hostname: 'localhost', port: 9000});
            break;
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
