// deno-lint-ignore-file no-unused-vars, no-explicit-any
/**
 * LiminalApp - the generic application/server core of the liminal micro-framework.
 *
 * An app (e.g. rabid, wordwiki) subclasses LiminalApp and supplies a small set of
 * hooks (its route scope, how to resolve a session into a security context, how
 * to wrap a page in its document template, where its resources live, ...).  The
 * base provides everything generic:
 *
 *   - route dispatch: evaluate a URL-path JS expression against the app's scope
 *     (dispatch), shared by the HTTP handler and the test harness;
 *   - the HTTP request/rpc handler and top-level response coercion
 *     (markup -> HTML, page -> document, redirect -> HX-Redirect, else JSON);
 *   - server lifecycle: startServer, clean self-shutdown (password + pidfile);
 *   - the browser-test bridge: a logged-in browser opts in as a test client and
 *     long-polls for JS to run; evalInBrowser(js) pushes JS onto that loop and
 *     awaits the result.  Plus the named test-run launcher and the dev-only /eval
 *     endpoint (arbitrary JS in the server or the browser).
 *
 * Nothing here knows about volunteers, tables, or rabid's templates - those enter
 * through the hooks below.
 */
import * as markup from './markup.ts';
import {Markup, h} from './markup.ts';
import * as server from './http-server.ts';
import * as strings from './strings.ts';
import * as utils from './utils.ts';
import {DenoHttpServer} from './deno-http-server.ts';
import {parseCookies} from './http-server.ts';
import {evalJsExprSrc} from './jsterp.ts';
import {evalRouteExprSrc} from './routeterp.ts';
import {exists as fileExists} from 'std/fs/mod.ts';
import * as security from './security.ts';
import * as browserAgent from './browser-agent.ts';
import * as date from './date.ts';
import {Temporal} from 'temporal-polyfill';
import {lazy} from './lazy.ts';

export interface LiminalServerConfig {
    hostname: string;
    port: number;
}

// The durable identity/liveness of a browser test client, read back from wherever
// the app persists it (rabid: columns on the login-session row).
export interface TestClientSession {
    session_token: string;
    last_test_client_opt_in?: string;
    last_test_client_heartbeat?: string;
}

// --- Browser test runs ------------------------------------------------------
// A run is a list of cases; each case may intermix in-process checks (query the
// db / dispatch a route) and in-browser checks (app.evalInBrowser).
export interface TestCase { name: string; run: (app: LiminalApp) => Promise<void>; }
export interface TestResult { name: string; ok: boolean; error?: string; }

export async function runTests(app: LiminalApp, cases: TestCase[]): Promise<TestResult[]> {
    const results: TestResult[] = [];
    for(const t of cases) {
        try {
            await t.run(app);
            results.push({name: t.name, ok: true});
        } catch(e) {
            results.push({name: t.name, ok: false, error: e instanceof Error ? e.message : String(e)});
        }
    }
    return results;
}

// Markup summary for the test-client page's "Run tests" button.
export function renderTestResults(results: TestResult[]): Markup {
    const passed = results.filter(r => r.ok).length;
    const allOk = passed === results.length;
    return [h.div, {},
        [h.p, {class: allOk ? 'fw-bold text-success' : 'fw-bold text-danger'},
         `${passed}/${results.length} browser tests passed`],
        [h.ul, {class: 'list-group'},
         results.map(r => [h.li, {class: 'list-group-item d-flex justify-content-between align-items-start'},
             [h.span, {}, (r.ok ? '✓ ' : '✗ ') + r.name],
             r.ok ? undefined : [h.code, {class: 'text-danger ms-2'}, r.error],
         ]),
        ],
    ];
}

// Which interpreter evaluates route expressions, selected once via env var:
//   (unset)/'jsterp' - the full JS-expression interpreter; 'routeterp' - the
// restricted, default-deny route interpreter.
const routeEvalMode = (Deno.env.get('LIMINAL_ROUTE_EVAL') ?? Deno.env.get('RABID_ROUTE_EVAL') ?? 'jsterp').toLowerCase();

function evalRoute(scope: Record<string, any>, jsExprSrc: string): any {
    switch(routeEvalMode) {
        case 'routeterp': return evalRouteExprSrc(scope, jsExprSrc);
        case 'jsterp':
        case '':          return evalJsExprSrc(scope, jsExprSrc);
        default: throw new Error(`liminal: unknown route eval mode '${routeEvalMode}' (expected 'jsterp' or 'routeterp')`);
    }
}

