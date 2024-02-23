import * as server from './server.ts';

interface HttpServerConfig {
    port?: number,
    hostname?: string,
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
                public requestHandler: (request: server.Request) => Promise<server.Response>) {
    }

    async run(): Promise<void> {
        throw new Error('unimplemented abstract method: HttpServer.start()');
    }
}
