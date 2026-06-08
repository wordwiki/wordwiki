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
import * as timesheet from './timesheet.ts';
import * as event from './event.ts';
import * as commitment from './commitment.ts';
import {Table, Tuple} from '../liminal/table.ts';
import * as table from '../liminal/table.ts';
import {serialize, serializeAs, setSerialized, path} from "../liminal/serializable.ts";
import {lazy} from '../liminal/lazy.ts';
import {activityReport, dailyActivityReport} from './activity_report.ts';
import { Temporal } from 'temporal-polyfill';
import {rpcUrl} from '../liminal/rpc.ts';
import * as passwordUtils from '../liminal/password.ts';
import * as date from '../liminal/date.ts';

export interface RabidServerConfig {
    hostname: string,
    port: number,
}

const constructorRoutes: Record<any, any> = {
    TableView: table.TableView,
};

/**
 * Top-level response coercion only: should this evaluated route result be
 * rendered as HTML markup (vs. returned as JSON)?
 *
 * We accept either a single element (`['div', {...}, ...]`) or a *fragment* - a
 * bare list of markup items, e.g. `[['p',{},...], ['table',{},...]]` - so that
 * render helpers can return a list of siblings without being forced to wrap them
 * in a single root element.  A fragment is discriminated by its first non-null
 * item being an element; a genuine JSON array (`[1,2]`, `[{...}]`) is not, and is
 * returned as JSON.  The two cases are disjoint: a single element has a *string*
 * tag at [0], a fragment has an element there.
 *
 * This is a deliberate, top-level-only kludge - markup.isElemMarkup, used inside
 * the markup model, is exact and unchanged.
 */
function isTopLevelMarkup(result: any): boolean {
    // A genuine element is `[tag, attrs, ...]` where tag is a string/function/
    // symbol.  markup.isElemMarkup only checks that [1] is an object, which gives
    // a false positive for an array of records (e.g. a query's `.all()` result),
    // whose [1] is just another record object - so we additionally require a
    // valid tag at [0].  (We keep this stricter check here, at the top level,
    // rather than changing markup.isElemMarkup, which is exact within the model.)
    const isElement = (n: any) =>
        markup.isElemMarkup(n) &&
        (typeof n[0] === 'string' || typeof n[0] === 'function' || typeof n[0] === 'symbol');
    if(isElement(result))
        return true;
    if(!Array.isArray(result))
        return false;
    // A fragment: a list of markup items whose first non-null item is an element.
    const firstMeaningful = result.find(item => item !== null && item !== undefined);
    return isElement(firstMeaningful);
}

/**
 *
 */
export class Rabid {
    
    routes: Record<string, any>;
    pages: Record<string, any>;

    // The large random password (a decimal string) that authorises the
    // rabid.shutdown(<password>) route, and the path of the pidfile we wrote at
    // startup.  Both are populated by startServer().
    shutdownPassword: string|undefined = undefined;
    pidFilePath: string|undefined = undefined;

    @path get volunteer() { return new volunteer.VolunteerTable(); }
    @path get passwordHash() { return new volunteer.PasswordHashTable(); }
    @path get volunteerLoginSession() { return new volunteer.VolunteerLoginSessionTable(); }
    @path get timesheet_entry() { return new timesheet.TimesheetEntryTable(); }
    @path get event() { return new event.EventTable(); }
    @path get event_commitment() { return new commitment.EventCommitmentTable(); }

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
    home() { return templates.page('home', home.home()); }
    volunteers() { return templates.page('Volunteers', this.volunteer.renderSearchableVolunteers()); }