/**
 * Top-level response coercion only: should this evaluated route result be
 * rendered as HTML markup (vs. returned as JSON)?  Accepts a single element
 * (`['div',{...},...]`) or a *fragment* (a bare list whose first non-null item is
 * an element); a genuine JSON array (`[1,2]`, `[{...}]`) is returned as JSON.
 */
export function isTopLevelMarkup(result: any): boolean {
    const isElement = (n: any) =>
        markup.isElemMarkup(n) &&
        (typeof n[0] === 'string' || typeof n[0] === 'function' || typeof n[0] === 'symbol');
    if(isElement(result)) return true;
    if(!Array.isArray(result)) return false;
    const firstMeaningful = result.find(item => item !== null && item !== undefined);
    return isElement(firstMeaningful);
}

/**
 * Make an arbitrary server-side value JSON-safe for the /eval response, mirroring
 * the browser client's serializer: tag the awkward cases (undefined, NaN/Infinity,
 * bigint, function, symbol, Date) rather than letting JSON.stringify drop or choke
 * on them, prefer toJSON() (e.g. Temporal), and guard depth + cycles.
 */
export function serializeValue(v: any): any {
    const seen = new WeakSet<object>();
    function ser(x: any, depth: number): any {
        if(x === undefined) return {__undefined: true};
        if(x === null) return null;
        const t = typeof x;
        if(t === 'number') return Number.isFinite(x) ? x : {__number: String(x)};
        if(t === 'string' || t === 'boolean') return x;
        if(t === 'bigint') return {__bigint: x.toString()};
        if(t === 'function') return {__function: x.name || '(anonymous)'};
        if(t === 'symbol') return {__symbol: String(x)};
        if(x instanceof Date) return {__date: x.toISOString()};
        if(depth > 6) return {__truncated: true};
        if(seen.has(x)) return {__circular: true};
        seen.add(x);
        if(Array.isArray(x)) return x.slice(0, 1000).map((e) => ser(e, depth + 1));
        if(typeof x.toJSON === 'function') { try { return x.toJSON(); } catch(_e) { /* fall through */ } }
        const out: Record<string, any> = {};
        for(const k of Object.keys(x)) out[k] = ser(x[k], depth + 1);
        return out;
    }
    return ser(v, 0);
}

/**
 * A large random number (decimal string) for use as a shutdown/eval password.
 * Two 64-bit random values concatenated (~38-40 digits); kept a string (never
 * parsed as a JS number) so the full value survives.
 */
export function generateLargeRandomPassword(): string {
    const buf = new BigUint64Array(2);
    crypto.getRandomValues(buf);
    return buf[0].toString() + buf[1].toString();
}

/**
 * The generic application/server core.  Subclass and implement the abstract hooks.
 */
export abstract class LiminalApp {

    // ----- Required app hooks -----------------------------------------------

    /** The app's scope name, e.g. 'rabid'.  Used to derive the route-URL prefix,
     *  the shutdown route, the session-cookie name, and the runtime file names. */
    abstract get appName(): string;

    /** The root route-eval scope (must bind the app instance under appName, plus
     *  any pages/constructors reachable from a URL). */
    abstract routes: Record<string, any>;

    /** Resolve a session token into the ambient security context for the request
     *  (anonymous => {actorId: undefined, roles: empty}). */
    abstract resolveSecurityContext(session_token: string | undefined): security.SecurityContext;

    /** The db_purpose marker for this database, or undefined if unmarked. */
    abstract getDbPurpose(): string | undefined;

    // Persist / read the test client's durable identity (rabid: login-session row).
    abstract stampTestClientOptIn(session_token: string, now: string): void;
    abstract stampTestClientHeartbeat(session_token: string, now: string): void;
    abstract mostRecentTestClient(): TestClientSession | undefined;

    /** Wrap a (title, body) into the app's page object (rabid: templates.page). */
    abstract makePage(title: any, body: any): any;

    /** The content directories to serve statically (e.g. {'/resources/': '/abs/path/'}). */
    abstract resourceContentDirs(): Promise<Record<string, string>>;

    /** Named browser test runs, launchable via `<appName>.ts test-run <name>`. */
    abstract testRuns(): Record<string, TestCase[]>;

    // ----- Overridable hooks (sensible defaults) ----------------------------

