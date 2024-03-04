import * as server from '../utils/http-server.ts';
import {DenoHttpServer} from '../utils/deno-http-server.ts';
import {friendlyRenderPage} from './render-page.ts';
import {ScannedDocument, ScannedPage} from './schema.ts';
import {evalJsExprSrc} from '../utils/jsterp.ts';
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';

// Proto request handler till we figure out how we want our urls etc to workc
async function taggerRequestHandler(request: server.Request): Promise<server.Response> {
    console.info('tagger request', request);
    const requestUrl = new URL(request.url);
    const filepath = decodeURIComponent(requestUrl.pathname);

    const pageRequest = /^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+)[.]html)$/.exec(filepath);
    console.info('pageRequest', pageRequest, 'for', filepath);
    if(pageRequest !== null) {
        const {Book, PageNumber} = pageRequest.groups as any
        if(typeof Book !== 'string') throw new Error('missing book');
        const book = Book;
        if(typeof PageNumber !== 'string') throw new Error('missing page number');
        const page_number = parseInt(PageNumber);
        
        const body = await friendlyRenderPage(book, page_number);
        const html = renderToStringViaLinkeDOM(body);
        return Promise.resolve({status: 200, headers: {}, body: html});
    } else {

        //        evalJsExprSrc({DocF
        
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
        '/content/': 'content/',
        '/derived/': 'derived/'};
    await new DenoHttpServer({port, contentdirs}, taggerRequestHandler).run();
}



function parsePlay() {
    console.info(/^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+))$/.exec('/page/PDM/21'));
    console.info(/^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+))|(?<Puppy>\/puppy\/(?<PuppyBook>[a-zA-Z]+)\/(?<PuppyNumber>[0-9]+))$/.exec('/page/PDM/21'));
    console.info(/^(?<Page>\/page\/(?<Book>)(?<PageNumber>[0-9]+))$/.exec('/page/PDM/7.html'));
    console.info(/^(?<Page>\/page\/(?<Book>)(?<PageNumber>[0-9]+))$/.exec('/page/PDM/7.html'));
}

if (import.meta.main) {
    parsePlay();
    await taggerServer();
}