    /**
     *
     */
    constructor() {
        
        this.pages = {
            home:()=>this.home(),
            volunteers:()=>this.volunteers(),
            activityReport:()=>templates.page('Activity Report', activityReport()),
            dailyActivityReport:()=>templates.page(
                'Daily Activity Report',
                dailyActivityReport(
                    Temporal.Now.plainDateISO().subtract({ days: 30 }),
                    Temporal.Now.plainDateISO()
                )
            ),
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

        // --- Write runtime files into the current working directory:
        //     - rabid.pid: our process id, so a supervisor (or a human) can
        //       check whether we are alive (modulo pid reuse) without grepping.
        //     - rabid-shutdown-password.txt: a large random number that must be
        //       supplied to the rabid.shutdown(<password>) route to ask this
        //       process to exit cleanly (so e.g. systemd can restart it rather
        //       than us being kill -9'd).  It is a secret, so we write it 0600.
        this.shutdownPassword = generateShutdownPassword();
        this.pidFilePath = 'rabid.pid';
        const shutdownPasswordPath = 'rabid-shutdown-password.txt';
        Deno.writeTextFileSync(this.pidFilePath, String(Deno.pid) + '\n');
        Deno.writeTextFileSync(shutdownPasswordPath, this.shutdownPassword + '\n', {mode: 0o600});
        console.info(`Wrote ${this.pidFilePath} (pid ${Deno.pid}) and ${shutdownPasswordPath} (mode 0600)`);

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

        const bodyArgs = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};

        const cookies = parseCookies(request.headers['cookie']);
        const session_token = cookies['RABID_SESSION_TOKEN'];
        
        // TODO PRINT COOKIES HERE.
        // TODO EXPERIMENT WITH ADDING A COOKIE.

        // Whether this request was issued by htmx (a partial swap) rather than a
        // full-page navigation.  Used both to adapt redirects (below) and to
        // decide whether a page() result is wrapped in the document template.
        const isHtmxRequest = request.headers['hx-request'] === 'true';

        // --- Special-case the self-shutdown route.  We match it with a strict
        //     digits-only regex and handle it directly rather than via jsterp so
        //     that (a) the large numeric password is compared as an exact string
        //     (a 40-digit number would lose precision if parsed as a JS number),
        //     and (b) no attacker-supplied expression is ever evaluated on this
        //     deliberately pre-login path - the only thing we accept is digits.
        const shutdownMatch = jsExprSrc.match(/^rabid\.shutdown\((\d+)\)$/);
        if(shutdownMatch)
            return this.shutdown(shutdownMatch[1]);

        const response = await this.rpcHandler(request.url, jsExprSrc, searchParams, bodyArgs, session_token, volunteer, isHtmxRequest);

        // If this request was issued by htmx (rather than a full-page navigation),
        // translate any server-side redirect into an HX-Redirect so that htmx
        // performs a real client-side navigation instead of swapping in the
        // redirected page.  This lets stateful actions just return
        // server.forwardResponse(url) and work correctly from both htmx and
        // plain <form> posts.
        if(isHtmxRequest && server.isRedirectResponse(response))
            return server.toHxRedirectResponse(response);

        return response;
    }