    /** URL prefix the route handler is mounted under (default `/<appName>/`). */
    get routePrefix(): string { return `/${this.appName}/`; }
    /** Session cookie name (default `<APPNAME>_SESSION_TOKEN`). */
    get sessionCookieName(): string { return `${this.appName.toUpperCase()}_SESSION_TOKEN`; }
    /** Route expr used for the empty path. */
    get homeRouteExpr(): string { return 'home'; }
    /** Runtime file names (written into cwd at startup). */
    get pidFileName(): string { return `${this.appName}.pid`; }
    get shutdownPasswordFileName(): string { return `${this.appName}-shutdown-password.txt`; }
    get evalPasswordFileName(): string { return `${this.appName}-eval-password.txt`; }

    /** The request-handler mount points (default: routePrefix and '/'). */
    requestHandlerPaths(): Record<string, (request: server.Request) => Promise<server.Response>> {
        const handler = (request: server.Request) => this.requestHandler(request);
        return {[this.routePrefix]: handler, '/': handler};
    }

    /** Given an unauthenticated request, return a replacement route expr (e.g. a
     *  login page) or undefined to proceed.  Default: no auth gate. */
    protected rewriteUnauthenticatedRoute(jsExprSrc: string, ctx: security.SecurityContext, requestUrl: string): string | undefined {
        return undefined;
    }

    /** Coerce a route result that is a "page" into a full document (or body-only
     *  for an htmx partial swap).  Default: pass through unchanged. */
    protected coercePageResult(result: any, isHtmxRequest: boolean): any {
        return result;
    }

    /** Evaluate `js` in this server process for the /eval server target.  Default
     *  uses direct eval in THIS module's scope under a system context.  Apps
     *  should OVERRIDE this so the code sees the app's own lexical scope (its
     *  tables etc.) - direct eval only reaches names visible at the eval site. */
    protected evalServer(js: string): Promise<any> {
        const app = this;
        return security.runSystem(() =>
            // deno-lint-ignore no-eval
            eval(`(async () => { ${js}\n})()`));
    }

    // ----- Server lifecycle state -------------------------------------------

    shutdownPassword: string | undefined = undefined;
    pidFilePath: string | undefined = undefined;
    // Authorises the dev-only /eval endpoint; generated ONLY on a non-production
    // db (endpoint hard-off otherwise).  Separate secret from shutdownPassword.
    evalPassword: string | undefined = undefined;

    ignorePaths = new Set(['/favicon.ico', '/.well-known/appspecific/com.chrome.devtools.json']);

    /** Whether this process serves a non-production db - enables the test harness
     *  and /eval.  Memoized: the marker is fixed for a server run, so we read it
     *  once rather than on every page render. */
    @lazy get isTestDb(): boolean {
        let purpose: string | undefined;
        try { purpose = security.runSystem(() => this.getDbPurpose()); }
        catch { purpose = undefined; }
        return purpose !== 'production';
    }

    async startServer(config: LiminalServerConfig) {
        console.info(`Starting ${this.appName} server`);

        // Runtime files in cwd: the pidfile (liveness) and the shutdown password
        // (authorises the clean self-shutdown route), the latter written 0600.
        this.shutdownPassword = generateLargeRandomPassword();
        this.pidFilePath = this.pidFileName;
        Deno.writeTextFileSync(this.pidFilePath, String(Deno.pid) + '\n');
        Deno.writeTextFileSync(this.shutdownPasswordFileName, this.shutdownPassword + '\n', {mode: 0o600});
        console.info(`Wrote ${this.pidFilePath} (pid ${Deno.pid}) and ${this.shutdownPasswordFileName} (mode 0600)`);

        // The /eval endpoint (dev god-mode) is enabled ONLY on a non-production db.
        if(this.isTestDb) {
            this.evalPassword = generateLargeRandomPassword();
            Deno.writeTextFileSync(this.evalPasswordFileName, this.evalPassword + '\n', {mode: 0o600});
            console.info(`Wrote ${this.evalPasswordFileName} (mode 0600) - /eval ENABLED (non-production db)`);
        } else {
            try { Deno.removeSync(this.evalPasswordFileName); } catch(_e) { /* not there - fine */ }
            console.info('/eval endpoint disabled (production db)');
        }

        try {
            const purpose = this.getDbPurpose();
            if(purpose && purpose !== 'production')
                console.warn(`NOTE: serving a '${purpose}' database (not production data).`);
        } catch { /* marker may be absent on an older db; ignore */ }

        const contentdirs = await this.resourceContentDirs();
        await new DenoHttpServer({port: config.port,
                                  hostname: config.hostname,
                                  contentdirs, contentfiles: {},
                                  requestHandlerPaths: this.requestHandlerPaths()}
                                 ).run();
    }

