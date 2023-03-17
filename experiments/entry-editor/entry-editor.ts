import {DenoHttpServer} from '../../server/deno-http-server.ts';
import * as server from '../../server/server.ts';
import { parse as toml_parse, stringify as toml_stringify } from "https://deno.land/std@0.177.0/encoding/toml.ts";
// @deno-types='https://deno.land/x/xregexp/types/index.d.ts'
import XRegExp from  'https://deno.land/x/xregexp/src/index.js';
import * as liquid from "https://esm.sh/liquidjs@10.6.0";
import EditListTag from './editlist-tag.ts';
import SectionTag from './section-tag.ts';
import { sleep } from "https://deno.land/x/sleep/mod.ts";
import {stringify}  from './liquid-utils.ts';

// TODO: inline a lexeme (as json)
// TODO: render a the lexeme using the template engine
// TODO: make a custom tag
// TODO: do a sample edit workflow

class EntryEditorServer {
    template_engine: liquid.Liquid;

    constructor(public entry: any) {
        let templates_root = 'templates';
        this.template_engine = new liquid.Liquid({
            strictFilters: true,
            strictVariables: true,
            outputEscape: 'escape',
            root: `${templates_root}/pages`,
            partials: `${templates_root}/partials`,
            layouts: `${templates_root}/layouts`,
            //cache: true, // off while testing
        });

        this.template_engine.registerTag('editlist', EditListTag);
        this.template_engine.registerTag('section', SectionTag);
    }
    
    async handleRequest(request: server.Request): Promise<server.Response> {
        const url = new URL(request.url);
        let match: any = undefined;
        //console.info('url', url);
        //console.info('url.pathname', url.pathname);
        switch(true) {
            case !!(match=XRegExp.cache(`^/entry/(?<id>[\\w-]+)$`, 'x').exec(url.pathname)):
                console.info('match', match);
                //console.info('ENTRY', match.groups.id);
                return this.renderEntry();
            default:
                //await sleep(1);
                break;
        }

        return Promise.resolve({
            status: 200,
            headers: {},
            url: 'foo',
            body: 'Hello <b>World!</b>',
        });
    }

    async renderEntry(): Promise<server.Response> {
        const entry_editor_template =
            await this.template_engine.parseFile('entry-editor.liquidjs');


        //let scope: any = {entry: this.entry};
        //let body = await this.template_engine.render(entry_editor_template, scope);

        let scope = new liquid.Context({entry: this.entry}, this.template_engine.options, {});
        let emitter = new PartialEmitter();
        //emitter.write('foo');
        let body = await liquid.toPromise(this.template_engine.renderer.renderTemplates(entry_editor_template, scope, emitter));
        
        return Promise.resolve({
            status: 200,
            headers: {},
            url: 'foo',
            body: body,
        });
    }
}

async function test(): Promise<void> {
    let entry = toml_parse(await Deno.readTextFile('entry.toml'));
    let entryEditorServer = new EntryEditorServer(entry);
    await new DenoHttpServer({port: 9000}, entryEditorServer.handleRequest.bind(entryEditorServer)).run();
}


//import { stringify } from '../util'
//import { Emitter } from './emitter'

export class PartialEmitter implements liquid.Emitter {
    public buffer = '';

    public write (html: any) {
        //console.info('not emitting', stringify(html));
        this.buffer += stringify(html)
    }
}



if (import.meta.main)
    test();
