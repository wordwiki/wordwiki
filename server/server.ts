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
    readonly headers: {[key: string]: string};
    /** Returns request's HTTP method, which is "GET" by default. */
    readonly method: string;
    /** Returns the URL of request as a string. */
    readonly url: string;
    readonly body: any;
}

export interface Response {
    readonly status: number;
    readonly headers: {[key: string]: string};
    readonly url: string;
    readonly body: string,
    
}

//export type RequestHandler = (request: Request) => Response;
