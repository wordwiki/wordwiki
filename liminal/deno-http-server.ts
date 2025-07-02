/**
 * Implemenation of our HttpServer simplified http interface
 * using the Deno builtin http support.
 */
import * as mime_types from './mime-types.ts';
import * as server from './http-server.ts';
import {HttpServer} from './http-server.ts';
import { serveDir, serveFile } from "jsr:@std/http/file-server";

/**
 * Deno Http server implemenation for titan1c.
 */
export class DenoHttpServer extends HttpServer {
    async run(): Promise<void> {
        
        if (!this.config.port) {
            throw new Error('config must include port for a DenoHttpServer');
        }
        
        let serve_config: Deno.ServeTcpOptions = { port: this.config.port };
        serve_config.port = this.config.port;
        if (this.config.hostname) serve_config.hostname = this.config.hostname;
        
        console.log(`Starting HTTP webserver.  Access it at:  http://${serve_config.hostname||'localhost'}:${serve_config.port}/`);
        
        Deno.serve(serve_config, async (req) => this.serveRequest(req));
    }

    async requestHandler(request: Request): Promise<Response> {
        return new Response("Hello, world!!")
    }
    
    async serveRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const filepath = decodeURIComponent(url.pathname);

        // --- If the path resolves to a content file path, serve that directly
        const resolvedContentFilePath = this.matchContentFilePath(filepath);
        if(resolvedContentFilePath) {
            //console.info(`For request path ${filepath} serving file ${resolvedContentFilePath}`);
            return this.serveFileRequest(request, resolvedContentFilePath);
        }

        // --- If the path matches a registered request handler, use that.
        const requestHandler = this.matchRequestHandlerPath(filepath);
        if(requestHandler)
            return this.serveHandlerRequest(request, requestHandler);

        // Wrong kind of response returned here !!! XXX
        return new Response(`No handler for path: ${String(filepath)}`); //, 404);
    }

    async serveHandlerRequest(denoRequest: Request,
                              requestHandler: (request: server.Request) => Promise<server.Response>): Promise<Response> {
   
        const headers = Object.fromEntries(denoRequest.headers.entries());
        const contentType = headers['content-type'];

        let body: any;
        switch (true) {
            // case !denoRequest.bodyUsed:
            //     console.info('body not used');
            //     body = undefined;
            //     break;
            case contentType === 'application/x-www-form-urlencoded' || contentType == 'multipart/form-data':
                body = extract_form_data(await denoRequest.formData());
                break;
            case contentType === 'application/json' || contentType === "text/plain;charset=UTF-8":
                // XXX the text/plain etc above is wrong FIX
                body = await denoRequest.json();
                console.info('got request body', body);
                break;
            default:
                //console.info('ignoring request body');
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
        let titan1cResponse: server.Response;
        try {
            titan1cResponse = await requestHandler(titan1cRequest);
        } catch(e) {
            // Want error response to be dependent on the desired content type XXX
            console.info('ERROR', e);
            titan1cResponse = server.htmlResponse(`ERROR: ${String(e)}`, 400);
        }
        // The native HTTP server uses the web standard `Request` and `Response`
        // objects.

        // XXX TODO more conversion here. XXX - we are dropping lots of fields.
        // XXX THIS HARD WIRED text/html utf-8 is BORKED - JUST TILL WE GET THINGS WORKING
        const responseHeaders = Object.assign({}, titan1cResponse.headers);
        responseHeaders["content-type"] ??= "text/html; charset=utf-8";
        //console.info('RESPONSE HEADERS', responseHeaders, 'BODY', titan1cResponse.body);

        return new Response(titan1cResponse.body, {
            status: titan1cResponse.status,
            headers: responseHeaders,
        });
    }        
    
    /**
     * Returns a request handler if the request path matches one of
     * the configured request handler prefixes.
     *
     * Uses a linear search - will have to do something fancier if we end
     * up having lots of request directories.
     */
    matchRequestHandlerPath(path: string): ((request: server.Request) => Promise<server.Response>)|undefined {
        //console.info('mapping content path', filepath, 'from', this.config.contentfiles);
        if(!this.config.requestHandlerPaths)
            return undefined;
        
        //console.info(this.config.contentdirs);
        for(const maybeFilePrefix of Object.keys(this.config.requestHandlerPaths)) {
            if(path.startsWith(maybeFilePrefix)) {

                if(!maybeFilePrefix.endsWith('/'))
                    throw new Error(`request dir paths must end in / : "${maybeFilePrefix}"`);
                return this.config.requestHandlerPaths[maybeFilePrefix];
            }
        }

        return undefined;
    }
    
    /**
     * Returns the translated filepath if the request path matches one of
     * the configured content path rewrites.
     *
     * Uses a linear search - will have to do something fancier if we end
     * up having lots of content directories.
     */
    matchContentFilePath(filepath: string): string|undefined {
        //console.info('mapping content path', filepath, 'from', this.config.contentfiles);
        if(this.config.contentfiles) {
            const mappedPath = this.config.contentfiles[filepath];
            if(mappedPath)
                return mappedPath;
        }
        if(this.config.contentdirs) {
            //console.info(this.config.contentdirs);
            for(const maybeFilePrefix of Object.keys(this.config.contentdirs)) {
                if(filepath.startsWith(maybeFilePrefix)) {

                    if (filepath.includes('..'))
                        throw new Error(`File request URLs cannot contain '..' - "${filepath}"`);
                    if(!maybeFilePrefix.endsWith('/'))
                        throw new Error(`Content dir paths must end in / : "${maybeFilePrefix}"`);
                    const replacementPrefix = this.config.contentdirs[maybeFilePrefix];
                    if(!replacementPrefix.endsWith('/'))
                        throw new Error(`Content dir replacement prefix must end in / : "${replacementPrefix}`);

                    const resolvedFilePath = replacementPrefix+filepath.substring(maybeFilePrefix.length);
                    return resolvedFilePath;
                }
            }
        }
        return undefined;
    }

    async serveFileRequest(request: Request, filepath: string) {
        //console.info('serving file request', filepath);
        return serveFile(request, filepath);
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

// if (import.meta.main) {
//     await new DenoHttpServer({port: 9000, contentdirs: {'/puppies/': './PUPPIES/'}}, log_request).run();
// }