    /**
     *
     */
    async rpcHandler(requestUrl: string,
                     jsExprSrc: string,
                     queryArgs: Record<string, any>,
                     bodyArgs: Record<string, any>,
                     session_token: string|undefined,
                     volunteer: string|undefined,
                     isHtmxRequest: boolean = false): Promise<any> {

        // --- Top level of root scope is active routes
        let rootScope = this.routes;
        //console.info('ROOTSCOPE', rootScope);

        // --- Push (possibly empty) URL search parameters as a scope
        //     with the single binding 'query'.  Later we may add more stuff
        //     from the request to this scope.
        rootScope = Object.assign({}, rootScope, {queryArgs, bodyArgs, session_token});
        //console.info('rootScope', rootScope);

        // --- Bind the positional rpc argument placeholders ($arg0, $arg1, ...)
        //     that the client tx``/rpc`` mechanism posts in the request body, so
        //     an expr like `rabid.volunteer.saveForm($arg0)` can resolve them.
        //     We deliberately bind ONLY keys of the form $argN - not arbitrary
        //     body keys - so a request body cannot inject or shadow other
        //     bindings (routes, queryArgs, session_token) in the eval scope.
        //     (This replaces the old, disabled "spread the whole body" approach.)
        const rpcArgBindings: Record<string, any> = {};
        for(const [k, v] of Object.entries(bodyArgs))
            if(/^\$arg\d+$/.test(k))
                rpcArgBindings[k] = v;
        rootScope = Object.assign({}, rootScope, rpcArgBindings);

        console.info("***", new Date().toLocaleString(), '::', volunteer, '::', jsExprSrc);
        // console.info('about to eval', jsExprSrc, 'with root scope ',
        //              JSON.stringify(utils.getAllPropertyNames(rootScope)));


        // Lookup session token to get session
        const session: volunteer.VolunteerLoginSession|undefined =
            session_token ? this.volunteerLoginSession.getBySessionToken.first({session_token}) : undefined;

        const allowedWithoutLoginJsExprsWhitelist = new Set([
            'rabid.loginRequest(bodyArgs)'
        ]);

        const noLoginRequired = false;  // XXX this will be replaced with server CLI args to supply test userid/password.
        const redirectToLoginPage = !(noLoginRequired || !!session || allowedWithoutLoginJsExprsWhitelist.has(jsExprSrc));
        if(redirectToLoginPage) {
            console.info('Redirecting to login');
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

        // A page() result (a navigable entry point) is wrapped in the site
        // document template for a top-level navigation, or reduced to just its
        // body for an htmx request - plus a <title> element so htmx still updates
        // the browser tab on a partial swap.  Fragment routes don't return a
        // page() and pass through here untouched (never wrapped).
        if(templates.isPage(result)) {
            result = isHtmxRequest
                ? [[h.title, {}, result.title], result.body]
                : templates.pageTemplate({title: result.title, body: result.body});
        }

        if(server.isMarkedResponse(result)) {
            return result;
        } else if(typeof result === 'string') {
            return server.htmlResponse(result);
        } else if(isTopLevelMarkup(result)) {
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

    login(targetUrl: string, errorMessage?: string): Markup {

        // TODO: rendering the login page while already logged in is confusing - probably 301 to the
        //       home page if already logged in.
        // TODO: I think our scheme may be wrong - if the actual login is done by RPC, then we don't need the
        //       targetUrl thing, the 301, the confusion as to whether to render if logged in etc etc -
        //       much better.

        const body = [
            [h.div, {class: 'container mt-5'},
                [h.div, {class: 'row justify-content-center'},
                    [h.div, {class: 'col-md-6 col-lg-5'},
                        [h.div, {class: 'card shadow'},
                            [h.div, {class: 'card-body p-5'},
                                [h.h1, {class: 'text-center mb-2'}, 'Welcome to Rabid'],
                                [h.p, {class: 'text-center text-muted mb-4'}, 'The Red Raccoon Volunteer System'],

                                errorMessage
                                    ? [h.div, {class: 'alert alert-danger', role: 'alert'}, errorMessage]
                                    : undefined,

                                [h.form, {name: 'login', method: 'post', action:'rabid.loginRequest(bodyArgs)'},
                                    [h.div, {class:"form-group mb-3"},
                                        [h.label, {for:"email"}, 'Email address'],
                                        [h.input, {
                                            type:"email", 
                                            class:"form-control", 
                                            name:"email", 
                                            id:"email",
                                            placeholder:"volunteer@example.com",
                                            required: true
                                        }],
                                    ],

                                    [h.div, {class:"form-group mb-4"},
                                        [h.label, {for:"password"}, 'Password'],
                                        [h.input, {
                                            type:"password", 
                                            class:"form-control", 
                                            name:"password", 
                                            id:"password",
                                            placeholder:"Enter your password",
                                            required: true
                                        }]
                                    ],

                                    [h.input, {type:'hidden', name: 'targetUrl', value: targetUrl}],
                                    
                                    [h.button, {type:"submit", class:"btn btn-primary btn-block w-100"}, 'Sign In'],
                                    
                                    [h.div, {class: 'text-center mt-3'},
                                       [h.a, {href: 'mailto:info@redraccoon.org', class: 'text-decoration-none'}, 'Contact info@redraccoon.org for password help']
                                    ]
                                ]
                            ]
                        ]
                    ]
                ]
            ]
        ];
        
        return templates.page('Login', body);
    }
        

    loginRequest(args: {email?: string, password?: string, targetUrl?: string}) {

        const {email, password} = args;
        const targetUrl = args.targetUrl || '/';

        // On failure we re-render the login page with a specific, human-readable
        // message (rather than throwing raw JSON).  The messages are intentionally
        // specific so they are useful when diagnosing volunteer support requests.
        const reRenderWithError = (message: string) =>
            this.login(targetUrl, message);

        if(!email)
            return reRenderWithError('Please enter your email address');
        if(!password)
            return reRenderWithError('Please enter your password');

        // --- Lookup volunteer by email
        const volunteer = rabid.volunteer.byEmail.first({email});
        if(!volunteer)
            return reRenderWithError('No account was found for that email address');

        // --- Lookup password record for volunteer
        const passwordHashRecord = rabid.passwordHash.byVolunteerId.first({volunteer_id: volunteer.volunteer_id});
        const {password_salt, password_hash} = passwordHashRecord ?? {};
        if(!password_salt || !password_hash)
            return reRenderWithError('No password has been set for this account');

        // --- Hash supplied password with salt from password_hash_record
        const hashedSuppliedPassword = passwordUtils.hashPassword(password, password_salt);

        // --- Hashed password must match stored password
        if(hashedSuppliedPassword !== password_hash)
            return reRenderWithError('Incorrect password');

        // --- Generate a new login session
        const now = date.currentSqliteDateTime();
        const session_token = passwordUtils.generateSessionToken();
        const sessionId = rabid.volunteerLoginSession.insert({
            session_token,
            volunteer_id: volunteer.volunteer_id,
            start_time: now,
            last_resume_time: now,
            last_ip: '', // TODO
        });

        // --- Set the RABID_SESSION_TOKEN cookie to the session_token and 302
        //     redirect to the originally requested page.
        const response = server.forwardResponse(targetUrl);
        // Note: session tokens are base64 (no '=' padding for our 24-byte tokens),
        //       so they are safe to use directly as a cookie value.
        // Max-Age is set to 400 days, which is the longest lifetime modern
        // browsers will honour (they hard-cap cookie expiry at 400 days per the
        // cookie spec, so there is no such thing as a "forever" cookie).  The
        // authoritative session lifetime lives in the volunteer_session table -
        // deleting that row ends the session regardless of the cookie's age.
        const fourHundredDaysInSeconds = 400 * 24 * 60 * 60;
        response.headers['Set-Cookie'] =
            `RABID_SESSION_TOKEN=${session_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${fourHundredDaysInSeconds}`;
        return response;
    }

    /**
     * Log out by clearing the current session (both server-side record and
     * client cookie) and redirecting to the home page.
     */
    logout(session_token?: string): server.Response {
        if(session_token) {
            db().execute<{session_token: string}>(
                'DELETE FROM volunteer_session WHERE session_token = :session_token',
                {session_token});
        }
        const response = server.forwardResponse('/');
        response.headers['Set-Cookie'] =
            'RABID_SESSION_TOKEN=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
        return response;
    }

    /**
     * Ask this server process to exit cleanly.  Authorised by the large random
     * password written to rabid-shutdown-password.txt at startup (compared as an
     * exact string).  Intended for restarts and for supervisors such as systemd
     * (which can then start a fresh process) - cleaner than kill -9.
     *
     * Note: this route is intercepted in requestHandler (not evaluated by jsterp)
     * and is reachable without a login session - the shutdown password is the
     * only credential.
     */
    shutdown(password: string): server.Response {
        if(this.shutdownPassword === undefined)
            return server.jsonResponse({error: 'shutdown is not enabled on this server'}, 403);
        if(password !== this.shutdownPassword)
            return server.jsonResponse({error: 'invalid shutdown password'}, 403);

        console.info('*** Shutdown requested with valid password - exiting.');

        // --- Best-effort removal of the pidfile so a stale one is not left behind.
        if(this.pidFilePath) {
            try { Deno.removeSync(this.pidFilePath); } catch(_e) { /* already gone - ignore */ }
        }

        // --- Exit shortly after this response is flushed so the caller (and any
        //     supervisor) sees a clean reply before the process dies.
        setTimeout(() => Deno.exit(0), 100);

        return server.htmlResponse('rabid: shutting down\n');
    }

}

/**
 * Generate a large random number (as a decimal string) for use as the
 * shutdown password.  Two 64-bit random values are concatenated, giving ~38-40
 * digits of entropy.  We keep it a string (and never parse it as a JS number)
 * so the full value survives - a number this large exceeds Number.MAX_SAFE_INTEGER.
 */
function generateShutdownPassword(): string {
    const buf = new BigUint64Array(2);
    crypto.getRandomValues(buf);
    return buf[0].toString() + buf[1].toString();
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
