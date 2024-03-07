import * as server from '../utils/http-server.ts';
import {DenoHttpServer} from '../utils/deno-http-server.ts';
import {friendlyRenderPageEditor} from './page-editor.ts';
import * as pageEditor from './page-editor.ts';
import {ScannedDocument, ScannedPage} from './schema.ts';
import * as schema from './schema.ts';
import {evalJsExprSrc} from '../utils/jsterp.ts';
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import * as utils from "../utils/utils.ts";
import * as strings from "../utils/strings.ts";
import { db } from "./db.ts";
let allRoutes_: Record<string, any>|undefined = undefined;

export function allRoutes() {
    return allRoutes_ ??= (()=>Object.assign(
        {},
        pageEditor.routes(),
        schema.routes(),
    ))();
}


// Proto request handler till we figure out how we want our urls etc to workc
async function taggerRequestHandler(request: server.Request): Promise<server.Response> {
    console.info('tagger request', request);
    const requestUrl = new URL(request.url);
    const filepath = decodeURIComponent(requestUrl.pathname);

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
    } else {
        console.info('FILEPATH is ', filepath);
        const jsExprSrc = strings.stripRequiredPrefix(filepath, '/');
        console.info('about to eval', jsExprSrc);
        const result = evalJsExprSrc(allRoutes(), jsExprSrc);
        console.info('result is', result);
        return Promise.resolve({status: 200, headers: {}, body: 'not found'});        
    }
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

// - also need to be able to go backwards (generate nice url for object).

// - one alternative is just to serialize server side, stash in a log, and
//   send id (which includes a password).
// - this gives lots of power at the cost of opaque (and inconsistent) URLs.

// - try something textual first

// - we can know # of args easily enough (by parsing JS text) - but can't know
//   types.  We can textually know types (JSON rules) - and as long as we
//   have an escape hatch to repr something as a string that we use at serialzation
//   time ...
// - /boundingBox/7372/resize/100/100/50/50/render.html
//   (looks up box   )(calls resize       )(calls render)
// - /boundingBox/7372/resize/100/100/50/50//boundingGroup/377/render.html
//   (does a resize action, tossing (non error) result, then doing a render of
//    something else)
// - 

// boundingBox(7372).resize(100,100,50,50),boundingGroup('377').html
// also allow nested exprs
// - this is now a subset of JS - can parse with a JS parser, then dispatch
//   of the AST ???
// ().,

// https://www.rfc-editor.org/rfc/rfc3986#page-13
// 





// - objects have identity based on DB identity.
// - can spin up an obj client side with just an id, then call a method on it.
//   (calls will need to be async)
// - return values can include identity of objects, which will auto create objects.
// - should be able to lazy load the scanned doc record, or be pre-pop with
// - should have methods on that will do updates, render things etc.
// - should be able to have methods that are not exposed over the wire.
// - ideally use magic to type the client side of this (without pulling
//   the code over - (for example proxy-based dispatch, but fully typed)
// - serialized versions of identity and calls can also be sane URLs
//   (for example a particular render of a page)
// - use the RPC mech we made for prev version as a base.
// - htmlx compatible (if we are going to use that) (or do our own thing)
//   - htmlx will make our thing much simpler (having the binding and
//     replacement instructions as part of the document).
//   - htmlx will do straight http requests for content URLs, which will
//     dispatch though these objects to render.
//   - so, when using the HTMLx stuff, we are not using the RPC layer -
//     but that is fine.
// - should play with htmlx next.

export async function taggerServer(port: number = 9000) {
    console.info('Starting tagger server');
    
    const contentdirs = {
        '/resources/': await findResourceDir()+'/',
        '/content/': 'content/',
        '/derived/': 'derived/'};
    await new DenoHttpServer({port, contentdirs}, taggerRequestHandler).run();
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
async function findResourceDir() {
    const serverFileUrl = new URL(import.meta.url);
    if(serverFileUrl.protocol !== 'file:')
        throw new Error(`wordwiki server can only be run (for now) with it's code on the local filesystem (to allow access to resource files) - got server file url - ${serverFileUrl} with protocol ${serverFileUrl.protocol}`);
    const serverFilePath = decodeURIComponent(serverFileUrl.pathname);
    const resourceDir = strings.stripRequiredSuffix(serverFilePath, '/tagger/server.ts')+'/resources';
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

/*
  {
  bounding_box_id: 39969,
  imported_from_bounding_box_id: null,
  bounding_group_id: 39969,
  document_id: 1,
  layer_id: 3,
  page_id: 201,
  x: 1019,
  y: 2336,
  w: 371,
  h: 133,
  color: null,
  tags: null,
  text: "literain",
  notes: null
  }
*/



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
}
