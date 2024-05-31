// deno-lint-ignore-file no-unused-vars
import * as server from '../utils/http-server.ts';
import {DenoHttpServer} from '../utils/deno-http-server.ts';
import {friendlyRenderPageEditor} from './render-page-editor.ts';
import * as pageEditor from './render-page-editor.ts';
import {ScannedDocument, ScannedPage} from './schema.ts';
import * as schema from './schema.ts';
import {evalJsExprSrc} from '../utils/jsterp.ts';
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import * as utils from "../utils/utils.ts";
import * as strings from "../utils/strings.ts";
import { db } from "./db.ts";
import * as workspace from './workspace.ts';
import * as markup from '../utils/markup.ts';

let allRoutes_: Record<string, any>|undefined = undefined;

export function allRoutes() {
    return allRoutes_ ??= (()=>Object.assign(
        {},
        pageEditor.routes(),
        schema.routes(),
        workspace.routes(),
    ))();
}

// Proto request handler till we figure out how we want our urls etc to workc
async function taggerRequestHandler(request: server.Request): Promise<server.Response> {
    //console.info('tagger request', request);
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

        const body = await friendlyRenderPageEditor(book, page_number);
        const html = renderToStringViaLinkeDOM(body);
        return Promise.resolve({status: 200, headers: {}, body: html});
    } else if (filepath === '/favicon.ico') {
        return Promise.resolve({status: 200, headers: {}, body: 'not found'});
    } else if (filepath === '/workspace-rpc-and-sync') {
        console.info('workspace sync request');
        const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
        return workspace.workspaceRpcAndSync(bodyParms as workspace.WorkspaceRpcAndSyncRequest);
    } else {
        const jsExprSrc = strings.stripOptionalPrefix(filepath, '/');
        const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
        return taggerRpcHandler(jsExprSrc, searchParams, bodyParms);
    }
}

export async function taggerRpcHandler(jsExprSrc: string,
                                       searchParams: Record<string, any>,
                                       bodyParms: Record<string, any>): Promise<any> {
    // --- Top level of root scope is active routes
    const routes = allRoutes();
    let rootScope = routes;

    // --- If we have URL search parameters, push them as a scope
    if(Object.keys(searchParams).length > 0)
        rootScope = Object.assign(Object.create(rootScope), searchParams);

    // --- If the query request body is a {}, then it is form parms or
    //     a json {} - push on scope.
    rootScope = Object.assign(Object.create(rootScope), bodyParms);

    console.info('about to eval', jsExprSrc, 'with root scope ',
                 utils.getAllPropertyNames(rootScope));

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
    else if(markup.isElemMarkup(result) && Array.isArray(result) && result[0] === 'html') // this squigs me - but is is soooo convenient!
        return server.htmlResponse(markup.renderToStringViaLinkeDOM(result));
    else
        return server.jsonResponse(result);

    // result can be a command - like forward
    // result can be json, a served page, etc
    // so - want to define a result interface - and have the individualt mentods rethren tnat
    // this can also be the opporthunity to allow streaming
    // this mech is part of our deno server stuff.
    // have shortcuts for returning other things:

    //return Promise.resolve({status: 200, headers: {}, body: 'not found'});
}


// Make a fancy facade over a db record that can be initted in a bunch of different
//  ways using static methods.
// Doc.forRecord({...});
// Doc.forFriendlyId('PDM').pageByNumber(7).render()
// Page.byNumber(Doc.byFriendlyId('PDM').id, 17);
// BoundingBox.byId(73772).render()
// new Doc(docById(777))
// new Page(pageByNumber(docById(777)

class RecordFacade {
    // - problem with static methods is we won't be constructing the real type.
    // - probably have to use builders.  Want lazy eval of args, but don't want
    //   to have to type all the ... so capture using closures.
    // - perhaps constructor arg can be the closure?
}

class Doc extends RecordFacade {
}

class Facade {
}


class DbRecordFacade<T> extends Facade {
    #record: T|undefined;

    constructor(public id: number, record: T|undefined) {
        super();
        this.#record = record;
    }

    get record(): T {
        throw new Error('not impl yet');
    }
}

class ScannedDocumentFacade extends DbRecordFacade<ScannedDocument> {

    page(page_num: number): ScannedPageFacade {
        // Lookup page num in document, and return a page facade based on page_id
        // ideally, we can traverse across this with an URL like
        //    /document/PDM/page/32
        throw new Error('not impl');
    }
}

class ScannedPageFacade extends DbRecordFacade<ScannedPage> {
}

export async function taggerServer(port: number = 9000, hostname: string = 'localhost') {
    console.info('Starting tagger server');

    const contentdirs = {
        '/resources/': await findResourceDir('resources')+'/',
        '/scripts/': await findResourceDir('web-build')+'/',
        '/content/': 'content/',
        '/derived/': 'derived/'};
    await new DenoHttpServer({port, hostname, contentdirs}, taggerRequestHandler).run();
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
    const resourceDir = strings.stripRequiredSuffix(serverFilePath, '/tagger/server.ts')+'/'+resourceDirName;
    const resourceMarkerPath = resourceDir+'/'+'resource_dir_marker.txt';
    if(!await fileExists(resourceMarkerPath))
        throw new Error(`resource directory ${resourceDir} is missing marker file ${resourceMarkerPath}`);

    return resourceDir;
}

function parsePlay() {
    console.info(/^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+))$/.exec('/page/PDM/21'));
    console.info(/^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+))|(?<Puppy>\/puppy\/(?<PuppyBook>[a-zA-Z]+)\/(?<PuppyNumber>[0-9]+))$/.exec('/page/PDM/21'));
    console.info(/^(?<Page>\/page\/(?<Book>)(?<PageNumber>[0-9]+))$/.exec('/page/PDM/7.html'));
    console.info(/^(?<Page>\/page\/(?<Book>)(?<PageNumber>[0-9]+))$/.exec('/page/PDM/7.html'));
}


function printBB(bounding_box_id: number) {
    console.info(schema.selectBoundingBox().required({bounding_box_id}));
}

function sqlPlay() {
    const id = 39969;
    printBB(id);
    console.info('A');
    db().executeStatements(`UPDATE bounding_box SET x=7 WHERE bounding_box_id = 39969`);
    console.info('CC');
    db().execute<{}>(`UPDATE bounding_box SET x=7 WHERE bounding_box_id = 39969`, {});
    console.info('B');
    //db().execute<{}>(`UPDATE TABLE bounding_box SET x, y, w, h = (1,2,3,4) WHERE bounding_box_id = 39969`, {});

}

if (import.meta.main) {
    //sqlPlay();
    //parsePlay();
    await taggerServer();
    //await taggerServer(9000, "0.0.0.0");
}
