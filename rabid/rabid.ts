// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as markup from '../tabula/markup.ts';
import * as schema from "./schema.ts";
import * as server from '../tabula/http-server.ts';
import * as strings from "../tabula/strings.ts";
import * as utils from "../tabula/utils.ts";
import * as random from "../tabula/random.ts";
import {panic} from '../tabula/utils.ts';
import * as config from './config.ts';
import * as timestamp from '../tabula/timestamp.ts';
import * as templates from './templates.ts';
import * as orderkey from '../tabula/orderkey.ts';
import {block} from '../tabula/strings.ts';
import {db} from "../tabula/db.ts";
import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../tabula/markup.ts';
import {DenoHttpServer} from '../tabula/deno-http-server.ts';
import {evalJsExprSrc} from '../tabula/jsterp.ts';
import {exists as fileExists} from "std/fs/mod.ts"
//import {Home} from './home-page.ts';
import * as home from './home-page.ts';
import {Page} from './page.ts';
import * as volunteer from './volunteer.ts';
import * as event from './event.ts';
import {Table, Tuple} from '../tabula/table.ts';
import * as table from '../tabula/table.ts';
import {serialize, serializeAs, setSerialized, path} from "../tabula/serializable.ts";
import {lazy} from '../tabula/lazy.ts';

import {rpcUrl} from '../tabula/rpc.ts';

export interface RabidServerConfig {
    hostname: string,
    port: number,
}

const constructorRoutes: Record<any, any> = {
    TableView: table.TableView,
};

/**
 *
 */
export class Rabid {
    
    routes: Record<string, any>;
    pages: Record<string, any>;

    @path get volunteer() { return new volunteer.VolunteerTable(); }
    @path get event() { return new event.EventTable(); }
    @path get event_commitment() { return new event.EventCommitmentTable(); }

    @lazy
    get tables() {
        return [this.volunteer, this.event, this.event_commitment];
    }
    
    /**
     *
     */
    constructor() {
        
        this.pages = {
            home:()=>templates.pageTemplate({title: 'home', body: home.home()}),
        };
        
        this.routes = Object.assign(
            {},
            {rabid: this},
            this.pages,
            constructorRoutes,
        );
    }

    [serialize](): string {
        return 'rabid';
    }

    /**
     *
     */
    async startServer(config: RabidServerConfig) {
        console.info('Starting rabid server');
        
        const contentdirs = {
            '/resources/': await findResourceDir('resources')+'/',
        };

        const contentfiles = {};
        const requestHandlerPaths: Record<string, (request: server.Request) => Promise<server.Response>> = {
            '/rabid/': request=>this.requestHandler(request),
            '/': request=>this.requestHandler(request),
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
        const volunteer = request.headers["x-webauth-volunteer"];
        requestUrl.searchParams.forEach((value: string, key: string) => searchParams[key] = value);
        console.info("FILE PATH", filepath);
        if (filepath === '/favicon.ico' || filepath === '/.well-known/appspecific/com.chrome.devtools.json') {
            return Promise.resolve({status: 200, headers: {}, body: 'not found'});
        } else {
            let jsExprSrc = strings.stripOptionalPrefix(filepath, '/');
            // XXX HACK - factor properly (shame! shame!)
            jsExprSrc = strings.stripOptionalPrefix(jsExprSrc, 'rabid/')
            switch(jsExprSrc) { // XXX HACK - move to better place
                case '':
                    jsExprSrc = 'home';
                    break;
            }
            const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
            return this.rpcHandler(jsExprSrc, searchParams, bodyParms, volunteer);
        }
    }

    /**
     *
     */
    async rpcHandler(jsExprSrc: string,
                     searchParams: Record<string, any>,
                     bodyParms: Record<string, any>,
                     volunteer: string|undefined): Promise<any> {

        // --- Top level of root scope is active routes
        let rootScope = this.routes;
        //console.info('ROOTSCOPE', rootScope);

        // --- Push (possibly empty) URL search parameters as a scope
        //     with the single binding 'query'.  Later we may add more stuff
        //     from the request to this scope.
        rootScope = Object.assign({}, rootScope, {query: searchParams});
        //console.info('rootScope', rootScope);

        // --- If the query request body is a {}, then it is form parms or
        //     a json {} - push on scope.
        rootScope = Object.assign(Object.create(rootScope), bodyParms);

        console.info("***", new Date().toLocaleString(), '::', volunteer, '::', jsExprSrc);
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

        // If the render expr evaluates to a function, call that function (this allows render
        // functions or closure constructors etc to be called without "()" at the end).
        if(typeof result === 'function') {
            result = result.apply(null);
        }

        if(server.isMarkedResponse(result)) {
            return result;
        } else if(typeof result === 'string') {
            return server.htmlResponse(result);
        } else if(markup.isElemMarkup(result) && Array.isArray(result)/* && result[0] === 'html'*/) { // this squigs me - but is is soooo convenient!
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
        throw new Error(`rabid server can only be run (for now) with it's code on the local filesystem (to allow access to resource files) - got server file url - ${serverFileUrl} with protocol ${serverFileUrl.protocol}`);
    const serverFilePath = decodeURIComponent(serverFileUrl.pathname);
    const resourceDir = strings.stripRequiredSuffix(serverFilePath, '/rabid/rabid.ts')+'/'+resourceDirName;
    const resourceMarkerPath = resourceDir+'/'+'resource_dir_marker.txt';
    if(!await fileExists(resourceMarkerPath))
        throw new Error(`resource directory ${resourceDir} is missing marker file ${resourceMarkerPath}`);

    return resourceDir;
}

// export let globalRabidInst: Rabid|undefined = undefined;

// export function getRabid(): Rabid {
//     return globalRabidInst ??= new Rabid();
// }

export let rabid: Rabid = undefined as unknown as Rabid;

export function getRabid(): Rabid {
    return rabid ??= new Rabid();
}

if (import.meta.main) {
    let rabid = getRabid();
    const args = Deno.args;
    const command = args[0];
    switch(command) {
        case 'serve':
            rabid.startServer({hostname: 'localhost', port: 8888});
            break;
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