    async requestHandler(request: server.Request): Promise<server.Response> {
        const requestUrl = new URL(request.url);
        const filepath = decodeURIComponent(requestUrl.pathname);

        const searchParams: Record<string, string> = {};
        requestUrl.searchParams.forEach((value: string, key: string) => searchParams[key] = value);

        if(this.ignorePaths.has(filepath))
            return Promise.resolve({status: 200, headers: {}, body: 'not found'});

        console.info('FILE PATH', filepath);
        let jsExprSrc = strings.stripOptionalPrefix(filepath, '/');
        jsExprSrc = strings.stripOptionalPrefix(jsExprSrc, `${this.appName}/`);
        if(jsExprSrc === '') jsExprSrc = this.homeRouteExpr;

        const bodyArgs = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
        const cookies = parseCookies(request.headers['cookie']);
        const session_token = cookies[this.sessionCookieName];
        const isHtmxRequest = request.headers['hx-request'] === 'true';

        // Self-shutdown: matched with a strict digits-only regex and handled
        // directly (not via the interpreter) so the big numeric password is
        // compared as an exact string and no attacker expr is evaluated pre-login.
        const shutdownMatch = jsExprSrc.match(new RegExp(`^${this.appName}\\.shutdown\\((\\d+)\\)$`));
        if(shutdownMatch)
            return this.shutdown(shutdownMatch[1]);

        // Dev-only eval endpoint, matched on the raw path (NOT via the interpreter,
        // so the posted JS is never parsed as a route expr).
        if(filepath === '/eval' || filepath === `${this.routePrefix}eval`)
            return await this.evalEndpoint(request);

        const response = await this.rpcHandler(request.url, jsExprSrc, searchParams, bodyArgs, session_token, isHtmxRequest);

        // For htmx, turn a server-side redirect into an HX-Redirect (htmx follows
        // it as a real client navigation rather than swapping the redirected page).
        if(isHtmxRequest && server.isRedirectResponse(response))
            return server.toHxRedirectResponse(response);
        return response;
    }

    /**
     * Build the route eval scope and evaluate a route expression against it,
     * returning the raw result.  Shared by the HTTP handler and the test harness.
     * Does NOT set up the security context - the caller does (server: from the
     * session; a test: an explicit actor).
     */
    async dispatch(jsExprSrc: string,
                   opts: {queryArgs?: Record<string, any>,
                          bodyArgs?: Record<string, any>,
                          session_token?: string} = {}): Promise<any> {
        const queryArgs = opts.queryArgs ?? {};
        const bodyArgs = opts.bodyArgs ?? {};

        let rootScope: Record<string, any> =
            Object.assign({}, this.routes, {queryArgs, bodyArgs, session_token: opts.session_token});

        // Bind ONLY the positional rpc placeholders ($arg0, ...) from the body, so
        // a request body can't inject or shadow other bindings in the eval scope.
        const rpcArgBindings: Record<string, any> = {};
        for(const [k, v] of Object.entries(bodyArgs))
            if(/^\$arg\d+$/.test(k))
                rpcArgBindings[k] = v;
        rootScope = Object.assign({}, rootScope, rpcArgBindings);

        let result: any = evalRoute(rootScope, jsExprSrc);
        while(result instanceof Promise)
            result = await result;

        // If the expr evaluates to a function, call it (so render functions can be
        // referenced without a trailing "()").
        if(typeof result === 'function')
            result = result.apply(null);

        return result;
    }

