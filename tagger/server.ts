import * as server from '../utils/http-server.ts';
import {DenoHttpServer} from '../utils/deno-http-server.ts';
import {friendlyRenderPage} from './render-page.ts';

// Proto request handler till we figure out how we want our urls etc to workc
async function taggerRequestHandler(request: server.Request): Promise<server.Response> {
    console.info('tagger request', request);
    const requestUrl = new URL(request.url);
    const filepath = decodeURIComponent(requestUrl.pathname);

    const pageRequest = /^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+)[.]html)$/.exec(filepath);
    console.info('pageRequest', pageRequest, 'for', filepath);
    if(pageRequest !== null) {
        const {Book, PageNumber} = pageRequest.groups as any
        if(typeof Book !== 'string') throw new Error('missing book');
        const book = Book;
        if(typeof PageNumber !== 'string') throw new Error('missing page number');
        const page_number = parseInt(PageNumber);
        
        const body = await friendlyRenderPage(book, page_number);
        
        return Promise.resolve({status: 200, headers: {}, body});
    } else {
        return Promise.resolve({status: 200, headers: {}, body: 'not found'});        
    }
    
    
}

export async function taggerServer(port: number = 9000) {
    console.info('Starting tagger server');
    const contentdirs = {
        '/content/': 'content/',
        '/derived/': 'derived/'};
    await new DenoHttpServer({port, contentdirs}, taggerRequestHandler).run();
}



function parsePlay() {
    console.info(/^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+))$/.exec('/page/PDM/21'));
    console.info(/^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+))|(?<Puppy>\/puppy\/(?<PuppyBook>[a-zA-Z]+)\/(?<PuppyNumber>[0-9]+))$/.exec('/page/PDM/21'));
    console.info(/^(?<Page>\/page\/(?<Book>)(?<PageNumber>[0-9]+))$/.exec('/page/PDM/7.html'));
    console.info(/^(?<Page>\/page\/(?<Book>)(?<PageNumber>[0-9]+))$/.exec('/page/PDM/7.html'));
}

if (import.meta.main) {
    parsePlay();
    await taggerServer();
}
