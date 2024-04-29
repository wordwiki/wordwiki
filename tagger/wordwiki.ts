import * as markup from '../utils/markup.ts';
import * as model from './model.ts';
import * as renderPageEditor from './render-page-editor.ts';
import * as schema from "./schema.ts";
import * as server from '../utils/http-server.ts';
import * as strings from "../utils/strings.ts";
import * as utils from "../utils/utils.ts";
import {panic} from '../utils/utils.ts';
import * as view from './view.ts';
import * as workspace from './workspace.ts';
import {VersionedDb} from  './workspace.ts';
import * as config from './config.ts';
import * as entry from './entry-schema.ts';
import * as timestamp from '../utils/timestamp.ts';
import * as templates from './templates.ts';
import * as orderkey from '../utils/orderkey.ts';
import {block} from "../utils/strings.ts";
import {db} from "./db.ts";
import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../utils/markup.ts';
import {DenoHttpServer} from '../utils/deno-http-server.ts';
import {ScannedDocument, ScannedPage, Assertion, updateAssertion, selectScannedDocumentByFriendlyId, Layer, assertionPathToFields, getAssertionPath, BoundingGroup, selectBoundingBoxesForGroup, getOrCreateNamedLayer} from './schema.ts';
import {dictSchemaJson} from "./entry-schema.ts";
import {evalJsExprSrc} from '../utils/jsterp.ts';
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import {pageEditor, PageEditorConfig, renderStandaloneGroup} from './render-page-editor.ts';
import {rpcUrl} from '../utils/rpc.ts';
export interface WordWikiConfig {
    hostname: string,
    port: number,
}

/**
 *
 */
export class WordWiki {
    config: WordWikiConfig;
    routes: Record<string, any>;
    dictSchema: model.Schema;
    #workspace: VersionedDb|undefined = undefined;
    #entriesJSON: any|undefined = undefined;
    #lastAllocatedTxTimestamp: number|undefined;

    /**
     *
     */
    constructor(config: WordWikiConfig) {
        this.config = config;
        
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

    /**
     *
     */
    get entriesJSON(): entry.Entry[] {
        return this.#entriesJSON ??=
            new workspace.CurrentTupleQuery(this.workspace.getTableByTag('dct')).toJSON().entry;
    }

    requestEntriesJSONReload() {
        this.#entriesJSON = undefined;
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

        // --- Create new layer in the specified document id.  
        const document = selectScannedDocumentByFriendlyId().required({friendly_document_id});
        const document_id = document.document_id;
        const layer_id = schema.getOrCreateNamedLayer(document.document_id, 'Tagging', 0);
        const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
            'bounding_group', {document_id, layer_id}, 'bounding_group_id');

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
        const taggerUrl = `/renderPageEditorByPageId(${page_id}, ${JSON.stringify(pageEditorConfig)})`;
        
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
        return {location: `/wordwiki.entry(${entry_id})`};
    }

    
    entry(entryId: number): any {

        const e = this.entriesJSON
            .filter(entry=>entry.entry_id === entryId)[0]
            ?? panic('Unable to find entry', entryId);
        
        const title = entry.renderEntrySpellings(e, e.spelling);
        const body = entry.renderEntry(e);
        
        return templates.pageTemplate({title, body});
    }

    home(): any {
        const title = "Dictionary Editor";
        const body = [
            ['h1', {}, title],

            ['br', {}],
            ['h3', {}, 'Search'],
            this.searchForm(),

            ['br', {}],
            ['h3', {}, 'Reports'],
            ['ul', {},
             ['li', {}, ['a', {href:'/wordwiki.entriesByPDMPage()'}, 'Entries by PDM Page']]
            ],
            
            ['br', {}],
            ['h3', {}, 'Reference Books'],
            ['ul', {},
             ['li', {}, ['a', {href:`/pageEditor("PDM")`}, 'PDM']],
             ['li', {}, ['a', {href:`/pageEditor("Rand")`}, 'Rand']],
             ['li', {}, ['a', {href:`/pageEditor("Clark")`}, 'Clark']],
             ['li', {}, ['a', {href:`/pageEditor("RandFirstReadingBook")`}, 'RandFirstReadingBook']]],
        ];

        return templates.pageTemplate({title, body});
    }