    async rpcHandler(requestUrl: string,
                     jsExprSrc: string,
                     queryArgs: Record<string, any>,
                     bodyArgs: Record<string, any>,
                     session_token: string | undefined,
                     isHtmxRequest: boolean = false): Promise<any> {

        console.info('***', new Date().toLocaleString(), '::', jsExprSrc);

        // Resolve the actor's security context once per request and make it
        // ambiently active so the data layer can enforce field-level read perms.
        const ctx = this.resolveSecurityContext(session_token);
        security.enterWith(ctx);

        // Let the app rewrite an unauthenticated request (e.g. to its login page).
        const rewritten = this.rewriteUnauthenticatedRoute(jsExprSrc, ctx, requestUrl);
        if(rewritten !== undefined) {
            console.info('Rewriting unauthenticated route ->', rewritten);
            jsExprSrc = rewritten;
        }

        let result: any = null;
        try {
            result = await this.dispatch(jsExprSrc, {queryArgs, bodyArgs, session_token});
        } catch(e) {
            console.info('request failed', e);
            return server.jsonResponse({error: String(e)}, 400);
        }

        // A "page" result is wrapped in the app's document template (or reduced to
        // body-only for htmx).  Fragment routes pass through untouched.
        result = this.coercePageResult(result, isHtmxRequest);

        if(server.isMarkedResponse(result)) {
            return result;
        } else if(typeof result === 'string') {
            return server.htmlResponse(result);
        } else if(isTopLevelMarkup(result)) {
            let htmlText: string;
            try {
                htmlText = await markup.asyncRenderToStringViaLinkeDOM(result);
            } catch(e) {
                console.info('request failed during content force', e);
                return server.jsonResponse({error: String(e)}, 400);
            }
            return server.htmlResponse(htmlText);
        } else {
            return server.jsonResponse(result);
        }
    }

    // ------------------------------------------------------------------------
    // --- Browser test bridge ------------------------------------------------
    // ------------------------------------------------------------------------
    //
    // A logged-in browser with the 'testing' permission opts in (loads the
    // test-client page), then long-polls for JS to run; evalInBrowser() pushes JS
    // onto that loop and awaits the result.  Transient channel below; durable
    // identity lives wherever the app persists it (the stampTestClient* hooks).

    @lazy get testClientChannel() { return new browserAgent.BrowserAgentChannel(); }

    // Gated twice: refused on a production db, and every route needs 'testing'.
    protected assertHarnessEnabled(): void {
        if(this.getDbPurpose() === 'production')
            throw new Error('the browser test harness is disabled on a production database');
    }
    protected assertTestingRole(): void {
        const ctx = security.current();
        if(!ctx?.system && !ctx?.roles.has('testing'))
            throw new Error("the 'testing' permission is required to use the browser test harness");
    }
    protected requireSession(session_token: string | undefined): string {
        if(!session_token) throw new Error('a login session is required to act as a test client');
        return session_token;
    }

    // The route URLs the browser client posts to (injected into the page so the
    // client is app-agnostic).  We elide the routePrefix: requestHandler strips a
    // leading '/' then '<appName>/', and the handler is also mounted at '/', so
    // '/<appName>.method(...)' routes fine without depending on where the app
    // mounts its prefix (e.g. wordwiki at /ww/).  Method routes keep the '()' -
    // the auto-call of a bare function result loses `this` on a bound method.
    protected testClientRoutes(): {optIn: string, poll: string, result: string} {
        const a = this.appName;
        return {
            optIn:  `/${a}.testClientOptIn(session_token)`,
            poll:   `/${a}.testClientPoll(session_token)`,
            result: `/${a}.testClientResult(session_token,$arg0,$arg1)`,
        };
    }

    // Opt in as the test client (stamps opt-in + heartbeat).  Most-recent opt-in
    // is "the" test client; older ones are told (via testClientPoll) to stop.
    testClientOptIn(session_token?: string) {
        this.assertHarnessEnabled();
        this.assertTestingRole();
        const token = this.requireSession(session_token);
        security.runSystem(() => this.stampTestClientOptIn(token, date.currentSqliteDateTime()));
        return {ok: true, pollTimeoutMs: 25_000};
    }

    async testClientPoll(session_token?: string) {
        this.assertHarnessEnabled();
        this.assertTestingRole();
        const token = this.requireSession(session_token);
        const current = security.runSystem(() => this.mostRecentTestClient());
        if(!current || current.session_token !== token)
            return {stale: true};
        security.runSystem(() => this.stampTestClientHeartbeat(token, date.currentSqliteDateTime()));
        const cmd = await this.testClientChannel.poll(token, {pollTimeoutMs: 25_000});
        return {cmd};
    }

    testClientResult(session_token: string | undefined, cmdId: string, result: browserAgent.BrowserResult) {
        this.assertHarnessEnabled();
        this.assertTestingRole();
        const token = this.requireSession(session_token);
        const delivered = this.testClientChannel.deliverResult(token, String(cmdId), result);
        return {ok: true, delivered};
    }

