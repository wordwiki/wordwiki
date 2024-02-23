import * as server from './server.ts';
import * as mime_types from './mime-types.ts';
import {HttpServer} from './http-server.ts';

/**
 * Deno Http server implemenation for titan1c.
 */
export class DenoHttpServer extends HttpServer {
    async run(): Promise<void> {
        
        if (!this.config.port) {
            throw new Error('config must include port for a DenoHttpServer');
        }
        let deno_config: Deno.ListenOptions = { port: this.config.port };
        deno_config.port = this.config.port;
        if (this.config.hostname) deno_config.hostname = this.config.hostname;
        
        const server = Deno.listen(deno_config);
        console.log(`HTTP webserver running.  Access it at:  http://${deno_config.hostname||'localhost'}:${deno_config.port}/`);

        for await (const conn of server) {
            // In order to not be blocking, we need to handle each connection individually
            // without awaiting the function
            this.serveConnection(conn);
        }
    }

    async serveConnection(conn: Deno.Conn) {
        // This "upgrades" a network connection into an HTTP connection.
        const httpConn = Deno.serveHttp(conn);
        // Each request sent over the HTTP connection will be yielded as an async
        // iterator from the HTTP connection.
        for await (const requestEvent of httpConn) {
            await this.serveRequest(requestEvent);
        }
    }

    async serveRequest(requestEvent: Deno.RequestEvent) {
        let denoRequest = requestEvent.request;
        const headers = Object.fromEntries(denoRequest.headers.entries());
        const contentType = headers['content-type'];
        //console.info(headers);

        const url = new URL(requestEvent.request.url);
        const filepath = decodeURIComponent(url.pathname);
        //console.info('request filepath', filepath, headers);
        // TODO make this not be hardcoded XXX
        if (filepath.startsWith('/resources/')) {
            if (filepath.includes('..'))
                throw new Error(`File request URLs cannot contain '..' - "${filepath}"`);
            return this.serveFileRequest(requestEvent, '.'+filepath);
        }
        
        let body: any;
        switch (true) {
            case !denoRequest.bodyUsed:
                body = undefined;
                break;
            case contentType === 'application/x-www-form-urlencoded' || contentType == 'multipart/form-data':
                body = extract_form_data(await denoRequest.formData());
                break;
            case contentType === 'application/json':
                body = await denoRequest.json();
                break;
            default:
                body = undefined;
                break;
        }

        let titan1cRequest: server.Request = {
            method: denoRequest.method,
            url: denoRequest.url,
            headers,
            // ISSUE: the body can be parsed in mulitiple ways (for example as a form) - and while we could
            // forward the raw bytes though - we woulid rather parse here (because the various web servers
            // have support for that).   So somehow we need to know how to parse.
            // USE Content-type: 
            body,
        };
        const titan1cResponse = await this.requestHandler(titan1cRequest);
        // The native HTTP server uses the web standard `Request` and `Response`
        // objects.

        // XXX TODO more conversion here. XXX - we are dropping lots of fields.
        return requestEvent.respondWith(new Response(titan1cResponse.body, {
            status: titan1cResponse.status,
            headers: {
                "content-type": "text/html; charset=utf-8",
            },
        }));
//         const body_out = `Your user-agent is:\n\n${
// requestEvent.request.headers.get("user-agent") ?? "Unknown"
// }`;
//         // The requestEvent's `.respondWith()` method is how we send the response
//         // back to the client.
//         requestEvent.respondWith(
//             new Response(body_out, {
//                 status: 200,
//             }),
//         );
    }

    async serveFileRequest(requestEvent: Deno.RequestEvent, filepath: string) {
        console.info('serving file request', filepath);

        let extension = filepath.match(/\.([^./]+)$/)?.[1];
        let mime_type = (extension ? mime_types.extension_to_mime_type[extension] : null)
            || 'text/plain';
        console.info('extension', extension, 'mime_type', mime_type);
        
        // Try opening the file
        let file;
        try {
            file = await Deno.open(filepath, { read: true });
        } catch {
            // If the file cannot be opened, return a "404 Not Found" response
            const notFoundResponse = new Response("404 Not Found", { status: 404 });
            await requestEvent.respondWith(notFoundResponse);
            return;
        }

        // Build a readable stream so the file doesn't have to be fully loaded into
        // memory while we send it
        const readableStream = file.readable;

        //"text/html; charset=utf-8",
        //"image/svg+xml"
        // Build and send the response

        let responseHeaders = new Headers();
        responseHeaders.append("Content-Type", mime_type);
        responseHeaders.append("cross-origin-embedder-policy", "require-corp");
        responseHeaders.append("cross-origin-opener-policy", "same-origin");
        
        const response = new Response(readableStream, { headers: responseHeaders });
                                     //  { headers: {
                                     //      "content-type": mime_type,
                                     //      // NOTE: these CORS things are here for a test. XXX
                                     //      "cross-origin-embedder-policy": "require-corp",
                                     //      "cross-origin-opener-policy:": "same-origin"
                                     //  }},
                                     // );
        await requestEvent.respondWith(response);
        return;
    }
}

function extract_form_data(form_data: FormData): {[key: string]: any} {
    let out: {[key: string]: any} = {};
    form_data.forEach((value, key, parent) => {
        if(value instanceof File) {
            console.error('not handling files yet XXX');
        } else {
            out[key] = value;
        }
    });
    return out;
}

async function log_request(request: server.Request): Promise<server.Response> {
    console.info({'request': request});
    return Promise.resolve({status: 200, headers: {}, url: 'foo', body: 'foo'});
}

if (import.meta.main) {
    await new DenoHttpServer({port: 9000}, log_request).run();
}