    searchForm(search?: string): any {
        return [
            ['form', {class:'row row-cols-lg-auto g-3 align-items-center', name: 'search', method: 'get', action:'/wordwiki.searchPage(query)'},

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

        //console.info('ENTRIES', this.entriesJSON);

        const search = String(query?.searchText ?? '');

        // replace ' '* with .*\w
        //const searchRegexSrc = `\\b${search.replaceAll(/ /g, ' .*\\b')}`;
        const searchRegexSrc =
            search.startsWith('^') || search.startsWith('\\B') || search.startsWith('\\b')
            ? search
            : `\\b${search}`;
        const searchRegex = new RegExp(searchRegexSrc, 'i');
        console.info('SEARCH IS', search, 'REGEX IS', searchRegexSrc);

        const matchesSet:Set<entry.Entry> = new Set();
        if(search !== '') {
            for(const entry of this.entriesJSON) {
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
        }
        const matches = Array.from(matchesSet.values());
        
        // const entriesWithHouseGloss = search === '' ? [] :
        //     this.entriesJSON.filter(
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
                ['a', {href: `/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e)]
            ];
        }
        
        const body = [
            ['h2', {}, title],

            // --- Query form
            this.searchForm(search),

            // --- Add new entry button
            ['div', {},
             ['button', {onclick:'imports.launchNewLexeme()'}, 'Add new Entry']],
            // --- Results
            ['ul', {},
             matches.map(e=>['li', {}, renderEntryItem(e)]),
            ]
        ];
        
        return templates.pageTemplate({title, body});
    }

    entriesByPDMPage(): any {
        const title = 'Entries by PDM Page';

        const pdmDocumentId =
            selectScannedDocumentByFriendlyId()
                .required({friendly_document_id: 'PDM'})
                .document_id;

        console.time('entriesInDocRefOrder');
        const entriesInDocRefOrder = db().
            all<{page_number: number, x: number, bounding_group_id: number, entry_id: number}, {document_id:number}>(
                block`
/**/     SELECT DISTINCT pg.page_number AS page_number, bg.bounding_group_id AS bounding_group_id, ref.id1 AS entry_id
/**/       FROM dict AS ref
/**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
/**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
/**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
/**/       WHERE ref.ty = 'ref' AND
/**/             bg.document_id = :document_id
/**/       ORDER BY pg.page_number, bb.y, bb.x, ref.id1`, {document_id: pdmDocumentId});
        console.timeEnd('entriesInDocRefOrder');

        console.info(entriesInDocRefOrder);

        const entriesById = new Map(this.entriesJSON.map(entry=>[entry.entry_id, entry]));

        function renderRef(ref: {page_number: number, bounding_group_id: number, entry_id: number}): any {
            const e = entriesById.get(ref.entry_id)
                ?? panic('unable to find entry with id', ref.entry_id);
            return [
                renderStandaloneGroup(ref.bounding_group_id),
                ['a', {href: `/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummary(e), ` - ref on PDM page ${ref.page_number}`]
            ];            
        }
        
        const body = entriesInDocRefOrder.map(ref=>['li', {}, renderRef(ref)]);

        return templates.pageTemplate({title, body});
    }


    
    /**
     *
     */
    async startServer() {
        console.info('Starting wordwiki server');
        
        const contentdirs = {
            '/resources/': await findResourceDir('resources')+'/',
            '/scripts/': await findResourceDir('web-build')+'/',
            '/content/': 'content/',
            '/derived/': 'derived/'};
        await new DenoHttpServer({port: this.config.port,
                                  hostname: this.config.hostname,
                                  contentdirs},
                                 request=>this.requestHandler(request)).run();
    }

    /**
     *
     */
    // Proto request handler till we figure out how we want our urls etc to workc
    async requestHandler(request: server.Request): Promise<server.Response> {
        if(!request?.url?.endsWith('/favicon.ico'))
            console.info('tagger request', request);
        const requestUrl = new URL(request.url);
        const filepath = decodeURIComponent(requestUrl.pathname);
        const searchParams: Record<string,string> = {};
        requestUrl.searchParams.forEach((value: string, key: string) => searchParams[key] = value);
        if(Object.keys(searchParams).length > 0)
            console.info('Search params are:', searchParams);

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
            switch(jsExprSrc) { // XXX HACK - move to better place
                case '':
                    jsExprSrc = 'wordwiki.home()';
                    break;
            }
            const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
            return this.rpcHandler(jsExprSrc, searchParams, bodyParms);
        }
    }

    /**
     *
     */
    async rpcHandler(jsExprSrc: string,
                     searchParams: Record<string, any>,
                     bodyParms: Record<string, any>): Promise<any> {

        // --- Top level of root scope is active routes
        let rootScope = this.routes;

        // --- Push (possibly empty) URL search parameters as a scope
        //     with the single binding 'query'.  Later we may add more stuff
        //     from the request to this scope.
        rootScope = Object.assign(Object.create(rootScope), {query: searchParams});

        // --- If the query request body is a {}, then it is form parms or
        //     a json {} - push on scope.
        rootScope = Object.assign(Object.create(rootScope), bodyParms);

        console.info('about to eval', jsExprSrc, 'with root scope ',
                     JSON.stringify(utils.getAllPropertyNames(rootScope)));

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

        if(typeof result === 'string')
            return server.htmlResponse(result);
        else if(markup.isElemMarkup(result) && Array.isArray(result) && result[0] === 'html') { // this squigs me - but is is soooo convenient!
            let htmlText: string = 'cat';
            try {
                // Note: we allow markup to contain Promises, which we force
                //       at render time.
                htmlText = await markup.asyncRenderToStringViaLinkeDOM(result);
            } catch(e) {
                console.info('request failed during content force', e);
                return server.jsonResponse({error: String(e)}, 400);
            }
            return server.htmlResponse(htmlText);
        } else {
            return server.jsonResponse(result);

        // result can be a command - like forward
        // result can be json, a served page, etc
        // so - want to define a result interface - and have the individualt mentods rethren tnat
        // this can also be the opporthunity to allow streaming
        // this mech is part of our deno server stuff.
        // have shortcuts for returning other things:

        //return Promise.resolve({status: 200, headers: {}, body: 'not found'});        
        }
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
    const resourceDir = strings.stripRequiredSuffix(serverFilePath, '/tagger/wordwiki.ts')+'/'+resourceDirName;
    const resourceMarkerPath = resourceDir+'/'+'resource_dir_marker.txt';
    if(!await fileExists(resourceMarkerPath))
        throw new Error(`resource directory ${resourceDir} is missing marker file ${resourceMarkerPath}`);

    return resourceDir;
}

if (import.meta.main) {
    const args = Deno.args;
    const command = args[0];
    switch(command) {
        case 'serve':
            new WordWiki({hostname: 'localhost', port: 9000}).startServer();
            break;
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