    /**
     * Run `js` in the current test client's browser and return its
     * (structured-cloned) value.  Always targets the most-recent opt-in - never an
     * older client, even a silent one - so which browser runs is deterministic.
     */
    async evalInBrowser(js: string, opts: {timeoutMs?: number} = {}): Promise<any> {
        this.assertHarnessEnabled();
        const current = security.runSystem(() => this.mostRecentTestClient());
        if(!current)
            throw new Error(`no browser test client has opted in - open /${this.appName}.testClientPage() in a logged-in browser with the 'testing' permission`);
        let res: browserAgent.BrowserResult;
        try {
            res = await this.testClientChannel.enqueue(current.session_token, js, {timeoutMs: opts.timeoutMs ?? 30_000});
        } catch(e) {
            if(e instanceof browserAgent.BrowserEvalTimeout)
                throw new Error(`browser eval timed out after ${e.ms}ms; the most-recent test client last sent a heartbeat at ${current.last_test_client_heartbeat ?? '(never)'} (opted in ${current.last_test_client_opt_in}) - it may be disconnected; reopen the test-client page`);
            throw e;
        }
        if(!res.ok)
            throw new browserAgent.BrowserEvalError(`browser eval threw: ${res.error?.name}: ${res.error?.message}`, res.error);
        return res.value;
    }

    // The opt-in page: injects the route URLs + loads the client script (which
    // opts in, then polls).  Navigating here is the explicit opt-in.
    testClientPage(): any {
        const routes = this.testClientRoutes();
        const runTestsUrl = `/${this.appName}.runBrowserTests()`;
        const body = [
            [h.div, {class: 'container py-3'},
             [h.h2, {}, 'Browser test client'],
             [h.p, {class: 'text-muted'},
              'This browser is now acting as the test client: server-side tests can run JS here and read the result. Leave this tab open. Opening this page again (here or elsewhere) makes that tab the active client.'],
             [h.div, {id: 'test-agent-status', class: 'alert alert-secondary'}, 'starting…'],
             [h.button, {class: 'btn btn-outline-primary',
                         'hx-get': runTestsUrl, 'hx-target': '#test-agent-results', 'hx-swap': 'innerHTML'},
              'Run demo tests'],
             [h.div, {id: 'test-agent-results', class: 'mt-3'}],
             // App-agnostic client: it reads its route URLs from this global.
             [h.script, {}, `window.__liminalTestAgent = ${JSON.stringify(routes)};`],
             [h.script, {src: '/resources/test-agent.js'}],
            ],
        ];
        return this.makePage('Test client', body);
    }

    // Run a named test suite and render the summary (the page's button; default 'demo').
    async runBrowserTests(name: string = 'demo'): Promise<Markup> {
        this.assertHarnessEnabled();
        this.assertTestingRole();
        const cases = this.testRuns()[name] ?? [];
        return renderTestResults(await runTests(this, cases));
    }

