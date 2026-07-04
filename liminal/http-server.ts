/**
 * A titan1c application is a server that takes requests as simple
 * JSON objects and returns responses as simple JSON objects.
 *
 * This abstraction is maintained (rather than directly wiring to a
 * HTTP server) so that the application can be run in multiple environments
 * such as:
 *
 * - under a testing framework without having to route requests though http.
 * - under a Deno HTTP server.
 * - under a Node HTTP server.
 * - as a web worker with requests forwarded from a Deno/Node HTTP server.
 *   (allows for sandboxing and multi threading for multiple projects on
 *    the hosted version)
 * - as a service worker (or web worker) in the browser
 *   (allows field workers to edit the dictionary w/o internet access)
 * - inside a phone application using Apache Cordova (or similar).
 * - inside a desktop application using Electron (or similar).
 *
 * To simplify the interface we do not support streaming.
 *
 * The Request/Response interface does not attempt to reproduce the full
 * richness of HTTP Request/Responses - just what we need for titan1c.  It will
 * be extended as we discover additional requirements.
 */
export interface Request {
    /** Returns a Headers object consisting of the headers associated with request. Note that headers added in the network layer by the user agent will not be accounted for in this object, e.g., the "Host" header. */
    headers: {[key: string]: string};
    /** Returns request's HTTP method, which is "GET" by default. */
    method: string;
    /** Returns the URL of request as a string. */
    url: string;
    body: any;
    /** The peer (TCP client) address, if the concrete server exposes it - e.g.
     *  '127.0.0.1' / '::1' for a local connection.  Used to restrict sensitive
     *  endpoints (the /eval server target) to localhost.  Undefined when the
     *  environment cannot supply it. */
    remoteAddr?: string;
}

export const ResponseMarker = Symbol('ResponseMarker');

export function isMarkedResponse(v: any): v is Response  {
    return v?.marker === ResponseMarker;
}
    
export interface Response {
    marker?: typeof ResponseMarker;
    status: number;
    headers: {[key: string]: string};
    //url: string;
    body: string,
}

export function forwardResponse(forwardToUrl: string, status:number=302): Response {
    return {marker: ResponseMarker, status, headers: {Location: forwardToUrl}, body: forwardToUrl};
}

export const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export function isRedirectResponse(r: any): r is Response {
    return isMarkedResponse(r) && redirectStatuses.has(r.status);
}

/**
 * htmx issues its requests via XHR/fetch, which transparently follows normal
 * HTTP redirects - so a 302 would cause htmx to swap in the *redirected* page's
 * HTML rather than navigating to it.  Instead, htmx looks for an HX-Redirect
 * response header and performs a full client-side navigation when it sees one.
 *
 * This converts one of our normal redirect Responses into the htmx form,
 * preserving any other headers we set (notably Set-Cookie).
 */
export function toHxRedirectResponse(redirect: Response): Response {
    const headers = Object.assign({}, redirect.headers, {'HX-Redirect': redirect.headers['Location']});
    delete headers['Location'];
    return {marker: ResponseMarker, status: 200, headers, body: ''};
}

export function htmlResponse(htmlText: string, status:number=200): Response {
    // Dynamic HTML is auth-gated, personalized and freshly rendered per
    // request: 'no-store' keeps it out of the HTTP cache AND (on most
    // browsers) the back/forward cache - so pressing Back after editing
    // re-requests the list page and shows the edits.  (Safari bfcaches even
    // no-store pages; the pageshow handler in liminal-scripts.js covers it.)
    return {marker: ResponseMarker, status,
            headers: {'cache-control': 'no-store'}, body: htmlText};
}

export function jsonResponse(json:any, status:number=200): Response {
    return jsonTextResponse(JSON.stringify(json??null), status);
}

export function jsonTextResponse(jsonText: string, status:number=200): Response {
    // TODO JSON content type.
    console.info('jsonTextResponse', jsonText);
    return {status,
            headers: {"content-type": "application/json;charset=utf-8"},
            body: jsonText};            
}

export function parseCookies(cookieHeader: string | null | undefined): { [key: string]: string } {
    const cookies: { [key: string]: string } = {};
    if (cookieHeader) {
        const cookieArray = cookieHeader.split(';');
        for (const cookie of cookieArray) {
            // Split on the first '=' only: cookie values may themselves contain
            // '=' (e.g. base64 padding), so a naive split('=') would truncate them.
            const trimmed = cookie.trim();
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const name = decodeURIComponent(trimmed.slice(0, eq));
            const value = decodeURIComponent(trimmed.slice(eq + 1));
            cookies[name] = value;
        }
    }
    return cookies;
}

//export function forwardResponse(url: 

//export type RequestHandler = (request: Request) => Response;

interface HttpServerConfig {
    port?: number,
    hostname?: string,
    /** The URL to ADVERTISE (e.g. http://wordwiki--2.localhost:8882/) - distinct
     *  from the bind hostname, which is always loopback.  Used only for the
     *  startup "Access it at" line; defaults to the bind host when unset. */
    baseUrl?: string,
    contentdirs?: Record<string,string>;
    contentfiles?: Record<string,string>;
    requestHandlerPaths?: Record<string, (request: Request) => Promise<Response>>;
    /** URL path prefixes whose files are CONTENT-ADDRESSED (the hash is in the
     *  path, so the bytes never change under a given URL) - served with
     *  `Cache-Control: immutable` so the browser never revalidates them.  e.g.
     *  ['/content/', '/derived/'].  Only set for genuinely immutable stores. */
    immutableContentPrefixes?: string[];
}

/**
 * Generic Http Server interface for titan1c.
 *
 * This abstraction layer exists to allow titan1c to be run using multiple
 * concrete http server APIs (for example Deno vs Node).
 *
 * Requests and responses are converted to/from the titan1c format.
 * This abstraction allows titan1c to run in non http environments
 * (see server.ts for details).
 */
export class HttpServer {
    constructor(public config: HttpServerConfig) {
    }

    async run(): Promise<void> {
        throw new Error('unimplemented abstract method: HttpServer.start()');
    }
}

