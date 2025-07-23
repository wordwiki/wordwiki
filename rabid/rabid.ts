// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as markup from '../liminal/markup.ts';
import * as schema from "./schema.ts";
import * as server from '../liminal/http-server.ts';
import * as strings from "../liminal/strings.ts";
import * as utils from "../liminal/utils.ts";
import * as random from "../liminal/random.ts";
import {panic} from '../liminal/utils.ts';
import * as config from './config.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as templates from './templates.ts';
import * as orderkey from '../liminal/orderkey.ts';
import {block} from '../liminal/strings.ts';
import {db} from "../liminal/db.ts";
import {Markup, renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM, h} from '../liminal/markup.ts';
import {DenoHttpServer} from '../liminal/deno-http-server.ts';
import {parseCookies} from '../liminal/http-server.ts';
import {evalJsExprSrc} from '../liminal/jsterp.ts';
import {exists as fileExists} from "std/fs/mod.ts"
//import {Home} from './home-page.ts';
import * as home from './home-page.ts';
import {Page} from './page.ts';
import * as volunteer from './volunteer.ts';
import * as event from './event.ts';
import {Table, Tuple} from '../liminal/table.ts';
import * as table from '../liminal/table.ts';
import {serialize, serializeAs, setSerialized, path} from "../liminal/serializable.ts";
import {lazy} from '../liminal/lazy.ts';

import {rpcUrl} from '../liminal/rpc.ts';

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
    @path get passwordHash() { return new volunteer.PasswordHashTable(); }
    @path get volunteerLoginSession() { return new volunteer.VolunteerLoginSessionTable(); }
    @path get timesheet_entry() { return new volunteer.TimesheetEntryTable(); }
    @path get event() { return new event.EventTable(); }
    @path get event_commitment() { return new event.EventCommitmentTable(); }

    @lazy
    get tables() {
        return [this.volunteer, this.passwordHash, this.volunteerLoginSession, this.timesheet_entry, this.event, this.event_commitment];
    }


    // TODO having this just be a method is much nicer, but did like having the
    //      internal stuff (like tables) separted?  or not?  If not, then can
    //      put views (and fragments) on the tables, and they can also be
    //      bound with @path, which will make them automatically rerenderable
    //      in a particularly clean way (if we can figure out the ARGS)
    //      But this is worth investigating.
    home() { return templates.pageTemplate({title: 'home', body: home.home()}); }

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

    ignorePaths = new Set(['/favicon.ico', '/.well-known/appspecific/com.chrome.devtools.json']);
    
    /**
     *
     */
    // Proto request handler till we figure out how we want our urls etc to workc
    async requestHandler(request: server.Request): Promise<server.Response> {
        
        if(false && !request?.url?.endsWith('/favicon.ico'))
            console.info('tagger request', request);
        
        const requestUrl = new URL(request.url);
        const filepath = decodeURIComponent(requestUrl.pathname);

        // 
        const volunteer = request.headers["x-webauth-volunteer"];
        
        const searchParams: Record<string,string> = {};
        requestUrl.searchParams.forEach((value: string, key: string) => searchParams[key] = value);
        
        if (this.ignorePaths.has(filepath)) {
            return Promise.resolve({status: 200, headers: {}, body: 'not found'});
        }

        console.info("FILE PATH", filepath);
        let jsExprSrc = strings.stripOptionalPrefix(filepath, '/');
        // XXX HACK - factor properly (shame! shame!)
        jsExprSrc = strings.stripOptionalPrefix(jsExprSrc, 'rabid/')
        switch(jsExprSrc) { // XXX HACK - move to better place
            case '':
                jsExprSrc = 'home';
                break;
        }

        const bodyParms = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};

        const cookies = parseCookies(request.headers['cookie']);
        const session_token = cookies['RABID_SESSION_TOKEN'];
        
        // TODO PRINT COOKIES HERE.
        // TODO EXPERIMENT WITH ADDING A COOKIE.
        
        return this.rpcHandler(request.url, jsExprSrc, searchParams, bodyParms, session_token, volunteer);
    }

    /**
     *
     */
    async rpcHandler(requestUrl: string,
                     jsExprSrc: string,
                     queryParms: Record<string, any>,
                     bodyParms: Record<string, any>,
                     session_token: string|undefined,
                     volunteer: string|undefined): Promise<any> {

        // --- Top level of root scope is active routes
        let rootScope = this.routes;
        //console.info('ROOTSCOPE', rootScope);

        // --- Push (possibly empty) URL search parameters as a scope
        //     with the single binding 'query'.  Later we may add more stuff
        //     from the request to this scope.
        rootScope = Object.assign({}, rootScope, {queryParms, bodyParms});
        //console.info('rootScope', rootScope);

        // --- If the query request body is a {}, then it is form parms or
        //     a json {} - push on scope.
        //     TODO: move body parms out of the root scope
        //rootScope = Object.assign(Object.create(rootScope), bodyParms);

        console.info("***", new Date().toLocaleString(), '::', volunteer, '::', jsExprSrc);
        // console.info('about to eval', jsExprSrc, 'with root scope ',
        //              JSON.stringify(utils.getAllPropertyNames(rootScope)));


        // Lookup session token to get session
        const session: volunteer.VolunteerLoginSession|undefined =
            session_token ? this.volunteerLoginSession.getBySessionToken.first({session_token}) : undefined;

        // If no session found, render login page instead of the requested page.
        if(false && !session) {
            jsExprSrc = `rabid.login(${JSON.stringify(requestUrl)})`;
        }
        
        let result: any = null;
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

    login(targetUrl: string): Markup {

        // TODO: rendering the login page while already logged in is confusing - probably 301 to the
        //       home page if already logged in.
        // TODO: I think our scheme may be wrong - if the actual login is done by RPC, then we don't need the
        //       targetUrl thing, the 301, the confusion as to whether to render if logged in etc etc -
        //       much better.
        
        const body = [
            [h.h1, {}, 'Login to Rabid - The Red Raccoon Volunteer System'],
            
            [h.form, {name: 'login', method: 'post', action:'rabid.loginRequest(bodyParms.email, bodyParms.password, bodyParms.targetUrl)'},


             [h.div, {class:"form-group"},
              [h.label, {for:"email"}, 'Email address'],
              [h.input, {type:"email", class:"form-control", name:"email", 'aria-describedby':"emailHelp", placeholder:"Enter email"}],
              //[h.small, {id:"emailHelp", class:"form-text text-muted"}, "We'll never share your email with anyone else."],
             ], // div

             [h.div, {class:"form-group"},
              [h.label, {for:"password"}, 'Password'],
              [h.input, {type:"password", class:"form-control", name:"password", placeholder:"Password"}]
             ], // div

             [h.input, {type:'hidden', name: 'targetUrl', value: targetUrl}],
             
             [h.button, {type:"submit", class:"btn btn-primary"}, 'Login'],
            ] // form
        ];
        
        return templates.pageTemplate({title: 'Login', body});
    }
        

    // This should probably be a RPC rather than a page request??
    loginRequest(email: string, password: string, targetUrl: string) {
        // --- Attempt to authenticate
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