    // Seconds since a session's last heartbeat (undefined if it never sent one).
    #heartbeatAgeSeconds(heartbeat: string | undefined): number | undefined {
        if(!heartbeat) return undefined;
        const hb = date.sqliteDateTimeToTemporal(heartbeat);
        return Temporal.Now.plainDateTimeISO().since(hb).total({unit: 'seconds'});
    }

    // Block until a live test client is connected (most-recent opt-in, fresh
    // heartbeat) or waitMs elapses.  Covers the ~1-2s an already-open tab takes to
    // reconnect after a restart - no per-run browser interaction.
    async #waitForTestClient(waitMs: number): Promise<boolean> {
        const freshSeconds = 35;
        const deadline = Date.now() + waitMs;
        let announced = false;
        for(;;) {
            const c = security.runSystem(() => this.mostRecentTestClient());
            const age = this.#heartbeatAgeSeconds(c?.last_test_client_heartbeat);
            if(c && age !== undefined && age <= freshSeconds)
                return true;
            if(Date.now() >= deadline)
                return false;
            if(!announced) {
                console.info(`Waiting for a test client... open /${this.appName}.testClientPage() in a logged-in browser (an already-open tab reconnects on its own).`);
                announced = true;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /**
     * Launch a named browser test run.  Waits for a live test client, runs the
     * suite, prints a summary, returns a process exit code: 0 all-passed, 1
     * failures, 2 unknown run, 3 no client.
     */
    async runNamedTestRun(name: string, opts: {waitMs?: number} = {}): Promise<number> {
        this.assertHarnessEnabled();
        const cases = this.testRuns()[name];
        if(!cases) {
            console.error(`Unknown test run '${name}'. Known runs: ${Object.keys(this.testRuns()).join(', ') || '(none)'}`);
            return 2;
        }
        if(!await this.#waitForTestClient(opts.waitMs ?? 60_000)) {
            console.error(`No test client connected - open /${this.appName}.testClientPage() in a logged-in browser with the 'testing' permission, leave the tab open, and re-run.`);
            return 3;
        }
        console.info(`\nRunning test run '${name}' (${cases.length} test(s))...\n`);
        const results = await runTests(this, cases);
        for(const r of results)
            console.info(r.ok ? `  ok    ${r.name}` : `  FAIL  ${r.name}\n          ${r.error}`);
        const passed = results.filter(r => r.ok).length;
        const allOk = passed === results.length;
        console.info(`\nTest run '${name}': ${passed}/${results.length} passed${allOk ? '' : '  *** FAILURES ***'}`);
        return allOk ? 0 : 1;
    }

    /**
     * Dev-only eval endpoint: run arbitrary JS in this server or the test browser.
     * POST /eval {password, target?:'server'|'browser', js, timeoutMs?}.  Hard-off
     * on a production db; otherwise authorised by the eval password.  The server
     * target additionally requires a localhost peer (RCE on the host).
     */
    async evalEndpoint(request: server.Request): Promise<server.Response> {
        const fail = (status: number, name: string, message: string) =>
            server.jsonResponse({ok: false, error: {name, message}}, status);

        if(!this.isTestDb)
            return fail(403, 'Disabled', 'eval endpoint is disabled on a production database');
        if(this.evalPassword === undefined)
            return fail(403, 'Disabled', 'eval endpoint is not enabled on this server');

        const body = utils.isObjectLiteral(request.body) ? request.body as Record<string, any> : {};
        if(typeof body.password !== 'string' || body.password !== this.evalPassword)
            return fail(403, 'Forbidden', 'invalid eval password');
        if(typeof body.js !== 'string')
            return fail(400, 'BadRequest', "missing 'js' (a string of code to evaluate)");

        const target = body.target ?? 'server';
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 30_000;
        try {
            let value: any;
            if(target === 'browser')
                value = await this.evalInBrowser(body.js, {timeoutMs});      // already serialized by the client
            else if(target === 'server') {
                // RCE on the host: require a loopback peer, and refuse if any
                // forwarding header is present (behind a reverse proxy every peer
                // is loopback and the real client rides in a forwarding header).
                const peer = request.remoteAddr;
                const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === 'localhost';
                const proxied = !!(request.headers['x-forwarded-for'] || request.headers['forwarded'] || request.headers['x-real-ip']);
                if(!isLoopback || proxied)
                    return fail(403, 'Forbidden', `server-target eval is only reachable from localhost (peer: ${peer ?? 'unknown'})`);
                value = serializeValue(await this.evalServer(body.js));
            }
            else
                return fail(400, 'BadRequest', `unknown target '${target}' (expected 'server' or 'browser')`);
            return server.jsonResponse({ok: true, target, value});
        } catch(e: any) {
            return server.jsonResponse({ok: false, target,
                error: {name: e?.name ?? 'Error', message: e?.message ?? String(e), stack: e?.stack}});
        }
    }

    /**
     * Ask this server process to exit cleanly.  Authorised by the shutdown
     * password (compared as an exact string).  Intercepted in requestHandler (not
     * evaluated by the interpreter) and reachable without a login session.
     */
    shutdown(password: string): server.Response {
        if(this.shutdownPassword === undefined)
            return server.jsonResponse({error: 'shutdown is not enabled on this server'}, 403);
        if(password !== this.shutdownPassword)
            return server.jsonResponse({error: 'invalid shutdown password'}, 403);

        console.info('*** Shutdown requested with valid password - exiting.');
        if(this.pidFilePath) {
            try { Deno.removeSync(this.pidFilePath); } catch(_e) { /* already gone - ignore */ }
        }
        setTimeout(() => Deno.exit(0), 100);
        return server.htmlResponse(`${this.appName}: shutting down\n`);
    }
}
