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
}

export interface Response {
    status: number;
    headers: {[key: string]: string};
    //url: string;
    body: string,
}

export function htmlResponse(htmlText: string, status:number=200): Response {
    return {status, headers: {}, body: htmlText};            
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

//export function forwardResponse(url: 

//export type RequestHandler = (request: Request) => Response;

interface HttpServerConfig {
    port?: number,
    hostname?: string,
    contentdirs?: Record<string,string>;
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
    constructor(public config: HttpServerConfig,
                public requestHandler: (request: Request) => Promise<Response>) {
    }

    async run(): Promise<void> {
        throw new Error('unimplemented abstract method: HttpServer.start()');
    }
}

